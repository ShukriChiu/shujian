use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::event::HookEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookHandlerType {
    Command,
    Http,
    Prompt,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookHandler {
    #[serde(rename = "type")]
    pub handler_type: HookHandlerType,

    #[serde(default)]
    pub command: Option<String>,

    #[serde(default)]
    pub url: Option<String>,

    #[serde(default)]
    pub prompt: Option<String>,

    #[serde(default)]
    pub model: Option<String>,

    #[serde(default)]
    pub r#if: Option<String>,

    #[serde(default = "default_timeout")]
    pub timeout: u64,

    #[serde(default)]
    pub status_message: Option<String>,

    #[serde(default)]
    pub r#async: bool,

    #[serde(default)]
    pub once: bool,

    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

fn default_timeout() -> u64 {
    600
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMatcherGroup {
    #[serde(default)]
    pub matcher: Option<String>,
    pub hooks: Vec<HookHandler>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookSource {
    UserConfig,
    ProjectConfig,
    LocalConfig,
    Plugin,
    Skill,
    AgentDef,
    BuiltIn,
    Session,
}

#[derive(Debug, Clone)]
pub struct RegisteredHook {
    pub event: HookEvent,
    pub group: HookMatcherGroup,
    pub source: HookSource,
}

#[derive(Debug, Default)]
pub struct HookRegistry {
    hooks: Vec<RegisteredHook>,
    disabled: bool,
}

impl HookRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, event: HookEvent, group: HookMatcherGroup, source: HookSource) {
        self.hooks.push(RegisteredHook {
            event,
            group,
            source,
        });
    }

    pub fn register_from_config(&mut self, config: &HooksConfig, source: HookSource) {
        for (event_name, groups) in &config.hooks {
            if let Some(event) = parse_event_name(event_name) {
                for group in groups {
                    self.register(event, group.clone(), source);
                }
            }
        }
    }

    pub fn set_disabled(&mut self, disabled: bool) {
        self.disabled = disabled;
    }

    pub fn find_matching(
        &self,
        event: HookEvent,
        matcher_value: Option<&str>,
    ) -> Vec<&RegisteredHook> {
        if self.disabled {
            return Vec::new();
        }

        self.hooks
            .iter()
            .filter(|h| {
                if h.event != event {
                    return false;
                }

                match (&h.group.matcher, matcher_value) {
                    (None, _) => true,
                    (Some(m), _) if m == "*" || m.is_empty() => true,
                    (Some(m), Some(val)) => matches_regex_simple(m, val),
                    (Some(_), None) => !event.supports_matcher(),
                }
            })
            .collect()
    }

    pub fn count_for_event(&self, event: HookEvent) -> usize {
        self.hooks.iter().filter(|h| h.event == event).count()
    }

    pub fn count(&self) -> usize {
        self.hooks.len()
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    pub fn all_events_with_counts(&self) -> Vec<(HookEvent, usize)> {
        let mut map: HashMap<HookEvent, usize> = HashMap::new();
        for h in &self.hooks {
            *map.entry(h.event).or_default() += 1;
        }
        let mut result: Vec<_> = map.into_iter().collect();
        result.sort_by_key(|(e, _)| format!("{:?}", e));
        result
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksConfig {
    #[serde(default)]
    pub hooks: HashMap<String, Vec<HookMatcherGroup>>,
    #[serde(default)]
    pub disable_all_hooks: bool,
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            hooks: HashMap::new(),
            disable_all_hooks: false,
        }
    }
}

fn parse_event_name(name: &str) -> Option<HookEvent> {
    match name {
        "SessionStart" => Some(HookEvent::SessionStart),
        "SessionEnd" => Some(HookEvent::SessionEnd),
        "UserPromptSubmit" => Some(HookEvent::UserPromptSubmit),
        "PreToolUse" => Some(HookEvent::PreToolUse),
        "PostToolUse" => Some(HookEvent::PostToolUse),
        "PostToolUseFailure" => Some(HookEvent::PostToolUseFailure),
        "PermissionRequest" => Some(HookEvent::PermissionRequest),
        "Notification" => Some(HookEvent::Notification),
        "SubagentStart" => Some(HookEvent::SubagentStart),
        "SubagentStop" => Some(HookEvent::SubagentStop),
        "TaskCreated" => Some(HookEvent::TaskCreated),
        "TaskCompleted" => Some(HookEvent::TaskCompleted),
        "Stop" => Some(HookEvent::Stop),
        "StopFailure" => Some(HookEvent::StopFailure),
        "TeammateIdle" => Some(HookEvent::TeammateIdle),
        "PreCompact" => Some(HookEvent::PreCompact),
        "PostCompact" => Some(HookEvent::PostCompact),
        "CwdChanged" => Some(HookEvent::CwdChanged),
        "FileChanged" => Some(HookEvent::FileChanged),
        "WorktreeCreate" => Some(HookEvent::WorktreeCreate),
        "WorktreeRemove" => Some(HookEvent::WorktreeRemove),
        "ConfigChange" => Some(HookEvent::ConfigChange),
        _ => None,
    }
}

fn matches_regex_simple(pattern: &str, value: &str) -> bool {
    if pattern.contains('|') {
        return pattern.split('|').any(|p| matches_regex_simple(p.trim(), value));
    }
    if pattern.ends_with(".*") {
        let prefix = &pattern[..pattern.len() - 2];
        return value.starts_with(prefix);
    }
    if pattern.ends_with('*') {
        let prefix = &pattern[..pattern.len() - 1];
        return value.starts_with(prefix);
    }
    pattern == value
}
