//! Shared provider identity and public routing for discovery, registration and inference.
pub const ORIGINATOR: &str = "FlowM";
pub const OPENAI_RESOURCE: &str = "https://api.openai.com/v1";
pub const MODEL_CATALOG_CLIENT_VERSION: &str = "0.155.0";

pub fn request_headers() -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert("originator", http::HeaderValue::from_static(ORIGINATOR));
    headers.insert(
        http::header::USER_AGENT,
        http::HeaderValue::from_str(&format!(
            "{}/{} (Codex schema {})",
            ORIGINATOR,
            env!("CARGO_PKG_VERSION"),
            MODEL_CATALOG_CLIENT_VERSION,
        ))
        .expect("FlowM's fixed application identity is a valid header"),
    );
    headers
}
