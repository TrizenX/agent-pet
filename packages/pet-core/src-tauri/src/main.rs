// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window;

use tauri::{Manager, PhysicalPosition};

/// M0 Spike A harness.
///
/// This is deliberately the smallest thing that can answer one question: does a
/// transparent, always-on-top Tauri 2 window stay visible above a full-screen
/// macOS app? No server, no state machine, no renderer — those are M1.
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // No Dock icon and no menu bar: this is a tray-resident overlay, not
            // a foreground app. Also stops the pet appearing in Cmd-Tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let win = app
                .get_webview_window("pet")
                .expect("window `pet` missing from tauri.conf.json");

            window::apply_overlay_behaviour(&win);

            // Park it bottom-right of the primary monitor so it is obviously
            // "on top of everything" rather than accidentally centred.
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

            let _ = win.show();
            println!("[spike-a] overlay window shown");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Agent Pet");
}
