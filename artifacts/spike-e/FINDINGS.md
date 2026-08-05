# Spike E — Linux

**TZX-74.** Does the pet work on Linux, and what does Wayland actually take away?

Spike A settled macOS by measuring. This is the same question for Linux, and it
had never been asked: every Linux claim in the spec and the README was reasoning
from how the protocols are documented to work. Some of it turned out right. The
part that was wrong had been wrong on every platform for months.

## Setup

A `rust:1-bookworm` container on arm64, with `libwebkit2gtk-4.1-dev`,
`libxdo-dev`, `libayatana-appindicator3-dev` and `librsvg2-dev`.

* **X11:** Xvfb at 1280x800, openbox as the window manager.
* **Wayland:** weston on its headless backend, `GDK_BACKEND=wayland`.

Not GNOME and not KDE, which the acceptance criteria ask for and this does not
deliver — see [What this does not answer](#what-this-does-not-answer). It does
run the real release binary, with the frontend bundled, driven by real hook
payloads over the real HTTP endpoint.

The build has to be a Tauri release build. `cargo build --release` produces a
binary that still loads `devUrl` and connects to a dev server nobody started;
it looks like a working pet with an empty window.

## It builds, and it runs

    Finished `release` profile [optimized] target(s) in 1m 29s
    Built application at: /tmp/target/release/agent-pet
    ELF 64-bit LSB pie executable, ARM aarch64

No source changes were needed to compile. The full path then worked end to end
on the first attempt:

    POST /event/claude-code            -> HTTP 204
    [webview:log] [pet] working.digging says "Running pnpm tauri build — hold on"

That is the adapter, the queue, the machine, the string layer and the renderer,
all running on a platform none of them had ever been on. Nothing in that chain
is macOS-flavoured, which is what §3.1 promises and had never been tested.

## What it found: the clamp was measuring zero

The first run placed the window here:

    0x00400003  1232 704  420 430  Agent Pet

A 420x430 window with its top-left corner at the bottom-right of a 1280x800
screen: 48 by 96 pixels of pet, and the rest off the edge.

`1232` is `1280 - 48 - 0`. The window believed it had no size.

`outer_size()` is fallible, and under GTK before the window is realized it also
*succeeds with 0x0*. `unwrap_or_default()` collapsed the error and the zero into
one silent `0`, and `default_corner` subtracted it.

The placement is the cosmetic half. The real one is that `clamp_to_visible`
measured the same zero:

    wanted.0 + w <= monitor.x + monitor.width

With `w = 0` this asks only whether the top-left corner is somewhere on a
monitor — a weaker test than "more than half overlaps", which is the rule the
comment directly above it exists to reject. **The check whose whole purpose is
to stop the window becoming invisible and undraggable would have approved the
position that made it invisible and undraggable.**

This is not a Linux bug. It is a latent bug on every platform, and Linux is
simply the one that reports the zero. macOS answers `outer_size()` promptly, so
it never happened there and never would have been found there.

Fixed in the same branch: `first_real_size` treats `0` as "no answer" and keeps
asking — `outer_size`, then `inner_size`, then the dimensions declared in
`tauri.conf.json`. `fits` is now a pure function over position, size and
monitors, so the zero is something a test can assert about; one of those tests
is the exact position Linux produced, rejected at 420x430 and accepted at 0x0.

`place` now reports where the window actually ended up rather than trusting
`set_position`'s return value, which is `Ok` on platforms that ignore the call.
After the fix, on the same container:

    [window] at 812,274
    0x00400003  812 274  420 430  Agent Pet

## The capability matrix

| Capability | X11 | Wayland | How it was measured |
| :-- | :-- | :-- | :-- |
| App runs, webview connects | ✅ | ✅ | `/health` reports `connected: true`; a real `PreToolUse` returns `204` and the bubble reads "Running pnpm tauri build — hold on" |
| `set_position` | ✅ | ❌ | X11: `wmctrl` reports `812 274 420 430`, the requested corner. Wayland: the pet asks for `0,0` and gets it, because `primary_monitor()` returns nothing to compute a corner from |
| Always-on-top | ✅ | ❌ | X11: `_NET_WM_STATE_ABOVE` (plus `SKIP_TASKBAR`, `SKIP_PAGER`). Wayland: no protocol exists for a client to request it |
| `set_ignore_cursor_events` | ✅ | — | See below |
| Transparency | ✅ ARGB visual | — | `xwininfo` reports `Depth: 32` for our window, against `24` for both the root window and an ordinary `xmessage` window on the same 24-bit screen |

**Click-through was measured differentially, which is the only way it means
anything.** With the pointer at 1000,480 — inside the pet's 420x430 window at
812,274:

    click_through = false  ->  window 2097762
    click_through = true   ->  window 1293

Neither number is self-evident, so both were named rather than assumed.
`xwininfo` puts window `2097762` at `Position: 812,274  Geometry: 420x430` —
our window, reparented by openbox. And `1293` is `0x50d`, which `xwininfo -root`
identifies as the root window. So with click-through off the pointer lands on
the pet, and with it on the pointer reaches the desktop. The capability works,
and the two states differ in the direction they should.

**The `set_position` read-back caught something worth keeping.** On X11, three
consecutive placements logged:

    [window] asked for 803,530 but the compositor placed it at 429,174
    [window] asked for 812,274 but the compositor placed it at 803,530
    [window] at 812,274

The reported position lags the request by one call — `outer_position()` is
answering from a cached value that X updates asynchronously. The final geometry
is correct and `wmctrl` agrees, so this is a property of the read-back and not
of the placement. Worth knowing before anyone treats a single such line as a
failure.

## Where the honest answer is "not measured"

**Transparency was not photographed.** Two attempts failed, for two different
reasons, and both are worth recording because each looked like a result.

The first screenshot was taken over a black root window. The pet appeared, but
black-on-black cannot distinguish a transparent window from an opaque black one,
so that image proves the pet renders and nothing about transparency.

The second set the root to `#FF0000` and sampled five points inside the window.
All five came back `RGB(0, 0, 0)` — no red. That reads like a clear failure, and
it is not one: openbox ships no compositing manager, and on X11 an ARGB window
with nothing compositing it is drawn opaque. The measurement was of the
container.

Adding `xcompmgr` made it worse in an instructive way: every sampled point came
back `RGB(128, 128, 128)`, a uniform mid-grey, because once a compositing
manager redirects rendering, `import -window root` no longer returns what is on
screen. Three runs, three different colours, none of them evidence.

`Depth: 32` is what finally settled it, and only because it comes with a
control: the root window and an ordinary window on the same screen report 24.
The pet has an alpha channel. Whether a given desktop composites it is a
property of that desktop, which is what §3.1 already said and what this cannot
check from a headless container.

## What this does not answer

**Not GNOME, not KDE.** TZX-74 asks for four environments; this covers two
compositors, neither of them a real desktop. openbox is a plain EWMH window
manager and weston is the Wayland reference compositor, so both are the
*standard-conforming* case. A desktop that deviates — Mutter's handling of
`_NET_WM_STATE_ABOVE`, KWin's rules — is not covered. What can be said is that
the capabilities work where the protocols say they should, and fail where the
protocol has nothing to offer, which is the part that was in doubt.

**Nobody has looked at the pet on a real Linux desktop.** Everything above is
window-server bookkeeping plus one screenshot over a black background. The
lesson this project keeps relearning is that those two disagree.

**arm64 only**, because the container is. Nothing in the change is
architecture-specific, but that is reasoning, not measurement.

## The decision

**Ship Linux as X11-only, and say so at startup.** Option (b) of the three in
TZX-74.

X11 supports every capability the overlay needs, and it needed no code changes
to get there. Wayland is not a degraded experience but a different product: no
positioning and no always-on-top means a pet fixed in the top-left corner,
behind whatever the user is working in. §1.1 says a pet you cannot see is worse
than no pet.

Tray-only degradation — option (a) — was rejected as premature. It is a second
product surface to design, build and maintain for a platform that is not a
Phase 1 target, and the thing that would make it worth doing is evidence that
people want to run this under Wayland, which does not exist yet.

So the app now detects the session at startup and says what it cannot do:

    [window] this is a Wayland session, where the pet cannot place itself or
    stay above other windows — it will sit at the top-left, behind whatever you
    are working in. Log in with an X11 session for the overlay to work.

Its weakness is stated rather than hidden: it goes to stderr, so someone who
launches the pet from a desktop icon will not see it. That is the right size of
answer for a best-effort platform, and the wrong one if Linux is ever promoted.

One caution about the read-back that reports this. Under Wayland the pet asks
for `0,0` and `outer_position()` returns `0,0`, so the log says `[window] at
0,0` — agreement, and completely uninformative. The instrument that made the
Linux placement bug obvious in one line cannot see the Wayland one at all,
because both sides of the comparison are wrong in the same way.


---

# X11, measured a second time: what "works" left out

Spike E answered *can it*. This asks *is it usable*, which turned out to be a
different question with a worse answer.

## Without a compositing manager the pet is a black box

The window gets a 32-bit ARGB visual — that part of Spike E holds. What Spike E
never checked is what happens when nothing is there to composite it.

Measured under Xvfb with openbox and no compositor, cropping the window's exact
rectangle out of a screenshot with a red root behind it:

| | no compositor | with `xcompmgr` |
| :-- | :-- | :-- |
| flat black | **93.0 %** | 2.0 % |
| pet content | 7.0 % | 98.0 % |
| red desktop showing through | 0.0 % | 0.0 % |

The screenshot is unambiguous: the sprite and the speech bubble render correctly,
in the right places, on a **solid black 420x430 rectangle**. On a real desktop
that is a black box sitting on top of whatever you are working in. Not a degraded
overlay — the opposite of one.

§1.1 says a pet you cannot see is worse than no pet. A pet you cannot see *past*
belongs in the same sentence.

## The `xcompmgr` column above is not evidence

Both compositor rows say 0.0 % red, which cannot be right: if transparency were
working, the red root would show through. It does not, because a compositing
manager redirects rendering and `import -window root` stops returning what is on
screen — the identical artefact that wasted a day on macOS during TZX-97, where
the same capture produced a uniform `RGB(128,128,128)`.

So: **no-compositor is measured, with-compositor is not.** The 98 % "content"
figure is the capture failing, not the pet succeeding. Whether transparency
actually composites on a real X11 desktop is still unphotographed, and the honest
way to get it is the window-id capture that finally worked on macOS — X11's
equivalent needs a compositor-aware grab, which `import -window root` is not.

## Fonts are fine, which was worth checking

The CSS stack is `ui-monospace, SFMono-Regular, Menlo, monospace` — three macOS
names and a fallback. A minimal Debian container with the webkit2gtk runtime
already carries 111 fonts and resolves `monospace` to DejaVu Sans Mono, and the
bubble renders legibly at 12px. Installing `fonts-dejavu-core` explicitly changed
nothing. No work needed.

## Idle CPU: measured, and not attributable

Two seconds of CPU over forty, so roughly 5 % of one core, against **0.083 %**
measured on macOS in Spike C. RSS 151 MB against ~350 MB on macOS.

That looks alarming and should not be quoted. Xvfb has no GPU: WebKit falls back
to software rendering, and the pet animates. The number describes llvmpipe, not
Linux. I6 remains unmeasured on Linux until someone runs it on a real X11 session
with hardware acceleration.

## What was done about it

`warn_if_not_composited`, beside the Wayland warning. GTK already answers the
question — `gdk_screen_is_composited` wraps the `_NET_WM_CM_S0` selection owner
check — and gdk is already in the dependency tree via tauri's Linux backend, so
asking costs nothing.

A warning, not a refusal: picom and xcompmgr both fix it, every composited desktop
already has one, and telling someone what to install is more use than declining to
start.

Verified on Linux in both directions, which is the only way a conditional warning
is worth anything:

    no compositor    -> warned once
    with xcompmgr    -> warned 0 times
