use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::path::PathBuf;

use super::{Tool, ToolContext};

fn resolve_path(workspace: &std::path::Path, requested: &str) -> Result<PathBuf> {
    let path = if std::path::Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        workspace.join(requested)
    };

    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    let ws_canonical = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());

    if !canonical.starts_with(&ws_canonical) && !path.starts_with(workspace) {
        anyhow::bail!(
            "路径越界: {} 不在工作空间 {} 内",
            requested,
            workspace.display()
        );
    }

    Ok(path)
}

pub struct ReadFileTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "读取工作空间中的文件内容。路径相对于 Agent 工作空间根目录。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径（相对于工作空间）"},
                "max_chars": {"type": "integer", "description": "最大读取字符数，默认 5000"}
            },
            "required": ["path"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let path_str = args["path"].as_str().context("缺少 path 参数")?;
        let max_chars = args["max_chars"].as_u64().unwrap_or(5000) as usize;

        let path = resolve_path(&ctx.workspace_root, path_str)?;

        let content = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("读取文件失败: {}", path.display()))?;

        if content.len() > max_chars {
            Ok(format!(
                "{}...\n[截断：文件共 {} 字符，只显示前 {}]",
                &content[..max_chars],
                content.len(),
                max_chars
            ))
        } else {
            Ok(content)
        }
    }
}

pub struct WriteFileTool;

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "写入或覆盖工作空间中的文件。自动创建不存在的父目录。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径（相对于工作空间）"},
                "content": {"type": "string", "description": "文件内容"}
            },
            "required": ["path", "content"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let path_str = args["path"].as_str().context("缺少 path 参数")?;
        let content = args["content"].as_str().context("缺少 content 参数")?;

        let path = resolve_path(&ctx.workspace_root, path_str)?;

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(&path, content)
            .await
            .with_context(|| format!("写入文件失败: {}", path.display()))?;

        Ok(format!(
            "已写入 {} ({} 字节)",
            path.display(),
            content.len()
        ))
    }
}

pub struct ListFilesTool;

#[async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &str {
        "list_files"
    }

    fn description(&self) -> &str {
        "列出工作空间目录中的文件和子目录。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录路径（相对于工作空间），默认为根目录"}
            }
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let path_str = args["path"].as_str().unwrap_or(".");
        let path = resolve_path(&ctx.workspace_root, path_str)?;

        let mut entries = tokio::fs::read_dir(&path)
            .await
            .with_context(|| format!("读取目录失败: {}", path.display()))?;

        let mut items = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = entry.file_type().await?;
            let prefix = if ft.is_dir() { "📁 " } else { "📄 " };
            items.push(format!("{}{}", prefix, name));
        }

        items.sort();
        if items.is_empty() {
            Ok("（空目录）".into())
        } else {
            Ok(items.join("\n"))
        }
    }
}
