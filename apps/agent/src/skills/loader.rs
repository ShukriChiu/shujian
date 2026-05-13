use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

use super::types::{LoadedSkill, SkillFrontmatter, SkillSource};

pub struct SkillLoader {
    personal_dir: PathBuf,
    project_dirs: Vec<PathBuf>,
    plugin_dirs: Vec<PathBuf>,
}

impl SkillLoader {
    pub fn new(project_root: &Path) -> Self {
        let home = dirs_home();
        Self {
            personal_dir: home.join(".claude").join("skills"),
            project_dirs: vec![
                project_root.join(".claude").join("skills"),
                project_root.join(".agents").join("skills"),
            ],
            plugin_dirs: Vec::new(),
        }
    }

    pub fn add_plugin_dir(&mut self, dir: PathBuf) {
        self.plugin_dirs.push(dir);
    }

    pub fn add_project_dir(&mut self, dir: PathBuf) {
        self.project_dirs.push(dir.join(".claude").join("skills"));
    }

    pub fn discover_all(&self) -> Vec<LoadedSkill> {
        let mut skills = Vec::new();
        let mut seen_names = std::collections::HashSet::new();

        for dir in &self.project_dirs {
            if dir.exists() {
                for skill in scan_skills_dir(dir, SkillSource::Project) {
                    if seen_names.insert(skill.name.clone()) {
                        skills.push(skill);
                    }
                }
            }
        }

        if self.personal_dir.exists() {
            for skill in scan_skills_dir(&self.personal_dir, SkillSource::Personal) {
                if seen_names.insert(skill.name.clone()) {
                    skills.push(skill);
                }
            }
        }

        for plugin_dir in &self.plugin_dirs {
            if plugin_dir.exists() {
                for skill in scan_skills_dir(plugin_dir, SkillSource::Plugin) {
                    if seen_names.insert(skill.name.clone()) {
                        skills.push(skill);
                    }
                }
            }
        }

        info!("discovered {} skills", skills.len());
        skills
    }

    pub fn load_by_name(&self, name: &str) -> Option<LoadedSkill> {
        self.discover_all().into_iter().find(|s| s.name == name)
    }
}

fn scan_skills_dir(dir: &Path, source: SkillSource) -> Vec<LoadedSkill> {
    let mut skills = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return skills;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            if path.file_name().map_or(false, |f| f == "SKILL.md") {
                if let Some(skill) = load_skill_file(&path, source) {
                    skills.push(skill);
                }
            }
            continue;
        }

        let skill_md = path.join("SKILL.md");
        if skill_md.exists() {
            if let Some(skill) = load_skill_file(&skill_md, source) {
                skills.push(skill);
            }
        }
    }

    skills
}

fn load_skill_file(path: &Path, source: SkillSource) -> Option<LoadedSkill> {
    let content = std::fs::read_to_string(path).ok()?;
    let (frontmatter, instructions) = parse_skill_md(&content);

    let directory = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();

    let name = frontmatter
        .name
        .clone()
        .or_else(|| {
            directory
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "unnamed".into());

    let supporting_files = find_supporting_files(&directory);

    debug!("loaded skill '{}' from {}", name, path.display());

    Some(LoadedSkill {
        name,
        source,
        frontmatter,
        instructions,
        directory,
        supporting_files,
    })
}

fn parse_skill_md(content: &str) -> (SkillFrontmatter, String) {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return (default_frontmatter(), trimmed.to_string());
    }

    let after_first = &trimmed[3..];
    let Some(end_idx) = after_first.find("---") else {
        return (default_frontmatter(), trimmed.to_string());
    };

    let yaml_str = &after_first[..end_idx].trim();
    let instructions = after_first[end_idx + 3..].trim().to_string();

    let frontmatter: SkillFrontmatter = serde_yaml_lite_parse(yaml_str).unwrap_or_else(|e| {
        warn!("failed to parse skill frontmatter: {}", e);
        default_frontmatter()
    });

    (frontmatter, instructions)
}

fn serde_yaml_lite_parse(yaml: &str) -> Result<SkillFrontmatter> {
    let mut fm = default_frontmatter();

    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');

        match key {
            "name" => fm.name = Some(value.to_string()),
            "description" => fm.description = Some(value.to_string()),
            "argument-hint" => fm.argument_hint = Some(value.to_string()),
            "disable-model-invocation" => {
                fm.disable_model_invocation = value == "true";
            }
            "user-invocable" => {
                fm.user_invocable = value != "false";
            }
            "allowed-tools" => fm.allowed_tools = Some(value.to_string()),
            "model" => fm.model = Some(value.to_string()),
            "effort" => fm.effort = Some(value.to_string()),
            "context" => {
                if value == "fork" {
                    fm.context = Some(super::types::SkillContext::Fork);
                }
            }
            "agent" => fm.agent = Some(value.to_string()),
            "shell" => fm.shell = Some(value.to_string()),
            "paths" => {
                fm.paths = Some(super::types::SkillPaths::Single(value.to_string()));
            }
            _ => {}
        }
    }

    Ok(fm)
}

fn default_frontmatter() -> SkillFrontmatter {
    SkillFrontmatter {
        name: None,
        description: None,
        argument_hint: None,
        disable_model_invocation: false,
        user_invocable: true,
        allowed_tools: None,
        model: None,
        effort: None,
        context: None,
        agent: None,
        paths: None,
        shell: None,
    }
}

fn find_supporting_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if fname == "SKILL.md" {
            continue;
        }

        if path.is_file() {
            files.push(path);
        } else if path.is_dir() {
            collect_dir_files(&path, &mut files);
        }
    }

    files
}

fn collect_dir_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            out.push(p);
        } else if p.is_dir() {
            collect_dir_files(&p, out);
        }
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}
