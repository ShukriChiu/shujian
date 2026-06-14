# Oura v2 API 字段参考

官方文档：https://cloud.ouraring.com/v2/docs

只记我们实际入库的字段；响应里还有很多辅助字段全部保留在 `raw_*` jsonb，需要时直接 `->> 'xxx'` 查。

## `/v2/usercollection/daily_sleep`

每日一条，是 Oura App 里的"Sleep Score"。

| 字段 | 说明 |
|---|---|
| `day` | 本地日期 YYYY-MM-DD |
| `score` | 总分 0-100 |
| `contributors` | 各维度贡献（deep_sleep/efficiency/latency/rem_sleep/restfulness/timing/total_sleep），每项 0-100 |

## `/v2/usercollection/sleep`

每段睡眠一条，可能一天多条（小睡）。主段 `type == "long_sleep"`。

| 字段 | 说明 |
|---|---|
| `day` | 本地日期 |
| `type` | `long_sleep` / `short_sleep` / `late_nap` |
| `bedtime_start`, `bedtime_end` | 带时区 ISO8601 |
| `total_sleep_duration` | 总睡眠秒数 |
| `deep_sleep_duration`, `rem_sleep_duration`, `light_sleep_duration` | 秒 |
| `awake_time` | 清醒秒数 |
| `latency` | 入睡用时秒 |
| `efficiency` | 0-100 |
| `average_hrv` | 毫秒（RMSSD） |
| `average_heart_rate` | bpm，当 RHR 代理用 |
| `lowest_heart_rate` | bpm |
| `average_breath` | 呼吸频率 |
| `readiness_score_delta`, `sleep_score_delta` | 该段对当日分数的贡献 |
| `heart_rate` | 5 分钟粒度时间序列 `{interval, items, timestamp}` |
| `hrv` | 5 分钟粒度时间序列 |

## `/v2/usercollection/daily_readiness`

| 字段 | 说明 |
|---|---|
| `day`, `score` | — |
| `temperature_deviation` | 当晚体温 vs 个人基线（摄氏度），>0.3 可能发烧苗头 |
| `temperature_trend_deviation` | 7 天趋势偏离 |
| `contributors` | activity_balance/body_temperature/hrv_balance/previous_day_activity/previous_night/recovery_index/resting_heart_rate/sleep_balance |

⚠️ `contributors.resting_heart_rate` 是 0-100 的贡献分，**不是** 实际 RHR。

## `/v2/usercollection/daily_activity`

| 字段 | 说明 |
|---|---|
| `day`, `score` | — |
| `steps` | 步数 |
| `active_calories` | kcal（活动消耗，不含基础代谢） |
| `total_calories` | kcal |
| `equivalent_walking_distance` | 米 |
| `high_activity_time`, `medium_activity_time`, `low_activity_time`, `sedentary_time` | 秒 |
| `non_wear_time` | 未佩戴秒数 |
| `target_calories`, `target_meters` | 当日目标 |
| `contributors` | meet_daily_targets/move_every_hour/recovery_time/stay_active/training_frequency/training_volume |

## `/v2/usercollection/daily_stress`

| 字段 | 说明 |
|---|---|
| `day` | — |
| `stress_high` | 高压累计秒数 |
| `recovery_high` | 高恢复累计秒数 |
| `day_summary` | `restored` / `normal` / `stressful` / `pronounced_stressful` |

## `/v2/usercollection/daily_spo2`

| 字段 | 说明 |
|---|---|
| `day` | — |
| `spo2_percentage.average` | 夜间平均 SpO2 % |

## `/v2/usercollection/daily_resilience`

| 字段 | 说明 |
|---|---|
| `day` | — |
| `level` | `limited` / `adequate` / `solid` / `strong` / `exceptional` |
| `contributors` | sleep_recovery/daytime_recovery/stress |

## `/v2/usercollection/daily_cardiovascular_age`

| 字段 | 说明 |
|---|---|
| `day` | — |
| `vascular_age` | 估算血管年龄（岁） |

## `/v2/usercollection/workout`

事件型，每次训练一条。

| 字段 | 说明 |
|---|---|
| `id` | external_id |
| `activity`, `activity_type` | 运动类型 |
| `intensity` | `easy` / `moderate` / `hard` |
| `source` | `autodetected` / `manual` / `confirmed` |
| `start_datetime`, `end_datetime` | 带时区 |
| `day` | 归属日期 |
| `calories` | kcal |
| `distance` | 米 |
| `label` | 用户标签 |

## `/v2/usercollection/session`

冥想/放松等主动 session。字段类似 workout，`type` 有 `meditation`/`breathing`/`nap`/`relaxation`/`rest`。

## `/v2/usercollection/enhanced_tag`

带标签的事件（咖啡因、酒精、经期、压力事件等）。

| 字段 | 说明 |
|---|---|
| `id` | — |
| `tag_type_code` | 标签类型 |
| `start_time`, `end_time` | — |
| `comment` | 用户备注 |

## `/v2/usercollection/heartrate`

分钟级心率。**数据量大**（睡觉时 5 分钟一个点，白天 live 模式更密）。按需 sync。

| 字段 | 说明 |
|---|---|
| `timestamp` | ISO8601 |
| `bpm` | 整数 |
| `source` | `awake` / `rest` / `sleep` / `workout` / `live` |

## 分页

所有 list 接口响应结构：`{"data": [...], "next_token": null | "..."}`。`next_token` 非空就带上再请一次。本 skill 已处理。

## 请求限制

- 速率：默认 300 req/5min、5000 req/day。连续拉 1 年全量也就几十次请求。
- Token：PAT 永不过期，除非你在后台手动 revoke。
