use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;

use super::meter::SessionMeter;
use super::types::{BudgetConfig, BudgetVerdict, GlobalBudget, TaskProfile};

/// Budget enforcer that checks session and global limits.
pub struct BudgetEnforcer {
    session_budget: BudgetConfig,
    global_budget: GlobalBudget,
    task_profiles: HashMap<String, TaskProfile>,
    /// Daily cost accumulator keyed by date string (YYYY-MM-DD).
    daily_costs: Mutex<HashMap<String, f64>>,
    /// Monthly cost accumulator keyed by month string (YYYY-MM).
    monthly_costs: Mutex<HashMap<String, f64>>,
    paused: AtomicBool,
    warning_issued: Mutex<HashMap<String, bool>>,
}

impl BudgetEnforcer {
    pub fn new(session_budget: BudgetConfig, global_budget: GlobalBudget) -> Self {
        Self {
            session_budget,
            global_budget,
            task_profiles: super::types::default_task_profiles(),
            daily_costs: Mutex::new(HashMap::new()),
            monthly_costs: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            warning_issued: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_profiles(mut self, profiles: HashMap<String, TaskProfile>) -> Self {
        self.task_profiles = profiles;
        self
    }

    /// Get the budget for a named task profile, falling back to the session default.
    pub fn budget_for_profile(&self, profile_name: &str) -> &BudgetConfig {
        self.task_profiles
            .get(profile_name)
            .map(|p| &p.budget)
            .unwrap_or(&self.session_budget)
    }

    /// Check all budget limits against the current session meter state.
    pub async fn check(&self, meter: &SessionMeter) -> BudgetVerdict {
        if self.paused.load(Ordering::Relaxed) {
            return BudgetVerdict::Paused {
                reason: "Budget auto-paused due to global limit".into(),
            };
        }

        if let Some(max_failures) = self.session_budget.max_consecutive_failures {
            if meter.consecutive_failures() >= max_failures {
                return BudgetVerdict::Exceeded {
                    reason: format!(
                        "{} consecutive failures (limit: {})",
                        meter.consecutive_failures(),
                        max_failures
                    ),
                };
            }
        }

        if let Some(max_iterations) = self.session_budget.max_loop_iterations {
            if meter.step_count() >= max_iterations {
                return BudgetVerdict::Exceeded {
                    reason: format!(
                        "{} iterations reached (limit: {})",
                        meter.step_count(),
                        max_iterations
                    ),
                };
            }
        }

        if let Some(max_duration) = self.session_budget.max_duration_ms {
            if meter.elapsed_ms() >= max_duration {
                return BudgetVerdict::Exceeded {
                    reason: format!(
                        "Duration {}ms exceeded limit {}ms",
                        meter.elapsed_ms(),
                        max_duration
                    ),
                };
            }
        }

        let total_cost = meter.total_cost_usd().await;
        let total_tokens = meter.total_tokens().await;

        if let Some(max_cost) = self.session_budget.max_cost_usd {
            if total_cost >= max_cost && self.session_budget.hard_stop {
                return BudgetVerdict::Exceeded {
                    reason: format!(
                        "Session cost ${:.4} exceeded limit ${:.2}",
                        total_cost, max_cost
                    ),
                };
            }

            let pct = total_cost / max_cost;
            if pct >= self.session_budget.warning_threshold {
                let warning_key = format!("cost_{}", (pct * 10.0) as u32);
                let mut warnings = self.warning_issued.lock().await;
                if !warnings.contains_key(&warning_key) {
                    warnings.insert(warning_key, true);
                    return BudgetVerdict::Warning {
                        usage_pct: pct * 100.0,
                        message: format!(
                            "Session cost ${:.4} is {:.1}% of ${:.2} limit",
                            total_cost,
                            pct * 100.0,
                            max_cost
                        ),
                    };
                }
            }
        }

        if let Some(max_tokens) = self.session_budget.max_tokens {
            if total_tokens >= max_tokens && self.session_budget.hard_stop {
                return BudgetVerdict::Exceeded {
                    reason: format!(
                        "Session tokens {} exceeded limit {}",
                        total_tokens, max_tokens
                    ),
                };
            }

            let pct = total_tokens as f64 / max_tokens as f64;
            if pct >= self.session_budget.warning_threshold {
                let warning_key = format!("tokens_{}", (pct * 10.0) as u32);
                let mut warnings = self.warning_issued.lock().await;
                if !warnings.contains_key(&warning_key) {
                    warnings.insert(warning_key, true);
                    return BudgetVerdict::Warning {
                        usage_pct: pct * 100.0,
                        message: format!(
                            "Session tokens {} is {:.1}% of {} limit",
                            total_tokens,
                            pct * 100.0,
                            max_tokens
                        ),
                    };
                }
            }
        }

        BudgetVerdict::Ok
    }

    /// Record a session's cost against the global daily/monthly accumulators.
    pub async fn record_global_cost(&self, cost_usd: f64) {
        let now = Utc::now();
        let day_key = format!("{}-{:02}-{:02}", now.year(), now.month(), now.day());
        let month_key = format!("{}-{:02}", now.year(), now.month());

        {
            let mut daily = self.daily_costs.lock().await;
            *daily.entry(day_key.clone()).or_insert(0.0) += cost_usd;
        }

        {
            let mut monthly = self.monthly_costs.lock().await;
            *monthly.entry(month_key.clone()).or_insert(0.0) += cost_usd;
        }

        if self.global_budget.auto_pause {
            let should_pause = self.check_global_limits(&day_key, &month_key).await;
            if should_pause {
                self.paused.store(true, Ordering::Relaxed);
            }
        }
    }

    async fn check_global_limits(&self, day_key: &str, month_key: &str) -> bool {
        if let Some(daily_limit) = self.global_budget.daily_limit_usd {
            let daily = self.daily_costs.lock().await;
            if let Some(&cost) = daily.get(day_key) {
                if cost >= daily_limit {
                    return true;
                }
            }
        }

        if let Some(monthly_limit) = self.global_budget.monthly_limit_usd {
            let monthly = self.monthly_costs.lock().await;
            if let Some(&cost) = monthly.get(month_key) {
                if cost >= monthly_limit {
                    return true;
                }
            }
        }

        false
    }

    /// Manually unpause after a global limit was hit.
    pub fn unpause(&self) {
        self.paused.store(false, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    /// Get current global usage stats.
    pub async fn global_stats(&self) -> GlobalBudgetStats {
        let now = Utc::now();
        let day_key = format!("{}-{:02}-{:02}", now.year(), now.month(), now.day());
        let month_key = format!("{}-{:02}", now.year(), now.month());

        let daily_spend = self
            .daily_costs
            .lock()
            .await
            .get(&day_key)
            .copied()
            .unwrap_or(0.0);

        let monthly_spend = self
            .monthly_costs
            .lock()
            .await
            .get(&month_key)
            .copied()
            .unwrap_or(0.0);

        GlobalBudgetStats {
            daily_spend_usd: daily_spend,
            daily_limit_usd: self.global_budget.daily_limit_usd,
            daily_usage_pct: self
                .global_budget
                .daily_limit_usd
                .map(|l| (daily_spend / l) * 100.0),
            monthly_spend_usd: monthly_spend,
            monthly_limit_usd: self.global_budget.monthly_limit_usd,
            monthly_usage_pct: self
                .global_budget
                .monthly_limit_usd
                .map(|l| (monthly_spend / l) * 100.0),
            is_paused: self.is_paused(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalBudgetStats {
    pub daily_spend_usd: f64,
    pub daily_limit_usd: Option<f64>,
    pub daily_usage_pct: Option<f64>,
    pub monthly_spend_usd: f64,
    pub monthly_limit_usd: Option<f64>,
    pub monthly_usage_pct: Option<f64>,
    pub is_paused: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::types::TokenUsage;

    #[tokio::test]
    async fn test_session_cost_limit() {
        let budget = BudgetConfig {
            max_cost_usd: Some(0.10),
            max_tokens: None,
            warning_threshold: 0.7,
            hard_stop: true,
            max_duration_ms: None,
            max_loop_iterations: None,
            max_consecutive_failures: None,
        };
        let enforcer = BudgetEnforcer::new(budget, GlobalBudget::default());
        let meter = SessionMeter::new("test");

        meter
            .record_step(
                "claude-sonnet-4.6",
                TokenUsage {
                    input_tokens: 100_000,
                    output_tokens: 10_000,
                    ..Default::default()
                },
                None,
            )
            .await;

        let verdict = enforcer.check(&meter).await;
        assert!(
            matches!(verdict, BudgetVerdict::Exceeded { .. }),
            "Expected Exceeded, got {:?}",
            verdict
        );
    }

    #[tokio::test]
    async fn test_session_warning() {
        let budget = BudgetConfig {
            max_cost_usd: Some(1.0),
            max_tokens: None,
            warning_threshold: 0.5,
            hard_stop: true,
            max_duration_ms: None,
            max_loop_iterations: None,
            max_consecutive_failures: None,
        };
        let enforcer = BudgetEnforcer::new(budget, GlobalBudget::default());
        let meter = SessionMeter::new("test");

        // Sonnet: $3/MTok input + $15/MTok output
        // 100k input = $0.30, 20k output = $0.30, total = $0.60 => 60% of $1.0
        meter
            .record_step(
                "claude-sonnet-4.6",
                TokenUsage {
                    input_tokens: 100_000,
                    output_tokens: 20_000,
                    ..Default::default()
                },
                None,
            )
            .await;

        let verdict = enforcer.check(&meter).await;
        assert!(
            matches!(verdict, BudgetVerdict::Warning { .. }),
            "Expected Warning, got {:?}",
            verdict
        );
    }

    #[tokio::test]
    async fn test_consecutive_failures_limit() {
        let budget = BudgetConfig {
            max_consecutive_failures: Some(3),
            ..Default::default()
        };
        let enforcer = BudgetEnforcer::new(budget, GlobalBudget::default());
        let meter = SessionMeter::new("test");

        meter.record_failure();
        meter.record_failure();
        assert!(matches!(enforcer.check(&meter).await, BudgetVerdict::Ok));

        meter.record_failure();
        assert!(matches!(
            enforcer.check(&meter).await,
            BudgetVerdict::Exceeded { .. }
        ));
    }

    #[tokio::test]
    async fn test_global_auto_pause() {
        let global = GlobalBudget {
            daily_limit_usd: Some(0.01),
            monthly_limit_usd: None,
            monthly_token_limit: None,
            auto_pause: true,
        };
        let enforcer = BudgetEnforcer::new(BudgetConfig::default(), global);

        enforcer.record_global_cost(0.02).await;
        assert!(enforcer.is_paused());

        let meter = SessionMeter::new("test");
        assert!(matches!(
            enforcer.check(&meter).await,
            BudgetVerdict::Paused { .. }
        ));

        enforcer.unpause();
        assert!(!enforcer.is_paused());
    }
}
