use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::sync::Mutex;

use super::types::{CostSnapshot, ModelPricing, ModelUsageSummary, TokenUsage};

/// Known model pricing table. Updated as new models are released.
pub fn default_pricing_table() -> HashMap<String, ModelPricing> {
    let mut table = HashMap::new();

    let models = [
        ("claude-opus-4", 15.0, 75.0),
        ("claude-sonnet-4.6", 3.0, 15.0),
        ("claude-haiku-3.5", 0.80, 4.0),
        ("claude-sonnet-4", 3.0, 15.0),
        ("claude-haiku-4", 1.0, 5.0),
        ("gpt-4o", 2.50, 10.0),
        ("gpt-4o-mini", 0.15, 0.60),
        ("gpt-4.1", 2.0, 8.0),
        ("gpt-4.1-mini", 0.40, 1.60),
        ("gpt-4.1-nano", 0.10, 0.40),
        ("deepseek-r1", 0.55, 2.19),
        ("deepseek-v3", 0.27, 1.10),
        ("gemini-2.5-pro", 1.25, 10.0),
        ("gemini-2.5-flash", 0.15, 0.60),
    ];

    for (id, input, output) in models {
        table.insert(
            id.to_string(),
            ModelPricing {
                model_id: id.to_string(),
                input_per_mtok: input,
                output_per_mtok: output,
                cache_read_multiplier: 0.1,
                cache_write_5m_multiplier: 1.25,
                cache_write_1h_multiplier: 2.0,
            },
        );
    }

    table
}

/// Session-level token meter that tracks per-step and cumulative usage.
pub struct SessionMeter {
    session_id: String,
    pricing_table: HashMap<String, ModelPricing>,
    steps: Mutex<Vec<CostSnapshot>>,
    step_counter: AtomicU32,
    model_summaries: Mutex<HashMap<String, ModelUsageSummary>>,
    consecutive_failures: AtomicU32,
    start_time: std::time::Instant,
}

