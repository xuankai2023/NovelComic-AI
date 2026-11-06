# AI 模型注册、Provider 与 Robin question

## 核心概念

- 这一组讲的是什么？
  - 只讲 `opencreator-ai` 如何把一个规范模型 ID 映射到可执行的 Provider 调用：模型 registry、Provider 类型、别名、参数 schema、结果模式和 Robin fallback。
  - 它不讲任务怎么创建。
  - 它也不讲 Provider 结果怎么轮询、Webhook 怎么收敛、产物怎么回调 Consumer。

- 为什么要先背一句话？
  - Publisher / Frontend 的模型目录决定用户看见什么。
  - Consumer 决定业务节点传什么 `model_id`。
  - `CORE_MODELS` 决定这个 ID 能不能执行、找哪家 Provider 执行。

- 四个东西怎么分？
  - 产品模型目录：展示、排序、定价、可见性。
  - Consumer 模型映射：业务模型名到 AI registry ID，节点参数到 `options`。
  - AI registry：`CORE_MODELS` 里的 `CoreModelEntity`。
  - Provider call：某个模型到某个厂商模型的一条执行配置，不是一次 attempt。

- 最短链路是什么？
  - Consumer 传 `model_id` / `options`。
  - `resolveCoreModelId` 收别名。
  - `requireCoreModel` 确认模型在 `CORE_MODELS`。
  - `validateCoreModelOptions` 按选中的 call 校验 options。
  - `submitCoreTask` 读取 `robin_calls`。
  - 按顺序选择 Provider call 并 `submit()`。
  - 返回 `provider_request_id` / `result_mode`。
  - 失败且未钉死 Provider 时尝试下一家。

## Registry 与 Provider call

- `CORE_MODELS` 为什么是权威源？
  - AI 网关能不能执行，只看这个数组。
  - 模型文件存在、前端目录存在、Consumer 映射存在，都不够。
  - 没 import、没放进数组，就不算已注册。
  - registry 编译进进程，新增项要发布 AI 服务。

- `CoreModelEntity` 至少有什么？
  - `id`、`aliases`、`displayName`、`robin_calls`。
  - `displayName` 只是 registry 内的名字，不是产品售价和排序。

- `CoreProvider` 是什么？
  - AI core 认可的厂商名，例如 `fal`、`openai`、`kling`。
  - 它是执行适配层，不是产品展示分类。
  - 一个产品模型可以有多条 Provider fallback。
  - 同一个 Provider 也可以挂多个厂商模型 ID。

- 一条 `CoreProviderCall` 必须提供什么？
  - `provider`、厂商 `model_id`、`options_schema`、`result_mode`。
  - `submit()`。
  - 可选 `getResult()`。
  - `normalizeResult()`。
  - 只返回 request id、没有归一化，后续链路无法判断成功、失败和媒体 URL。

- 参考文档里的 180 个模型和 23 个 Provider 要背吗？
  - 不要当成长期常量。
  - 那只是当时 `CORE_MODELS` 和 `CoreProvider` 的代码快照。

## 别名、校验和钉死 Provider

- `resolveCoreModelId()` 怎么收？
  - `entry.id` 命中，或 `aliases` 包含这个名字，就返回规范 ID。
  - 找不到时原样返回。
  - 真正失败在 `requireCoreModel()`。

- 未注册怎么报？
  - 文案是 `Model is not registered`。
  - OpenCreator 参考口径的错误码是 `3008`。
  - 前端目录和 Consumer 映射不能代替这次校验。

- `validateCoreModelOptions()` 用谁的 schema？
  - 定义在 `model-runtime.ts`。
  - 默认用 `robin_calls` 第一条的 `options_schema`。
  - `options.provider` 钉死时，先确认这家在 `robin_calls` 里，再用那一条的 schema。
  - 同一个模型的不同 call 可以有不同 schema。

