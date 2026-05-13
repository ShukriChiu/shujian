use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::Result;
use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use super::micro::MicrocompactStore;
use super::summary;
use super::types::{
    CompactionResult, CompactionSummary, CompactionTrigger, ContextBudget, ContextStats,
    DeltaSummary, MicrocompactPolicy,
};
use crate::llm::types::Message;

/// The three-layer context compaction engine.
///
/// Layer 1: Microcompaction — offload large tool outputs to disk early.
/// Layer 2: Auto-compaction — summarize when context approaches capacity.
/// Layer 3: Manual compaction — user-triggered at task boundaries.
///
/// Modeled after Claude Code's compaction system, adapted for a Rust agent runtime.
pub struct CompactionEngine {
    budget: ContextBudget,
    workspace: PathBuf,
    micro: Mutex<MicrocompactStore>,
    compaction_count: AtomicUsize,
    /// Custom instructions appended to every compaction prompt.
    compact_instructions: Option<String>,
    /// History of compaction summaries.
    history: Mutex<Vec<CompactionSummary>>,
    /// Delta summaries for background agents.
    delta_summaries: Mutex<Vec<DeltaSummary>>,
}

impl CompactionEngine {
    pub fn new(workspace: &Path, budget: ContextBudget) -> Self {
        let micro_policy = MicrocompactPolicy {
            storage_dir: PathBuf::from(".agent-memory/tool-cache"),
            ..Default::default()
        };

        Self {
            budget,
            workspace: workspace.to_path_buf(),
            micro: Mutex::new(MicrocompactStore::new(micro_policy)),
            compaction_count: AtomicUsize::new(0),
            compact_instructions: None,
            history: Mutex::new(Vec::new()),
            delta_summaries: Mutex::new(Vec::new()),
        }
    }

    pub fn with_micro_policy(mut self, policy: MicrocompactPolicy) -> Self {
        self.micro = Mutex::new(MicrocompactStore::new(policy));
        self
    }

    pub fn with_compact_instructions(mut self, instructions: impl Into<String>) -> Self {
        self.compact_instructions = Some(instructions.into());
        self
    }

    // ──────────────────────────────────────────────────
    // Layer 1: Microcompaction
    // ──────────────────────────────────────────────────

    /// Process a tool result through microcompaction.
    /// Returns the content to keep inline (either original or a stub).
    pub async fn process_tool_result(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        content: &str,
    ) -> Result<String> {
        let mut micro = self.micro.lock().await;

        if micro.should_offload(content) {
            let record = micro
                .offload(&self.workspace, tool_call_id, tool_name, content)
                .await?;
            Ok(record.inline_stub)
        } else {
            Ok(content.to_string())
        }
    }

    /// Retrieve a previously offloaded tool result from disk.
    pub async fn retrieve_tool_result(&self, tool_call_id: &str) -> Result<Option<String>> {
        let micro = self.micro.lock().await;
        micro.retrieve(&self.workspace, tool_call_id).await
    }

    // ──────────────────────────────────────────────────
    // Layer 2: Auto-compaction
    // ──────────────────────────────────────────────────

    /// Check if auto-compaction should trigger based on current token usage.
    pub fn should_auto_compact(&self, current_tokens: usize) -> bool {
        self.budget.should_auto_compact(current_tokens)
    }

