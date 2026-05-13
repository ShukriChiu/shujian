use crate::config::AppConfig;
use anyhow::Result;

pub fn list_agents(config: &AppConfig) -> Result<()> {
    if config.agents.is_empty() {
        println!("未配置任何 Agent。");
        return Ok(());
    }

    println!("\n📋 已配置的数字员工（共 {} 个）\n", config.agents.len());
    println!("{:<20} {:<15} {:<8} 工作空间", "名称", "模型类别", "纪律");
    println!("{}", "-".repeat(75));

    for agent in &config.agents {
        let category = agent.model_category.as_deref().unwrap_or("default");
        let discipline = if agent.discipline.enforce_todo {
            "✓"
        } else {
            "✗"
        };
        println!(
            "{:<20} {:<15} {:<8} {}",
            agent.name, category, discipline, agent.workspace
        );
        if let Some(desc) = &agent.description {
            println!("  └─ {}", desc);
        }
    }

    if !config.model_categories.is_empty() {
        println!("\n🧠 模型类别");
        println!("{:<15} {:<12} 模型", "类别", "Provider");
        println!("{}", "-".repeat(60));
        for cat in &config.model_categories {
            println!("{:<15} {:<12} {}", cat.name, cat.provider, cat.model);
        }
    }

    if !config.triggers.is_empty() {
        println!("\n⏰ 触发器");
        for t in &config.triggers {
            let agent = t.agent.as_deref().unwrap_or("(默认)");
            let schedule = t.expr.as_deref().unwrap_or("interval");
            println!(
                "  {} → {} ({}: {}) — {}",
                t.name, agent, t.trigger_type, schedule, t.reason
            );
        }
    }

    println!();
    Ok(())
}
