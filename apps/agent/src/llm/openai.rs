use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};

use super::client::LlmClient;
use super::types::*;

pub struct OpenAiClient {
    api_key: String,
    model: String,
    base_url: String,
    http: Client,
}

impl OpenAiClient {
    pub fn new(api_key: String, model: String, base_url: Option<String>) -> Self {
        Self {
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".into()),
            http: Client::new(),
        }
    }

    fn build_body(&self, messages: &[Message], tools: &[ToolDefinition], stream: bool) -> Value {
        let msgs: Vec<Value> = messages.iter().map(|m| msg_to_openai(m)).collect();

        let mut body = json!({
            "model": self.model,
            "messages": msgs,
            "stream": stream,
        });

        if !tools.is_empty() {
            let tool_defs: Vec<Value> = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = json!(tool_defs);
        }

        body
    }
}

fn msg_to_openai(msg: &Message) -> Value {
    match msg {
        Message::System { content } => json!({"role": "system", "content": content}),
        Message::User { content } => json!({"role": "user", "content": content}),
        Message::Assistant {
            content,
            tool_calls,
        } => {
            let mut m = json!({"role": "assistant"});
            if let Some(c) = content {
                m["content"] = json!(c);
            }
            if !tool_calls.is_empty() {
                m["tool_calls"] = json!(
                    tool_calls
                        .iter()
                        .map(|tc| json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": tc.arguments,
                            }
                        }))
                        .collect::<Vec<_>>()
                );
            }
            m
        }
        Message::Tool {
            tool_call_id,
            content,
        } => {
            json!({"role": "tool", "tool_call_id": tool_call_id, "content": content})
        }
    }
}

fn parse_response(body: &Value) -> Result<LlmResponse> {
    let choice = body["choices"]
        .get(0)
        .context("OpenAI 响应中没有 choices")?;
    let msg = &choice["message"];

    let content = msg["content"].as_str().map(String::from);

    let tool_calls: Vec<ToolCall> = msg
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    Some(ToolCall {
                        id: tc["id"].as_str()?.to_string(),
                        name: tc["function"]["name"].as_str()?.to_string(),
                        arguments: tc["function"]["arguments"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let usage = body.get("usage").map(|u| TokenUsage {
        prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
        completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
    });

    Ok(LlmResponse {
        content,
        tool_calls,
        usage,
    })
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn chat(&self, messages: &[Message], tools: &[ToolDefinition]) -> Result<LlmResponse> {
        let body = self.build_body(messages, tools, false);

        let resp = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .context("OpenAI 请求失败")?;

        let status = resp.status();
        let text = resp.text().await.context("读取 OpenAI 响应体失败")?;

        if !status.is_success() {
            anyhow::bail!(
                "OpenAI API 错误 ({}): {}",
                status,
                &text[..text.len().min(500)]
            );
        }

        let json: Value = serde_json::from_str(&text).context("解析 OpenAI JSON 失败")?;
        parse_response(&json)
    }

    async fn chat_stream(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        on_chunk: Box<dyn Fn(StreamChunk) + Send>,
    ) -> Result<LlmResponse> {
        let body = self.build_body(messages, tools, true);

        let resp = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .context("OpenAI stream 请求失败")?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("OpenAI API 错误: {}", &text[..text.len().min(500)]);
        }

        let mut content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut stream = resp.bytes_stream();

        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("读取 SSE chunk 失败")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line == "data: [DONE]" {
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

                if let Some(choices) = val["choices"].as_array() {
                    for choice in choices {
                        let delta = &choice["delta"];

                        if let Some(text) = delta["content"].as_str() {
                            content.push_str(text);
                            on_chunk(StreamChunk::Text(text.to_string()));
                        }

                        if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            for tc in tcs {
                                let idx = tc["index"].as_u64().unwrap_or(0) as usize;

                                if let Some(id) = tc["id"].as_str() {
                                    let name =
                                        tc["function"]["name"].as_str().unwrap_or("").to_string();
                                    while tool_calls.len() <= idx {
                                        tool_calls.push(ToolCall {
                                            id: String::new(),
                                            name: String::new(),
                                            arguments: String::new(),
                                        });
                                    }
                                    tool_calls[idx].id = id.to_string();
                                    tool_calls[idx].name = name.clone();
                                    on_chunk(StreamChunk::ToolCallStart {
                                        index: idx,
                                        id: id.to_string(),
                                        name,
                                    });
                                }

                                if let Some(args) = tc["function"]["arguments"].as_str() {
                                    if idx < tool_calls.len() {
                                        tool_calls[idx].arguments.push_str(args);
                                    }
                                    on_chunk(StreamChunk::ToolCallDelta {
                                        index: idx,
                                        arguments: args.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        on_chunk(StreamChunk::Done);

        Ok(LlmResponse {
            content: if content.is_empty() {
                None
            } else {
                Some(content)
            },
            tool_calls,
            usage: None,
        })
    }
}
