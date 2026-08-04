---
description: Check whether Agent Pet is actually wired up — is the pet running, are the hooks installed, and do they agree on a port.
---

# Agent Pet — doctor

The three ways this setup fails are all silent: the pet is not running, the hooks are not
installed, or they point at a port nothing is listening on. None of them produces an error
anywhere — the pet simply never reacts. Diagnose each one and say which it is.

**The plugin does not contain the pet.** It only installs hooks. Somebody who installed the
plugin and saw nothing happen has almost certainly not built the app yet, and that is the
first thing to check, not the last.

## Steps

1. **Is the pet listening?**

   ```sh
   curl -s --max-time 2 http://127.0.0.1:48200/health
   ```

   A JSON body means yes. Read `webview.connected` from it: the HTTP server can be up while
   the window has not finished loading, and that is a different problem from a dead pet.

   Connection refused means the app is not running.

2. **Are this plugin's hooks active?** Confirm the plugin is enabled in
   `~/.claude/settings.json` under `enabledPlugins` (look for `agent-pet@trizenx`), and
   check whether there is also a manual block in `hooks` pointing at
   `127.0.0.1:48200/event/claude-code`. Both being present is harmless — each event just
   arrives twice — but only one is needed.

3. **Do they agree on the port?** The endpoint is baked into the hook URLs. If the pet was
   started with a non-default `PET_PORT`, the hooks point somewhere nothing is listening.
   Compare the port in the hook URLs against the one the pet answered on.

4. **Only if the pet is running and hooks are wired**, prove the whole path end to end:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     http://127.0.0.1:48200/event/claude-code \
     -H 'content-type: application/json' \
     -d '{"hook_event_name":"PreToolUse","session_id":"doctor","cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"echo hello"}}'
   ```

   `204` is the only correct answer (invariant I1: always `204`, always an empty body). The
   pet should visibly react.

## Reporting

Be concrete about which half is missing, and give the fix rather than the diagnosis alone.

* **Pet not running, never built** — this is the common case. Tell them the plugin is only
  the wiring and give the build commands:

  ```sh
  git clone https://github.com/TrizenX/agent-pet && cd agent-pet
  corepack enable && pnpm install
  pnpm --filter @agent-pet/pet-core tauri build --no-bundle
  ./packages/pet-core/src-tauri/target/release/agent-pet &
  ```

  Mention that `cargo build --release` alone produces a binary that loads a dev server
  nobody started and shows an empty window — a trap that looks exactly like a broken pet.

* **Pet built but nothing appears on screen.** Known and open: TZX-97. Ask them to check
  whether it is on another desktop/Space, and to run with `PET_WINDOW_TRACE=1`, which makes
  the window report `isVisible`, `isOnActiveSpace` and `occlusionState` every three
  seconds. Do not guess at a cause — six plausible ones have already been measured and
  refuted.

* **Pet running, hooks missing** — the plugin may be installed but disabled. Otherwise
  `node packages/adapter-claude-code/src/cli.ts install` writes the block manually, with a
  backup.

* **Ports disagree** — reinstall the hooks for the pet's actual port:
  `node packages/adapter-claude-code/src/cli.ts doctor --port <N>` prints the right block.

* **Everything checks out** — say so plainly and stop. Do not print a block of
  configuration to paste; under a green report that reads as work remaining, which is the
  one question this command exists to answer.

Never claim it works because the hooks returned `204`. A refused connection and a working
pet are both fast and quiet; only `/health` and the pet moving tell them apart.
