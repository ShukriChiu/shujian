use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Token budget configuration for the context window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextBudget {
    /// Total context window size for the model.
    pub max_context_tokens: usize,
    /// Tokens reserved for the model's output.
    pub output_headroom: usize,
    /// Tokens reserved for compaction (the summarization call itself needs room).
    pub compaction_headroom: usize,
    /// Minimum conversation size before auto-compaction triggers.
    pub min_conversation_tokens: usize,
    /// Threshold ratio (0.0-1.0) of context usage that triggers auto-compaction.
    pub auto_compact_threshold: f64,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self {
            max_context_tokens: 200_000,
            output_headroom: 16_000,
            compaction_headroom: 8_000,
            min_conversation_tokens: 20_000,
            auto_compact_threshold: 0.90,
        }
    }
}

impl ContextBudget {
    /// How many tokens are available for actual conversation.
    pub fn usable_tokens(&self) -> usize {
        self.max_context_tokens
            .saturating_sub(self.output_headroom)
            .saturating_sub(self.compaction_headroom)
    }

    /// Returns true if the given token count exceeds the auto-compact threshold.
    pub fn should_auto_compact(&self, current_tokens: usize) -> bool {
        let threshold = (self.usable_tokens() as f64 * self.auto_compact_threshold) as usize;
        current_tokens >= threshold && current_tokens >= self.min_conversation_tokens
    }
}

/// Microcompaction policy — controls when tool outputs get offloaded to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicrocompactPolicy {
    /// Tool results above this size (in chars) are candidates for offloading.
    pub offload_threshold_chars: usize,
    /// Number of most recent tool results to keep fully inline ("hot tail").
    pub hot_tail_count: usize,
    /// Directory for cold storage files.
    pub storage_dir: PathBuf,
}

impl Default for MicrocompactPolicy {
    fn default() -> Self {
        Self {
            offload_threshold_chars: 4_000,
            hot_tail_count: 5,
            storage_dir: PathBuf::from(".agent-memory/tool-cache"),
        }
    }
}

/// A tool result that has been offloaded to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffloadedResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub storage_path: PathBuf,
    pub original_size_chars: usize,
    pub offloaded_at: DateTime<Utc>,
    /// Short excerpt kept inline for the model's awareness.
    pub inline_stub: String,
}

/// The structured summary produced by compaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionSummary {
    /// The compressed working state.
    pub summary_text: String,
    /// Files that were recently accessed (for rehydration).
    pub recent_files: Vec<String>,
    /// Active todo items to preserve.
    pub active_todos: Vec<String>,
    /// What the user asked to do most recently.
    pub current_intent: Option<String>,
    /// Suggested next step.
    pub next_step: Option<String>,
    /// How many tokens the original conversation consumed.
    pub original_tokens: usize,
    /// How many tokens this summary uses.
    pub summary_tokens: usize,
    /// When compaction occurred.
    pub compacted_at: DateTime<Utc>,
    /// Optional focus hint the user provided.
    pub focus_hint: Option<String>,
    /// Whether this was auto or manual compaction.
    pub trigger: CompactionTrigger,
}

/// What triggered the compaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CompactionTrigger {
    Auto,
    Manual { focus: Option<String> },
    TaskBoundary { completed_task: String },
}

/// Delta summary for background/subagent tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaSummary {
    pub agent_id: String,
    pub previous_summary: Option<String>,
    pub new_messages_count: usize,
    pub delta_text: String,
    pub updated_at: DateTime<Utc>,
}

/// Result of a compaction operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    pub summary: CompactionSummary,
    /// Messages that should replace the entire conversation.
    pub replacement_messages: Vec<ReplacementMessage>,
    /// How many messages were removed.
    pub messages_removed: usize,
    /// How many tokens were freed.
    pub tokens_freed: usize,
}

/// A message in the post-compaction conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplacementMessage {
    pub role: String,
    pub content: String,
}

/// Statistics about current context usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextStats {
    pub total_messages: usize,
    pub system_prompt_tokens: usize,
    pub conversation_tokens: usize,
    pub tool_schema_tokens: usize,
    pub offloaded_results: usize,
    pub hot_tail_results: usize,
    pub free_tokens: usize,
    pub usage_percent: f64,
    pub compaction_count: usize,
}
