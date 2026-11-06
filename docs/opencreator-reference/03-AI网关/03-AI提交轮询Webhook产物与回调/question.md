# AI 提交、轮询、Webhook、产物与回调 question

## 核心概念

- 这一组讲的是什么？
  - 只讲 `ai_task` 已经 `queued` 之后，如何提交 Provider、收敛结果、处理产物，并把精简回调投递给 Consumer。
  - 它不讲任务怎么创建。
  - 它也不讲 `CORE_MODELS` 怎么注册模型和 Robin 顺序。

- 为什么要先背一句话？
  - provider worker 把任务送到厂商。
  - polling 和厂商 Webhook 把结果收成 `ProviderResult`。
  - artifact worker 整理到 `callback_pending`。
  - callback worker 签名投递给 Consumer。
  - 画布节点由 Consumer 往后推。

- 五件事怎么分？
  - Provider submit：交给厂商，写下 `provider_request_id`，进入 `waiting_provider`。
  - Provider result：`immediateResult`、轮询、厂商 Webhook 收成的统一结果。
  - Artifact processing：成功整理产物，失败跳过整理，两边都可回调。
  - Consumer callback：HMAC 投递到建单时的 `webhook_url`。
  - Workflow event：Consumer 挂回 invocation 之后，Publisher / Frontend 才看见节点。

- 最短链路是什么？
  - submit job 只带 `ai_task_id`。
  - worker 回库读取任务并 `submitCoreTask()`。
  - `markProviderSubmitted()`，状态 `waiting_provider`。
  - 三条入口收成 `ProviderResult`，`applyProviderResult()`。
  - artifact-processing 把状态送到 `callback_pending`。
  - HMAC POST Consumer。
  - 2xx 后按有没有 `error` 写成 `succeeded` 或 `failed`。

## 提交与三条结果入口

- submit job 里为什么只有 ID？
  - 还可以带 `skip_providers`。
  - options、webhook、上下文都从任务文档读。
  - 重试和 fallback 以数据库为准。

- 提交成功写什么？
  - `provider`、`provider_model_id`、`provider_request_id`、`provider_status`、`result_mode`、attempt。
  - 状态进入 `waiting_provider`。
  - 这表示已经交给某一家，结果还没收敛完。

- 三条入口分别是什么？
  - `immediateResult`：submit 当场带最终结果，立刻 `normalizeResult()`。
  - polling：`getResult()` 再归一化。仍在处理中就继续停在 `waiting_provider`。
  - provider webhook：`POST /v1/provider-webhooks/:provider`，由 `ProviderWebhookService.handleWebhook()` 收敛。

- 为什么厂商原始 JSON 不能直接给 Consumer？
  - 后续 artifact worker 和回调都吃统一 `ProviderResult`。
  - 原始状态、错误码和媒体字段各家不一样。

- Webhook 怎么避免覆盖新 attempt？
  - 先按 `ai_task_id` 或 `provider_request_id` 找到任务。
  - provider event 用 event id 去重，`inserted=false` 不再推进。
  - `isSameProviderAttempt()` 核对 provider、厂商模型 ID、request id 和 attempt。
  - 任务已经离开 `waiting_provider` 就只回接受。

- Webhook 模式为什么还要轮询？
  - 参考实现里，后面还有 Robin，而且当前 call 有 `getResult()` 时，worker 轮询兜底。
  - 目的是厂商回调丢失后，下一家仍然有机会。
  - 最后一家纯 Webhook 可以停在 `waiting_provider` 等回调或外部补偿。
  - 厂商一直不回调、又没有补偿时，任务会停在这个状态。

## 失败、产物和回调

- Provider 失败是不是最终失败？
  - 先看还有没有剩余 call。
  - 有：`addRobinSkipProvider(provider:model_id)`，再入一条带 `skip_providers` 的 submit job。
  - 没有：写成最终 `failed`，进入 artifact-processing。
  - fallback 可以让状态离开 `failed`。顺序表没有接进写路径。

