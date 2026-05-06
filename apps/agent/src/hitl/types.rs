use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// A structured question that the agent presents to the user.
/// Mirrors Claude Code's AskUserQuestion tool schema exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    /// The complete question text. Should be clear, specific, end with "?".
    pub question: String,
    /// Very short label displayed as a chip/tag (max 12 chars).
    /// Examples: "Auth method", "Library", "Approach"
    pub header: String,
    /// Whether the user can select multiple options (non-mutually-exclusive).
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
    /// Available choices (2-4 options). An "Other" option is added automatically.
    pub options: Vec<QuestionOption>,
}

/// A single choice within a question.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Display text (1-5 words, concise).
    pub label: String,
    /// Explanation of what this option means or what will happen.
    pub description: String,
    /// Optional HTML/markdown preview for visual comparison (layout choices, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// The type of human-in-the-loop interaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionType {
    /// Agent needs to clarify ambiguous user intent (AskUserQuestion tool).
    Clarification,
    /// Agent needs permission to execute a tool (PermissionVerdict::Ask).
    ToolApproval,
    /// Agent needs confirmation before a destructive operation.
    Confirmation,
    /// Agent needs free-form input from the user.
    FreeInput,
    /// Plan mode: agent presents a plan for approval before executing.
    PlanApproval,
}

/// A pending interaction waiting for user response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingInteraction {
    /// Unique identifier for this interaction.
    pub id: String,
    /// What kind of interaction this is.
    pub interaction_type: InteractionType,
    /// The session that spawned this interaction.
    pub session_id: String,
    /// The agent that is waiting (None = main agent).
    pub agent_id: Option<String>,
    /// When this interaction was created.
    pub created_at: DateTime<Utc>,
    /// When this interaction will time out (None = no timeout).
    pub expires_at: Option<DateTime<Utc>>,
    /// The structured questions (for Clarification type).
    pub questions: Vec<Question>,
    /// Context about what triggered this interaction.
    pub context: InteractionContext,
    /// Current status.
    pub status: InteractionStatus,
}

/// Additional context about why the interaction was triggered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionContext {
    /// The tool that triggered this (if ToolApproval).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// The tool input (if ToolApproval).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    /// A human-readable summary of what the agent is trying to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The plan text (if PlanApproval).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Permission suggestions the agent recommends (allow-list updates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<String>>,
}

impl Default for InteractionContext {
    fn default() -> Self {
        Self {
            tool_name: None,
            tool_input: None,
            description: None,
            plan: None,
            suggestions: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    /// Waiting for user response.
    Pending,
    /// User has responded.
    Answered,
    /// Timed out without response.
    TimedOut,
    /// Cancelled by the agent or system.
    Cancelled,
}

/// The user's response to a pending interaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionResponse {
    /// The interaction ID being responded to.
    pub interaction_id: String,
    /// For Clarification: mapping of question text → selected option label(s).
    /// For multi-select, labels joined with ", ".
    #[serde(default)]
    pub answers: HashMap<String, String>,
    /// For ToolApproval: allow or deny.
    #[serde(default)]
    pub approved: Option<bool>,
    /// For ToolApproval with modifications: updated tool input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<serde_json::Value>,
    /// Optional message from the user (for deny with reason, or free input).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The resolved result after a user responds (or timeout occurs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InteractionResult {
    /// User answered clarifying questions.
    Answered {
        answers: HashMap<String, String>,
    },
    /// User approved a tool execution.
    Approved {
        updated_input: Option<serde_json::Value>,
    },
    /// User denied a tool execution.
    Denied {
        message: String,
    },
    /// User approved a plan.
    PlanApproved,
    /// User rejected a plan (with optional feedback).
    PlanRejected {
        feedback: Option<String>,
    },
    /// Interaction timed out.
    TimedOut,
    /// Interaction was cancelled.
    Cancelled,
}

/// Configuration for the HITL system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HitlConfig {
    /// Default timeout for interactions in seconds (60 = Claude Code default).
    pub default_timeout_secs: u64,
    /// Maximum number of questions per AskUserQuestion call (Claude Code: 4).
    pub max_questions: usize,
    /// Maximum number of options per question (Claude Code: 4).
    pub max_options: usize,
    /// Whether to automatically add an "Other" free-text option.
    pub auto_add_other: bool,
    /// Whether sub-agents are allowed to ask questions (Claude Code: false).
    pub allow_subagent_questions: bool,
    /// Maximum concurrent pending interactions.
    pub max_pending: usize,
}

impl Default for HitlConfig {
    fn default() -> Self {
        Self {
            default_timeout_secs: 60,
            max_questions: 4,
            max_options: 4,
            auto_add_other: true,
            allow_subagent_questions: false,
            max_pending: 10,
        }
    }
}

