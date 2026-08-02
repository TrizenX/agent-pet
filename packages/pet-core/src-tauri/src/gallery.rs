//! Writing packs to disk, and remembering the gallery's index.
//!
//! Spec §12.4. The network lives in the webview — it already has a sandboxed
//! HTTP stack and the gallery serves `Access-Control-Allow-Origin: *`, so
//! putting a TLS client in the shell would buy nothing and cost a dependency
//! tree. What the webview cannot do is write a file, which is all of this.
//!
//! One directory is ours: `app_config_dir()/packs`. The two ecosystem install
//! roots that `packs.rs` also scans belong to other tools and are read-only
//! forever (§12.2). Nothing here can be pointed at them: every path in this
//! file is built from `packs_dir()`, which cannot name them.
//!
//! **We are not re-hosting anything.** The bytes travel from the gallery's CDN
//! to the user's disk because the user asked for them. The manifest we do cache
//! is an index — slugs and URLs — not art. See §17.2.

use std::path::{Path, PathBuf};

use tauri::Manager;

/// How long a cached index stays good. §12.4.
const CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;

/// The sheet names a pack may be written with.
///
/// Not a sanitiser applied to a remote string — an allowlist. The frontend
/// picks one of these based on what it decoded; the gallery's own file naming
/// never reaches the filesystem.
const SHEET_NAMES: [&str; 2] = ["spritesheet.webp", "spritesheet.png"];

fn packs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("packs"))
        .map_err(|e| format!("no app config directory: {e}"))
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("gallery-index.json"))
        .map_err(|e| format!("no app config directory: {e}"))
}

/// Whether a gallery slug is safe to use as a directory name.
///
/// This string comes out of a JSON document on someone else's server and is
/// about to become a path. Conservative on purpose: a slug we reject costs one
/// uninstallable pet, and a slug we should have rejected costs a write outside
/// the only directory we are allowed to touch.
fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug != "."
        && slug != ".."
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// The cached gallery index, if it is still fresh.
///
/// Returns `None` for missing, unreadable, or stale — all three mean the same
/// thing to the caller, which is "fetch it". Never an error: a corrupt cache
/// file must cost a round trip, not a broken picker.
#[tauri::command]
pub fn gallery_cache_read(app: tauri::AppHandle) -> Option<String> {
    let path = cache_path(&app).ok()?;
    let age = std::fs::metadata(&path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()?;
    if age.as_secs() > CACHE_TTL_SECONDS {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

/// Remember the index for a day. Failure is not worth reporting: the picker
/// works either way, it just fetches again next time.
#[tauri::command]
pub fn gallery_cache_write(app: tauri::AppHandle, json: String) {
    let Ok(path) = cache_path(&app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, json) {
        println!("[gallery] could not cache the index: {e}");
    }
}

/// Write a pack the frontend has already downloaded and validated.
///
/// Validation happens before this call, not after. A pack that fails geometry
/// is one that never reaches the disk — which is a stronger guarantee than
/// deleting it afterwards, and it cannot be defeated by the app being killed
/// between the write and the delete.
///
/// Written to a staging directory and renamed, so an interrupted install leaves
/// nothing that `discover()` would list.
#[tauri::command]
pub fn install_pack(
    app: tauri::AppHandle,
    slug: String,
    pet_json: String,
    sheet: Vec<u8>,
    sheet_name: String,
) -> Result<String, String> {
    if !is_safe_slug(&slug) {
        return Err(format!("refusing to install under the name {slug:?}"));
    }
    if !SHEET_NAMES.contains(&sheet_name.as_str()) {
        return Err(format!("{sheet_name:?} is not a sheet name we write"));
    }
    if sheet.is_empty() {
        return Err("the spritesheet is empty".to_string());
    }

    let root = packs_dir(&app)?;
    let staging = root.join(format!(".installing-{slug}"));
    let final_dir = root.join(&slug);

    // Belt and braces. `is_safe_slug` already makes this unreachable, but the
    // check is cheap and the thing it prevents is a write outside our own
    // directory.
    if final_dir.parent() != Some(root.as_path()) {
        return Err("that name does not resolve inside the packs directory".to_string());
    }

    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("could not create {slug}: {e}"))?;

    let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
        std::fs::write(staging.join(name), bytes).map_err(|e| format!("could not write {name}: {e}"))
    };
    if let Err(e) = write("pet.json", pet_json.as_bytes()).and_then(|()| write(&sheet_name, &sheet))
    {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // Replacing an existing pack of the same name is a reinstall, which is what
    // the user asked for by pressing the button a second time.
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        format!("could not finish installing {slug}: {e}")
    })?;

    println!("[gallery] installed {slug} ({} bytes)", sheet.len());
    refresh_pack_list(&app);
    Ok(final_dir.to_string_lossy().into_owned())
}

