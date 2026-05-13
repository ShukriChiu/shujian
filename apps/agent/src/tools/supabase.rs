use anyhow::{Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use super::{Tool, ToolContext};

const MAX_ROWS_DISPLAY: usize = 50;

pub struct SupabaseQueryTool;

#[async_trait]
impl Tool for SupabaseQueryTool {
    fn name(&self) -> &str {
        "query_supabase"
    }

    fn description(&self) -> &str {
        "在 Supabase 数仓上执行 SQL 查询（只读 SELECT）。返回 JSON 格式结果。用于查询商品、销售、库存、客户等数据。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "SQL 查询语句（只支持 SELECT）"}
            },
            "required": ["sql"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String> {
        let sql = args["sql"].as_str().context("缺少 sql 参数")?;

        let trimmed = sql.trim().to_uppercase();
        if !trimmed.starts_with("SELECT") && !trimmed.starts_with("WITH") {
            anyhow::bail!(
                "只允许 SELECT / WITH 查询，拒绝执行: {}",
                &sql[..sql.len().min(100)]
            );
        }

        let url = ctx.supabase_url.as_deref().context("未配置 SUPABASE_URL")?;
        let key = ctx.supabase_key.as_deref().context("未配置 SUPABASE_KEY")?;

        let client = Client::new();
        let resp = client
            .post(format!("{}/rest/v1/rpc/exec_sql", url))
            .header("apikey", key)
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .json(&json!({"query": sql}))
            .send()
            .await
            .context("Supabase 请求失败")?;

        let status = resp.status();
        let text = resp.text().await.context("读取 Supabase 响应失败")?;

        if !status.is_success() {
            return Ok(format!(
                "查询失败 ({}): {}",
                status,
                &text[..text.len().min(500)]
            ));
        }

        let rows: Value = serde_json::from_str(&text).unwrap_or(json!(text));

        if let Some(arr) = rows.as_array()
            && arr.len() > MAX_ROWS_DISPLAY
        {
            let truncated: Vec<&Value> = arr.iter().take(MAX_ROWS_DISPLAY).collect();
            return Ok(format!(
                "{}\n...[共 {} 行，只显示前 {}]",
                serde_json::to_string_pretty(&truncated)?,
                arr.len(),
                MAX_ROWS_DISPLAY
            ));
        }

        Ok(serde_json::to_string_pretty(&rows).unwrap_or(text))
    }
}
