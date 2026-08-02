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

#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use base64::Engine as _;
use tauri::Manager;

/// How long a cached index stays good. §12.4.
const CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;

/// The sheet names a pack may be written with.
///
/// Not a sanitiser applied to a remote string — an allowlist. The frontend
/// picks one of these based on what it decoded; the gallery's own file naming
/// never reaches the filesystem.
const SHEET_NAMES: [&str; 2] = ["spritesheet.webp", "spritesheet.png"];

/// The largest sheet we will accept from the gallery.
///
/// The geometry check is not a size check, and mistaking one for the other was
/// a real hole: `classifyGeometry` bounds the *decoded* dimensions, so a PNG at
/// a perfectly ordinary 1536×1872 can carry an arbitrary payload in an ancillary
/// chunk that every decoder skips. Verified — an 11 KB sheet padded to 5 MB
/// still decodes to identical pixels. Only a byte count catches that.
///
/// Eight mebibytes against real sheets of one to two: room for a legitimate 4×
/// upscale, and four hundred times less than "whatever the server sends".
const MAX_SHEET_BYTES: usize = 8 * 1024 * 1024;

/// And the same for the index, which is JSON we write to disk unexamined.
/// The live one is 1.4 MB.
const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;

/// Names Windows refuses in every directory, case-insensitively.
///
/// Not a path-escape — a denial of service. A gallery entry with `slug: "con"`
/// passes every other rule here, and then `create_dir_all` fails on Windows for
/// a reason no error message would explain, permanently, for that pet. Cheaper
/// to refuse the name than to explain the failure.
const RESERVED_ON_WINDOWS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

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
        && !RESERVED_ON_WINDOWS.contains(&slug)
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
pub async fn gallery_cache_read(app: tauri::AppHandle) -> Option<String> {
    off_thread(move || cache_read(&app)).await.flatten()
}

fn cache_read(app: &tauri::AppHandle) -> Option<String> {
    let path = cache_path(app).ok()?;
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

/// Run blocking work off the thread that draws the pet.
///
/// A `#[tauri::command]` that is not `async` is called *inline* on the thread
/// that owns the webview's IPC handler — the platform UI thread. Everything in
/// this file touches the disk, and one of them rescans three directories, so
/// without this the pet freezes for the duration of an install. `async fn` alone
/// would only move the stall onto an async worker; the work has to leave both.
async fn off_thread<T, F>(work: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => Some(value),
        Err(e) => {
            println!("[gallery] background task failed: {e}");
            None
        }
    }
}

/// Remember the index for a day. Failure is not worth reporting: the picker
/// works either way, it just fetches again next time.
#[tauri::command]
pub async fn gallery_cache_write(app: tauri::AppHandle, json: String) {
    off_thread(move || cache_write(&app, &json)).await;
}

fn cache_write(app: &tauri::AppHandle, json: &str) {
    if json.len() > MAX_INDEX_BYTES {
        println!(
            "[gallery] not caching an index of {} bytes (limit {MAX_INDEX_BYTES})",
            json.len()
        );
        return;
    }
    let Ok(path) = cache_path(app) else { return };
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
pub async fn install_pack(
    app: tauri::AppHandle,
    slug: String,
    pet_json: String,
    sheet_base64: String,
    sheet_name: String,
) -> Result<String, String> {
    off_thread(move || install_blocking(&app, &slug, &pet_json, &sheet_base64, &sheet_name))
        .await
        .unwrap_or_else(|| Err("the install task did not finish".to_string()))
}

/// The sheet crosses the IPC boundary as base64, not as bytes.
///
/// Tauri only takes its raw-bytes fast path when the whole invoke payload is a
/// typed array, which it never is for a command with named arguments — so a
/// `Vec<u8>` argument is serialised as a JSON array of decimal numbers. Measured
/// at roughly fifteen to twenty times the source: an 8 MB sheet became a 154 MB
/// JS array and a 30-million-character string before the shell saw a byte of it.
/// Base64 costs 1.33×.
fn install_blocking(
    app: &tauri::AppHandle,
    slug: &str,
    pet_json: &str,
    sheet_base64: &str,
    sheet_name: &str,
) -> Result<String, String> {
    let sheet = base64::engine::general_purpose::STANDARD
        .decode(sheet_base64)
        .map_err(|e| format!("the spritesheet did not survive the trip: {e}"))?;

    if sheet.len() > MAX_SHEET_BYTES {
        return Err(format!(
            "the spritesheet is {} bytes; we install nothing above {MAX_SHEET_BYTES}",
            sheet.len()
        ));
    }
    if !is_safe_slug(slug) {
        return Err(format!("refusing to install under the name {slug:?}"));
    }
    if !SHEET_NAMES.contains(&sheet_name) {
        return Err(format!("{sheet_name:?} is not a sheet name we write"));
    }
    if sheet.is_empty() {
        return Err("the spritesheet is empty".to_string());
    }

    let root = packs_dir(app)?;
    let staging = root.join(format!(".installing-{slug}"));
    let final_dir = root.join(slug);

    // Belt and braces. `is_safe_slug` already makes this unreachable, but the
    // check is cheap and the thing it prevents is a write outside our own
    // directory.
    if final_dir.parent() != Some(root.as_path()) {
        return Err("that name does not resolve inside the packs directory".to_string());
    }

    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("could not create {slug}: {e}"))?;

    let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
        std::fs::write(staging.join(name), bytes)
            .map_err(|e| format!("could not write {name}: {e}"))
    };
    if let Err(e) = write("pet.json", pet_json.as_bytes()).and_then(|()| write(sheet_name, &sheet))
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
    refresh_pack_list(app);
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
    app.emit("pet-settings", &*settings)
        .map_err(|e| e.to_string())
}

/// Remove a pack we installed. Only ever from our own directory.
#[tauri::command]
pub async fn uninstall_pack(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    off_thread(move || uninstall_blocking(&app, &slug))
        .await
        .unwrap_or_else(|| Err("the uninstall task did not finish".to_string()))
}

fn uninstall_blocking(app: &tauri::AppHandle, slug: &str) -> Result<(), String> {
    if !is_safe_slug(slug) {
        return Err(format!("refusing to remove {slug:?}"));
    }
    let dir = packs_dir(app)?.join(slug);
    if !dir.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {slug}: {e}"))?;
    refresh_pack_list(app);
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
        for slug in [
            "guga",
            "wukong-5",
            "blue-guga",
            "pet_package_zhizhi3-0",
            "a",
        ] {
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
    fn refuses_names_windows_will_not_create() {
        // Not an escape — a pet that can never install, on a target platform,
        // for a reason no error message would explain.
        for slug in ["con", "nul", "aux", "prn", "com1", "lpt9"] {
            assert!(!is_safe_slug(slug), "{slug} is reserved on Windows");
        }
        // Still fine: reserved only as a whole name.
        assert!(is_safe_slug("console"));
        assert!(is_safe_slug("con-cat"));
        assert!(is_safe_slug("com10"));
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
