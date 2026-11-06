# 观测告警健康与 SLO：这里面有哪些技术点

先把这块拆开。每条都是后面对照 [01-观测告警健康与SLO.md](./01-观测告警健康与SLO.md) 时要认的信号。文件怎么串、按什么顺序写，分别在 01 和 [02.文件编写顺序.md](./02.文件编写顺序.md)。

一次点运行留下证据的顺序：

```text
POST /api/v2/flow/runs
  → 中间件新造 HTTP trace_id，写进 X-Trace-ID
  → create_run 另造 run trace_id，写进 flow_task 和 202 body
  → enqueue 带上 run 这张、sentry_trace、publish_timestamp
  → Consumer set_trace_id，日志和 Sentry tag 挂上
  → AI 日志继续带 task.trace_id
  → 报障用 202 body 的 trace_id 或 flow_task_id 反查
```

探活不插在这条链上。它回答这台实例现在接不接新活。

四类信号：

| 信号 | 回答什么 | 现码落在哪 |
| --- | --- | --- |
| 相关 ID | 同一次操作的日志能不能对上 | HTTP 一张，run 一张，socket 再一张 |
| 诊断 | 采到的异常、行为和领取延迟 | Sentry、PostHog、`flow.queue_delay`、结构化日志 |
| 探活 | 这台现在接不接新活 | 各仓 `/health`、`/readyz` 语义不同 |
| SLO | 分子、分母、目标、Owner | 仓内没有已签字的口径 |

---

## 1. 同一次操作有三张应用 ID

`POST /api/v2/flow/runs` 会新造两次。WebSocket `accept` 之后还会再造一次，只留给这条连接。

| 张 | 谁造 | 写到哪 | 对得上什么 |
| --- | --- | --- | --- |
| HTTP | `TraceIDMiddleware.dispatch` | `RequestContext`、Sentry tag、响应头 `X-Trace-ID` | 这一次 HTTP 的 Publisher 日志 |
| run | `WorkflowRunV2Service.create_run` | `flow_task.trace_id`、命令、`202` body | 入队、Consumer、AI、回调 |
| socket | v1 `/flow_task/{ws_id}`、v2 events WebSocket，`accept` 之后 | 该连接处理过程里的 `RequestContext` | 这条 socket 自己的日志 |

中间件不读入站 `X-Trace-ID` / `traceparent`。`create_run` 也不读 `RequestContext`。continue、cancel、幂等重放都复用库里那张 run ID。dispatcher 以后换一条 HTTP 补发时，响应头会变，Mongo 里的 run ID 不变。

v2 派发显式传入 `command["trace_id"]`，所以 socket 刚写进 `RequestContext` 的那张不会盖掉 run 这张。

报障对执行链，用 `202` body 或库里的 `trace_id`，加上 `flow_task_id`。

格式在 `generate_trace_id()`：

```text
1-{unix 秒的 8 位 hex}-{uuid4 前 24 位 hex}
```

这是应用自己的字符串，和 W3C `traceparent` 里的 trace-id 格式不同。

---

## 2. 入队要同时带走三样

v2 消息里同时有：

| 字段 | 从哪来 | 后面谁用 |
| --- | --- | --- |
| `trace_id` | 命令上的 run ID | Consumer `set_trace_id`、AI 任务日志 |
| `sentry_trace` / `sentry_baggage` | `sentry_sdk.get_traceparent()` / `get_baggage()` | Consumer `continue_trace` |
| `publish_timestamp` | Publisher `publish` 时的 `time()` | `flow.queue_delay` |

`sentry_trace` 是 Sentry SDK 的续接头。它和应用 `trace_id` 是两个值。

消息缺 `trace_id`，Consumer 对不上这次 run。缺 `publish_timestamp`，就没有领取延迟样本，任务仍会跑。

---

## 3. Consumer 挂上消息里的 ID

`run_flow` 入口：

1. `set_trace_id(trace_id)` 写进 ContextVar。
2. 有 `sentry_trace` 时 `continue_trace`，再 `start_transaction(op="flow.run")`。
3. `set_tag` 挂上 `trace_id`、`flow_task_id`、`flow_id`、`user_id`、`command_id`。

logger 每次 patch `get_trace_id()`，空着打印 `N/A`。

