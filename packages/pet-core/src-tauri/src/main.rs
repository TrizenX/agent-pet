// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod guard;
mod queue;
mod server;
mod window;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition};

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

fn main() {
    let port = server::configured_port();
    let token = std::env::var("PET_TOKEN").ok().filter(|t| !t.is_empty());
    let state = Arc::new(ServerState::new(port, token));

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![report_ready, webview_log])
        // `eval` during setup runs against whatever document exists at that
        // moment and is discarded on navigation, so the bridge has to be
        // reinstalled per page load or it silently never runs.
        .on_page_load(|win, _| {
            println!("[webview] page loaded: {}", win.url().map(|u| u.to_string()).unwrap_or_default());
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

            window::apply_overlay_behaviour(&win);
            place_bottom_right(&win);

            // Spike C harness: render the `sleeping` equivalent so animating
            // and static costs can be measured against the same binary.
            if std::env::var("PET_STATIC")
                .map(|v| v != "0")
                .unwrap_or(false)
            {
                let _ = win.eval("document.body.classList.add('static')");
                println!("[spike-c] static render mode");
            }

            println!("[setup] window url = {:?}", win.url().map(|u| u.to_string()));
            let _ = win.show();

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

/// Park the pet bottom-right of the primary monitor, so it is obviously "on top
/// of everything" rather than accidentally centred.
fn place_bottom_right(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let w = (208.0 * scale) as i32;
        let h = (232.0 * scale) as i32;
        let margin = (48.0 * scale) as i32;
        let _ = win.set_position(PhysicalPosition::new(
            screen.width as i32 - w - margin,
            screen.height as i32 - h - margin * 2,
        ));
    }
}
