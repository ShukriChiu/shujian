use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use super::client::StdioMcpClient;
use super::types::*;

pub struct McpManager {
    servers: Arc<RwLock<HashMap<String, McpServerState>>>,
    clients: Arc<RwLock<HashMap<String, Arc<StdioMcpClient>>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(RwLock::new(HashMap::new())),
            clients: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add_server(&self, config: McpServerConfig) -> Result<()> {
        let name = config.name.clone();
        let state = McpServerState {
            config: config.clone(),
            status: McpServerStatus::Disconnected,
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
            error: None,
            pid: None,
        };

        self.servers.write().await.insert(name.clone(), state);

        if config.enabled {
            self.connect_server(&name).await?;
        }

        Ok(())
    }

    pub async fn remove_server(&self, name: &str) -> Result<()> {
        self.disconnect_server(name).await?;
        self.servers.write().await.remove(name);
        info!("removed MCP server '{}'", name);
        Ok(())
    }

    pub async fn connect_server(&self, name: &str) -> Result<()> {
        let config = {
            let servers = self.servers.read().await;
            let state = servers.get(name).context("MCP server not registered")?;
            state.config.clone()
        };

        {
            let mut servers = self.servers.write().await;
            if let Some(s) = servers.get_mut(name) {
                s.status = McpServerStatus::Connecting;
                s.error = None;
            }
        }

        match config.transport {
            McpTransport::Stdio { .. } => {
                let client = StdioMcpClient::spawn(&config).await?;

                let init_result = client.initialize().await;
                if let Err(ref e) = init_result {
                    let mut servers = self.servers.write().await;
                    if let Some(s) = servers.get_mut(name) {
                        s.status = McpServerStatus::Error;
                        s.error = Some(format!("initialization failed: {}", e));
                    }
                    return Err(anyhow::anyhow!("MCP init failed: {}", e));
                }

                let tools = client.list_tools().await.unwrap_or_default();
                let resources = client.list_resources().await.unwrap_or_default();

                info!(
                    "MCP server '{}' connected: {} tools, {} resources",
                    name,
                    tools.len(),
                    resources.len()
                );

                let client = Arc::new(client);
                self.clients.write().await.insert(name.to_string(), client);

                let mut servers = self.servers.write().await;
                if let Some(s) = servers.get_mut(name) {
                    s.status = McpServerStatus::Connected;
                    s.tools = tools;
                    s.resources = resources;
                }
            }

            McpTransport::Http { url, .. } => {
                info!(
                    "HTTP MCP server '{}' registered (url: {}), tool calls via HTTP POST",
                    name, url
                );
                let mut servers = self.servers.write().await;
                if let Some(s) = servers.get_mut(name) {
                    s.status = McpServerStatus::Connected;
                }
            }

            McpTransport::Sse { url } => {
                warn!(
                    "SSE transport for '{}' is deprecated, use HTTP instead (url: {})",
                    name, url
                );
                let mut servers = self.servers.write().await;
                if let Some(s) = servers.get_mut(name) {
                    s.status = McpServerStatus::Connected;
                }
            }
        }

        Ok(())
    }

    pub async fn disconnect_server(&self, name: &str) -> Result<()> {
        if let Some(client) = self.clients.write().await.remove(name) {
            client.shutdown().await?;
        }

        let mut servers = self.servers.write().await;
        if let Some(s) = servers.get_mut(name) {
            s.status = McpServerStatus::Disconnected;
            s.tools.clear();
            s.resources.clear();
        }

        Ok(())
    }

    pub async fn call_tool(&self, request: ToolCallRequest) -> Result<ToolCallResponse> {
        let clients = self.clients.read().await;
        let client = clients
            .get(&request.server_name)
            .context("MCP server not connected")?;

        client
            .call_tool(&request.tool_name, request.arguments)
            .await
    }

    pub async fn read_resource(&self, server_name: &str, uri: &str) -> Result<String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(server_name)
            .context("MCP server not connected")?;
        client.read_resource(uri).await
    }

    pub async fn all_tools(&self) -> Vec<McpToolDescriptor> {
        let servers = self.servers.read().await;
        servers
            .values()
            .filter(|s| s.status == McpServerStatus::Connected)
            .flat_map(|s| s.tools.iter().cloned())
            .collect()
    }

    pub async fn all_resources(&self) -> Vec<McpResource> {
        let servers = self.servers.read().await;
        servers
            .values()
            .filter(|s| s.status == McpServerStatus::Connected)
            .flat_map(|s| s.resources.iter().cloned())
            .collect()
    }

    pub async fn server_states(&self) -> Vec<McpServerState> {
        self.servers.read().await.values().cloned().collect()
    }

    pub async fn server_status(&self, name: &str) -> Option<McpServerStatus> {
        self.servers.read().await.get(name).map(|s| s.status)
    }

    pub async fn load_from_project(&self, project_root: &Path) -> Result<()> {
        let mcp_json = project_root.join(".mcp.json");
        if !mcp_json.exists() {
            return Ok(());
        }

        let content = tokio::fs::read_to_string(&mcp_json).await?;
        let configs: HashMap<String, serde_json::Value> = serde_json::from_str(&content)?;

        for (name, value) in configs {
            if let Ok(config) = parse_mcp_config(&name, &value)
                && let Err(e) = self.add_server(config).await
            {
                warn!("failed to add MCP server '{}': {}", name, e);
            }
        }

        Ok(())
    }

    pub async fn shutdown_all(&self) -> Result<()> {
        let names: Vec<String> = self.clients.read().await.keys().cloned().collect();
        for name in names {
            if let Err(e) = self.disconnect_server(&name).await {
                error!("failed to disconnect MCP server '{}': {}", name, e);
            }
        }
        Ok(())
    }
}

fn parse_mcp_config(name: &str, value: &serde_json::Value) -> Result<McpServerConfig> {
    let transport = if let Some(cmd) = value.get("command").and_then(|c| c.as_str()) {
        let args: Vec<String> = value
            .get("args")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        McpTransport::Stdio {
            command: cmd.to_string(),
            args,
        }
    } else if let Some(url) = value.get("url").and_then(|u| u.as_str()) {
        McpTransport::Http {
            url: url.to_string(),
            headers: HashMap::new(),
        }
    } else {
        anyhow::bail!("MCP server config must have 'command' or 'url'");
    };

    let env: HashMap<String, String> = value
        .get("env")
        .and_then(|e| e.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    Ok(McpServerConfig {
        name: name.to_string(),
        transport,
        scope: McpScope::Local,
        env,
        enabled: true,
    })
}