模型回调一进来先 `set_trace_id(None)`，对上 invocation 之后再设回 callback 或 flow 上的 ID。这样上一条请求的 ContextVar 不会串到这条回调。

metric 或 `continue_trace` 抛错会被吃掉，任务继续。tag 写在后面单独的 `try` 里。

---

## 4. `flow.queue_delay` 只量领取

```text
queue_delay = max(0, round(now - publish_timestamp, 3))
sentry_sdk.metrics.distribution("flow.queue_delay", queue_delay, unit="second")
```

属性只有 `flow_run_type`。起点是 Publisher `publish`，终点是 Consumer 进入 `run_flow`。

厂商执行、callback、Outbox、RabbitMQ、WebSocket 回灯、产物能不能打开，都在这个数之后。用户等了 90 秒、这个数是 0.2 秒，说明慢在领取之后。

AI 自己还有 `queue_wait_ms`：job 开始时间减任务 `created_at`。那是 AI 队列内部等待，和 `flow.queue_delay` 各记各的。

---

## 5. Sentry 是采样后的诊断

| 仓 | 采样 | 健康检查 | 会丢掉的异常 |
| --- | --- | --- | --- |
| Publisher | HTTP `0.2`，`mq_callback` `0.05`，profile `0.1` | `/health`、`/readyz` 为 `0` | `InsufficientCredits` |
| Consumer | 默认 `0.1`，`flow.run` `0.05`，profile `0.1` | 同上 | 积分、敏感内容、参数、文件、模型输出等一组 |
| Agent | 其余 `1.0` | 名字是 `/health`、`/readyz` 时为 `0` | SDK 失败时 `SafeSpan` 变空操作 |
| Frontend | 有 `VITE_SENTRY_DSN` 才 `Sentry.init`，`sendDefaultPii: false` | 浏览器侧不采服务端探活 | 无 DSN 则整个初始化跳过 |

`before_send` 把 `prompt`、`token`、`authorization` 等改成 `[FILTERED]`。

面板上没有 issue，表示这条没被采样到，或被过滤了。条数也不是失败次数。

---

## 6. 探活按仓读 body

| 端点 | 通过 | 503 |
| --- | --- | --- |
| Publisher `/health`、`/health2` | 进程回包 | 这条路径不因依赖失败返回 503 |
| Publisher `/readyz` | 没有 `/tmp/publisher_maintenance`，body 带 `active_ws` | 维护文件在，`status=draining` |
| Publisher `/health/consumer` | blue、green 的 `/health` 都是 200，超时 5 秒 | 任一失败，body `status=degraded` |
| Consumer `/health` | `ok` + `instance_id` | 不在这里看积压 |
| Consumer `/readyz` | 不是 `DRAINING` / `STOPPED`，且已打开的门槛没超 | 排空，或 backlog / stale 超阈值 |
| AI `/health` | `{ status: "ok" }` | 不查依赖 |
| AI `/readyz` | Mongo ping 且 Redis ping | 任一不通；body 仍带 `worker_heartbeat` |
| Agent `/health` | `{"status":"ok"}` | 公开口不查 Mongo、Redis、RabbitMQ |

Publisher `/readyz` 不探 Mongo、Redis，也不读 `/health/consumer` 的结果。`/health/consumer` 打的是 Consumer `/health`，不打 Consumer `/readyz`。

AI 的 `ready` 只看 `mongoOk && redisOk`。`worker_heartbeat` 缺失时，API 仍可以 200。

Agent 排空在本机口 `GET /preview/active_runs`、`POST /preview/drain`。只放行 `127.0.0.1`、`::1`、`localhost`，其它来源 404。公开 `/health` 不带 active run 数。

---

## 7. 阈值 0 表示比较关着

```text
READYZ_MAX_FLOW_RESUME_BACKLOG = 0
READYZ_MAX_STALE_WEBHOOK_INVOCATIONS = 0
```

只有配置 `> 0` 才拿指标去比。`0` 时积压再大，`/readyz` 仍可 200。

`DRAINING` / `STOPPED` 不看这两个数，直接 503。

`/readyz` 和 `/ops/consumer/status` 都会带 `flow_engine`：

- `flow_resume_backlog`
- `running_flow_count`
- `webhook_running_invocation_count`
- `stale_webhook_invocation_count`
- `pending_callback_count`
- `failed_event_outbox_count`

