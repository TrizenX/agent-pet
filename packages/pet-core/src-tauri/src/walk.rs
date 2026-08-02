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

use std::collections::VecDeque;
use std::sync::Arc;

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
/// How many of our own recent moves to remember.
///
/// One is not enough. `set_position` is dispatched differently depending on the
/// caller's thread: from the main thread it applies inline, from the walker's
/// tokio task it is posted to the event loop and drains later. So a move the
/// walker issued can land *after* a move `halt` made, and comparing against
/// only the most recent command would read that straggler as a hand on the
/// window. Eight covers about two thirds of a second of queued steps.
const COMMAND_MEMORY: usize = 8;

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
    /// Positions we recently asked for, to tell our own moves from the user's.
    commanded: VecDeque<(i32, i32)>,
}

impl Walk {
    /// True while this module owns the window's position.
    ///
    /// Stays true after the pet stops pacing, because home outlives a burst of
    /// work — and because a straggling move can still arrive after it.
    pub fn is_driving(&self) -> bool {
        self.home.is_some()
    }

    fn note_command(&mut self, at: (i32, i32)) {
        if self.commanded.len() == COMMAND_MEMORY {
            self.commanded.pop_front();
        }
        self.commanded.push_back(at);
    }

    /// Whether a `Moved` event came from the user rather than from us.
    ///
    /// The window emits `Moved` for our own steps too, so "the pet is walking"
    /// is not enough to tell them apart. A move we did not command, or one
    /// further than a single step could explain, is a hand on the window.
    pub fn is_user_drag(&self, to: (i32, i32)) -> bool {
        !self
            .commanded
            .iter()
            .any(|&(cx, cy)| (to.0 - cx).abs() <= DRAG_THRESHOLD_PX && to.1 == cy)
    }

    /// The user moved the pet mid-stride. Their position wins.
    pub fn rehome(&mut self, to: (i32, i32)) {
        self.home = Some(to);
        self.offset = 0;
        self.commanded.clear();
        self.note_command(to);
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
        walk.note_command((pos.x, pos.y));
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

/// Stop now, mid-stride. For the tray toggle, for reduced motion, and for
/// shutdown — walking politely back is not what someone who just said "stop
/// moving" asked for.
///
/// Home is deliberately *kept*. It is where the pet lives, not a lease held for
/// the duration of one burst, and keeping it is what lets `remember_position`
/// still recognise a straggling move as ours rather than as a drag.
#[tauri::command]
pub fn halt_walking(app: tauri::AppHandle) {
    halt(&app);
}

pub fn halt(app: &tauri::AppHandle) {
    let Some(shared) = app.try_state::<Arc<crate::tray::AppState>>() else {
        return;
    };
    let Some(win) = app.get_webview_window("pet") else {
        return;
    };

    let mut walk = shared.walk.lock().expect("walk poisoned");
    walk.working = false;
    walk.generation += 1;
    walk.offset = 0;
    let Some(home) = walk.home else {
        return;
    };
    // Clamped like every other placement. `home` was valid when it was
    // captured; a display can be unplugged during a multi-minute agent run, and
    // teleporting to a coordinate that no longer exists leaves the pet off
    // every screen with no timer left running to rescue it.
    let target = window::clamp_to_visible(&win, home);
    walk.home = Some(target);
    walk.note_command(target);
    drop(walk);

    window::place(&win, target);
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
                    // Clamped, for the same reason `halt` clamps: this is the
                    // one placement that does not go through the step below.
                    let settled = window::clamp_to_visible(&win, home);
                    walk.home = Some(settled);
                    walk.note_command(settled);
                    walk.generation += 1;
                    drop(walk);
                    window::place(&win, settled);
                    let _ = app.emit("pet-walk", 0i32);
                    return;
                }
            }

            let target = window::clamp_to_visible(&win, (home.0 + walk.offset, home.1));
            let dir = walk.dir;
            walk.note_command(target);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn walking_at(home: (i32, i32), commands: &[(i32, i32)]) -> Walk {
        let mut w = Walk {
            home: Some(home),
            ..Default::default()
        };
        for &c in commands {
            w.note_command(c);
        }
        w
    }

    #[test]
    fn recognises_its_own_step_as_its_own() {
        let w = walking_at((100, 50), &[(104, 50)]);
        assert!(!w.is_user_drag((104, 50)));
    }

    #[test]
    fn a_straggling_step_is_still_ours() {
        // The race this memory exists for: `halt` places the window from the
        // main thread and applies inline, while a step the walker issued from a
        // tokio thread is still queued in the event loop. It lands afterwards.
        // With a single remembered command it would read as a hand on the pet.
        let w = walking_at((100, 50), &[(112, 50), (116, 50), (100, 50)]);
        assert!(
            !w.is_user_drag((116, 50)),
            "an older step of ours is not a drag"
        );
        assert!(!w.is_user_drag((100, 50)), "and neither is the latest");
    }

    #[test]
    fn forgets_far_enough_back_to_stay_a_drag_test() {
        let mut w = walking_at((0, 0), &[]);
        for i in 0..COMMAND_MEMORY as i32 + 4 {
            w.note_command((i * 100, 0));
        }
        assert_eq!(w.commanded.len(), COMMAND_MEMORY);
        assert!(w.is_user_drag((0, 0)), "the oldest command has aged out");
    }

    #[test]
    fn a_move_we_never_asked_for_is_a_drag() {
        let w = walking_at((100, 50), &[(104, 50)]);
        assert!(w.is_user_drag((900, 50)), "somewhere else entirely");
        assert!(w.is_user_drag((104, 400)), "same x, dragged vertically");
    }

    #[test]
    fn nothing_commanded_yet_means_any_move_is_the_users() {
        let w = Walk::default();
        assert!(w.is_user_drag((10, 10)));
    }

    #[test]
    fn rehoming_forgets_where_we_were_walking() {
        // Otherwise the positions from the interrupted walk keep counting as
        // ours, and a second drag to one of them would be ignored.
        let mut w = walking_at((100, 50), &[(112, 50), (116, 50)]);
        w.rehome((500, 300));

        assert_eq!(w.resting_position((0, 0)), (500, 300));
        assert_eq!(w.offset, 0);
        assert!(w.is_user_drag((116, 50)), "the old walk is no longer ours");
        assert!(!w.is_user_drag((500, 300)));
    }

    #[test]
    fn resting_position_is_home_when_we_have_one() {
        assert_eq!(walking_at((7, 9), &[]).resting_position((1, 2)), (7, 9));
        assert_eq!(Walk::default().resting_position((1, 2)), (1, 2));
    }

    #[test]
    fn homing_always_terminates() {
        // The property that keeps I6 honest: the walk-home loop is what drops
        // the timer, so an offset that never reaches zero is a clock that never
        // stops. Mirrors the arithmetic in `spawn_walker`.
        for start in [-RANGE_PX, -7, -1, 0, 1, 7, RANGE_PX] {
            let mut offset = start;
            let mut steps = 0;
            while offset != 0 {
                let step = STEP_PX * if offset > 0 { -1 } else { 1 };
                offset = if offset.abs() <= STEP_PX {
                    0
                } else {
                    offset + step
                };
                steps += 1;
                assert!(steps < 1000, "offset {start} never reached home");
            }
        }
    }
}
