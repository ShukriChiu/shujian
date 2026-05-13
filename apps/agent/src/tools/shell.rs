use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::process::Command;

use super::{Tool, ToolContext};

const MAX_OUTPUT: usize = 10_000;

pub struct ShellExecTool;

#[async_trait]
impl Tool for ShellExecTool {
    fn name(&self) -> &str {
        "shell_exec"
    }

    fn description(&self) -> &str {
        "在 Agent 工作空间内执行 shell 命令。返回 stdout + stderr + exit code。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的 shell 命令"},
                "timeout_secs": {"type": "integer", "description": "超时秒数，默认 30"}
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let cmd = args["command"].as_str().context("缺少 command 参数")?;
        let timeout = args["timeout_secs"].as_u64().unwrap_or(30);

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(timeout),
            Command::new("sh")
                .arg("-c")
                .arg(cmd)
                .current_dir(&ctx.workspace_root)
                .output(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("命令超时 ({}s): {}", timeout, cmd))?
        .with_context(|| format!("执行命令失败: {}", cmd))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);

        let mut result = format!("exit_code: {}\n", code);

        if !stdout.is_empty() {
            let s = if stdout.len() > MAX_OUTPUT {
                format!("{}...[截断]", &stdout[..MAX_OUTPUT])
            } else {
                stdout.to_string()
            };
            result.push_str(&format!("--- stdout ---\n{}\n", s));
        }

        if !stderr.is_empty() {
            let s = if stderr.len() > MAX_OUTPUT {
                format!("{}...[截断]", &stderr[..MAX_OUTPUT])
            } else {
                stderr.to_string()
            };
            result.push_str(&format!("--- stderr ---\n{}\n", s));
        }

        Ok(result)
    }
}
