//! Shujian agent runtime. Many modules ship ahead of full orchestration
//! wiring; until every subsystem is exercised from CLI/server entrypoints,
//! `rustc` would emit hundreds of `dead_code` diagnostics. CI runs
//! `clippy -D warnings`, so we scope the suppression to this crate root only.
#![allow(dead_code)]

mod agent;
mod audit;
mod cli;
mod compaction;
mod config;
mod coordinator;
mod cost;
mod hitl;
mod hooks;
mod llm;
mod mcp;
mod memory;
mod permissions;
mod runtime;
mod server;
mod skills;
mod streaming;
mod tools;
mod types;
mod workspace;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "shujian-agent", about = "友联数字员工 Rust 运行时", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// 配置文件路径
    #[arg(short, long, default_value = "config.toml")]
    config: PathBuf,
}

#[derive(Subcommand)]
enum Commands {
    /// 交互式对话模式
    Agent {
        /// 指定 Agent 名称（默认使用第一个）
        #[arg(short, long)]
        name: Option<String>,
    },
    /// 后台守护进程（HTTP 服务 + 全部 Agent 触发器）
    Daemon,
    /// 查看 daemon 运行状态
    Status,
    /// 列出所有已配置的 Agent
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                // SAFETY: called before any threads are spawned
                unsafe { std::env::set_var(key.trim(), value.trim()) };
            }
        }
    }

    let config = config::AppConfig::load(&cli.config)?;

    match cli.command {
        Commands::Agent { name } => cli::agent::run_interactive(&config, name.as_deref()).await,
        Commands::Daemon => cli::daemon::run_daemon(&config).await,
        Commands::Status => cli::status::show_status(&config).await,
        Commands::List => cli::list::list_agents(&config),
    }
}
