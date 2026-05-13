use std::collections::HashMap;
use tracing::debug;

use super::types::LoadedSkill;

pub struct SkillResolver {
    skills: Vec<LoadedSkill>,
    name_index: HashMap<String, usize>,
}

impl SkillResolver {
    pub fn new(skills: Vec<LoadedSkill>) -> Self {
        let name_index: HashMap<String, usize> = skills
            .iter()
            .enumerate()
            .map(|(i, s)| (s.name.clone(), i))
            .collect();
        Self { skills, name_index }
    }

    pub fn by_name(&self, name: &str) -> Option<&LoadedSkill> {
        self.name_index.get(name).and_then(|&i| self.skills.get(i))
    }

    pub fn by_slash_command(&self, command: &str) -> Option<&LoadedSkill> {
        let name = command.strip_prefix('/').unwrap_or(command);
        self.by_name(name)
    }

    pub fn user_invocable(&self) -> Vec<&LoadedSkill> {
        self.skills
            .iter()
            .filter(|s| s.is_user_invocable())
            .collect()
    }

    pub fn model_invocable(&self) -> Vec<&LoadedSkill> {
        self.skills
            .iter()
            .filter(|s| s.is_model_invocable())
            .collect()
    }

    pub fn resolve_for_context(
        &self,
        user_prompt: &str,
        active_files: &[String],
    ) -> Vec<&LoadedSkill> {
        let mut matched = Vec::new();

        for skill in &self.skills {
            if !skill.is_model_invocable() {
                continue;
            }

            let desc_match = skill
                .frontmatter
                .description
                .as_deref()
                .map(|d| fuzzy_match(d, user_prompt))
                .unwrap_or(false);

            let path_match =
                active_files.is_empty() || active_files.iter().any(|f| skill.matches_path(f));

            if desc_match && path_match {
                matched.push(skill);
            }
        }

        debug!(
            "resolved {} skills for prompt ({}... + {} files)",
            matched.len(),
            &user_prompt[..user_prompt.len().min(50)],
            active_files.len()
        );

        matched
    }

    pub fn render_instructions(
        &self,
        skill: &LoadedSkill,
        arguments: &str,
        session_id: &str,
    ) -> String {
        let mut output = skill.instructions.clone();

        let args: Vec<&str> = arguments.split_whitespace().collect();

        output = output.replace("$ARGUMENTS", arguments);
        for (i, arg) in args.iter().enumerate() {
            output = output.replace(&format!("$ARGUMENTS[{}]", i), arg);
            output = output.replace(&format!("${}", i), arg);
        }

        output = output.replace("${CLAUDE_SESSION_ID}", session_id);
        output = output.replace("${CLAUDE_SKILL_DIR}", &skill.directory.to_string_lossy());

        if !arguments.is_empty() && !skill.instructions.contains("$ARGUMENTS") {
            output.push_str(&format!("\n\nARGUMENTS: {}", arguments));
        }

        output
    }

    pub fn all_skills(&self) -> &[LoadedSkill] {
        &self.skills
    }

    pub fn count(&self) -> usize {
        self.skills.len()
    }
}

fn fuzzy_match(description: &str, prompt: &str) -> bool {
    let desc_lower = description.to_lowercase();
    let prompt_lower = prompt.to_lowercase();

    let desc_words: Vec<&str> = desc_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2)
        .collect();

    let match_count = desc_words
        .iter()
        .filter(|w| prompt_lower.contains(**w))
        .count();

    if desc_words.is_empty() {
        return false;
    }

    let ratio = match_count as f64 / desc_words.len() as f64;
    ratio > 0.3
}
