use std::sync::Arc;
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};

use super::types::{
    HitlConfig, InteractionResponse, InteractionResult, InteractionStatus, InteractionType,
    PendingInteraction, Question,
};

/// The agent-side handle: call `wait()` to block until the user responds.
pub struct InteractionWaiter {
    rx: oneshot::Receiver<InteractionResponse>,
    interaction: PendingInteraction,
    timeout_duration: Duration,
}

impl InteractionWaiter {
    /// Block the agent until the user responds or timeout.
    /// This is the core "pause" mechanism — the agent's agentic loop calls this
    /// after registering the interaction, and the tokio task yields here.
    pub async fn wait(self) -> InteractionResult {
        match timeout(self.timeout_duration, self.rx).await {
            Ok(Ok(response)) => Self::resolve(self.interaction.interaction_type, response),
            Ok(Err(_)) => {
                // Sender was dropped (interaction cancelled)
                InteractionResult::Cancelled
            }
            Err(_) => {
                // Timeout elapsed
                InteractionResult::TimedOut
            }
        }
    }

    /// Get a reference to the pending interaction metadata.
    pub fn interaction(&self) -> &PendingInteraction {
        &self.interaction
    }

    fn resolve(
        interaction_type: InteractionType,
        response: InteractionResponse,
    ) -> InteractionResult {
        match interaction_type {
            InteractionType::Clarification | InteractionType::FreeInput => {
                InteractionResult::Answered {
                    answers: response.answers,
                }
            }
            InteractionType::ToolApproval | InteractionType::Confirmation => {
                if response.approved.unwrap_or(false) {
                    InteractionResult::Approved {
                        updated_input: response.updated_input,
                    }
                } else {
                    InteractionResult::Denied {
                        message: response
                            .message
                            .unwrap_or_else(|| "User denied".to_string()),
                    }
                }
            }
            InteractionType::PlanApproval => {
                if response.approved.unwrap_or(false) {
                    InteractionResult::PlanApproved
                } else {
                    InteractionResult::PlanRejected {
                        feedback: response.message,
                    }
                }
            }
        }
    }
}

/// The server-side handle: send a response to unblock the waiting agent.
pub struct InteractionResponder {
    tx: oneshot::Sender<InteractionResponse>,
}

impl InteractionResponder {
    /// Send the user's response, unblocking the agent.
    /// Returns Err if the agent has already moved on (dropped the receiver).
    pub fn respond(self, response: InteractionResponse) -> Result<(), InteractionResponse> {
        self.tx.send(response)
    }
}

/// Create a paired (waiter, responder) for one interaction.
///
/// The agent holds the `InteractionWaiter` and calls `wait()` to pause.
/// The API layer holds the `InteractionResponder` and calls `respond()` when the user answers.
pub fn create_interaction(
    interaction: PendingInteraction,
    config: &HitlConfig,
) -> (InteractionWaiter, InteractionResponder) {
    let (tx, rx) = oneshot::channel();

    let timeout_secs = interaction
        .expires_at
        .map(|e| {
            let remaining = e - chrono::Utc::now();
            remaining.num_seconds().max(1) as u64
        })
        .unwrap_or(config.default_timeout_secs);

    let waiter = InteractionWaiter {
        rx,
        interaction,
        timeout_duration: Duration::from_secs(timeout_secs),
    };

    let responder = InteractionResponder { tx };

    (waiter, responder)
}

/// Convenience: create a clarification interaction channel.
pub fn ask_questions(
    session_id: &str,
    agent_id: Option<&str>,
    questions: Vec<Question>,
    config: &HitlConfig,
) -> (InteractionWaiter, InteractionResponder, PendingInteraction) {
    let interaction = PendingInteraction::clarification(
        session_id,
        agent_id,
        questions.clone(),
        config.default_timeout_secs,
    );
    let snapshot = interaction.clone();
    let (waiter, responder) = create_interaction(interaction, config);
    (waiter, responder, snapshot)
}

/// Convenience: create a tool approval interaction channel.
pub fn ask_tool_approval(
    session_id: &str,
    agent_id: Option<&str>,
    tool_name: &str,
    tool_input: serde_json::Value,
    description: &str,
    config: &HitlConfig,
) -> (InteractionWaiter, InteractionResponder, PendingInteraction) {
    let interaction = PendingInteraction::tool_approval(
        session_id,
        agent_id,
        tool_name,
        tool_input,
        description,
        config.default_timeout_secs,
    );
    let snapshot = interaction.clone();
    let (waiter, responder) = create_interaction(interaction, config);
    (waiter, responder, snapshot)
}

