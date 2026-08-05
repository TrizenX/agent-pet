//! Platform window behaviour for the overlay.
//!
//! Spec §9.1 and M0 Spike A. A plain always-on-top window does *not* float above
//! a full-screen macOS app: entering full screen moves the app to its own Space,
//! and an ordinary floating window neither joins that Space nor outranks it.
//! Many developers run their terminal full-screen, so without this the pet
//! disappears exactly when it matters.

use tauri::{Manager, PhysicalPosition, WebviewWindow};

/// Make the window behave as a system overlay: visible on every Space,
/// including the Space a full-screen app creates for itself.
pub fn apply_overlay_behaviour(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::apply(window);

    #[cfg(not(target_os = "macos"))]
    {
        // Windows: `alwaysOnTop` in tauri.conf.json is sufficient (HWND_TOPMOST).
        // Linux/X11: also sufficient — Spike E confirmed _NET_WM_STATE_ABOVE is
        // set, and `set_position` and `set_ignore_cursor_events` both work.
        let _ = window;
        #[cfg(target_os = "linux")]
        {
            warn_if_wayland();
            warn_if_not_composited();
        }
    }
}

/// Say out loud what Wayland takes away, once, at startup.
///
/// Spike E measured it: under Wayland the app runs and the webview connects,
/// but `primary_monitor()` returns nothing, so the pet cannot work out where
/// the corner is and lands at 0,0 — and there is no protocol for a client to
/// raise itself above other windows at all. That is a deliberate Wayland
/// decision, not a bug we can fix.
///
/// A pet sitting in the top-left corner under everything else looks like a
/// broken pet. TZX-74's acceptance is explicit that this must never fail
/// silently, so it does not: the one thing worse than an unsupported platform
/// is an unsupported platform that pretends.
#[cfg(target_os = "linux")]
fn warn_if_wayland() {
    let wayland = std::env::var("XDG_SESSION_TYPE")
        .is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
        || std::env::var("WAYLAND_DISPLAY").is_ok_and(|v| !v.is_empty());
    if !wayland {
        return;
    }
    eprintln!(
        "[window] this is a Wayland session, where the pet cannot place itself \
         or stay above other windows — it will sit at the top-left, behind \
         whatever you are working in. Log in with an X11 session for the \
         overlay to work. See artifacts/spike-e/FINDINGS.md."
    );
}

/// Say so when X11 has no compositing manager, because the pet becomes a box.
///
/// The window is transparent and gets a 32-bit ARGB visual, which Spike E
/// confirmed. What Spike E did not check is what happens when nothing is there
/// to composite it: X11 draws the unpainted area opaque, and the pet becomes a
/// solid 420x430 rectangle sitting on top of whatever you are working in.
///
/// Measured under Xvfb with openbox and no compositor: **93 % of the window is
/// flat black**, with the sprite and the bubble drawn on it. That is not a
/// degraded overlay, it is a black box, and §1.1's "a pet you cannot see is worse
/// than no pet" has an obvious sibling here.
///
/// GTK already answers this — `gdk_screen_is_composited` wraps the
/// `_NET_WM_CM_S0` selection owner check — and gdk is already in the tree via
/// tauri's Linux backend, so this costs nothing to ask.
///
/// A warning rather than a refusal: picom, xcompmgr and every desktop compositor
/// fix it, and the user may well have one. Telling them what to install is more
/// use than declining to start.
#[cfg(target_os = "linux")]
fn warn_if_not_composited() {
    use gdk::prelude::*;
    let Some(screen) = gdk::Screen::default() else {
        return;
    };
    if screen.is_composited() {
        return;
    }
    eprintln!(
        "[window] no compositing manager is running, so this X11 session cannot \
         draw a transparent window — the pet will appear as a solid black \
         rectangle rather than floating over your desktop. Start one (picom, \
         xcompmgr) or use a desktop environment that composites. Measured: 93 % \
         of the window is opaque without one."
    );
}