    /// Perform auto-compaction on a conversation.
    ///
    /// `summarize_fn` is called with the compaction prompt + conversation messages,
    /// and should return the model's summary text and its token count.
    pub async fn auto_compact<F, Fut>(
        &self,
        messages: &[Message],
        system_prompt: &str,
        current_tokens: usize,
        recent_files: Vec<String>,
        active_todos: Vec<String>,
        summarize_fn: F,
    ) -> Result<CompactionResult>
    where
        F: FnOnce(String, Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<(String, usize)>>,
    {
        info!(tokens = current_tokens, "auto-compaction triggered");

        let prompt = summary::build_compaction_prompt(None, self.compact_instructions.as_deref());

        let mut compact_messages = vec![Message::System {
            content: prompt.clone(),
        }];
        compact_messages.extend(messages.iter().cloned());

        let (summary_text, summary_tokens) = summarize_fn(prompt, compact_messages).await?;

        let result = summary::finalize_compaction(
            summary_text,
            CompactionTrigger::Auto,
            system_prompt,
            current_tokens,
            summary_tokens,
            messages.len(),
            recent_files,
            active_todos,
            None,
            None,
            None,
        );

        self.compaction_count.fetch_add(1, Ordering::Relaxed);
        self.history.lock().await.push(result.summary.clone());

        Ok(result)
    }

    // ──────────────────────────────────────────────────
    // Layer 3: Manual compaction
    // ──────────────────────────────────────────────────

    /// Perform manual compaction with an optional focus hint.
    pub async fn manual_compact<F, Fut>(
        &self,
        messages: &[Message],
        system_prompt: &str,
        current_tokens: usize,
        focus_hint: Option<&str>,
        recent_files: Vec<String>,
        active_todos: Vec<String>,
        current_intent: Option<String>,
        next_step: Option<String>,
        summarize_fn: F,
    ) -> Result<CompactionResult>
    where
        F: FnOnce(String, Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<(String, usize)>>,
    {
        info!(
            focus = focus_hint.unwrap_or("none"),
            tokens = current_tokens,
            "manual compaction triggered"
        );

        let prompt =
            summary::build_compaction_prompt(focus_hint, self.compact_instructions.as_deref());

        let mut compact_messages = vec![Message::System {
            content: prompt.clone(),
        }];
        compact_messages.extend(messages.iter().cloned());

        let (summary_text, summary_tokens) = summarize_fn(prompt, compact_messages).await?;

        let result = summary::finalize_compaction(
            summary_text,
            CompactionTrigger::Manual {
                focus: focus_hint.map(String::from),
            },
            system_prompt,
            current_tokens,
            summary_tokens,
            messages.len(),
            recent_files,
            active_todos,
            current_intent,
            next_step,
            focus_hint.map(String::from),
        );

        self.compaction_count.fetch_add(1, Ordering::Relaxed);
        self.history.lock().await.push(result.summary.clone());

        Ok(result)
    }

    // ──────────────────────────────────────────────────
    // Background delta summarization
    // ──────────────────────────────────────────────────

    /// Perform incremental delta summarization for a background agent.
    pub async fn delta_summarize<F, Fut>(
        &self,
        agent_id: &str,
        new_messages: &[Message],
        summarize_fn: F,
    ) -> Result<DeltaSummary>
    where
        F: FnOnce(String, Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<(String, usize)>>,
    {
        let deltas = self.delta_summaries.lock().await;
        let previous = deltas
            .iter()
            .filter(|d| d.agent_id == agent_id)
            .last()
            .map(|d| d.delta_text.as_str());

        let prompt = summary::build_delta_prompt(previous);
        drop(deltas);

        let mut compact_messages = vec![Message::System {
            content: prompt.clone(),
        }];
        compact_messages.extend(new_messages.iter().cloned());

        let (delta_text, _tokens) = summarize_fn(prompt, compact_messages).await?;

        let prev_text = {
            let deltas = self.delta_summaries.lock().await;
            deltas
                .iter()
                .filter(|d| d.agent_id == agent_id)
                .last()
                .map(|d| d.delta_text.clone())
        };

        let delta = summary::build_delta_summary(
            agent_id,
            prev_text.as_deref(),
            delta_text,
            new_messages.len(),
        );

        self.delta_summaries.lock().await.push(delta.clone());

        debug!(
            agent_id,
            msgs = new_messages.len(),
            "delta summarization done"
        );
        Ok(delta)
    }

    // ──────────────────────────────────────────────────
    // Statistics and inspection
    // ──────────────────────────────────────────────────

    /// Get current context usage statistics.
    pub async fn stats(
        &self,
        system_prompt_tokens: usize,
        conversation_tokens: usize,
        tool_schema_tokens: usize,
    ) -> ContextStats {
        let micro = self.micro.lock().await;
        let (hot, cold) = micro.partition_results();

        let total_used = system_prompt_tokens + conversation_tokens + tool_schema_tokens;
        let free = self.budget.usable_tokens().saturating_sub(total_used);
        let usage_percent = if self.budget.usable_tokens() > 0 {
            total_used as f64 / self.budget.usable_tokens() as f64
        } else {
            0.0
        };

        ContextStats {
            total_messages: 0, // caller fills this
            system_prompt_tokens,
            conversation_tokens,
            tool_schema_tokens,
            offloaded_results: micro.offloaded_count(),
            hot_tail_results: hot.len(),
            free_tokens: free,
            usage_percent,
            compaction_count: self.compaction_count.load(Ordering::Relaxed),
        }
    }

    /// Get compaction history.
    pub async fn compaction_history(&self) -> Vec<CompactionSummary> {
        self.history.lock().await.clone()
    }

    /// Get the latest delta summary for an agent.
    pub async fn latest_delta(&self, agent_id: &str) -> Option<DeltaSummary> {
        self.delta_summaries
            .lock()
            .await
            .iter()
            .filter(|d| d.agent_id == agent_id)
            .last()
            .cloned()
    }

    /// Run garbage collection on microcompacted files.
    pub async fn gc(&self, max_retain: usize) -> Result<usize> {
        let mut micro = self.micro.lock().await;
        micro.gc(&self.workspace, max_retain).await
    }

    pub fn budget(&self) -> &ContextBudget {
        &self.budget
    }

    pub fn compaction_count(&self) -> usize {
        self.compaction_count.load(Ordering::Relaxed)
    }
}
