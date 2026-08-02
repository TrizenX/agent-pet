// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod guard;
mod packs;
mod queue;
mod server;
mod settings;
mod tray;
mod window;

use std::sync::Arc;

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

fn main() {
    let port = server::configured_port();
    let token = std::env::var("PET_TOKEN").ok().filter(|t| !t.is_empty());
    let state = Arc::new(ServerState::new(port, token));

    tauri::Builder::default()
        // Two pets would fight over the port, and the second would exit on the
        // bind error with the first still running — confusing rather than
        // wrong. Focusing the existing one is the honest response.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Relaunching is how a user asks to see the pet, so an explicitly
            // hidden pet is un-hidden and the setting updated to match. The
            // alternative is a window on screen while the tray still claims it
            // is hidden.
            if let Some(win) = app.get_webview_window("pet") {
                let click_through = match app.try_state::<std::sync::Arc<tray::AppState>>() {
                    Some(shared) => {
                        let mut settings = shared.settings.lock().expect("settings poisoned");
                        settings.hidden = false;
                        settings::save(app, &settings);
                        settings.click_through
                    }
                    None => false,
                };
                window::show(&win, click_through);
            }
        }))
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            report_ready,
            webview_log,
            endpoint_url,
            get_settings,
            copy_text,
            list_packs
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
            // One scan, at startup, shared by the tray and the frontend. See
            // `tray::AppState::packs`.
            let found = packs::discover(app.handle());
            println!("[packs] discovered {}", found.len());
            for p in &found {
                println!(
                    "[packs]   {} ({}) sheet={:?}",
                    p.id,
                    p.root,
                    p.sheet.is_some()
                );
            }
            let shared = std::sync::Arc::new(tray::AppState {
                settings: std::sync::Mutex::new(saved.clone()),
                packs: found,
            });
            app.manage(shared.clone());

            window::place(
                &win,
                saved
                    .position
                    .map(|p| window::clamp_to_visible(&win, p))
                    .unwrap_or_else(|| window::default_corner(&win)),
            );
            tray::build(app.handle(), &saved, &shared.packs)?;
            remember_position(&win, app.handle().clone(), shared);

            println!(
                "[setup] window url = {:?}",
                win.url().map(|u| u.to_string())
            );
            if saved.hidden {
                // Still needs the overlay behaviour applied, so that showing it
                // later from the tray does not start from a plain window.
                window::apply_overlay_behaviour(&win);
            } else {
                window::show(&win, saved.click_through);
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
fn report_ready(
    state: tauri::State<'_, Arc<ServerState>>,
    adapters: Vec<String>,
    sessions: usize,
    focused_state: String,
    focused_project: String,
) {
    state.set_webview_report(WebviewReport {
        connected: true,
        adapters,
        sessions,
        focused_state,
        focused_project,
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

/// Pet packs found on disk.
///
/// Shallow on purpose: this reports what is *there*, not what is valid.
/// Validating needs the decoded sheet, which only the webview has, and a second
/// implementation of the geometry rules here would be one more thing to keep in
/// step with `packs/atlas.ts`.
#[tauri::command]
fn list_packs(app: tauri::AppHandle) -> Vec<packs::DiscoveredPack> {
    // The list `setup` scanned, not a second scan: the tray persists a pack by
    // the id it saw, and the frontend has to look it up by that same id.
    match app.try_state::<Arc<tray::AppState>>() {
        Some(shared) => shared.packs.clone(),
        None => Vec::new(),
    }
}

/// Put text on the clipboard on the frontend's behalf.
///
/// The shell does the writing; the frontend decides *what*. Hook configuration
/// is agent-specific, and I5 says only the adapter registry may know that —
/// generating the block here would have put eleven hook event names and an
/// agent id in the one place that is supposed to stay ignorant of both, where
/// the I5 lint could not see them either.
#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// The current settings, for the frontend to start from.
///
/// The `pet-settings` event only fires when the tray changes something, so a
/// frontend that listened and nothing else would render at its own defaults
/// after every restart — silently discarding a scale and a glyph preference
/// that the Rust side had loaded from disk correctly.
#[tauri::command]
fn get_settings(shared: tauri::State<'_, Arc<tray::AppState>>) -> settings::Settings {
    shared.settings.lock().expect("settings poisoned").clone()
}

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
///
/// Woken by the queue rather than by a timer. It was a 250 ms poll, which was
/// cheap enough to measure clean but was still a 4 Hz clock ticking against an
/// invariant that asks for nothing above 1 Hz while the pet is asleep. Waiting
/// on a notification costs nothing at all and drops latency to zero.
fn spawn_drain(app: tauri::AppHandle, state: Arc<ServerState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            state.queue.wait().await;
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
