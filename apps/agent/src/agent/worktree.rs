use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::info;

pub struct WorktreeManager {
    repo_root: PathBuf,
}

impl WorktreeManager {
    pub fn new(repo_root: &Path) -> Self {
        Self {
            repo_root: repo_root.to_path_buf(),
        }
    }

    pub async fn create(
        &self,
        branch_name: &str,
        base_branch: Option<&str>,
    ) -> Result<WorktreeInfo> {
        let worktree_dir = self.repo_root.join(".agent-worktrees").join(branch_name);

        let base = base_branch.unwrap_or("HEAD");

        let output = tokio::process::Command::new("git")
            .args(["worktree", "add", "-b", branch_name])
            .arg(&worktree_dir)
            .arg(base)
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("git worktree add")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("git worktree add failed: {}", stderr);
        }

        info!(
            branch = branch_name,
            path = %worktree_dir.display(),
            "worktree created"
        );

        Ok(WorktreeInfo {
            branch: branch_name.into(),
            path: worktree_dir,
            base_branch: base.into(),
        })
    }

    pub async fn remove(&self, branch_name: &str) -> Result<()> {
        let worktree_dir = self.repo_root.join(".agent-worktrees").join(branch_name);

        if !worktree_dir.exists() {
            return Ok(());
        }

        let output = tokio::process::Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&worktree_dir)
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("git worktree remove")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("git worktree remove failed: {}", stderr);
        }

        let _ = tokio::process::Command::new("git")
            .args(["branch", "-D", branch_name])
            .current_dir(&self.repo_root)
            .output()
            .await;

        info!(branch = branch_name, "worktree removed");
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<WorktreeInfo>> {
        let output = tokio::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("git worktree list")?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut worktrees = Vec::new();
        let mut current_path: Option<PathBuf> = None;
        let mut current_branch: Option<String> = None;

        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                current_path = Some(PathBuf::from(path));
            } else if let Some(branch_ref) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(branch_ref.into());
            } else if line.is_empty() {
                if let (Some(path), Some(branch)) = (current_path.take(), current_branch.take())
                    && path.to_string_lossy().contains(".agent-worktrees")
                {
                    worktrees.push(WorktreeInfo {
                        branch: branch.clone(),
                        path,
                        base_branch: "unknown".into(),
                    });
                }
                current_path = None;
                current_branch = None;
            }
        }

        Ok(worktrees)
    }

    pub async fn cleanup_all(&self) -> Result<u32> {
        let worktrees = self.list().await?;
        let count = worktrees.len() as u32;

        for wt in worktrees {
            if let Err(e) = self.remove(&wt.branch).await {
                tracing::warn!(branch = %wt.branch, error = %e, "failed to cleanup worktree");
            }
        }

        let worktrees_dir = self.repo_root.join(".agent-worktrees");
        if worktrees_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&worktrees_dir).await;
        }

        info!(count = count, "worktrees cleaned up");
        Ok(count)
    }

    pub async fn merge_back(
        &self,
        branch_name: &str,
        target_branch: &str,
        commit_message: Option<&str>,
    ) -> Result<MergeResult> {
        let output = tokio::process::Command::new("git")
            .args(["checkout", target_branch])
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("git checkout target")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("checkout failed: {}", stderr);
        }

        let merge_output = tokio::process::Command::new("git")
            .args(["merge", "--no-ff", branch_name])
            .args(
                commit_message
                    .map(|m| vec!["-m".to_string(), m.to_string()])
                    .unwrap_or_default(),
            )
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("git merge")?;

        if merge_output.status.success() {
            self.remove(branch_name).await?;

            Ok(MergeResult {
                success: true,
                conflicts: Vec::new(),
                message: format!("merged {} into {}", branch_name, target_branch),
            })
        } else {
            let stderr = String::from_utf8_lossy(&merge_output.stderr);
            let stdout = String::from_utf8_lossy(&merge_output.stdout);

            let _ = tokio::process::Command::new("git")
                .args(["merge", "--abort"])
                .current_dir(&self.repo_root)
                .output()
                .await;

            let conflicts: Vec<String> = stdout
                .lines()
                .filter(|l| l.starts_with("CONFLICT"))
                .map(|l| l.to_string())
                .collect();

            Ok(MergeResult {
                success: false,
                conflicts,
                message: stderr.to_string(),
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    pub branch: String,
    pub path: PathBuf,
    pub base_branch: String,
}

#[derive(Debug, Clone)]
pub struct MergeResult {
    pub success: bool,
    pub conflicts: Vec<String>,
    pub message: String,
}
