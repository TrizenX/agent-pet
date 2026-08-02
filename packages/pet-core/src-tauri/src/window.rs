//! Platform window behaviour for the overlay.
//!
//! Spec §9.1 and M0 Spike A. A plain always-on-top window does *not* float above
//! a full-screen macOS app: entering full screen moves the app to its own Space,
//! and an ordinary floating window neither joins that Space nor outranks it.
//! Many developers run their terminal full-screen, so without this the pet
//! disappears exactly when it matters.

use tauri::{PhysicalPosition, WebviewWindow};

/// Make the window behave as a system overlay: visible on every Space,
/// including the Space a full-screen app creates for itself.
pub fn apply_overlay_behaviour(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::apply(window);

    #[cfg(not(target_os = "macos"))]
    {
        // Windows: `alwaysOnTop` in tauri.conf.json is sufficient (HWND_TOPMOST).
        // Linux: see spec §3.1 — under Wayland a client cannot force this at all.
        // Tracked by TZX-74.
        let _ = window;
    }
}

#[cfg(target_os = "macos")]
// The `objc` 0.2 macros emit a `cargo-clippy` cfg that current rustc flags as
// unexpected. Harmless, and not worth pulling in a heavier bindings crate for.
#[allow(unexpected_cfgs)]
mod macos {
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
    unsafe fn make_nonactivating_panel(ns_window: *mut Object) {
        use objc::runtime::{NO, YES};

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

        observe_space_changes(ns_window as usize, behaviour, level);

        println!(
            "[window] macOS overlay applied (nspanel={panel}, collectionBehavior={behaviour:#x}, level={level})"
        );
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
    let size = win.outer_size().unwrap_or_default();
    let (w, h) = (size.width as i32, size.height as i32);

    let monitors = win.available_monitors().unwrap_or_default();
    // Wholly on one screen, not merely mostly.
    //
    // "More than half overlaps" let a stored position survive a change to the
    // window's own width — and when the window grew, the sprite (which sits
    // centred in it) slid right by half the difference and hung off the edge
    // while the check still called it visible. For a small always-on-top
    // overlay there is no case where half-off is what anyone wanted.
    let visible = monitors.iter().any(|m| {
        let pos = m.position();
        let ms = m.size();
        wanted.0 >= pos.x
            && wanted.1 >= pos.y
            && wanted.0 + w <= pos.x + ms.width as i32
            && wanted.1 + h <= pos.y + ms.height as i32
    });

    if visible {
        return wanted;
    }
    default_corner(win)
}

/// Bottom-right of the primary monitor, inset from the edges.
pub fn default_corner(win: &WebviewWindow) -> (i32, i32) {
    let Ok(Some(monitor)) = win.primary_monitor() else {
        return (0, 0);
    };
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let size = win.outer_size().unwrap_or_default();
    let margin = (48.0 * scale) as i32;
    (
        screen.width as i32 - size.width as i32 - margin,
        screen.height as i32 - size.height as i32 - margin * 2,
    )
}

pub fn place(win: &WebviewWindow, at: (i32, i32)) {
    let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
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