这些是当前计数。仓内没有把它们接成告警规则。排空怎么切流归蓝绿那组。

---

## 8. 飞书收下消息，心跳写在 Redis

`sendText` 发出去要同时满足：开着、有 `webhookUrl`、HTTP 成功、响应体里的数字 `code` 为 `0`。没开或没 URL 就直接返回。有 secret 时带 `timestamp` 和 HMAC-SHA256。文本超过 8000 字会截断。

| 通知 | 何时发 | 失败时 |
| --- | --- | --- |
| `AlertService.notifyCallbackDlq` | consumer-callback 进 DLQ | 只打 `alert.feishu.callback_dlq_failed`，DLQ 照写 |
| `ModelCallNotifier.notifyOnce` | 模型调用通知 | 先 `claimModelCallNotification`，认领不到就跳过 |

飞书 `code=0` 表示这条文本被收下。模型是否恢复、用户是否看到结果，要另查任务状态。

Worker 启动时写一次心跳，之后每 30 秒写 `{prefix}:readyz:worker:worker`。TTL 用 `REDIS_DEFAULT_TTL_SECONDS`，默认 86400 秒。key 还在，只说明没过期，不说明这 30 秒内进程刚写过。

---

## 9. 浏览器和 Agent 分析是旁路

- Frontend 有 DSN 才初始化 Sentry，有 PostHog key 才打 `$pageview`、`Page_View`。开发走 `/ingest`，中国区域延迟 5 秒。
- WebSocket `connectionStatus === 'exhausted'` 时，任务盒子显示断线和重试。run 仍可能在 Consumer 里跑。
- `useWorkflowRunner` 收下 `202` 后留下 `flow_task_id` / `flow_run_id`。body 里的 `trace_id` 有类型，不进 session。
- Agent PostHog 和 `SafeSpan` 在 key / SDK 失败时变成空操作，模型调用继续。

PostHog 是行为样本。国内延迟和采样都会让条数少于真实次数。

---

## 10. 现码停在诊断

Publisher、Consumer 的 `requirements.txt` 有 `opentelemetry-api`、`prometheus_client`。应用源码里没有 `TracerProvider`、exporter、Prometheus scrape。AI `metrics.ts` 只有 `QueueBacklogMetric` 类型。

所以现在能拿来排障的是日志字段、Sentry tag、`flow.queue_delay` 和探活 JSON。五仓还没有一棵 span tree，也没有统一指标平台。

| 已有 | 能证明 | 要另写才算 SLO |
| --- | --- | --- |
| run `trace_id` | 日志对得上这条 run | 成功率 |
| Sentry issue / transaction | 采到的异常或慢样本 | 全量失败数 |
| `flow.queue_delay` | 领取段延迟 | 用户等待 |
| `/readyz` | 这台接不接新活 | 出片是否成功 |
| `flow_engine` | 当前积压、stale、失败 Outbox | 已上线告警 |
| 飞书结果 | 通知有没有被收下 | 故障已恢复 |

旅程口径要另写分子、分母、排除项和窗口：提交有没有明确结果、第一次执行迹象多久出现、会不会停在中间态、产物能不能打开、回调之后用户看不看得见、恢复会不会错账。目标值不在仓库里。没有目标，就没有错误预算，也没有带 Owner 和 Runbook 的告警。

排障按四格写：用户影响、已经对上的 ID 和日志、还缺的分母或目标、下一步补哪段证据。

---

## 动手前要有的东西

业务链已经能点 Run：

- `POST /api/v2/flow/runs` 返回 `202`、`flow_task_id`、`flow_run_id`。
- Publisher 能把命令放进 `run_flow`。
- Consumer 能领到这条命令。
- AI 任务文档能保存 `trace_id`。

配置可以先空着，空时必须跳过：

- 各仓 Sentry DSN，Frontend 是 `VITE_SENTRY_DSN`。
- Frontend PostHog key，Agent PostHog `api_key`。
- AI `alert.feishu`、`modelCallFeishu` 的开关、webhook、secret。
- Publisher `CONSUMER_BLUE_URL`、`CONSUMER_GREEN_URL`。
- Consumer `READYZ_MAX_*`，默认 `0`。

画布门禁和 run 创建不在这篇里。蓝绿切流看配置部署那组。
