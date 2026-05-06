use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFrontmatter {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "argument-hint")]
    pub argument_hint: Option<String>,
    #[serde(default, rename = "disable-model-invocation")]
    pub disable_model_invocation: bool,
    #[serde(default = "default_true", rename = "user-invocable")]
    pub user_invocable: bool,
    #[serde(default, rename = "allowed-tools")]
    pub allowed_tools: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub context: Option<SkillContext>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub paths: Option<SkillPaths>,
    #[serde(default)]
    pub shell: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillContext {
    Inline,
    Fork,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SkillPaths {
    Single(String),
    List(Vec<String>),
}

impl SkillPaths {
    pub fn patterns(&self) -> Vec<&str> {
        match self {
            Self::Single(s) => s.split(',').map(str::trim).collect(),
            Self::List(v) => v.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Personal,
    Project,
    Plugin,
    Enterprise,
    Nested,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedSkill {
    pub name: String,
    pub source: SkillSource,
    pub frontmatter: SkillFrontmatter,
    pub instructions: String,
    pub directory: PathBuf,
    pub supporting_files: Vec<PathBuf>,
}

impl LoadedSkill {
    pub fn slash_command(&self) -> String {
        format!("/{}", self.name)
    }

    pub fn description(&self) -> &str {
        self.frontmatter
            .description
            .as_deref()
            .unwrap_or(&self.instructions[..self.instructions.len().min(250)])
    }

    pub fn is_fork(&self) -> bool {
        matches!(self.frontmatter.context, Some(SkillContext::Fork))
    }

    pub fn is_model_invocable(&self) -> bool {
        !self.frontmatter.disable_model_invocation
    }

    pub fn is_user_invocable(&self) -> bool {
        self.frontmatter.user_invocable
    }

    pub fn allowed_tools(&self) -> Vec<String> {
        self.frontmatter
            .allowed_tools
            .as_deref()
            .map(|s| s.split(',').map(|t| t.trim().to_string()).collect())
            .unwrap_or_default()
    }

    pub fn matches_path(&self, file_path: &str) -> bool {
        let Some(ref paths) = self.frontmatter.paths else {
            return true;
        };
        let patterns = paths.patterns();
        if patterns.is_empty() {
            return true;
        }
        patterns
            .iter()
            .any(|pat| glob_match_simple(pat, file_path))
    }
}

fn glob_match_simple(pattern: &str, path: &str) -> bool {
    if pattern == "*" || pattern == "**" {
        return true;
    }
    if let Some(ext) = pattern.strip_prefix("*.") {
        return path.ends_with(&format!(".{}", ext));
    }
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return path.starts_with(prefix);
    }
    path.contains(pattern)
}
