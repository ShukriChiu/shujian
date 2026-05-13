use anyhow::Result;
use async_trait::async_trait;

use super::types::{LlmResponse, Message, StreamChunk, ToolDefinition};
use crate::config::LlmConfig;

#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn chat(&self, messages: &[Message], tools: &[ToolDefinition]) -> Result<LlmResponse>;

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        on_chunk: Box<dyn Fn(StreamChunk) + Send>,
    ) -> Result<LlmResponse>;
}

pub fn create_llm_client(config: &LlmConfig, api_key: &str) -> Box<dyn LlmClient> {
    match config.provider.as_str() {
        "anthropic" => Box::new(super::anthropic::AnthropicClient::new(
            api_key.to_string(),
            config.model.clone(),
        )),
        _ => Box::new(super::openai::OpenAiClient::new(
            api_key.to_string(),
            config.model.clone(),
            config.base_url.clone(),
        )),
    }
}