#[cfg(target_os = "macos")]
// The `objc` 0.2 macros emit a `cargo-clippy` cfg that current rustc flags as
// unexpected. Harmless, and not worth pulling in a heavier bindings crate for.
#[allow(unexpected_cfgs)]
mod macos {
    /// Just enough of CGGeometry to read a frame back. Declared rather than
    /// pulled in, for the same reason the collection-behaviour bits are named
    /// locally: the layout is auditable against Apple's headers.
    mod core_graphics_frame {
        #[repr(C)]
        #[derive(Copy, Clone)]
        pub struct CGPoint {
            pub x: f64,
            pub y: f64,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        pub struct CGSize {
            pub width: f64,
            pub height: f64,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        pub struct CGRect {
            pub origin: CGPoint,
            pub size: CGSize,
        }
        unsafe impl objc::Encode for CGRect {
            fn encode() -> objc::Encoding {
                unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
            }
        }
    }

    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::WebviewWindow;

    // NSWindowCollectionBehavior bits. Named here rather than pulled from a
    // bindings crate so the values are auditable against Apple's headers.
    const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    const STATIONARY: u64 = 1 << 4;
    const FULL_SCREEN_AUXILIARY: u64 = 1 << 8;
    const IGNORES_CYCLE: u64 = 1 << 6;

    #[allow(dead_code)]
    const MANAGED: u64 = 1 << 2;
    #[allow(dead_code)]
    const TRANSIENT: u64 = 1 << 3;

    /// NSStatusWindowLevel. Tauri's `always_on_top` sets NSFloatingWindowLevel
    /// (3), which a full-screen app still covers. 25 sits with the menu bar.
    const NS_STATUS_WINDOW_LEVEL: i64 = 25;

    /// Spike A knobs. Overridable so the level/behaviour matrix can be swept
    /// without a rebuild; see artifacts/spike-a/FINDINGS.md.
    fn level() -> i64 {
        std::env::var("PET_WINDOW_LEVEL")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(NS_STATUS_WINDOW_LEVEL)
    }

    fn behaviour_override() -> Option<u64> {
        std::env::var("PET_COLLECTION_BEHAVIOUR")
            .ok()
            .and_then(|v| v.parse().ok())
    }

    /// Convert to NSPanel unless explicitly disabled. On by default because
    /// Spike A · A3 showed the plain NSWindow route does not survive a
    /// full-screen transition.
    fn use_panel() -> bool {
        std::env::var("PET_USE_NSPANEL")
            .map(|v| v != "0")
            .unwrap_or(true)
    }

    const NONACTIVATING_PANEL: u64 = 1 << 7;

    extern "C" {
        fn object_setClass(
            obj: *mut Object,
            cls: *const objc::runtime::Class,
        ) -> *const objc::runtime::Class;
    }

    /// Re-class the Tauri NSWindow as an NSPanel and mark it non-activating.
    ///
    /// This is what shipping overlay apps actually do, and it is a different
    /// mechanism from collection behaviour: a non-activating panel never
    /// becomes key, so the window server treats it as auxiliary chrome rather
    /// than as a document window that belongs to one Space.
    ///
    /// Isa-swizzling NSWindow → NSPanel is safe here because NSPanel adds no
    /// instance variables; it only changes behaviour. The style mask bit is
    /// meaningless on a plain NSWindow, which is why the class has to change
    /// first.
    /// Re-class once, and only once.
    ///
    /// `apply` runs on every `show()`, which means startup, the tray's Show
    /// toggle, and — the one that hurt — the single-instance callback when
    /// someone launches the app a second time. Re-classing a window that is
    /// already an `NSPanel` and setting `floatingPanel` again crashes inside
    /// AppKit's window manager:
    ///
    ///     -[NSPanel setFloatingPanel:]
    ///     -[NSWindow _applyWindowLevelWithTagUpdateNeeded:]
    ///     -[_WMWindow setWindowLevel:]                      EXC_BREAKPOINT
    ///
    /// So double-clicking the app icon while it was running killed the pet that
    /// was already there. Found by a soak that died twenty seconds in, from a
    /// crash report rather than from any test.
    unsafe fn make_nonactivating_panel(ns_window: *mut Object) {
        use objc::runtime::{NO, YES};

        let already: bool = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
        if already {
            return;
        }

        object_setClass(ns_window, class!(NSPanel));

        let mask: u64 = msg_send![ns_window, styleMask];
        let _: () = msg_send![ns_window, setStyleMask: mask | NONACTIVATING_PANEL];

        // Float above the owning app's windows, never take key focus just
        // because the user clicked, and stay visible when the app deactivates —
        // which for a background overlay is always.
        let _: () = msg_send![ns_window, setFloatingPanel: YES];
        let _: () = msg_send![ns_window, setBecomesKeyOnlyIfNeeded: YES];
        let _: () = msg_send![ns_window, setHidesOnDeactivate: NO];
        let _: () = msg_send![ns_window, setWorksWhenModal: NO];
    }

