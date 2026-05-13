use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use tokio::sync::broadcast;

use super::events::StreamEvent;

/// SSE broadcast hub — manages subscribers and broadcasts stream events.
///
/// Any number of clients can connect to the SSE endpoint and receive
/// real-time events as the agent works. Events are serialized as JSON
/// and sent using the standard SSE protocol.
pub struct SseBroadcaster {
    tx: broadcast::Sender<StreamEvent>,
    seq: AtomicU64,
}

impl SseBroadcaster {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            seq: AtomicU64::new(1),
        }
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Broadcast an event to all connected SSE clients.
    pub fn broadcast(&self, mut event: StreamEvent) {
        event.seq = self.next_seq();
        let _ = self.tx.send(event);
    }

    /// Emit a text delta event.
    pub fn emit_text(&self, session_id: &str, text: &str) {
        self.broadcast(StreamEvent::text_delta(0, session_id, text));
    }

    /// Emit a tool call start event.
    pub fn emit_tool_start(&self, session_id: &str, tool_name: &str, tool_id: &str) {
        self.broadcast(StreamEvent::tool_start(0, session_id, tool_name, tool_id));
    }

    /// Emit a tool call progress event.
    pub fn emit_tool_progress(
        &self,
        session_id: &str,
        tool_id: &str,
        progress: f64,
        message: &str,
    ) {
        self.broadcast(StreamEvent::tool_progress(
            0, session_id, tool_id, progress, message,
        ));
    }

    /// Emit a tool call result event.
    pub fn emit_tool_result(&self, session_id: &str, tool_id: &str, success: bool, preview: &str) {
        self.broadcast(StreamEvent::tool_result(
            0, session_id, tool_id, success, preview,
        ));
    }

    /// Emit a session start event.
    pub fn emit_session_start(&self, session_id: &str, agent_type: &str) {
        self.broadcast(StreamEvent::session_start(0, session_id, agent_type));
    }

    /// Emit a session end event.
    pub fn emit_session_end(&self, session_id: &str, summary: &str) {
        self.broadcast(StreamEvent::session_end(0, session_id, summary));
    }

    /// Emit a heartbeat event.
    pub fn emit_heartbeat(&self) {
        self.broadcast(StreamEvent::heartbeat(0));
    }

    /// Emit an error event.
    pub fn emit_error(&self, session_id: Option<&str>, message: &str) {
        self.broadcast(StreamEvent::error(0, session_id, message));
    }

    /// Emit a token usage event.
    pub fn emit_token_usage(
        &self,
        session_id: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        cost_usd: f64,
    ) {
        self.broadcast(StreamEvent::token_usage(
            0,
            session_id,
            prompt_tokens,
            completion_tokens,
            cost_usd,
        ));
    }

    /// Create a new SSE subscriber stream for an Axum handler.
    pub fn subscribe(
        &self,
    ) -> impl Stream<Item = Result<Event, std::convert::Infallible>> + 'static + use<> {
        let mut rx = self.tx.subscribe();

        async_stream::stream! {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let event_name = serde_json::to_value(&event.event_type)
                            .ok()
                            .and_then(|v| v.as_str().map(String::from))
                            .unwrap_or_else(|| "message".into());

                        let data = serde_json::to_string(&event).unwrap_or_default();

                        yield Ok(Event::default()
                            .event(event_name)
                            .data(data)
                            .id(event.seq.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        let lag_event = StreamEvent::error(
                            0,
                            None,
                            &format!("Client lagged, missed {n} events"),
                        );
                        let data = serde_json::to_string(&lag_event).unwrap_or_default();
                        yield Ok(Event::default().event("error").data(data));
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }

    /// Get the number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Get the current sequence number.
    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }
}

/// Create the SSE Axum response with keep-alive.
pub fn sse_response(
    broadcaster: Arc<SseBroadcaster>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>> + 'static> {
    let stream = broadcaster.subscribe();
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}

/// Spawn a background heartbeat task that emits heartbeats at a fixed interval.
pub fn spawn_heartbeat(broadcaster: Arc<SseBroadcaster>, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            if broadcaster.subscriber_count() > 0 {
                broadcaster.emit_heartbeat();
            }
        }
    });
}
