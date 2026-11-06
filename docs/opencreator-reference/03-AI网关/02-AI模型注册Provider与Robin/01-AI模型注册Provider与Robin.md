# OpenCreator 是怎么做 AI 模型注册、Provider 与 Robin 的

如果要看机制拆解，读 [00-AI模型注册Provider与Robin技术点.md](./00-AI模型注册Provider与Robin技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一、先说结论

OpenCreator 的 AI 模型不是靠前端目录直接执行的。真正能不能打厂商，取决于 `opencreator-ai` 里的 `CORE_MODELS`。

```text
Consumer 传 model_id
  → resolveCoreModelId 收别名
  → requireCoreModel 查 CORE_MODELS
  → validateCoreModelOptions 校验参数
  → submitCoreTask 读取 robin_calls
  → 选择 CoreProviderCall
  → 调 submit()
  → 返回 provider_request_id 和 result_mode
```

必须分清四件事：

- 产品模型目录：Publisher/Frontend 用来展示、排序、定价和控制可见性。
- Consumer 模型映射：把业务节点模型名转成 AI registry ID。
- AI registry：`opencreator-ai` 里真正可执行的模型注册表。
- Provider call：某个模型的一条厂商执行路径。

Robin 是 `robin_calls` 的有序 fallback。它不是负载均衡，也不是随机选择。

---

## 二、必须有的文件

按一次模型从“被识别”到“被提交”的顺序背。第 9 步之后才进入具体 Provider 的轮询、Webhook、产物处理。

1. `opencreator-ai/packages/core/src/types.ts`：定义 `CoreProvider`、`CoreModelEntity`、`CoreProviderCall`、`CoreSubmitResult`。
2. `opencreator-ai/packages/core/src/models/*.ts`：每个模型声明自己的 ID、别名、展示名和 `robin_calls`。
3. `opencreator-ai/packages/core/src/models/index.ts`：把已注册模型汇总进 `CORE_MODELS`。
4. `opencreator-ai/packages/core/src/model-runtime.ts`：模型别名收敛、注册校验、Provider 钉死、Provider call 参数校验、Robin 选择和提交入口。
5. `opencreator-ai/packages/core/src/model-constraints.ts`：读取模型约束配置，给提交前预校验和能力限制使用。
6. `opencreator-ai/packages/core/data/model_constraints.json`：模型能力、输入限制和部分历史产品字段数据。
7. `opencreator-ai/packages/runtime/src/provider-worker.ts`：读取 `ai_task`，调用 `submitCoreTask()`，记录 attempt 和 fallback。
8. `opencreator-consumer/services/opencreator_ai/model_mapper.py`：Consumer 侧把业务模型名映射成 AI registry ID。
9. `opencreator-consumer/services/opencreator_ai/options_builder.py`：Consumer 侧把节点参数组装成 AI `options`。
10. `opencreator-consumer/model_gateway/providers/opencreator_ai.py`：Consumer 侧把模型节点提交给 `opencreator-ai`。
11. `opencreator-publisher/controller/v1/models.py`：产品模型目录接口。
12. `opencreator-frontend/src/constants/availableModelInstances.tsx`：前端模型目录和展示数据。

### `opencreator-ai/packages/core/src/types.ts`

OpenCreator 源码：[types.ts](../../../../../opencreate/opencreator-ai/packages/core/src/types.ts)

这份文件先把 AI core 的核心概念定死：

```text
CoreProvider
CoreModelEntity
CoreProviderCall
CoreSubmitResult
CoreRunContext
CoreProviderResultMode
```

最关键的是：

```text
CoreModelEntity
  → id
  → aliases
  → displayName
  → robin_calls

CoreProviderCall
  → provider
  → model_id
  → options_schema
  → result_mode
  → submit()
  → getResult?()
  → normalizeResult()
```

这说明模型注册不是只加一个 ID。至少要有一条 Provider call，后续才知道怎么提交、怎么取结果、怎么归一化。

### `opencreator-ai/packages/core/src/models/*.ts`

OpenCreator 源码：[models 目录](../../../../../opencreate/opencreator-ai/packages/core/src/models)

每个模型文件一般负责一类模型或一个模型族。里面导出具体 `CoreModelEntity`。

一个可执行模型至少要声明：

```text
id
aliases
displayName
robin_calls
```

`robin_calls` 可以只有一条，也可以多条。多条时，顺序就是 fallback 顺序。

### `opencreator-ai/packages/core/src/models/index.ts`

OpenCreator 源码：[models/index.ts](../../../../../opencreate/opencreator-ai/packages/core/src/models/index.ts)

这里是 registry 汇总入口：

```text
export const CORE_MODELS = [
  ...
]
```

只有放进这个数组的模型，才算 AI 网关已注册。文件里有实现但没 import、没放入数组，不算可执行模型。

当前代码快照里，既有图像、视频、音频，也有文本模型。具体数量会随代码变化，不要把文档里的数字当成长期常量。

### `opencreator-ai/packages/core/src/model-runtime.ts`

OpenCreator 源码：[model-runtime.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-runtime.ts)

这是模型运行时的核心文件，负责：

```text
listCoreModels()
resolveCoreModelId()
requireCoreModel()
validateCoreModelOptions()
submitCoreTask()
getRemainingRobinProviders()
getCoreProviderResult()
parseCoreProviderWebhook()
```

本篇最关键的是前三组：

```text
resolveCoreModelId()
  → alias 或 id 收成规范模型 ID

requireCoreModel()
  → 确认模型在 CORE_MODELS

submitCoreTask()
  → 按 robin_calls 执行 Provider call
```

### `opencreator-ai/packages/core/src/model-constraints.ts`

OpenCreator 源码：[model-constraints.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-constraints.ts)

这层负责读取模型约束配置：

```text
getModelConstraints()
getProviderEntry()
updateModelConstraintsConfig()
```

它不是 `validateCoreModelOptions()` 的定义处。Provider call 的 `options_schema` 校验在 `model-runtime.ts`；`model-constraints.ts` 主要提供模型能力、输入尺寸、时长、格式、Provider retry 等约束数据，供提交前预校验使用。

### `opencreator-ai/packages/core/data/model_constraints.json`

OpenCreator 源码：[model_constraints.json](../../../../../opencreate/opencreator-ai/packages/core/data/model_constraints.json)

这份数据承载模型能力和输入限制。当前 OpenCreator 里也包含 `pricing` 等历史字段，但在这组 AI registry 文档里，不应把它当成产品模型目录的权威源。

NovelComic 迁移时，执行链路优先依赖输入限制、Provider 能力和参数约束；价格、用户权益、目录排序仍应以 Publisher/Frontend 产品目录为准。

### `opencreator-ai/packages/runtime/src/provider-worker.ts`

OpenCreator 源码：[provider-worker.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)

Provider worker 从队列拿到：

```text
ai_task_id
skip_providers?
```

然后：

```text
taskRepository.requireByAiTaskId()
  → submitCoreTask()
  → markProviderSubmitted()
  → upsertAttempt()
```

提交失败时，worker 会根据 Robin 是否还有剩余 Provider 来决定是否重新入队 fallback job。

### `opencreator-consumer/services/opencreator_ai/model_mapper.py`

OpenCreator 源码：[model_mapper.py](../../../../../opencreate/opencreator-consumer/services/opencreator_ai/model_mapper.py)

Consumer 侧模型名不一定等于 AI registry ID。这里负责：

```text
业务模型名 / config_name
  → opencreator-ai model_id
```

这是跨仓桥接，不是 AI 执行权威。映射错了，最终仍会被 AI 侧 `requireCoreModel()` 拦住。

### `opencreator-consumer/services/opencreator_ai/options_builder.py`

OpenCreator 源码：[options_builder.py](../../../../../opencreate/opencreator-consumer/services/opencreator_ai/options_builder.py)

负责把 Consumer 的节点输入组成 AI 网关的 `options`。

这一步要和 AI registry 的 `options_schema` 对齐，否则任务会在 `validateCoreModelOptions()` 阶段失败。

### `opencreator-consumer/model_gateway/providers/opencreator_ai.py`

OpenCreator 源码：[opencreator_ai.py](../../../../../opencreate/opencreator-consumer/model_gateway/providers/opencreator_ai.py)

这是 Consumer 侧把模型节点提交给 `opencreator-ai` 的 Provider。关键动作：

```text
OpenCreatorAIModelMapper.to_opencreator_model_id()
OpenCreatorAIOptionsBuilder.build()
OpenCreatorAITaskRequest(...)
OpenCreatorAITaskClient.submit()
```

它还会构造 `client_context`，把 run、flow task、node、result、user、config 等业务上下文交给 AI 网关保存并回调时带回。

### `opencreator-publisher/controller/v1/models.py`

OpenCreator 源码：[models.py](../../../../../opencreate/opencreator-publisher/controller/v1/models.py)

Publisher 模型目录面向产品展示。它不决定 AI registry 是否可执行。

不要因为 Publisher 目录里有某个模型，就认为 `opencreator-ai` 一定注册了对应 `CoreModelEntity`。

### `opencreator-frontend/src/constants/availableModelInstances.tsx`

OpenCreator 源码：[availableModelInstances.tsx](../../../../../opencreate/opencreator-frontend/src/constants/availableModelInstances.tsx)

前端模型目录决定用户在节点里看见什么。它也不是 AI registry 权威源。

如果前端展示了一个模型，但 Consumer 映射或 AI registry 没接上，运行时仍会失败。

---

## 三、运行时链路

### 1. Consumer 选择模型并映射

```text
业务节点 model_id / config_name
  → OpenCreatorAIModelMapper.to_opencreator_model_id()
  → opencreator_model_id
```

映射后的 ID 会作为 AI task 的 `model_id`。

### 2. Consumer 组装 options

```text
ModelProviderRequest
  → OpenCreatorAIOptionsBuilder.build()
  → options
```

如果要钉死 Provider，Consumer 可以把 Provider 放在：

```text
options.provider
```

### 3. AI 建单时收别名和校验参数

```text
TaskService
  → resolveCoreModelId(model_id)
  → validateCoreModelOptions(core_model_id, options)
```

`validateCoreModelOptions()` 会确认 Provider 是否允许，并用对应 call 的 `options_schema` 解析参数。

### 4. Provider worker 读取任务

```text
provider-execution submit job
  → ai_task_id
  → taskRepository.requireByAiTaskId()
```

worker 读取任务后，把任务里的 `model_id`、`options`、`webhook_url`、`trace_id` 交给 core。

### 5. `submitCoreTask` 选择 Provider call

```text
submitCoreTask()
  → requireCoreModel(model_id)
  → extractRequestedProviderFromOptions(options)
  → orderedCalls(entry, requestedProvider?)
  → runModelSubmit()
```

没有钉死 Provider 时，从 `robin_calls[0]` 开始。

有 `options.provider` 时，只尝试指定 Provider。

### 6. 提交前剥离 `options.provider`

`options.provider` 是 AI core 的控制字段，不应该透传给厂商模型。真正进入 Provider call 前会：

```text
stripProviderFromOptions(options)
```

这样上游厂商只收到业务参数，不收到 OpenCreator 的内部路由字段。

### 7. Provider call 返回提交结果

Provider `submit()` 返回：

```text
provider
model_id
result_mode
provider_request_id
provider_status
raw_summary
immediateResult?
firstPollResult?
```

worker 会把 Provider、厂商模型 ID、请求 ID 和状态写回任务与 attempt。

### 8. 失败后按 Robin fallback

如果某个 Provider call 失败，而且没有钉死 Provider，worker 会把失败 call 写入 skip：

```text
provider:model_id
```

再创建 fallback job。下一次 `submitCoreTask()` 会跳过这些 call，尝试后面的 `robin_calls`。

如果已经钉死 Provider，或 Robin 没有剩余 call，则进入最终失败路径。

---

## 四、和产品模型目录的关系

产品目录回答的是：

```text
用户能看到什么模型？
节点里展示什么名字？
价格和权益是什么？
哪些模型对当前用户可见？
```

AI registry 回答的是：

```text
这个 model_id 是否注册？
参数能不能通过 schema？
能走哪些 Provider？
失败后能不能换下一家？
结果怎么归一化？
```

这两套表可以有关联，但不能合并成一套。

如果 NovelComic 迁移时把产品目录当成执行 registry，会出现三个问题：

1. 前端能选，但 AI 网关不认识。
2. AI 能执行，但产品目录没有价格、权益或展示配置。
3. Consumer 映射和 AI registry ID 不一致，运行时才失败。

---

## 五、和 NovelComic 对照

NovelComic 迁移这块时，顺序应该是：

1. 先定义 AI core 的 Provider 和模型类型。
2. 再接一个最小 Provider call，跑通 submit + normalize。
3. 再把模型放进 `CORE_MODELS`。
4. 再写 alias、`requireCoreModel()` 和参数校验。
5. 再接 Robin fallback。
6. 最后再和 Publisher/Frontend 产品目录、Consumer 映射对齐。

不要先做一张很大的前端模型表。前端表不能证明模型真的可执行；最先要跑通的是 AI registry 里一条真实 Provider call。

做完本篇后，再接 [AI提交轮询Webhook产物与回调](../03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)。
