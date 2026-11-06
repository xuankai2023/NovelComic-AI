# AI 提交、轮询、Webhook、产物与回调：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-ai`、`opencreator-consumer`。NovelComic 看 `novelcomic-ai`、`novelcomic-consumer`。

不在这一份：建单 HTTP 信封、`ai_task` 建单字段、`markProviderSubmitted()` 写成 `waiting_provider`、`applyProviderResult()` 的状态名、fallback 的 `jobId` 和「轮询失败保持 `waiting_provider`、抛错先写成 `failed`」。这些在「AI 任务契约与状态机」。`CORE_MODELS`、一次 `submitCoreTask()` 里换下一家、约束预校验、图片 URL 改写、Consumer 别名表在「AI 模型注册、Provider 与 Robin」。这里只补提交返回之后怎么轮询、厂商 Webhook 怎么收敛、产物怎么上传、对 Consumer 的 payload 和重试，以及 Consumer 怎么验签和对单。

上一节已经规定的状态名和 `jobId` 保持不动。`provider-${ai_task_id}-fallback-${nextProvider.provider}` 不要再接厂商模型 ID。`robin_skip_providers` 不要改回 `skip_providers`。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。差的是类放在哪个文件、日志文案。

- 队列名是 `provider-execution`、`artifact-processing`、`consumer-callback`、`consumer-callback-dlq`
- 产物 job 名是 `process`，`jobId` 是 `artifact-${ai_task_id}`。回调 job 名是 `deliver`，`jobId` 是 `callback-${ai_task_id}`。DLQ job 名是 `failed`，`jobId` 是 `callback-dlq-${ai_task_id}`
- 签名是 HMAC-SHA256，内容是 `timestamp + "." + rawBody`，头是 `content-type: application/json`、`x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key`。每次投递的幂等键是 `${randomUUID()}:${timestamp}`
- MiniMax 的 `challenge` 用 HTTP 200 原样回 `{ challenge }`，不套 `{ code, msg, data }`。带 `task` 对象时把 `task.id` 收成顶层 `task_id`、`task.status` 收成顶层 `status`
- 腾讯验签是 `MD5(SignKey + T)`。没配 SignKey 放行，`reason` 是 `signKey not configured`。缺 `Sign`/`T`、签名不一致、`T` 早于当前秒，分别是 `missing Sign/T`、`sign mismatch`、`signature expired`，HTTP 403，`msg` 是 `invalid_signature`，`data` 是 `{ status: "rejected", reason }`
- `ensureMongoIndexes()` 里 `ai_task_attempt` 的 `{ ai_task_id, attempt }` 唯一、`ai_provider_event` 的 `{ provider, provider_request_id, event_id }` 唯一、`ai_callback_delivery` 的 `{ ai_task_id, attempt }` 唯一，这三条保持不动。不要再在 `provider_events` 上另建一套
- 失败任务跳过 `processResult()`，直接 `callback_pending` 再入回调队列。其余状态先 `processing_artifacts`，再 `processResult()`、`updateResult()`、`callback_pending`

回调 2xx 之后按有没有 `error` 写 `failed` 或 `succeeded`、投递耗尽写 `callback_failed`、写之前不做状态顺序检查，这些在「AI 任务契约与状态机」。现码里 `consumer-callback.ts` 仍会先 `assertTaskStatusCanAdvance()`，那一节拿掉，这里不要当成已经对齐。

# 1. 结果契约和 telemetry 按现码收紧

做完要达到：`ProviderResult.usage` 用 `UsageFact`。字段是可选的 `input_tokens`、`output_tokens`、`duration_seconds`、`generated_count`、`artifact_count`、`provider_raw`。没有 `cost`、`currency`。

`NormalizedError.code` 和 `message` 允许空字符串。`aspect_ratio` 不要求 `min(1)`。`provider_model_id`、`provider_request_id`、`provider_status` 允许空字符串。

`ProviderTelemetryAttempt` 在现有耗时字段之外还有可选的 `error_params`、`started_at`、`completed_at`。后两个是带时区偏移的 ISO 字符串。

`AiTaskAttemptDocument`、`AiProviderEventDocument`、`AiCallbackDeliveryDocument` 与 OpenCreator `packages/contracts/src/db.schema.ts` 同名字段相同。callback delivery 的 `status` 含 `pending`、`succeeded`、`failed`、`dead_lettered`。文档里不存 `raw_body`。有 `request_body_hash`、`next_retry_at`。

## 现在

usage 是 `input_tokens`、`output_tokens`、`total_tokens`、`cost`、`currency`。错误的 `code` 和 `message` 要求非空。attempt 和 provider event 没有契约，只在 `mongo.ts` 里留了三个字段的占位。callback delivery 多了 `raw_body`，没有 `next_retry_at`，`status` 只有成功和失败。telemetry attempt 没有 `error_params` 和时间。

## 改哪些文件