- 失败任务进不进回调？
  - 进。
  - artifact worker 对 `failed` 跳过 `processResult()`，直接改成 `callback_pending` 并入队。
  - DAG 需要收到失败通知。

- 成功任务怎么到可回调？
  - `processing_artifacts`。
  - `artifactStore.processResult()`。
  - `updateResult()`。
  - `callback_pending`。
  - enqueue consumer-callback。

- artifact worker 会再上传一次媒体吗？
  - 参考实现用 `PassThroughArtifactStore` 整理并持久化。
  - 上传可能已经发生在 Provider `normalizeResult()` 的 uploader 里。

- 对内和对外 payload 差在哪？
  - 对内 `AiTaskWebhookPayload`，成功状态是 `succeeded`。
  - 对外 `AiTaskPublicWebhookPayload`，成功状态是 `success`。
  - 参考口径的对外结果是 `result.output: string[]`。媒体优先用 artifact URL，文本包成单元素数组。
  - telemetry 和厂商 raw 不整包外传。回调不能反推完整 `ai_task`。

- 签名怎么算？
  - 头是 `x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key`。
  - HMAC-SHA256，内容是 `timestamp + "." + rawBody`。
  - 密钥是 `consumerWebhookSecret`。
  - Consumer 用原始 body 验签。

- 2xx 之后状态怎么写？
  - 任务上有 `error`：最终 `failed`。
  - 没有 `error`：最终 `succeeded`。
  - 投递成功不等于模型成功。

- 什么时候进 DLQ？
  - 网络错误、超时、Consumer 非 2xx，按 attempts 和 retry window 重试。
  - 耗尽后 `markFailed()` 写成 `callback_failed`，再写入 callback-dlq 并告警。
  - `callback_failed` 是通知失败。结果仍在 AI 文档里，现码不会自动重投。

## Consumer 边界

- AI 侧怎么知道 Consumer 对上了 invocation？
  - 不知道。
  - AI 只看 HTTP 是否 2xx。
  - 对单在 Consumer。

- Consumer 入口是什么？
  - `POST /callbacks/models/{vendor}`。
  - 验签、timestamp、idempotency key、payload schema。
  - 再交给 invocation service。

- 用哪些字段对单？
  - `ai_task_id` / `external_task_id`。
  - `trace_id`。
  - `client_context` 里的 `result_id`、`node_id`、`run_id`。

- 对不上 invocation 怎么办？
  - 写 pending callback。
  - 这不是 AI 投递失败，也不是 Provider 失败。

- 前端看哪一层？
  - Consumer 推进 DAG 之后的 workflow event。
  - Publisher 接住事件再推 WebSocket。
  - 前端不接厂商 Webhook，也不轮询 AI task。

## NovelComic 迁移

- 编写顺序为什么把仓储放在 worker 前面？
  - `task-repository` 在建单组已经能读写任务。
  - 这一组先补 `markProviderSubmitted`、`applyProviderResult`、skip，并补 attempt / provider event / callback delivery。
  - worker 第一次写状态时这些方法就要在。

- 五段怎么排？
  - 结果契约和仓储补方法。
  - provider worker：提交、immediate、polling、fallback。
  - Webhook 路由、event repository、webhook service。
  - artifact store 和 artifact worker。
  - 对外 schema、投递记录、callback worker、DLQ、Consumer 验签和对单。

- 本章最小验收是什么？
  - submit 成功写下 `provider_request_id`，状态为 `waiting_provider`。
  - immediate 和 polling 都能收成 `ProviderResult`。
  - Webhook 能定位任务、忽略旧 attempt，同一 event 不重复入队。
  - 有下一家就 fallback，没有就最终失败。
  - 成功走 `processing_artifacts → callback_pending`，失败跳过产物也进入 `callback_pending`。
  - 对外 `success` 和 `result.output` 形状正确，HMAC 能用原始 body 验证。
  - 2xx 后按有没有 `error` 写最终状态。
  - 非 2xx 会重试，耗尽后 `callback_failed` 加 DLQ。
  - Consumer 能对回 invocation。前端只看见 workflow event。

