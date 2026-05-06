use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};

use super::client::LlmClient;
use super::types::*;

pub struct AnthropicClient {
    api_key: String,
    model: String,
    http: Client,
}

impl AnthropicClient {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key,
            model,
            http: Client::new(),
        }
    }

    fn build_body(&self, messages: &[Message], tools: &[ToolDefinition], stream: bool) -> (Option<String>, Value) {
        let mut system_prompt = None;
        let mut api_msgs: Vec<Value> = Vec::new();

        for msg in messages {
            match msg {
                Message::System { content } => {
                    system_prompt = Some(content.clone());
                }
                Message::User { content } => {
                    api_msgs.push(json!({"role": "user", "content": content}));
                }
                Message::Assistant { content, tool_calls } => {
                    let mut blocks: Vec<Value> = Vec::new();
                    if let Some(c) = content {
                        blocks.push(json!({"type": "text", "text": c}));
                    }
                    for tc in tool_calls {
                        let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": args,
                        }));
                    }
                    api_msgs.push(json!({"role": "assistant", "content": blocks}));
                }
                Message::Tool { tool_call_id, content } => {
                    api_msgs.push(json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call_id,
                            "content": content,
                        }]
                    }));
                }
            }
        }

        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect();

        let mut body = json!({
            "model": self.model,
            "max_tokens": 8192,
            "messages": api_msgs,
            "stream": stream,
        });

        if !tool_defs.is_empty() {
            body["tools"] = json!(tool_defs);
        }

        (system_prompt, body)
    }
}

fn parse_response(body: &Value) -> Result<LlmResponse> {
    let content_blocks = body["content"].as_array().context("Anthropic 无 content 字段")?;

    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for block in content_blocks {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(t) = block["text"].as_str() {
                    text_parts.push(t.to_string());
                }
            }
            Some("tool_use") => {
                tool_calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or("").to_string(),
                    name: block["name"].as_str().unwrap_or("").to_string(),
                    arguments: block["input"].to_string(),
                });
            }
            _ => {}
        }
    }

    let usage = body.get("usage").map(|u| TokenUsage {
        prompt_tokens: u["input_tokens"].as_u64().unwrap_or(0) as u32,
        completion_tokens: u["output_tokens"].as_u64().unwrap_or(0) as u32,
    });

    let content = if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join(""))
    };

    Ok(LlmResponse {
        content,
        tool_calls,
        usage,
    })
}

#[async_trait]
impl LlmClient for AnthropicClient {
    async fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
    ) -> Result<LlmResponse> {
        let (system_prompt, mut body) = self.build_body(messages, tools, false);

        if let Some(sp) = &system_prompt {
            body["system"] = json!(sp);
        }

        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Anthropic 请求失败")?;

        let status = resp.status();
        let text = resp.text().await.context("读取 Anthropic 响应体失败")?;

        if !status.is_success() {
            anyhow::bail!("Anthropic API 错误 ({}): {}", status, &text[..text.len().min(500)]);
        }

        let json: Value = serde_json::from_str(&text).context("解析 Anthropic JSON 失败")?;
        parse_response(&json)
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        on_chunk: Box<dyn Fn(StreamChunk) + Send>,
    ) -> Result<LlmResponse> {
        let (system_prompt, mut body) = self.build_body(messages, tools, true);

        if let Some(sp) = &system_prompt {
            body["system"] = json!(sp);
        }

        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Anthropic stream 请求失败")?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Anthropic API 错误: {}", &text[..text.len().min(500)]);
        }

        let mut content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut current_tool: Option<ToolCall> = None;
        let mut current_tool_input = String::new();
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("读取 Anthropic SSE chunk 失败")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                let data = if let Some(d) = line.strip_prefix("data: ") {
                    d
                } else {
                    continue;
                };

                let val: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                match val["type"].as_str() {
                    Some("content_block_start") => {
                        let block = &val["content_block"];
                        if block["type"].as_str() == Some("tool_use") {
                            let id = block["id"].as_str().unwrap_or("").to_string();
                            let name = block["name"].as_str().unwrap_or("").to_string();
                            on_chunk(StreamChunk::ToolCallStart {
                                index: tool_calls.len(),
                                id: id.clone(),
                                name: name.clone(),
                            });
                            current_tool = Some(ToolCall { id, name, arguments: String::new() });
                            current_tool_input.clear();
                        }
                    }
                    Some("content_block_delta") => {
                        let delta = &val["delta"];
                        match delta["type"].as_str() {
                            Some("text_delta") => {
                                if let Some(t) = delta["text"].as_str() {
                                    content.push_str(t);
                                    on_chunk(StreamChunk::Text(t.to_string()));
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some(partial) = delta["partial_json"].as_str() {
                                    current_tool_input.push_str(partial);
                                    on_chunk(StreamChunk::ToolCallDelta {
                                        index: tool_calls.len(),
                                        arguments: partial.to_string(),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("content_block_stop") => {
                        if let Some(mut tc) = current_tool.take() {
                            tc.arguments = current_tool_input.clone();
                            tool_calls.push(tc);
                            current_tool_input.clear();
                        }
                    }
                    Some("message_stop") => break,
                    _ => {}
                }
            }
        }

        on_chunk(StreamChunk::Done);

        Ok(LlmResponse {
            content: if content.is_empty() { None } else { Some(content) },
            tool_calls,
            usage: None,
        })
    }
}