1. `novelcomic-ai/packages/contracts/src/provider-result.schema.ts`。对照 OpenCreator 同名文件和 `usage.schema.ts`。
2. `novelcomic-ai/packages/contracts/src/db.schema.ts` 的 telemetry、attempt、provider event、callback delivery。对照 OpenCreator `db.schema.ts` 和 `common.ts` 里的 `ProviderTelemetrySchema`。
3. `novelcomic-ai/packages/db/src/mongo.ts` 的占位类型换成上面的契约。索引保持已经对齐的那三条。

# 2. provider worker 在 `submitCoreTask()` 返回之后

做完要达到：`process()` 吃 BullMQ 的 job，能读到 `attemptsMade` 和 `opts.attempts`。`skip_providers` 只取 `job.data.skip_providers`，没有就是空数组。模型 id 用 `task.model_id`。

提交成功后的 attempt 写到 `ai_task_attempt`，键是 `ai_task_id + attempt`，`attempt` 是任务上的 `attempt + 1`。`submit_payload_summary` 是 `task.input_summary`。`provider_response_summary` 是 `submit.raw_summary`。`status` 缺省是 `submitted`。

同时 `updateProviderTelemetry()`：`provider`、`provider_model_id`、`provider_request_id`、`status`（缺省 `submitted`）、`queue_wait_ms`、`submit_duration_ms`。`queue_wait_ms` 在 `created_at` 不大于 0 时不写。

要不要接着等结果：

```text
submit.result_mode === "polling"
  或 当前 call 有 getResult 且后面还有 Robin
```

两条都不成立，job 在记下 attempt 之后返回。任务停在 `waiting_provider`。这时即使 submit 带了 `immediateResult`，worker 也不归一化。

两条成立时：

- 有 `immediateResult` 且能按 `provider + 厂商模型 ID` 找到 call：用去掉 `provider` 之后的 options 组 context，`normalizeResult(immediateResult, context)`，`applyProviderResult()`。状态不是 `waiting_provider` 就入产物队列。然后返回，不再轮询。找不到 call 时，这份 `immediateResult` 不消费，继续往下走轮询
- 有 `firstPollResult` 且能找到 call：对它做同一次 `normalizeResult()`，不再发首次查询。找不到 call 时改走 `getCoreProviderResult()`
- call 登记的是 `webhook`：先合成一条 `waiting_provider`，不立刻 `getResult()`。打点原因是 `webhook_preferred`
- 其余：立刻 `getCoreProviderResult()`

然后只要状态还是 `waiting_provider` 就循环。间隔是 `polling.intervalMs`，缺省 5000。超时是 `polling.providerTimeoutMs[provider]`，没有就用 `polling.timeoutMs`，缺省 600000。`luma` 缺省 1800000。

webhook 兜底每次等待前后都回库看任务。当前 `provider` 和 `provider_request_id` 仍是这一家，并且状态已经是终态、`processing_artifacts`、`callback_pending`、`callback_succeeded`、`callback_failed` 之一，job 直接返回，不再 `applyProviderResult()`。

超时把结果改成 `failed`。`error.code` 是 `provider_error`，`retryable` 是 false，文案是 `Provider polling timed out after ${秒}s`，秒数是经过毫秒除以 1000 后四舍五入。

轮询得到 `failed` 并且还有下一家：按上一节入 fallback，不把这次失败写成任务终态。这次 `skip_providers` 只在 `job.data.skip_providers` 后面接 `${provider}:${model_id}`，不读任务文档上的 `robin_skip_providers`。同时 `recordProviderTelemetryAttempt()`，`phase` 是 `polling`，并 `notifyProviderFailure()`。

没有下一家：`applyProviderResult()`，记 telemetry，失败再通知，然后入产物队列。产物 job 的 data 只有 `{ ai_task_id }`。

`submitCoreTask()` 或后面的归一化抛错：

```text
normalizeProviderFailureError()
  → 失败的 attempt 写入 ai_task_attempt
  → applyProviderResult(failed)，error 用 selectMostHelpfulProviderFailure()
  → 这次抛错还没被记成 phase 不是 provider_job 的失败 telemetry 时，再记一条 phase=provider_job
  → retryable 且 job.attemptsMade + 1 小于 opts.attempts（opts 没有数字时按 3）
       原样抛出，让 BullMQ 重试同一条 job
  → 否则还有下一家：上一节的抛错 fallback
  → 没有下一家：再 apply 一次 failed，入产物队列
```

抛错这条里，当前 provider 还是 `unknown` 时，剩余 call 按空处理，不入 fallback，直接走最终失败。能确定 provider 时，`skip_providers` 是任务上的 `robin_skip_providers`、`job.data.skip_providers` 和这次失败键的去重并集。轮询失败那条不要用这个并集。

