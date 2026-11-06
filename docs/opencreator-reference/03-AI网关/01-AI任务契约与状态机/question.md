# AI 任务契约与状态机 question

## 核心概念

- 这一组讲的是什么？
  - 只讲 `opencreator-ai` 如何把 Consumer 的一次模型调用收成稳定任务：请求契约、模型 ID 归一、参数校验、幂等建单、队列提交、任务状态和跨仓边界。
  - 它不讲 Provider 怎么提交、怎么轮询、怎么接厂商 Webhook。
  - 它也不讲产物处理和回调重试的具体实现。

- 为什么要先背一句话？
  - Consumer 负责发起一次业务模型调用。
  - `opencreator-ai` 负责把它变成 `ai_task`。
  - Provider worker 后面才负责真正打厂商。
  - `ai_task` 不是画布节点状态，也不是 workflow run 状态。

- 四个对象怎么分？
  - `workflow run`：一次画布执行。
  - `node invocation`：某个节点的一次执行记录。
  - `ai_task`：AI 网关的一次模型调用。
  - `provider attempt`：向某个厂商模型的一次提交尝试。

- 建单最短链路是什么？
  - Consumer 组装 `model_id` / `options` / `webhook_url`。
  - `POST /v1/tasks`。
  - `CreateAiTaskRequestSchema` 严格验形。
  - `resolveCoreModelId` 收别名。
  - `validateCoreModelOptions` 按模型校验 options。
  - `TaskRepository.createOrGet()` 幂等写 `ai_task(status=queued)`。
  - 新任务入 provider-execution submit job。
  - HTTP 返回 `ai_task_id` 和 `queued`。

## 请求契约

- `/v1/tasks` 负责到哪一步？
  - 只负责收单、校验、落库、入队、返回 `ai_task_id`。
  - 不直接调用厂商，也不等待模型结果。

- 请求里哪些字段必填？
  - `model_id`、`options`、`webhook_url`。
  - `options` 必须是 object。
  - `webhook_url` 必须是可回调 URL。

- 哪些字段可选，但 Consumer 执行节点时应该带上？
  - `trace_id`：跨系统追踪。
  - `idempotency_key`：同一业务意图复用同一张任务单。
  - `locale`。
  - `client_context`：回调时由 Consumer 解释，用来定位 workflow、节点和 invocation。

- schema 对未知字段怎么处理？
  - 默认严格，不接受未知字段。
  - 新增上下文字段必须同时升级 Consumer 和 AI 两侧契约。

- 新建和幂等命中的 HTTP 有什么区别？
  - 新建：`202 Accepted`，`ai_task_id`，`status=queued`。
  - 命中：`200 OK`，`ai_task_id`，`existing=true`。
  - `202` 只表示收下并排队。

- Consumer schema 能不能代替 AI 契约？
  - 不能。
  - Consumer schema 方便业务组包和类型检查。
  - AI contract 负责最终校验，非法请求在进 service 前就被拒绝。

## 模型校验与幂等

- 两层校验分别保证什么？
  - 第一层保证这是一张 AI 任务单。
  - 第二层保证这张单的参数能给对应模型执行。
  - 模型或参数非法时不落库、不入队。

- `resolveCoreModelId()` 找不到别名时做什么？
  - 当前实现原样返回。
  - 后面的 registry 校验再决定是否失败。
  - 找不到已注册模型时，不应该建可执行任务。

- 为什么 `options` 不能只验成 object？
  - 同一个 `/v1/tasks` 接收不同模型。
  - 每个模型的 required、类型、enum、范围、长度都不一样。
  - 要在识别出 `core_model_id` 之后再验一次。

- 前端模型目录能证明模型可执行吗？
  - 不能。
  - Consumer 可以做前置映射。
  - 最终 registry 校验在 AI 网关。

- `createOrGet()` 怎么区分新建和复用？
  - 有 `idempotency_key`：按 key 建唯一索引，并发重复请求只能成功创建一条，其余返回已有任务。
  - 没有 `idempotency_key`：每次创建新任务。
  - 返回值要能区分 `created` 和 `existing`。
  - 只有 `created` 才 enqueue submit job。

- 幂等为什么不能先查再插？
  - 并发下两个请求都会以为自己是第一次。
  - 必须靠数据库唯一约束兜住。
  - 索引是 `idempotency_key` unique sparse，没传 key 的文档不占这个唯一槽。

