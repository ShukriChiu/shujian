use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Pricing for a single model, per million tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPricing {
    pub model_id: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    /// Cache-read tokens are charged at this multiplier of the input rate (typically 0.1x).
    pub cache_read_multiplier: f64,
    /// 5-minute ephemeral cache creation is 1.25x input.
    pub cache_write_5m_multiplier: f64,
    /// 1-hour ephemeral cache creation is 2x input (Claude Code default).
    pub cache_write_1h_multiplier: f64,
}

impl ModelPricing {
    pub fn cost_for(&self, usage: &TokenUsage) -> f64 {
        let input_cost = (usage.input_tokens as f64 / 1_000_000.0) * self.input_per_mtok;
        let output_cost = (usage.output_tokens as f64 / 1_000_000.0) * self.output_per_mtok;
        let cache_read_cost = (usage.cache_read_tokens as f64 / 1_000_000.0)
            * self.input_per_mtok
            * self.cache_read_multiplier;
        let cache_write_5m_cost = (usage.cache_creation_5m_tokens as f64 / 1_000_000.0)
            * self.input_per_mtok
            * self.cache_write_5m_multiplier;
        let cache_write_1h_cost = (usage.cache_creation_1h_tokens as f64 / 1_000_000.0)
            * self.input_per_mtok
            * self.cache_write_1h_multiplier;

        input_cost + output_cost + cache_read_cost + cache_write_5m_cost + cache_write_1h_cost
    }
}

/// Token counts for a single interaction step.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_5m_tokens: u64,
    pub cache_creation_1h_tokens: u64,
}

impl TokenUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_5m_tokens
            + self.cache_creation_1h_tokens
    }

    pub fn merge(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_5m_tokens += other.cache_creation_5m_tokens;
        self.cache_creation_1h_tokens += other.cache_creation_1h_tokens;
    }
}

/// A snapshot of cost at a point in time, used for per-step and per-session tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostSnapshot {
    pub timestamp: DateTime<Utc>,
    pub model_id: String,
    pub usage: TokenUsage,
    pub cost_usd: f64,
    pub step_index: u32,
    pub session_id: String,
    pub agent_id: Option<String>,
}

/// Per-model usage aggregation within a session or report period.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelUsageSummary {
    pub model_id: String,
    pub total_usage: TokenUsage,
    pub total_cost_usd: f64,
    pub step_count: u32,
}

/// Budget configuration for a session or task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetConfig {
    pub max_tokens: Option<u64>,
    pub max_cost_usd: Option<f64>,
    pub warning_threshold: f64,
    pub hard_stop: bool,
    pub max_duration_ms: Option<u64>,
    pub max_loop_iterations: Option<u32>,
    pub max_consecutive_failures: Option<u32>,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            max_tokens: Some(500_000),
            max_cost_usd: Some(5.0),
            warning_threshold: 0.7,
            hard_stop: true,
            max_duration_ms: Some(30 * 60 * 1000),
            max_loop_iterations: Some(10),
            max_consecutive_failures: Some(3),
        }
    }
}

/// Global (monthly/daily) budget caps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalBudget {
    pub daily_limit_usd: Option<f64>,
    pub monthly_limit_usd: Option<f64>,
    pub monthly_token_limit: Option<u64>,
    pub auto_pause: bool,
}

impl Default for GlobalBudget {
    fn default() -> Self {
        Self {
            daily_limit_usd: Some(12.0),
            monthly_limit_usd: Some(200.0),
            monthly_token_limit: None,
            auto_pause: true,
        }
    }
}

/// Task profiles with pre-defined budgets for different task complexities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProfile {
    pub name: String,
    pub budget: BudgetConfig,
}

