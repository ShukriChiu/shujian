use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentId;
use super::task::TokenUsage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMessage {
    pub id: String,
    pub from: AgentId,
    pub from_name: String,
    pub to: AgentId,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub status: InboxMessageStatus,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxMessageStatus {
    Pending,
    Processing,
    Processed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResultMessage {
    pub agent_id: AgentId,
    pub task_id: String,
    pub status: AgentResultStatus,
    pub summary: String,
    pub result: String,
    pub usage: Option<TokenUsage>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentResultStatus {
    Completed,
    Failed,
    Killed,
}

impl AgentResultMessage {
    pub fn to_xml(&self) -> String {
        let mut xml = String::new();
        xml.push_str("<agent_result>\n");
        xml.push_str(&format!("  <agent_id>{}</agent_id>\n", self.agent_id));
        xml.push_str(&format!("  <status>{:?}</status>\n", self.status));
        xml.push_str(&format!("  <summary>{}</summary>\n", self.summary));
        xml.push_str(&format!("  <result>{}</result>\n", self.result));
        if let Some(usage) = &self.usage {
            xml.push_str("  <usage>\n");
            xml.push_str(&format!("    <input_tokens>{}</input_tokens>\n", usage.input_tokens));
            xml.push_str(&format!("    <output_tokens>{}</output_tokens>\n", usage.output_tokens));
            xml.push_str("  </usage>\n");
        }
        if let Some(cost) = self.cost_usd {
            xml.push_str(&format!("  <cost_usd>{:.4}</cost_usd>\n", cost));
        }
        xml.push_str("</agent_result>");
        xml
    }
}
