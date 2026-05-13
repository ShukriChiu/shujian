use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "system")]
    System { content: String },
    #[serde(rename = "user")]
    User { content: String },
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
    },
    #[serde(rename = "tool")]
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

impl LlmResponse {
    pub fn has_tool_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }

    pub fn text(&self) -> &str {
        self.content.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Clone)]
pub enum StreamChunk {
    Text(String),
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallDelta {
        index: usize,
        arguments: String,
    },
    Done,
}
