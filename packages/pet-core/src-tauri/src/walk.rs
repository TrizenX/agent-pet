//! The pet pacing while the agent works.
//!
//! Spec §9.1 and TZX-81. Two rules shape everything here.
//!
//! **I6 first.** An idle pet costs approximately nothing, and that figure is
//! measured while nothing is happening. So there is no ticker unless the pet is
//! actually walking: the timer is created when work starts and dropped when the
//! pet gets home. Off is a real off — no task, no interval, no IPC.
//!
//! **The shell owns the motion.** The frontend says *working* or *not working*;
//! everything between those two messages happens here. Driving it from the
//! webview would mean an IPC round trip per animation frame, which is the same
//! mistake as the 250 ms drain loop M1's review removed — cheap enough to
//! measure clean and still a clock ticking against an invariant.
//!
//! The pet only paces while it is *working*. Not while idle, not asleep, and
//! deliberately not while waiting on an approval: a request that wanders away
//! from where the user last saw it is worse than one that sits still.

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use crate::window;

/// How often the window moves. Twelve a second reads as walking rather than
/// sliding, and is two orders of magnitude below a render loop.
const STEP_MS: u64 = 80;
/// Pixels per step.
const STEP_PX: i32 = 4;
/// How far from home the pet will wander, each way.
const RANGE_PX: i32 = 120;
/// A jump larger than one step did not come from us.
const DRAG_THRESHOLD_PX: i32 = STEP_PX * 3;

#[derive(Default)]
pub struct Walk {
    /// Where the pet lives. Everything is relative to this, so stopping means
    /// walking back rather than teleporting.
    home: Option<(i32, i32)>,
    offset: i32,
    dir: i32,
    /// Whether the agent is currently working.
    working: bool,
    /// Bumped on every start, so a task from a previous burst exits instead of
    /// two of them fighting over the window.
    generation: u64,
    /// The last position we asked for, to tell our own moves from the user's.
    commanded: Option<(i32, i32)>,
}

impl Walk {
    /// True while a position is being driven from here.
    pub fn is_driving(&self) -> bool {
        self.home.is_some()
    }

    /// Whether a `Moved` event came from the user rather than from us.
    ///
    /// The window emits `Moved` for our own steps too, so "the pet is walking"
    /// is not enough to tell them apart. A move we did not command, or one
    /// further than a single step could explain, is a hand on the window.
    pub fn is_user_drag(&self, to: (i32, i32)) -> bool {
        match self.commanded {
            None => true,
            Some((cx, cy)) => (to.0 - cx).abs() > DRAG_THRESHOLD_PX || (to.1 - cy).abs() > 0,
        }
    }

    /// The user moved the pet mid-stride. Their position wins.
    pub fn rehome(&mut self, to: (i32, i32)) {
        self.home = Some(to);
        self.offset = 0;
        self.commanded = Some(to);
    }

    /// Where the pet would sit if it stopped now — what gets persisted.
    pub fn resting_position(&self, current: (i32, i32)) -> (i32, i32) {
        self.home.unwrap_or(current)
    }
}

/// Tell the walker whether the agent is working.
///
/// Idempotent: the frontend sends this on every state change and most of them
/// do not change the answer.
#[tauri::command]
pub fn set_walking(app: tauri::AppHandle, on: bool) {
    let Some(shared) = app.try_state::<Arc<crate::tray::AppState>>() else {
        return;
    };
    if on && !shared.settings.lock().expect("settings poisoned").wander {
        return;
    }

    let mut walk = shared.walk.lock().expect("walk poisoned");
    if walk.working == on {
        return;
    }
    walk.working = on;

    if !on {
        // Do not stop the task — let it walk the pet home first. It exits by
        // itself once the offset reaches zero.
        println!("[walk] heading home");
        return;
    }

    if walk.home.is_none() {
        let Some(win) = app.get_webview_window("pet") else {
            return;
        };
        let Ok(pos) = win.outer_position() else {
            return;
        };
        walk.home = Some((pos.x, pos.y));
        walk.commanded = walk.home;
        walk.dir = 1;
    }
    walk.generation += 1;
    let generation = walk.generation;
    let home = walk.home;
    drop(walk);

    // An overlay cannot report where it thinks it is. Two lines a burst is the
    // difference between a debuggable "the pet did not move" and a shrug.
    println!("[walk] pacing from {home:?}");
    spawn_walker(app, generation);
}

/// Stop immediately and forget home. For the tray toggle and for shutdown,
/// where walking politely back is not what anyone wants.
pub fn halt(app: &tauri::AppHandle) {
    let Some(shared) = app.try_state::<Arc<crate::tray::AppState>>() else {
        return;
    };
    let mut walk = shared.walk.lock().expect("walk poisoned");
    walk.working = false;
    walk.generation += 1;
    let home = walk.home.take();
    walk.offset = 0;
    walk.commanded = None;
    drop(walk);

    if let (Some(home), Some(win)) = (home, app.get_webview_window("pet")) {
        window::place(&win, home);
    }
}

fn spawn_walker(app: tauri::AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(STEP_MS));
        let mut facing = 0i32;

        loop {
            ticker.tick().await;

            let Some(shared) = app.try_state::<Arc<crate::tray::AppState>>() else {
                return;
            };
            let Some(win) = app.get_webview_window("pet") else {
                return;
            };

            let mut walk = shared.walk.lock().expect("walk poisoned");
            // A newer burst took over. Two tasks stepping the same window would
            // double its speed and fight over direction.
            if walk.generation != generation {
                return;
            }
            let Some(home) = walk.home else { return };

            if walk.working {
                walk.offset += walk.dir * STEP_PX;
                if walk.offset.abs() >= RANGE_PX {
                    walk.offset = RANGE_PX * walk.dir.signum();
                    walk.dir = -walk.dir;
                }
            } else {
                // Heading home. Reaching it is what ends the task, so there is
                // no timer left running once the agent stops.
                let step = STEP_PX * if walk.offset > 0 { -1 } else { 1 };
                walk.offset = if walk.offset.abs() <= STEP_PX {
                    0
                } else {
                    walk.offset + step
                };
                walk.dir = if walk.offset > 0 { -1 } else { 1 };
                if walk.offset == 0 {
                    walk.commanded = Some(home);
                    walk.generation += 1;
                    drop(walk);
                    window::place(&win, home);
                    let _ = app.emit("pet-walk", 0i32);
                    return;
                }
            }

            let target = window::clamp_to_visible(&win, (home.0 + walk.offset, home.1));
            let dir = walk.dir;
            walk.commanded = Some(target);
            drop(walk);

            window::place(&win, target);

            // Only on a turn. The frontend needs this to choose between the two
            // run cycles, and it changes about once every three seconds.
            if dir != facing {
                facing = dir;
                // Also the only outside evidence that the window is really
                // moving. An overlay cannot report its own position, and
                // "pacing" printed once at the start proves only that the task
                // started.
                println!("[walk] facing {dir} at x={} (home {})", target.0, home.0);
                let _ = app.emit("pet-walk", dir);
            }
        }
    });
}
