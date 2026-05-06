use anyhow::Result;
use crate::config::AppConfig;

pub async fn show_status(config: &AppConfig) -> Result<()> {
    let url = format!("http://{}/api/status", config.server.bind);

    println!("正在连接 {}...\n", url);

    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                let text = resp.text().await?;
                let status: serde_json::Value = serde_json::from_str(&text)?;

                println!("Daemon 状态");
                println!("  运行时间: {}s", status["uptime_secs"].as_u64().unwrap_or(0));
                println!("  已完成任务: {}", status["tasks_completed"].as_u64().unwrap_or(0));
                println!("  失败任务: {}", status["tasks_failed"].as_u64().unwrap_or(0));
                println!("  最大并发: {}", status["max_concurrent"].as_u64().unwrap_or(0));

                if let Some(tasks) = status["active_tasks"].as_array() {
                    if tasks.is_empty() {
                        println!("  当前任务: 无");
                    } else {
                        println!("  当前任务:");
                        for t in tasks {
                            println!("    [{}] {} — {} ({})",
                                t["id"].as_str().unwrap_or("?"),
                                t["agent"].as_str().unwrap_or("?"),
                                t["message"].as_str().unwrap_or("?"),
                                t["started_at"].as_str().unwrap_or("?"),
                            );
                        }
                    }
                }
            } else {
                println!("服务响应异常: {}", resp.status());
            }
        }
        Err(_) => {
            println!("无法连接到 daemon ({})", url);
            println!("请先运行: shujian-agent daemon");
        }
    }

    Ok(())
}
