# AI 任务契约与状态机：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-ai`、`opencreator-consumer`。NovelComic 看 `novelcomic-ai`、`novelcomic-consumer`。

不在这一份：模型目录里有哪些模型、Robin 怎么排下一家、厂商提交体、轮询、Webhook 验签、产物上传、回调签名和重试。这些在「AI 模型注册、Provider 与 Robin」和「AI 提交、轮询、Webhook、产物与回调」。这里只补建单契约、幂等落库、HTTP 收单、`ai_task.status` 怎么被写，以及 Consumer 怎么组请求并把返回的任务号挂回 invocation。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。差的是日志、类放在哪个文件、引号风格。

- 状态枚举是 `received`、`queued`、`submitted_to_provider`、`waiting_provider`、`processing_artifacts`、`callback_pending`、`callback_succeeded`、`callback_failed`、`succeeded`、`failed`、`timed_out`、`cancelled`、`ignored`。终态是 `succeeded`、`failed`、`timed_out`、`cancelled`。`TASK_STATUS_ORDER` 的数字相同：`callback_failed` 是 6，`callback_succeeded` 是 7，四个终态和 `ignored` 都是 8
- `POST /v1/tasks` 用 strict schema。必填 `model_id`、object 型 `options`、URL 型 `webhook_url`。`locale` 只收 `zh` 和 `en`。`trace_id`、`idempotency_key`、`locale`、`client_context` 可选
- 请求体形状不合法时 HTTP 400，body 是 `{ code: 400, msg: "Invalid request body", data: { details } }`，`details` 是 Zod `flatten()`。不落库、不入队
- `createOrGet()`：没有 `idempotency_key` 就 `insertOne`。有 key 时也先插入，Mongo `11000` 再按 key `findOne`。只有 `created` 才入队。命中已有任务不再 `add`
- 新建任务的 job 名字是 `submit`，data 只有 `{ ai_task_id }`，`jobId` 是 `provider-${ai_task_id}`，队列名是 `provider-execution`
- `packages/db/src/mongo.ts` 的 `ensureMongoIndexes()` 已经按 `ai_task` 建了 `ai_task_id` 唯一索引、`idempotency_key` 的 partial unique（`$exists: true`）、`{ provider, provider_request_id }`、`{ status, updated_at }`。这四条保持不动
- 提交成功后 `markProviderSubmitted()` 把 `status` 写成 `waiting_provider`。回调投递耗尽时写成 `callback_failed`。成功投递后按任务上是否已有 `error` 写成 `failed` 或 `succeeded`

# 1. 收单 HTTP 要套同一层信封

做完要达到：新建和幂等命中都走 `{ code, msg, data }`。

新建：

```text
HTTP 202
{ code: 202, msg: "queued", data: { ai_task_id, status: "queued" } }
```

同一个 `idempotency_key` 再来：

```text
HTTP 200
{ code: 200, msg: "existing", data: { ai_task_id, status: "existing" } }
```

`data` 里只有 `ai_task_id` 和 `status`。顶层不要再放一份任务字段，也不要加 `existing: true`。

模型未注册：HTTP 404，`msg` 是 `Model is not registered: ${model}`，`data` 是 `null`。这是 `kind: "not_found"`，`error_code` 是 `3008`。`model` 用请求里的原始 `model_id`。

`options` 过不了该模型当前 call 的 schema：HTTP 400，`msg` 是 `Invalid input for model ${coreModelId}`，`data` 是 `null`。`coreModelId` 是 `resolveCoreModelId()` 之后的 id。

`options.provider` 钉住的厂商不在该模型的 `robin_calls` 里：HTTP 400，`msg` 是 `Provider "${requested}" is not available for model ${id}. Allowed: ${list}`，`data` 是 `null`。`requested` 先 trim 再转小写。`list` 是去重后的 provider 名，逗号加空格拼接。

`11000` 之后按 key 找不到文档：HTTP 409，`msg` 是 `Duplicate task detected but existing task was not found`，`data` 是 `null`。

路由只负责 body schema。模型、参数、冲突从 service 抛出，由和 OpenCreator `apps/api/src/response.ts` 一样的 error handler 按 `kind` 收成上面的状态码。`validation_error` → 400，`not_found` → 404，`conflict` → 409。5xx 的 `msg` 收成 `Internal Server Error`。

另外补上查询：

```text
GET /v1/tasks/:ai_task_id
```

