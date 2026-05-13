use std::collections::VecDeque;
use std::path::Path;

use anyhow::Result;
use chrono::Utc;
use tracing::{debug, info};

use super::types::{MicrocompactPolicy, OffloadedResult};

/// Microcompaction layer — offloads large tool results to disk,
/// keeping only a "hot tail" of recent results fully inline.
///
/// Inspired by Claude Code's approach: recent tool results stay visible
/// for reasoning, older/large results become disk references.
pub struct MicrocompactStore {
    policy: MicrocompactPolicy,
    /// Queue of offloaded results, newest at back.
    offloaded: VecDeque<OffloadedResult>,
    /// Counter for generating unique file names.
    seq: u64,
}

impl MicrocompactStore {
    pub fn new(policy: MicrocompactPolicy) -> Self {
        Self {
            policy,
            offloaded: VecDeque::new(),
            seq: 0,
        }
    }

    /// Check whether a tool result should be offloaded based on size.
    pub fn should_offload(&self, content: &str) -> bool {
        content.len() > self.policy.offload_threshold_chars
    }

    /// Offload a tool result to disk. Returns the stub to keep inline
    /// and the path where the full content is stored.
    pub async fn offload(
        &mut self,
        workspace: &Path,
        tool_call_id: &str,
        tool_name: &str,
        content: &str,
    ) -> Result<OffloadedResult> {
        let storage_dir = workspace.join(&self.policy.storage_dir);
        tokio::fs::create_dir_all(&storage_dir).await?;

        self.seq += 1;
        let filename = format!("{}_{}.txt", tool_name.replace('/', "_"), self.seq);
        let storage_path = storage_dir.join(&filename);

        tokio::fs::write(&storage_path, content).await?;

        let stub = build_inline_stub(tool_name, content, &storage_path);

        let record = OffloadedResult {
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            storage_path: storage_path.clone(),
            original_size_chars: content.len(),
            offloaded_at: Utc::now(),
            inline_stub: stub,
        };

        self.offloaded.push_back(record.clone());

        info!(
            tool = tool_name,
            chars = content.len(),
            path = %storage_path.display(),
            "microcompacted tool result to disk"
        );

        Ok(record)
    }

    /// Retrieve a previously offloaded result from disk.
    pub async fn retrieve(&self, workspace: &Path, tool_call_id: &str) -> Result<Option<String>> {
        if let Some(record) = self
            .offloaded
            .iter()
            .find(|r| r.tool_call_id == tool_call_id)
        {
            let full_path = if record.storage_path.is_absolute() {
                record.storage_path.clone()
            } else {
                workspace.join(&record.storage_path)
            };

            if full_path.exists() {
                let content = tokio::fs::read_to_string(&full_path).await?;
                debug!(path = %full_path.display(), "retrieved offloaded tool result");
                return Ok(Some(content));
            }
        }
        Ok(None)
    }

    /// Determine which tool results are in the "hot tail" (kept inline)
    /// versus "cold storage" (offloaded, only stub visible).
    pub fn partition_results(&self) -> (Vec<&OffloadedResult>, Vec<&OffloadedResult>) {
        let total = self.offloaded.len();
        if total <= self.policy.hot_tail_count {
            return (self.offloaded.iter().collect(), Vec::new());
        }

        let cold_count = total - self.policy.hot_tail_count;
        let cold: Vec<_> = self.offloaded.iter().take(cold_count).collect();
        let hot: Vec<_> = self.offloaded.iter().skip(cold_count).collect();
        (hot, cold)
    }

    /// Clean up old offloaded files beyond a maximum retention count.
    pub async fn gc(&mut self, workspace: &Path, max_retain: usize) -> Result<usize> {
        let mut removed = 0;
        while self.offloaded.len() > max_retain {
            if let Some(old) = self.offloaded.pop_front() {
                let path = if old.storage_path.is_absolute() {
                    old.storage_path
                } else {
                    workspace.join(&old.storage_path)
                };
                if path.exists() {
                    let _ = tokio::fs::remove_file(&path).await;
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            info!(removed, "garbage collected old microcompacted files");
        }
        Ok(removed)
    }

    pub fn offloaded_count(&self) -> usize {
        self.offloaded.len()
    }

    pub fn total_offloaded_bytes(&self) -> usize {
        self.offloaded.iter().map(|r| r.original_size_chars).sum()
    }
}

/// Build a short inline stub that stays in context when the full result is offloaded.
fn build_inline_stub(tool_name: &str, content: &str, storage_path: &Path) -> String {
    let preview_len = 200.min(content.len());
    let preview = &content[..preview_len];
    let ellipsis = if content.len() > preview_len {
        "..."
    } else {
        ""
    };

    format!(
        "[{tool_name} output offloaded to disk — {chars} chars → {path}]\n\
         Preview: {preview}{ellipsis}",
        tool_name = tool_name,
        chars = content.len(),
        path = storage_path.display(),
        preview = preview.trim(),
        ellipsis = ellipsis,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_offload_and_retrieve() {
        let tmp = TempDir::new().unwrap();
        let policy = MicrocompactPolicy {
            offload_threshold_chars: 100,
            hot_tail_count: 3,
            storage_dir: "tool-cache".into(),
        };
        let mut store = MicrocompactStore::new(policy);

        let big_content = "x".repeat(500);
        assert!(store.should_offload(&big_content));
        assert!(!store.should_offload("small"));

        let record = store
            .offload(tmp.path(), "call-1", "bash", &big_content)
            .await
            .unwrap();
        assert_eq!(record.original_size_chars, 500);
        assert!(record.inline_stub.contains("500 chars"));

        let retrieved = store.retrieve(tmp.path(), "call-1").await.unwrap();
        assert_eq!(retrieved.unwrap(), big_content);
    }

    #[tokio::test]
    async fn test_hot_cold_partition() {
        let tmp = TempDir::new().unwrap();
        let policy = MicrocompactPolicy {
            offload_threshold_chars: 10,
            hot_tail_count: 2,
            storage_dir: "tool-cache".into(),
        };
        let mut store = MicrocompactStore::new(policy);

        for i in 0..5 {
            let content = format!("result content {}", "x".repeat(100));
            store
                .offload(tmp.path(), &format!("call-{i}"), "grep", &content)
                .await
                .unwrap();
        }

        let (hot, cold) = store.partition_results();
        assert_eq!(hot.len(), 2);
        assert_eq!(cold.len(), 3);
    }
}
