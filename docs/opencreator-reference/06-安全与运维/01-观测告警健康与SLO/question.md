# 观测告警健康与 SLO question

## 核心概念

- “观测告警健康与 SLO”讲的是什么？
  - 讲的是一次 Run 留下的证据能不能对上，以及这台实例现在接不接新活。
  - 它回答日志用哪张 ID 串起来、异常和领取延迟采到哪、探活 body 怎么读、飞书有没有把通知收下。
  - 它不重写 DAG，也不在仓库里补一份旅程目标、错误预算或 Runbook。

- 这条证据可以拆成哪四类信号？
  - 相关 ID：同一次操作的日志能不能对上。HTTP 一张，run 一张，socket 再一张。
  - 诊断：Sentry、PostHog、结构化日志、`flow.queue_delay`。
  - 探活：各仓 `/health`、`/readyz` 语义不同，看 body 再决定接不接新活。
  - SLO：分子、分母、目标、Owner。仓内没有已签字的口径。

- 为什么“有 `X-Trace-ID`”“有 run `trace_id`”“`/readyz` 是 200”“飞书 `code=0`”不能混在一起？
  - `X-Trace-ID` 只表示这一次 HTTP。
  - `202` body 里的 `trace_id` 才跟着命令进 Consumer 和 AI。
  - `/readyz` 200 只表示这台按自己的规则可以接新活。
  - 飞书 `code=0` 只表示这条文本被收下。

## 三张应用 ID

- 一次 `POST /api/v2/flow/runs` 会造几张 ID？
  - 中间件先造 HTTP 这张，写进响应头 `X-Trace-ID`。
  - `create_run` 再造 run 这张，写进 `flow_task`、命令和 `202` body。
  - 事件 WebSocket 在 `accept` 之后再造 socket 这张，只留给这条连接的日志。

- HTTP 这张写到哪？
  - `TraceIDMiddleware` 调用 `generate_trace_id()`。
  - 放进 `request.state.trace_id` 和 `RequestContext`。
  - 能挂上时再打 Sentry tag；SDK 还没初始化，这次请求仍然成功。
  - 响应头写出 `X-Trace-ID`。

- 为什么入站自己带的 `X-Trace-ID` 不会回到响应头？
  - 中间件不读入站 `X-Trace-ID`，也不读 `traceparent`。
  - 每次请求都新造一张。
  - 连打两次，两张不同。

- run 这张谁造，后面谁用？
  - `WorkflowRunV2Service.create_run` 在幂等检查通过后调用 `generate_trace_id()`。
  - `create_run` 不读 `RequestContext`。
  - continue、cancel、幂等重放都复用库里那张。
  - dispatcher 把 `command["trace_id"]` 放进 `run_flow`。

- 为什么响应头和 body 的 `trace_id` 可以不同？
  - 响应头是这次 HTTP。
  - body 是这次 run。
  - 同一次创建里，body、Mongo `flow_task.trace_id`、`run_flow` 消息三者相同。
  - 以后换一条 HTTP 补发，响应头会变，库里的 run ID 不变。

- socket 这张会盖掉 run 这张吗？
  - 不会。
  - v2 事件 WebSocket 在 `websocket.accept()` 之后才 `generate_trace_id()`，写进当前连接的 `RequestContext`。
  - 入队显式传入命令上的 `trace_id`。
  - 报执行链用 `202` body 或库里的 `trace_id`，再加上 `flow_task_id`。

- `generate_trace_id()` 长什么样？
  - `1-{unix 秒的 8 位 hex}-{uuid4 前 24 位 hex}`。
  - 这是应用自己的字符串。
  - 它和 W3C `traceparent` 里的 trace-id 格式不同。
  - `sentry_trace` 是 Sentry SDK 的续接头，和应用 `trace_id` 也是两个值。

## 入队与 Consumer

- v2 消息里要同时带走哪三样？
  - `trace_id`：命令上的 run ID，给 Consumer `set_trace_id` 和 AI 任务日志。
  - `sentry_trace` / `sentry_baggage`：`get_traceparent()` / `get_baggage()`，给 Consumer `continue_trace`。取不到就是空字符串。
  - `publish_timestamp`：Publisher `publish` 时的 `time()`，给 `flow.queue_delay`。

- 消息缺字段时任务还跑吗？
  - 缺 `trace_id`，Consumer 对不上这次 run。
  - 缺 `publish_timestamp`，就没有领取延迟样本，任务仍会跑。
  - metric 或 `continue_trace` 抛错会被吃掉，任务继续。

- Consumer 收到 `run_flow` 后怎么挂 ID？
  - `set_trace_id(消息里的 trace_id)` 写进 ContextVar。
  - 有 `publish_timestamp` 才算 `flow.queue_delay`。
  - 有 `sentry_trace` 才 `continue_trace`，再 `start_transaction(op="flow.run")`。
  - `set_tag` 放在后面单独的 `try`，挂上 `trace_id`、`flow_task_id`、`flow_id`、`user_id`、`command_id`。