impl SessionMeter {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            pricing_table: default_pricing_table(),
            steps: Mutex::new(Vec::new()),
            step_counter: AtomicU32::new(0),
            model_summaries: Mutex::new(HashMap::new()),
            consecutive_failures: AtomicU32::new(0),
            start_time: std::time::Instant::now(),
        }
    }

    pub fn with_pricing(mut self, table: HashMap<String, ModelPricing>) -> Self {
        self.pricing_table = table;
        self
    }

    /// Record a step's token usage. Returns the cost for this step.
    pub async fn record_step(
        &self,
        model_id: &str,
        usage: TokenUsage,
        agent_id: Option<&str>,
    ) -> f64 {
        let cost = self
            .pricing_table
            .get(model_id)
            .map(|p| p.cost_for(&usage))
            .unwrap_or(0.0);

        let step_index = self.step_counter.fetch_add(1, Ordering::Relaxed);

        let snapshot = CostSnapshot {
            timestamp: Utc::now(),
            model_id: model_id.to_string(),
            usage: usage.clone(),
            cost_usd: cost,
            step_index,
            session_id: self.session_id.clone(),
            agent_id: agent_id.map(String::from),
        };

        self.steps.lock().await.push(snapshot);

        let mut summaries = self.model_summaries.lock().await;
        let summary = summaries
            .entry(model_id.to_string())
            .or_insert_with(|| ModelUsageSummary {
                model_id: model_id.to_string(),
                ..Default::default()
            });
        summary.total_usage.merge(&usage);
        summary.total_cost_usd += cost;
        summary.step_count += 1;

        cost
    }

    /// Record a successful step (resets consecutive failure counter).
    pub fn record_success(&self) {
        self.consecutive_failures.store(0, Ordering::Relaxed);
    }

    /// Record a failed step (increments consecutive failure counter).
    pub fn record_failure(&self) -> u32 {
        self.consecutive_failures.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures.load(Ordering::Relaxed)
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }

    pub fn step_count(&self) -> u32 {
        self.step_counter.load(Ordering::Relaxed)
    }

    /// Get the total cost for this session across all models.
    pub async fn total_cost_usd(&self) -> f64 {
        self.model_summaries
            .lock()
            .await
            .values()
            .map(|s| s.total_cost_usd)
            .sum()
    }

    /// Get the total tokens consumed in this session.
    pub async fn total_tokens(&self) -> u64 {
        self.model_summaries
            .lock()
            .await
            .values()
            .map(|s| s.total_usage.total_tokens())
            .sum()
    }

    /// Get the cumulative usage across all models.
    pub async fn cumulative_usage(&self) -> TokenUsage {
        let mut total = TokenUsage::default();
        for summary in self.model_summaries.lock().await.values() {
            total.merge(&summary.total_usage);
        }
        total
    }

    /// Get per-model usage breakdowns.
    pub async fn model_usage(&self) -> HashMap<String, ModelUsageSummary> {
        self.model_summaries.lock().await.clone()
    }

    /// Get all step snapshots for detailed analysis.
    pub async fn steps(&self) -> Vec<CostSnapshot> {
        self.steps.lock().await.clone()
    }

    /// Get session summary matching Claude Code's /cost command output.
    pub async fn session_summary(&self) -> SessionCostSummary {
        let total_cost = self.total_cost_usd().await;
        let total_usage = self.cumulative_usage().await;
        let model_usage = self.model_usage().await;
        let elapsed = self.start_time.elapsed();

        SessionCostSummary {
            session_id: self.session_id.clone(),
            total_cost_usd: total_cost,
            total_usage,
            model_usage,
            step_count: self.step_count(),
            duration_ms: elapsed.as_millis() as u64,
            consecutive_failures: self.consecutive_failures(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCostSummary {
    pub session_id: String,
    pub total_cost_usd: f64,
    pub total_usage: TokenUsage,
    pub model_usage: HashMap<String, ModelUsageSummary>,
    pub step_count: u32,
    pub duration_ms: u64,
    pub consecutive_failures: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_meter() {
        let meter = SessionMeter::new("test-session");

        let cost1 = meter
            .record_step(
                "claude-sonnet-4.6",
                TokenUsage {
                    input_tokens: 10_000,
                    output_tokens: 2_000,
                    ..Default::default()
                },
                None,
            )
            .await;

        assert!(cost1 > 0.0);

        let cost2 = meter
            .record_step(
                "claude-sonnet-4.6",
                TokenUsage {
                    input_tokens: 5_000,
                    output_tokens: 1_000,
                    cache_read_tokens: 8_000,
                    ..Default::default()
                },
                Some("sub-agent-1"),
            )
            .await;

        assert!(cost2 > 0.0);

        let total = meter.total_cost_usd().await;
        assert!((total - (cost1 + cost2)).abs() < 1e-10);
        assert_eq!(meter.step_count(), 2);

        let summary = meter.session_summary().await;
        assert_eq!(summary.step_count, 2);
        assert_eq!(summary.total_usage.input_tokens, 15_000);
        assert_eq!(summary.total_usage.output_tokens, 3_000);
    }

    #[tokio::test]
    async fn test_multi_model_tracking() {
        let meter = SessionMeter::new("multi-model");

        meter
            .record_step(
                "claude-sonnet-4.6",
                TokenUsage {
                    input_tokens: 10_000,
                    output_tokens: 2_000,
                    ..Default::default()
                },
                None,
            )
            .await;

        meter
            .record_step(
                "claude-haiku-3.5",
                TokenUsage {
                    input_tokens: 5_000,
                    output_tokens: 1_000,
                    ..Default::default()
                },
                Some("subagent"),
            )
            .await;

        let model_usage = meter.model_usage().await;
        assert_eq!(model_usage.len(), 2);
        assert!(model_usage.contains_key("claude-sonnet-4.6"));
        assert!(model_usage.contains_key("claude-haiku-3.5"));

        let sonnet = &model_usage["claude-sonnet-4.6"];
        let haiku = &model_usage["claude-haiku-3.5"];
        assert!(sonnet.total_cost_usd > haiku.total_cost_usd);
    }

    #[test]
    fn test_failure_tracking() {
        let meter = SessionMeter::new("fail-test");

        meter.record_success();
        assert_eq!(meter.consecutive_failures(), 0);

        assert_eq!(meter.record_failure(), 1);
        assert_eq!(meter.record_failure(), 2);
        assert_eq!(meter.consecutive_failures(), 2);

        meter.record_success();
        assert_eq!(meter.consecutive_failures(), 0);
    }
}
