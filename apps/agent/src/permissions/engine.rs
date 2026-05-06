use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use super::rules::matches_rule;
use super::types::*;

/// The permission engine — evaluates tool calls against the configured rules
/// using Claude Code's deny → ask → allow precedence.
pub struct PermissionEngine {
    config: RwLock<PermissionConfig>,
    mode: RwLock<PermissionMode>,
    /// Tools approved for this session ("yes, don't ask again").
    session_approvals: RwLock<HashSet<String>>,
    total_requests: AtomicUsize,
    total_allowed: AtomicUsize,
    total_denied: AtomicUsize,
    total_asked: AtomicUsize,
}

impl PermissionEngine {
    pub fn new(config: PermissionConfig) -> Self {
        let mode = config.default_mode;
        Self {
            config: RwLock::new(config),
            mode: RwLock::new(mode),
            session_approvals: RwLock::new(HashSet::new()),
            total_requests: AtomicUsize::new(0),
            total_allowed: AtomicUsize::new(0),
            total_denied: AtomicUsize::new(0),
            total_asked: AtomicUsize::new(0),
        }
    }

    pub fn with_default_config() -> Self {
        Self::new(PermissionConfig::default())
    }

    /// Evaluate a tool call against the permission system.
    ///
    /// Evaluation order (first match wins):
    /// 1. Deny rules (always checked first)
    /// 2. Mode-specific overrides (plan mode blocks writes, bypass mode allows all)
    /// 3. Session approvals ("yes, don't ask again")
    /// 4. Ask rules
    /// 5. Allow rules
    /// 6. Default behavior based on tool category
    pub async fn evaluate(&self, request: &PermissionRequest) -> PermissionVerdict {
        self.total_requests.fetch_add(1, Ordering::Relaxed);

        let config = self.config.read().await;
        let mode = *self.mode.read().await;

        if let Some(deny) = self.check_deny_rules(&config, request) {
            self.total_denied.fetch_add(1, Ordering::Relaxed);
            debug!(
                tool = %request.tool_name,
                input = %truncate(&request.tool_input, 100),
                "DENIED by rule"
            );
            return deny;
        }

        if let Some(verdict) = self.check_mode_override(mode, &config, request) {
            match &verdict {
                PermissionVerdict::Allow => self.total_allowed.fetch_add(1, Ordering::Relaxed),
                PermissionVerdict::Deny { .. } => self.total_denied.fetch_add(1, Ordering::Relaxed),
                PermissionVerdict::Ask { .. } => self.total_asked.fetch_add(1, Ordering::Relaxed),
            };
            return verdict;
        }

        if self.check_session_approval(request).await {
            self.total_allowed.fetch_add(1, Ordering::Relaxed);
            debug!(
                tool = %request.tool_name,
                "allowed by session approval"
            );
            return PermissionVerdict::Allow;
        }

        if self.check_ask_rules(&config, request) {
            self.total_asked.fetch_add(1, Ordering::Relaxed);
            return PermissionVerdict::Ask {
                reason: format!(
                    "Tool '{}' matches an ask rule",
                    request.tool_name
                ),
            };
        }

        if self.check_allow_rules(&config, request) {
            self.total_allowed.fetch_add(1, Ordering::Relaxed);
            debug!(
                tool = %request.tool_name,
                "allowed by allow rule"
            );
            return PermissionVerdict::Allow;
        }

        let verdict = self.default_verdict(mode, request);
        match &verdict {
            PermissionVerdict::Allow => self.total_allowed.fetch_add(1, Ordering::Relaxed),
            PermissionVerdict::Deny { .. } => self.total_denied.fetch_add(1, Ordering::Relaxed),
            PermissionVerdict::Ask { .. } => self.total_asked.fetch_add(1, Ordering::Relaxed),
        };
        verdict
    }

    fn check_deny_rules(
        &self,
        config: &PermissionConfig,
        request: &PermissionRequest,
    ) -> Option<PermissionVerdict> {
        for rule in &config.deny {
            if matches_rule(&rule.specifier, &request.tool_name, &request.tool_input) {
                return Some(PermissionVerdict::Deny {
                    reason: format!(
                        "Denied by rule '{}' (source: {:?})",
                        rule.specifier, rule.source
                    ),
                });
            }
        }
        None
    }

