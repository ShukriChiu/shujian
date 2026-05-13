use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

use super::channel::{self, InteractionResponder, InteractionWaiter};
use super::types::*;
use crate::streaming::events::{StreamEvent, StreamEventType};
use crate::streaming::sse::SseBroadcaster;

/// Manages all pending HITL interactions.
///
/// This is the central coordinator between:
/// - Agent runtime (creates interactions via `ask_*` methods)
/// - SSE broadcaster (pushes interaction events to connected clients)
/// - REST API (receives user responses and routes them to the correct responder)
pub struct HitlManager {
    config: HitlConfig,
    /// Active responders indexed by interaction ID.
    responders: RwLock<HashMap<String, InteractionResponder>>,
    /// Snapshots of all pending interactions (for API listing).
    pending: RwLock<HashMap<String, PendingInteraction>>,
    /// SSE broadcaster for pushing interaction events to clients.
    broadcaster: Arc<SseBroadcaster>,
    /// History of resolved interactions (capped).
    history: RwLock<Vec<PendingInteraction>>,
}

impl HitlManager {
    pub fn new(config: HitlConfig, broadcaster: Arc<SseBroadcaster>) -> Self {
        Self {
            config,
            responders: RwLock::new(HashMap::new()),
            pending: RwLock::new(HashMap::new()),
            broadcaster,
            history: RwLock::new(Vec::new()),
        }
    }

    /// Create a clarification interaction (AskUserQuestion).
    ///
    /// Returns an `InteractionWaiter` that the agent should `.wait()` on.
    /// The interaction is registered internally and pushed via SSE.
    pub async fn ask_clarification(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        questions: Vec<Question>,
    ) -> Result<InteractionWaiter, HitlError> {
        // Enforce subagent restriction
        if agent_id.is_some() && !self.config.allow_subagent_questions {
            return Err(HitlError::SubagentNotAllowed);
        }

        // Enforce question limits
        if questions.len() > self.config.max_questions {
            return Err(HitlError::TooManyQuestions {
                max: self.config.max_questions,
                got: questions.len(),
            });
        }

        for q in &questions {
            if q.options.len() > self.config.max_options {
                return Err(HitlError::TooManyOptions {
                    question: q.header.clone(),
                    max: self.config.max_options,
                    got: q.options.len(),
                });
            }
        }

        // Check pending count
        let pending_count = self.pending.read().await.len();
        if pending_count >= self.config.max_pending {
            return Err(HitlError::TooManyPending {
                max: self.config.max_pending,
            });
        }

        let (waiter, responder, snapshot) =
            channel::ask_questions(session_id, agent_id, questions, &self.config);

        let interaction_id = snapshot.id.clone();

        // Register
        self.responders
            .write()
            .await
            .insert(interaction_id.clone(), responder);
        self.pending
            .write()
            .await
            .insert(interaction_id.clone(), snapshot.clone());

        // Broadcast via SSE
        self.broadcast_interaction(&snapshot).await;

        info!(
            interaction_id = %interaction_id,
            session_id = %session_id,
            questions = snapshot.questions.len(),
            "HITL clarification interaction created"
        );

        Ok(waiter)
    }

    /// Create a tool approval interaction.
    pub async fn ask_tool_approval(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        tool_name: &str,
        tool_input: serde_json::Value,
        description: &str,
    ) -> Result<InteractionWaiter, HitlError> {
        let pending_count = self.pending.read().await.len();
        if pending_count >= self.config.max_pending {
            return Err(HitlError::TooManyPending {
                max: self.config.max_pending,
            });
        }

        let (waiter, responder, snapshot) = channel::ask_tool_approval(
            session_id,
            agent_id,
            tool_name,
            tool_input,
            description,
            &self.config,
        );

        let interaction_id = snapshot.id.clone();
        self.responders
            .write()
            .await
            .insert(interaction_id.clone(), responder);
        self.pending
            .write()
            .await
            .insert(interaction_id.clone(), snapshot.clone());

        self.broadcast_interaction(&snapshot).await;

        info!(
            interaction_id = %interaction_id,
            tool = %tool_name,
            "HITL tool approval interaction created"
        );

        Ok(waiter)
    }