/// Wear a pack.
///
/// The shell owns the selection because it also persists it, and because the
/// tray writes to the same field — two writers and one file means one of them
/// has to be the shell. Emits `pet-settings` so the frontend sees its own
/// change through the same path a tray click takes, rather than a second one.
///
/// The tray submenu's checkmarks are built once at startup and do not move.
/// That is the same staleness the pack list already has (see `tray.rs`), and a
/// menu that updated its ticks but not its entries would be worse.
#[tauri::command]
pub fn select_pack(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    use tauri::Emitter;
    let shared = app
        .try_state::<std::sync::Arc<crate::tray::AppState>>()
        .ok_or("settings are not available")?;
    let mut settings = shared.settings.lock().expect("settings poisoned");
    settings.pack = slug;
    crate::settings::save(&app, &settings);
    app.emit("pet-settings", &*settings).map_err(|e| e.to_string())
}

/// Remove a pack we installed. Only ever from our own directory.
#[tauri::command]
pub fn uninstall_pack(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    if !is_safe_slug(&slug) {
        return Err(format!("refusing to remove {slug:?}"));
    }
    let dir = packs_dir(&app)?.join(&slug);
    if !dir.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {slug}: {e}"))?;
    refresh_pack_list(&app);
    Ok(())
}

/// Re-scan after we changed what is on disk.
///
/// The shell caches the pack list from startup so the tray and the frontend
/// cannot disagree about it. That cache is correct right up to the moment this
/// process writes a pack — after which the frontend would ask for the list,
/// get the old one, and find the pet it just installed missing. Rescanning here
/// keeps the single-source property and the freshness both.
fn refresh_pack_list(app: &tauri::AppHandle) {
    let Some(shared) = app.try_state::<std::sync::Arc<crate::tray::AppState>>() else {
        return;
    };
    let found = crate::packs::discover(app);
    println!("[gallery] pack list refreshed: {} on disk", found.len());
    *shared.packs.lock().expect("packs poisoned") = found;
}

/// Whether a path is inside a root, for tests and for the paranoid.
#[cfg(test)]
fn inside(child: &Path, root: &Path) -> bool {
    child.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_slugs_the_gallery_actually_uses() {
        for slug in ["guga", "wukong-5", "blue-guga", "pet_package_zhizhi3-0", "a"] {
            assert!(is_safe_slug(slug), "{slug} should be installable");
        }
    }

    #[test]
    fn refuses_anything_that_could_leave_the_packs_directory() {
        for slug in [
            "",
            ".",
            "..",
            "../evil",
            "/etc/passwd",
            "a/b",
            "a\\b",
            "with space",
            "Capitals",
            "null\0byte",
            "~/somewhere/else/x",
        ] {
            assert!(!is_safe_slug(slug), "{slug:?} should be refused");
        }
    }

    #[test]
    fn refuses_a_slug_longer_than_a_directory_name() {
        assert!(is_safe_slug(&"a".repeat(64)));
        assert!(!is_safe_slug(&"a".repeat(65)));
    }

    #[test]
    fn a_safe_slug_always_stays_one_level_under_the_root() {
        // The property the whole check exists for, stated directly.
        let root = Path::new("/tmp/packs");
        for slug in ["guga", "wukong-5", &"z".repeat(64)] {
            assert!(is_safe_slug(slug));
            let dir = root.join(slug);
            assert_eq!(dir.parent(), Some(root));
            assert!(inside(&dir, root));
        }
    }
}
