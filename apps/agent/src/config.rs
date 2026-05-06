use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize, Clone)]
pub struct AppConfig {
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub model_categories: Vec<ModelCategory>,
    pub llm: LlmConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub supabase: SubabaseConfig,
    #[serde(default)]
    pub union_agent: UnionAgentConfig,
    #[serde(default)]
    pub triggers: Vec<TriggerConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AgentConfig {
    pub name: String,
    pub workspace: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub model_category: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub discipline: DisciplineConfig,
    #[serde(default)]
    pub triggers: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DisciplineConfig {
    #[serde(default = "default_true")]
    pub enforce_todo: bool,
    #[serde(default = "default_max_continuation")]
    pub max_continuation: usize,
    #[serde(default = "default_true")]
    pub accumulate_wisdom: bool,
}

impl Default for DisciplineConfig {
    fn default() -> Self {
        Self {
            enforce_todo: true,
            max_continuation: 3,
            accumulate_wisdom: true,
        }
    }
}

fn default_true() -> bool { true }
fn default_max_continuation() -> usize { 3 }

#[derive(Debug, Deserialize, Clone)]
pub struct ModelCategory {
    pub name: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub max_rounds: Option<usize>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
}

fn default_max_rounds() -> usize {
    50
}

#[derive(Debug, Deserialize, Clone)]
pub struct ServerConfig {
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_tasks: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            max_concurrent_tasks: default_max_concurrent(),
        }
    }
}

fn default_bind() -> String {
    "0.0.0.0:8002".into()
}

fn default_max_concurrent() -> usize { 5 }

#[derive(Debug, Deserialize, Clone, Default)]
pub struct SubabaseConfig {
    #[serde(default)]
    pub url_env: Option<String>,
    #[serde(default)]
    pub key_env: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct UnionAgentConfig {
    #[serde(default = "default_union_agent_url")]
    pub base_url: String,
}

fn default_union_agent_url() -> String {
    "http://localhost:8001".into()
}

#[derive(Debug, Deserialize, Clone)]
pub struct TriggerConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub trigger_type: String,
    #[serde(default)]
    pub expr: Option<String>,
    #[serde(default)]
    pub minutes: Option<u64>,
    pub reason: String,
    #[serde(default)]
    pub agent: Option<String>,
}

impl AppConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let content =
            std::fs::read_to_string(path).with_context(|| format!("读取配置文件失败: {}", path.display()))?;
        let config: AppConfig =
            toml::from_str(&content).with_context(|| format!("解析配置文件失败: {}", path.display()))?;
        Ok(config)
    }

    pub fn get_agent(&self, name: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.name == name)
    }

    pub fn default_agent(&self) -> Option<&AgentConfig> {
        self.agents.first()
    }

    pub fn resolve_llm(&self, agent: &AgentConfig) -> ResolvedLlm {
        if let Some(cat_name) = &agent.model_category {
            if let Some(cat) = self.model_categories.iter().find(|c| c.name == *cat_name) {
                return ResolvedLlm {
                    provider: cat.provider.clone(),
                    model: cat.model.clone(),
                    base_url: cat.base_url.clone().or(self.llm.base_url.clone()),
                    api_key_env: cat.api_key_env.clone().or(self.llm.api_key_env.clone()),
                    max_rounds: cat.max_rounds.unwrap_or(self.llm.max_rounds),
                };
            }
        }
        ResolvedLlm {
            provider: self.llm.provider.clone(),
            model: self.llm.model.clone(),
            base_url: self.llm.base_url.clone(),
            api_key_env: self.llm.api_key_env.clone(),
            max_rounds: self.llm.max_rounds,
        }
    }

    pub fn workspace_path(&self) -> PathBuf {
        self.default_agent()
            .map(|a| PathBuf::from(&a.workspace))
            .unwrap_or_else(|| PathBuf::from("./agents/default"))
    }

    pub fn llm_api_key(&self) -> Result<String> {
        self.resolve_api_key(&self.llm.api_key_env, &self.llm.provider)
    }

    pub fn resolve_api_key(&self, key_env: &Option<String>, provider: &str) -> Result<String> {
        let env_name = key_env
            .clone()
            .unwrap_or_else(|| match provider {
                "anthropic" => "ANTHROPIC_API_KEY".into(),
                _ => "OPENAI_API_KEY".into(),
            });
        std::env::var(&env_name).with_context(|| format!("环境变量 {} 未设置", env_name))
    }

    pub fn supabase_url(&self) -> Result<String> {
        let env_name = self.supabase.url_env.as_deref().unwrap_or("SUPABASE_URL");
        std::env::var(env_name).with_context(|| format!("环境变量 {} 未设置", env_name))
    }

    pub fn supabase_key(&self) -> Result<String> {
        let env_name = self.supabase.key_env.as_deref().unwrap_or("SUPABASE_KEY");
        std::env::var(env_name).with_context(|| format!("环境变量 {} 未设置", env_name))
    }

    pub fn triggers_for_agent(&self, agent_name: &str) -> Vec<&TriggerConfig> {
        self.triggers
            .iter()
            .filter(|t| {
                t.agent.as_deref() == Some(agent_name)
                    || t.agent.is_none()
            })
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedLlm {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
    pub max_rounds: usize,
}

impl ResolvedLlm {
    pub fn to_llm_config(&self) -> LlmConfig {
        LlmConfig {
            provider: self.provider.clone(),
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            api_key_env: self.api_key_env.clone(),
            max_rounds: self.max_rounds,
        }
    }
}
