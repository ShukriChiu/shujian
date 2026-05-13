use std::collections::VecDeque;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::Value;

const DOOM_LOOP_THRESHOLD: usize = 3;
const MAX_HISTORY: usize = 50;
const MAX_OUTPUT_CHARS: usize = 8000;
const FILE_SPILL_THRESHOLD: usize = 12000;

#[derive(Debug, Clone, PartialEq)]
pub enum LoopStatus {
    Ok,
    Warning(String),
    Block(String),
}

pub struct LoopDetector {
    history: VecDeque<u64>,
}

impl LoopDetector {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(MAX_HISTORY),
        }
    }

    pub fn record_and_check(&mut self, tool_name: &str, args: &Value) -> LoopStatus {
        let hash = Self::hash_call(tool_name, args);

        self.history.push_back(hash);
        if self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }

        let consecutive = self
            .history
            .iter()
            .rev()
            .take_while(|&&h| h == hash)
            .count();

        if consecutive >= DOOM_LOOP_THRESHOLD {
            LoopStatus::Block(format!(
                "检测到死循环：工具 `{}` 被连续调用 {} 次且参数相同。已中断执行。请换一种方式解决问题。",
                tool_name, consecutive
            ))
        } else if consecutive >= DOOM_LOOP_THRESHOLD - 1 {
            LoopStatus::Warning(format!(
                "警告：工具 `{}` 已连续调用 {} 次且参数相同，如果再重复将被中断。",
                tool_name, consecutive
            ))
        } else {
            LoopStatus::Ok
        }
    }

    fn hash_call(tool_name: &str, args: &Value) -> u64 {
        let mut hasher = DefaultHasher::new();
        tool_name.hash(&mut hasher);
        let stable = stable_json(args);
        stable.hash(&mut hasher);
        hasher.finish()
    }
}

fn stable_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut pairs: Vec<_> = map.iter().collect();
            pairs.sort_by_key(|(k, _)| (*k).clone());
            let inner: Vec<String> = pairs
                .into_iter()
                .map(|(k, v)| format!("{}:{}", k, stable_json(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        _ => v.to_string(),
    }
}

pub struct OutputTruncator;

impl OutputTruncator {
    pub fn truncate(output: String, workspace: &std::path::Path) -> String {
        if output.len() <= MAX_OUTPUT_CHARS {
            return output;
        }

        if output.len() > FILE_SPILL_THRESHOLD {
            let spill_dir = workspace.join("workspace/.tool_output");
            if std::fs::create_dir_all(&spill_dir).is_ok() {
                let filename = format!(
                    "output_{}.txt",
                    chrono::Local::now().format("%Y%m%d_%H%M%S_%3f")
                );
                let path = spill_dir.join(&filename);
                if std::fs::write(&path, &output).is_ok() {
                    return format!(
                        "{}...\n\n[输出过长（{} 字节），完整内容已保存到 workspace/.tool_output/{}，用 read_file 查看]",
                        &output[..MAX_OUTPUT_CHARS.min(2000)],
                        output.len(),
                        filename
                    );
                }
            }
        }

        format!(
            "{}...\n[截断：共 {} 字节，只显示前 {}]",
            &output[..MAX_OUTPUT_CHARS],
            output.len(),
            MAX_OUTPUT_CHARS
        )
    }
}

pub fn try_repair_tool_name(name: &str, known_tools: &[String]) -> Option<String> {
    let lower = name.to_lowercase();
    if known_tools.iter().any(|t| t == &lower) {
        return Some(lower);
    }

    let no_dash = lower.replace('-', "_");
    if known_tools.iter().any(|t| t == &no_dash) {
        return Some(no_dash);
    }

    None
}

pub struct TokenTracker {
    pub total_prompt: u64,
    pub total_completion: u64,
    pub budget: Option<u64>,
}

impl TokenTracker {
    pub fn new(budget: Option<u64>) -> Self {
        Self {
            total_prompt: 0,
            total_completion: 0,
            budget,
        }
    }

    pub fn record(&mut self, prompt: u32, completion: u32) {
        self.total_prompt += prompt as u64;
        self.total_completion += completion as u64;
    }

    pub fn total(&self) -> u64 {
        self.total_prompt + self.total_completion
    }

    pub fn over_budget(&self) -> bool {
        self.budget.is_some_and(|b| self.total() > b)
    }

    pub fn summary(&self) -> String {
        format!(
            "token 用量：prompt={}, completion={}, total={}{}",
            self.total_prompt,
            self.total_completion,
            self.total(),
            self.budget
                .map(|b| format!(", budget={}", b))
                .unwrap_or_default()
        )
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PermissionRule {
    pub tool: String,
    #[serde(default)]
    pub pattern: Option<String>,
    pub action: PermissionAction,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionAction {
    Allow,
    Deny,
    Ask,
}

pub struct PermissionChecker {
    rules: Vec<PermissionRule>,
}

impl PermissionChecker {
    pub fn new(rules: Vec<PermissionRule>) -> Self {
        Self { rules }
    }

    pub fn check(&self, tool_name: &str, args: &Value) -> PermissionAction {
        for rule in self.rules.iter().rev() {
            if !glob_match(&rule.tool, tool_name) {
                continue;
            }

            if let Some(pattern) = &rule.pattern {
                let arg_str = args.to_string();
                if !glob_match(pattern, &arg_str) {
                    continue;
                }
            }

            return rule.action.clone();
        }

        PermissionAction::Allow
    }
}

fn glob_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" {
        return true;
    }

    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            let (prefix, suffix) = (parts[0], parts[1]);
            return text.starts_with(prefix) && text.ends_with(suffix);
        }
    }

    pattern == text
}