- `model_constraints.json` 做什么？
  - 提供输入限制、尺寸、时长、格式、文本长度和 Provider retry。
  - 它不替代 Provider call 的 `options_schema`。
  - 里面的历史价格字段不是产品售价权威。

- `options.provider` 会进厂商请求吗？
  - 不会。
  - 它先被当成路由控制字段：trim、转小写、确认允许。
  - `submit()` 前 `stripProviderFromOptions()` 把它去掉。

- 钉死 Provider 之后失败会换下一家吗？
  - 不会。
  - `getRemainingRobinProviders()` 直接返回空数组。

## Robin 与结果模式

- Robin 是负载均衡吗？
  - 不是。
  - 它是 `robin_calls` 的有序 fallback。
  - 不是随机、加权、多 Provider 并发，也不是低延迟优先。

- 跳过粒度是什么？
  - `provider:model_id`。
  - 不只跳过 Provider 名。
  - 同一 Provider 的另一个厂商模型 ID 仍可以是下一条 fallback。

- fallback job 怎么接上下一次提交？
  - worker 记下失败 attempt。
  - 把失败 call 放进 `skip_providers`。
  - 还有剩余 call 时重新 enqueue submit job，并带上新的 skip 列表。
  - 下一次 `submitCoreTask()` 跳过这些 call。

- `result_mode` 有哪几种？
  - 参考实现只有 `webhook` 和 `polling`。
  - 同步最终结果放在 `submit()` 返回的 `immediateResult`。
  - 轮询预先拿到的首次结果用 `firstPollResult`。
  - 不要为同步再加一种 result mode。

- `normalizeResult()` 为什么每条 call 都要有？
  - 厂商原始结果要收成统一 `ProviderResult`。
  - 任务仓储、artifact worker 和 Consumer callback 都吃这份统一结果。

## Worker 与跨仓

- provider worker 对本篇做到哪一步？
  - 从队列拿 `ai_task_id` 和可选的 `skip_providers`。
  - 回库读任务，调用 `submitCoreTask()`。
  - 成功后写 provider、厂商模型 ID、request id、状态、`result_mode` 和 attempt。
  - 任务进入 `waiting_provider`。
  - 轮询、Webhook 和产物不在本篇。

- Consumer 映射的职责是什么？
  - `to_opencreator_model_id(model_id, config_name?)` 把业务名收成 registry ID。
  - `OpenCreatorAIOptionsBuilder.build()` 把节点参数收成 AI `options`。
  - 然后 `POST /v1/tasks`。
  - 映射成功仍要过 AI 侧注册校验和参数校验。

- 产品目录和 registry 为什么不能合成一张表？
  - 目录回答用户看见什么、价格和权益是什么。
  - registry 回答能不能执行、走哪家、失败后换不换。
  - 目录有模型，不代表 registry 可执行。
  - registry 有模型，也不代表目录必须展示。
  - Agent 聊天模型集合不要和画布目录、AI registry 合并统计。

## NovelComic 迁移

- 为什么不要先做一张大前端模型表？
  - 前端表不能证明模型可执行。
  - 最先要跑通的是 registry 里一条真实 Provider call。

- 五段编写顺序是什么？
  - AI core 类型。
  - Provider client 和 result normalizer。
  - 单个模型文件，再放进 `CORE_MODELS`。
  - model-runtime、constraints、Robin、provider worker。
  - 最后才接 Consumer 映射和 Publisher / Frontend 目录。

- 第一轮 Robin 要做到什么程度？
  - 先一条 call 跑通 submit 和 normalize。
  - 再加第二条，验证第一家失败会试下一家。
  - 同时验证钉死 Provider 时失败后不 fallback。

- 本章最小验收是什么？
  - `CoreProvider` 包含要接入的厂商。
  - client 能拿到 request id 或同步结果。
  - normalizer 能分出成功、失败、处理中。
  - 模型在 `CORE_MODELS` 里，且至少一条 `robin_calls`。
  - 别名能收成规范 ID，未注册模型有稳定错误。
  - 默认 call 和钉死 Provider 使用各自的 schema。
  - 未钉死时第一家失败能跳到下一家；钉死则不跳。
  - worker 把任务写到 `waiting_provider`，并记下 request id。
  - Consumer 映射后的 ID 和 options 能过 AI 校验。
  - 产品目录、Consumer 映射、`CORE_MODELS` 三者 ID 对齐。

