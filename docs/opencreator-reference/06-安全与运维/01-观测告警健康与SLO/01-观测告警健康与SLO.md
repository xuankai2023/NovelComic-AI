# OpenCreator 是怎么做观测告警健康与 SLO 的

## 一、先说结论

一次点运行的证据按这个顺序留下。名词见 [00-观测告警健康与SLO技术点.md](./00-观测告警健康与SLO技术点.md)。

[trace_id_middlewares.py](../../../../../opencreate/opencreator-publisher/middleware/trace_id_middlewares.py)：每个 HTTP 新造一张，写入 `X-Trace-ID`  
→ [workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)：`create_run` 再造 run 这张，continue / cancel 复用  
→ [flow.py](../../../../../opencreate/opencreator-publisher/services/flow.py)：`enqueue_flow_task` 带上 `trace_id`、`sentry_trace`、`publish_timestamp`  
→ [tasks/flow.py](../../../../../opencreate/opencreator-consumer/tasks/flow.py)：`set_trace_id`、`flow.queue_delay`、Sentry tag  
→ [provider-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)：日志继续带 `task.trace_id`  
→ [feishu-webhook-client.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)：模型或回调失败时另发通知

探活在各仓自己的 `main` / `health` 路由上，不插进上面这条链。

要分开的五样：

- HTTP ID：响应头 `X-Trace-ID`。
- run ID：`flow_task.trace_id` 和 `202` body。
- socket ID：事件 WebSocket `accept` 之后另造，只服务这条连接。
- 诊断：Sentry、PostHog、结构化日志、`flow.queue_delay`。
- 探活：看 body 里的状态，再决定这台接不接新活。

---

## 二、Frontend 必须有的文件

按浏览器进程起来的顺序背。没有 DSN 或 PostHog key 时，对应初始化跳过，页面仍能跑。

1. `src/main.tsx`：有 `VITE_SENTRY_DSN` 才 `Sentry.init`。
2. `src/provider/usePostHogProvider.tsx`：有 key 才初始化，并打页面事件。
3. `src/lib/posthog-capture.ts`：业务事件从这里发。
4. `src/lib/workflow-resumable-websocket.ts`：连接失败上报 Sentry。
5. `src/store/ws.ts`：会话上留 `connectionStatus`。
6. `src/features/canvas-workflow/components/panels/TasksBox.tsx`：`exhausted` 时给出断线和重试。

### `src/main.tsx`

OpenCreator 源码：[main.tsx](../../../../../opencreate/opencreator-frontend/src/main.tsx)

```text
已有 Sentry client → 跳过
有 VITE_SENTRY_DSN
  → Sentry.init({ dsn, environment: MODE, sendDefaultPii: false })
```

这里不做用户识别，也不读 `X-Trace-ID`。

### `src/provider/usePostHogProvider.tsx`

OpenCreator 源码：[usePostHogProvider.tsx](../../../../../opencreate/opencreator-frontend/src/provider/usePostHogProvider.tsx)

- 没有 `POSTHOG_KEY`：不初始化。
- 生产：`api_host` 用配置的 host。开发：`/ingest`，并用本地 `distinct_id`。
- `person_profiles: 'identified_only'`。
- 中国区域延迟 5 秒，放进 idle callback。
- 路由变化后打 `$pageview`、`Page_View`，带促销参数时另打 `promo_link_visit`。

发送失败被吞掉。

### 连接状态

[workflow-resumable-websocket.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts) 在连接、认证、attach 失败时 `Sentry.captureException`。

[useWorkflowRunner.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts) 把 `connectionStatus` 写成 `connecting`、`connected`、`reconnecting`、`detached`、`exhausted`。`202` 的 `trace_id` 留在类型里，session 只留 `flow_task_id` / `flow_run_id`。

[TasksBox.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/TasksBox.tsx) 在 `exhausted` 且任务没有错误、没有停止时，显示断线和重试。

---

## 三、Publisher 必须有的文件

按一次 `POST /api/v2/flow/runs` 走进来的顺序背。

