use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

use super::meter::SessionCostSummary;
use super::types::TokenUsage;

/// Persistent cost reporter that aggregates across sessions.
pub struct CostReporter {
    storage_dir: PathBuf,
    sessions: Mutex<Vec<SessionRecord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub total_cost_usd: f64,
    pub total_usage: TokenUsage,
    pub model_breakdown: HashMap<String, ModelCostEntry>,
    pub step_count: u32,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCostEntry {
    pub model_id: String,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl CostReporter {
    pub fn new(workspace: &Path) -> Self {
        let storage_dir = workspace.join(".shujian").join("cost");
        Self {
            storage_dir,
            sessions: Mutex::new(Vec::new()),
        }
    }

    /// Record a completed session.
    pub async fn record_session(
        &self,
        summary: SessionCostSummary,
        agent_type: Option<&str>,
    ) {
        let mut model_breakdown = HashMap::new();
        for (model_id, usage) in &summary.model_usage {
            model_breakdown.insert(
                model_id.clone(),
                ModelCostEntry {
                    model_id: model_id.clone(),
                    cost_usd: usage.total_cost_usd,
                    input_tokens: usage.total_usage.input_tokens,
                    output_tokens: usage.total_usage.output_tokens,
                    cache_read_tokens: usage.total_usage.cache_read_tokens,
                    cache_write_tokens: usage.total_usage.cache_creation_5m_tokens
                        + usage.total_usage.cache_creation_1h_tokens,
                },
            );
        }

        let now = Utc::now();
        let record = SessionRecord {
            session_id: summary.session_id,
            start_time: now
                - chrono::Duration::milliseconds(summary.duration_ms as i64),
            end_time: now,
            total_cost_usd: summary.total_cost_usd,
            total_usage: summary.total_usage,
            model_breakdown,
            step_count: summary.step_count,
            agent_type: agent_type.map(String::from),
        };

        if let Err(e) = self.persist_record(&record).await {
            tracing::warn!("Failed to persist cost record: {}", e);
        }

        self.sessions.lock().await.push(record);
    }

    async fn persist_record(
        &self,
        record: &SessionRecord,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        tokio::fs::create_dir_all(&self.storage_dir).await?;

        let now = Utc::now();
        let filename = format!(
            "costs_{}-{:02}.jsonl",
            now.year(),
            now.month()
        );
        let path = self.storage_dir.join(filename);

        let line = serde_json::to_string(record)? + "\n";
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?
            .write_all(line.as_bytes())
            .await?;

        Ok(())
    }

    /// Generate a cost report for a time period.
    pub async fn generate_report(
        &self,
        since: Option<DateTime<Utc>>,
        until: Option<DateTime<Utc>>,
    ) -> CostReport {
        let sessions = self.sessions.lock().await;
        let filtered: Vec<&SessionRecord> = sessions
            .iter()
            .filter(|s| {
                if let Some(since) = since {
                    if s.start_time < since {
                        return false;
                    }
                }
                if let Some(until) = until {
                    if s.end_time > until {
                        return false;
                    }
                }
                true
            })
            .collect();

        let total_cost: f64 = filtered.iter().map(|s| s.total_cost_usd).sum();
        let total_sessions = filtered.len();

        let mut by_model: HashMap<String, ModelCostEntry> = HashMap::new();
        let mut by_agent: HashMap<String, f64> = HashMap::new();
        let mut daily_costs: HashMap<String, f64> = HashMap::new();
        let mut total_usage = TokenUsage::default();

        for session in &filtered {
            total_usage.merge(&session.total_usage);

            for (model_id, entry) in &session.model_breakdown {
                let agg = by_model
                    .entry(model_id.clone())
                    .or_insert_with(|| ModelCostEntry {
                        model_id: model_id.clone(),
                        cost_usd: 0.0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                    });
                agg.cost_usd += entry.cost_usd;
                agg.input_tokens += entry.input_tokens;
                agg.output_tokens += entry.output_tokens;
                agg.cache_read_tokens += entry.cache_read_tokens;
                agg.cache_write_tokens += entry.cache_write_tokens;
            }

            let agent = session
                .agent_type
                .as_deref()
                .unwrap_or("unknown");
            *by_agent.entry(agent.into()).or_insert(0.0) +=
                session.total_cost_usd;

            let day_key = format!(
                "{}-{:02}-{:02}",
                session.start_time.year(),
                session.start_time.month(),
                session.start_time.day()
            );
            *daily_costs.entry(day_key).or_insert(0.0) +=
                session.total_cost_usd;
        }

        let avg_cost_per_session = if total_sessions > 0 {
            total_cost / total_sessions as f64
        } else {
            0.0
        };

        let avg_daily_cost = if !daily_costs.is_empty() {
            total_cost / daily_costs.len() as f64
        } else {
            0.0
        };

        CostReport {
            period_start: since,
            period_end: until,
            total_cost_usd: total_cost,
            total_sessions,
            total_usage,
            avg_cost_per_session,
            avg_daily_cost,
            by_model,
            by_agent,
            daily_costs,
        }
    }

    /// Load historical cost records from disk.
    pub async fn load_history(&self) -> Vec<SessionRecord> {
        let mut records = Vec::new();

        let dir = match tokio::fs::read_dir(&self.storage_dir).await {
            Ok(dir) => dir,
            Err(_) => return records,
        };

        let mut dir = dir;
        while let Ok(Some(entry)) = dir.next_entry().await {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "jsonl") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    for line in content.lines() {
                        if let Ok(record) =
                            serde_json::from_str::<SessionRecord>(line)
                        {
                            records.push(record);
                        }
                    }
                }
            }
        }