    pub fn apply(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else {
            eprintln!("[window] ns_window() unavailable; overlay behaviour not applied");
            return;
        };
        let ns_window = ptr as *mut Object;
        if ns_window.is_null() {
            eprintln!("[window] ns_window() returned null; overlay behaviour not applied");
            return;
        }

        // FULL_SCREEN_AUXILIARY is the bit that lets the window appear over a
        // full-screen app. CAN_JOIN_ALL_SPACES keeps it present as the user
        // switches Spaces; STATIONARY stops it sliding during the transition
        // animation; IGNORES_CYCLE keeps it out of Cmd-` window cycling.
        let behaviour = behaviour_override()
            .unwrap_or(CAN_JOIN_ALL_SPACES | STATIONARY | FULL_SCREEN_AUXILIARY | IGNORES_CYCLE);
        let level = level();

        let panel = use_panel();

        unsafe {
            // Order matters: the class swap must happen before the style mask
            // and level are set, or they are applied to the wrong class and
            // partially reset by the conversion.
            if panel {
                make_nonactivating_panel(ns_window);
            }

            let _: () = msg_send![ns_window, setCollectionBehavior: behaviour];
            let _: () = msg_send![ns_window, setLevel: level];

            // Required, and easy to miss. With `focus: false` the app never
            // activates, and an unactivated app's windows are never ordered
            // onto the screen — the window exists in the window server with the
            // right level and bounds, and is simply not displayed. `show()`
            // alone does not fix it. `orderFrontRegardless` displays it without
            // activating the app, which is exactly what an overlay wants: it
            // must never steal focus from the editor or terminal.
            let _: () = msg_send![ns_window, orderFrontRegardless];
        }

        if std::env::var("PET_WINDOW_TRACE").as_deref() == Ok("1") {
            report(window, "after orderFrontRegardless");
            report_all(window);
        }
        trace(window);

        observe_space_changes(ns_window as usize, behaviour, level);

        println!(
            "[window] macOS overlay applied (nspanel={panel}, collectionBehavior={behaviour:#x}, level={level})"
        );
    }

