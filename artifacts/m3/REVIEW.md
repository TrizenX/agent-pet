# M3 code review

Five reviewers over `503a483..main` — spec/invariants, the Rust shell, the
frontend, project history, and one pointed at hostile pack input. Eight defects
survived verification. All eight are fixed on `kaydentrizenx/tzx-m3-review`.

The history reviewer's finding is the good news and worth recording first: M3
reintroduced none of the seven defects the M1 and M2 reviews catalogued, and it
*fixed* two of them that were already latent in the tree when M3 started.

---

## 1. A pack's directory name and its `pet.json` id are different strings

`packs.rs` keys a pack by its directory (`dir.file_name()`), and the tray writes
that string into `settings.pack`. `loader.ts` keys a `LoadedPack` by
`manifest.id`, the id the author wrote inside the file. `App.tsx` compared one
against the other.

They agree for every pack on this machine, which is why the manual test passed.
They do not agree in general. Of the first 120 pets in the public manifest,
**13 declare an `id` that differs from their install slug** — `wukong-5` →
`wukong`, `belayer-cat` → `cat-belayer`, `pearl-houzuki-2` → `Pearl Houzuki` —
and one declares no `id` at all. For every one of those, choosing the pack in
the tray updated the checkmark, persisted the selection, and silently rendered
the built-in pet.

Silently is the part that matters. The fallback is indistinguishable from never
having chosen anything.

**Fixed:** `discovery.ts` overrides the loaded pack's id with the one the shell
found it under, so the two ends of the wire use the same string. `App.tsx` now
logs which pack it is showing, and warns by name when a persisted selection
matches nothing. Verified end to end: `wukong-5` installed, selected, and
rendering — `[packs] showing "wukong-5"`.

## 2. An oversized sheet is decoded before it is rejected

`classifyGeometry` had no upper bound on scale. A sheet at 24576×29952 is a
*legal* v1 grid at scale 16 by every rule the code had, and `loadOne` called
`getImageData` over the whole canvas **before** geometry was ever checked.

That is a 2.9 GB allocation followed by `measureFrameCounts` walking 735 million
pixels synchronously — on the thread that draws the pet, for every pack found,
at every startup.

Two things were wrong and both are fixed. `MAX_SCALE = 4` caps it (memory is
quadratic in scale: s=4 is 184 MB, s=16 is 2.9 GB; every sampled gallery pet is
s=1). And `decode()` now classifies the geometry from the *bitmap's dimensions*
and throws before allocating any pixel buffer. `classifyGeometry` takes width
and height rather than an `ImageData` precisely so it can be called there.

The test that pins this asserts `getImageData` was never reached, not merely
that the pack was rejected. With the fix removed it fails — and takes 3.1
seconds to do it, which is the frame scan showing up even against mocks.

## 3. The built-in pet is the one pack with nothing beneath it

`defaultPack.ts` catches `buildPack` failures and substitutes a blank pack,
with a comment naming I4. It did not catch `decode()`. An undecodable bundled
sheet meant a rejected promise, `pack` staying `null`, and `App.tsx` rendering
nothing forever — the terminal state I4 forbids, reached through the file that
claims to prevent it. `discovery.ts` wraps the identical call.

**Fixed:** the decode is wrapped, and the fallback extracted so both paths reach
it.

## 4. One bad pack could stop the app from starting

`packs.rs` goes to real trouble to skip a bad entry rather than fail the scan.
`tray.rs` threw that away: each pack became a `CheckMenuItem::with_id(...)?`
inside the loop, and `tray::build()` is called with `?` from `setup()`. One
unrepresentable menu label — from a directory name in a root we do not control —
would have failed startup entirely.

**Fixed:** the item is skipped with a logged reason.

## 5. Two full disk scans at startup, on the main thread

`tray::build` called `packs::discover()`, and `list_packs` called it again for
the frontend. Beyond the doubled blocking I/O before the window is shown, two
independent scans are one more way for the tray and the webview to disagree
about what is installed — which is exactly defect 1's failure mode.