        records
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostReport {
    pub period_start: Option<DateTime<Utc>>,
    pub period_end: Option<DateTime<Utc>>,
    pub total_cost_usd: f64,
    pub total_sessions: usize,
    pub total_usage: TokenUsage,
    pub avg_cost_per_session: f64,
    pub avg_daily_cost: f64,
    pub by_model: HashMap<String, ModelCostEntry>,
    pub by_agent: HashMap<String, f64>,
    pub daily_costs: HashMap<String, f64>,
}

use tokio::io::AsyncWriteExt;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::types::ModelUsageSummary;
    use std::collections::HashMap;

    fn make_summary(id: &str, cost: f64, input: u64, output: u64) -> SessionCostSummary {
        let mut model_usage = HashMap::new();
        model_usage.insert(
            "claude-sonnet-4.6".to_string(),
            ModelUsageSummary {
                model_id: "claude-sonnet-4.6".to_string(),
                total_usage: TokenUsage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Default::default()
                },
                total_cost_usd: cost,
                step_count: 1,
            },
        );

        SessionCostSummary {
            session_id: id.to_string(),
            total_cost_usd: cost,
            total_usage: TokenUsage {
                input_tokens: input,
                output_tokens: output,
                ..Default::default()
            },
            model_usage,
            step_count: 1,
            duration_ms: 5000,
            consecutive_failures: 0,
        }
    }

    #[tokio::test]
    async fn test_report_generation() {
        let reporter = CostReporter::new(Path::new("/tmp/test-cost-reporter"));

        reporter
            .record_session(make_summary("s1", 0.50, 10000, 2000), Some("coder"))
            .await;
        reporter
            .record_session(make_summary("s2", 0.30, 8000, 1500), Some("reviewer"))
            .await;
        reporter
            .record_session(make_summary("s3", 0.20, 5000, 1000), Some("coder"))
            .await;

        let report = reporter.generate_report(None, None).await;

        assert_eq!(report.total_sessions, 3);
        assert!((report.total_cost_usd - 1.0).abs() < 1e-10);
        assert!(report.by_model.contains_key("claude-sonnet-4.6"));
        assert_eq!(report.by_agent.len(), 2);
        assert!((report.by_agent["coder"] - 0.70).abs() < 1e-10);
        assert!((report.by_agent["reviewer"] - 0.30).abs() < 1e-10);
    }
}