    /// Every NSWindow the application owns, not just the one we styled.
    ///
    /// TZX-97: six hypotheses were tested and refuted, and every one of them
    /// asked the *same* window — the one `ns_window()` hands back. But
    /// `CGWindowList` shows this process owning two: ours at layer 25, and an
    /// unnamed 500x500 at layer 0. Nobody had checked which of them the webview
    /// actually lives in, or whether the overlay behaviour is being applied to
    /// the right object at all.
    ///
    /// It is also the control the earlier readings never had. `occlusion=0x2000`
    /// is not a legal `NSWindowOcclusionState`, which means either AppKit is
    /// returning something undocumented or my `msg_send` is wrong — and a second
    /// window in the same process, read the same way, distinguishes those two.
    pub fn report_all(window: &WebviewWindow) {
        unsafe {
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let windows: *mut Object = msg_send![app, windows];
            let count: usize = msg_send![windows, count];
            let ours = window.ns_window().map(|p| p as usize).unwrap_or(0);
            println!("[window] the app owns {count} NSWindow(s):");
            for i in 0..count {
                let w: *mut Object = msg_send![windows, objectAtIndex: i];
                let cls: *const objc::runtime::Class = msg_send![w, class];
                let name = std::ffi::CStr::from_ptr(objc::runtime::class_getName(cls))
                    .to_string_lossy()
                    .into_owned();
                let visible: bool = msg_send![w, isVisible];
                let on_space: bool = msg_send![w, isOnActiveSpace];
                let occ: u64 = msg_send![w, occlusionState];
                let level: i64 = msg_send![w, level];
                let alpha: f64 = msg_send![w, alphaValue];
                let opaque: bool = msg_send![w, isOpaque];
                let frame: core_graphics_frame::CGRect = msg_send![w, frame];
                println!(
                    "[window]   [{i}] {name}{} frame=({},{} {}x{}) level={level} \
                     visible={visible} onActiveSpace={on_space} occlusion={occ:#x} \
                     alpha={alpha} opaque={opaque}",
                    if w as usize == ours { " <- ours" } else { "" },
                    frame.origin.x as i64,
                    frame.origin.y as i64,
                    frame.size.width as i64,
                    frame.size.height as i64,
                );
            }
        }
    }

    /// Sample the window's state over time, when `PET_WINDOW_TRACE=1`.
    ///
    /// A single reading cannot tell a startup race from a permanent condition,
    /// and this project has now twice mistaken one sample for a cause. Off by
    /// default because an overlay must cost nothing when idle (I6).
    pub fn trace(window: &WebviewWindow) {
        if std::env::var("PET_WINDOW_TRACE").as_deref() != Ok("1") {
            return;
        }
        let win = window.clone();
        std::thread::spawn(move || {
            for i in 0..12 {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let w = win.clone();
                let label = format!("t+{}s", (i + 1) * 3);
                // AppKit is main-thread only, and reading these off it returns
                // stale nonsense rather than failing loudly.
                let _ = win.run_on_main_thread(move || report(&w, &label));
            }
        });
    }

    /// What AppKit thinks of our window, in its own words.
    ///
    /// TZX-97: the window sits in `CGWindowListOptionAll` at level 25 with
    /// correct bounds and never appears in `kCGWindowListOptionOnScreenOnly`,
    /// and cropping its exact rectangle out of a screenshot shows only what is
    /// behind it. Every hypothesis about *why* was checked from outside the
    /// process and every one of them was wrong — twice I read two coincidences
    /// as a cause.
    ///
    /// So this asks the object. `screen` is the interesting one: AppKit returns
    /// nil for a window it does not consider to be on any display, which
    /// distinguishes "ordered out" from "on screen but not composited" — two
    /// very different bugs that look identical from the window server's side.
    pub fn report(window: &WebviewWindow, when: &str) {
        let Ok(ptr) = window.ns_window() else { return };
        let ns_window = ptr as *mut Object;
        if ns_window.is_null() {
            return;
        }
        unsafe {
            let visible: bool = msg_send![ns_window, isVisible];
            let on_active_space: bool = msg_send![ns_window, isOnActiveSpace];
            let occlusion: u64 = msg_send![ns_window, occlusionState];
            let alpha: f64 = msg_send![ns_window, alphaValue];
            let screen: *mut Object = msg_send![ns_window, screen];
            let level: i64 = msg_send![ns_window, level];
            let miniaturized: bool = msg_send![ns_window, isMiniaturized];
            // Read back rather than trust the write. `setCollectionBehavior:`
            // silently drops bits AppKit considers invalid for the window's
            // class or style, and the whole question is whether
            // canJoinAllSpaces (0x1) actually took.
            let behaviour: u64 = msg_send![ns_window, collectionBehavior];
            let style: u64 = msg_send![ns_window, styleMask];
            let floating: bool = msg_send![ns_window, isFloatingPanel];

            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let hidden: bool = msg_send![app, isHidden];
            let active: bool = msg_send![app, isActive];
            let policy: i64 = msg_send![app, activationPolicy];

            println!(
                "[window] {when}: visible={visible} screen={} onActiveSpace={on_active_space} \
                 occlusion={occlusion:#x} alpha={alpha} level={level} miniaturized={miniaturized} \
                 behaviour={behaviour:#x} styleMask={style:#x} floatingPanel={floating} \
                 app(hidden={hidden} active={active} activationPolicy={policy})",
                if screen.is_null() { "nil" } else { "yes" }
            );
        }
    }