找到时 HTTP 200，`msg` 是 `ok`，`data` 是 `{ task, attempts, provider_events, callback_deliveries }`。`attempts` 按 `attempt` 升序，`provider_events` 按 `received_at` 升序，`callback_deliveries` 按 `attempt` 升序。没有记录时这三个数组是空的。任务不存在时 HTTP 404，`msg` 是 `Task not found`，`data` 是 `null`。

## 现在

新建返回的是顶层 `{ ai_task_id, status: "queued" }`，没有 `code` / `msg` / `data`。幂等命中是顶层 `{ ai_task_id, status: "existing", existing: true }`。

未注册模型和非法 options 都在路由里收成 HTTP 400，`data` 是 `{ code, details }`。钉住了不存在的 provider 时，`CoreProviderNotAvailableError` 没有按 400 返回。没有 `GET /v1/tasks/:ai_task_id`。

## 改哪些文件

1. `novelcomic-ai/apps/api/src/routes/tasks.ts`。对照 OpenCreator `apps/api/src/routes/tasks.ts` 和 `apps/api/src/response.ts`。
2. `novelcomic-ai/apps/api/src/index.ts` 接上同一套 error handler。
3. `novelcomic-ai/packages/db` 里补 `listByTask()`，排序和 OpenCreator 的 `attempt-repository.ts`、`provider-event-repository.ts`、`callback-delivery-repository.ts` 一致。写入这些集合的逻辑仍留在后面两节。

# 2. 请求契约按网关现码收紧

做完要达到：`CreateAiTaskRequestSchema` 不 `trim`。`" model "` 能过第一层；全空白的 `model_id` 也能过 `min(1)`，然后在第 3 节变成 404。

`client_context` 是 strict object，只允许这些可选字符串：

```text
run_id
flow_task_id
node_id
result_id
user_id
node_type
model_display_name
config_name
```

多出来的键，包括 `flow_id`、`flow_run_id`、`execution_plan_token`，在进 service 之前就是 400。空字符串过不了 `min(1)`。

`options` 仍是 JSON object。某个模型允许哪些字段，由第 3 节的 schema 决定，不在这一层放宽成“任何键都合法就能执行”。

## 现在

`model_id`、`trace_id`、`idempotency_key` 会 `trim`。`client_context` 是任意 `record`，未知键会进库。

## 改哪些文件

1. `novelcomic-ai/packages/contracts/src/create-task.schema.ts`。对照 OpenCreator `packages/contracts/src/create-task.schema.ts` 和 `packages/contracts/src/common.ts` 里的 `ClientContextSchema`。

# 3. 建单前用 registry 的 zod schema 验 options

做完要达到：`TaskService.createTask()` 的顺序是：

```text
resolveCoreModelId(request.model_id)
  → validateCoreModelOptions(coreModelId, options)
  → createOrGet()
  → 只有 created 才 enqueue
```

`resolveCoreModelId()` 对上 id 或 `aliases` 就返回 registry id。对不上就原样返回，再交给 `requireCoreModel()`。

`validateCoreModelOptions()`：

- `requireCoreModel()` 失败就是第 1 节的 404
- `options.provider` 是非空字符串时，trim、转小写，并且必须出现在该模型的 `robin_calls` 里。否则是第 1 节的 400
- 用被钉住的那条 call 的 `options_schema.parse()`。没有钉住时，用 `robin_calls` 第一条的 schema
- parse 之前先拿掉 `provider`。钉住成功后，把小写后的 `provider` 放回返回值
- 落库的 `options` 是 parse 之后的对象。Zod 默认会丢掉 schema 里没有的键
- `ZodError` 收成第 1 节的 `Invalid input for model ...`，`data` 为 null

建单这条路径不要再走 `optionConstraintsFromJsonSchema()`，也不要在没有约束时把原始 `options` 原样放过。模型各自的 zod schema 仍在下一节补；这一节先把调用和失败时的 HTTP 收成现码。

## 现在

