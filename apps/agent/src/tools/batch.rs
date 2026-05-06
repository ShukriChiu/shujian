use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

use super::{Tool, ToolContext};

const MAX_BATCH_SIZE: usize = 25;

pub struct BatchTool;

#[async_trait]
impl Tool for BatchTool {
    fn name(&self) -> &str { "batch" }

    fn description(&self) -> &str {
        "并行执行多个工具调用。当你需要同时执行多个独立操作时使用（如同时读取多个文件、同时查询多个数据源）。最多 25 个并行调用。不支持嵌套 batch。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "calls": {
                    "type": "array",
                    "description": "要并行执行的工具调用列表",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string", "description": "工具名称"},
                            "args": {"type": "object", "description": "工具参数"}
                        },
                        "required": ["tool", "args"]
                    }
                }
            },
            "required": ["calls"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let calls = args["calls"]
            .as_array()
            .context("缺少 calls 数组")?;

        if calls.len() > MAX_BATCH_SIZE {
            anyhow::bail!("batch 最多 {} 个调用，收到 {}", MAX_BATCH_SIZE, calls.len());
        }

        let mut handles = Vec::new();

        for (i, call) in calls.iter().enumerate() {
            let tool_name = call["tool"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let tool_args = call["args"].clone();

            if tool_name == "batch" {
                handles.push((i, tool_name, Err(anyhow::anyhow!("不允许嵌套 batch"))));
                continue;
            }

            let workspace = ctx.workspace_root.clone();
            let supa_url = ctx.supabase_url.clone();
            let supa_key = ctx.supabase_key.clone();
            let ua_url = ctx.union_agent_url.clone();

            let inner_ctx = ToolContext {
                workspace_root: workspace,
                supabase_url: supa_url,
                supabase_key: supa_key,
                union_agent_url: ua_url,
            };

            let name_clone = tool_name.clone();
            let args_clone = tool_args.clone();

            let handle: tokio::task::JoinHandle<Result<String>> = tokio::spawn(async move {
                let tool: Box<dyn Tool> = match name_clone.as_str() {
                    "read_file" => Box::new(super::file::ReadFileTool),
                    "write_file" => Box::new(super::file::WriteFileTool),
                    "list_files" => Box::new(super::file::ListFilesTool),
                    "shell_exec" => Box::new(super::shell::ShellExecTool),
                    "http_fetch" => Box::new(super::http_fetch::HttpFetchTool),
                    "query_supabase" => Box::new(super::supabase::SupabaseQueryTool),
                    _ => return Err(anyhow::anyhow!("batch 中不支持工具: {}", name_clone)),
                };
                tool.execute(args_clone, &inner_ctx).await
            });

            handles.push((i, tool_name, Ok(handle)));
        }

        let mut results = Vec::new();
        for (i, name, handle_or_err) in handles {
            match handle_or_err {
                Err(e) => {
                    results.push(format!("[{}] {} → 错误: {}", i, name, e));
                }
                Ok(handle) => {
                    match handle.await {
                        Ok(Ok(output)) => {
                            let truncated = if output.len() > 2000 {
                                format!("{}...[截断]", &output[..2000])
                            } else {
                                output
                            };
                            results.push(format!("[{}] {} → {}", i, name, truncated));
                        }
                        Ok(Err(e)) => {
                            results.push(format!("[{}] {} → 错误: {}", i, name, e));
                        }
                        Err(e) => {
                            results.push(format!("[{}] {} → 任务失败: {}", i, name, e));
                        }
                    }
                }
            }
        }

        Ok(results.join("\n\n---\n\n"))
    }
}
