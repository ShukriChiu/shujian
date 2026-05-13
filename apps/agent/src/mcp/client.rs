use anyhow::{Context, Result};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, info};

use super::types::*;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    REQUEST_ID.fetch_add(1, Ordering::SeqCst)
}

pub struct StdioMcpClient {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    stdout_lines: Mutex<Option<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>>,
    server_name: String,
}

impl StdioMcpClient {
    pub async fn spawn(config: &McpServerConfig) -> Result<Self> {
        let McpTransport::Stdio {
            ref command,
            ref args,
        } = config.transport
        else {
            anyhow::bail!("StdioMcpClient requires stdio transport");
        };

        info!(
            "spawning MCP server '{}': {} {:?}",
            config.name, command, args
        );

        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn MCP server: {} {:?}", command, args))?;

        let stdin = child
            .stdin
            .take()
            .context("failed to capture MCP server stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("failed to capture MCP server stdout")?;

        let lines = BufReader::new(stdout).lines();

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            stdout_lines: Mutex::new(Some(lines)),
            server_name: config.name.clone(),
        })
    }

    pub async fn initialize(&self) -> Result<serde_json::Value> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "roots": { "listChanged": true }
            },
            "clientInfo": {
                "name": "shujian-agent",
                "version": env!("CARGO_PKG_VERSION")
            }
        });

        let resp = self.send_request("initialize", Some(params)).await?;

        self.send_notification("notifications/initialized", None)
            .await?;

        Ok(resp)
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolDescriptor>> {
        let resp = self.send_request("tools/list", None).await?;

        let tools = resp
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(McpToolDescriptor {
                            name: t.get("name")?.as_str()?.to_string(),
                            description: t
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string(),
                            input_schema: t
                                .get("inputSchema")
                                .cloned()
                                .unwrap_or(serde_json::json!({})),
                            server_name: self.server_name.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(tools)
    }

    pub async fn list_resources(&self) -> Result<Vec<McpResource>> {
        let resp = self.send_request("resources/list", None).await?;

        let resources = resp
            .get("resources")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| {
                        Some(McpResource {
                            uri: r.get("uri")?.as_str()?.to_string(),
                            name: r.get("name")?.as_str()?.to_string(),
                            description: r
                                .get("description")
                                .and_then(|d| d.as_str())
                                .map(String::from),
                            mime_type: r.get("mimeType").and_then(|d| d.as_str()).map(String::from),
                            server_name: self.server_name.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(resources)
    }

    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResponse> {
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": arguments,
        });

        let resp = self.send_request("tools/call", Some(params)).await?;

        let is_error = resp
            .get("isError")
            .and_then(|e| e.as_bool())
            .unwrap_or(false);

        let content = resp
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let t = item.get("type")?.as_str()?;
                        match t {
                            "text" => Some(ToolCallContent::Text {
                                text: item
                                    .get("text")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            }),
                            "image" => Some(ToolCallContent::Image {
                                data: item
                                    .get("data")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                mime_type: item
                                    .get("mimeType")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("image/png")
                                    .to_string(),
                            }),
                            _ => None,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ToolCallResponse { content, is_error })
    }

    pub async fn read_resource(&self, uri: &str) -> Result<String> {
        let params = serde_json::json!({ "uri": uri });
        let resp = self.send_request("resources/read", Some(params)).await?;

        let text = resp
            .get("contents")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        Ok(text)
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.send_request("shutdown", None).await;
        let _ = self.send_notification("exit", None).await;

        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }

        info!("MCP server '{}' shut down", self.server_name);
        Ok(())
    }

    pub fn pid(&self) -> Option<u32> {
        None
    }

    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let req = JsonRpcRequest::new(next_id(), method, params);
        let req_json = serde_json::to_string(&req)?;

        debug!(
            "MCP[{}] -> {}: {}",
            self.server_name,
            method,
            &req_json[..req_json.len().min(200)]
        );

        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .context("MCP server stdin not available")?;
            stdin
                .write_all(format!("{}\n", req_json).as_bytes())
                .await?;
            stdin.flush().await?;
        }

        let mut lines_guard = self.stdout_lines.lock().await;
        let lines = lines_guard
            .as_mut()
            .context("MCP server stdout not available")?;

        let timeout = tokio::time::Duration::from_secs(30);
        loop {
            let line = tokio::time::timeout(timeout, lines.next_line())
                .await
                .context("MCP response timeout")??
                .context("MCP server stdout closed")?;

            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            debug!(
                "MCP[{}] <- {}",
                self.server_name,
                &line[..line.len().min(200)]
            );

            let resp: JsonRpcResponse = serde_json::from_str(line).with_context(|| {
                format!(
                    "invalid MCP JSON-RPC response: {}",
                    &line[..line.len().min(100)]
                )
            })?;

            if resp.id == Some(req.id) {
                if let Some(err) = resp.error {
                    anyhow::bail!("MCP error ({}): {}", err.code, err.message);
                }
                return Ok(resp.result.unwrap_or(serde_json::Value::Null));
            }
        }
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<()> {
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or(serde_json::Value::Null),
        });
        let notif_json = serde_json::to_string(&notif)?;

        let mut stdin_guard = self.stdin.lock().await;
        if let Some(stdin) = stdin_guard.as_mut() {
            stdin
                .write_all(format!("{}\n", notif_json).as_bytes())
                .await?;
            stdin.flush().await?;
        }

        Ok(())
    }
}
