use std::path::Path;

use anyhow::Result;
use chrono::Utc;
use tracing::info;

use crate::types::event::AppEvent;
use crate::types::state::AppStateStore;
use crate::types::task::{TaskState, TaskType};

pub struct DreamConfig {
    pub min_sessions_between_dreams: u32,
    pub token_threshold: u64,
    pub max_entries_per_dream: usize,
}

impl Default for DreamConfig {
    fn default() -> Self {
        Self {
            min_sessions_between_dreams: 3,
            token_threshold: 50_000,
            max_entries_per_dream: 20,
        }
    }
}

pub fn should_dream(store: &AppStateStore, config: &DreamConfig) -> bool {
    let state = store.state();
    let state = match state.try_read() {
        Ok(s) => s,
        Err(_) => return false,
    };

    if state.memory_state.dream_in_progress {
        return false;
    }

    if state.memory_state.sessions_since_dream < config.min_sessions_between_dreams {
        return false;
    }

    let total_tokens = state.token_usage_total.total_tokens();
    if total_tokens < config.token_threshold {
        return false;
    }

    true
}

pub async fn trigger_dream(store: &AppStateStore, workspace_dir: &Path) -> Result<String> {
    let task = TaskState::new(TaskType::Dream, "Auto Dream: 记忆整合");
    let task_id = task.id.clone();

    store
        .update_and_emit(
            |state| {
                state.memory_state.dream_in_progress = true;
                state.register_task(task.clone());
            },
            AppEvent::DreamStarted {
                task_id: task_id.clone(),
            },
        )
        .await;

    info!(task_id = %task_id, "dream started");

    let session_dir = workspace_dir.join(".agent-memory").join("sessions");
    let consolidated_path = workspace_dir.join(".agent-memory").join("consolidated.md");

    let session_entries = collect_session_entries(&session_dir).await?;

    if session_entries.is_empty() {
        finish_dream(store, &task_id, vec![]).await;
        return Ok(task_id);
    }

    let consolidated = consolidate_entries(&session_entries);

    let existing = if consolidated_path.exists() {
        tokio::fs::read_to_string(&consolidated_path).await?
    } else {
        String::new()
    };

    let new_content = format!(
        "{}\n\n## Dream @ {}\n\n{}",
        existing.trim(),
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
        consolidated
    );

    tokio::fs::create_dir_all(consolidated_path.parent().unwrap()).await?;
    tokio::fs::write(&consolidated_path, new_content.trim()).await?;

    let updated_files = vec![consolidated_path.display().to_string()];
    finish_dream(store, &task_id, updated_files.clone()).await;

    info!(task_id = %task_id, files = ?updated_files, "dream completed");
    Ok(task_id)
}

async fn finish_dream(store: &AppStateStore, task_id: &str, files_updated: Vec<String>) {
    let tid = task_id.to_string();
    let files = files_updated.clone();
    store
        .update_and_emit(
            move |state| {
                state.complete_task(&tid, Some("Dream consolidation complete".into()));
                state.memory_state.dream_in_progress = false;
                state.memory_state.sessions_since_dream = 0;
                state.memory_state.last_dream_at = Some(Utc::now());
            },
            AppEvent::DreamCompleted {
                task_id: task_id.to_string(),
                files_updated,
            },
        )
        .await;
}

async fn collect_session_entries(session_dir: &Path) -> Result<Vec<String>> {
    if !session_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(session_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md") {
            let content = tokio::fs::read_to_string(&path).await?;
            if !content.trim().is_empty() {
                entries.push(content);
            }
        }
    }
    entries.sort();
    Ok(entries)
}

fn consolidate_entries(entries: &[String]) -> String {
    let mut consolidated = String::new();

    for (i, entry) in entries.iter().enumerate() {
        let lines: Vec<&str> = entry.lines().collect();
        let summary = if lines.len() > 10 {
            lines[..10].join("\n") + "\n..."
        } else {
            entry.clone()
        };
        consolidated.push_str(&format!("### Session {}\n{}\n\n", i + 1, summary));
    }

    consolidated
}
