# OpenCreator AI 提交、轮询、Webhook、产物与回调

## 职责

这条链把 `queued` 的 AI 任务真正送到厂商，收敛同步、轮询和厂商 Webhook 三种结果，处理媒体产物，再把统一结果可靠回调给 Consumer。

## 入口

- `provider-execution` 的 `submit` job 只携带 `ai_task_id`。
- 厂商 Webhook 进入 AI API 的 Provider 回调路由，再按 `provider_request_id` 对当前 attempt。
- `artifact-processing` 处理成功产物；失败任务跳过产物处理。
- `consumer-callback` 向建任务时保存的 `webhook_url` 投递；Consumer 入口是 `/callbacks/models/{vendor}`。

## 主链

```text
provider worker 读取 ai_task
  → registry 按 Robin 提交一家
  → 写 provider/provider_request_id/attempt
  → status=waiting_provider
  → immediateResult：当场归一化
     polling：循环 getResult
     webhook：等待厂商回调
  → 失败且仍有 Robin：带 skip_providers 重投下一家
  → provider normalize 使用配置 uploader 转存或透传
  → applyProviderResult 持久化规范结果
  → artifact-processing 整理并持久化结果
  → status=callback_pending
  → HMAC 签名 POST Consumer
  → 2xx 后 status=succeeded|failed
```

Webhook 模式若后面还有 Robin 且实现了 `getResult`，worker 会轮询兜底，避免丢 Webhook 后永远等不到 fallback。最后一家纯 Webhook 可让 job 返回，任务停在 `waiting_provider` 等回调。

## 关键状态/消息

- 提交成功写 `provider_request_id` 和 `ai_task_attempt`，并进入 `waiting_provider`。
- 轮询与 Webhook 都先归一成 `ProviderResult`；谁先把同一 Provider 单推进，另一边检测已完成后退出。
- 成功任务通常写 `processing_artifacts → callback_pending`；失败会先写 `failed`，fallback 可再写回 `waiting_provider`，最终失败也会进入 `callback_pending` 等待通知 Consumer。
- 状态顺序检查函数没有接入实际写路径，不能把上述状态当成严格单向状态机。
- 对外成功状态为 `success`，不是内部的 `succeeded`。
- 对外结果是 `result.output: string[]`；媒体优先使用处理后的 artifact URL，文本被包成单元素数组。
- 回调带 `x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key`，签名内容是 `timestamp + "." + rawBody`。
- Consumer 返回非 2xx、网络错误或超时会重试；次数或窗口耗尽后写 `callback_failed` 并进入 DLQ。

## 关键源码链接

- [Provider 提交、轮询和 fallback](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)
- [厂商 Webhook 收敛](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-webhook-service.ts)
- [产物处理](../../../../../opencreate/opencreator-ai/packages/runtime/src/artifact-worker.ts)
- [回调投递与签名](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)
- [回调重试和 DLQ](../../../../../opencreate/opencreator-ai/packages/runtime/src/callback-worker.ts)
- [统一 Webhook 契约](../../../../../opencreate/opencreator-ai/packages/contracts/src/webhook.schema.ts)
- [任务与 attempt 仓储](../../../../../opencreate/opencreator-ai/packages/db/src/task-repository.ts)
- [Consumer 回调入口](../../../../../opencreate/opencreator-consumer/main.py)
- [Consumer 回调对单](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)

## 跨仓边界

- opencreator-ai 只保证模型结果、产物和回调投递；不直接更新画布节点。
- Consumer 用 `ai_task_id`、外部任务号、`trace_id` 和 `client_context` 把回调挂回 invocation，再推进 DAG。
- Publisher 只在 Consumer 发布节点事件后接住结果并推 WebSocket。
- Frontend 看见的是工作流事件，不接厂商 Webhook，也不轮询 AI task。
- 对象存储上传可能发生在 provider `normalizeResult` 使用的 uploader 中；artifact worker 当前使用 `PassThroughArtifactStore`，负责整理和持久化，不负责再次上传。

## 遗留/未启用

- 最后一家纯 Webhook 若厂商永不回调且没有外部补偿，任务可能长期停在 `waiting_provider`。
- `callback_failed` 后结果仍在 AI 文档中，但现码不会自动重新挂回 Consumer，需运维补偿。
- `TASK_STATUS_ORDER` 未接入 worker/repository 写路径，状态可回退或离开 `failed`。
- 对外 payload 会丢弃内部 telemetry、artifact 元数据和原始厂商响应；不能用回调重建完整 `ai_task`。
- Consumer 对不上 invocation 时先写 pending callback；这不代表 AI 侧投递失败。