1. `utils/id_utils.py`：`generate_trace_id()`。
2. `common/context/request_context.py`：HTTP 这张放进 ContextVar，缺省 `"-"`。
3. `core/sentry.py`：进程启动时初始化。
4. `core/register.py`：先 `init_sentry`，再挂 `TraceIDMiddleware`。
5. `middleware/trace_id_middlewares.py`：每个 HTTP 新造一张。
6. `services/workflow_runs_v2.py`：`create_run` 再造 run 这张。
7. `services/flow.py`：入队带上 run ID 和 `publish_timestamp`。
8. `controller/v2/flow_runs.py`：事件 WebSocket `accept` 后再造 socket 这张。
9. `main.py`：四个探活。
10. `common/exception/handler.py`：未捕获异常 `capture_exception`。

### `utils/id_utils.py`

OpenCreator 源码：[id_utils.py](../../../../../opencreate/opencreator-publisher/utils/id_utils.py)

```text
1-{unix 秒 8 位 hex}-{uuid4().hex 前 24 位}
```

### `middleware/trace_id_middlewares.py`

OpenCreator 源码：[trace_id_middlewares.py](../../../../../opencreate/opencreator-publisher/middleware/trace_id_middlewares.py)

```text
generate_trace_id()
  → request.state.trace_id
  → RequestContext.set_trace_id
  → sentry_sdk.set_tag("trace_id")
  → sentry_sdk.set_context("request_trace")
  → call_next
  → response.headers["X-Trace-ID"]
```

文件里没有 `request.headers.get`。客户端断开导致的 `RuntimeError` 收成 204。

### `services/workflow_runs_v2.py`

OpenCreator 源码：[workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)

```text
新 run，过了幂等检查
  → trace_id = generate_trace_id()
  → task_doc.trace_id
  → 202 body 来自 task

continue / cancel
  → task.trace_id，缺了才再 generate

幂等重放
  → 返回已有 task 的 trace_id

dispatch_command
  → enqueue_flow_task(trace_id=command["trace_id"])
```

`create_run` 不调用 `RequestContext.get_trace_id()`。

### `services/flow.py`

OpenCreator 源码：[flow.py](../../../../../opencreate/opencreator-publisher/services/flow.py)

```text
trace_id = 入参 or RequestContext.get_trace_id()
空或 "-" → 再 generate_trace_id()
sentry_trace = get_traceparent()，取不到是空字符串
sentry_baggage = baggage.serialize()
publish_timestamp = time()
  → FlowTask.run_flow.publish
```

v2 已经传入 command 上的 `trace_id`，返回值就是消息里的那张。

### 事件 WebSocket

OpenCreator 源码：[flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)

`workflow_run_events_v2` 在 `websocket.accept()` 之后立刻 `generate_trace_id()` 并 `RequestContext.set_trace_id`。v1 的 `/flow_task/{ws_id}` 同样如此。这张服务当前连接上的日志。run 的稳定 ID 仍在命令里。

### `core/sentry.py` 和探活

OpenCreator 源码：[sentry.py](../../../../../opencreate/opencreator-publisher/core/sentry.py)、[main.py](../../../../../opencreate/opencreator-publisher/main.py)

DSN 为空就打警告并返回。采样：`/health`、`/readyz` 为 `0`，`mq_callback` 为 `0.05`，其它 HTTP 为 `0.2`，profile `0.1`。`InsufficientCredits` 在 `before_send` 丢掉。`prompt`、`token`、`authorization` 改成 `[FILTERED]`。

```text
GET /health     → responseBase.success()
GET /health2    → 200 {"status":"ok","code":200}
GET /readyz     → active_ws = len(ws_global_map)
                  /tmp/publisher_maintenance 存在：503 draining
                  否则 200，body 带 active_ws
GET /health/consumer
                → 并行 GET {BLUE}/health、{GREEN}/health，timeout 5 秒
                → 都 200：200
                → 否则 503，body status=degraded
```

未捕获异常在 [handler.py](../../../../../opencreate/opencreator-publisher/common/exception/handler.py) 里 `capture_exception`。已经转成明确业务响应的异常不走这里。

---

## 四、Consumer 必须有的文件

