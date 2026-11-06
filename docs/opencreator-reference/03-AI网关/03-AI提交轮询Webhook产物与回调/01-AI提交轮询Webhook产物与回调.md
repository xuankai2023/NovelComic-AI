# OpenCreator 是怎么做 AI 提交、轮询、Webhook、产物与回调的

如果要看机制拆解，读 [00-AI提交轮询Webhook产物与回调技术点.md](./00-AI提交轮询Webhook产物与回调技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一、先说结论

OpenCreator 的 AI 执行不是“提交厂商后直接把结果塞回画布”。`opencreator-ai` 只负责 AI gateway 内部的 Provider 提交、结果归一化、产物整理和 Consumer 回调。

```text
queued ai_task
  → provider worker 提交 Provider
  → waiting_provider
  → immediateResult / polling / provider webhook
  → ProviderResult
  → artifact-processing
  → callback_pending
  → consumer-callback
  → Consumer webhook_url
  → 2xx 后按 task.error 写 succeeded 或 failed
```

必须分清五件事：

- Provider submit：把 AI 任务交给厂商，拿到 `provider_request_id`。
- Provider result：同步、轮询或厂商 Webhook 收敛后的统一结果。
- Artifact processing：把成功或失败任务都推进到可回调状态。
- Consumer callback：把精简结果签名投递给 Consumer。
- Workflow event：Consumer 后续推进 DAG 后，Publisher/Frontend 才能看见节点变化。

---

## 二、必须有的文件

按一次 `queued` 任务继续往下跑的顺序背。

1. `opencreator-ai/packages/runtime/src/provider-worker.ts`：读取 `ai_task`，提交 Provider，处理 polling、immediate result 和 Robin fallback。
2. `opencreator-ai/packages/runtime/src/provider-webhook-service.ts`：接厂商 Webhook，解析、去重、归一化并入后续队列。
3. `opencreator-ai/packages/contracts/src/provider-result.schema.ts`：定义统一 Provider 结果。
4. `opencreator-ai/packages/runtime/src/artifact-worker.ts`：处理产物，把任务推进到 `callback_pending`。
5. `opencreator-ai/packages/runtime/src/consumer-callback.ts`：生成 Consumer 精简 payload、签名并 POST。
6. `opencreator-ai/packages/runtime/src/callback-worker.ts`：执行回调重试、DLQ 和告警。
7. `opencreator-ai/packages/contracts/src/webhook.schema.ts`：定义内部和对外 Webhook payload。
8. `opencreator-ai/packages/db/src/task-repository.ts`：持久化 Provider、result、artifact、callback 状态。
9. `opencreator-ai/packages/db/src/*attempt* / *provider-event* / *callback-delivery*`：记录 attempt、Webhook event 和回调投递。
10. `opencreator-consumer/main.py`：Consumer 接收 AI 回调入口。
11. `opencreator-consumer/services/invocation/model_invocation_service.py`：Consumer 对单、写结果、推进 invocation。

### `opencreator-ai/packages/runtime/src/provider-worker.ts`

OpenCreator 源码：[provider-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)

Provider worker 处理：

```text
provider-execution submit job
  → requireByAiTaskId(ai_task_id)
  → submitCoreTask()
  → markProviderSubmitted()
  → upsertAttempt()
  → status=waiting_provider
```

它还负责：

- immediate result 当场归一化。
- polling 模式循环读取结果。
- webhook 模式在有 fallback 时做轮询兜底。
- Provider 失败时按 Robin 重新入队。
- 成功或最终失败后入 `artifact-processing`。

### `opencreator-ai/packages/runtime/src/provider-webhook-service.ts`

OpenCreator 源码：[provider-webhook-service.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-webhook-service.ts)

厂商 Webhook 到这里收敛。关键动作：

```text
coerceJsonWebhookBody()
  → parseCoreProviderWebhook()
  → resolveTask()
  → isSameProviderAttempt()
  → normalizeCoreProviderResult()
  → record provider event
  → applyProviderResult()
  → enqueue artifact-processing 或 fallback
```

它会忽略旧 attempt 的迟到 Webhook，也会在任务已处理时避免重复推进。

### `opencreator-ai/packages/contracts/src/provider-result.schema.ts`

OpenCreator 源码：[provider-result.schema.ts](../../../../../opencreate/opencreator-ai/packages/contracts/src/provider-result.schema.ts)

这是 Provider 归一化结果的契约。Provider 原始响应必须变成统一结构，后续 artifact worker 和 Consumer callback 才能继续处理。

统一结果至少要表达：

- `status`
- `provider`
- `provider_model_id`
- `provider_request_id`
- `result`
- `usage`
- `error`
- `raw_summary`

### `opencreator-ai/packages/runtime/src/artifact-worker.ts`

OpenCreator 源码：[artifact-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/artifact-worker.ts)

artifact worker 是 Provider 结果和 Consumer 回调之间的过渡层。

成功任务：

```text
processing_artifacts
  → artifactStore.processResult()
  → updateResult()
  → callback_pending
  → enqueue consumer-callback
```

失败任务：

```text
failed
  → skip artifact processing
  → callback_pending
  → enqueue consumer-callback
```

所以失败也会通知 Consumer，不是失败后就停在 AI 侧。

### `opencreator-ai/packages/runtime/src/consumer-callback.ts`

OpenCreator 源码：[consumer-callback.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)

负责生成对 Consumer 的回调：

```text
load task
  → build internal payload
  → build public payload
  → JSON.stringify(publicPayload)
  → createSignature(secret, timestamp, rawBody)
  → POST webhook_url
```

对外 payload 会把内部 `succeeded` 转成：

```text
success
```

并把媒体或文本结果整理成：

```text
result.output: string[]
```

Consumer 返回 2xx 后，AI 侧才更新最终任务状态：

```text
task.error ? failed : succeeded
```

所以“回调投递成功”和“模型生成成功”不是同一件事。失败任务也会被成功投递给 Consumer，然后 AI 侧最终状态仍是 `failed`。

### `opencreator-ai/packages/runtime/src/callback-worker.ts`

OpenCreator 源码：[callback-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/callback-worker.ts)

callback worker 调 `ConsumerCallbackService.deliver()`。失败时判断：

```text
currentAttempt >= maxAttempts
  或 retryWindowMs 已过
```

耗尽后：

```text
markFailed()
  → callback_failed
  → callbackDlq.add()
  → alert
```

`callback_failed` 是投递失败，不是 Provider 又失败了一次。

### `opencreator-ai/packages/contracts/src/webhook.schema.ts`

OpenCreator 源码：[webhook.schema.ts](../../../../../opencreate/opencreator-ai/packages/contracts/src/webhook.schema.ts)

定义两层 payload：

```text
AiTaskWebhookPayload
  → 内部完整 payload

AiTaskPublicWebhookPayload
  → 对 Consumer 的精简 payload
```

对外 status 是：

```text
success | failed | timed_out | cancelled
```

内部 status 是：

```text
succeeded | failed | timed_out | cancelled
```

### `opencreator-ai/packages/db/src/task-repository.ts`

OpenCreator 源码：[task-repository.ts](../../../../../opencreate/opencreator-ai/packages/db/src/task-repository.ts)

这一层负责把执行链路的事实写回任务：

```text
markProviderSubmitted()
updateProviderTelemetry()
applyProviderResult()
updateResult()
updateStatus()
addRobinSkipProvider()
```

排障时要以 task 文档、attempt、provider event 和 callback delivery 一起看，不要只看单个 status。

### `opencreator-consumer/main.py`

OpenCreator 源码：[main.py](../../../../../opencreate/opencreator-consumer/main.py)

Consumer 提供回调入口：

```text
/callbacks/models/{vendor}
```

AI callback 投递到建任务时保存的 `webhook_url`。Consumer 应在入口做签名、幂等和 payload 校验。

### `opencreator-consumer/services/invocation/model_invocation_service.py`

OpenCreator 源码：[model_invocation_service.py](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)

Consumer 收到回调后，对单并写入 invocation：

```text
ai_task_id / external_task_id
trace_id
client_context
result_id
node_id
```

写入 invocation 后，Consumer 才继续推进 DAG、聚合节点结果，并把后续事件交给 Publisher/Frontend。

---

## 三、运行时链路

### 1. Provider worker 读取任务

```text
provider-execution submit job
  → ai_task_id
  → taskRepository.requireByAiTaskId()
```

worker 加载任务后拿到 `model_id`、`options`、`webhook_url`、`trace_id` 和当前 attempt。

### 2. 提交 Provider

```text
submitCoreTask()
  → registry 按 Robin 选择 Provider call
  → call.submit(context)
```

提交成功后写：

```text
provider
provider_model_id
provider_request_id
provider_status
status=waiting_provider
```

### 3. immediate result

如果 `submit()` 返回 `immediateResult`：

```text
call.normalizeResult(immediateResult)
  → applyProviderResult()
  → enqueue artifact-processing
```

这类 Provider 在提交时已经拿到最终结果，不需要等 Webhook 或轮询。

### 4. polling result

如果 `result_mode=polling`：

```text
getCoreProviderResult()
  → call.getResult()
  → call.normalizeResult()
```

如果结果仍是 `waiting_provider`，继续等待或重试；如果成功或失败，就进入 artifact-processing 或 Robin fallback。

### 5. provider webhook result

厂商回调时：

```text
ProviderWebhookService.handleWebhook()
  → parseCoreProviderWebhook()
  → resolveTask()
  → 同 attempt 校验
  → normalizeCoreProviderResult()
  → record provider event
  → applyProviderResult()
```

如果任务已经被轮询处理过，Webhook 不会重复推进。

### 6. Robin fallback

Provider 失败后：

```text
getRemainingRobinProviders()
  → 有剩余 Provider
  → addRobinSkipProvider(provider:model_id)
  → enqueue provider-execution submit job
```

如果没有剩余 Provider，失败结果也会进入 artifact-processing，最终回调 Consumer。

### 7. Artifact processing

```text
artifact-processing
  → load task
  → processing_artifacts 或 skip failed
  → processResult()
  → callback_pending
  → enqueue consumer-callback
```

artifact worker 是进入回调队列前的统一出口。

### 8. Consumer callback

```text
consumer-callback
  → build public payload
  → HMAC sign timestamp + "." + rawBody
  → POST webhook_url
```

2xx 表示 AI 侧投递成功。投递成功后，AI 按 `task.error ? failed : succeeded` 写最终状态。非 2xx、超时或网络错误都会进入重试。

### 9. Callback retry and DLQ

```text
callback worker failed
  → BullMQ retry
  → attempts 或 retry window 耗尽
  → callback_failed
  → callback-dlq
```

进入 DLQ 后，AI 文档里仍可能有 result 或 error。需要运维补偿或人工对账。

---

## 四、对外 payload 形状

对 Consumer 的成功回调大致是：

```json
{
  "ai_task_id": "...",
  "status": "success",
  "model_id": "...",
  "provider": "...",
  "provider_model_id": "...",
  "provider_request_id": "...",
  "client_context": {},
  "result": {
    "output": ["https://..."]
  },
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  },
  "error": null,
  "started_at": "...",
  "completed_at": "..."
}
```

失败回调也会投递，只是：

```text
status=failed
error={ error_code, message, display_group, action, ... }
```

Consumer 不应该用对外 payload 反推 AI 内部完整任务。内部 telemetry、artifact 元数据、raw summary 和 attempt 历史不完整外传。

---

## 五、和 NovelComic 对照

NovelComic 迁移这块时，不要直接从“厂商 Webhook 回来后更新画布节点”开始。

正确顺序是：

1. Provider worker 能提交任务并写 `waiting_provider`。
2. immediate / polling / webhook 三条结果入口都能变成统一 `ProviderResult`。
3. Provider 失败能按 Robin fallback。
4. 成功和最终失败都能进入 artifact worker。
5. artifact worker 统一推进到 `callback_pending`。
6. callback worker 签名投递 Consumer。
7. Consumer 对单后再推进 DAG 和画布事件。

只要 Consumer 还没对单成功，前端就不应该直接从 AI task 推断节点状态。
