//! Finding pet packs on disk.
//!
//! Spec §12.2. Three roots, in priority order — ours, then the two the wider
//! ecosystem installs into. Reading those means `npx petdex install <slug>`
//! already works for our users and we ship no CLI of our own.
//!
//! **We never write to them.** They belong to other tools; we are a reader.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPack {
    /// Directory name, which is also the id users see in the tray.
    pub id: String,
    /// Absolute path to `pet.json`.
    pub manifest: String,
    /// Absolute path to the sheet, if one is next to the manifest.
    pub sheet: Option<String>,
    /// Which root it came from, for the event log.
    pub root: String,
}

/// The roots, in the order a duplicate id should win.
pub fn roots(app: &tauri::AppHandle) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Ok(dir) = app.path().app_config_dir() {
        out.push(("app".to_string(), dir.join("packs")));
    }
    if let Some(home) = dirs_home() {
        // Other tools' install roots. Read-only, always.
        out.push(("petdex".to_string(), home.join(".petdex/pets")));
        out.push(("codex".to_string(), home.join(".codex/pets")));
    }
    out
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The conventional sheet names, in the order the ecosystem uses them.
fn find_sheet(dir: &Path, declared: Option<&str>) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(d) = declared {
        candidates.push(d.to_string());
    }
    candidates.extend(
        [
            "spritesheet.webp",
            "spritesheet.png",
            "sprite.webp",
            "sprite.png",
        ]
        .iter()
        .map(|s| s.to_string()),
    );

    candidates
        .into_iter()
        .map(|name| dir.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Everything installed, first root wins on a duplicate id.
///
/// Deliberately shallow: read the directory, note what is there, and let the
/// frontend decide what is valid. Validation needs the decoded image, which
/// lives in the webview, and duplicating the geometry rules here would be a
/// second implementation to keep in step.
pub fn discover(app: &tauri::AppHandle) -> Vec<DiscoveredPack> {
    let mut found: Vec<DiscoveredPack> = Vec::new();

    for (label, root) in roots(app) {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let manifest = dir.join("pet.json");
            if !manifest.is_file() {
                continue;
            }
            let Some(id) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if found.iter().any(|p| p.id == id) {
                continue;
            }

            let declared = std::fs::read_to_string(&manifest)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| {
                    v.get("spritesheetPath")
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                });

            found.push(DiscoveredPack {
                id,
                manifest: manifest.to_string_lossy().into_owned(),
                sheet: find_sheet(&dir, declared.as_deref()),
                root: label.clone(),
            });
        }
    }

    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}