    /// Create a plan approval interaction.
    pub async fn ask_plan_approval(
        &self,
        session_id: &str,
        plan: &str,
    ) -> Result<InteractionWaiter, HitlError> {
        let pending_count = self.pending.read().await.len();
        if pending_count >= self.config.max_pending {
            return Err(HitlError::TooManyPending {
                max: self.config.max_pending,
            });
        }

        let (waiter, responder, snapshot) =
            channel::ask_plan_approval(session_id, plan, &self.config);

        let interaction_id = snapshot.id.clone();
        self.responders
            .write()
            .await
            .insert(interaction_id.clone(), responder);
        self.pending
            .write()
            .await
            .insert(interaction_id.clone(), snapshot.clone());

        self.broadcast_interaction(&snapshot).await;

        info!(
            interaction_id = %interaction_id,
            "HITL plan approval interaction created"
        );

        Ok(waiter)
    }

    /// Submit a user response to a pending interaction.
    ///
    /// Called by the REST API when the user answers.
    pub async fn respond(&self, response: InteractionResponse) -> Result<(), HitlError> {
        let interaction_id = response.interaction_id.clone();

        // Remove from pending and responders
        let responder = self.responders.write().await.remove(&interaction_id);
        let mut interaction = self.pending.write().await.remove(&interaction_id);

        let responder = responder.ok_or_else(|| HitlError::NotFound {
            id: interaction_id.clone(),
        })?;

        // Check if expired
        if let Some(ref i) = interaction {
            if i.is_expired() {
                warn!(interaction_id = %interaction_id, "Attempted to respond to expired interaction");
                return Err(HitlError::Expired {
                    id: interaction_id.clone(),
                });
            }
        }

        // Send response to unblock the agent
        if let Err(_response) = responder.respond(response) {
            warn!(interaction_id = %interaction_id, "Agent already moved on (receiver dropped)");
            return Err(HitlError::AgentGone {
                id: interaction_id.clone(),
            });
        }

        // Update status and archive
        if let Some(ref mut i) = interaction {
            i.status = InteractionStatus::Answered;
            self.archive(i.clone()).await;

            // Broadcast resolution
            self.broadcast_resolved(i).await;
        }

        info!(interaction_id = %interaction_id, "HITL interaction answered");
        Ok(())
    }

    /// Cancel a pending interaction.
    pub async fn cancel(&self, interaction_id: &str) -> Result<(), HitlError> {
        let responder = self.responders.write().await.remove(interaction_id);
        let mut interaction = self.pending.write().await.remove(interaction_id);

        if responder.is_none() {
            return Err(HitlError::NotFound {
                id: interaction_id.to_string(),
            });
        }

        // Drop the responder — this causes the waiter to receive `Cancelled`
        drop(responder);

        if let Some(ref mut i) = interaction {
            i.status = InteractionStatus::Cancelled;
            self.archive(i.clone()).await;
        }

        info!(interaction_id = %interaction_id, "HITL interaction cancelled");
        Ok(())
    }

    /// List all pending interactions.
    pub async fn list_pending(&self) -> Vec<PendingInteraction> {
        let pending = self.pending.read().await;
        let mut result: Vec<_> = pending.values().cloned().collect();

        // Clean up expired ones
        let expired_ids: Vec<String> = result
            .iter()
            .filter(|i| i.is_expired())
            .map(|i| i.id.clone())
            .collect();

        drop(pending);

        for id in &expired_ids {
            let _ = self.cancel(id).await;
        }

        // Re-read after cleanup
        result = self.pending.read().await.values().cloned().collect();
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        result
    }

    /// List pending interactions for a specific session.
    pub async fn list_pending_for_session(&self, session_id: &str) -> Vec<PendingInteraction> {
        self.list_pending()
            .await
            .into_iter()
            .filter(|i| i.session_id == session_id)
            .collect()
    }