/// Pre-defined task profiles matching Claude Code's recommended patterns.
pub fn default_task_profiles() -> HashMap<String, TaskProfile> {
    let mut profiles = HashMap::new();

    profiles.insert(
        "quick-fix".into(),
        TaskProfile {
            name: "quick-fix".into(),
            budget: BudgetConfig {
                max_tokens: Some(50_000),
                max_cost_usd: Some(0.50),
                warning_threshold: 0.7,
                hard_stop: true,
                max_duration_ms: Some(5 * 60 * 1000),
                max_loop_iterations: Some(3),
                max_consecutive_failures: Some(2),
            },
        },
    );

    profiles.insert(
        "feature".into(),
        TaskProfile {
            name: "feature".into(),
            budget: BudgetConfig {
                max_tokens: Some(300_000),
                max_cost_usd: Some(3.0),
                warning_threshold: 0.7,
                hard_stop: true,
                max_duration_ms: Some(30 * 60 * 1000),
                max_loop_iterations: Some(10),
                max_consecutive_failures: Some(3),
            },
        },
    );

    profiles.insert(
        "refactoring".into(),
        TaskProfile {
            name: "refactoring".into(),
            budget: BudgetConfig {
                max_tokens: Some(500_000),
                max_cost_usd: Some(5.0),
                warning_threshold: 0.7,
                hard_stop: true,
                max_duration_ms: Some(60 * 60 * 1000),
                max_loop_iterations: Some(15),
                max_consecutive_failures: Some(3),
            },
        },
    );

    profiles.insert(
        "exploration".into(),
        TaskProfile {
            name: "exploration".into(),
            budget: BudgetConfig {
                max_tokens: Some(200_000),
                max_cost_usd: Some(2.0),
                warning_threshold: 0.8,
                hard_stop: false,
                max_duration_ms: Some(15 * 60 * 1000),
                max_loop_iterations: Some(5),
                max_consecutive_failures: Some(2),
            },
        },
    );

    profiles
}

/// Budget check result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BudgetVerdict {
    /// Under budget, all clear.
    Ok,
    /// Warning threshold crossed; percentage of budget consumed.
    Warning { usage_pct: f64, message: String },
    /// Hard limit reached; must stop.
    Exceeded { reason: String },
    /// Globally paused (daily/monthly limit hit).
    Paused { reason: String },
}

/// Rate limit configuration per team size.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    pub tpm_per_user: u64,
    pub rpm_per_user: f64,
    pub team_size: u32,
}

impl RateLimitConfig {
    pub fn for_team_size(size: u32) -> Self {
        let (tpm, rpm) = match size {
            1..=5 => (250_000, 6.0),
            6..=20 => (125_000, 3.0),
            21..=50 => (62_500, 1.5),
            51..=100 => (30_000, 0.75),
            101..=500 => (17_500, 0.42),
            _ => (12_500, 0.3),
        };
        Self {
            tpm_per_user: tpm,
            rpm_per_user: rpm,
            team_size: size,
        }
    }

    pub fn total_tpm(&self) -> u64 {
        self.tpm_per_user * self.team_size as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sonnet_pricing() -> ModelPricing {
        ModelPricing {
            model_id: "claude-sonnet-4.6".into(),
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            cache_read_multiplier: 0.1,
            cache_write_5m_multiplier: 1.25,
            cache_write_1h_multiplier: 2.0,
        }
    }

    #[test]
    fn test_cost_calculation() {
        let pricing = sonnet_pricing();
        let usage = TokenUsage {
            input_tokens: 10_000,
            output_tokens: 2_000,
            cache_read_tokens: 50_000,
            cache_creation_5m_tokens: 0,
            cache_creation_1h_tokens: 5_000,
            ..Default::default()
        };

        let cost = pricing.cost_for(&usage);

        let expected_input = 10_000.0 / 1e6 * 3.0;
        let expected_output = 2_000.0 / 1e6 * 15.0;
        let expected_cache_read = 50_000.0 / 1e6 * 3.0 * 0.1;
        let expected_cache_write = 5_000.0 / 1e6 * 3.0 * 2.0;
        let expected =
            expected_input + expected_output + expected_cache_read + expected_cache_write;

        assert!((cost - expected).abs() < 1e-10);
    }

    #[test]
    fn test_usage_merge() {
        let mut a = TokenUsage {
            input_tokens: 100,
            output_tokens: 50,
            ..Default::default()
        };
        let b = TokenUsage {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_tokens: 30,
            ..Default::default()
        };
        a.merge(&b);
        assert_eq!(a.input_tokens, 300);
        assert_eq!(a.output_tokens, 150);
        assert_eq!(a.cache_read_tokens, 30);
    }

    #[test]
    fn test_rate_limit_scaling() {
        let small = RateLimitConfig::for_team_size(3);
        let large = RateLimitConfig::for_team_size(200);
        assert!(small.tpm_per_user > large.tpm_per_user);
        assert_eq!(large.total_tpm(), 17_500 * 200);
    }
}
