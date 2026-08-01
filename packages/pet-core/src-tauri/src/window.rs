//! Platform window behaviour for the overlay.
//!
//! Spec §9.1 and M0 Spike A. A plain always-on-top window does *not* float above
//! a full-screen macOS app: entering full screen moves the app to its own Space,
//! and an ordinary floating window neither joins that Space nor outranks it.
//! Many developers run their terminal full-screen, so without this the pet
//! disappears exactly when it matters.

use tauri::WebviewWindow;

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
            let _: () = msg_send![ns_window, setIgnoresMouseEvents: false];

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