impl PendingInteraction {
    /// Create a new clarification interaction (AskUserQuestion).
    pub fn clarification(
        session_id: &str,
        agent_id: Option<&str>,
        questions: Vec<Question>,
        timeout_secs: u64,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            interaction_type: InteractionType::Clarification,
            session_id: session_id.to_string(),
            agent_id: agent_id.map(String::from),
            created_at: now,
            expires_at: Some(now + chrono::Duration::seconds(timeout_secs as i64)),
            questions,
            context: InteractionContext::default(),
            status: InteractionStatus::Pending,
        }
    }

    /// Create a tool approval interaction.
    pub fn tool_approval(
        session_id: &str,
        agent_id: Option<&str>,
        tool_name: &str,
        tool_input: serde_json::Value,
        description: &str,
        timeout_secs: u64,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            interaction_type: InteractionType::ToolApproval,
            session_id: session_id.to_string(),
            agent_id: agent_id.map(String::from),
            created_at: now,
            expires_at: Some(now + chrono::Duration::seconds(timeout_secs as i64)),
            questions: vec![],
            context: InteractionContext {
                tool_name: Some(tool_name.to_string()),
                tool_input: Some(tool_input),
                description: Some(description.to_string()),
                ..Default::default()
            },
            status: InteractionStatus::Pending,
        }
    }

    /// Create a plan approval interaction.
    pub fn plan_approval(
        session_id: &str,
        plan: &str,
        timeout_secs: u64,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            interaction_type: InteractionType::PlanApproval,
            session_id: session_id.to_string(),
            agent_id: None,
            created_at: now,
            expires_at: Some(now + chrono::Duration::seconds(timeout_secs as i64)),
            questions: vec![],
            context: InteractionContext {
                plan: Some(plan.to_string()),
                description: Some("Review and approve the implementation plan".to_string()),
                ..Default::default()
            },
            status: InteractionStatus::Pending,
        }
    }

    /// Check if this interaction has expired.
    pub fn is_expired(&self) -> bool {
        if let Some(expires_at) = self.expires_at {
            Utc::now() > expires_at
        } else {
            false
        }
    }

    /// Remaining time in seconds (None if no timeout).
    pub fn remaining_secs(&self) -> Option<i64> {
        self.expires_at.map(|e| {
            let remaining = e - Utc::now();
            remaining.num_seconds().max(0)
        })
    }
}

/// Builder for constructing AskUserQuestion calls fluently.
pub struct QuestionBuilder {
    questions: Vec<Question>,
}

impl QuestionBuilder {
    pub fn new() -> Self {
        Self {
            questions: Vec::new(),
        }
    }

    /// Add a single-select question.
    pub fn ask(mut self, header: &str, question: &str, options: Vec<(&str, &str)>) -> Self {
        self.questions.push(Question {
            question: question.to_string(),
            header: header.to_string(),
            multi_select: false,
            options: options
                .into_iter()
                .map(|(label, desc)| QuestionOption {
                    label: label.to_string(),
                    description: desc.to_string(),
                    preview: None,
                })
                .collect(),
        });
        self
    }

    /// Add a multi-select question.
    pub fn ask_multi(mut self, header: &str, question: &str, options: Vec<(&str, &str)>) -> Self {
        self.questions.push(Question {
            question: question.to_string(),
            header: header.to_string(),
            multi_select: true,
            options: options
                .into_iter()
                .map(|(label, desc)| QuestionOption {
                    label: label.to_string(),
                    description: desc.to_string(),
                    preview: None,
                })
                .collect(),
        });
        self
    }

    pub fn build(self) -> Vec<Question> {
        self.questions
    }
}

impl Default for QuestionBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_question_builder() {
        let questions = QuestionBuilder::new()
            .ask(
                "Framework",
                "Which framework should we use?",
                vec![
                    ("React Native", "Cross-platform, one codebase"),
                    ("Flutter", "High performance, Google ecosystem"),
                    ("Swift/Kotlin", "Native performance, per-platform"),
                ],
            )
            .ask_multi(
                "Features",
                "Which features do you want to enable?",
                vec![
                    ("Auth", "User authentication system"),
                    ("Push", "Push notifications"),
                    ("Analytics", "Usage tracking and analytics"),
                ],
            )
            .build();

        assert_eq!(questions.len(), 2);
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options.len(), 3);
        assert!(questions[1].multi_select);
    }

    #[test]
    fn test_pending_interaction_expiry() {
        let interaction = PendingInteraction::clarification(
            "session-1",
            None,
            vec![],
            0, // 0 second timeout = already expired
        );
        // With 0 timeout, it should be expired or just about to expire
        // Give a tiny buffer for test execution
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(interaction.is_expired());
    }

    #[test]
    fn test_tool_approval_context() {
        let interaction = PendingInteraction::tool_approval(
            "s1",
            Some("agent-1"),
            "Bash",
            serde_json::json!({"command": "rm -rf /tmp/test"}),
            "Delete temporary test directory",
            60,
        );

        assert_eq!(interaction.interaction_type, InteractionType::ToolApproval);
        assert_eq!(interaction.context.tool_name.as_deref(), Some("Bash"));
        assert!(!interaction.is_expired());
        assert!(interaction.remaining_secs().unwrap() > 50);
    }
}
