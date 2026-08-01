//! The local event endpoint.
//!
//! Two invariants live here, and they are the ones that decide whether anyone
//! keeps the app installed:
//!
//! **I1 — the pet never changes agent behaviour.** A hook's response body can
//! block a tool call or inject context into the agent. Every response on the
//! event endpoints is therefore `204 No Content` with an empty body, including
//! for input we cannot understand. A pet that silently blocks a `Bash` call
//! would be a catastrophic bug, so the code has no path that can produce one.
//!
//! **I2 — the pet never slows the agent.** HTTP hooks are synchronous; the
//! agent waits for the response. The handler therefore does not parse the body,
//! does not touch the webview, and does not wait on any consumer. It copies
//! bytes into a bounded queue and returns.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::guard::admit;
use crate::queue::{EventQueue, RawEvent};

/// Hard ceiling on a single body.
///
/// Not the 8 KB the spec originally called for — see the note in
/// `docs/ARCHITECTURE.md`. A tool-completion payload embeds the tool's entire
/// response, so a `Read` of a large file or a chatty command produces payloads
/// far past 8 KB. Rejecting those would mean returning a non-204 to a genuine
/// hook, which I1 forbids. This limit only exists to stop something
/// pathological; accumulation is bounded by the queue instead.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

pub const DEFAULT_PORT: u16 = 48200;
const QUEUE_MAX_ITEMS: usize = 1000;
const QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Facts the webview reports back so `/health` can answer for the whole app.
/// The Rust side deliberately knows nothing about adapters or sessions itself.
#[derive(Debug, Default, Clone)]
pub struct WebviewReport {
    pub connected: bool,
    pub adapters: Vec<String>,
    pub sessions: usize,
    /// What the pet is currently drawing, and for which project.
    ///
    /// Exposed because a session *count* cannot verify the focus policy: a
    /// harness asking "are there two sessions?" passes even if both collapsed
    /// into one wrong state. The reviewable claim is which one won.
    pub focused_state: String,
    pub focused_project: String,
}

pub struct ServerState {
    pub queue: Arc<EventQueue>,
    pub token: Option<String>,
    pub port: u16,
    pub started_at: std::time::Instant,
    pub rejected: AtomicU64,
    webview: std::sync::RwLock<WebviewReport>,
}

impl ServerState {
    pub fn new(port: u16, token: Option<String>) -> Self {
        Self {
            queue: Arc::new(EventQueue::new(QUEUE_MAX_ITEMS, QUEUE_MAX_BYTES)),
            token,
            port,
            started_at: std::time::Instant::now(),
            rejected: AtomicU64::new(0),
            webview: std::sync::RwLock::new(WebviewReport::default()),
        }
    }

    pub fn set_webview_report(&self, report: WebviewReport) {
        *self.webview.write().expect("report poisoned") = report;
    }

    fn webview_report(&self) -> WebviewReport {
        self.webview.read().expect("report poisoned").clone()
    }
}

pub type SharedState = Arc<ServerState>;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/event/{source}", post(post_event))
        .route("/pet-event", post(post_pet_event))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Raw payload from an agent's hook. `source` selects the adapter, in the
/// webview — nothing here interprets it.
async fn post_event(
    State(state): State<SharedState>,
    Path(source): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    accept(&state, source, headers, body)
}

/// Pre-normalised `PetEvent`, for demo mode and third-party integrators. Same
/// contract; the webview routes it past the adapter registry instead of through
/// it.
async fn post_pet_event(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    accept(&state, "pet-event".to_string(), headers, body)
}

fn accept(state: &SharedState, source: String, headers: HeaderMap, body: Bytes) -> StatusCode {
    if let Err(rejection) = admit(&headers, state.token.as_deref()) {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        // Not a hook, so I1 does not apply: say no clearly.
        eprintln!("[server] refused: {}", rejection.reason());
        return rejection.status();
    }

    // Everything from here is I1 territory: no path may return anything but
    // 204, and no path may parse the body.
    state.queue.push(RawEvent {
        source,
        body: body.to_vec(),
        received_at_ms: now_ms(),
    });

    StatusCode::NO_CONTENT
}

async fn health(State(state): State<SharedState>) -> impl IntoResponse {
    let stats = state.queue.stats();
    let report = state.webview_report();
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.port,
        "uptime_seconds": state.started_at.elapsed().as_secs(),
        "events": {
            "received": stats.received,
            "dropped": stats.dropped,
            "delivered": stats.delivered,
            "queued": state.queue.len(),
            "rejected": state.rejected.load(Ordering::Relaxed),
        },
        "webview": {
            "connected": report.connected,
            "adapters": report.adapters,
            "sessions": report.sessions,
            "focusedState": report.focused_state,
            "focusedProject": report.focused_project,
        },
        "authRequired": state.token.is_some(),
    }))
}

