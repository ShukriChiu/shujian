use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use super::ToolContext;
use crate::types::permission::PermissionBehavior;

#[derive(Debug, Clone)]
pub struct ToolCallProgress {
    pub tool_name: String,
    pub percent: Option<f32>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ToolMetadata {
    pub is_read_only: bool,
    pub is_destructive: bool,
    pub is_concurrency_safe: bool,
    pub max_result_bytes: usize,
    pub timeout_ms: u64,
    pub supports_interrupt: bool,
}

impl Default for ToolMetadata {
    fn default() -> Self {
        Self {
            is_read_only: false,
            is_destructive: false,
            is_concurrency_safe: true,
            max_result_bytes: 50_000,
            timeout_ms: 30_000,
            supports_interrupt: false,
        }
    }
}

impl ToolMetadata {
    pub fn read_only() -> Self {
        Self {
            is_read_only: true,
            ..Default::default()
        }
    }

    pub fn destructive() -> Self {
        Self {
            is_destructive: true,
            is_concurrency_safe: false,
            ..Default::default()
        }
    }
}

#[async_trait]
pub trait EnhancedTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    fn metadata(&self) -> ToolMetadata;

    async fn execute(
        &self,
        args: Value,
        ctx: &ToolContext,
        progress: Option<Arc<dyn ProgressSink>>,
    ) -> Result<String>;

    fn check_permission(&self, _args: &Value, _ctx: &ToolContext) -> PermissionBehavior {
        if self.metadata().is_read_only {
            PermissionBehavior::Allow
        } else if self.metadata().is_destructive {
            PermissionBehavior::Ask
        } else {
            PermissionBehavior::Allow
        }
    }

    fn validate_input(&self, _args: &Value) -> Result<()> {
        Ok(())
    }

    fn render_summary(&self, args: &Value) -> String {
        format!(
            "{}({})",
            self.name(),
            serde_json::to_string(args).unwrap_or_default()
        )
    }
}

pub trait ProgressSink: Send + Sync {
    fn report(&self, progress: ToolCallProgress);
}
