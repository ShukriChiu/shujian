use anyhow::Result;
use tracing::{info, warn, error};

use crate::config::DisciplineConfig;
use crate::llm::{LlmClient, Message, StreamChunk, ToolCall};
use crate::tools::{ToolContext, ToolRegistry};
use crate::workspace::WorkspaceManager;
use super::context::{build_continuation_prompt, build_wisdom_prompt};
use super::guard::*;

pub struct AgentEngine {
    max_rounds: usize,
    token_budget: Option<u64>,
    permissions: PermissionChecker,
    discipline: DisciplineConfig,
    workspace: Option<std::sync::Arc<WorkspaceManager>>,
}

impl AgentEngine {
    pub fn new(max_rounds: usize) -> Self {
        Self {
            max_rounds,
            token_budget: None,
            permissions: PermissionChecker::new(vec![]),
            discipline: DisciplineConfig::default(),
            workspace: None,
        }
    }

    pub fn with_token_budget(mut self, budget: u64) -> Self {
        self.token_budget = Some(budget);
        self
    }

    pub fn with_permissions(mut self, rules: Vec<PermissionRule>) -> Self {
        self.permissions = PermissionChecker::new(rules);
        self
    }

    pub fn with_discipline(mut self, config: DisciplineConfig) -> Self {
        self.discipline = config;
        self
    }

    pub fn with_workspace(mut self, ws: std::sync::Arc<WorkspaceManager>) -> Self {
        self.workspace = Some(ws);
        self
    }

    pub async fn run(
        &self,
        llm: &dyn LlmClient,
        messages: &mut Vec<Message>,
        tools: &ToolRegistry,
        tool_ctx: &ToolContext,
        stream: bool,
    ) -> Result<String> {
        let tool_defs = tools.definitions();
        let tool_names: Vec<String> = tool_defs.iter().map(|t| t.name.clone()).collect();
        let mut loop_detector = LoopDetector::new();
        let mut token_tracker = TokenTracker::new(self.token_budget);
        let mut continuation_count: usize = 0;

        for round in 0..self.max_rounds {
            info!("轮次 {}/{}", round + 1, self.max_rounds);

            let response = self
                .call_with_retry(llm, messages, &tool_defs, stream, 3)
                .await?;

            if let Some(usage) = &response.usage {
                token_tracker.record(usage.prompt_tokens, usage.completion_tokens);
            }

            if token_tracker.over_budget() {
                warn!("{}", token_tracker.summary());
                messages.push(Message::System {
                    content: format!(
                        "已超出 token 预算（{}）。请立即给出最终回复，不要再调用工具。",
                        token_tracker.summary()
                    ),
                });
            }

            if !response.has_tool_calls() {
                let text = response.text().to_string();
                messages.push(Message::Assistant {
                    content: Some(text.clone()),
                    tool_calls: vec![],
                });

                if self.discipline.enforce_todo
                    && continuation_count < self.discipline.max_continuation
                {
                    if let Some(ws) = &self.workspace {
                        let (has_incomplete, todos) = ws.has_incomplete_todos();
                        if has_incomplete {
                            continuation_count += 1;
                            info!(
                                "Todo Enforcer: {} 个未完成项，续跑 ({}/{})",
                                todos.len(),
                                continuation_count,
                                self.discipline.max_continuation
                            );
                            messages.push(Message::User {
                                content: build_continuation_prompt(&todos),
                            });
                            continue;
                        }
                    }
                }

                if self.discipline.accumulate_wisdom
                    && continuation_count == 0
                    && self.workspace.is_some()
                {
                    info!("{}", token_tracker.summary());
                    return self
                        .maybe_accumulate_wisdom(llm, messages, tools, tool_ctx, text, stream)
                        .await;
                }

                info!("{}", token_tracker.summary());
                return Ok(text);
            }

            let tc_clones: Vec<ToolCall> = response.tool_calls.clone();
            messages.push(Message::Assistant {
                content: response.content.clone(),
                tool_calls: tc_clones.clone(),
            });

            for tc in &tc_clones {
                let resolved_name = if tools.has_tool(&tc.name) {
                    tc.name.clone()
                } else if let Some(repaired) = try_repair_tool_name(&tc.name, &tool_names) {
                    warn!("工具名修复: {} → {}", tc.name, repaired);
                    repaired
                } else {
                    let err_msg = format!(
                        "未知工具 `{}`。可用工具: {}",
                        tc.name,
                        tool_names.join(", ")
                    );
                    warn!("{}", err_msg);
                    messages.push(Message::Tool {
                        tool_call_id: tc.id.clone(),
                        content: err_msg,
                    });
                    continue;
                };

                let args: serde_json::Value =
                    serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));

                let perm = self.permissions.check(&resolved_name, &args);
                if perm == PermissionAction::Deny {
                    let deny_msg = format!("权限拒绝：工具 `{}` 被当前 Agent 模式禁止使用。", resolved_name);
                    warn!("{}", deny_msg);
                    messages.push(Message::Tool {
                        tool_call_id: tc.id.clone(),
                        content: deny_msg,
                    });
                    continue;
                }

                match loop_detector.record_and_check(&resolved_name, &args) {
                    LoopStatus::Block(msg) => {
                        error!("{}", msg);
                        messages.push(Message::Tool {
                            tool_call_id: tc.id.clone(),
                            content: msg,
                        });
                        continue;
                    }
                    LoopStatus::Warning(msg) => {
                        warn!("{}", msg);
                        messages.push(Message::System { content: msg });
                    }
                    LoopStatus::Ok => {}
                }

                info!(
                    "调用工具: {} ({})",
                    resolved_name,
                    &tc.arguments[..tc.arguments.len().min(100)]
                );

                let result = match tools.execute(&resolved_name, args, tool_ctx).await {
                    Ok(r) => r,
                    Err(e) => format!("工具执行错误: {}", e),
                };

                let result = OutputTruncator::truncate(result, &tool_ctx.workspace_root);

                info!("工具结果: {} 字节", result.len());

                messages.push(Message::Tool {
                    tool_call_id: tc.id.clone(),
                    content: result,
                });
            }

