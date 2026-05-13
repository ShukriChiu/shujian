/// Rule matching logic for the permission system.
///
/// Supports glob patterns and tool-specific specifiers following
/// Claude Code's permission rule syntax:
///   - `Bash` — matches all Bash commands
///   - `Bash(npm run *)` — matches commands starting with "npm run "
///   - `Read(./.env)` — matches reading .env in current directory
///   - `Edit(/src/**/*.ts)` — matches TypeScript edits under /src/
///   - `WebFetch(domain:example.com)` — matches fetch to example.com
///   - `mcp__server__tool` — matches specific MCP tool
///   - `Agent(Explore)` — matches agent spawning

/// Parse a rule specifier into (tool_name, optional_pattern).
pub fn parse_specifier(specifier: &str) -> (&str, Option<&str>) {
    if let Some(open) = specifier.find('(') {
        if specifier.ends_with(')') {
            let tool = &specifier[..open];
            let pattern = &specifier[open + 1..specifier.len() - 1];
            return (tool, Some(pattern));
        }
    }

    if specifier.contains("__") {
        return (specifier, None);
    }

    (specifier, None)
}

/// Check if a tool call matches a permission rule specifier.
pub fn matches_rule(specifier: &str, tool_name: &str, tool_input: &str) -> bool {
    let (rule_tool, pattern) = parse_specifier(specifier);

    if rule_tool.contains("__") {
        return matches_mcp_specifier(specifier, tool_name);
    }

    if !tool_name.eq_ignore_ascii_case(rule_tool) {
        return false;
    }

    match pattern {
        None | Some("*") => true,
        Some(pat) => match_pattern(pat, tool_input, rule_tool),
    }
}

/// Match an MCP tool specifier: mcp__server or mcp__server__tool.
fn matches_mcp_specifier(specifier: &str, tool_name: &str) -> bool {
    let spec_parts: Vec<&str> = specifier.split("__").collect();
    let tool_parts: Vec<&str> = tool_name.split("__").collect();

    if spec_parts.len() < 2 || tool_parts.len() < 2 {
        return false;
    }

    if spec_parts[0] != "mcp" || tool_parts[0] != "mcp" {
        return false;
    }

    if spec_parts[1] != tool_parts[1] {
        return false;
    }

    if spec_parts.len() == 2 {
        return true;
    }

    if spec_parts.len() == 3 && tool_parts.len() == 3 {
        return glob_match(spec_parts[2], tool_parts[2]);
    }

    false
}

/// Match a pattern against input, with tool-specific logic.
fn match_pattern(pattern: &str, input: &str, tool: &str) -> bool {
    match tool.to_lowercase().as_str() {
        "bash" => match_bash_pattern(pattern, input),
        "read" | "edit" | "write" => match_path_pattern(pattern, input),
        "webfetch" => match_web_pattern(pattern, input),
        "agent" => input.eq_ignore_ascii_case(pattern),
        _ => glob_match(pattern, input),
    }
}

/// Match a Bash command pattern with glob support.
/// Shell operators like `&&` are handled: a prefix match rule like
/// `Bash(safe-cmd *)` won't match `safe-cmd && other-cmd`.
fn match_bash_pattern(pattern: &str, command: &str) -> bool {
    let command = command.trim();

    if command.contains("&&") || command.contains("||") || command.contains(';') {
        let parts = split_compound_command(command);
        if parts.len() > 1 {
            return false;
        }
    }

    glob_match(pattern, command)
}

/// Split a compound shell command into individual commands.
fn split_compound_command(command: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut last = 0;
    let bytes = command.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'&' && i + 1 < bytes.len() && bytes[i + 1] == b'&' {
            parts.push(&command[last..i]);
            i += 2;
            last = i;
        } else if bytes[i] == b'|' && i + 1 < bytes.len() && bytes[i + 1] == b'|' {
            parts.push(&command[last..i]);
            i += 2;
            last = i;
        } else if bytes[i] == b';' {
            parts.push(&command[last..i]);
            i += 1;
            last = i;
        } else {
            i += 1;
        }
    }

    if last < command.len() {
        parts.push(&command[last..]);
    }

    parts
}

/// Match a file path pattern (gitignore-style).
fn match_path_pattern(pattern: &str, path: &str) -> bool {
    let normalized_path = path.replace('\\', "/");
    let normalized_pattern = pattern.replace('\\', "/");

    glob_match(&normalized_pattern, &normalized_path)
}

/// Match a WebFetch pattern (supports domain: prefix).
fn match_web_pattern(pattern: &str, url: &str) -> bool {
    if let Some(domain) = pattern.strip_prefix("domain:") {
        let url_lower = url.to_lowercase();
        let domain_lower = domain.to_lowercase();

        if let Some(host_start) = url_lower.find("://") {
            let after_proto = &url_lower[host_start + 3..];
            let host_end = after_proto.find('/').unwrap_or(after_proto.len());
            let host = &after_proto[..host_end];
            let host_no_port = host.split(':').next().unwrap_or(host);

            return host_no_port == domain_lower
                || host_no_port.ends_with(&format!(".{}", domain_lower));
        }
        return false;
    }

    glob_match(pattern, url)
}

