# agent-pet plugin

**This plugin is half the install.** It wires your session's hooks to a pet; it does not
contain the pet. On its own it does nothing at all — and it does nothing *silently*, which
is why this is the first thing written here rather than a footnote.

The pet is a desktop app you run. Download it from
[Releases](https://github.com/TrizenX/agent-pet/releases) — universal `.dmg`, Apple Silicon
and Intel — drag it to Applications, and then:

```sh
xattr -dr com.apple.quarantine "/Applications/Agent Pet.app"
```

The build is **unsigned**, because signing and notarising need an Apple Developer identity
this project does not have. `spctl` reports `no usable signature`, and macOS will not open a
quarantined app that fails assessment. Removing the quarantine attribute is what lets it
run — do not do that for software you do not trust. Each release ships a `.sha256`.

Or build it yourself, which asks you to trust nothing: [Rust](https://rustup.rs) and
Node 20+, a few minutes the first time.

```sh
git clone https://github.com/TrizenX/agent-pet && cd agent-pet
corepack enable && pnpm install
pnpm --filter @agent-pet/pet-core tauri build --no-bundle
./packages/pet-core/src-tauri/target/release/agent-pet &
```

> `cargo build --release` on its own is **not** enough. Tauri decides dev-versus-production
> from how `tauri-build` was invoked, not from the cargo profile, so that binary tries to
> load a dev server nobody started and shows an empty window. Use the command above.

## Is it working?

```
/agent-pet:doctor
```

That answers the only three questions that matter — is the pet running, are the hooks
installed, and do they point at the port the pet is actually on — because all three fail
the same way: the pet never reacts, with no error anywhere.

If you would rather not build anything yet, that is a fine place to stop. The hooks are
harmless without the pet (below); you just will not see a pet.

## What it does to your session

Nothing, by design. Every hook is an HTTP POST to `127.0.0.1:48200` with a two-second
timeout, and the pet answers `204` with an empty body — a hook response body can block a
tool call, so the pet's server has no code path that reads the request or produces a
decision (spec invariant I1).

If the pet is not running, the connection is refused instantly on loopback and the hook
costs nothing measurable. Measured round-trip with the pet running: **0.16 ms**; with it killed, 0.11 ms to be
refused. (An earlier 0.21 ms figure was `curl` startup, not the endpoint.)

## Moving the port

The endpoint is baked into the hook URLs, so a non-default `PET_PORT` needs a different
block. `doctor` prints the right one and tells you what is currently wired:

```
node packages/adapter-claude-code/src/cli.ts doctor --port 49000
```

The pet refuses to start on a busy port rather than quietly choosing another one, for the
same reason: hooks point at a URL, and a silent move is a pet that stops reacting with no
error anywhere.

## Platforms

macOS and Windows. Linux works under X11 and **not** under Wayland: a Wayland client
cannot position its own window or stay above other windows, so the pet would sit in the
top-left corner behind your editor. The app says so on stderr at startup rather than
pretending — [why](https://github.com/TrizenX/agent-pet/blob/main/artifacts/spike-e/FINDINGS.md).