/// Resolve the port from `PET_PORT`, falling back to the default.
pub fn configured_port() -> u16 {
    std::env::var("PET_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Bind loopback, or fail with something the user can act on.
///
/// Deliberately no fallback to another port (D9): hooks hardcode the port in a
/// URL, so silently moving would mean the pet simply stops reacting with no
/// error anywhere. Failing loudly is the kinder outcome.
pub async fn bind(port: u16) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| {
            format!(
                "cannot listen on 127.0.0.1:{port} ({e}).\n\
                 Another Agent Pet may already be running. The port is not \
                 changed automatically because installed hooks point at it by \
                 URL; set PET_PORT and reinstall the hooks to move it."
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> SharedState {
        Arc::new(ServerState::new(DEFAULT_PORT, None))
    }

    async fn send(app: Router, req: Request<Body>) -> (StatusCode, Vec<u8>) {
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, body)
    }

    fn post(path: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap()
    }

    #[tokio::test]
    async fn a_hook_event_is_accepted_with_an_empty_204() {
        let st = state();
        let (status, body) =
            send(router(st.clone()), post("/event/some-agent", r#"{"a":1}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(body.is_empty(), "I1: the response body must be empty");
        assert_eq!(st.queue.len(), 1);
    }

    #[tokio::test]
    async fn the_source_segment_is_carried_through_verbatim() {
        let st = state();
        send(router(st.clone()), post("/event/some-future-agent", "{}")).await;
        assert_eq!(st.queue.drain()[0].source, "some-future-agent");
    }

    #[tokio::test]
    async fn pet_event_shares_the_contract() {
        let st = state();
        let (status, body) = send(router(st.clone()), post("/pet-event", r#"{"v":1}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(body.is_empty());
        assert_eq!(st.queue.drain()[0].source, "pet-event");
    }

    #[tokio::test]
    async fn malformed_input_still_gets_204_and_is_simply_kept_unparsed() {
        // I1: we cannot answer 400 to a hook. The response path never parses,
        // so this is structurally impossible rather than merely avoided.
        for body in ["not json at all", "", "{", "[1,2,3]", "null"] {
            let st = state();
            let (status, out) = send(router(st.clone()), post("/event/some-agent", body)).await;
            assert_eq!(status, StatusCode::NO_CONTENT, "body={body:?}");
            assert!(out.is_empty());
        }
    }

    #[tokio::test]
    async fn a_missing_content_type_is_not_a_reason_to_refuse_a_hook() {
        let st = state();
        let req = Request::builder()
            .method("POST")
            .uri("/event/some-agent")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(send(router(st), req).await.0, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn a_browser_is_refused() {
        let st = state();
        let req = Request::builder()
            .method("POST")
            .uri("/event/some-agent")
            .header("content-type", "application/json")
            .header("origin", "https://evil.example")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(send(router(st.clone()), req).await.0, StatusCode::FORBIDDEN);
        assert_eq!(st.queue.len(), 0, "nothing may be enqueued from a browser");
        assert_eq!(st.rejected.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_token_is_enforced_when_configured() {
        let st = Arc::new(ServerState::new(DEFAULT_PORT, Some("secret".into())));
        assert_eq!(
            send(router(st.clone()), post("/event/some-agent", "{}"))
                .await
                .0,
            StatusCode::FORBIDDEN
        );

        let req = Request::builder()
            .method("POST")
            .uri("/event/some-agent")
            .header("x-pet-token", "secret")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            send(router(st.clone()), req).await.0,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn a_pathological_body_is_refused_by_the_limit_layer() {
        let st = state();
        let huge = "x".repeat(MAX_BODY_BYTES + 1);
        let (status, _) = send(router(st.clone()), post("/event/some-agent", &huge)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(st.queue.len(), 0);
    }

    #[tokio::test]
    async fn a_large_but_realistic_payload_is_accepted() {
        // A tool-completion payload embeds the whole response; 200 KB is ordinary,
        // and answering anything but 204 to it would break I1.
        let st = state();
        let big = format!(r#"{{"stdout":"{}"}}"#, "x".repeat(200_000));
        let (status, body) = send(router(st.clone()), post("/event/some-agent", &big)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(body.is_empty());
        assert_eq!(st.queue.len(), 1);
    }

    #[tokio::test]
    async fn a_burst_never_backpressures_and_never_errors() {
        let st = state();
        for i in 0..1500 {
            let (status, _) = send(
                router(st.clone()),
                post("/event/some-agent", &format!(r#"{{"n":{i}}}"#)),
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT);
        }
        let stats = st.queue.stats();
        assert_eq!(stats.received, 1500);
        assert!(stats.dropped >= 500, "oldest events should have been shed");
        assert_eq!(st.queue.len(), QUEUE_MAX_ITEMS);
    }

    #[tokio::test]
    async fn events_survive_a_consumer_that_never_runs() {
        // The webview crashing must not take the endpoint down with it.
        let st = state();
        for _ in 0..50 {
            send(router(st.clone()), post("/event/some-agent", "{}")).await;
        }
        let (status, _) = send(router(st.clone()), post("/event/some-agent", "{}")).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn health_reports_the_facts() {
        let st = state();
        send(router(st.clone()), post("/event/some-agent", "{}")).await;
        st.set_webview_report(WebviewReport {
            connected: true,
            adapters: vec!["some-agent".into()],
            sessions: 2,
            focused_state: "waiting_approval".into(),
            focused_project: "acme-api".into(),
        });

        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let (status, body) = send(router(st), req).await;
        assert_eq!(status, StatusCode::OK);

        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["port"], DEFAULT_PORT);
        assert_eq!(v["events"]["received"], 1);
        assert_eq!(v["webview"]["connected"], true);
        assert_eq!(v["webview"]["sessions"], 2);
        assert_eq!(v["authRequired"], false);
    }

    #[tokio::test]
    async fn health_is_honest_before_the_webview_reports_in() {
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let (_, body) = send(router(state()), req).await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["webview"]["connected"], false);
        assert_eq!(v["webview"]["adapters"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn binding_a_busy_port_fails_with_an_actionable_message() {
        let first = bind(0).await.expect("first bind");
        let port = first.local_addr().unwrap().port();

        let err = bind(port).await.expect_err("second bind must fail");
        assert!(err.contains(&port.to_string()));
        assert!(
            err.contains("PET_PORT"),
            "the message must say how to move it"
        );
        assert!(err.contains("already be running"));
    }
}
