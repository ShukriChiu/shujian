use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tracing::warn;

use crate::types::agent::AgentId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: DateTime<Utc>,
    pub event_type: AuditEventType,
    pub agent_id: Option<AgentId>,
    pub agent_type: Option<String>,
    pub task_id: Option<String>,
    pub user: Option<String>,
    pub detail: String,
    pub cost_usd: Option<f64>,
    pub tokens_used: Option<u64>,
    pub duration_ms: Option<i64>,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventType {
    AgentSpawned,
    AgentCompleted,
    AgentFailed,
    AgentKilled,
    TaskCreated,
    TaskCompleted,
    TaskFailed,
    ToolExecuted,
    ToolBlocked,
    PermissionGranted,
    PermissionDenied,
    HookFired,
    HookBlocked,
    MemoryWrite,
    DreamTriggered,
    SessionStart,
    SessionEnd,
    ConfigChanged,
    CostThresholdReached,
    WorktreeCreated,
    WorktreeRemoved,
}

pub struct AuditLogger {
    log_dir: PathBuf,
    max_entries_per_file: usize,
}

impl AuditLogger {
    pub fn new(base_dir: &Path) -> Self {
        Self {
            log_dir: base_dir.join(".agent-audit"),
            max_entries_per_file: 10_000,
        }
    }

    pub async fn log(&self, entry: AuditEntry) {
        if let Err(e) = self.write_entry(&entry).await {
            warn!(error = %e, "failed to write audit log");
        }
    }

    pub async fn log_agent_spawn(
        &self,
        agent_id: AgentId,
        agent_type: &str,
        task_id: &str,
        detail: &str,
    ) {
        self.log(AuditEntry {
            timestamp: Utc::now(),
            event_type: AuditEventType::AgentSpawned,
            agent_id: Some(agent_id),
            agent_type: Some(agent_type.into()),
            task_id: Some(task_id.into()),
            user: None,
            detail: detail.into(),
            cost_usd: None,
            tokens_used: None,
            duration_ms: None,
            success: true,
        })
        .await;
    }

    pub async fn log_tool_exec(
        &self,
        agent_id: Option<AgentId>,
        tool_name: &str,
        success: bool,
        duration_ms: i64,
    ) {
        self.log(AuditEntry {
            timestamp: Utc::now(),
            event_type: if success {
                AuditEventType::ToolExecuted
            } else {
                AuditEventType::ToolBlocked
            },
            agent_id,
            agent_type: None,
            task_id: None,
            user: None,
            detail: tool_name.into(),
            cost_usd: None,
            tokens_used: None,
            duration_ms: Some(duration_ms),
            success,
        })
        .await;
    }

    pub async fn log_cost_threshold(
        &self,
        agent_id: AgentId,
        current_cost: f64,
        threshold: f64,
    ) {
        self.log(AuditEntry {
            timestamp: Utc::now(),
            event_type: AuditEventType::CostThresholdReached,
            agent_id: Some(agent_id),
            agent_type: None,
            task_id: None,
            user: None,
            detail: format!(
                "cost ${:.4} exceeded threshold ${:.4}",
                current_cost, threshold
            ),
            cost_usd: Some(current_cost),
            tokens_used: None,
            duration_ms: None,
            success: false,
        })
        .await;
    }

    pub async fn query(
        &self,
        filter: AuditFilter,
    ) -> anyhow::Result<Vec<AuditEntry>> {
        let mut results = Vec::new();
        let dir = &self.log_dir;

        if !dir.exists() {
            return Ok(results);
        }

        let mut entries = tokio::fs::read_dir(dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "jsonl") {
                let content = tokio::fs::read_to_string(&path).await?;
                for line in content.lines() {
                    if let Ok(audit) = serde_json::from_str::<AuditEntry>(line) {
                        if filter.matches(&audit) {
                            results.push(audit);
                        }
                    }
                }
            }
        }

        results.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if let Some(limit) = filter.limit {
            results.truncate(limit);
        }

        Ok(results)
    }

    async fn write_entry(&self, entry: &AuditEntry) -> anyhow::Result<()> {
        tokio::fs::create_dir_all(&self.log_dir).await?;

        let date = entry.timestamp.format("%Y-%m-%d");
        let path = self.log_dir.join(format!("{}.jsonl", date));

        let line = serde_json::to_string(entry)? + "\n";

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;

        file.write_all(line.as_bytes()).await?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct AuditFilter {
    pub event_type: Option<AuditEventType>,
    pub agent_type: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub success_only: Option<bool>,
    pub limit: Option<usize>,
}

impl AuditFilter {
    fn matches(&self, entry: &AuditEntry) -> bool {
        if let Some(ref et) = self.event_type {
            let et_str = serde_json::to_string(et).unwrap_or_default();
            let entry_str = serde_json::to_string(&entry.event_type).unwrap_or_default();
            if et_str != entry_str {
                return false;
            }
        }
        if let Some(ref at) = self.agent_type {
            if entry.agent_type.as_deref() != Some(at) {
                return false;
            }
        }
        if let Some(since) = self.since {
            if entry.timestamp < since {
                return false;
            }
        }
        if let Some(until) = self.until {
            if entry.timestamp > until {
                return false;
            }
        }
        if let Some(success) = self.success_only {
            if entry.success != success {
                return false;
            }
        }
        true
    }
}
