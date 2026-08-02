//! The handful of things the pet remembers between runs.
//!
//! Deliberately tiny and deliberately best-effort: none of it is important
//! enough to interrupt the user over. A corrupt or missing file yields
//! defaults, and a failed write is logged and forgotten — a pet that refuses to
//! start because it could not save its window position would be absurd.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Last window position, in physical pixels. Validated against the monitors
    /// that actually exist before it is used — see `window::clamp_to_visible`.
    pub position: Option<(i32, i32)>,
    pub click_through: bool,
    pub glyphs_enabled: bool,
    /// 0.75, 1.0 or 1.5. Stored rather than an enum so a future size is data.
    pub scale: f64,
    pub hidden: bool,
    /// Pack id, or empty for the built-in pet.
    pub pack: String,
    /// Whether the pet paces while the agent works. On by default; a window
    /// that moves is a preference, and some people will want it still.
    pub wander: bool,
    /// `"en"`, `"vi"`, or empty for "follow the system".
    ///
    /// Empty is the default and is not the same as `"en"`: it means nobody has
    /// chosen, so the webview's own locale decides. Storing a chosen `"en"`
    /// distinctly is what lets a Vietnamese system be overridden to English.
    pub locale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            position: None,
            click_through: false,
            glyphs_enabled: true,
            scale: 1.0,
            hidden: false,
            pack: String::new(),
            wander: true,
            locale: String::new(),
        }
    }
}

fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    let Some(p) = path(app) else {
        return Settings::default();
    };
    match std::fs::read_to_string(&p) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!(
                "[settings] {} is unreadable ({e}); using defaults",
                p.display()
            );
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) {
    let Some(p) = path(app) else { return };
    match serde_json::to_string_pretty(settings) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&p, text) {
                eprintln!("[settings] could not write {}: {e}", p.display());
            }
        }
        Err(e) => eprintln!("[settings] could not serialise: {e}"),
    }
}
