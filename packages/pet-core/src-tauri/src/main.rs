// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod guard;
mod queue;
mod server;
mod settings;
mod tray;
mod window;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use server::{ServerState, WebviewReport};

/// What the webview receives.
///
/// Deliberately not a `PetEvent`: the shell does no interpretation. It forwards
/// the source tag and the untouched payload and lets the adapter registry
/// decide what any of it means (I5).
#[derive(Serialize, Clone)]
struct AgentRaw {
    source: String,
    /// The body as received, unparsed. Parsing here would put agent-shaped
    /// assumptions into the shell, and would also put work on the path that
    /// I2 requires to stay empty.
    payload: String,
    at: u64,
}

/// How often the drain task wakes when the queue is empty.
///
/// 250 ms is imperceptible for a pet reacting to a tool call, and it keeps idle
/// cost within I6 — Spike C measured the whole app at 0.042 % of one core while
/// asleep, and this must not spoil that.
const DRAIN_INTERVAL: Duration = Duration::from_millis(250);

/// The exact hooks block for the running port, for tray → Copy hook config.
///
/// Generated rather than hardcoded because the port is configurable and a
/// hooks file pointing at the wrong one fails silently (D9).
pub fn hooks_block(port: u16) -> String {
    let target = format!(
        r#"{{"type":"http","url":"http://127.0.0.1:{port}/event/claude-code","timeout":2}}"#
    );
    let plain = format!(r#"[{{"hooks":[{target}]}}]"#);
    let matched = format!(r#"[{{"matcher":".*","hooks":[{target}]}}]"#);
    let rows = [
        ("SessionStart", &plain),
        ("SessionEnd", &plain),
        ("UserPromptSubmit", &plain),
        ("PreToolUse", &matched),
        ("PostToolUse", &matched),
        ("PostToolUseFailure", &matched),
        ("PermissionRequest", &matched),
        ("PermissionDenied", &matched),
        ("Notification", &plain),
        ("Stop", &plain),
        ("StopFailure", &plain),
    ]
    .iter()
    .map(|(event, body)| format!(r#"    "{event}": {body}"#))
    .collect::<Vec<_>>()
    .join(",\n");
    format!("{{\n  \"hooks\": {{\n{rows}\n  }}\n}}")
}

fn main() {
    let port = server::configured_port();
    let token = std::env::var("PET_TOKEN").ok().filter(|t| !t.is_empty());
    let state = Arc::new(ServerState::new(port, token));

    tauri::Builder::default()
        // Two pets would fight over the port, and the second would exit on the
        // bind error with the first still running — confusing rather than
        // wrong. Focusing the existing one is the honest response.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("pet") {
                let _ = win.show();
                window::apply_overlay_behaviour(&win);
            }
        }))
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            report_ready,
            webview_log,
            endpoint_url
        ])
        // `eval` during setup runs against whatever document exists at that
        // moment and is discarded on navigation, so the bridge has to be
        // reinstalled per page load or it silently never runs.
        .on_page_load(|win, _| {
            println!(
                "[webview] page loaded: {}",
                win.url().map(|u| u.to_string()).unwrap_or_default()
            );
            let _ = win.eval(CONSOLE_BRIDGE);
        })
        .setup(move |app| {
            // No Dock icon and no menu bar: this is a tray-resident overlay, not
            // a foreground app. Also stops the pet appearing in Cmd-Tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let win = app
                .get_webview_window("pet")
                .expect("window `pet` missing from tauri.conf.json");

            let saved = settings::load(app.handle());
            let shared = std::sync::Arc::new(tray::AppState {
                settings: std::sync::Mutex::new(saved.clone()),
            });
            app.manage(shared.clone());

            window::apply_overlay_behaviour(&win);
            window::place(
                &win,
                saved
                    .position
                    .map(|p| window::clamp_to_visible(&win, p))
                    .unwrap_or_else(|| window::default_corner(&win)),
            );
            window::set_click_through(&win, saved.click_through);
            tray::build(app.handle(), &saved)?;
            remember_position(&win, app.handle().clone(), shared);

            // Spike C harness: render the `sleeping` equivalent so animating
            // and static costs can be measured against the same binary.
            if std::env::var("PET_STATIC")
                .map(|v| v != "0")
                .unwrap_or(false)
            {
                let _ = win.eval("document.body.classList.add('static')");
                println!("[spike-c] static render mode");
            }

            println!(
                "[setup] window url = {:?}",
                win.url().map(|u| u.to_string())
            );
            if !saved.hidden {
                let _ = win.show();
            }

            spawn_server(app.handle().clone(), state.clone());
            spawn_drain(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Agent Pet");
}

/// Called by the webview once its adapter registry is up, so `/health` can
/// answer for the whole app rather than only for the shell.
#[tauri::command]
fn report_ready(state: tauri::State<'_, Arc<ServerState>>, adapters: Vec<String>, sessions: usize) {
    state.set_webview_report(WebviewReport {
        connected: true,
        adapters,
        sessions,
    });
}

/// Surfaces webview errors on stdout.
///
/// A transparent, undecorated overlay has nowhere to show a failure — a broken
/// frontend and a working one both look like an empty screen. Without this the
/// only symptom of a crashed renderer is a pet that never appears.
#[tauri::command]
fn webview_log(level: String, message: String) {
    println!("[webview:{level}] {message}");
}

/// Injected before the app script so a failure during module evaluation is
/// still reported.
const CONSOLE_BRIDGE: &str = r#"
(() => {
  const send = (level, args) => {
    try {
      window.__TAURI_INTERNALS__.invoke('webview_log', {
        level,
        message: args.map(a => (a && a.stack) ? a.stack : String(a)).join(' '),
      });
    } catch {}
  };
  for (const level of ['error', 'warn', 'log']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { send(level, args); original(...args); };
  }
  addEventListener('error', e => send('error', [e.message, e.filename + ':' + e.lineno]));
  addEventListener('unhandledrejection', e => send('error', ['unhandled rejection', e.reason]));
})();
"#;

/// Where the frontend should post pre-normalised events.
///
/// Asked for rather than assumed: the port is configurable, and a demo posting
/// to the wrong one would fail silently — the same trap D9 exists to avoid.
#[tauri::command]
fn endpoint_url(state: tauri::State<'_, Arc<ServerState>>) -> String {
    format!("http://127.0.0.1:{}/pet-event", state.port)
}

fn spawn_server(app: tauri::AppHandle, state: Arc<ServerState>) {
    let port = state.port;
    tauri::async_runtime::spawn(async move {
        let listener = match server::bind(port).await {
            Ok(l) => l,
            Err(message) => {
                // D9: no silent fallback to another port. Hooks hardcode this
                // one in a URL, so moving quietly would leave the user with a
                // pet that never reacts and no error to explain why.
                eprintln!("\n[server] {message}\n");
                app.exit(1);
                return;
            }
        };
        println!("[server] listening on http://127.0.0.1:{port}");

        if let Err(e) = axum::serve(listener, server::router(state)).await {
            eprintln!("[server] stopped: {e}");
        }
    });
}

/// Moves events from the queue into the webview.
///
/// Everything expensive lives on this side of the queue so the HTTP handler can
/// stay trivial (I2). If the webview is gone, emits fail harmlessly and the
/// server keeps answering `204`.
fn spawn_drain(app: tauri::AppHandle, state: Arc<ServerState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            for event in state.queue.drain() {
                let payload = AgentRaw {
                    source: event.source,
                    payload: String::from_utf8_lossy(&event.body).into_owned(),
                    at: event.received_at_ms,
                };
                if let Err(e) = app.emit("agent-raw", payload) {
                    eprintln!("[drain] emit failed: {e}");
                }
            }
            tokio::time::sleep(DRAIN_INTERVAL).await;
        }
    });
}