    fn check_mode_override(
        &self,
        mode: PermissionMode,
        config: &PermissionConfig,
        request: &PermissionRequest,
    ) -> Option<PermissionVerdict> {
        match mode {
            PermissionMode::Plan => {
                if request.category != ToolCategory::ReadOnly {
                    return Some(PermissionVerdict::Deny {
                        reason: "Plan mode: only read-only operations allowed".into(),
                    });
                }
            }
            PermissionMode::BypassPermissions => {
                if config.disable_bypass_mode {
                    return Some(PermissionVerdict::Deny {
                        reason: "Bypass mode disabled by policy".into(),
                    });
                }
                if self.is_protected_path(config, &request.tool_input) {
                    return Some(PermissionVerdict::Ask {
                        reason: format!(
                            "Protected directory: {}",
                            request.tool_input
                        ),
                    });
                }
                return Some(PermissionVerdict::Allow);
            }
            PermissionMode::AcceptEdits => {
                if request.category == ToolCategory::FileModification {
                    return Some(PermissionVerdict::Allow);
                }
            }
            PermissionMode::DontAsk => {
                return Some(PermissionVerdict::Deny {
                    reason: format!(
                        "DontAsk mode: '{}' not pre-approved",
                        request.tool_name
                    ),
                });
            }
            PermissionMode::Default | PermissionMode::Auto => {}
        }
        None
    }

    async fn check_session_approval(&self, request: &PermissionRequest) -> bool {
        let approvals = self.session_approvals.read().await;

        let exact_key = format!("{}:{}", request.tool_name, request.tool_input);
        if approvals.contains(&exact_key) {
            return true;
        }

        let tool_key = request.tool_name.clone();
        if approvals.contains(&tool_key) {
            return true;
        }

        false
    }

    fn check_ask_rules(
        &self,
        config: &PermissionConfig,
        request: &PermissionRequest,
    ) -> bool {
        config.ask.iter().any(|rule| {
            matches_rule(&rule.specifier, &request.tool_name, &request.tool_input)
        })
    }

    fn check_allow_rules(
        &self,
        config: &PermissionConfig,
        request: &PermissionRequest,
    ) -> bool {
        config.allow.iter().any(|rule| {
            matches_rule(&rule.specifier, &request.tool_name, &request.tool_input)
        })
    }

    fn default_verdict(
        &self,
        mode: PermissionMode,
        request: &PermissionRequest,
    ) -> PermissionVerdict {
        match request.category {
            ToolCategory::ReadOnly => PermissionVerdict::Allow,
            ToolCategory::FileModification => PermissionVerdict::Ask {
                reason: "File modification requires approval".into(),
            },
            ToolCategory::Bash => PermissionVerdict::Ask {
                reason: "Shell command requires approval".into(),
            },
            ToolCategory::WebFetch => PermissionVerdict::Ask {
                reason: "Web request requires approval".into(),
            },
            ToolCategory::Mcp => PermissionVerdict::Ask {
                reason: "MCP tool call requires approval".into(),
            },
            ToolCategory::Agent => PermissionVerdict::Ask {
                reason: "Agent spawning requires approval".into(),
            },
            ToolCategory::Other => PermissionVerdict::Ask {
                reason: format!(
                    "Tool '{}' requires approval",
                    request.tool_name
                ),
            },
        }
    }

    fn is_protected_path(&self, config: &PermissionConfig, path: &str) -> bool {
        let normalized = path.replace('\\', "/");
        let segments: Vec<&str> = normalized
            .trim_start_matches("./")
            .trim_start_matches('/')
            .split('/')
            .collect();

        config.protected_dirs.iter().any(|dir| {
            let dir_clean = dir.trim_start_matches("./").trim_start_matches('/');
            segments.first().map_or(false, |first| *first == dir_clean)
        })
    }

    // ──────────────────────────────────────────────────
    // Mutation methods
    // ──────────────────────────────────────────────────

    /// Record a session-level approval ("yes, don't ask again").
    pub async fn approve_session(&self, tool_name: &str, tool_input: Option<&str>) {
        let key = match tool_input {
            Some(input) => format!("{tool_name}:{input}"),
            None => tool_name.to_string(),
        };
        info!(key = %key, "session approval recorded");
        self.session_approvals.write().await.insert(key);
    }

    /// Add a rule dynamically.
    pub async fn add_rule(&self, category: &str, rule: PermissionRule) {
        let mut config = self.config.write().await;
        match category {
            "allow" => config.allow.push(rule),
            "ask" => config.ask.push(rule),
            "deny" => config.deny.push(rule),
            _ => warn!(category, "unknown rule category"),
        }
    }

    /// Change the permission mode.
    pub async fn set_mode(&self, mode: PermissionMode) {
        info!(mode = %mode, "permission mode changed");
        *self.mode.write().await = mode;
    }

    /// Get current permission mode.
    pub async fn current_mode(&self) -> PermissionMode {
        *self.mode.read().await
    }

