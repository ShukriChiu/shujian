use serde::{Deserialize, Serialize};

/// Permission mode controlling how tool calls are authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Standard: prompts for permission on first use of each tool.
    #[default]
    Default,
    /// Auto-accepts file edit permissions for the session.
    AcceptEdits,
    /// Read-only: cannot modify files or execute commands.
    Plan,
    /// Background classifier auto-approves safe actions.
    Auto,
    /// Auto-denies tools unless pre-approved via rules.
    DontAsk,
    /// Skips all permission prompts (isolated environments only).
    BypassPermissions,
}

impl std::fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Default => write!(f, "default"),
            Self::AcceptEdits => write!(f, "acceptEdits"),
            Self::Plan => write!(f, "plan"),
            Self::Auto => write!(f, "auto"),
            Self::DontAsk => write!(f, "dontAsk"),
            Self::BypassPermissions => write!(f, "bypassPermissions"),
        }
    }
}

/// Permission verdict for a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionVerdict {
    /// Tool call is allowed without prompting.
    Allow,
    /// Tool call requires user confirmation.
    Ask { reason: String },
    /// Tool call is denied.
    Deny { reason: String },
}

impl PermissionVerdict {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }

    pub fn is_denied(&self) -> bool {
        matches!(self, Self::Deny { .. })
    }
}

/// Category of a tool for permission purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    /// Read-only operations (file read, grep, glob): no approval needed.
    ReadOnly,
    /// File modifications (edit, write): approval per session.
    FileModification,
    /// Shell command execution: approval per project.
    Bash,
    /// Web requests.
    WebFetch,
    /// MCP tool calls.
    Mcp,
    /// Agent/subagent spawning.
    Agent,
    /// Other tools.
    Other,
}

/// A permission rule entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    /// The tool specifier pattern (e.g. "Bash(npm run *)", "Read(./.env)", "Edit").
    pub specifier: String,
    /// Where the rule comes from.
    pub source: RuleSource,
}

/// Source of a permission rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSource {
    /// Managed enterprise policy — cannot be overridden.
    Managed,
    /// CLI arguments (temporary session overrides).
    Cli,
    /// Local project settings (.claude/settings.local.json).
    LocalProject,
    /// Shared project settings (.claude/settings.json).
    SharedProject,
    /// User home settings (~/.claude/settings.json).
    User,
    /// Session-level approval ("yes, don't ask again").
    SessionApproval,
    /// PreToolUse hook verdict.
    Hook,
}

/// Full permission configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionConfig {
    /// Rules for tools that should be allowed without prompting.
    #[serde(default)]
    pub allow: Vec<PermissionRule>,
    /// Rules for tools that should always prompt for confirmation.
    #[serde(default)]
    pub ask: Vec<PermissionRule>,
    /// Rules for tools that should always be denied.
    #[serde(default)]
    pub deny: Vec<PermissionRule>,
    /// Default permission mode.
    #[serde(default = "default_mode")]
    pub default_mode: PermissionMode,
    /// Protected directories that always prompt even in bypass mode.
    #[serde(default = "default_protected_dirs")]
    pub protected_dirs: Vec<String>,
    /// Whether bypass mode is disabled by policy.
    #[serde(default)]
    pub disable_bypass_mode: bool,
    /// Whether auto mode is disabled by policy.
    #[serde(default)]
    pub disable_auto_mode: bool,
}

impl Default for PermissionConfig {
    fn default() -> Self {
        Self {
            allow: Vec::new(),
            ask: Vec::new(),
            deny: Vec::new(),
            default_mode: PermissionMode::Default,
            protected_dirs: vec![
                ".git".into(),
                ".claude".into(),
                ".vscode".into(),
                ".idea".into(),
            ],
            disable_bypass_mode: false,
            disable_auto_mode: false,
        }
    }
}

fn default_mode() -> PermissionMode {
    PermissionMode::Default
}

fn default_protected_dirs() -> Vec<String> {
    vec![
        ".git".into(),
        ".claude".into(),
        ".vscode".into(),
        ".idea".into(),
    ]
}

/// Request to evaluate permissions for a tool call.
#[derive(Debug, Clone)]
pub struct PermissionRequest {
    /// Tool name (e.g. "Bash", "Read", "Edit", "WebFetch").
    pub tool_name: String,
    /// Tool-specific input (e.g. the bash command, file path, URL).
    pub tool_input: String,
    /// Category of the tool.
    pub category: ToolCategory,
    /// The agent requesting permission.
    pub agent_id: Option<String>,
}

/// Statistics about the permission system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionStats {
    pub mode: String,
    pub allow_rules: usize,
    pub ask_rules: usize,
    pub deny_rules: usize,
    pub session_approvals: usize,
    pub total_requests: usize,
    pub total_allowed: usize,
    pub total_denied: usize,
    pub total_asked: usize,
}
