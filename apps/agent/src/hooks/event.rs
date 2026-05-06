use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    SessionStart,
    SessionEnd,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    Notification,
    SubagentStart,
    SubagentStop,
    TaskCreated,
    TaskCompleted,
    Stop,
    StopFailure,
    TeammateIdle,
    PreCompact,
    PostCompact,
    CwdChanged,
    FileChanged,
    WorktreeCreate,
    WorktreeRemove,
    ConfigChange,
}

impl HookEvent {
    pub fn can_block(&self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PermissionRequest
                | Self::UserPromptSubmit
                | Self::Stop
                | Self::SubagentStop
                | Self::TeammateIdle
                | Self::TaskCreated
                | Self::TaskCompleted
                | Self::ConfigChange
                | Self::WorktreeCreate
        )
    }

    pub fn supports_matcher(&self) -> bool {
        !matches!(
            self,
            Self::UserPromptSubmit
                | Self::Stop
                | Self::TeammateIdle
                | Self::TaskCreated
                | Self::TaskCompleted
                | Self::WorktreeCreate
                | Self::WorktreeRemove
                | Self::CwdChanged
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookInput {
    pub session_id: String,
    pub cwd: String,
    pub hook_event_name: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(flatten)]
    pub event_data: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookOutput {
    #[serde(default = "default_true")]
    pub r#continue: bool,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub suppress_output: bool,
    #[serde(default)]
    pub system_message: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub hook_specific_output: Option<HookSpecificOutput>,
}

fn default_true() -> bool {
    true
}

impl Default for HookOutput {
    fn default() -> Self {
        Self {
            r#continue: true,
            stop_reason: None,
            suppress_output: false,
            system_message: None,
            decision: None,
            reason: None,
            hook_specific_output: None,
        }
    }
}

impl HookOutput {
    pub fn allow() -> Self {
        Self::default()
    }

    pub fn block(reason: impl Into<String>) -> Self {
        Self {
            decision: Some("block".into()),
            reason: Some(reason.into()),
            ..Default::default()
        }
    }

    pub fn deny_tool(reason: impl Into<String>) -> Self {
        Self {
            hook_specific_output: Some(HookSpecificOutput {
                hook_event_name: "PreToolUse".into(),
                permission_decision: Some("deny".into()),
                permission_decision_reason: Some(reason.into()),
                additional_context: None,
            }),
            ..Default::default()
        }
    }

    pub fn stop(reason: impl Into<String>) -> Self {
        Self {
            r#continue: false,
            stop_reason: Some(reason.into()),
            ..Default::default()
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.decision.as_deref() == Some("block")
            || self
                .hook_specific_output
                .as_ref()
                .is_some_and(|h| h.permission_decision.as_deref() == Some("deny"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookSpecificOutput {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: String,
    #[serde(rename = "permissionDecision")]
    #[serde(default)]
    pub permission_decision: Option<String>,
    #[serde(rename = "permissionDecisionReason")]
    #[serde(default)]
    pub permission_decision_reason: Option<String>,
    #[serde(rename = "additionalContext")]
    #[serde(default)]
    pub additional_context: Option<String>,
}