- 日志里的 `trace_id` 从哪来？
  - logger 每次 patch `get_trace_id()`。
  - 上下文空着打印 `N/A`。
  - Consumer 里不要新造 ID。

- 模型回调为什么先清空 trace？
  - `model_callback` 开头 `set_trace_id(None)`。
  - 对上 invocation 之后，再按 callback、invocation metadata 或 flow 设回。
  - 这样上一条请求的 ContextVar 不会串到这条回调。

## 领取延迟与 Sentry

- `flow.queue_delay` 量的是哪一段？
  - `queue_delay = max(0, round(now - publish_timestamp, 3))`，单位秒。
  - 起点是 Publisher `publish`，终点是 Consumer 进入 `run_flow`。
  - attribute 只有 `flow_run_type`。

- 用户等了很久、这个数却很小，说明什么？
  - 慢在领取之后。
  - 厂商执行、callback、Outbox、RabbitMQ、WebSocket 回灯、产物能不能打开，都在这个数之后。
  - AI 自己的 `queue_wait_ms` 是 job 开始时间减任务 `created_at`，和 `flow.queue_delay` 各记各的。

- Sentry 是全量失败次数吗？
  - 不是。它是采样后的诊断。
  - Publisher：`/health`、`/readyz` 为 `0`，`mq_callback` 为 `0.05`，其它 HTTP 为 `0.2`。
  - Consumer：`/health`、`/readyz` 为 `0`，`flow.run` 为 `0.05`，其它为 `0.1`。
  - Agent：除健康检查名以外采样 `1.0`。SDK 失败时 `SafeSpan` 变成空操作。
  - Frontend：有 `VITE_SENTRY_DSN` 才 `Sentry.init`，`sendDefaultPii: false`。没有 DSN 就跳过初始化。

- 哪些异常不会变成 issue？
  - Publisher `before_send` 丢掉 `InsufficientCredits`。
  - Consumer 丢掉积分、敏感内容、参数、文件、模型输出这一组预期业务异常。
  - `prompt`、`token`、`authorization` 改成 `[FILTERED]`。
  - 已经变成明确业务响应的异常留在业务分支，不走未捕获的 `capture_exception`。

- 面板上没有 issue 表示什么？
  - 这条没被采样到，或被过滤了。
  - 条数也不是失败次数。

## 探活

- Publisher `/health`、`/health2`、`/readyz` 各回答什么？
  - `/health` 表示进程能回包。
  - `/health2` 返回 `200 {"status":"ok","code":200}`。
  - `/readyz` 数 active WebSocket。存在 `/tmp/publisher_maintenance` 则 `503`，body `status=draining`；否则 `200`，body 带 `active_ws`。
  - 这一步不 ping Mongo、Redis，也不读 Consumer 的结果。

- `/health/consumer` 打的是哪一个口？
  - 并行 `GET` blue、green 的 `/health`，超时 5 秒。
  - 都是 `200` 则自己 `200`。
  - 任一失败则 `503`，body `status=degraded`。
  - 它不打 Consumer `/readyz`。Publisher 自己的 `/readyz` 也不读取这次结果。

- Consumer `/readyz` 什么时候 503？
  - intake 是 `DRAINING` 或 `STOPPED`，直接 `503`，不看积压数字。
  - `READYZ_MAX_FLOW_RESUME_BACKLOG > 0` 且积压超过它，`503 degraded`。
  - `READYZ_MAX_STALE_WEBHOOK_INVOCATIONS > 0` 且 stale 超过它，`503 degraded`。
  - 两个阈值默认是 `0`。`0` 表示比较关着，积压再大仍可 `200`。
  - `200` 时 body 仍带 `flow_engine`。

- `flow_engine` 里有什么？
  - `flow_resume_backlog`、`running_flow_count`、`webhook_running_invocation_count`、`stale_webhook_invocation_count`、`pending_callback_count`、`failed_event_outbox_count`。
  - `/ops/consumer/status` 另外带 intake、inflight、heartbeat。
  - 这些是当前计数。仓内没有把它们接成告警规则。排空怎么切流归蓝绿那组。

- AI `/readyz` 的 `ready` 看什么？
  - `ready = mongoOk && redisOk`。
  - body 另带 `worker_heartbeat`，读失败则 `null`。
  - Mongo 和 Redis 都通、心跳缺失时仍是 `200`。Mongo 不通则 `503`，心跳字段仍在。
  - `/health` 只回进程存活，不查依赖。

