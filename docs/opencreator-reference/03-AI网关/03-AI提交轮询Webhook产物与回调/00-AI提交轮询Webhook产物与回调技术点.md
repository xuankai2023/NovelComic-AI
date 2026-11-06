# AI 提交、轮询、Webhook、产物与回调：技术点

这组只讲 `opencreator-ai` 在 `ai_task` 已经 `queued` 之后，如何真正提交 Provider、收敛结果、处理产物，并把精简回调可靠投递给 Consumer。

先背一句话：

```text
provider worker 负责把任务送到厂商；
provider webhook / polling 负责把厂商结果收成 ProviderResult；
artifact worker 负责把结果整理到 callback_pending；
callback worker 负责把精简 payload 签名投递给 Consumer。
```

它不讲任务怎么创建，也不讲模型 registry 怎么选 Provider。建单看 [AI任务契约与状态机](../01-AI任务契约与状态机/01-AI任务契约与状态机.md)，模型注册和 Robin 看 [AI模型注册Provider与Robin](../02-AI模型注册Provider与Robin/01-AI模型注册Provider与Robin.md)。

最短链路是：

```text
provider-execution submit job(ai_task_id)
  → provider worker 读取 ai_task
  → submitCoreTask 按 Robin 提交 Provider
  → markProviderSubmitted 写 provider_request_id / attempt
  → status=waiting_provider
  → immediateResult / polling / provider webhook 收敛成 ProviderResult
  → applyProviderResult 写 result 或 error
  → artifact-processing
  → status=callback_pending
  → consumer-callback deliver
  → HMAC 签名 POST Consumer webhook_url
  → Consumer 返回 2xx
  → 按 task.error 写最终 status=succeeded | failed
```

这篇的边界固定：

- `opencreator-ai` 不直接更新画布节点。
- Consumer 用 `ai_task_id`、`trace_id`、`client_context` 把回调挂回 node invocation。
- Publisher 和 Frontend 只看 Consumer 后续发布的 workflow 事件，不直接接厂商 Webhook。

---

## 1. submit job 只带 `ai_task_id`

OpenCreator 对照：

- [provider-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)

`provider-execution` 队列里的 submit job 只需要：

```text
ai_task_id
skip_providers?
```

worker 开始后，先回库读取完整任务：

```text
taskRepository.requireByAiTaskId(ai_task_id)
```

这样重试、fallback 和恢复都以数据库任务为准，而不是以 job 里复制的一份旧参数为准。

---

## 2. Provider 提交成功后进入 `waiting_provider`

Provider worker 调：

```text
submitCoreTask()
```

成功后写：

```text
provider
provider_model_id
provider_request_id
provider_status
attempt
provider_telemetry
```

并把任务推进到：

```text
waiting_provider
```

这表示任务已经交给某个厂商 Provider，后续等待同步结果、轮询结果或厂商 Webhook。

---

## 3. 结果入口有三种

Provider 结果可能来自三条入口：

```text
immediateResult
  → submit 当场拿到最终结果

polling
  → worker 循环 getCoreProviderResult()

provider webhook
  → ProviderWebhookService.handleWebhook()
```

三条入口最终都要归一成 `ProviderResult`，再写回任务。不要让厂商原始结果直接穿透到 Consumer。

---

## 4. Webhook 会做同 attempt 校验

OpenCreator 对照：

- [provider-webhook-service.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-webhook-service.ts)

厂商 Webhook 到来后，服务会：

```text
parseCoreProviderWebhook(provider, payload, headers)
  → resolveTask(provider_request_id / ai_task_id)
  → 判断是否是当前 active provider attempt
```

如果 Webhook 属于旧 attempt，或任务已经被别的路径处理过，就不会重复推进当前任务。

这解决两个问题：

- Robin fallback 后，旧 Provider 迟到的 Webhook 不能覆盖新 Provider 的结果。
- 轮询已经拿到结果时，重复 Webhook 不能再次写入和重复入队。

---

## 5. Webhook 模式也可能被 worker 轮询兜底

Provider call 的 `result_mode` 是 `webhook`，不代表 worker 一定立刻退出。

如果后面还有 Robin Provider，而且当前 call 实现了 `getResult()`，worker 会做轮询兜底：

```text
webhook provider + has getResult + has remaining robin
  → worker 轮询
  → 失败可触发 fallback
```

目的不是替代 Webhook，而是防止厂商 Webhook 丢失后任务永久停在 `waiting_provider`，导致后面的 Robin 永远没机会。

最后一家纯 Webhook 没有 fallback 时，worker 可以返回，让任务停在 `waiting_provider` 等厂商回调或外部补偿。

---

## 6. Provider 失败不一定是最终失败

Provider 失败后要看 Robin：