## 面试短答

- 一句话讲这条链？
  - worker 把 `queued` 任务交给厂商，三条入口收成 `ProviderResult`，产物层把成功和失败都送到 `callback_pending`，再签名回调 Consumer。

- 一句话讲 Webhook 和轮询的关系？
  - 它们是同一份结果的两个入口；谁先把任务推进离开 `waiting_provider`，另一边就退出。后面还有 Robin 时，轮询还可以给 Webhook 兜底。

- 一句话讲 `callback_failed`？
  - 结果已经在 AI 文档里，只是通知 Consumer 的重试耗尽了。

- 一句话讲画布为什么不接厂商回调？
  - 厂商回调只更新 `ai_task`。节点状态要等 Consumer 对上 invocation，再走 workflow event。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - provider worker 和 artifact worker 已经挂在 `apps/worker`。
  - 提交、`immediateResult`、polling、fallback 入队、产物整理、签名函数、Webhook service、callback worker、DLQ 都有代码和测试。
  - 运行中的 API Webhook 路由和 callback 队列还没有接上这些类。

- 进程里实际在跑什么？
  - provider worker 会把任务提交到 `waiting_provider`，并把 immediate / polling 的结果送进 artifact 队列。
  - artifact worker 使用 `PassThroughArtifactStore`。
  - attempt repository 没有注入，进程里不写 attempt。
  - `consumer-callback` 队列只被创建，没有 worker 消费。
  - `apps/api` 的 `POST /v1/provider-webhooks/:provider` 使用没有仓储的 `ProviderWebhookService`，收到请求后直接 202。

- 当前 KIE 图像提交后会停在哪？
  - 这条 call 的 `result_mode` 是 `webhook`。
  - worker 只对 `polling` 调用 `getResult()`，不会做参考笔记里的 Webhook 轮询兜底。
  - 提交成功后停在 `waiting_provider`，等厂商回调。回调路由还没把结果写回任务。

- fallback 状态和参考笔记一样吗？
  - 不一样。
  - 还有下一家时写成 `queued`，skip 键是 `provider:model_id`，再入 submit job。
  - 没有 `addRobinSkipProvider()`。
  - 没有下一家才写成 `failed`。
  - 参考路径是失败后可以再回到 `waiting_provider`。

- Webhook 去重现在在哪一层成立？
  - `ProviderWebhookService` 在注入了 task repository 和 event repository 时成立。
  - 它会看 event 是否新插入、是不是当前 attempt、任务是否还停在 `waiting_provider`。
  - 当前 API 启动没有注入这些依赖，所以这条去重不在现网路由上生效。

- 对外 payload 和参考笔记一样吗？
  - 成功状态会从 `succeeded` 收成 `success`。
  - 当前 `result.output` 是可选字符串，并可以带 `artifacts`。
  - 还不是参考笔记里的 `result.output: string[]`。
  - 签名内容已经是 `timestamp.rawBody`。

- Consumer 对单做到哪了？
  - `POST /callbacks/models/{vendor}` 会验原始 body 和时间戳。
  - 对不上 invocation 写入 `pending_model_callbacks`。
  - 对上之后按 idempotency key 和 invocation 终态避免重复写。
  - `consumer_webhook_secret` 为空时验签直接通过。配了密钥才校验。

- 什么时候才算本章完整验收？
  - worker 进程能提交、轮询或收 immediate，并把产物送到 `callback_pending`。
  - 厂商 Webhook 路由注入仓储后，能去重、对上当前 attempt、写入结果。
  - callback worker 真正消费 `consumer-callback`，2xx 写最终状态，耗尽写 `callback_failed` 和 DLQ。
  - Consumer 用原始 body 验签，并能把 `ai_task_id` 挂回 invocation。
  - 前端仍然只消费 workflow event。
