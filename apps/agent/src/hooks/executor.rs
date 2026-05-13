use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use super::event::{HookEvent, HookInput, HookOutput};
use super::registry::{HookHandler, HookHandlerType, HookRegistry};

#[derive(Debug, Clone)]
pub struct HookResult {
    pub event: HookEvent,
    pub outputs: Vec<HookOutput>,
    pub blocked: bool,
    pub block_reason: Option<String>,
}

impl HookResult {
    pub fn allowed() -> Self {
        Self {
            event: HookEvent::SessionStart,
            outputs: vec![],
            blocked: false,
            block_reason: None,
        }
    }
}

pub struct HookExecutor;

impl HookExecutor {
    pub async fn fire(
        registry: &HookRegistry,
        event: HookEvent,
        input: HookInput,
        matcher_value: Option<&str>,
    ) -> Result<HookResult> {
        let matching = registry.find_matching(event, matcher_value);

        if matching.is_empty() {
            return Ok(HookResult {
                event,
                outputs: vec![],
                blocked: false,
                block_reason: None,
            });
        }

        info!(
            event = ?event,
            count = matching.len(),
            "firing hooks"
        );

        let input_json = serde_json::to_string(&input)?;
        let mut outputs = Vec::new();
        let mut blocked = false;
        let mut block_reason = None;

        for registered in &matching {
            for handler in &registered.group.hooks {
                if should_skip_handler(handler, &input) {
                    continue;
                }

                match execute_handler(handler, &input_json).await {
                    Ok(output) => {
                        if !output.r#continue {
                            blocked = true;
                            block_reason = output.stop_reason.clone();
                        }
                        if output.is_blocked() && event.can_block() {
                            blocked = true;
                            block_reason = output.reason.clone().or_else(|| {
                                output
                                    .hook_specific_output
                                    .as_ref()
                                    .and_then(|h| h.permission_decision_reason.clone())
                            });
                        }
                        outputs.push(output);
                    }
                    Err(e) => {
                        warn!(event = ?event, error = %e, "hook execution failed (non-blocking)");
                    }
                }

                if blocked {
                    break;
                }
            }

            if blocked {
                break;
            }
        }

        Ok(HookResult {
            event,
            outputs,
            blocked,
            block_reason,
        })
    }

    pub async fn fire_parallel(
        registry: &HookRegistry,
        event: HookEvent,
        input: HookInput,
        matcher_value: Option<&str>,
    ) -> Result<HookResult> {
        let matching = registry.find_matching(event, matcher_value);

        if matching.is_empty() {
            return Ok(HookResult {
                event,
                outputs: vec![],
                blocked: false,
                block_reason: None,
            });
        }

        let input_json = serde_json::to_string(&input)?;
        let mut handles = Vec::new();

        for registered in &matching {
            for handler in &registered.group.hooks {
                if should_skip_handler(handler, &input) {
                    continue;
                }
                let h = handler.clone();
                let ij = input_json.clone();
                handles.push(tokio::spawn(async move { execute_handler(&h, &ij).await }));
            }
        }

        let mut outputs = Vec::new();
        let mut blocked = false;
        let mut block_reason = None;

        for handle in handles {
            match handle.await {
                Ok(Ok(output)) => {
                    if !output.r#continue {
                        blocked = true;
                        block_reason = output.stop_reason.clone();
                    }
                    if output.is_blocked() && event.can_block() {
                        blocked = true;
                        block_reason = output.reason.clone().or_else(|| {
                            output
                                .hook_specific_output
                                .as_ref()
                                .and_then(|h| h.permission_decision_reason.clone())
                        });
                    }
                    outputs.push(output);
                }
                Ok(Err(e)) => {
                    warn!(event = ?event, error = %e, "parallel hook failed (non-blocking)");
                }
                Err(e) => {
                    warn!(event = ?event, error = %e, "hook task panicked");
                }
            }
        }

        Ok(HookResult {
            event,
            outputs,
            blocked,
            block_reason,
        })
    }
}

async fn execute_handler(handler: &HookHandler, input_json: &str) -> Result<HookOutput> {
    match handler.handler_type {
        HookHandlerType::Command => execute_command(handler, input_json).await,
        HookHandlerType::Http => execute_http(handler, input_json).await,
        HookHandlerType::Prompt | HookHandlerType::Agent => Ok(HookOutput::allow()),
    }
}

async fn execute_command(handler: &HookHandler, input_json: &str) -> Result<HookOutput> {
    let cmd = handler
        .command
        .as_deref()
        .context("command hook missing command field")?;

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning hook command: {}", cmd))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input_json.as_bytes()).await?;
        drop(stdin);
    }

    let timeout = std::time::Duration::from_secs(handler.timeout);
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .with_context(|| format!("hook command timed out after {}s", handler.timeout))?
        .with_context(|| format!("hook command failed: {}", cmd))?;

    let exit_code = output.status.code().unwrap_or(-1);

    match exit_code {
        0 => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.trim().is_empty() {
                Ok(HookOutput::allow())
            } else {
                Ok(serde_json::from_str(stdout.trim()).unwrap_or_else(|_| HookOutput::allow()))
            }
        }
        2 => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(HookOutput::block(stderr.trim().to_string()))
        }
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(cmd = cmd, exit_code = exit_code, stderr = %stderr, "hook non-blocking error");
            Ok(HookOutput::allow())
        }
    }
}

async fn execute_http(handler: &HookHandler, input_json: &str) -> Result<HookOutput> {
    let url = handler
        .url
        .as_deref()
        .context("http hook missing url field")?;

    let client = reqwest::Client::new();
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .body(input_json.to_string());

    if let Some(headers) = &handler.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    let timeout = std::time::Duration::from_secs(handler.timeout);

    let resp = tokio::time::timeout(timeout, req.send())
        .await
        .with_context(|| format!("http hook timed out after {}s", handler.timeout))?
        .with_context(|| format!("http hook request failed: {}", url))?;

    if !resp.status().is_success() {
        warn!(url = url, status = %resp.status(), "http hook non-2xx (non-blocking)");
        return Ok(HookOutput::allow());
    }

    let body = resp.text().await.unwrap_or_default();
    if body.trim().is_empty() {
        return Ok(HookOutput::allow());
    }

    Ok(serde_json::from_str(&body).unwrap_or_else(|_| HookOutput::allow()))
}

fn should_skip_handler(handler: &HookHandler, input: &HookInput) -> bool {
    if let Some(if_pattern) = &handler.r#if
        && let Some(tool_name) = input.event_data.get("tool_name")
    {
        let tool_str = tool_name.as_str().unwrap_or("");
        if !matches_if_pattern(if_pattern, tool_str, input) {
            return true;
        }
    }
    false
}

fn matches_if_pattern(pattern: &str, tool_name: &str, input: &HookInput) -> bool {
    if let Some(paren_start) = pattern.find('(') {
        let prefix = &pattern[..paren_start];
        if prefix != tool_name {
            return false;
        }
        let arg_pattern = pattern[paren_start + 1..].trim_end_matches(')');

        if let Some(tool_input) = input.event_data.get("tool_input") {
            let input_str = serde_json::to_string(tool_input).unwrap_or_default();
            return glob_match(arg_pattern, &input_str);
        }
        return false;
    }

    pattern == tool_name
}

fn glob_match(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return value.starts_with(prefix);
    }
    value.contains(pattern)
}