**Fixed:** scanned once in `setup`, held on `tray::AppState`, read by both.

## 6. `packs.rs` trusted a path a stranger wrote

`find_sheet` did `dir.join(declared)` with no containment check.
`PathBuf::join` **replaces** the whole path when the argument is absolute, so a
`spritesheetPath` of `/etc/passwd` became exactly that. `../..` resolved out of
the pack directory. A symlinked pack directory had us reading `pet.json`
through the link, since `std::fs` in the shell answers to no scope at all.

None of this was exploitable: the adversarial reviewer confirmed against the
pinned Tauri 2.11.5 source that the asset protocol canonicalizes and
scope-checks before serving, so the webview's later fetch got a 403. But the
defence lived entirely in an external layer, and would silently become a real
arbitrary-read primitive the day someone widened `assetProtocol.scope`.

**Fixed:** a declared sheet path must be a single ordinary path component, and a
pack directory must still be under its root after `canonicalize()`. Both are
tested, including a real symlink.

## 7. The I5 lint exemption was file-wide

M3 added `packs.rs` to `ALLOWED` so the `~/.codex/pets` install root would not
trip the agent-name pattern. That is a fair exemption for that string — the
root list is identical whether we support zero adapters or ten. But exempting
the *file* also blinded the check to `claude`, every hook event name, and every
tool name, for anything added to that file later. That is the shape of the gap
this script exists to close.

**Fixed:** the exemption is scoped to the two substrings that need it. Proved it
can still fail by adding `// PostToolUse` to `packs.rs` and watching the lint
reject it.

## 8. Two Tauri capabilities nothing uses

`core:webview:default` and `core:app:default` were added alongside the
asset-protocol scope. Pack loading needs neither — the read access comes from
`tauri.conf.json` — and nothing in the frontend imports either API. Between them
they grant the webview devtools toggling and window geometry commands, against
a capabilities file whose own description says "and nothing else."

**Fixed:** removed, with the reason recorded in the description.

---

## Also: 211 lines of new code had no tests

`packs.rs` (117) and `discovery.ts` (94) shipped with none. Both sit directly on
files strangers wrote, and defects 1, 2 and 6 all live in that untested surface.

Added: 8 Rust tests over `discover_in` (declared-sheet fallback, traversal,
absolute path, symlinked directory, duplicate-id precedence, one-bad-entry
resilience, missing root) and 5 TypeScript tests over `loadInstalledPacks`.

Each was checked against M2's rule — **a harness must prove it is pointed at
something real before it measures, and the proof has to be a check that can
fail.** Reverting the id fix and the scale ceiling turns the two tests that
matter red; that was verified, not assumed.

---

## What the reviewers cleared

Worth recording, because these were the specific worries:

- No code writes to `~/.petdex` or `~/.codex`. Read-only holds.
- `assetProtocol.scope` matches `packs::roots()` exactly — no wider.
- Duplicate ids across roots resolve deterministically, first root wins.
- The decoded `ImageData` is not retained on `LoadedPack`; rendering uses the
  URL. Not a soak-memory source.
- The StrictMode double-mount does not double-log — the `live` guard is
  per-invocation. It does decode twice in dev, which the compiled binary does
  not do.
- Every `#[tauri::command]` is registered and matches a frontend `invoke`.
- Deeply nested and oversized `pet.json` degrade to a rejected pack, not a crash.
- `manifest.id`, `displayName` and `description` reach no filesystem path, menu
  id, or DOM sink.
- The docs shipped in TZX-76 check out against the code, except the row-7 note
  below.

## Doc corrections

`docs/PET_PACKS.md` said row 7 is drawn for `working.typing`. It is also the
fallback for unclassified tool activity, which makes it the most-visible working
row — an author reading the table would have under-invested in it. Corrected,
along with a note about the 4× decode ceiling.