/// Persist the window position after the user drags it.
///
/// Written on move rather than on quit: the pet is a background app that people
/// close by killing, and a position remembered only on a clean exit is a
/// position usually forgotten.
fn remember_position(
    win: &tauri::WebviewWindow,
    app: tauri::AppHandle,
    shared: std::sync::Arc<tray::AppState>,
) {
    let label = win.label().to_string();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            let Some(win) = app.get_webview_window(&label) else {
                return;
            };
            let _ = win;
            let mut settings = shared.settings.lock().expect("settings poisoned");
            settings.position = Some((pos.x, pos.y));
            settings::save(&app, &settings);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_block_is_valid_json_for_the_running_port() {
        let text = hooks_block(48999);
        let parsed: serde_json::Value =
            serde_json::from_str(&text).expect("tray copies this straight into settings.json");
        let hooks = parsed["hooks"].as_object().expect("a hooks object");
        assert_eq!(hooks.len(), 11, "spec §5.3 registers eleven events");
        assert!(
            text.contains("127.0.0.1:48999"),
            "must name the port actually in use"
        );
        assert!(!text.contains("48200"), "must not leak the default port");
    }

    #[test]
    fn only_the_tool_events_carry_a_matcher() {
        let parsed: serde_json::Value = serde_json::from_str(&hooks_block(48200)).unwrap();
        let hooks = &parsed["hooks"];
        assert_eq!(hooks["PreToolUse"][0]["matcher"], ".*");
        assert!(hooks["Stop"][0]["matcher"].is_null());
    }

    #[test]
    fn every_hook_uses_a_short_timeout() {
        // HTTP hooks are synchronous; the agent waits for us (I2).
        let parsed: serde_json::Value = serde_json::from_str(&hooks_block(48200)).unwrap();
        for (event, entries) in parsed["hooks"].as_object().unwrap() {
            let timeout = entries[0]["hooks"][0]["timeout"].as_u64().unwrap();
            assert!(timeout <= 2, "{event} would block the agent for {timeout}s");
        }
    }

    #[test]
    fn settings_survive_a_file_that_predates_a_field() {
        // Adding a setting must not brick an existing install.
        let old = r#"{"click_through":true}"#;
        let s: settings::Settings = serde_json::from_str(old).unwrap();
        assert!(s.click_through);
        assert!(s.glyphs_enabled, "a new field falls back to its default");
        assert_eq!(s.scale, 1.0);
        assert_eq!(s.position, None);
    }

    #[test]
    fn settings_round_trip() {
        let mut s = settings::Settings::default();
        s.position = Some((10, 20));
        s.scale = 1.5;
        let back: settings::Settings =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.position, Some((10, 20)));
        assert_eq!(back.scale, 1.5);
    }
}