    /// Clear session approvals (e.g. when starting a new task).
    pub async fn clear_session_approvals(&self) {
        self.session_approvals.write().await.clear();
    }

    /// Get statistics about the permission system.
    pub async fn stats(&self) -> PermissionStats {
        let config = self.config.read().await;
        let mode = self.mode.read().await;
        let approvals = self.session_approvals.read().await;

        PermissionStats {
            mode: mode.to_string(),
            allow_rules: config.allow.len(),
            ask_rules: config.ask.len(),
            deny_rules: config.deny.len(),
            session_approvals: approvals.len(),
            total_requests: self.total_requests.load(Ordering::Relaxed),
            total_allowed: self.total_allowed.load(Ordering::Relaxed),
            total_denied: self.total_denied.load(Ordering::Relaxed),
            total_asked: self.total_asked.load(Ordering::Relaxed),
        }
    }
}

fn truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        s
    } else {
        &s[..max_len]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_request(tool: &str, input: &str, category: ToolCategory) -> PermissionRequest {
        PermissionRequest {
            tool_name: tool.into(),
            tool_input: input.into(),
            category,
            agent_id: None,
        }
    }

    #[tokio::test]
    async fn test_read_only_always_allowed() {
        let engine = PermissionEngine::with_default_config();
        let req = make_request("Read", "src/main.rs", ToolCategory::ReadOnly);
        let verdict = engine.evaluate(&req).await;
        assert!(verdict.is_allowed());
    }

    #[tokio::test]
    async fn test_deny_takes_precedence() {
        let config = PermissionConfig {
            deny: vec![PermissionRule {
                specifier: "Bash(rm -rf *)".into(),
                source: RuleSource::Managed,
            }],
            allow: vec![PermissionRule {
                specifier: "Bash".into(),
                source: RuleSource::User,
            }],
            ..Default::default()
        };

        let engine = PermissionEngine::new(config);
        let req = make_request("Bash", "rm -rf /", ToolCategory::Bash);
        let verdict = engine.evaluate(&req).await;
        assert!(verdict.is_denied());
    }

    #[tokio::test]
    async fn test_plan_mode_blocks_writes() {
        let mut config = PermissionConfig::default();
        config.default_mode = PermissionMode::Plan;

        let engine = PermissionEngine::new(config);

        let read = make_request("Read", "file.txt", ToolCategory::ReadOnly);
        assert!(engine.evaluate(&read).await.is_allowed());

        let write = make_request("Edit", "file.txt", ToolCategory::FileModification);
        assert!(engine.evaluate(&write).await.is_denied());

        let bash = make_request("Bash", "ls", ToolCategory::Bash);
        assert!(engine.evaluate(&bash).await.is_denied());
    }

    #[tokio::test]
    async fn test_session_approval() {
        let engine = PermissionEngine::with_default_config();

        let req = make_request("Bash", "npm run build", ToolCategory::Bash);
        let verdict = engine.evaluate(&req).await;
        assert!(!verdict.is_allowed());

        engine.approve_session("Bash", Some("npm run build")).await;
        let verdict = engine.evaluate(&req).await;
        assert!(verdict.is_allowed());
    }

    #[tokio::test]
    async fn test_allow_rules() {
        let config = PermissionConfig {
            allow: vec![PermissionRule {
                specifier: "Bash(npm run *)".into(),
                source: RuleSource::User,
            }],
            ..Default::default()
        };

        let engine = PermissionEngine::new(config);

        let build = make_request("Bash", "npm run build", ToolCategory::Bash);
        assert!(engine.evaluate(&build).await.is_allowed());

        let install = make_request("Bash", "npm install", ToolCategory::Bash);
        assert!(!engine.evaluate(&install).await.is_allowed());
    }

    #[tokio::test]
    async fn test_bypass_mode_protected_dirs() {
        let mut config = PermissionConfig::default();
        config.default_mode = PermissionMode::BypassPermissions;

        let engine = PermissionEngine::new(config);

        let safe = make_request("Edit", "src/main.rs", ToolCategory::FileModification);
        assert!(engine.evaluate(&safe).await.is_allowed());

        let git = make_request("Edit", ".git/config", ToolCategory::FileModification);
        let verdict = engine.evaluate(&git).await;
        assert!(matches!(verdict, PermissionVerdict::Ask { .. }));
    }

    #[tokio::test]
    async fn test_stats() {
        let engine = PermissionEngine::with_default_config();

        let req = make_request("Read", "file.txt", ToolCategory::ReadOnly);
        engine.evaluate(&req).await;
        engine.evaluate(&req).await;

        let stats = engine.stats().await;
        assert_eq!(stats.total_requests, 2);
        assert_eq!(stats.total_allowed, 2);
    }
}
