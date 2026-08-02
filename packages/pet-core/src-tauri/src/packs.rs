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
    /// Directory name.
    ///
    /// This is *the* id — what the tray shows, what a selection persists, and
    /// what the frontend keys the loaded pack by. Deliberately not the `id`
    /// inside `pet.json`: the two differ for roughly one pack in ten, and when
    /// they did, choosing that pack silently showed the built-in pet instead.
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

/// One path component, and an ordinary one — not `..`, not a root.
///
/// `PathBuf::join` replaces the whole path when the argument is absolute, so an
/// unchecked `spritesheetPath` of `/etc/passwd` becomes exactly that.
fn is_plain_file_name(s: &str) -> bool {
    let mut components = Path::new(s).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

/// Whether `dir` really lives under `root` once symlinks are resolved.
///
/// `std::fs` in the shell answers to nobody: Tauri's scope only guards the
/// asset protocol the webview reads through, so a symlinked pack directory
/// would have us reading a `pet.json` from anywhere on disk. The frontend fetch
/// would later be refused, but by then we have already read the file and put
/// its path in a list — the cheaper and more honest place to stop is here.
fn contained_in(dir: &Path, root: &Path) -> bool {
    match (dir.canonicalize(), root.canonicalize()) {
        (Ok(d), Ok(r)) => d.starts_with(r),
        _ => false,
    }
}

/// The conventional sheet names, in the order the ecosystem uses them.
///
/// A declared path is a file name, not a path. Every sheet in the ecosystem
/// sits beside its `pet.json`, so a `spritesheetPath` with a separator in it is
/// either a mistake or an attempt to point us somewhere else — and this string
/// comes out of a file a stranger wrote. Tauri's asset protocol would refuse
/// the read anyway, but a pack that resolves to a path we would never load is
/// better rejected here, where the reason is legible, than three layers down as
/// an opaque 403.
fn find_sheet(dir: &Path, declared: Option<&str>) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(d) = declared.filter(|d| is_plain_file_name(d)) {
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
    discover_in(&roots(app))
}

/// The scan itself, separated from where the roots come from so it can be
/// pointed at a temporary directory in a test. Everything above this line is
/// path arithmetic against the real `$HOME`; everything below is the behaviour
/// worth pinning.
pub fn discover_in(roots: &[(String, PathBuf)]) -> Vec<DiscoveredPack> {
    let mut found: Vec<DiscoveredPack> = Vec::new();

    for (label, root) in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() || !contained_in(&dir, root) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch directory that cleans itself up. Not worth a dependency.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("agent-pet-packs-{name}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("temp dir");
            Tmp(dir)
        }
        fn pack(&self, root: &str, id: &str, manifest: &str, sheets: &[&str]) -> PathBuf {
            let dir = self.0.join(root).join(id);
            fs::create_dir_all(&dir).expect("pack dir");
            fs::write(dir.join("pet.json"), manifest).expect("pet.json");
            for s in sheets {
                fs::write(dir.join(s), b"not really an image").expect("sheet");
            }
            dir
        }
        fn root(&self, label: &str, name: &str) -> (String, PathBuf) {
            (label.to_string(), self.0.join(name))
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_a_pack_and_its_declared_sheet() {
        let t = Tmp::new("basic");
        t.pack(
            "a",
            "frog",
            r#"{"id":"frog","spritesheetPath":"custom.webp"}"#,
            &["custom.webp"],
        );
        let found = discover_in(&[t.root("app", "a")]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "frog");
        assert_eq!(found[0].root, "app");
        assert!(found[0].sheet.as_deref().unwrap().ends_with("custom.webp"));
    }

    #[test]
    fn falls_back_to_the_conventional_sheet_names() {
        let t = Tmp::new("fallback");
        t.pack("a", "slime", r#"{"id":"slime"}"#, &["sprite.png"]);
        let found = discover_in(&[t.root("app", "a")]);
        assert!(found[0].sheet.as_deref().unwrap().ends_with("sprite.png"));
    }

    #[test]
    fn a_declared_sheet_path_may_not_leave_the_pack_directory() {
        let t = Tmp::new("traversal");
        t.pack(
            "a",
            "evil",
            r#"{"id":"evil","spritesheetPath":"../spritesheet.webp"}"#,
            &[],
        );
        // The file exists, one level up, and is even a plausible sheet name.
        fs::write(t.0.join("a").join("spritesheet.webp"), b"x").expect("outside file");
        let found = discover_in(&[t.root("app", "a")]);
        assert_eq!(found.len(), 1, "the pack is still listed");
        assert_eq!(
            found[0].sheet, None,
            "but the escaping path is not what we point at"
        );
    }

    #[test]
    fn a_declared_sheet_path_may_not_be_absolute() {
        let t = Tmp::new("absolute");
        t.pack(
            "a",
            "evil",
            r#"{"id":"evil","spritesheetPath":"/etc/hosts"}"#,
            &[],
        );
        // `PathBuf::join` would otherwise return `/etc/hosts` verbatim.
        assert_eq!(discover_in(&[t.root("app", "a")])[0].sheet, None);
    }

    #[test]
    #[cfg(unix)]
    fn a_symlinked_pack_directory_is_skipped() {
        let t = Tmp::new("symlink");
        // A real pack, somewhere we were never asked to look.
        t.pack("elsewhere", "secret", r#"{"id":"secret"}"#, &["sprite.png"]);
        fs::create_dir_all(t.0.join("a")).expect("root");
        std::os::unix::fs::symlink(t.0.join("elsewhere/secret"), t.0.join("a/secret"))
            .expect("symlink");

        assert!(t.0.join("a/secret/pet.json").is_file(), "the link resolves");
        assert!(
            discover_in(&[t.root("app", "a")]).is_empty(),
            "and we still refuse to read through it"
        );
    }

    #[test]
    fn the_first_root_wins_a_duplicate_id() {
        let t = Tmp::new("duplicate");
        t.pack("a", "frog", r#"{"id":"frog"}"#, &["spritesheet.webp"]);
        t.pack("b", "frog", r#"{"id":"frog"}"#, &["spritesheet.webp"]);
        let found = discover_in(&[t.root("app", "a"), t.root("petdex", "b")]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].root, "app");
    }

    #[test]
    fn one_bad_entry_does_not_cost_the_others() {
        let t = Tmp::new("resilience");
        t.pack("a", "good", r#"{"id":"good"}"#, &["spritesheet.webp"]);
        // Unparseable JSON, no sheet, and a loose file that is not a directory.
        t.pack("a", "broken", "{not json", &[]);
        fs::write(t.0.join("a").join("README.md"), b"hi").expect("stray file");

        let found = discover_in(&[t.root("app", "a")]);
        let ids: Vec<&str> = found.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["broken", "good"], "listed, sorted, neither fatal");
        assert_eq!(found[0].sheet, None, "the broken one just has no sheet");
    }

    #[test]
    fn a_missing_root_is_not_an_error() {
        let t = Tmp::new("missing");
        assert!(discover_in(&[t.root("app", "nope")]).is_empty());
    }
}
