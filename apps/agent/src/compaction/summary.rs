use chrono::Utc;
use tracing::info;

use super::types::{
    CompactionResult, CompactionSummary, CompactionTrigger, DeltaSummary, ReplacementMessage,
};

/// Builds the compaction prompt that the model uses to summarize the conversation.
///
/// This is the "compaction contract" — a structured checklist that ensures
/// the summary preserves everything needed for continuation.
pub fn build_compaction_prompt(
    focus_hint: Option<&str>,
    custom_instructions: Option<&str>,
) -> String {
    let mut prompt = String::from(
        "You are performing a conversation compaction. Your task is to produce a structured \
         working state summary that allows the conversation to continue seamlessly.\n\n\
         You MUST include ALL of the following sections:\n\n\
         ## 1. User Intent\n\
         What was the user's primary request? What are they trying to accomplish?\n\n\
         ## 2. Key Technical Decisions\n\
         Important architectural, design, or implementation decisions made during the conversation.\n\n\
         ## 3. Files and Code\n\
         List all files that were read, created, or modified. For each:\n\
         - Full file path\n\
         - What was done (read/created/modified)\n\
         - Brief summary of the content or changes\n\
         - Include any important code snippets verbatim if they are central to the task\n\n\
         ## 4. Errors and Fixes\n\
         Any errors encountered and how they were resolved. Include exact error messages \
         if they required specific fixes.\n\n\
         ## 5. Current State\n\
         The exact current state of the work:\n\
         - What has been completed\n\
         - What is in progress\n\
         - What files are in what state\n\n\
         ## 6. Pending Tasks\n\
         Remaining work items, in priority order. If a todo list exists, preserve it exactly.\n\n\
         ## 7. Next Step\n\
         The single most important next action, matching the user's most recent intent.\n\n\
         IMPORTANT RULES:\n\
         - Be specific: include file paths, function names, line numbers, exact error messages.\n\
         - Preserve structure: use the numbered sections above.\n\
         - Do NOT editorialize or add opinions. Just record facts.\n\
         - This summary replaces the entire conversation, so nothing important should be left out.\n\
         - Aim for completeness over brevity — losing critical detail is worse than being verbose.",
    );

    if let Some(focus) = focus_hint {
        prompt.push_str(&format!(
            "\n\nFOCUS HINT: The user asked to focus the summary on: {focus}"
        ));
    }

    if let Some(instructions) = custom_instructions {
        prompt.push_str(&format!(
            "\n\nADDITIONAL COMPACTION INSTRUCTIONS:\n{instructions}"
        ));
    }

    prompt
}

/// Build the continuation message that wraps the summary for the model.
pub fn build_continuation_message(summary_text: &str) -> String {
    format!(
        "This session is being continued from a previous conversation that was compacted \
         to stay within the context window. The summary below covers the earlier portion \
         of the conversation.\n\n\
         {summary_text}\n\n\
         Continue the conversation from where it left off. Do not ask the user any \
         questions about what happened before — the summary contains all necessary context. \
         Pick up the next task or continue the current one."
    )
}

/// Build the delta summarization prompt for background agents.
pub fn build_delta_prompt(previous_summary: Option<&str>) -> String {
    let base = "You are given a few messages from a conversation, as well as a summary \
                of the conversation so far. Your task is to summarize the new messages \
                based on the summary so far. Aim for 1-2 sentences at most, focusing on \
                the most important details.";

    match previous_summary {
        Some(prev) => {
            format!("{base}\n\nPrevious summary:\n{prev}\n\nNow summarize the new messages:")
        }
        None => format!("{base}\n\nThis is the first batch of messages. Summarize them concisely:"),
    }
}

/// Assemble the post-compaction conversation from the compaction result.
///
/// This is the "rehydration sequence": summary + recent files + todos + continuation.
pub fn build_replacement_messages(
    summary: &CompactionSummary,
    system_prompt: &str,
) -> Vec<ReplacementMessage> {
    let mut messages = Vec::new();

    messages.push(ReplacementMessage {
        role: "system".into(),
        content: system_prompt.to_string(),
    });

    let continuation = build_continuation_message(&summary.summary_text);

    let mut user_content = continuation;

    if !summary.active_todos.is_empty() {
        user_content.push_str("\n\n## Active Todo List\n");
        for (i, todo) in summary.active_todos.iter().enumerate() {
            user_content.push_str(&format!("{}. {}\n", i + 1, todo));
        }
    }

    if !summary.recent_files.is_empty() {
        user_content.push_str("\n\n## Recently Accessed Files (re-read these as needed)\n");
        for file in &summary.recent_files {
            user_content.push_str(&format!("- {file}\n"));
        }
    }

    if let Some(next) = &summary.next_step {
        user_content.push_str(&format!("\n\n## Immediate Next Step\n{next}\n"));
    }

    messages.push(ReplacementMessage {
        role: "user".into(),
        content: user_content,
    });

    messages
}

/// Create a CompactionResult from a model-generated summary.
#[allow(clippy::too_many_arguments)]
pub fn finalize_compaction(
    summary_text: String,
    trigger: CompactionTrigger,
    system_prompt: &str,
    original_tokens: usize,
    summary_tokens: usize,
    messages_removed: usize,
    recent_files: Vec<String>,
    active_todos: Vec<String>,
    current_intent: Option<String>,
    next_step: Option<String>,
    focus_hint: Option<String>,
) -> CompactionResult {
    let summary = CompactionSummary {
        summary_text,
        recent_files,
        active_todos,
        current_intent,
        next_step,
        original_tokens,
        summary_tokens,
        compacted_at: Utc::now(),
        focus_hint,
        trigger,
    };

    let replacement_messages = build_replacement_messages(&summary, system_prompt);

    let tokens_freed = original_tokens.saturating_sub(summary_tokens);

    info!(
        original = original_tokens,
        summary = summary_tokens,
        freed = tokens_freed,
        removed = messages_removed,
        "compaction complete"
    );

    CompactionResult {
        summary,
        replacement_messages,
        messages_removed,
        tokens_freed,
    }
}

/// Create an incremental delta summary for a background agent.
pub fn build_delta_summary(
    agent_id: &str,
    previous: Option<&str>,
    delta_text: String,
    new_messages_count: usize,
) -> DeltaSummary {
    DeltaSummary {
        agent_id: agent_id.to_string(),
        previous_summary: previous.map(String::from),
        new_messages_count,
        delta_text,
        updated_at: Utc::now(),
    }
}