1. `utils/trace_context.py`：`set_trace_id` / `get_trace_id` / `clear_trace_id`。
2. `logger/logger.py`：每条日志 patch `trace_id`，空则 `N/A`。
3. `tasks/flow.py`：入口挂 ID、打 queue delay、续 Sentry。
4. `core/sentry.py`：执行侧采样和预期异常过滤。
5. `main.py`：`/health`、`/readyz`、`/ops/consumer/status`，回调入口先清空 trace。

### `tasks/flow.py`

OpenCreator 源码：[flow.py](../../../../../opencreate/opencreator-consumer/tasks/flow.py)

```text
set_trace_id(trace_id)
有 publish_timestamp
  → queue_delay = max(0, round(time() - publish_timestamp, 3))
  → distribution("flow.queue_delay")，attribute 只有 flow_run_type
有 sentry_trace
  → continue_trace
  → start_transaction(op="flow.run", name=f"flow:{flow_task_id}")
set_tag(trace_id, flow_task_id, flow_id, user_id, command_id, protocol_version, ws_id)
set_user({ id: user_id })
```

前两个 `try` 失败只跳过观测。tag 在第三个 `try`。

[main.py](../../../../../opencreate/opencreator-consumer/main.py) 的 `model_callback` 开头 `set_trace_id(None)`。`ModelInvocationService` 对上之后再按 callback、invocation metadata 或 flow 设回。

### `core/sentry.py`

OpenCreator 源码：[sentry.py](../../../../../opencreate/opencreator-consumer/core/sentry.py)

默认采样 `0.1`，`flow.run` 为 `0.05`。`EXPECTED_EXCEPTION_TYPES` 含积分不足、敏感内容、参数、文件、模型不存在、输出失败等，`before_send` 返回 `None`。脱敏字段和 Publisher 同一组。

### `/readyz`

```text
GET /health
  → {"status":"ok","instance_id"}

GET /readyz
  → Redis opencreator:consumer:intake:{INSTANCE_ID}
  → DRAINING 或 STOPPED：503，带 inflight_count、flow_engine
  → READYZ_MAX_FLOW_RESUME_BACKLOG > 0 且积压超过它：503 degraded
  → READYZ_MAX_STALE_WEBHOOK_INVOCATIONS > 0 且 stale 超过它：503 degraded
  → 否则 200，body 带 flow_engine

GET /ops/consumer/status
  → intake_state、inflight_count、last_heartbeat、flow_engine
```

`_flow_engine_health_metrics` 读 resume stream 的 `XLEN`，以及 Mongo 里 running flow、webhook running、stale webhook、pending callback、failed outbox。

两个 `READYZ_MAX_*` 默认是 `0`，比较不进入。`POST /ops/consumer/drain` 和 `/ops/consumer/active` 只改 intake 状态，探活读这个状态。

---

## 五、AI 必须有的文件

1. `packages/queues/src/heartbeat.ts`：写和读 worker 心跳。
2. `apps/worker/src/main.ts`：每 30 秒写一次，并装上飞书客户端。
3. `apps/api/src/routes/health.ts`：`/health` 与 `/readyz`。
4. `packages/runtime/src/logger.ts`：事件名加字段打成一行。
5. `packages/runtime/src/provider-worker.ts`：`logTask` 带 `task.trace_id`，另记 `queue_wait_ms`。
6. `packages/runtime/src/feishu-webhook-client.ts`：发送和判定成功。
7. `packages/runtime/src/alert-service.ts`：回调 DLQ 通知。
8. `packages/runtime/src/model-call-notifier.ts`：先认领再发。

### `/readyz` 和心跳

[health.ts](../../../../../opencreate/opencreator-ai/apps/api/src/routes/health.ts)、[main.ts](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts)、[heartbeat.ts](../../../../../opencreate/opencreator-ai/packages/queues/src/heartbeat.ts)

```text
GET /health → 200 { status: "ok" }

GET /readyz
  → mongo ping、redis ping
  → readWorkerHeartbeat(..., "worker")，失败则 null
  → ready = mongoOk && redisOk
  → 200 或 503，body 含 mongo、redis、worker_heartbeat

worker 启动
  → 立刻 writeWorkerHeartbeat
  → 每 30_000 ms 再写
  → key：{prefix}:readyz:worker:worker
  → TTL：REDIS_DEFAULT_TTL_SECONDS，默认 86400
```