/// Simple glob matching supporting `*` (single segment) and `**` (recursive).
pub fn glob_match(pattern: &str, input: &str) -> bool {
    if pattern == "*" {
        return true;
    }

    if !pattern.contains('*') {
        return pattern == input;
    }

    if pattern.contains("**") {
        return glob_match_double_star(pattern, input);
    }

    let parts: Vec<&str> = pattern.split('*').collect();

    if parts.len() == 2 {
        let prefix = parts[0];
        let suffix = parts[1];

        if !prefix.is_empty() && !input.starts_with(prefix) {
            return false;
        }
        if !suffix.is_empty() && !input.ends_with(suffix) {
            return false;
        }

        if prefix.ends_with(' ') && !input[prefix.len()..].is_empty() {
            return input.len() >= prefix.len();
        }

        return input.len() >= prefix.len() + suffix.len();
    }

    wildcard_match(pattern, input)
}

fn glob_match_double_star(pattern: &str, input: &str) -> bool {
    let regex_str = pattern
        .replace('.', "\\.")
        .replace("**/", "(.*/)?")
        .replace("**", ".*")
        .replace('*', "[^/]*");

    let full_pattern = format!("^{regex_str}$");

    regex::Regex::new(&full_pattern)
        .map(|re| re.is_match(input))
        .unwrap_or(false)
}

fn wildcard_match(pattern: &str, input: &str) -> bool {
    let regex_str = pattern.replace('.', "\\.").replace('*', ".*");

    let full_pattern = format!("^{regex_str}$");

    regex::Regex::new(&full_pattern)
        .map(|re| re.is_match(input))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_specifier() {
        assert_eq!(parse_specifier("Bash"), ("Bash", None));
        assert_eq!(
            parse_specifier("Bash(npm run *)"),
            ("Bash", Some("npm run *"))
        );
        assert_eq!(parse_specifier("Read(./.env)"), ("Read", Some("./.env")));
        assert_eq!(parse_specifier("mcp__puppeteer"), ("mcp__puppeteer", None));
    }

    #[test]
    fn test_bash_matching() {
        assert!(matches_rule("Bash", "Bash", "anything"));
        assert!(matches_rule("Bash(*)", "Bash", "anything"));
        assert!(matches_rule("Bash(npm run *)", "Bash", "npm run build"));
        assert!(matches_rule(
            "Bash(npm run *)",
            "Bash",
            "npm run test --coverage"
        ));
        assert!(!matches_rule("Bash(npm run *)", "Bash", "npm install"));
    }

    #[test]
    fn test_bash_compound_safety() {
        assert!(!matches_rule(
            "Bash(safe-cmd *)",
            "Bash",
            "safe-cmd arg && rm -rf /"
        ));
        assert!(matches_rule("Bash(safe-cmd *)", "Bash", "safe-cmd --help"));
    }

    #[test]
    fn test_path_matching() {
        assert!(matches_rule("Read(./.env)", "Read", "./.env"));
        assert!(matches_rule(
            "Edit(/src/**/*.ts)",
            "Edit",
            "/src/components/App.ts"
        ));
        assert!(!matches_rule(
            "Edit(/src/**/*.ts)",
            "Edit",
            "/docs/readme.md"
        ));
    }

    #[test]
    fn test_web_matching() {
        assert!(matches_rule(
            "WebFetch(domain:example.com)",
            "WebFetch",
            "https://example.com/api/v1"
        ));
        assert!(matches_rule(
            "WebFetch(domain:example.com)",
            "WebFetch",
            "https://api.example.com/data"
        ));
        assert!(!matches_rule(
            "WebFetch(domain:example.com)",
            "WebFetch",
            "https://evil.com/example.com"
        ));
    }

    #[test]
    fn test_mcp_matching() {
        assert!(matches_rule(
            "mcp__puppeteer",
            "mcp__puppeteer__navigate",
            ""
        ));
        assert!(matches_rule(
            "mcp__puppeteer__puppeteer_navigate",
            "mcp__puppeteer__puppeteer_navigate",
            ""
        ));
        assert!(!matches_rule(
            "mcp__puppeteer__puppeteer_navigate",
            "mcp__puppeteer__puppeteer_click",
            ""
        ));
    }

    #[test]
    fn test_agent_matching() {
        assert!(matches_rule("Agent(Explore)", "Agent", "Explore"));
        assert!(!matches_rule("Agent(Explore)", "Agent", "Plan"));
    }
}
