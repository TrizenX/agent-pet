//! The tray menu — the pet's only settings surface in Phase 1.
//!
//! It also has one job the rest of the app cannot do: it is the guaranteed way
//! back. A click-through pet cannot be clicked and a hidden pet cannot be seen,
//! so every state the user can put the pet into has to be reversible from here.

use std::sync::{Arc, Mutex};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::{self, Settings};
use crate::window;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// What was on disk at startup.
    ///
    /// Scanned once, in `setup`, and shared with the frontend from here. The
    /// tray and the webview have to agree on the id of every pack — the tray
    /// writes the selection and the webview looks it up — and two independent
    /// scans is one more way for them to disagree. It also halves the startup
    /// disk I/O, which happens on the main thread before the window is shown.
    pub packs: Vec<crate::packs::DiscoveredPack>,
}

/// Scales offered in the Size submenu. Anything else is a data change.
const SCALES: [(&str, f64); 3] = [("size-075", 0.75), ("size-100", 1.0), ("size-150", 1.5)];

fn pet<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window("pet")
}

pub fn build(
    app: &AppHandle,
    initial: &Settings,
    packs: &[crate::packs::DiscoveredPack],
) -> tauri::Result<()> {
    let show =
        CheckMenuItem::with_id(app, "show", "Show pet", true, !initial.hidden, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(
        app,
        "click-through",
        // Naming the consequence in the label, because the alternative is a
        // user discovering it by finding the pet unresponsive.
        "Click-through (pet not draggable)",
        true,
        initial.click_through,
        None::<&str>,
    )?;
    let glyphs = CheckMenuItem::with_id(
        app,
        "glyphs",
        "State glyphs",
        true,
        initial.glyphs_enabled,
        None::<&str>,
    )?;

    let size_items: Vec<CheckMenuItem<_>> = SCALES
        .iter()
        .map(|(id, value)| {
            CheckMenuItem::with_id(
                app,
                *id,
                format!(
                    "{}×",
                    if *value == 1.0 {
                        "1".into()
                    } else {
                        value.to_string()
                    }
                ),
                true,
                (initial.scale - value).abs() < f64::EPSILON,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let size = Submenu::with_id_and_items(
        app,
        "size",
        "Size",
        true,
        &size_items
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
            .collect::<Vec<_>>(),
    )?;

    // Built from disk at startup. A pack installed later needs a restart —
    // acceptable for Phase 1, and honest: the alternative is watching three
    // directories for the whole session to save one relaunch.
    let mut pack_items: Vec<CheckMenuItem<_>> = vec![CheckMenuItem::with_id(
        app,
        "pack:",
        "Built-in",
        true,
        initial.pack.is_empty(),
        None::<&str>,
    )?];
    for found in packs {
        // Not `?`. `packs.rs` goes to some trouble to skip a bad entry rather
        // than fail the scan, and propagating from here would throw that away:
        // `build` is called with `?` from `setup`, so one unrepresentable menu
        // label — from a directory name in a root we do not control — would
        // stop the app from starting at all.
        match CheckMenuItem::with_id(
            app,
            format!("pack:{}", found.id),
            format!("{}  ({})", found.id, found.root),
            true,
            initial.pack == found.id,
            None::<&str>,
        ) {
            Ok(item) => pack_items.push(item),
            Err(e) => println!("[packs] no menu item for {}: {e}", found.id),
        }
    }
    let choose_pet = Submenu::with_id_and_items(
        app,
        "choose-pet",
        "Choose pet",
        true,
        &pack_items
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
            .collect::<Vec<_>>(),
    )?;

    let demo_items = [
        ("demo-full", "Full session"),
        ("demo-approval", "Approval"),
        ("demo-rate-limit", "Rate limit"),
        ("demo-error", "Error"),
        ("demo-multi", "Multi-session"),
    ]
    .iter()
    .map(|(id, label)| MenuItem::with_id(app, *id, *label, true, None::<&str>))
    .collect::<tauri::Result<Vec<_>>>()?;
    let demo = Submenu::with_id_and_items(
        app,
        "demo",
        "Demo",
        true,
        &demo_items
            .iter()
            .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
            .collect::<Vec<_>>(),
    )?;

    let event_log = MenuItem::with_id(app, "event-log", "Event log…", true, None::<&str>)?;
    let copy_hooks = MenuItem::with_id(app, "copy-hooks", "Copy hook config", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &click_through,
            &glyphs,
            &choose_pet,
            &size,
            &demo,
            &PredefinedMenuItem::separator(app)?,
            &event_log,
            &copy_hooks,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let handle = app.clone();
    TrayIconBuilder::with_id("pet")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundled tray icon"),
        )
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |_, event| on_menu(&handle, event.id().as_ref()))
        .build(app)?;

    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Arc<AppState>>();

    // Held only long enough to read or write a field; the window calls below
    // can re-enter the tray handler on some platforms.
    let mut settings = state.settings.lock().expect("settings poisoned").clone();

    match id {
        "quit" => {
            settings::save(app, &settings);
            app.exit(0);
            return;
        }

        "show" => {
            settings.hidden = !settings.hidden;
            if let Some(win) = pet(app) {
                if settings.hidden {
                    let _ = win.hide();
                } else {
                    window::show(&win, settings.click_through);
                }
            }
        }

        "click-through" => {
            settings.click_through = !settings.click_through;
            if let Some(win) = pet(app) {
                window::set_click_through(&win, settings.click_through);
            }
        }

        "glyphs" => {
            settings.glyphs_enabled = !settings.glyphs_enabled;
            let _ = app.emit("pet-settings", &settings);
        }

        "copy-hooks" => {
            // Asks the frontend, which owns the adapter and therefore the only
            // thing that knows what a hook config looks like (I5). The shell
            // writes the clipboard; it does not compose the text.
            let _ = app.emit("copy-hooks", ());
        }

        "event-log" => {
            let _ = app.emit("toggle-event-log", ());
        }

        other if other.starts_with("pack:") => {
            settings.pack = other.trim_start_matches("pack:").to_string();
            let _ = app.emit("pet-settings", &settings);
        }

        other if other.starts_with("size-") => {
            if let Some((_, value)) = SCALES.iter().find(|(sid, _)| *sid == other) {
                settings.scale = *value;
                let _ = app.emit("pet-settings", &settings);
            }
        }

        other if other.starts_with("demo-") => {
            let _ = app.emit(
                "demo-scenario",
                other.trim_start_matches("demo-").to_string(),
            );
        }

        _ => {}
    }

    *state.settings.lock().expect("settings poisoned") = settings.clone();
    settings::save(app, &settings);
}