`selectMostHelpfulProviderFailure()`、`USER_ERROR_CODE_PRIORITY`、`isRetryableUserErrorCode()` 与 OpenCreator `provider-worker.ts` 同名函数相同。telemetry 的字段和「有才写」的规则对照同文件的 `buildProviderTelemetryAttempt()`。

`applyProviderResult()` 除了上一节的状态和 `completed_at`，还写 `provider`、`model_id`。`provider_model_id`、`provider_request_id`、`provider_status`、`result`、`usage`、`error` 有值就 `$set`，是 `undefined` 就 `$unset`。等待中的结果因此会清掉任务上原来的 `error`。

`onProviderAttemptFailed` 在上一节的换家回调之后，仍要记 telemetry 并 `notifyProviderFailure()`。回调自己抛错只记日志。飞书通知的认领、文案和「发送失败不抛出」在第 10 节。

## 现在

`process()` 只吃 job data。轮询只打一次 `getResult()`，超时缺省 30 秒，文案是 `Provider polling timed out after ${timeoutMs}ms`。没有间隔循环，没有 webhook 兜底，没有 `firstPollResult`。`immediateResult` 在任何 `result_mode` 下都会归一化。attempt 仓库没有接到 worker，`submit_payload_summary` 用的是 `options`。抛错不会按 `retryable` 交回 BullMQ。产物 job 多带了 `enqueued_at`。

## 改哪些文件

1. `novelcomic-ai/packages/runtime/src/provider-worker.ts`。对照 OpenCreator `packages/runtime/src/provider-worker.ts`。状态名和 fallback `jobId` 保持上一节。
2. `novelcomic-ai/packages/core/src/model-runtime.ts` 补 `getCoreProviderResult()`、`normalizeCoreProviderResult()`。对照 OpenCreator 同名函数。`getResult(provider_request_id, context)` 的入参形状保持上一节。
3. `novelcomic-ai/packages/db/src/task-repository.ts` 补 `recordProviderTelemetryAttempt()`。`$push` 的路径是 `provider_telemetry.attempts`，其余 telemetry 用点路径 `$set`，`undefined` 不写。

# 3. 厂商 Webhook 先解析成 `ParsedProviderResult`

做完要达到：`parseCoreProviderWebhook(provider, payload, headers)` 返回 `ParsedProviderResult`。`headers` 不参与解析。失败结果没有 `error_code` 时，用 `classifyWebhookError()` 补上 `error_code` 和 `error_params`。

分支和现码相同：`fal`、`google`、`baidu`、`sufy`、`qnaigc`、`kie`、`kling`、`tencent`、`minimax`，以及 polling 名单 `openai`、`anthropic`、`xai`、`byteplus`、`volcengine`、`ideogram`、`runway`、`luma`、`fish_audio`、`replicate`、`deer`、`aliyun`。名单外抛 `Provider webhook is not supported in core: ${provider}`。每个分支调用的 `normalize*Payload` 与 OpenCreator `model-runtime.ts` 里这一函数相同，按该函数和它调用的文件 diff，不另写一套通用字段扫描。

`getCoreProviderResult()` 和 `normalizeCoreProviderResult()` 在归一化之后，失败结果仍没有 `error_code` 时走 `classifyProviderFailure()`。

厂商 HTTP 的路径和请求体也在这一节补完。上一节只要求 call 接上现码的 `submit`、`getResult`、`normalizeResult`。字节布局对照 OpenCreator `packages/core/src/api/**` 和 `packages/core/src/provider/**` 的同路径文件。Webhook 用到的 `normalize*Payload` 多在 `provider/`，不在 `api/`。

单次厂商请求的超时缺省：同步调用 120000 毫秒，提交 60000，下载 60000，单次轮询请求 30000。这是 `fetchTimeout`，和上面 worker 自己的轮询总超时不是同一个数。

## 现在