    /// Get a specific pending interaction.
    pub async fn get_pending(&self, interaction_id: &str) -> Option<PendingInteraction> {
        self.pending.read().await.get(interaction_id).cloned()
    }

    /// Get recent interaction history.
    pub async fn history(&self, limit: usize) -> Vec<PendingInteraction> {
        let history = self.history.read().await;
        history.iter().rev().take(limit).cloned().collect()
    }

    /// Get statistics about the HITL system.
    pub async fn stats(&self) -> HitlStats {
        let pending = self.pending.read().await;
        let history = self.history.read().await;

        let answered = history
            .iter()
            .filter(|i| i.status == InteractionStatus::Answered)
            .count();
        let timed_out = history
            .iter()
            .filter(|i| i.status == InteractionStatus::TimedOut)
            .count();
        let cancelled = history
            .iter()
            .filter(|i| i.status == InteractionStatus::Cancelled)
            .count();

        HitlStats {
            pending_count: pending.len(),
            total_answered: answered,
            total_timed_out: timed_out,
            total_cancelled: cancelled,
            config: self.config.clone(),
        }
    }

    /// Broadcast a new pending interaction via SSE.
    async fn broadcast_interaction(&self, interaction: &PendingInteraction) {
        let event = StreamEvent::new(
            StreamEventType::Custom("hitl_question".to_string()),
            serde_json::to_value(interaction).unwrap_or_default(),
        );
        self.broadcaster.broadcast(event);
    }

    /// Broadcast that an interaction was resolved.
    async fn broadcast_resolved(&self, interaction: &PendingInteraction) {
        let event = StreamEvent::new(
            StreamEventType::Custom("hitl_resolved".to_string()),
            serde_json::json!({
                "interaction_id": interaction.id,
                "status": interaction.status,
            }),
        );
        self.broadcaster.broadcast(event);
    }

