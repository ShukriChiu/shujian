use std::path::Path;

use anyhow::{Context, Result};
use tracing::info;

use crate::types::agent::AgentDefinition;

use super::built_in::get_built_in_agents;

#[derive(Debug, serde::Deserialize)]
struct AgentToml {
    agent: AgentDefinition,
}

pub async fn load_agents(agents_dir: &Path) -> Result<Vec<AgentDefinition>> {
    let mut agents = get_built_in_agents();
    info!(count = agents.len(), "loaded built-in agents");

    if agents_dir.is_dir() {
        let mut entries = tokio::fs::read_dir(agents_dir)
            .await
            .context("reading agents dir")?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "toml") {
                match load_agent_file(&path).await {
                    Ok(def) => {
                        info!(agent_type = %def.agent_type, path = %path.display(), "loaded custom agent");
                        agents.push(def);
                    }
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "failed to load agent definition");
                    }
                }
            }
        }
    }

    Ok(agents)
}

async fn load_agent_file(path: &Path) -> Result<AgentDefinition> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("reading {}", path.display()))?;

    let parsed: AgentToml =
        toml::from_str(&content).with_context(|| format!("parsing {}", path.display()))?;

    Ok(parsed.agent)
}