    unsafe fn ns_string(s: &str) -> *mut Object {
        let c = std::ffi::CString::new(s).expect("no interior NUL");
        let obj: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![obj, initWithUTF8String: c.as_ptr()]
    }

    /// Re-assert the overlay every time the active Space changes.
    ///
    /// Spike A · A3 measured this: a window ordered in on the normal desktop is
    /// visible in only 12 of 57 samples once the user enters full screen, even
    /// with `canJoinAllSpaces` set. Space membership is decided when the window
    /// is ordered in, and entering full screen builds a *new* Space that the
    /// existing window does not join. Creating the window while a full-screen
    /// Space is already active works fine — which is why a level sweep alone
    /// would have reported a false pass.
    ///
    /// Re-ordering on `NSWorkspaceActiveSpaceDidChangeNotification` costs
    /// nothing when the user is not switching Spaces, so it does not threaten
    /// invariant I6 the way a polling timer would.
    fn observe_space_changes(ns_window_addr: usize, behaviour: u64, level: i64) {
        use block::ConcreteBlock;
        use std::sync::Once;

        // One observer for the life of the process. Registering per `show()`
        // piled up a handler for every time the pet had ever been shown, each
        // re-asserting the level on every Space change — work that grew for as
        // long as the app ran, in the one place I6 promises nothing does.
        static REGISTERED: Once = Once::new();
        let mut registered = false;
        REGISTERED.call_once(|| registered = true);
        if !registered {
            return;
        }

        unsafe {
            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let center: *mut Object = msg_send![workspace, notificationCenter];
            let name = ns_string("NSWorkspaceActiveSpaceDidChangeNotification");
            let queue: *mut Object = msg_send![class!(NSOperationQueue), mainQueue];

            // The pointer is carried as a usize because a raw pointer is not
            // Send; the block only ever runs on the main queue, where touching
            // the NSWindow is safe.
            let block = ConcreteBlock::new(move |_notification: *mut Object| {
                let win = ns_window_addr as *mut Object;
                // Measured as insufficient on its own — see Spike A · A3. Kept
                // because it is the correct baseline for whatever fixes this,
                // and because it costs nothing. An `orderOut:` before the
                // re-entry was also tried and measured no better (10/55), while
                // adding a visible flicker, so it is not here.
                let _: () = msg_send![win, setCollectionBehavior: behaviour];
                let _: () = msg_send![win, setLevel: level];
                let _: () = msg_send![win, orderFrontRegardless];
            });
            let block = block.copy();

            let nil: *mut Object = std::ptr::null_mut();
            let _observer: *mut Object = msg_send![center,
                addObserverForName: name
                            object: nil
                             queue: queue
                        usingBlock: &*block];

            // The observer and its block must outlive this scope; the overlay
            // lives for the whole process, so leaking them is the correct
            // lifetime, not a bug.
            std::mem::forget(block);
        }
    }
}

/// Keep a remembered position on a monitor that still exists.
///
/// Undocking a laptop is enough to leave a saved position on a screen that is
/// no longer there, and a window placed off every display is invisible and
/// unrecoverable — the user has no way to drag back something they cannot see.
/// Anything outside the union of current monitors goes bottom-right of the
/// primary.
pub fn clamp_to_visible(win: &WebviewWindow, wanted: (i32, i32)) -> (i32, i32) {
    let (w, h) = window_size(win);
    let monitors: Vec<_> = win
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (p, s) = (m.position(), m.size());
            (p.x, p.y, s.width as i32, s.height as i32)
        })
        .collect();

