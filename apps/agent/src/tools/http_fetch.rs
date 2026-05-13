use anyhow::{Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use super::{Tool, ToolContext};

const MAX_RESPONSE: usize = 20_000;

pub struct HttpFetchTool;

#[async_trait]
impl Tool for HttpFetchTool {
    fn name(&self) -> &str {
        "http_fetch"
    }

    fn description(&self) -> &str {
        "发起 HTTP 请求。支持 GET 和 POST，可发送 JSON body。用于调用外部 API（如 union-agent OCR 服务）。"
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "请求 URL"},
                "method": {"type": "string", "description": "HTTP 方法: GET 或 POST，默认 GET"},
                "body": {"type": "object", "description": "POST 请求的 JSON body（可选）"},
                "headers": {"type": "object", "description": "额外请求头（可选）"}
            },
            "required": ["url"]
        })
    }

    async fn execute(&self, args: Value, _ctx: &ToolContext) -> Result<String> {
        let url = args["url"].as_str().context("缺少 url 参数")?;
        let method = args["method"].as_str().unwrap_or("GET").to_uppercase();

        let client = Client::new();
        let mut req = match method.as_str() {
            "POST" => client.post(url),
            _ => client.get(url),
        };

        if let Some(headers) = args["headers"].as_object() {
            for (k, v) in headers {
                if let Some(val) = v.as_str() {
                    req = req.header(k.as_str(), val);
                }
            }
        }

        if method == "POST"
            && let Some(body) = args.get("body")
        {
            req = req.json(body);
        }

        let resp = req
            .send()
            .await
            .with_context(|| format!("HTTP 请求失败: {}", url))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .with_context(|| format!("读取响应体失败: {}", url))?;

        let truncated = if text.len() > MAX_RESPONSE {
            format!("{}...[截断，共 {} 字节]", &text[..MAX_RESPONSE], text.len())
        } else {
            text
        };

        Ok(format!("HTTP {} {}\n{}", status, url, truncated))
    }
}