- Worker 心跳表示进程刚写过吗？
  - 启动时写一次，之后每 30 秒写 `{prefix}:readyz:worker:worker`。
  - TTL 用 `REDIS_DEFAULT_TTL_SECONDS`，默认 `86400` 秒。
  - key 还在，只说明没过期。

- Agent 公开口和本机口怎么分？
  - `GET /health` 回 `{"status":"ok"}`，不查 Mongo、Redis、RabbitMQ，也不带 active run 数。
  - `GET /preview/active_runs`、`POST /preview/drain` 只放行 `127.0.0.1`、`::1`、`localhost`。
  - 其它来源 `404`。
  - 本机 drain 之后，`/health` 仍是 `ok`，active run 数只出现在 `/preview/active_runs`。

## 飞书通知

- `sendText` 怎样才算发出去？
  - 开着、有 `webhookUrl`、HTTP 成功、响应体里的数字 `code` 为 `0`，四样同时满足。
  - 没开或没 URL 就直接返回。
  - 有 secret 时带 `timestamp` 和 HMAC-SHA256。
  - 文本超过 8000 字会截断。
  - HTTP 不成功，或 `code` 是数字且不是 `0`，调用方能看见失败。

- 回调 DLQ 通知失败会改任务终态吗？
  - 不会。
  - `notifyCallbackDlq` 的 `sendText` 抛错时，只打 `alert.feishu.callback_dlq_failed`。
  - 异常停在通知通道，DLQ 照写，callback 仍进入失败终态。

- 模型通知为什么先认领？
  - `notifyOnce` 先 `claimModelCallNotification`。
  - 没认领到就返回。
  - 发出去标记 sent，失败标记 failed。
  - 同一个 `ai_task_id` 只发出一次。
  - 飞书收下文本之后，模型是否恢复、用户是否看到结果，要另查任务状态。

## 浏览器诊断

- 前端会生成 run 的 `trace_id` 吗？
  - 不会。
  - `202` 的 `trace_id` 留在接口类型里。
  - 会话以 `flow_task_id`、`flow_run_id` 为钥匙。

- 没有 DSN、没有 PostHog key 时页面还能跑吗？
  - 能。
  - 有 `VITE_SENTRY_DSN` 才 `Sentry.init`。
  - 有 key 才初始化页面事件，并打 `$pageview`、`Page_View`。
  - 业务事件从 `posthog-capture` 发出，失败不抛到页面。
  - Agent 侧 PostHog 没 key 时，capture 也是空操作，模型调用继续。

- WebSocket `exhausted` 表示 run 停了吗？
  - 不表示。
  - 任务盒子在连接耗尽、任务没有错误、没有停止时，显示断线和重试。
  - run 状态保持原样，Consumer 里仍可能继续跑。
  - 连接、认证、attach 失败会上报 Sentry。

- PostHog 条数为什么会少于真实次数？
  - 它是行为样本。
  - 开发走 `/ingest`。中国区域延迟 5 秒，放进 idle callback。
  - `person_profiles` 用 `identified_only`。

## 现码停在诊断

- 现在能拿来排障的是什么？
  - 日志字段、Sentry tag、`flow.queue_delay` 和探活 JSON。
  - Publisher、Consumer 的依赖里可以有 OpenTelemetry 和 Prometheus 客户端。
  - 应用源码里没有 `TracerProvider`、exporter、Prometheus scrape。
  - AI 指标类型停在队列积压这一种。五仓还没有一棵 span tree，也没有统一指标平台。

- 已有信号能证明什么，要另写才算什么？
  - run `trace_id` 证明日志对得上这条 run。成功率要另写分子分母。
  - Sentry issue 证明采到的异常或慢样本。全量失败数要另记。
  - `flow.queue_delay` 证明领取段延迟。用户等待要另记。
  - `/readyz` 证明这台接不接新活。出片是否成功要另记。
  - `flow_engine` 证明当前积压、stale、失败 Outbox。已上线告警要另接。
  - 飞书结果证明通知有没有被收下。故障已恢复要另查。

- 旅程口径要另写哪些东西？
  - 提交有没有明确结果。
  - 第一次执行迹象多久出现。
  - 会不会停在中间态。
  - 产物能不能打开。
  - 回调之后用户看不看得见。
  - 恢复会不会错账。
  - 目标值不在仓库里。没有目标，就没有错误预算，也没有带 Owner 和 Runbook 的告警。

- 排障按哪四格写？
  - 用户影响。
  - 已经对上的 ID 和日志。
  - 还缺的分母或目标。
  - 下一步补哪段证据。

## 面试短答

- 一句话讲观测告警健康与 SLO？
  - 一次 Run 用应用自己的 run `trace_id` 把 Publisher、Consumer、AI 日志串起来，Sentry 和 `flow.queue_delay` 只提供采样诊断和领取延迟，各仓 `/readyz` 按自己的 body 决定接不接新活，飞书只证明通知被收下；旅程目标、错误预算和 Runbook 不在这组交付里。

