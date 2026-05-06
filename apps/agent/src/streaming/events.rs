use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Structured streaming event protocol for real-time agent output.
///
/// Each event has a type, an optional session/agent scope, and a payload.
/// Modeled after Claude Code's real-time streaming approach where the
/// UI receives granular events for text, tool calls, status changes, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    /// Monotonically increasing sequence number.
    pub seq: u64,
    /// Event type identifier.
    #[serde(rename = "type")]
    pub event_type: StreamEventType,
    /// Timestamp of the event.
    pub timestamp: DateTime<Utc>,
    /// Session this event belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Agent that produced this event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Event-specific payload.
    pub data: serde_json::Value,
}

/// Event types in the streaming protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamEventType {
    // ── Session lifecycle ──
    SessionStart,
    SessionEnd,

    // ── Text generation ──
    TextDelta,
    TextDone,

    // ── Tool execution ──
    ToolCallStart,
    ToolCallProgress,
    ToolCallResult,

    // ── Agent lifecycle ──
    AgentSpawned,
    AgentProgress,
    AgentCompleted,
    AgentFailed,

    // ── Permission flow ──
    PermissionRequest,
    PermissionResponse,

    // ── Context management ──
    CompactionStarted,
    CompactionCompleted,

    // ── HITL (Human-in-the-Loop) ──
    HitlQuestion,
    HitlResolved,

    // ── System status ──
    Heartbeat,
    Error,
    StatusUpdate,

    // ── Cost tracking ──
    TokenUsage,

    // ── Extensible custom events ──
    Custom(String),
}

static GLOBAL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_seq() -> u64 {
    GLOBAL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl StreamEvent {
    /// Generic constructor for custom/dynamic event types.
    pub fn new(event_type: StreamEventType, data: serde_json::Value) -> Self {
        Self {
            seq: next_seq(),
            event_type,
            timestamp: Utc::now(),
            session_id: None,
            agent_id: None,
            data,
        }
    }

    pub fn text_delta(seq: u64, session_id: &str, text: &str) -> Self {
        Self {
            seq,
            event_type: StreamEventType::TextDelta,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({ "text": text }),
        }
    }

    pub fn tool_start(seq: u64, session_id: &str, tool_name: &str, tool_id: &str) -> Self {
        Self {
            seq,
            event_type: StreamEventType::ToolCallStart,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "tool_name": tool_name,
                "tool_call_id": tool_id,
            }),
        }
    }

    pub fn tool_progress(
        seq: u64,
        session_id: &str,
        tool_id: &str,
        progress: f64,
        message: &str,
    ) -> Self {
        Self {
            seq,
            event_type: StreamEventType::ToolCallProgress,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "tool_call_id": tool_id,
                "progress": progress,
                "message": message,
            }),
        }
    }

    pub fn tool_result(
        seq: u64,
        session_id: &str,
        tool_id: &str,
        success: bool,
        result_preview: &str,
    ) -> Self {
        Self {
            seq,
            event_type: StreamEventType::ToolCallResult,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "tool_call_id": tool_id,
                "success": success,
                "result_preview": result_preview,
            }),
        }
    }

    pub fn heartbeat(seq: u64) -> Self {
        Self {
            seq,
            event_type: StreamEventType::Heartbeat,
            timestamp: Utc::now(),
            session_id: None,
            agent_id: None,
            data: serde_json::json!({}),
        }
    }

    pub fn error(seq: u64, session_id: Option<&str>, message: &str) -> Self {
        Self {
            seq,
            event_type: StreamEventType::Error,
            timestamp: Utc::now(),
            session_id: session_id.map(String::from),
            agent_id: None,
            data: serde_json::json!({ "error": message }),
        }
    }

    pub fn session_start(seq: u64, session_id: &str, agent_type: &str) -> Self {
        Self {
            seq,
            event_type: StreamEventType::SessionStart,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "agent_type": agent_type,
            }),
        }
    }

    pub fn session_end(seq: u64, session_id: &str, summary: &str) -> Self {
        Self {
            seq,
            event_type: StreamEventType::SessionEnd,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "summary": summary,
            }),
        }
    }

    pub fn token_usage(
        seq: u64,
        session_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        cost_usd: f64,
    ) -> Self {
        Self {
            seq,
            event_type: StreamEventType::TokenUsage,
            timestamp: Utc::now(),
            session_id: Some(session_id.into()),
            agent_id: None,
            data: serde_json::json!({
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "cost_usd": cost_usd,
            }),
        }
    }

    /// Serialize to SSE data format.
    pub fn to_sse_data(&self) -> String {
        let event_name = serde_json::to_value(&self.event_type)
            .and_then(|v| Ok(v.as_str().unwrap_or("message").to_string()))
            .unwrap_or_else(|_| "message".into());

        let json = serde_json::to_string(self).unwrap_or_default();
        format!("event: {event_name}\ndata: {json}\n\n")
    }
}