    /// Archive a resolved interaction.
    async fn archive(&self, interaction: PendingInteraction) {
        let mut history = self.history.write().await;
        history.push(interaction);
        // Cap history at 1000
        if history.len() > 1000 {
            let drain_count = history.len() - 1000;
            history.drain(..drain_count);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HitlStats {
    pub pending_count: usize,
    pub total_answered: usize,
    pub total_timed_out: usize,
    pub total_cancelled: usize,
    pub config: HitlConfig,
}

use serde::{Deserialize, Serialize};

/// Errors that can occur in the HITL system.
#[derive(Debug, thiserror::Error)]
pub enum HitlError {
    #[error("Sub-agents are not allowed to ask questions (config: allow_subagent_questions=false)")]
    SubagentNotAllowed,

    #[error("Too many questions: max {max}, got {got}")]
    TooManyQuestions { max: usize, got: usize },

    #[error("Too many options for question '{question}': max {max}, got {got}")]
    TooManyOptions {
        question: String,
        max: usize,
        got: usize,
    },

    #[error("Too many pending interactions: max {max}")]
    TooManyPending { max: usize },

    #[error("Interaction not found: {id}")]
    NotFound { id: String },

    #[error("Interaction expired: {id}")]
    Expired { id: String },

    #[error("Agent already moved on (dropped receiver): {id}")]
    AgentGone { id: String },
}

impl HitlError {
    /// HTTP status code for this error.
    pub fn status_code(&self) -> u16 {
        match self {
            HitlError::SubagentNotAllowed => 403,
            HitlError::TooManyQuestions { .. } => 400,
            HitlError::TooManyOptions { .. } => 400,
            HitlError::TooManyPending { .. } => 429,
            HitlError::NotFound { .. } => 404,
            HitlError::Expired { .. } => 410,
            HitlError::AgentGone { .. } => 409,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_broadcaster() -> Arc<SseBroadcaster> {
        Arc::new(SseBroadcaster::new(64))
    }

    #[tokio::test]
    async fn test_ask_and_respond_roundtrip() {
        let mgr = HitlManager::new(HitlConfig::default(), test_broadcaster());

        let questions = vec![Question {
            question: "Which ORM?".to_string(),
            header: "ORM".to_string(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "Diesel".to_string(),
                    description: "Compile-time checked queries".to_string(),
                    preview: None,
                },
                QuestionOption {
                    label: "SQLx".to_string(),
                    description: "Async, runtime checked".to_string(),
                    preview: None,
                },
            ],
        }];

        let waiter = mgr
            .ask_clarification("session-1", None, questions)
            .await
            .unwrap();

        // Verify it's in the pending list
        let pending = mgr.list_pending().await;
        assert_eq!(pending.len(), 1);
        let interaction_id = pending[0].id.clone();

        // Respond
        let response = InteractionResponse {
            interaction_id: interaction_id.clone(),
            answers: {
                let mut m = std::collections::HashMap::new();
                m.insert("Which ORM?".to_string(), "SQLx".to_string());
                m
            },
            approved: None,
            updated_input: None,
            message: None,
        };

        // Spawn the response in background
        let mgr_clone = Arc::new(mgr);
        let mgr_for_respond = mgr_clone.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            mgr_for_respond.respond(response).await.unwrap();
        });

        let result = waiter.wait().await;
        match result {
            InteractionResult::Answered { answers } => {
                assert_eq!(answers.get("Which ORM?").unwrap(), "SQLx");
            }
            other => panic!("Expected Answered, got {:?}", other),
        }

        // Should be removed from pending, added to history
        assert_eq!(mgr_clone.list_pending().await.len(), 0);
        assert_eq!(mgr_clone.history(10).await.len(), 1);
    }

    #[tokio::test]
    async fn test_subagent_restriction() {
        let config = HitlConfig {
            allow_subagent_questions: false,
            ..Default::default()
        };
        let mgr = HitlManager::new(config, test_broadcaster());

        let result = mgr
            .ask_clarification("s1", Some("sub-agent-1"), vec![])
            .await;

        assert!(matches!(result, Err(HitlError::SubagentNotAllowed)));
    }

    #[tokio::test]
    async fn test_question_limits() {
        let config = HitlConfig {
            max_questions: 2,
            ..Default::default()
        };
        let mgr = HitlManager::new(config, test_broadcaster());

        let too_many = vec![
            Question {
                question: "Q1?".into(),
                header: "Q1".into(),
                multi_select: false,
                options: vec![],
            },
            Question {
                question: "Q2?".into(),
                header: "Q2".into(),
                multi_select: false,
                options: vec![],
            },
            Question {
                question: "Q3?".into(),
                header: "Q3".into(),
                multi_select: false,
                options: vec![],
            },
        ];

        let result = mgr.ask_clarification("s1", None, too_many).await;
        assert!(matches!(
            result,
            Err(HitlError::TooManyQuestions { max: 2, got: 3 })
        ));
    }

    #[tokio::test]
    async fn test_cancel() {
        let mgr = Arc::new(HitlManager::new(HitlConfig::default(), test_broadcaster()));

        let waiter = mgr.ask_clarification("s1", None, vec![]).await.unwrap();

        let pending = mgr.list_pending().await;
        let id = pending[0].id.clone();

        let mgr_clone = mgr.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            mgr_clone.cancel(&id).await.unwrap();
        });

        let result = waiter.wait().await;
        assert!(matches!(result, InteractionResult::Cancelled));
    }

    #[tokio::test]
    async fn test_not_found() {
        let mgr = HitlManager::new(HitlConfig::default(), test_broadcaster());

        let result = mgr
            .respond(InteractionResponse {
                interaction_id: "nonexistent".to_string(),
                answers: std::collections::HashMap::new(),
                approved: None,
                updated_input: None,
                message: None,
            })
            .await;

        assert!(matches!(result, Err(HitlError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_stats() {
        let mgr = HitlManager::new(HitlConfig::default(), test_broadcaster());

        let stats = mgr.stats().await;
        assert_eq!(stats.pending_count, 0);
        assert_eq!(stats.total_answered, 0);
    }
}
