use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing::info;

pub struct Scratchpad {
    dir: PathBuf,
}

impl Scratchpad {
    pub fn new(base_dir: &Path, coordinator_task_id: &str) -> Self {
        Self {
            dir: base_dir.join(".scratchpad").join(coordinator_task_id),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub async fn ensure_dir(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.dir).await?;
        Ok(())
    }

    pub async fn write(&self, filename: &str, content: &str) -> Result<()> {
        self.ensure_dir().await?;
        let path = self.dir.join(filename);
        tokio::fs::write(&path, content).await?;
        info!(path = %path.display(), bytes = content.len(), "scratchpad write");
        Ok(())
    }

    pub async fn read(&self, filename: &str) -> Result<Option<String>> {
        let path = self.dir.join(filename);
        if path.exists() {
            Ok(Some(tokio::fs::read_to_string(&path).await?))
        } else {
            Ok(None)
        }
    }

    pub async fn list(&self) -> Result<Vec<String>> {
        if !self.dir.exists() {
            return Ok(Vec::new());
        }
        let mut files = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
        files.sort();
        Ok(files)
    }

    pub async fn cleanup(&self) -> Result<()> {
        if self.dir.exists() {
            let count = self.list().await?.len();
            tokio::fs::remove_dir_all(&self.dir).await?;
            info!(path = %self.dir.display(), files = count, "scratchpad cleaned up");
        }
        Ok(())
    }
}