## 面试短答

- 一句话讲模型注册、Provider 与 Robin？
  - `CORE_MODELS` 决定模型能不能执行，每条 `robin_calls` 是一条厂商路径，Robin 只按数组顺序在失败后换下一家。

- 一句话讲产品和执行为什么要拆开？
  - 产品目录管用户看见什么和怎么卖，AI registry 管这个 ID 找谁执行、参数怎么验、失败后往哪走。

- 一句话讲钉死 Provider？
  - `options.provider` 只允许这一家，失败后不再 fallback，而且这个字段不会透传给厂商。

- 一句话讲跳过键？
  - 跳过的是 `provider:model_id`，所以同一 Provider 的另一个厂商模型还可以留在后面的 fallback 里。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - registry、KIE client、KIE normalizer、`submitCoreTask()`、钉死 Provider 和 worker fallback 都已经有代码。
  - `CORE_MODELS` 里只有 `kie-image-v1` 一条 `kie:z-image` webhook call。
  - Consumer 映射、options builder、Publisher 内置目录和前端本地目录都对到这个 ID。
  - 还没有 OpenCreator 那种上百个模型和二十多家 Provider。

- 未注册错误和参考笔记一样吗？
  - 文案一样，是 `Model is not registered`。
  - 当前 code 是 `MODEL_NOT_REGISTERED`。
  - 没有数字错误码 `3008`。

- 别名现在能收成什么？
  - `kie-image` 和 `z-image` 收成 `kie-image-v1`。
  - Consumer 映射表也认识这两个别名，以及 `imageModel`、`image_model`、`text_to_image_config` 下的 `default`。
  - 映射表没有的名字在 Consumer 就抛 `MissingOpenCreatorAIModelMapping`，请求到不了 AI。

- 当前这张表有没有第二家 fallback？
  - 运行时支持按 `provider:model_id` 跳过并重新入队。
  - 钉死 `options.provider` 时剩余 Provider 为空。
  - 已注册的 KIE 图像只有一条 call，所以这条生产模型没有下一家可换。

- `result_mode` 和参考笔记有什么差别？
  - 参考笔记只有 `webhook` 和 `polling`，同步结果走 `immediateResult`。
  - NovelComic 的类型写成了 `sync | polling | webhook`。
  - worker 仍然识别 submit 返回上的 `immediateResult`。
  - 当前 KIE 图像 call 登记的是 `webhook`。

- 产品目录能不能当成已经注册？
  - 不能。
  - Publisher 内置了 `text_to_image_config` / `kie-image-v1`，前端本地列表用了同一个 ID。
  - 它们只管展示和对齐。
  - 可执行权威仍是 `CORE_MODELS`。
  - `model_constraints.json` 记 prompt 长度、输入模态和 KIE retry，不决定售价。

- 参数校验现在跟哪条 call 走？
  - `validateCoreModelOptions()` 读选中 call 的 `options_schema`。
  - KIE 图像至少要求 `prompt`。
  - 钉死 Provider 时用那一家的 schema，并且 `provider` 字段不会进 `submit()` 的业务参数。

- 什么时候才算本章完整验收？
  - 一条真实 Provider call 能提交并归一化结果。
  - 模型在 `CORE_MODELS` 里，别名和未注册错误稳定。
  - worker 能把 `queued` 任务推进到 `waiting_provider` 并写下 request id。
  - 钉死 Provider 不会 fallback；有第二条 call 时，第一家失败会试下一家。
  - Consumer 组出的 ID 和 options 能过 AI 校验。
  - 产品目录 ID 和 registry ID 对齐，但目录本身不算执行注册。
