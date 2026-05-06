use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub struct WorkspaceManager {
    root: PathBuf,
}

impl WorkspaceManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ensure_structure(&self) -> Result<()> {
        let dirs = ["memory", "skills", "workspace", "workspace/archived"];
        for d in dirs {
            let path = self.root.join(d);
            if !path.exists() {
                std::fs::create_dir_all(&path)
                    .with_context(|| format!("创建目录失败: {}", path.display()))?;
            }
        }

        let defaults = [
            ("soul.md", "# Agent Soul\n\n(请配置此 Agent 的人格定义)\n"),
            ("focus.md", "# Focus Items\n\n(当前无关注项)\n"),
            ("memory/memory.md", "# Long-term Memory\n\n(暂无记忆)\n"),
            ("memory/wisdom.md", "# Wisdom\n\n(跨任务经验沉淀，由 Agent 自动维护)\n"),
        ];

        for (file, default_content) in defaults {
            let path = self.root.join(file);
            if !path.exists() {
                std::fs::write(&path, default_content)
                    .with_context(|| format!("创建默认文件失败: {}", path.display()))?;
            }
        }

        Ok(())
    }

    pub fn read_file(&self, relative: &str, max_chars: usize) -> Option<String> {
        let path = self.root.join(relative);
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                if content.len() > max_chars {
                    Some(content[..max_chars].to_string())
                } else {
                    Some(content)
                }
            }
            Err(_) => None,
        }
    }

    pub fn read_soul(&self) -> Option<String> {
        self.read_file("soul.md", 2000)
    }

    pub fn read_memory(&self) -> Option<String> {
        self.read_file("memory/memory.md", 2000)
    }

    pub fn read_wisdom(&self) -> Option<String> {
        self.read_file("memory/wisdom.md", 1500)
    }

    pub fn read_focus(&self) -> Option<String> {
        self.read_file("focus.md", 3000)
    }

    pub fn has_incomplete_todos(&self) -> (bool, Vec<String>) {
        let focus = match self.read_focus() {
            Some(f) => f,
            None => return (false, vec![]),
        };

        let incomplete: Vec<String> = focus
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                trimmed.starts_with("- [ ]") || trimmed.starts_with("- [/]")
            })
            .map(|l| l.trim().to_string())
            .collect();

        (!incomplete.is_empty(), incomplete)
    }

    pub fn list_skills(&self) -> Vec<(String, String)> {
        let skills_dir = self.root.join("skills");
        let mut skills = Vec::new();

        let entries = match std::fs::read_dir(&skills_dir) {
            Ok(e) => e,
            Err(_) => return skills,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "md") {
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let desc = content
                    .lines()
                    .find(|l| !l.starts_with('#') && !l.trim().is_empty())
                    .unwrap_or("(无描述)")
                    .to_string();

                skills.push((name, desc));
            }
        }

        skills
    }
}