- 幂等键应该绑到什么范围？
  - 绑到一次具体业务意图，例如一次 workflow node invocation。
  - 不要只用模型名或用户 ID。

- 队列 job 里放什么？
  - 只放 `ai_task_id`。
  - 不复制 `options`、`webhook_url`、`client_context`。
  - Worker 按 ID 回库读取最新任务事实。

## 状态机

- 契约里有哪些状态？
  - `received`、`queued`、`submitted_to_provider`、`waiting_provider`、`processing_artifacts`。
  - `callback_pending`、`callback_failed`、`callback_succeeded`。
  - `succeeded`、`failed`、`timed_out`、`cancelled`、`ignored`。

- `TASK_STATUS_ORDER` 是运行时强制状态机吗？
  - 不是。
  - 它和 `assertTaskStatusCanAdvance()` 是校验辅助。
  - 当前主链的写路径没有全面调用这个检查。
  - 排障不能只按顺序表推断历史。

- 主链常见状态怎么走？
  - `queued → waiting_provider → processing_artifacts → callback_pending → succeeded | failed`。
  - 建单完成时最稳定的状态是 `queued`。

- 哪些状态留在枚举里，但当前主链不写？
  - `received`。
  - `submitted_to_provider`。
  - `callback_succeeded`。

- 正式终态有哪些？
  - `succeeded`、`failed`、`timed_out`、`cancelled`。
  - `callback_failed` 和 `ignored` 要单独看，不能直接当成这四个终态。

- 为什么状态可以不单调？
  - Robin 还有下一家时，attempt 失败后任务会重新进入等待 Provider。
  - OpenCreator 参考路径是 `waiting_provider → failed → waiting_provider`。
  - 没有 fallback 时走 `failed → callback_pending → failed`。
  - 所以内部的 `failed` 可能只是一次 attempt，也可能是最终失败。

- 判断失败时还要看什么？
  - `ai_task.status`。
  - attempts。
  - provider / `provider_request_id`。
  - skip providers。
  - callback delivery 记录。
  - Consumer 是否已经对上 invocation。

- `failed` 和 `callback_failed` 怎么分？
  - `failed`：模型或 Provider 链路最终失败。
  - `callback_pending`：结果已准备好，等待通知 Consumer。
  - `callback_failed`：通知 Consumer 的投递重试耗尽。
  - `succeeded`：成功结果已经投递给 Consumer。
  - `callback_failed` 不等于模型又执行失败了一次。

- 什么时候才能把状态检查做成强制门禁？
  - 必须同时覆盖 fallback 离开 `failed`、callback pending 和 callback failed。
  - 否则会和现有写路径冲突。

## 跨仓边界

- 谁创建 `ai_task`？
  - Consumer。
  - Frontend 和 Publisher 只建立 flow run，不直接创建 `ai_task`。

- AI 网关会不会直接改画布？
  - 不会。
  - 它不更新画布节点，也不推前端 WebSocket。
  - 它把统一结果回调给 Consumer。
  - Consumer 挂回 invocation 后，再由 workflow 事件链路推到 Publisher 和前端。

- `client_context` 谁来解释？
  - Consumer。
  - AI 网关只保存和回传，不把它当成画布状态机的输入。

- Consumer 建单成功后必须留下什么？
  - `ai_task_id`。
  - `trace_id`。
  - `idempotency_key`。
  - `client_context`。
  - 给定 `ai_task_id`，要能查回 workflow、节点和 invocation。

- Provider 原始状态能直接显示到前端吗？
  - 不能。
  - 要先归一化成 AI 任务状态，再由 Consumer 转成节点事件。

## NovelComic 迁移

- 为什么不要从 Provider 开始写？
  - 先要有一张可靠的 AI 任务单。
  - 没有稳定的 `ai_task_id` 和任务文档，后面的提交、Webhook 和补偿没有权威对象。

- 四段编写顺序是什么？
  - 契约：`task-state`、create-task schema、db schema。
  - 模型校验：model runtime、model constraints。
  - 建单服务：repository、task service、route，外加状态检查辅助。
  - Consumer 接入：schemas、task client、invocation 回挂 `ai_task_id`。

- 写之前必须已经有什么？
  - AI HTTP API、数据库、可入队的 `provider-execution` 抽象。
  - 能判断模型是否存在的最小 registry。
  - Consumer 的 node invocation。
  - AI base URL、调用凭据，以及回调 Consumer 的公开 URL。

