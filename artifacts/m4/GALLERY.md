# M4 · gallery client — what was measured

## Nothing is fetched until someone asks

Checked two ways, because the obvious one is weaker than it looks.

**No cache file after a normal launch.** The index is written to app-data only
after a successful fetch, so its absence means no fetch happened:

```
$ ls ~/Library/.../dev.trizenx.agent-pet/gallery-index.json
No such file or directory
```

**No outbound socket.** The whole app, sixty seconds after launch:

```
COMMAND     PID  USER   FD   TYPE   NAME
agent-pet 84611 hello   10u  IPv4   TCP 127.0.0.1:48200 (LISTEN)
```

One socket, and it is the one we listen on. Note the limit honestly: WKWebView
does its networking in a separate daemon process, so this proves the *shell*
made no request, not the webview. That is why the cache-file check is also here
— between them they cover both processes.

**And the check can fail.** Opening the picker produced the file immediately, at
exactly the size the CDN reports:

```
-rw-r--r--  1452458  gallery-index.json
```

## Installing works, and found a bug on the way

Installing `belayer-cat` wrote 1 161 676 bytes, and then the pet did not change.

The log said why, because M3's review added a line for exactly this:

```
[gallery] installed belayer-cat (1161676 bytes)
[packs] 4 loaded, 1 skipped
[packs] selected pack "belayer-cat" is not among the 4 loaded; showing the built-in pet
```

M3's review made the shell scan the disk **once**, at startup, so the tray and
the frontend could not disagree about what is installed. That was right, and it
became wrong the moment this milestone gave the app the ability to write a pack:
`list_packs` kept serving the startup list, so a pet the user had just installed
was invisible until the next launch.

Fixed by refreshing the cached list from `install_pack` and `uninstall_pack` —
the only rescans in the app, and both are ones the user asked for by pressing a
button. Not a poll.

```
[gallery] installed belayer-cat (1161676 bytes)
[gallery] pack list refreshed: 6 on disk
[packs] 5 loaded, 1 skipped
[packs] showing "belayer-cat"
```

`belayer-cat` is a useful test case twice over: its `pet.json` declares
`cat-belayer`, so this also exercises M3's directory-name fix through a path
that did not exist when that fix was written.

## Release build

`cargo build --release` is **not** a production build. It still loads `devUrl`,
because Tauri decides dev-versus-production from how `tauri-build` was invoked,
not from the cargo profile:

```
[setup] window url = Ok("http://localhost:1420/")
```

The harness caught this and refused to measure — the precondition it grew in M2
after grading an empty shell twice. `pnpm tauri build --no-bundle` gives the
real thing:

```
[setup] window url = Ok("tauri://localhost")
```

## A content security policy, at last

`csp` was `null`, which disables CSP entirely. That was defensible while the app
made no requests. It is not defensible now that it makes two.

Set for production only (`devCsp: null`), because Vite's dev server needs inline
scripts and a websocket that production does not:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: asset: http://asset.localhost;
connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost
            https://petdex.dev https://assets.petdex.dev
```

Verified against the production build rather than assumed: the webview connects,
the console bridge (which runs through `eval`) still reports, and packs still
decode through the asset protocol.

## Invariants, release build

| | debug (M2) | release (M4) |
| :-- | --: | --: |
| I6 idle CPU | 0.022 % | **0.100 %** |
| I2 hook round trip, median | 0.164 ms | **0.202 ms** |
| I2 hook round trip, p99 | 0.439 ms | **0.455 ms** |
| I2 refused connection | 0.113 ms | **0.092 ms** |

7/7 pass. The numbers are close enough to the debug ones to be unremarkable,
which is itself worth recording: the M2 figures were not misleading, they were
just unproven. Idle CPU is higher in release and still two orders of magnitude
under the budget — a single sample either way, not a trend.

The soak is separate and still running; see `invariants-release-soak.json`.