/// Convenience: create a plan approval interaction channel.
pub fn ask_plan_approval(
    session_id: &str,
    plan: &str,
    config: &HitlConfig,
) -> (InteractionWaiter, InteractionResponder, PendingInteraction) {
    let interaction =
        PendingInteraction::plan_approval(session_id, plan, config.default_timeout_secs);
    let snapshot = interaction.clone();
    let (waiter, responder) = create_interaction(interaction, config);
    (waiter, responder, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_clarification_roundtrip() {
        let config = HitlConfig::default();
        let questions = vec![Question {
            question: "Which database?".to_string(),
            header: "Database".to_string(),
            multi_select: false,
            options: vec![
                super::super::types::QuestionOption {
                    label: "PostgreSQL".to_string(),
                    description: "Relational, battle-tested".to_string(),
                    preview: None,
                },
                super::super::types::QuestionOption {
                    label: "SQLite".to_string(),
                    description: "Embedded, zero-config".to_string(),
                    preview: None,
                },
            ],
        }];

        let (waiter, responder, snapshot) = ask_questions("s1", None, questions, &config);

        assert_eq!(snapshot.interaction_type, InteractionType::Clarification);
        assert_eq!(snapshot.status, InteractionStatus::Pending);

        // Simulate user responding in a separate task
        tokio::spawn(async move {
            let mut answers = HashMap::new();
            answers.insert("Which database?".to_string(), "PostgreSQL".to_string());
            responder
                .respond(InteractionResponse {
                    interaction_id: snapshot.id.clone(),
                    answers,
                    approved: None,
                    updated_input: None,
                    message: None,
                })
                .unwrap();
        });

        let result = waiter.wait().await;
        match result {
            InteractionResult::Answered { answers } => {
                assert_eq!(answers.get("Which database?").unwrap(), "PostgreSQL");
            }
            other => panic!("Expected Answered, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_tool_approval_approved() {
        let config = HitlConfig::default();
        let (waiter, responder, snapshot) = ask_tool_approval(
            "s1",
            None,
            "Bash",
            serde_json::json!({"command": "rm -rf /tmp/test"}),
            "Delete temp directory",
            &config,
        );

        tokio::spawn(async move {
            responder
                .respond(InteractionResponse {
                    interaction_id: snapshot.id.clone(),
                    answers: HashMap::new(),
                    approved: Some(true),
                    updated_input: None,
                    message: None,
                })
                .unwrap();
        });

        match waiter.wait().await {
            InteractionResult::Approved { updated_input } => {
                assert!(updated_input.is_none());
            }
            other => panic!("Expected Approved, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_tool_approval_denied() {
        let config = HitlConfig::default();
        let (waiter, responder, snapshot) = ask_tool_approval(
            "s1",
            None,
            "Bash",
            serde_json::json!({"command": "DROP DATABASE"}),
            "Drop database",
            &config,
        );

        tokio::spawn(async move {
            responder
                .respond(InteractionResponse {
                    interaction_id: snapshot.id.clone(),
                    answers: HashMap::new(),
                    approved: Some(false),
                    updated_input: None,
                    message: Some("Too dangerous".to_string()),
                })
                .unwrap();
        });

        match waiter.wait().await {
            InteractionResult::Denied { message } => {
                assert_eq!(message, "Too dangerous");
            }
            other => panic!("Expected Denied, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_timeout() {
        let config = HitlConfig {
            default_timeout_secs: 1,
            ..Default::default()
        };
        let (waiter, _responder, _snapshot) = ask_questions("s1", None, vec![], &config);

        // Don't respond — should time out
        let result = waiter.wait().await;
        assert!(matches!(result, InteractionResult::TimedOut));
    }

    #[tokio::test]
    async fn test_cancelled_when_responder_dropped() {
        let config = HitlConfig::default();
        let (waiter, responder, _snapshot) = ask_questions("s1", None, vec![], &config);

        // Drop the responder without responding
        drop(responder);

        let result = waiter.wait().await;
        assert!(matches!(result, InteractionResult::Cancelled));
    }

    #[tokio::test]
    async fn test_plan_approval() {
        let config = HitlConfig::default();
        let (waiter, responder, snapshot) = ask_plan_approval(
            "s1",
            "1. Add auth module\n2. Create login page\n3. Add JWT middleware",
            &config,
        );

        tokio::spawn(async move {
            responder
                .respond(InteractionResponse {
                    interaction_id: snapshot.id.clone(),
                    answers: HashMap::new(),
                    approved: Some(true),
                    updated_input: None,
                    message: None,
                })
                .unwrap();
        });

        match waiter.wait().await {
            InteractionResult::PlanApproved => {}
            other => panic!("Expected PlanApproved, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_plan_rejected_with_feedback() {
        let config = HitlConfig::default();
        let (waiter, responder, snapshot) = ask_plan_approval("s1", "Delete everything", &config);

        tokio::spawn(async move {
            responder
                .respond(InteractionResponse {
                    interaction_id: snapshot.id.clone(),
                    answers: HashMap::new(),
                    approved: Some(false),
                    updated_input: None,
                    message: Some("Too aggressive, try incremental".to_string()),
                })
                .unwrap();
        });

        match waiter.wait().await {
            InteractionResult::PlanRejected { feedback } => {
                assert_eq!(feedback.unwrap(), "Too aggressive, try incremental");
            }
            other => panic!("Expected PlanRejected, got {:?}", other),
        }
    }
}