    if fits(wanted, (w, h), &monitors) {
        return wanted;
    }
    default_corner(win)
}

/// Whether a `size` window at `wanted` sits wholly inside one of `monitors`,
/// each `(x, y, w, h)`.
///
/// Wholly on one screen, not merely mostly. "More than half overlaps" let a
/// stored position survive a change to the window's own width — and when the
/// window grew, the sprite (which sits centred in it) slid right by half the
/// difference and hung off the edge while the check still called it visible.
/// For a small always-on-top overlay there is no case where half-off is what
/// anyone wanted.
fn fits(wanted: (i32, i32), size: (i32, i32), monitors: &[(i32, i32, i32, i32)]) -> bool {
    monitors.iter().any(|&(mx, my, mw, mh)| {
        wanted.0 >= mx
            && wanted.1 >= my
            && wanted.0 + size.0 <= mx + mw
            && wanted.1 + size.1 <= my + mh
    })
}

/// The first of `candidates` that is a size a real window could have.
///
/// Zero is the trap. `outer_size()` is fallible *and*, under GTK before the
/// window is realized, succeeds with 0x0 — so `unwrap_or_default()` collapsed
/// the error and the zero into the same silent `0`. On Linux that placed a
/// 420x430 window's top-left in the bottom-right corner, leaving 48x96 pixels
/// of pet on a 1280x800 screen; and it quietly reduced `fits` above to "is the
/// top-left corner on a monitor", which is the weaker test its own comment
/// exists to reject. A window that reports no size has not told us anything,
/// and the honest response is to keep asking rather than to substitute zero.
fn first_real_size(candidates: impl IntoIterator<Item = (u32, u32)>) -> Option<(i32, i32)> {
    candidates
        .into_iter()
        .find(|&(w, h)| w > 0 && h > 0)
        .map(|(w, h)| (w as i32, h as i32))
}

/// The window's size in physical pixels, from whichever source can answer.
///
/// Falls back to the dimensions declared in `tauri.conf.json`, which is where
/// this window's size came from in the first place, so the fallback cannot
/// drift from the truth the way a hardcoded constant would.
fn window_size(win: &WebviewWindow) -> (i32, i32) {
    let reported = [win.outer_size(), win.inner_size()]
        .into_iter()
        .flatten()
        .map(|s| (s.width, s.height));
    if let Some(size) = first_real_size(reported) {
        return size;
    }

    let scale = win.scale_factor().unwrap_or(1.0);
    let declared = win
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == win.label())
        .map(|w| ((w.width * scale) as u32, (w.height * scale) as u32));

    first_real_size(declared).unwrap_or_else(|| {
        // Nothing left to ask. Say so: a window placed as if it had no size is
        // the failure this whole function exists to prevent, and it must not be
        // the one thing that happens silently.
        eprintln!("[window] no source could report the window size; placement may be wrong");
        (0, 0)
    })
}

/// Bottom-right of the primary monitor, inset from the edges.
pub fn default_corner(win: &WebviewWindow) -> (i32, i32) {
    let Ok(Some(monitor)) = win.primary_monitor() else {
        return (0, 0);
    };
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let (w, h) = window_size(win);
    let margin = (48.0 * scale) as i32;
    (
        screen.width as i32 - w - margin,
        screen.height as i32 - h - margin * 2,
    )
}

