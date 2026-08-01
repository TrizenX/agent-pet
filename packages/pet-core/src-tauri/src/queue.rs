//! The bounded hand-off between the HTTP handler and the webview.
//!
//! Invariant I2 says the pet never slows the agent. HTTP hooks are synchronous:
//! the agent blocks until the response arrives. So the handler must do the
//! smallest possible amount of work and answer immediately, and everything that
//! could take time — parsing, mapping, rendering — happens on the other side of
//! this queue.
//!
//! It is bounded twice, by count *and* by bytes. Count alone is not enough: a
//! single tool-completion event carrying the stdout of a large command can be
//! hundreds of kilobytes, so a thousand-entry queue could hold hundreds of
//! megabytes.
//! When either bound is exceeded the **oldest** entries go, because a pet
//! showing stale state is worse than a pet that skipped a frame.

use std::collections::VecDeque;
use std::sync::Mutex;

use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    /// Adapter id from the URL path. The server never interprets it.
    pub source: String,
    /// Unparsed body. Parsing on the response path would violate I2.
    pub body: Vec<u8>,
    pub received_at_ms: u64,
}

impl RawEvent {
    fn weight(&self) -> usize {
        self.body.len() + self.source.len()
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct QueueStats {
    pub received: u64,
    pub dropped: u64,
    pub delivered: u64,
}

pub struct EventQueue {
    inner: Mutex<Inner>,
    /// Wakes the drain task. Event-driven rather than polled, so an idle pet
    /// runs no timer at all — I6 asks for no timers faster than 1 Hz, and the
    /// honest reading of that is none.
    ready: Notify,
    max_items: usize,
    max_bytes: usize,
}

#[derive(Default)]
struct Inner {
    items: VecDeque<RawEvent>,
    bytes: usize,
    stats: QueueStats,
}

impl EventQueue {
    pub fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            ready: Notify::new(),
            max_items,
            max_bytes,
        }
    }

    /// Never fails and never blocks on a consumer. Returns how many older
    /// entries had to be discarded to make room.
    pub fn push(&self, event: RawEvent) -> usize {
        let mut inner = self.inner.lock().expect("queue poisoned");
        inner.stats.received += 1;

        let weight = event.weight();
        inner.bytes += weight;
        inner.items.push_back(event);

        let mut dropped = 0;
        while inner.items.len() > self.max_items
            || (inner.bytes > self.max_bytes && inner.items.len() > 1)
        {
            if let Some(old) = inner.items.pop_front() {
                inner.bytes -= old.weight();
                dropped += 1;
            }
        }
        inner.stats.dropped += dropped as u64;
        drop(inner);

        // A permit is stored if nobody is waiting, so an event that arrives
        // between drains is not lost.
        self.ready.notify_one();
        dropped
    }

    /// Wait until there is something to drain.
    pub async fn wait(&self) {
        self.ready.notified().await;
    }

    /// Take everything currently queued.
    pub fn drain(&self) -> Vec<RawEvent> {
        let mut inner = self.inner.lock().expect("queue poisoned");
        let out: Vec<_> = inner.items.drain(..).collect();
        inner.bytes = 0;
        inner.stats.delivered += out.len() as u64;
        out
    }

    pub fn stats(&self) -> QueueStats {
        self.inner.lock().expect("queue poisoned").stats
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("queue poisoned").items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(n: usize, size: usize) -> RawEvent {
        RawEvent {
            source: format!("s{n}"),
            body: vec![b'x'; size],
            received_at_ms: n as u64,
        }
    }

    #[test]
    fn holds_what_fits() {
        let q = EventQueue::new(4, 1 << 20);
        for i in 0..4 {
            assert_eq!(q.push(event(i, 10)), 0);
        }
        assert_eq!(q.len(), 4);
        assert_eq!(q.drain().len(), 4);
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn drops_the_oldest_when_the_count_bound_is_hit() {
        let q = EventQueue::new(3, 1 << 20);
        for i in 0..5 {
            q.push(event(i, 10));
        }
        let kept: Vec<_> = q.drain().into_iter().map(|e| e.received_at_ms).collect();
        // Stale state is worse than a skipped frame: the newest survive.
        assert_eq!(kept, vec![2, 3, 4]);
    }

    #[test]
    fn drops_the_oldest_when_the_byte_bound_is_hit() {
        // Count would allow all ten; bytes must not.
        let q = EventQueue::new(1000, 250);
        for i in 0..10 {
            q.push(event(i, 100));
        }
        let kept = q.drain();
        assert!(kept.len() <= 3, "kept {} entries", kept.len());
        assert_eq!(kept.last().unwrap().received_at_ms, 9);
    }

    #[test]
    fn a_single_oversized_event_is_still_delivered() {
        // Dropping it would lose the event entirely; the bound exists to stop
        // accumulation, not to censor one large payload.
        let q = EventQueue::new(10, 100);
        q.push(event(0, 5_000));
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn byte_accounting_recovers_after_a_drain() {
        let q = EventQueue::new(10, 1_000);
        for i in 0..5 {
            q.push(event(i, 150));
        }
        q.drain();
        for i in 0..5 {
            assert_eq!(q.push(event(i, 150)), 0, "drain must reset the byte count");
        }
    }

    #[test]
    fn a_thousand_event_burst_never_blocks_and_is_accounted_for() {
        let q = EventQueue::new(1000, 8 << 20);
        for i in 0..5000 {
            q.push(event(i, 64));
        }
        let s = q.stats();
        assert_eq!(s.received, 5000);
        assert_eq!(s.dropped, 4000);
        assert_eq!(q.len(), 1000);
        q.drain();
        assert_eq!(q.stats().delivered, 1000);
    }
}
