pub mod file;
pub mod shell;
pub mod http_fetch;
pub mod supabase;
pub mod batch;
pub mod traits;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use crate::llm::ToolDefinition;

pub struct ToolContext {
    pub workspace_root: std::path::PathBuf,
    pub supabase_url: Option<String>,
    pub supabase_key: Option<String>,
    pub union_agent_url: String,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    pub fn tool_names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters_schema(),
            })
            .collect()
    }

    pub async fn execute(&self, name: &str, args: Value, ctx: &ToolContext) -> Result<String> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("未知工具: {}", name))?;
        tool.execute(args, ctx).await
    }

    pub fn register_defaults(&mut self) {
        self.register(Arc::new(file::ReadFileTool));
        self.register(Arc::new(file::WriteFileTool));
        self.register(Arc::new(file::ListFilesTool));
        self.register(Arc::new(shell::ShellExecTool));
        self.register(Arc::new(http_fetch::HttpFetchTool));
        self.register(Arc::new(supabase::SupabaseQueryTool));
        self.register(Arc::new(batch::BatchTool));
    }

    pub fn register_selected(&mut self, names: &[String]) {
        let all: Vec<Arc<dyn Tool>> = vec![
            Arc::new(file::ReadFileTool),
            Arc::new(file::WriteFileTool),
            Arc::new(file::ListFilesTool),
            Arc::new(shell::ShellExecTool),
            Arc::new(http_fetch::HttpFetchTool),
            Arc::new(supabase::SupabaseQueryTool),
            Arc::new(batch::BatchTool),
        ];

        for tool in all {
            if names.iter().any(|n| n == tool.name()) {
                self.register(tool);
            }
        }

        if names.iter().any(|n| n == "batch") && !self.has_tool("batch") {
            self.register(Arc::new(batch::BatchTool));
        }
    }
}
