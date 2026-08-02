# M4 code review

Five reviewers over `2da2a49..main` — adversarial gallery input, the Rust shell
and its new concurrency, the frontend, spec and docs, and project history. Seven
defects survived verification. All seven are fixed.

The history reviewer found no recurrence of the ten defects M1–M3 catalogued.

Every finding below is in code M4 wrote. That is the pattern worth naming: the
milestone that added the network and the first file write is the milestone whose
review found the most.

---

## 1. The geometry check is not a size check

`classifyGeometry` caps the *decoded* dimensions at 4× — a fix from M3's own
review. Nothing capped the *bytes*.

A PNG is a chunk container, and every decoder skips chunks it does not
recognise. The reviewer built one: an ordinary, entirely valid 1536×1872 sheet
with a junk ancillary chunk spliced in after IHDR, **11 239 bytes → 5 254 131
bytes**, decoding to byte-identical pixels. Nothing in the pipeline looked at
`Content-Length` and nothing truncated, so a hostile `spritesheetUrl` could
serve hundreds of megabytes that passed every check we had.

The mistake was treating a bound on what the file *depicts* as a bound on what
the file *is*.

**Fixed:** an 8 MB ceiling, checked three times — against the declared
`Content-Length` before reading the body, against the real blob size after, and
again in Rust, which is the copy that enforces. Real sheets are 1–2 MB.

## 2. Bytes crossed the IPC boundary as a list of decimal numbers

`Array.from(new Uint8Array(...))`, then Tauri's `JSON.stringify`.

The reviewer traced Tauri's own `process-ipc-message-fn.js` and confirmed the
raw-bytes fast path applies only when the *entire* invoke payload is a typed
array — never true for a command with named arguments. Then measured it: an 8 MB
buffer became a **154 MB retained JS array** and a **~30-million-character**
JSON string. Fifteen to twenty times the source, on a single button press.

**Fixed:** base64, which is 1.33×. `base64 0.22` was already compiled into the
tree via `tauri → plist`, so this cost no new dependency. Verified end to end:
`installed belayer-cat (1161676 bytes)` — the same byte count the raw path
produced, so the round trip is exact.

## 3. Every install froze the pet

A `#[tauri::command]` that is not `async` is called **inline** on the thread
owning the webview's IPC handler — the platform UI thread. The reviewer
confirmed this in `tauri-macros`' `wrapper.rs` and `tauri`'s `ipc/command.rs`
rather than inferring it.

So `install_pack` did its base64 decode, its multi-megabyte write, and then
`refresh_pack_list` — a scan of three directories, two of which we do not
control and whose size is unbounded — on the thread that draws the pet. Every
install, not once at startup.

**Fixed:** `off_thread`, a `spawn_blocking` wrapper, around every command in
`gallery.rs`. `async fn` alone would not have been enough; it would have moved
the stall onto an async worker instead of off a thread entirely.

## 4. Nothing gave up

No timeout on any gallery fetch. Both `catch` blocks handled a *rejected*
fetch — DNS failure, refused connection — and did nothing for one that never
settles, which is the commoner failure on a real network: a captive portal, a
stalled socket, a slow proxy.

`busy` disables every install button while one is in flight, so a single hung
request degraded the entire picker to "downloading…" with no way back except
closing it.

**Fixed:** `AbortSignal.timeout(15_000)` on every request.

## 5. A CSP block and being offline looked identical

`connect-src` is a host allowlist, and it is the *only* thing stopping a
manifest from pointing `spritesheetUrl` at `file:///etc/passwd` — there was no
application-level check at all. That part works: the reviewer confirmed the
production CSP refuses it.

But a CSP refusal reaches JavaScript as a bare `TypeError`, indistinguishable
from having no network. And the allowlist hardcodes `assets.petdex.dev`, a host
nothing in the manifest schema guarantees. If the gallery moves its CDN, every
install fails and the app says "could not reach the gallery".

**Fixed:** the host is checked before fetching, so the refusal names it. Not for
safety — the CSP is still what enforces — but so the failure is legible. Tested
with a manifest entry pointing at `file:///etc/passwd`; the test asserts the
fetch was never attempted.

## 6. Windows slugs that can never install

`is_safe_slug` accepted `con`, `nul`, `aux`, `prn`, `com1`…`lpt9` — reserved at
the Win32 level in every directory, case-insensitively. Not an escape: a pet
that fails to install forever, on a target platform, for a reason no error
message would explain.

**Fixed and tested**, including that `console`, `con-cat` and `com10` are still
fine.

## 7. A new empty catch, in the milestone that knows better

`.catch(() => {})` on the `open-gallery` listener teardown — the exact pattern
that hid three unregistered Tauri commands for two milestones, added new in a
milestone whose own `useShellSettings.ts` cites that incident as the reason not
to.

There were six across the frontend. Rather than add six log lines, they now go
through one `stopListening(unlisten, event)` helper, so the next listener cannot
reintroduce the silent version by copying its neighbour.

Also fixed: `onInstalled` chained `rescanPacks().then(() => selectPack(slug))`
with no catch. Currently unreachable — `rescanPacks` cannot reject — but the
failure it would produce is *the picker says "installed" and the pet never
changes*, which is the silent-success shape this project has now shipped twice.

## Doc gap

§10 of the spec is where security controls live, and the CSP was not in it — it
existed only in `artifacts/m4/GALLERY.md`. Added, along with the pack-download
rules, and stating plainly that **`devCsp` is `null`, so a dev build has no CSP
at all** and anything relying on it must be verified against `tauri build`.

---

## What the reviewers cleared

- **`remove_dir_all` on a symlinked `packs/<slug>` does not escape.** Verified
  with a standalone Rust program: it removes the link, not the target. A
  symlinked pack cannot be used to delete files elsewhere.
- **No deadlock** from the second mutex. Nothing holds `settings` and `packs`
  together; `refresh_pack_list` scans *before* taking the lock, so it is held
  only for the assignment.
- **No manifest field reaches the DOM unescaped** — `displayName` and `slug` are
  a JSX text child and a `title`, and there is no `dangerouslySetInnerHTML`
  anywhere.
- **The `decode.ts` extraction lost nothing**, and incidentally fixed the
  built-in pet, whose old private copy had neither the geometry check nor
  `bitmap.close()` on the no-context path.
- **`busy` cannot get stuck**, the status slot cannot show both a button and a
  status, and filtering 4 347 entries per keystroke is genuinely fine.
- **§12.4's three constraints hold**, I6 gained no timer, I4 has no new terminal
  state, and the IP policy is not crossed: only the *index* is cached, never the
  art.
- **`generate_handler!` lists all eleven commands** — checked again after each
  `rustfmt` pass, which is how three went missing at the end of M2.
- **Every number in `GALLERY.md`** matches `artifacts/m2/invariants.json` and
  `artifacts/m4/invariants-release.json` exactly.

## One process change

Twice this milestone a clean local run met a red `rust` job over formatting
alone. `pnpm verify` covers the TypeScript half of the repo and nothing told
anyone the other half had its own gate. `pnpm verify:rust` now runs
`rustfmt --check` and `cargo test`; it caught the third instance before the
push.
