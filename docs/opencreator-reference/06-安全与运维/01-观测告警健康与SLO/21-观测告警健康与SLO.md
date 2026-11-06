# 21：观测、告警、健康与 SLO

## 职责

- `opencreator-frontend` 用 Sentry/PostHog 记录浏览器异常与用户行为，并展示连接状态。
- `opencreator-publisher` 生成应用级 `trace_id`，提供 health/readiness 与 Consumer 聚合探活。
- `opencreator-consumer` 延续 `trace_id`，记录 queue delay，暴露执行引擎 backlog/stale/outbox 指标和 readiness。
- `opencreator-ai` 输出结构化日志、队列事件与 worker heartbeat，并用飞书发送模型/回调异常通知。
- `opencreator-agent` 使用 Sentry/PostHog、性能 span 与业务事件，提供基础 `/health` 和本机 drain 状态。

## 入口

- Publisher：`/health`、`/health2`、`/health/consumer`、`/readyz`。
- Consumer：`/health`、`/readyz`、`/ops/consumer/status`。
- AI：`/health`、`/readyz`；后者检查 Mongo、Redis 并返回 worker heartbeat。
- Agent：`/health`；蓝绿控制端点仅 localhost 可访问。
- Frontend：Sentry 初始化、PostHog provider、WebSocket 状态与性能埋点。

## 主链

```text
用户请求
  → Publisher TraceIDMiddleware 新造 trace_id
  → 响应 X-Trace-ID + 命令消息 trace_id
  → Consumer ContextVar / Sentry tag / 日志
  → AI task trace_id 与 callback 日志
  → 用户报障时按 trace_id / flow_task_id 反查
```

`flow.queue_delay` 只覆盖 Publisher publish 到 Consumer 领取；不覆盖厂商执行、callback、Outbox、RabbitMQ、WebSocket 和产物可用。健康检查只判断实例/依赖能否接新活，也不是用户旅程成功率。

## 关键状态/消息

- Publisher `/readyz`：维护文件存在时 `draining` 503，否则返回 active WebSocket 数。
- Consumer `/readyz`：`DRAINING/STOPPED` 返回 503；backlog/stale 阈值仅在配置大于 0 时生效，0 表示关闭该门槛。
- AI `/readyz`：Mongo 与 Redis 都通才 ready；worker heartbeat 被返回但当前不参与 ready 布尔值。
- Agent `/health` 仅返回进程存活；drain/active run 信息在 localhost 控制端点。
- 飞书发送成功需同时满足 HTTP 成功和响应 `code=0`；告警通知 ACK 不等于故障已恢复。
- `trace_id` 是应用相关 ID；Publisher 现码覆盖生成，不是已证的 W3C 父子 span。

## 关键源码链接

- [Frontend Sentry 入口](../../../../../opencreate/opencreator-frontend/src/main.tsx)
- [Frontend PostHog Provider](../../../../../opencreate/opencreator-frontend/src/provider/usePostHogProvider.tsx)
- [Publisher trace 中间件](../../../../../opencreate/opencreator-publisher/middleware/trace_id_middlewares.py)
- [Publisher 健康端点](../../../../../opencreate/opencreator-publisher/main.py)
- [Consumer trace 上下文](../../../../../opencreate/opencreator-consumer/utils/trace_context.py)
- [Consumer 健康与排空](../../../../../opencreate/opencreator-consumer/main.py)
- [AI 健康端点](../../../../../opencreate/opencreator-ai/apps/api/src/routes/health.ts)
- [AI worker heartbeat 与告警装配](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts)
- [AI 飞书告警客户端](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)
- [Agent API 健康与排空](../../../../../opencreate/opencreator-agent/creato/api/server.py)
- [Agent Sentry](../../../../../opencreate/opencreator-agent/creato/sentry.py)

## 跨仓边界

- 各仓健康端点语义不同，不能用一个 `/health` 名称假定检查内容一致。
- Sentry issue 是采样诊断信号，不是全量失败分母；PostHog 事件也不能直接当 SLO。
- Publisher/Consumer 的相关 ID 可对日志，AI/Agent 还有各自事件与 trace 字段，尚无证据证明五仓形成统一 span tree。
- 告警 Owner 应落到实际主责仓：入口/回灯归 Publisher，DAG/积压归 Consumer，厂商/回调归 AI，Agent SSE 归 Agent，浏览器体验归 Frontend。

## 遗留/未启用

- 现码未见正式用户旅程 SLI、目标值、错误预算与统一告警 Owner/Runbook。
- OTel/Prometheus 依赖或词汇存在，不等于 exporter、scrape、告警规则已接通。
- AI readiness 不因 worker heartbeat 缺失而失败，可能出现 API ready 但 worker 不工作的窗口。
- Agent 没有独立 `/readyz`，公开 `/health` 不检查 Mongo、Redis、RabbitMQ 或模型提供方。
- Publisher readiness 不检查 Mongo/Redis/Consumer，只反映维护状态与连接数。
- 五仓日志字段和采样策略未统一，不能据当前信号声称已有端到端 SLO。