```text
当前 Provider 失败
  → 记录 attempt failure
  → addRobinSkipProvider(provider:model_id)
  → 如果还有 remaining Provider
       enqueue fallback submit job
  → 否则写最终 failed
```

所以 `failed` 在内部可能出现后又被 fallback 拉回 `waiting_provider`。不能只按状态顺序表推断任务历史。

---

## 7. `applyProviderResult` 是结果入库口

无论结果来自 immediate、polling 还是 webhook，归一化后都要写任务：

```text
applyProviderResult(ai_task_id, ProviderResult)
```

成功结果通常会继续进入：

```text
artifact-processing
```

失败结果也会进入 artifact worker，但 artifact worker 会跳过产物处理，直接转入 callback。

---

## 8. artifact worker 负责进入 `callback_pending`

OpenCreator 对照：

- [artifact-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/artifact-worker.ts)

成功任务：

```text
status=processing_artifacts
  → artifactStore.processResult(task.result)
  → updateResult()
  → status=callback_pending
  → enqueue consumer-callback
```

失败任务：

```text
status=failed
  → skip artifact processing
  → status=callback_pending
  → enqueue consumer-callback
```

当前 artifact worker 使用配置的 `ArtifactStore` 处理结果。对象存储上传也可能已在 Provider `normalizeResult()` 使用的 uploader 中完成，不能假设 artifact worker 一定再次上传媒体。

---

## 9. Consumer 回调发送的是精简 payload

OpenCreator 对照：

- [consumer-callback.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)
- [webhook.schema.ts](../../../../../opencreate/opencreator-ai/packages/contracts/src/webhook.schema.ts)

AI 内部 payload 是：

```text
AiTaskWebhookPayload
```

对 Consumer 发送的是精简版：

```text
AiTaskPublicWebhookPayload
```

关键差异：

- 内部成功状态是 `succeeded`，对外成功状态是 `success`。
- 对外结果只保留业务需要的 `result.output: string[]`。
- 媒体结果优先取 artifacts URL。
- 文本结果被包装成单元素数组。
- 内部 telemetry、raw summary 和 artifact 元数据不会完整外传。

---

## 10. 回调有 HMAC 签名

Consumer callback 请求头包括：

```text
content-type: application/json
x-oc-timestamp
x-oc-signature
x-oc-idempotency-key
```

签名内容是：

```text
timestamp + "." + rawBody
```

签名密钥来自 AI 配置：

```text
consumerWebhookSecret
```

Consumer 必须用原始 body 验签，不能用重新序列化后的 JSON 字符串验签。

---

## 11. 非 2xx 会重试，耗尽后进 DLQ

OpenCreator 对照：

- [callback-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/callback-worker.ts)
- [consumer-callback.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)

回调失败包括：

- 网络错误。
- 超时。
- Consumer 返回非 2xx。

callback worker 会按 BullMQ attempts 和 retry window 重试。达到最大次数或超过重试窗口后：

```text
markFailed()
  → status=callback_failed
  → enqueue callback-dlq
  → alert
```

`callback_failed` 表示投递 Consumer 失败，不表示模型执行又失败了一次。

Consumer 返回 2xx 后，AI 侧才会结束回调链路；最终任务状态由任务是否带 `error` 决定：

```text
task.error 存在
  → status=failed

task.error 不存在
  → status=succeeded
```

---

## 12. Consumer 对单不是 AI 侧投递成功的同义词

OpenCreator 对照：

- [Consumer 回调入口](../../../../../opencreate/opencreator-consumer/main.py)
- [model_invocation_service.py](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)

AI 侧只知道 HTTP 是否 2xx。Consumer 收到后，还要按：

```text
ai_task_id
external_task_id
trace_id
client_context
result_id
node_id
```

把回调挂回对应 invocation。

如果 Consumer 暂时对不上 invocation，可能先写 pending callback。这不等于 AI 投递失败，也不等于 Provider 失败。

---

## 动手前要有的东西

### opencreator-ai

- provider-execution 队列。
- provider worker。
- Provider call 的 `submit()`、`getResult?()`、`normalizeResult()`。
- provider webhook 路由和 `ProviderWebhookService`。
- `ProviderResult` / webhook payload schema。
- artifact store 和 artifact worker。
- consumer callback service。
- callback worker、retry 和 DLQ。

### Consumer

- `/callbacks/models/{vendor}` 入口。
- HMAC 验签。
- `ai_task_id` / `external_task_id` 对单逻辑。
- pending callback 存储。
- invocation 结果写入和 DAG 推进。

### 运维

- `trace_id` 从 Consumer 到 AI 再回 Consumer。
- provider request id 可查。
- attempt、provider event、callback delivery 可查。
- DLQ 和告警可查。