/// Move the window, and say where it actually ended up.
///
/// The read-back is the point. `set_position` returns `Ok` on platforms that
/// ignore it — under Wayland a client is not permitted to place its own window
/// at all (spec §3.1, TZX-74) — so the return value says nothing about whether
/// the pet moved. Asking the window where it is afterwards is the only answer
/// that means anything, and it is how the Linux placement bug was visible from
/// one line of output instead of a screenshot.
pub fn place(win: &WebviewWindow, at: (i32, i32)) {
    if let Err(e) = win.set_position(PhysicalPosition::new(at.0, at.1)) {
        eprintln!("[window] could not move to {},{}: {e}", at.0, at.1);
        return;
    }
    match win.outer_position() {
        Ok(p) if (p.x, p.y) == at => println!("[window] at {},{}", at.0, at.1),
        Ok(p) => println!(
            "[window] asked for {},{} but the compositor placed it at {},{}",
            at.0, at.1, p.x, p.y
        ),
        Err(e) => eprintln!(
            "[window] moved to {},{} but cannot read it back: {e}",
            at.0, at.1
        ),
    }
}

/// Toggle click-through.
///
/// While this is on the pet cannot be dragged, which is why the tray item says
/// so and why the tray is always the way back. Leaving a user with a window
/// they can neither click nor move would be unrecoverable without quitting.
///
/// Deliberately not folded into `apply_overlay_behaviour`: that function runs
/// on every show, and setting the flag there silently reset the user's choice
/// each time the pet was hidden and shown again.
pub fn set_click_through(win: &WebviewWindow, on: bool) {
    if let Err(e) = win.set_ignore_cursor_events(on) {
        eprintln!("[window] click-through toggle failed: {e}");
    }
}

/// Show the pet, correctly.
///
/// Three things have to happen together and used to be three separate call
/// sites that each remembered a different subset:
///
///   * `show()`, obviously;
///   * re-assert the overlay behaviour, because a window hidden across a Space
///     change comes back as an ordinary one and quietly undoes Spike A;
///   * re-apply click-through, because it is a window flag and showing does not
///     preserve the user's choice.
///
/// Callers that forgot the third silently turned click-through off every time
/// the pet was hidden and shown again.
pub fn show(win: &WebviewWindow, click_through: bool) {
    let _ = win.show();
    apply_overlay_behaviour(win);
    set_click_through(win, click_through);
}

#[cfg(test)]
mod tests {
    use super::{first_real_size, fits};

    /// The screen the containerised Linux run actually used.
    const SCREEN: [(i32, i32, i32, i32); 1] = [(0, 0, 1280, 800)];
    /// The pet's window, from tauri.conf.json.
    const PET: (i32, i32) = (420, 430);

    #[test]
    fn a_window_wholly_on_screen_fits() {
        assert!(fits((100, 100), PET, &SCREEN));
        // Flush against the bottom-right corner is still inside.
        assert!(fits((1280 - 420, 800 - 430), PET, &SCREEN));
    }

    #[test]
    fn hanging_off_any_edge_does_not_fit() {
        assert!(!fits((1000, 100), PET, &SCREEN), "off the right edge");
        assert!(!fits((100, 600), PET, &SCREEN), "off the bottom edge");
        assert!(!fits((-1, 100), PET, &SCREEN), "off the left edge");
        assert!(!fits((100, -1), PET, &SCREEN), "off the top edge");
    }

    /// The Linux bug, as an assertion.
    ///
    /// `default_corner` put the window here because it believed the window was
    /// 0x0. Only 48x96 pixels of a 420x430 pet were on screen — and the clamp
    /// that exists to catch exactly that called the position visible, because
    /// it was measuring the same zero.
    #[test]
    fn the_position_linux_produced_is_rejected_at_the_real_size() {
        let off_screen = (1232, 704);
        assert!(!fits(off_screen, PET, &SCREEN));
        assert!(
            fits(off_screen, (0, 0), &SCREEN),
            "a zero size makes the clamp accept it — which is why zero must never reach it"
        );
    }

    #[test]
    fn a_zero_size_is_not_an_answer() {
        assert_eq!(first_real_size([(0, 0)]), None);
        assert_eq!(first_real_size([(0, 430)]), None, "half a size is no size");
        assert_eq!(first_real_size([(0, 0), (420, 430)]), Some((420, 430)));
        assert_eq!(first_real_size([]), None);
    }
}
