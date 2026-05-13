use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::Utc;
use tracing::info;

use crate::types::agent::MemoryScope;

pub struct MemoryStore {
    base_dir: PathBuf,
    scope: MemoryScope,
}

impl MemoryStore {
    pub fn new(base_dir: &Path, scope: MemoryScope) -> Self {
        Self {
            base_dir: base_dir.to_path_buf(),
            scope,
        }
    }

    pub fn scope(&self) -> MemoryScope {
        self.scope
    }

    fn memory_dir(&self) -> PathBuf {
        match self.scope {
            MemoryScope::User => dirs_path("user"),
            MemoryScope::Project => self.base_dir.join(".agent-memory"),
            MemoryScope::Local => self.base_dir.join(".agent-memory").join("local"),
            MemoryScope::None => self.base_dir.join(".agent-memory").join("ephemeral"),
        }
    }

    pub async fn ensure_dirs(&self) -> Result<()> {
        let dir = self.memory_dir();
        tokio::fs::create_dir_all(&dir).await?;
        Ok(())
    }

    pub async fn read_file(&self, filename: &str) -> Result<Option<String>> {
        let path = self.memory_dir().join(filename);
        if path.exists() {
            Ok(Some(tokio::fs::read_to_string(&path).await?))
        } else {
            Ok(None)
        }
    }

    pub async fn write_file(&self, filename: &str, content: &str) -> Result<()> {
        self.ensure_dirs().await?;
        let path = self.memory_dir().join(filename);
        tokio::fs::write(&path, content).await?;
        info!(path = %path.display(), bytes = content.len(), "memory write");
        Ok(())
    }

    pub async fn append_entry(&self, filename: &str, entry: &str) -> Result<()> {
        self.ensure_dirs().await?;
        let path = self.memory_dir().join(filename);
        let existing = if path.exists() {
            tokio::fs::read_to_string(&path).await?
        } else {
            String::new()
        };

        let timestamp = Utc::now().format("%Y-%m-%d %H:%M UTC");
        let new_content = format!("{}\n\n---\n_{}_ {}\n", existing.trim(), timestamp, entry);
        tokio::fs::write(&path, new_content.trim()).await?;
        Ok(())
    }

    pub async fn list_entries(&self) -> Result<Vec<String>> {
        let dir = self.memory_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut files = Vec::new();
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if let Some(name) = entry.file_name().to_str()
                && (name.ends_with(".md") || name.ends_with(".txt"))
            {
                files.push(name.to_string());
            }
        }
        files.sort();
        Ok(files)
    }

    pub async fn session_log(&self, session_id: &str, content: &str) -> Result<()> {
        let logs_dir = self.memory_dir().join("sessions");
        tokio::fs::create_dir_all(&logs_dir).await?;
        let date = Utc::now().format("%Y-%m-%d");
        let path = logs_dir.join(format!("{}_{}.md", date, session_id));
        tokio::fs::write(&path, content).await?;
        Ok(())
    }
}

fn dirs_path(scope: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".shujian-agent")
        .join("memory")
        .join(scope)
}