- 一句话讲为什么响应头和 body 的 `trace_id` 可以不同？
  - 响应头是中间件为这一次 HTTP 新造的，body 是 `create_run` 另造并写进命令的 run ID，continue 和入队都复用后者。

- 一句话讲 `flow.queue_delay`？
  - 它只比较 Publisher `publish` 到 Consumer 进入 `run_flow` 的秒数，用户后面等的模型、回调和回灯都不在这个数里。

- 一句话讲为什么 `/readyz` 200 不等于用户旅程成功？
  - `/readyz` 只按本仓规则判断这台接不接新活，成功率要另有分子、分母、窗口和目标。

- 一句话讲飞书 `code=0`？
  - 它只表示这条文本被飞书收下，callback 终态和模型任务状态仍走原来的路径。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - Publisher 每次 HTTP 新造 `X-Trace-ID`，不回写入站头。
  - run 使用 `1-{unix hex}-{24 hex}`，写入 `flow_task`、命令和 `202` body；continue 复用这张。
  - 入队带上 run `trace_id`、`sentry_trace`、`publish_timestamp`。
  - 事件 WebSocket `accept` 之后另造一张，只打当前连接日志。
  - Consumer 日志能按 run 这张搜到，空上下文打印 `N/A`，有 `publish_timestamp` 才打 `flow.queue_delay`。
  - 回调入口先 `set_trace_id(None)`。
  - Sentry DSN 为空时跳过初始化。健康检查采样为 `0`。`InsufficientCredits` 不进 Publisher issue。
  - Publisher `/readyz` 看维护文件和 `active_ws`。`/health/consumer` 只打两边的 `/health`。
  - Consumer 阈值默认 `0`，积压不导致 `/readyz` 503；`DRAINING` / `STOPPED` 会 503，body 带 `flow_engine`。
  - AI：Mongo、Redis 通而心跳缺失时 `/readyz` 为 200，body 带 `worker_heartbeat`。
  - 飞书 HTTP 失败或 `code!=0` 时，callback 终态和模型任务状态保持原路径。同一 `ai_task_id` 先认领再发。
  - Agent 公开 `/health` 回 `ok`。非本机 `/preview/drain` 为 404。
  - 前端无 DSN、无 PostHog key 时主路径可用。连接 `exhausted` 时任务盒子出现断线和重试，run 状态保持原样。

- 当前实现能不能算本章主链路打通？
  - 可以算证据链和探活语义打通。
  - 因为三张 ID、领取延迟、分仓探活、飞书失败隔离和浏览器断线提示都已经存在。
  - 这不等于 SLO 已经落地：没有已签字的旅程目标、错误预算、Owner 和 Runbook，也没有统一 span tree 或指标平台。

- 当前测试覆盖了哪些本章风险？
  - `scripts/accept-observability-health-slo.py` 覆盖响应头与 body 分张、入站头不回写、命令与 `run_flow` 同一张、continue 复用、socket 另造、Consumer 日志与 `flow.queue_delay`、回调清空上下文、Sentry 过滤、Publisher / Consumer 探活分离。
  - AI 验收覆盖心跳不参与 `ready`，以及飞书失败不改 callback 终态和模型任务状态。
  - 前端验收覆盖空 DSN、空 PostHog key，以及 `exhausted` 时出现断线提示且 run 状态不变。

- 为什么说当前还不是完整 SLO？
  - `flow.queue_delay` 只覆盖领取段。
  - Sentry 条数受采样和 `before_send` 影响。
  - `flow_engine` 是当前计数，没有接成告警规则。
  - Worker 心跳 key 的默认 TTL 是 86400 秒，key 还在只说明没过期。
  - 应用源码里没有 `TracerProvider`、exporter 和 Prometheus scrape。

- 如果用户说 Run 很慢，当前应该怎么排查？
  - 先拿 `202` body 的 `trace_id` 或 `flow_task_id`，不要拿响应头那张去对 Consumer。
  - 再看 Consumer 入口日志里的 `[trace_id=...]` 和 `flow.queue_delay`。
  - 这个数很小，就到 AI 日志里的同一 `trace_id` 和 `queue_wait_ms` 继续看。
  - Sentry 有这个 tag 就看样本；没有 issue 先按采样和过滤理解。
  - `/readyz` 若是 503，先读 body 是 `draining` 还是 `degraded`。

- 什么时候才算本章验收？
  - 证据能对上：HTTP 头、run ID、socket ID 三张分开，命令和 Consumer 用同一张 run ID。
  - 探活语义分开：Publisher、Consumer、AI、Agent 各自按自己的 body 判断。
  - 告警失败留在通知通道：飞书失败不改任务路径。
  - 用户旅程的目标值和错误预算另开口径，不在这次编写里交付。