            if round >= (self.max_rounds as f64 * 0.8) as usize {
                warn!("接近轮次上限 ({}/{})", round + 1, self.max_rounds);
                messages.push(Message::System {
                    content: format!(
                        "警告：你已使用 {}/{} 轮工具调用。请尽快完成任务并给出最终回复。",
                        round + 1,
                        self.max_rounds
                    ),
                });
            }

            if self.should_compact(messages) {
                info!("触发对话压缩...");
                if let Err(e) = self.compact_history(llm, messages).await {
                    warn!("对话压缩失败: {}", e);
                }
            }
        }

        info!("{}", token_tracker.summary());
        Ok("（已达到最大工具调用轮次，强制结束）".into())
    }

    async fn maybe_accumulate_wisdom(
        &self,
        llm: &dyn LlmClient,
        messages: &mut Vec<Message>,
        tools: &ToolRegistry,
        tool_ctx: &ToolContext,
        final_text: String,
        stream: bool,
    ) -> Result<String> {
        messages.push(Message::User {
            content: build_wisdom_prompt(),
        });

        let tool_defs = tools.definitions();
        let response = self.call_with_retry(llm, messages, &tool_defs, stream, 2).await;

        match response {
            Ok(resp) => {
                if resp.has_tool_calls() {
                    let tc_clones: Vec<ToolCall> = resp.tool_calls.clone();
                    messages.push(Message::Assistant {
                        content: resp.content.clone(),
                        tool_calls: tc_clones.clone(),
                    });
                    for tc in &tc_clones {
                        if tools.has_tool(&tc.name) {
                            let args: serde_json::Value =
                                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                            let result = match tools.execute(&tc.name, args, tool_ctx).await {
                                Ok(r) => r,
                                Err(e) => format!("工具执行错误: {}", e),
                            };
                            info!("经验写入: {} → {} 字节", tc.name, result.len());
                            messages.push(Message::Tool {
                                tool_call_id: tc.id.clone(),
                                content: result,
                            });
                        }
                    }
                }
                Ok(final_text)
            }
            Err(e) => {
                warn!("经验积累调用失败（不影响主结果）: {}", e);
                Ok(final_text)
            }
        }
    }

    async fn call_with_retry(
        &self,
        llm: &dyn LlmClient,
        messages: &[Message],
        tools: &[crate::llm::ToolDefinition],
        stream: bool,
        max_retries: usize,
    ) -> Result<crate::llm::LlmResponse> {
        let mut last_err = None;

        for attempt in 0..=max_retries {
            if attempt > 0 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt as u32 - 1));
                warn!("LLM 调用重试 ({}/{}), 等待 {:?}", attempt, max_retries, delay);
                tokio::time::sleep(delay).await;
            }

            let result = if stream {
                llm.chat_stream(
                    messages,
                    tools,
                    Box::new(|chunk| match chunk {
                        StreamChunk::Text(t) => print!("{}", t),
                        StreamChunk::Done => println!(),
                        _ => {}
                    }),
                )
                .await
            } else {
                llm.chat(messages, tools).await
            };

            match result {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("429") || err_str.contains("503") || err_str.contains("timeout") {
                        warn!("LLM 暂时不可用: {}", &err_str[..err_str.len().min(200)]);
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("LLM 调用失败（已重试 {} 次）", max_retries)))
    }

    fn should_compact(&self, messages: &[Message]) -> bool {
        let total_chars: usize = messages
            .iter()
            .map(|m| match m {
                Message::System { content } | Message::User { content } => content.len(),
                Message::Assistant { content, tool_calls } => {
                    content.as_deref().map_or(0, |c| c.len())
                        + tool_calls.iter().map(|tc| tc.arguments.len()).sum::<usize>()
                }
                Message::Tool { content, .. } => content.len(),
            })
            .sum();

        total_chars > 100_000
    }

    async fn compact_history(
        &self,
        llm: &dyn LlmClient,
        messages: &mut Vec<Message>,
    ) -> Result<()> {
        if messages.len() < 6 {
            return Ok(());
        }

        let system_msg = messages.first().cloned();

        let mid = messages.len() * 2 / 3;
        let to_compact: Vec<&Message> = messages[1..mid].iter().collect();

        let summary_text: String = to_compact
            .iter()
            .filter_map(|m| match m {
                Message::User { content } => Some(format!("User: {}", &content[..content.len().min(200)])),
                Message::Assistant { content, .. } => {
                    content.as_deref().map(|c| format!("Assistant: {}", &c[..c.len().min(200)]))
                }
                Message::Tool { content, .. } => Some(format!("Tool: {}", &content[..content.len().min(100)])),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let compact_msgs = vec![
            Message::System {
                content: "你是一个对话总结助手。请将以下对话历史压缩为一段简洁的摘要，保留关键信息（工具调用结果、决策、发现）。用中文回复。".into(),
            },
            Message::User {
                content: format!("请总结以下对话历史：\n\n{}", summary_text),
            },
        ];

        let response = llm.chat(&compact_msgs, &[]).await?;
        let summary = response.text().to_string();

        let recent: Vec<Message> = messages[mid..].to_vec();

        messages.clear();
        if let Some(sys) = system_msg {
            messages.push(sys);
        }
        messages.push(Message::System {
            content: format!("## 之前的对话摘要\n{}", summary),
        });
        messages.extend(recent);

        info!("对话压缩完成：{} 条消息压缩为摘要 + {} 条近期消息", mid - 1, messages.len() - 2);

        Ok(())
    }
}
