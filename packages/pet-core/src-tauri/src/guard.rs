//! Request admission for the local event endpoint.
//!
//! The threat model is small but not empty: the server listens on loopback with
//! no authentication, and any process on the machine — including a web page in
//! the user's browser — can reach it. The impact of a forged event is only a
//! wrong animation, but the endpoint must not be a free channel into the app.

use axum::http::{HeaderMap, StatusCode};

/// Headers a browser always sends and a hook never does.
///
/// This single rule closes the entire "any web page can POST to your loopback
/// port" vector, with no configuration and nothing for the user to set up.
/// `fetch()` cannot suppress `Origin` on a cross-origin request, and
/// `Sec-Fetch-Site` is a forbidden header name that page script cannot remove.
const BROWSER_MARKERS: [&str; 3] = ["origin", "sec-fetch-site", "sec-fetch-mode"];

/// Header carrying the shared secret, when `PET_TOKEN` is set.
pub const TOKEN_HEADER: &str = "x-pet-token";

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Rejection {
    /// Came from a browser. Not a hook, and never will be.
    Browser,
    /// `PET_TOKEN` is configured and the request did not present it.
    BadToken,
}

impl Rejection {
    pub fn status(self) -> StatusCode {
        StatusCode::FORBIDDEN
    }

    pub fn reason(self) -> &'static str {
        match self {
            Rejection::Browser => "browser-originated request",
            Rejection::BadToken => "missing or incorrect token",
        }
    }
}

/// Decide whether a request may enqueue an event.
///
/// Note what is deliberately *not* checked here: `Content-Type` and body shape.
/// A hook that sends something unexpected must still receive `204` (I1), so
/// malformed input is dropped later rather than rejected now. Only traffic that
/// provably did not come from a hook is refused.
pub fn admit(headers: &HeaderMap, expected_token: Option<&str>) -> Result<(), Rejection> {
    if BROWSER_MARKERS.iter().any(|h| headers.contains_key(*h)) {
        return Err(Rejection::Browser);
    }

    if let Some(expected) = expected_token {
        let presented = headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok());
        if !presented.is_some_and(|p| constant_time_eq(p, expected)) {
            return Err(Rejection::BadToken);
        }
    }

    Ok(())
}

/// Length-independent only for equal-length inputs, which is enough here: the
/// token length is not a secret, and the endpoint is loopback-only.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn a_bare_hook_request_is_admitted() {
        assert!(admit(&headers(&[("content-type", "application/json")]), None).is_ok());
        assert!(admit(&HeaderMap::new(), None).is_ok());
    }

    #[test]
    fn anything_carrying_a_browser_marker_is_refused() {
        for marker in BROWSER_MARKERS {
            let h = headers(&[(marker, "https://evil.example")]);
            assert_eq!(admit(&h, None), Err(Rejection::Browser), "{marker}");
        }
    }

    #[test]
    fn browser_markers_are_matched_case_insensitively() {
        // HeaderMap lowercases on insert; this pins the behaviour we rely on.
        let mut h = HeaderMap::new();
        h.insert("Origin", HeaderValue::from_static("https://evil.example"));
        assert_eq!(admit(&h, None), Err(Rejection::Browser));
    }

    #[test]
    fn a_token_is_required_only_when_configured() {
        let bare = HeaderMap::new();
        assert!(admit(&bare, None).is_ok());
        assert_eq!(admit(&bare, Some("secret")), Err(Rejection::BadToken));
    }

    #[test]
    fn the_right_token_is_admitted_and_a_wrong_one_is_not() {
        assert!(admit(&headers(&[(TOKEN_HEADER, "secret")]), Some("secret")).is_ok());
        assert_eq!(
            admit(&headers(&[(TOKEN_HEADER, "wrong")]), Some("secret")),
            Err(Rejection::BadToken)
        );
        assert_eq!(
            admit(&headers(&[(TOKEN_HEADER, "secre")]), Some("secret")),
            Err(Rejection::BadToken)
        );
    }

    #[test]
    fn a_browser_is_refused_even_with_a_valid_token() {
        // Order matters: a page that somehow learned the token is still a page.
        let h = headers(&[("origin", "https://evil.example"), (TOKEN_HEADER, "secret")]);
        assert_eq!(admit(&h, Some("secret")), Err(Rejection::Browser));
    }

    #[test]
    fn constant_time_eq_agrees_with_plain_equality() {
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