`parseCoreProviderWebhook()` 只抽出 `ai_task_id`、`provider_request_id`、`provider_model_id`、`provider_status`、`event_id`、`event_type`、`attempt`。不返回状态、结果和错误。没有 `getCoreProviderResult()`、`normalizeCoreProviderResult()`。`packages/core/src/api` 还没有现码那套厂商客户端。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/model-runtime.ts` 的 `parseCoreProviderWebhook()`、`getCoreProviderResult()`、`normalizeCoreProviderResult()`。对照 OpenCreator 同名函数。
2. `novelcomic-ai/packages/core/src/error-classifier.ts` 的 `classifyWebhookError()`、`classifyProviderFailure()`。对照 OpenCreator 同名文件。
3. `novelcomic-ai/packages/core/src/api/**` 和 `packages/core/src/provider/**`。对照 OpenCreator 同目录。模型有没有进 `CORE_MODELS` 仍按上一节。
4. `novelcomic-ai/packages/config` 的 `fetchTimeout` 四个缺省值。对照 OpenCreator `load-config.ts`。

# 4. Webhook 服务按当前 attempt 决定要不要推进

做完要达到：`handleWebhook()` 的顺序是：

```text
coerceJsonWebhookBody()
  → parseCoreProviderWebhook()
  → resolveTask()
  → isSameProviderAttempt()
  → 已经离开 waiting_provider：按下面的重放规则入队后返回
  → normalizeCoreProviderResult()
  → recordEvent()
  → 非 waiting 且 event.inserted：记 phase=webhook 的 telemetry
  → failed 且还有下一家：addRobinSkipProvider + 入 fallback，不 applyProviderResult
  → 否则 applyProviderResult
  → 状态不是 waiting_provider：入产物队列
```

`coerceJsonWebhookBody()`：纯文本先 `JSON.parse`。对象的 `data` 是字符串，并且 trim 后以 `{` 或 `[` 开头，才把 `data` 解析成 JSON。解析失败保持原值。

`resolveTask()`：payload 里能读到 `ai_task_id` 或 `external_task_id` 就 `getByAiTaskId()`。查找顺序是顶层、`metadata`、`data`、`data.task_info`。不用顶层 `id`。读不到时用 `getByProviderRequestId({ provider, providerRequestId })`，两个字段一起匹配。都没有就抛普通 `Error`，文案是 `Provider webhook did not include ai_task_id`。上一节的 5xx 会把 `msg` 收成 `Internal Server Error`。

`isSameProviderAttempt()` 只比 provider 和 `provider_request_id`。任务上的 provider 与这次不同就是旧 attempt。两边的 request id 都有、webhook 的 id 不是 `unknown`、且不相等，也是旧 attempt。不比厂商模型 ID，不比 attempt 数字。旧 attempt 返回按任务文档拼出的 `ProviderResult`，不写库、不入队。

任务状态已经不是 `received`、`queued`、`submitted_to_provider`、`waiting_provider`：

- 拼出当前任务的 `ProviderResult` 并返回
- `failed` 且还有下一家：`$addToSet` 跳过键，再入上一节的 fallback。跳过列表只用来自任务文档的 `robin_skip_providers` 加上这次的键，没有 job data 可以并进去
- `failed` 或 `succeeded`：再入一次产物队列

`event.inserted` 不挡住上面的重放，也不挡住「没有下一家时」的产物入队。它只决定要不要记 webhook telemetry。

event 的唯一键是 `provider + provider_request_id + event_id`，`$setOnInsert`。`provider_request_id` 没有时写成 `unknown`。`event_type` 固定是 `webhook`。`signature_verified` 固定是 true。`event_id` 取 payload 的 `event_id`、`id`、`request_id`、`task_id`、`taskId` 里第一个非空字符串；再有 `status`、`task_status`、`callbackType` 之一就接成 `${baseId}:${status}`。一个都没有就用 `nanoid()`。

HTTP：

```text
POST /v1/provider-webhooks/:provider
```

路径里的 provider 不 trim、不转小写。成功是 HTTP 200，`msg` 是 `accepted`，`data` 是 `{ status: "accepted", provider_status }`。`data` 里不放 `provider`。

## 现在

解析之后用 `call.normalizeResult(payload)`，吃的是原始 body。重复 event 直接返回，不再重放 fallback 和产物入队。同 attempt 还比较厂商模型 ID 和 attempt 数字。离开 `waiting_provider` 就停，不重放。失败且有下一家会走 `markProviderFailedAttempt()`，`jobId` 多了厂商模型 ID。event 写在 `provider_events`，唯一键是 `provider + event_id`。`signature_verified` 只在腾讯头 `x-oc-signature-verified` 为 `true` 时为真。路由把 provider 转成小写，成功回 HTTP 202，`data` 里多了 `provider`。

## 改哪些文件

1. `novelcomic-ai/packages/runtime/src/provider-webhook-service.ts`。对照 OpenCreator 同名文件，含 `resolveAiTaskId()`、`resolveEventId()`、`isSameProviderAttempt()`。
2. `novelcomic-ai/apps/api/src/routes/provider-webhooks.ts`。对照 OpenCreator 同名路由。腾讯验签和 MiniMax challenge 保持已经对齐的结果。
3. `novelcomic-ai/packages/db/src/provider-event-repository.ts`。对照 OpenCreator `recordEvent()` 和 `listByTask()`。集合用 `ai_provider_event`。
4. `novelcomic-ai/packages/db/src/task-repository.ts` 的 `getByProviderRequestId({ provider, providerRequestId })`。

# 5. 产物上传发生在 normalize，artifact worker 不再传一遍

做完要达到：worker 和 Webhook 的 context 使用 `createArtifactUploader(config)`。`pass_through` 用上一节的 `passThroughUploader`，`uploadRemoteUrl` 返回 `{ url }`。

`cos` 和 `s3` 先下载远程文件，超时 600000 毫秒，HTTP 不成功抛 `Failed to download artifact: ${status} ${url}`。对象键是 `${prefix}/result-${nanoid(32)}.${ext}`。`prefix` 看 `model_id` 按 `/` 分开的第二段：含 `audio` 或 `voice` 是 `audio`，含 `video` 是 `videos`，含 `image` 是 `images`，否则 `files`。扩展名先取 URL 路径最后一段，长度不超过 4 且只含字母数字才用；否则按 content-type 映射 `mp4`、`webm`、`png`、`jpg`、`gif`、`webp`、`mp3`、`wav`，对不上用 `bin`。公开 URL 是 CDN 域名拼这个键。返回值带 `url`，以及有才写的 `mime_type`、`file_size`、`width`、`height`、`duration_seconds`、`aspect_ratio`。缺密钥、桶、地域或 CDN 域名时，进程在创建 uploader 时抛错，文案与 OpenCreator `uploader-factory.ts` 相同。

`PassThroughArtifactStore.processResult()` 不下载、不改 `artifacts`。没有 `artifact.baseUrl` 时原样返回。有的话只在 `metadata` 里加上 `artifact_base_url`。

artifact worker 只把 `status === "failed"` 跳过 `processResult()`。`timed_out` 和 `cancelled` 仍走整理。失败那条的 `artifact_process_ms` 是 0。`total_gateway_ms` 在 `created_at` 不大于 0 时不写。`notifyOnce()` 在入回调队列之前。回调 job data 是 `{ ai_task_id, enqueued_at }`。

provider worker 的 context 还带 `MongoMediaAssetResolver`。只有 `byteplus` 会查人脸记录。`verification_status === "active"` 时返回 `asset://${asset_id}`。有记录但还没 active 是 `not_ready`。没有记录，或其他 provider，是 `not_found`。

## 现在

`RemoteArtifactUploader` 不下载、不上传，只拼一个 `${base}/artifacts/${Date.now()}-${safeName}`。`DefaultArtifactStore` 会按 artifact URL 再走一遍 uploader。worker 创建的是 `PassThroughArtifactStore`，但 context 没有把真正的 uploader 交给 `normalizeResult()`。没有 `MongoMediaAssetResolver`。

## 改哪些文件

1. `novelcomic-ai/packages/storage/src/artifact-store.ts`、`artifact-uploader-utils.ts`、`cos-uploader.ts`、`s3-uploader.ts`、`uploader-factory.ts`。对照 OpenCreator `packages/storage/src` 同名文件。
2. `novelcomic-ai/packages/runtime/src/artifact-worker.ts`。对照 OpenCreator 同名文件。失败跳过和成功整理的状态已经对齐，补 telemetry 的 0 值和 job data。
3. `novelcomic-ai/packages/runtime/src/media-asset-resolver.ts`。对照 OpenCreator 同名文件。由 provider worker 和 Webhook 的 `execution_options` 传入。

# 6. 给 Consumer 的 payload 和投递记录

做完要达到：内部 payload 是 `AiTaskWebhookPayload`。`status` 在任务有 `error` 时是 `failed`，否则 `timed_out`、`cancelled`、`failed` 保持原样，其余收成 `succeeded`。`started_at` 用 `task.started_at ?? task.created_at`。`completed_at` 用 `task.completed_at ?? new Date()`。有 telemetry 就放 `provider_telemetry`。

对外 payload 是 `AiTaskPublicWebhookPayload`：

```text
status          succeeded 收成 success，其余同内部
result          有 artifacts 就用它们的 url；否则 output 非空字符串包成单元素数组。都没有就不放 result
usage           总是有。prompt_tokens = input_tokens ?? 0，completion_tokens = output_tokens ?? 0，total_tokens 是两者相加
error           没有错误是 null。有错误是 { error_code, message, display_group, action, error_params?, provider_message }
```

对外不放 `trace_id`。`provider_telemetry` 和 `client_context` 有才放。

`error_code` 缺省走 `EC.GENERATION_FAILED`。`message`、`display_group`、`action`、`error_params` 对照 OpenCreator `consumer-callback.ts` 的 `buildPublicError()`，以及 `formatErrorMessage()`、`getDisplayGroupForCode()`、`extractParamsFromMessage()`、`sanitizeProviderMessage()`。`locale === "en"` 不查 reason 库。`zh` 用 `ReasonMappingStore.resolveReason()`。`provider_message` 是归一化错误上的原始 `message`。

投递记录：

```text
ai_task_id
webhook_url
attempt                  callbackAttempt，缺省 1
status                   2xx 是 succeeded，否则 failed
idempotency_key
request_body_hash        sha256 hex
response_status          拿到 HTTP 响应才有
response_body_summary    正文或异常 message，截到 2000 字
next_retry_at            非 2xx 且 Retry-After 能解析时才有
```

`Retry-After` 是非负数字时按秒乘 1000。是日期时用该时刻减去现在，小于 0 按 0。解析不了就没有。

网络错误和超时抛 `OpenCreatorAiError`，`kind` 是 `callback_error`，`retryable` 是 true，文案是 `Consumer callback request failed`。非 2xx 文案是 `Consumer callback failed with status ${status}`，`retryable` 仅在状态大于等于 500 或等于 429 时为真。两种错误的 `details.callbackDelivery` 都带上请求体、请求头、webhook、模型、provider。请求超时缺省 30000 毫秒。

`deliver()` 在组 payload 之前先 `notifyOnce()`。飞书失败按第 10 节吞掉，不能挡住这次 POST。

2xx 之后的状态写入保持上一节，不在写之前做顺序检查。

## 现在

对外 payload 仍带 `trace_id`，`result` 是内部的 `NormalizedTaskResult`，`usage` 是任意对象且可以省略，`error` 是 `{ code, message, retryable?, details? }`。`started_at` 用 `created_at`。投递记录存了 `raw_body`，不存 `next_retry_at`。失败类型是 `ConsumerCallbackDeliveryError`。2xx 之前还会 `assertTaskStatusCanAdvance()`。

## 改哪些文件

1. `novelcomic-ai/packages/contracts/src/webhook.schema.ts`。对照 OpenCreator 同名文件。
2. `novelcomic-ai/packages/runtime/src/consumer-callback.ts`。对照 OpenCreator 同名文件，含 `buildPublicCallbackOutput()`、`buildPublicError()`、`createSignature()`。
3. `novelcomic-ai/packages/errors` 里被 `buildPublicError()` 用到的 `formatErrorMessage()`、`getDisplayGroupForCode()`、`extractParamsFromMessage()`、`extractMatchableProviderMessage()`。对照 OpenCreator `packages/errors`。
4. `novelcomic-ai/packages/runtime/src/reason-mapping-store.ts` 和 loader。对照 OpenCreator 同名文件。`zh` 的 reason 替换走这里。
5. `novelcomic-ai/packages/db/src/callback-delivery-repository.ts`。对照 OpenCreator `upsertDelivery()`。去掉 `raw_body`。

# 7. 回调重试、DLQ 和告警

做完要达到：`consumer-callback` 的缺省尝试次数是 `callback.retryAttempts`，缺省 5。退避类型是 `callback-decorrelated-jitter`。`calculateCallbackBackoff()` 与 OpenCreator `packages/queues/src/queues.ts` 相同：优先用错误上的 `retryAfterMs`，否则在 `retryMinDelayMs` 和 `min(retryMaxDelayMs, 上次 delay * 3)` 之间取随机整数。下一次唤醒会超出 `retryWindowMs` 时返回 `-1`。缺省 `retryWindowMs` 是 86400000，`retryMinDelayMs` 是 5000，`retryMaxDelayMs` 是 3600000。

`provider-execution` 和 `artifact-processing` 的缺省尝试次数是 3，指数退避，起始 5000。完成记录保留 86400 秒、最多 1000 条。失败记录保留 604800 秒。DLQ 完成记录同样保留 `dlqRetentionSeconds`，缺省 604800，最多 10000 条。

worker 并发缺省：provider 5，artifact 5，callback 20。

callback worker 用 `job.attemptsMade + 1` 当本次次数，`job.opts.attempts` 不是数字时按 1。次数到顶，或 `now - (enqueued_at ?? job.timestamp) >= retryWindowMs`，就：

```text
markFailed()
  → callbackDlq.add，data 是 { ai_task_id, failed_at, reason, attempts_made }
  → alert
  → 再把原错误抛出
```

告警文案对照 `buildCallbackDlqAlertText()`。开头是 `[OpenCreator AI] Callback 回调最终失败`。带环境、队列名、任务 ID、失败原因、尝试次数、重试窗口、失败时间。有投递上下文时再带 trace、模型、provider、webhook、最后一次 HTTP 状态和响应摘要，以及一条可复放的 curl。飞书发送失败只记日志，不改变 DLQ 已经写入的结果。未启用告警时直接返回。

## 现在

三条业务队列都没有缺省尝试次数和退避。callback worker 在没传 `retryWindowMs` 时永不因窗口耗尽。告警在 DLQ 之前发出，文案是 `=== NovelComic AI 回调最终失败 ===`，带 `atAll`，没有 curl，也没有最后一次响应。

## 改哪些文件

1. `novelcomic-ai/packages/queues/src/index.ts`。对照 OpenCreator `packages/queues/src/queues.ts` 和 `workers.ts` 的缺省 job 选项、`calculateCallbackBackoff()`、并发。
2. `novelcomic-ai/packages/runtime/src/callback-worker.ts`。对照 OpenCreator 同名文件。`process()` 继续吃完整 job。
3. `novelcomic-ai/packages/runtime/src/alert-service.ts`。对照 OpenCreator `alert-service.ts` 的 `notifyCallbackDlq()` 和 `buildCallbackDlqAlertText()`。
4. `novelcomic-ai/packages/config` 的 polling、callback、queue 并发缺省值。对照 OpenCreator `load-config.ts` 里这三块。

# 8. Worker 把这些依赖接上

做完要达到：provider worker 拿到 config、四份 repository、队列、uploader、`MongoMediaAssetResolver`、`ModelCallNotifier`。Webhook 路由拿到同一套 task repository、provider event repository、队列、uploader、notifier。artifact worker 拿到 `PassThroughArtifactStore`。callback worker 拿到带 `ReasonMappingStore` 的 `ConsumerCallbackService` 和 `AlertService`。

`AttemptRepository.upsertAttempt()` 按 `ai_task_id + attempt` 整份 `$set`。`listByTask()` 按 `attempt` 升序。provider event 的 `listByTask()` 按 `received_at` 升序。callback delivery 的 `listByTask()` 按 `attempt` 升序。三份列表都去掉 `_id`。

provider worker 和 artifact worker 的 `process()` 都吃完整 job，否则第 2 节读不到 `attemptsMade`。

## 现在

`apps/worker/src/index.ts` 把 attempt repository 传成 `undefined`。Webhook 路由默认 `new ProviderWebhookService()`，没有 repository 和队列。provider worker 和 artifact worker 只把 `job.data` 交进去。

## 改哪些文件

1. `novelcomic-ai/apps/worker/src/index.ts`。对照 OpenCreator `apps/worker/src/main.ts` 里组 processor 的那一段。人脸核验队列不在这一节改。
2. `novelcomic-ai/packages/db/src/attempt-repository.ts`。对照 OpenCreator 同名文件。
3. `novelcomic-ai/apps/api` 注册 Webhook 路由的地方，把第 4 节的 service 依赖传进去。

# 9. Consumer 收下回调并对回 invocation

做完要达到：`POST /callbacks/models/{vendor}` 先把 vendor 转成小写，并把 `-` 换成 `_`。

读原始 body。空 body 当成 `{}`。JSON 对象里没有 `trace_id` 或 `idempotency_key` 时，用 query 里的同名参数补上。`JSONDecodeError` 先记成 payload 为空，请求继续往下走。配了 `consumer_webhook_secret` 才验签，用原始 body，不看时间窗。没配密钥就跳过验签。签名失败 HTTP 401，body 是 `{ status: "invalid_signature" }`，这时即使 JSON 是坏的也先回 401。

vendor 没有 `parse_callback`：HTTP 404，`{ status: "unknown_provider", vendor }`。这步在 `invalid_json` 之前。payload 为空才是 HTTP 400，`{ status: "invalid_json" }`。parser 抛错：HTTP 400，`{ status: "invalid_payload", vendor, error }`，`error` 是异常的字符串。不要求一定有 `x-oc-idempotency-key`。`UnicodeDecodeError` 不收成 `invalid_json`。

`OpenCreatorAICallbackParser.parse()` 与 OpenCreator `callback_parser.py` 相同：

```text
external_task_id     ai_task_id
status               原样
trace_id             payload 的 trace_id，没有就用补过 query 的那份
result               model_id、provider、provider_model_id、provider_request_id、
                     provider_telemetry、client_context、result、usage、started_at、completed_at
error                有 code 且没有 error_code 时，把 code 抄进 error_code。空的 error_params 删掉
dedupe_key           payload.event_id，没有就用排序后 JSON 的 sha256
```

`OpenCreatorAICallbackPayload` 允许额外字段。`usage` 缺省三个 token 都是 0。`error` 允许 `error_code`、`display_group`、`action`、`error_params`、`provider_message`。`result.output` 可以是字符串或字符串数组，`output_urls()` 把字符串收成单元素数组。

`handle_callback_fast(callback)` 只收这一份解析结果：

```text
按 vendor + external_task_id 找 invocation
  → 没有就按 trace_id 补 external_task_id，条件与 OpenCreator _attach_callback_by_trace_id() 相同
  → 仍没有：pending_model_callback 按 vendor + external_task_id upsert，
            payload 用 raw_payload，status=pending，receive_count 加 1，返回 None
  → 已经是终态：_schedule_finalize 仅当 finalize_status == "failed"
  → dedupe_key 已在 callback_dedupe_keys 里：直接返回，不调度 finalize
  → 否则写入 callback_status、callback_result、callback_error、callback_raw_payload、
    finalize_status=pending，并 $addToSet callback_dedupe_keys
  → 清掉 finalize_error、finalize_started_at、finalize_finished_at、
    submit_status、submit_error、submit_timeout_at
  → _schedule_finalize = true
```

`callback_status` 的收法：`success`、`completed`、`succeeded` 收成 `success`。`timeout`、`timed_out` 收成 `timeout`。其余收成 `failed`。

入口在落库之后调用 `InvocationFinalizer.schedule_finalize(invocation_id)`，不在这个 HTTP 请求里把 finalize 跑完。

补跑挂起回调的维护任务对照 `FlowRecoveryService.replay_pending_callbacks()`。每次最多 100 条 `status=pending`。先 `parse_callback(payload)`，再 `handle_callback_fast()`。对上 invocation 就写成 `replayed` 并带上 `invocation_id`；需要 finalize 时用 `run_finalize_async()`，把这次补跑等完。对不上就保持 `pending`。解析或处理抛错就写成 `failed`，`error` 是异常字符串。

响应是：

```text
{
  status: "accepted",
  vendor,
  external_task_id,
  finalize_scheduled,
  matched
}
```

`matched` 表示找到了 invocation。没找到也是这份 200，不是 AI 侧的投递失败。

积分、DAG 和画布事件仍留在工作流那一节。这里只把回调挂上 invocation，并调度 finalize。

## 现在

入口先卡时间窗，并在没有 `x-oc-idempotency-key` 时 HTTP 400。payload 用 strict 模型，`error` 只认 `code` 和 `message`，多出来的 `error_code`、`display_group`、`action`、`provider_message`、`provider_telemetry` 会被拒绝。没有 `parse_callback`。去重键用的是这次请求新生成的幂等头，同一份结果重试会对不上。落库字段是 `callback_payload`、`ai_task_id`、`usage`、`provider_gateway_status`。找到之后在请求里直接 `run_finalize()`。响应里的 id 字段是 `ai_task_id`。

## 改哪些文件

1. `novelcomic-consumer/app/main.py` 的 `POST /callbacks/models/{vendor}`。对照 OpenCreator `main.py` 的 `model_callback()` 和 `_verify_opencreator_ai_callback_signature()`。
2. 新增 `novelcomic-consumer/app/services/opencreator_ai/callback_parser.py`。对照 OpenCreator `services/opencreator_ai/callback_parser.py` 和 `schemas.py` 里的 `OpenCreatorAICallbackPayload`。
3. `novelcomic-consumer/app/model_gateway/providers/opencreator_ai.py` 的 `parse_callback()`。对照 OpenCreator 同名方法。
4. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的 `handle_callback_fast()`、`_attach_callback_by_trace_id()`、`_normalize_callback_status()`。对照 OpenCreator 同名方法。`mark_running()` 和 claim 保持上一节。
5. vendor 归一化对照 OpenCreator `services/invocation/model_callback_vendor.py`。
6. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `replay_pending_callbacks()`。对照 OpenCreator 同名方法。积分、DAG 和画布事件仍不在这里改。

# 10. 飞书模型通知失败不能打断主链路

做完要达到：`notifyOnce()` 用 `claimModelCallNotification()`。没抢到就返回。抢到后发送，成功写 `model_call_notify_status=sent` 并记下 `model_call_notified_at`。发送失败写 `failed` 和 `model_call_notify_error`，然后返回，不把异常抛回 artifact worker 或 `deliver()`。

正文开头是 `=== 结果型原子执行完成 ===`。在厂商任务 ID 之后先写一行 `节点总耗时`，值与 `网关总耗时` 相同。`total_gateway_ms` 没有时，用 `completed_at - created_at`，不用 `updated_at`。其余行和 fallback 链路的格式对照 `buildModelCallNotificationText()`。

`notifyProviderFailure()` 另走 `claimModelCallFailureNotification()`。键是：

```text
${provider}|${provider_model_id ?? "unknown-model"}|${provider_request_id ?? "no-request"}|${phase}|${error_code ?? "no-error-code"}
```

`error_code` 先看 `error.error_code`，再看入参上的 `error_code`。用 `$addToSet` 写进 `model_call_failure_notified_keys`。已经有这把键就不再发。这条通知 `atAll`。发送失败只记日志，不删掉已经写入的键，也不抛出。正文开头是 `=== 模型厂商调用失败 ===`，字段对照 `buildModelCallFailureNotificationText()`。错误信息压成一行，超过 800 字截成 797 字再加 `...`。

未启用，或没有 webhook 地址时，两条都不发。

## 现在

只有 `notifyOnce()`。发送失败会把异常抛出去，artifact job 会因此失败，回调也可能还没入队。正文开头是 `=== NovelComic AI 原子执行完成 ===`，没有单独的节点总耗时，总耗时回退用的是 `updated_at`。没有按失败键去重的厂商失败通知。

## 改哪些文件

1. `novelcomic-ai/packages/runtime/src/model-call-notifier.ts`。对照 OpenCreator 同名文件。
2. `novelcomic-ai/packages/db/src/task-repository.ts` 补 `claimModelCallFailureNotification()`。对照 OpenCreator 同名方法。
3. `novelcomic-ai/packages/contracts/src/db.schema.ts` 的 `model_call_failure_notified_keys`。对照 OpenCreator `AiTaskDocumentSchema` 里这一个字段。
