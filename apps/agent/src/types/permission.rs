use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum PermissionMode {
    #[default]
    Default,
    Plan,
    AcceptEdits,
    Auto,
    Supervised,
}

impl PermissionMode {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Default => "Default",
            Self::Plan => "Plan (Read-Only)",
            Self::AcceptEdits => "Accept Edits",
            Self::Auto => "Auto",
            Self::Supervised => "Supervised",
        }
    }

    pub fn is_read_only(&self) -> bool {
        matches!(self, Self::Plan)
    }

    pub fn auto_approve_all(&self) -> bool {
        matches!(self, Self::Auto)
    }

    pub fn requires_approval_for_all(&self) -> bool {
        matches!(self, Self::Supervised)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionBehavior {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSource {
    UserConfig,
    ProjectConfig,
    AgentDef,
    Session,
    Cli,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub source: RuleSource,
    pub behavior: PermissionBehavior,
    pub tool_name: String,
    #[serde(default)]
    pub pattern: Option<String>,
}

impl PermissionRule {
    pub fn matches_tool(&self, tool_name: &str) -> bool {
        if self.tool_name == "*" {
            return true;
        }
        if self.tool_name.ends_with('*') {
            let prefix = &self.tool_name[..self.tool_name.len() - 1];
            return tool_name.starts_with(prefix);
        }
        self.tool_name == tool_name
    }

    pub fn matches_args(&self, args_str: &str) -> bool {
        match &self.pattern {
            None => true,
            Some(pat) => {
                if pat.ends_with('*') {
                    let prefix = &pat[..pat.len() - 1];
                    args_str.starts_with(prefix)
                } else {
                    args_str.contains(pat.as_str())
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PermissionDecision {
    Allow {
        reason: String,
    },
    Deny {
        message: String,
        reason: String,
    },
    Ask {
        request_id: String,
        message: String,
        tool_name: String,
        input_summary: String,
    },
}

impl PermissionDecision {
    pub fn is_allow(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionContext {
    pub mode: PermissionMode,
    pub rules: Vec<PermissionRule>,
}

impl Default for PermissionContext {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Default,
            rules: Vec::new(),
        }
    }
}

impl PermissionContext {
    pub fn check(&self, tool_name: &str, args_str: &str, is_read_only: bool) -> PermissionBehavior {
        if self.mode.auto_approve_all() {
            return PermissionBehavior::Allow;
        }
        if self.mode.is_read_only() && !is_read_only {
            return PermissionBehavior::Deny;
        }

        let mut result = if self.mode.requires_approval_for_all() {
            PermissionBehavior::Ask
        } else {
            PermissionBehavior::Allow
        };

        for rule in &self.rules {
            if rule.matches_tool(tool_name) && rule.matches_args(args_str) {
                result = rule.behavior;
            }
        }

        result
    }
}