- 本章最小验收是什么？
  - 非法 body 被 schema 拦住，不落库。
  - 未注册模型或非法 options 被拦住，不落库。
  - 合法请求返回 `202` 和 `ai_task_id`。
  - 库里有一条 `status=queued` 的 `ai_task`。
  - 队列里有一个只含 `ai_task_id` 的 submit job。
  - 同一个幂等键重复请求返回已有 ID，不重复入队。
  - Consumer 把 `ai_task_id` 写回 node invocation。
  - `trace_id` 能从 invocation 查到 AI task，再查回请求上下文。
  - 状态枚举没有和 workflow run / node status 混用。
  - Worker 能按 ID 读回任务。Provider 提交成功不在本章验收里。

## 面试短答

- 一句话讲 AI 任务契约与状态机？
  - Consumer 发起一次模型调用，AI 网关把它验形成幂等的 `ai_task` 并排队；`202` 只表示已入队，任务状态不是画布状态，状态顺序表也不是强制单向状态机。

- 一句话讲两层校验？
  - schema 保证任务单形状，registry 保证这个模型的 options 真能执行。

- 一句话讲幂等？
  - `idempotency_key` 的 sparse unique 让同一业务意图只建一单，命中后返回已有任务并且不重复入队。

- 一句话讲为什么 job 只有 ID？
  - 任务文档才是事实源，worker 重试和排障都按 `ai_task_id` 回库读。

- 一句话讲 `callback_failed`？
  - 它表示结果通知 Consumer 失败，不表示模型又失败了一次。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - `POST /v1/tasks`、严格 schema、模型别名收敛、按模型验 options、`createOrGet`、新建才入队，都已经接上。
  - Consumer 能组请求，并把 `ai_task_id` 写入 `model_invocations`。
  - `assertTaskStatusCanAdvance()` 已实现，写路径没有调用它。
  - Provider 提交、轮询、Webhook 和产物处理已经有后续代码，但不属于本章验收。

- 当前 HTTP 和幂等是否按契约返回？
  - 新建是 `202`，body 为 `ai_task_id` + `status=queued`。
  - 幂等命中是 `200`，body 带 `existing: true`，status 为 `existing`。
  - 重复键不第二次 `add('submit')`。
  - 没传 `idempotency_key` 会直接插入新任务。

- 当前幂等键绑的是什么？
  - Consumer 用这次 invocation plan 的 `result_id`。
  - `client_context` 里有 `flow_id`、`run_id`、`node_id`、`result_id`，供回调对账。
  - AI 网关不解析这些字段的画布含义。

- 状态辅助函数现在有没有卡住 fallback？
  - 没有。
  - repository 的 `updateStatus`、`markProviderFailedAttempt` 都不调用 `assertTaskStatusCanAdvance()`。
  - 如果现在把它接上所有写路径，离开终态和回退都会和现有 fallback 冲突。

- NovelComic 的 fallback 状态和参考笔记一样吗？
  - 不一样，排障时要分开说。
  - 参考笔记里的 OpenCreator 路径是 `waiting_provider → failed → waiting_provider`。
  - 当前 NovelComic 在还有下一家时，把任务写成 `queued` 并重新投入 submit job；没有下一家才写成 `failed`。

- `callback_failed` 在当前代码里谁写？
  - 回调投递耗尽时 `ConsumerCallbackService.markFailed()` 写成 `callback_failed`。
  - 投递成功后，任务上已有 `error` 就写成 `failed`，否则写成 `succeeded`。
  - 这仍然是投递结果，不是再跑一次模型。

- 当前测试要覆盖哪些本章风险？
  - 非法 body、未知字段、未注册模型、非法 options，都不落库。
  - 合法请求 `202`、`queued`、队列 payload 只有 `ai_task_id`。
  - 并发同一个幂等键只有一条任务、一个 submit job。
  - Consumer 能把 `ai_task_id` 挂回 invocation，并用 `trace_id` / `client_context` 对上。
  - 状态字符串不和 workflow run、node status 混用。

- 什么时候才算本章完整验收？
  - 收单、两层校验、幂等落库、只入队一次、invocation 回挂都成立。
  - 状态枚举和画布状态分开。
  - 状态前进检查仍是辅助函数，文档和代码都承认它未接入写路径。
  - Provider 是否提交成功，留到提交、轮询、Webhook 和产物专题再验。