### 飞书

[feishu-webhook-client.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)

```text
enabled === false 或没有 webhookUrl → return
有 secret → timestamp + HMAC-SHA256 sign
POST
  → HTTP 失败：抛错
  → body.code 是数字且不是 0：抛错
  → 否则 feishu.webhook.sent
```

[alert-service.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/alert-service.ts) 接住 `notifyCallbackDlq` 的发送异常，只记 `alert.feishu.callback_dlq_failed`。

[model-call-notifier.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/model-call-notifier.ts) 的 `notifyOnce` 先 `claimModelCallNotification`。发出去标记 sent，失败标记 failed。

---

## 六、Agent 必须有的文件

1. `creato/sentry.py`：初始化、`SafeSpan`、`SafeTransaction`。
2. `creato/posthog.py`：LLM Analytics。没 key 时函数是空操作。
3. `creato/core/loop.py`：运行循环里挂 Sentry 和 PostHog context。
4. `creato/api/server.py`：公开 `/health`，本机 drain 口。

[sentry.py](../../../../../opencreate/opencreator-agent/creato/sentry.py)：DSN 空或已初始化则跳过。除 `/health`、`/readyz` 外采样 `1.0`。`SafeSpan` 在 SDK 抛错时把 span 清空。

[server.py](../../../../../opencreate/opencreator-agent/creato/api/server.py)：

```text
GET /health → {"status":"ok"}

GET /preview/active_runs
POST /preview/drain
  → 仅 127.0.0.1、::1、localhost
  → 其它 404
```

`/preview/drain` 把 `app.state.shutting_down` 设为 true，返回当时的 `active_runs`。

---

## 七、报障时按哪张 ID 查

创建和派发的逐步调用已经写在上面。出问题只沿 run 这张查：

```text
202 body.trace_id 或 flow_task_id
  → Publisher 入队日志里的同一 trace_id
  → Consumer [trace_id=...] 和 flow.queue_delay
  → AI provider.* 日志里的同一 trace_id
  → Sentry 有这个 tag 就看样本
```

`/readyz` 返回 503 时先读 body：`draining` 还是 `degraded`，以及 `issues`、`flow_engine`。这是实例接新活的判定。

飞书路径独立：

```text
callback 进 DLQ → notifyCallbackDlq → sendText
模型通知 → claimModelCallNotification → sendText → mark sent / failed
```

---

## 八、和 NovelComic 对照

| 位置 | NovelComic 现在 | 对齐 OpenCreator 时要变成 |
| --- | --- | --- |
| run `trace_id` | Publisher 用 `uuid4().hex` 写入 run | `1-{unix hex}-{24 hex}`，和 HTTP 头分开 |
| HTTP 头 | 没有 `TraceIDMiddleware` | 每次请求新造 `X-Trace-ID`，不读入站头 |
| Consumer 日志 | 消息里能带到 `trace_id` | ContextVar、`[trace_id=]`、`flow.queue_delay`、Sentry tag |
| Publisher `/readyz` | `connections.checks()`，Mongo / Redis / RabbitMQ 任一失败 503 | 维护文件 + `active_ws` |
| Consumer `/readyz` | 同一套依赖检查 | 排空状态 + 阈值默认 `0` + `flow_engine` |
| Publisher 探 Consumer | 没有 `/health/consumer` | 只打 blue/green 的 `/health`，超时 5 秒 |
| AI `/readyz` | ping Mongo、Redis，失败 503 | 同样两样决定 200/503，另返回 `worker_heartbeat` |
| Agent | `/health` 与 `/readyz` 都查依赖，`/health` 可在 200 里给 `degraded` | 公开 `/health` 只回 `ok`；drain 只留本机 |
| 浏览器 | 已有 `postHogCapture` | 补 Sentry 初始化、页面 PostHog、`exhausted` 断线 |
| 飞书 | Publisher / Consumer 已有别的 webhook 配置 | AI 的 DLQ 通知和模型通知单独接，失败不改任务 |
| SLO | 没有目标、预算、Owner | 先把上面的信号分开，目标另定 |

编写顺序见 [02.文件编写顺序.md](./02.文件编写顺序.md)。
