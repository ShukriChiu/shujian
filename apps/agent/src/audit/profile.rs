use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub agent_type: String,
    pub display_name: String,
    pub first_seen: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
    pub stats: AgentStats,
    pub efficiency: EfficiencyMetrics,
    pub cost_trend: Vec<CostDataPoint>,
    pub domain_strengths: HashMap<String, f64>,
    pub recent_tasks: Vec<TaskSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentStats {
    pub total_spawns: u64,
    pub tasks_completed: u64,
    pub tasks_failed: u64,
    pub tasks_killed: u64,
    pub total_cost_usd: f64,
    pub total_tokens: u64,
    pub total_duration_ms: i64,
    pub tools_called: u64,
    pub tools_blocked: u64,
    pub permissions_asked: u64,
    pub permissions_denied: u64,
}

impl AgentStats {
    pub fn success_rate(&self) -> f64 {
        let total = self.tasks_completed + self.tasks_failed + self.tasks_killed;
        if total == 0 {
            return 0.0;
        }
        self.tasks_completed as f64 / total as f64
    }

    pub fn avg_cost_per_task(&self) -> f64 {
        let total = self.tasks_completed + self.tasks_failed;
        if total == 0 {
            return 0.0;
        }
        self.total_cost_usd / total as f64
    }

    pub fn avg_duration_ms(&self) -> i64 {
        let total = self.tasks_completed + self.tasks_failed;
        if total == 0 {
            return 0;
        }
        self.total_duration_ms / total as i64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EfficiencyMetrics {
    pub tokens_per_task: f64,
    pub cost_per_success: f64,
    pub avg_turns_per_task: f64,
    pub tool_block_rate: f64,
    pub self_sufficiency: f64,
}

impl Default for EfficiencyMetrics {
    fn default() -> Self {
        Self {
            tokens_per_task: 0.0,
            cost_per_success: 0.0,
            avg_turns_per_task: 0.0,
            tool_block_rate: 0.0,
            self_sufficiency: 1.0,
        }
    }
}

impl EfficiencyMetrics {
    pub fn compute(stats: &AgentStats) -> Self {
        let total_tasks = stats.tasks_completed + stats.tasks_failed;
        let total_tools = stats.tools_called + stats.tools_blocked;

        Self {
            tokens_per_task: if total_tasks > 0 {
                stats.total_tokens as f64 / total_tasks as f64
            } else {
                0.0
            },
            cost_per_success: if stats.tasks_completed > 0 {
                stats.total_cost_usd / stats.tasks_completed as f64
            } else {
                0.0
            },
            avg_turns_per_task: 0.0,
            tool_block_rate: if total_tools > 0 {
                stats.tools_blocked as f64 / total_tools as f64
            } else {
                0.0
            },
            self_sufficiency: if total_tasks > 0 {
                1.0 - (stats.permissions_asked as f64 / total_tasks.max(1) as f64).min(1.0)
            } else {
                1.0
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostDataPoint {
    pub date: String,
    pub cost_usd: f64,
    pub tasks: u64,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummary {
    pub task_id: String,
    pub description: String,
    pub status: String,
    pub cost_usd: f64,
    pub duration_ms: i64,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct ProfileStore {
    profiles: HashMap<String, AgentProfile>,
}

impl ProfileStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_spawn(&mut self, agent_type: &str, display_name: &str) {
        let profile = self
            .profiles
            .entry(agent_type.to_string())
            .or_insert_with(|| AgentProfile {
                agent_type: agent_type.into(),
                display_name: display_name.into(),
                first_seen: Utc::now(),
                last_active: Utc::now(),
                stats: AgentStats::default(),
                efficiency: EfficiencyMetrics::default(),
                cost_trend: Vec::new(),
                domain_strengths: HashMap::new(),
                recent_tasks: Vec::new(),
            });

        profile.stats.total_spawns += 1;
        profile.last_active = Utc::now();
    }

    pub fn record_task_complete(
        &mut self,
        agent_type: &str,
        task_id: &str,
        description: &str,
        cost: f64,
        tokens: u64,
        duration_ms: i64,
        success: bool,
    ) {
        if let Some(profile) = self.profiles.get_mut(agent_type) {
            if success {
                profile.stats.tasks_completed += 1;
            } else {
                profile.stats.tasks_failed += 1;
            }
            profile.stats.total_cost_usd += cost;
            profile.stats.total_tokens += tokens;
            profile.stats.total_duration_ms += duration_ms;
            profile.last_active = Utc::now();

            profile.efficiency = EfficiencyMetrics::compute(&profile.stats);

            profile.recent_tasks.push(TaskSummary {
                task_id: task_id.into(),
                description: description.into(),
                status: if success { "completed" } else { "failed" }.into(),
                cost_usd: cost,
                duration_ms,
                completed_at: Utc::now(),
            });

            if profile.recent_tasks.len() > 50 {
                profile.recent_tasks.remove(0);
            }
        }
    }

    pub fn record_tool_call(&mut self, agent_type: &str, blocked: bool) {
        if let Some(profile) = self.profiles.get_mut(agent_type) {
            profile.stats.tools_called += 1;
            if blocked {
                profile.stats.tools_blocked += 1;
            }
            profile.efficiency = EfficiencyMetrics::compute(&profile.stats);
        }
    }

    pub fn record_domain_success(&mut self, agent_type: &str, domain: &str) {
        if let Some(profile) = self.profiles.get_mut(agent_type) {
            let score = profile.domain_strengths.entry(domain.into()).or_insert(0.0);
            *score = (*score * 0.9) + 0.1;
        }
    }

    pub fn get_profile(&self, agent_type: &str) -> Option<&AgentProfile> {
        self.profiles.get(agent_type)
    }

    pub fn all_profiles(&self) -> Vec<&AgentProfile> {
        let mut profiles: Vec<_> = self.profiles.values().collect();
        profiles.sort_by(|a, b| b.stats.total_spawns.cmp(&a.stats.total_spawns));
        profiles
    }

    pub fn recommend_agent(&self, domain: Option<&str>) -> Option<&str> {
        let mut best: Option<(&str, f64)> = None;

        for profile in self.profiles.values() {
            let mut score = profile.stats.success_rate();

            if let Some(d) = domain {
                if let Some(&domain_score) = profile.domain_strengths.get(d) {
                    score += domain_score;
                }
            }

            if profile.stats.total_spawns < 3 {
                score *= 0.5;
            }

            match best {
                None => best = Some((&profile.agent_type, score)),
                Some((_, best_score)) if score > best_score => {
                    best = Some((&profile.agent_type, score));
                }
                _ => {}
            }
        }

        best.map(|(t, _)| t)
    }
}