`validateCoreModelOptions()` 读的是 JSON Schema 形状的 `type/properties/required`。转不出来就直接返回原 options。未注册模型被收成 `TaskServiceValidationError`，HTTP 400。`model_id` 落库时仍是请求里的原始字符串，另写 `core_model_id`。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/model-runtime.ts` 的 `resolveCoreModelId()`、`requireCoreModel()`、`validateCoreModelOptions()`。对照 OpenCreator 同名函数，含 `assertPinnedProviderAllowed()`。
2. `novelcomic-ai/packages/runtime/src/task-service.ts`。对照 OpenCreator `task-service.ts` 的 `createTask()` 和 `validateOptions()`。

# 4. `ai_task` 写在 `ai_task` 集合里

做完要达到：建单写入的集合名是 `ai_task`，和 `COLLECTIONS.aiTask`、`ensureMongoIndexes()` 是同一张表。路由和 worker 都从这张表读写。`TaskRepository` 不要再默认写 `ai_tasks`，也不要在那张表上另建一套 sparse unique。

新建文档至少是：

```text
ai_task_id
idempotency_key          有才写
trace_id                 有才写
client_context           有才写
model_id                 resolve 之后的 registry id
status                   queued
attempt                  0
options                  第 3 节 parse 之后的对象
input_summary            { option_count, has_prompt }
webhook_url
locale                   有才写
created_at
updated_at
```

没有 `core_model_id`。`input_summary.option_count` 是 `options` 的键数量。`has_prompt` 为真，仅当 `options.prompt` 是非空字符串。

`ai_task_id` 的形状是 `task_${Date.now()}_${nanoid(8)}`。

后面 worker 读到的模型 id 就是这份 `model_id`。`requireCoreModel(task.model_id)` 和 `submitCoreTask({ model_id: task.model_id })` 用它。跳过列表的字段名是 `robin_skip_providers`，追加用 `$addToSet`。

`markProviderSubmitted()` 写入的是 `provider`、`provider_model_id`、`provider_request_id`、`provider_status`、`status: "waiting_provider"`、`started_at`、`updated_at`。

## 现在

`TaskRepository` 默认集合是 `ai_tasks`，`ensureIndexes()` 在这张表上建 sparse unique。`ensureMongoIndexes()` 却给 `ai_task` 建了 partial unique，建单没有写进去。

文档把原始 `model_id` 和 `core_model_id` 分开存，没有 `attempt: 0`，没有 `input_summary`。跳过列表叫 `skip_providers`。worker 提交时读的是 `task.core_model_id`。

## 改哪些文件

1. `novelcomic-ai/packages/contracts/src/db.schema.ts` 的 `AiTaskDocumentSchema`。对照 OpenCreator `packages/contracts/src/db.schema.ts`。建单会写到的字段先对齐；attempt、provider event、callback delivery 的后续写入仍在后面两节。
2. `novelcomic-ai/packages/db/src/task-repository.ts`。集合名改成 `ai_task`。去掉会在 `ai_tasks` 上建索引的 `ensureIndexes()`。`createOrGet()` 的 11000 分支对照 OpenCreator。
3. `novelcomic-ai/packages/runtime/src/task-service.ts` 的建单字段和 id。`input_summary` 对照 OpenCreator `packages/runtime/src/input-summary.ts`。
4. `novelcomic-ai/apps/api/src/routes/tasks.ts` 和 `apps/worker/src/index.ts` 使用同一张 `ai_task`。
5. `novelcomic-ai/packages/runtime/src/provider-worker.ts` 读 `task.model_id`。厂商请求体不要在这一节改。

# 5. 状态辅助不要挡写路径；fallback 的状态按现码写

做完要达到：`assertTaskStatusCanAdvance()` 仍然只是辅助。相同状态直接返回。来源是终态，或目标序号更小，就抛错。repository、worker、回调成功之后的 `updateStatus()` 都不调用它。

成功回调之后直接把状态写成 `failed` 或 `succeeded`，看任务上有没有 `error`。投递耗尽写成 `callback_failed`。这两次写入都不经过顺序检查。因此已经是 `succeeded` 的任务，如果文档上有 `error`，仍会被写成 `failed`。

厂商结果写回任务时，`status` 用结果自己的状态：`succeeded`、`failed`、`timed_out`、`cancelled`，或仍是 `waiting_provider`。`waiting_provider` 不写 `completed_at`。其余状态写上 `completed_at`。不要在这一步把 `succeeded` 收成 `processing_artifacts`。产物 worker 之后才把非 `failed` 的任务改成 `processing_artifacts`，`failed` 则直接改成 `callback_pending`。产物怎么上传留在后面一节，这里只对齐写回时的状态名。

fallback 只改状态和跳过列表，厂商协议留在后面两节。

轮询得到失败、并且还有下一家：

- 不把 `status` 写成 `failed`，也不写成 `queued`
- `$addToSet` `robin_skip_providers`，元素是 `${provider}:${model_id}`
- 再入队 `submit`，data 是 `{ ai_task_id, skip_providers }`，`jobId` 是 `provider-${ai_task_id}-fallback-${nextProvider}`
- 这次任务保持 `waiting_provider`。下一轮 `markProviderSubmitted()` 再写一次 `waiting_provider`

执行抛错、并且还有下一家：

- 先把 `status` 写成 `failed`，并带上这次的 provider 和 error
- 再 `$addToSet` `robin_skip_providers`，入队方式同上
- 下一轮 `markProviderSubmitted()` 把 `status` 写成 `waiting_provider`

所以异常这条会经过 `failed`，然后再离开 `failed`。没有下一家时保持 `failed`。`failed` 既可能是这一次 attempt，也可能是最终失败，要连 `robin_skip_providers` 和 callback 一起看。

## 现在

`consumer-callback.ts` 在写成 `succeeded` 或 `failed` 之前调用 `assertTaskStatusCanAdvance()`。终态再往别处走会抛 `TaskStatusTransitionError`。

`applyProviderResult()` 把成功收成 `processing_artifacts`，失败收成 `failed`，其余收成 `waiting_provider`。没有 `timed_out` 和 `cancelled` 这两档。

`markProviderFailedAttempt({ has_fallback: true })` 把状态写成 `queued`，跳过列表写在 `skip_providers`。轮询失败和提交抛错都走这条。fallback 的 `jobId` 多带了 provider model id：`provider-${ai_task_id}-fallback-${provider}-${model_id}`。

## 改哪些文件

1. `novelcomic-ai/packages/runtime/src/consumer-callback.ts`。成功投递后的 `updateStatus()` 对照 OpenCreator `consumer-callback.ts`。回调请求、签名、重试留在后面一节，只拿掉这次状态写入前的顺序检查。
2. `novelcomic-ai/packages/db/src/task-repository.ts` 的失败更新。对照 OpenCreator `addRobinSkipProvider()` 和 `applyProviderResult()` 写出的 `status`。
3. `novelcomic-ai/packages/runtime/src/provider-worker.ts` 里决定“还有下一家时状态写什么”的两处。对照 OpenCreator `provider-worker.ts` 的轮询 fallback 和 `catch` fallback。提交、轮询、Webhook 的其余步骤不要在这一节展开。

# 6. Consumer 发出去的建单请求要能被网关收下

做完要达到：发给 `POST /v1/tasks` 的 JSON 是：

```text
model_id           mapper 之后的 id
options            arguments 先铺开，再用 model_options 覆盖，丢掉 null
webhook_url        {callback_base}/callbacks/models/opencreator_ai
locale             zh 或 en
idempotency_key    缺省 {run_id}:{result_id}
trace_id           缺省 {run_id}:{node_id}:{result_id}
client_context     只含第 2 节那 8 个键
```

`locale` 用 `normalize_user_locale()`。`zh`、`zh-CN` 收成 `zh`，`en`、`en-US` 收成 `en`，空值和认不出的值收成 `en`。请求里总是带 `locale`。

`client_context` 的值来自这次调用的 `run_id`、`flow_task_id`、`node_id`、`result_id`、`user_id`、`node_type`、展示名、`config_name`。空字符串和空值不放进对象。展示名优先 metadata 里的 `model_display_name` 或 `display_name`，再退回调用方原来的 `model_id`。

`options` 不做 camelCase 改名，也不从 `node` / `inputs` 里抽 `prompt`。`model_options[model_id]` 是对象时只用这一份，否则用整个 `model_options`。

`webhook_url` 在原 query 没有 `trace_id`、`idempotency_key` 时补上这两个参数。

缺 `OC_AUTH_KEY` / `OPENCREATOR_AI_AUTH_KEY` 时，请求不要发出去，直接 `ValueError`，文案与 OpenCreator provider 相同。header 名是 `auth_key`。

客户端对照 OpenCreator `task_client.py`：

- 复用一个 `httpx.AsyncClient`
- 超时缺省 30 秒，提交超时看 `WEBHOOK_SUBMIT_TIMEOUT_SECONDS`
- 只对 `ConnectError` 和 `ConnectTimeout` 重试，间隔 `0.2s`、`0.5s`、`1.0s`，最多 4 次尝试
- 读超时、4xx、5xx 不重试
- 响应只认 `payload.data.ai_task_id`。没有这层 `data` 就失败
- 超时错误文案是 `opencreator-ai submit request timed out`，`__cause__` 是 `httpx.TimeoutException`
- 其他失败文案是 `opencreator-ai submit request failed`

模型别名表本身在下一节。这一节只要 Consumer 先过 mapper，网关再 `resolveCoreModelId()`。

## 现在

幂等键是 `plan.result_id`。`trace_id` 只在 flow 上有值时才传。`client_context` 带了 `flow_id`、`flow_run_id`、`execution_plan_token`，网关按第 2 节会 400。

`options_builder` 会把 `aspectRatio` 收成 `aspect_ratio`，并从 `node` / `inputs` 补 `prompt`。客户端用 urllib，把顶层 JSON 和 `data` 都当成成功，HTTP 200 会被当成 `existing`。连接失败没有那三次退避。

## 改哪些文件

1. `novelcomic-consumer/app/services/opencreator_ai/schemas.py`。请求对象对照 OpenCreator `services/opencreator_ai/schemas.py` 的 `OpenCreatorAITaskRequest`。响应从 `data.ai_task_id` 取。
2. `novelcomic-consumer/app/services/opencreator_ai/task_client.py`。对照 OpenCreator `task_client.py`。
3. `novelcomic-consumer/app/services/opencreator_ai/options_builder.py`。对照 OpenCreator `options_builder.py`。
4. `novelcomic-consumer/app/model_gateway/providers/opencreator_ai.py`。对照 OpenCreator `model_gateway/providers/opencreator_ai.py` 里组 `client_context`、`locale`、`idempotency_key`、`trace_id` 的那一段。
5. Consumer 里生成 `webhook_url` 的位置，对照 OpenCreator `tasks/flow_resume.py` 的 `_callback_url_with_context()`。

# 7. `ai_task_id` 挂在 invocation 的 `external_task_id` 上

做完要达到：一次节点调用先按 `run_id + node_id + result_id + attempt` upsert。`invocation_id` 是 32 位 nanoid。`status` 先是 `submitting`。metadata 里有 `trace_id` 和 `idempotency_key`，值与发给网关的相同。

真正 `submit` 之前先 `claim_webhook_submit()`。只有还没有 `external_task_id`，并且 `submit_claim_token` 为空或 `submit_claimed_at` 早于 300 秒，才能领到。领不到就不再发 `POST /v1/tasks`。

网关返回之后 `mark_running()`：

- 条件是 status 仍是 `submitting` 或 `running`，且 `external_task_id` 不存在，或已经等于这次返回的 id
- 写入 `external_task_id = ai_task_id`，`status = running`，`submit_response` 为当时的 raw response
- raw response 里能看到 `data`、`request`、`legacy_model_id`、`opencreator_model_id`
- 清掉 `submit_claim_token`、`submit_status`、`submit_error`、`submit_timeout_at`
- 回调已经把同一条记成终态时，这次更新跳过
- 其他写失败抛错

查找用 `vendor + external_task_id`。给定网关返回的 `ai_task_id`，能找到 `run_id`、`node_id`、`result_id`。再用任务文档上的 `trace_id` 和 `client_context` 对回同一次调用。invocation 上不要再靠单独的 `ai_task_id` 字段做这件查找。

提交超时，并且 `__cause__` 是 `httpx.TimeoutException`：`status` 写成 `running`，`submit_status` 写成 `uncertain`，`submit_error` 是 `{ message, phase: "submit_timeout", recoverable: true }`，写上 `submit_timeout_at`，清掉 claim token。这条不新拿一个 `ai_task_id`。

## 现在

`invocation_id` 直接用 `plan.result_id`。提交前没有 claim。成功后同时写 `ai_task_id` 和 `external_task_id`，`status` 写成网关返回的 `queued` 或 `existing`。超时只按错误文案里有没有 timeout 来判断。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的建单、claim、`mark_running()`、`mark_submit_uncertain()`、按 `external_task_id` 查找。对照 OpenCreator `services/invocation/model_invocation_service.py`。
2. 调用提交的那一层对照 OpenCreator `tasks/flow_resume.py`：先 `create_invocation()`，再 claim，再 `provider.submit()`，成功后 `mark_running()`。积分预扣和 DAG 推进留在工作流那一节，不要在这里重写。
