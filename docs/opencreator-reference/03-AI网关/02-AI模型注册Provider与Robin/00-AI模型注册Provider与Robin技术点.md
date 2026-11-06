# AI 模型注册、Provider 与 Robin：技术点

这组只讲 `opencreator-ai` 如何把一个规范模型 ID 映射到可执行的 Provider 调用：模型 registry、Provider 类型、模型别名、参数 schema、结果模式、Robin fallback，以及它和 Publisher/Frontend 产品模型目录的边界。

先背一句话：

```text
Publisher/Frontend 的模型目录决定用户看见什么；
Consumer 决定业务节点传什么 model_id；
opencreator-ai 的 CORE_MODELS 决定这个 model_id 到底能不能执行、找哪家 Provider 执行。
```

它不讲任务怎么创建，也不讲 Provider 结果怎么轮询、Webhook 怎么收敛、产物怎么回调 Consumer。建单看 [01-AI任务契约与状态机](../01-AI任务契约与状态机/01-AI任务契约与状态机.md)，结果链路放到后面的 AI 提交、轮询、Webhook、产物与回调专题里。

最短链路是：

```text
Consumer 传 model_id / options
  → resolveCoreModelId 收别名
  → requireCoreModel 确认模型在 CORE_MODELS
  → validateCoreModelOptions 按选中的 call 校验 options
  → submitCoreTask 读取 robin_calls
  → 按顺序选择 Provider call
  → submit(context)
  → 返回 provider_request_id / result_mode
  → 失败且未钉死 Provider 时尝试下一家
```

这篇的边界固定：

- `CORE_MODELS` 是 AI 执行 registry，不是用户侧模型商品目录。
- `CoreProviderCall` 是“某个模型到某个厂商模型”的执行配置，不是一次任务 attempt。
- Robin 是有序 fallback，不是随机、加权、并发竞速或负载均衡。

---

## 1. `CORE_MODELS` 是执行权威源

OpenCreator 对照：

- [models/index.ts](../../../../../opencreate/opencreator-ai/packages/core/src/models/index.ts)
- [types.ts](../../../../../opencreate/opencreator-ai/packages/core/src/types.ts)

AI 网关能执行哪些模型，最终看：

```text
CORE_MODELS
```

数组里的每一项都是 `CoreModelEntity`：

```text
id
aliases
displayName
robin_calls
```

`displayName` 只是 AI registry 内的展示名，不等于产品目录里的价格、排序、分组和可见性。新增模型如果没有放进 `CORE_MODELS`，即使文件存在、前端目录存在、Consumer 映射存在，也不算 AI 网关已注册。

---

## 2. `CoreProvider` 是厂商枚举

OpenCreator 对照：

- [types.ts](../../../../../opencreate/opencreator-ai/packages/core/src/types.ts)

`CoreProvider` 是 AI core 认可的 Provider 字符串联合类型，例如：

```text
fal
google
openai
anthropic
byteplus
volcengine
ideogram
minimax
runway
luma
replicate
kling
aliyun
tencent
...
```

这里的 Provider 是执行适配层，不是产品展示分类。一个产品模型可以有多个 Provider fallback；同一个 Provider 也可以承载多个厂商模型 ID。

---

## 3. `CoreProviderCall` 是一次可选执行路径

每个 `robin_calls` 元素都是一个 `CoreProviderCall`：

```text
provider
model_id
options_schema
result_mode
submit()
getResult?()
normalizeResult()
```

含义是：

- `provider`：AI core 内部 Provider 名。
- `model_id`：厂商侧模型 ID。
- `options_schema`：这个 Provider call 接受的参数形状。
- `result_mode`：结果来自 webhook 还是 polling。
- `submit()`：真正提交给厂商。
- `getResult()`：轮询模式或 fallback 兜底时读取结果。
- `normalizeResult()`：把厂商结果变成 AI 网关统一结果。

所以“注册一个模型”不是只加一个名字，而是要给出至少一条可执行 Provider call。

---

## 4. 别名只解决入口兼容

OpenCreator 对照：

- [model-runtime.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-runtime.ts)

Consumer 可以传规范 ID，也可以传别名。AI core 用：

```text
resolveCoreModelId(model_id)
```

查找：

```text
entry.id === model_id
  或 entry.aliases 包含 model_id
```

命中则返回规范 `entry.id`。不命中时，当前实现会原样返回，再由 `requireCoreModel()` 抛未注册错误。

别名只解决旧模型名、产品层命名和 AI registry 命名之间的兼容，不应该当成另一个独立模型注册。

---

## 5. `requireCoreModel` 才是最终注册校验

建单时可以先 `resolveCoreModelId()`，Provider worker 打厂商前还会：

```text
requireCoreModel(model_id)
```

找不到模型时抛：

```text
Model is not registered
error_code=3008
```

因此 NovelComic 迁移时不能只靠前端模型目录、Publisher 配置或 Consumer 映射判断模型可执行。最终权威在 AI gateway 的 registry。

---

## 6. 参数 schema 跟 Provider call 绑定

OpenCreator 对照：

- [model-runtime.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-runtime.ts)
- [model-constraints.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-constraints.ts)
- [model_constraints.json](../../../../../opencreate/opencreator-ai/packages/core/data/model_constraints.json)

参数校验入口是：

```text
validateCoreModelOptions(model_id, options)
```

这个函数定义在 `model-runtime.ts`。默认情况下，它选择 `robin_calls` 里的第一条 call，用这条 call 的 `options_schema` 解析参数。

如果请求通过 `options.provider` 钉死 Provider，则先确认这个 Provider 在当前模型的 `robin_calls` 内，再使用对应 call 的 `options_schema` 校验。

`model-constraints.ts` 和 `model_constraints.json` 是另一层输入限制配置，供提交前预校验和模型能力约束使用。它们不替代 Provider call 自己的 `options_schema`。

这意味着：

- 同一个模型的不同 Provider call 可以有不同参数 schema。
- 钉死 Provider 后不能继续用第一家 Provider 的 schema。
- 参数校验失败时不应该落库为可执行任务。

---

## 7. `options.provider` 是显式钉死 Provider

OpenCreator 对照：

- [model-runtime.ts](../../../../../opencreate/opencreator-ai/packages/core/src/model-runtime.ts)

Consumer/前端可以在 `options.provider` 里传 Provider 名。AI core 会：

```text
extractRequestedProviderFromOptions()
  → trim + lower
  → assertPinnedProviderAllowed()
  → selectCoreCall(entry, requestedProvider)
```

真正进厂商 API 前，会用：

```text
stripProviderFromOptions()
```

把 `provider` 从 options 移除，避免透传给上游模型。

钉死 Provider 后，失败不会越权切到其他 Provider。`getRemainingRobinProviders()` 会直接返回空数组。

---

## 8. Robin 是有序 fallback

Robin 的顺序就是 `robin_calls` 数组顺序：

```text
robin_calls[0]
  → robin_calls[1]
  → robin_calls[2]
```

失败后，系统用 `skip_providers` 跳过已经失败的精确 call：

```text
provider:model_id
```

注意跳过粒度是 Provider 加厂商模型 ID，不只是 Provider 名。同一个 Provider 的另一个模型 ID 仍然可以是另一条 fallback。

Robin 不是：

- 随机选择。
- 按权重分流。
- 多 Provider 并发。
- 低延迟优先。

---

## 9. `result_mode` 只分 webhook 和 polling

OpenCreator 对照：

- [types.ts](../../../../../opencreate/opencreator-ai/packages/core/src/types.ts)

`CoreProviderResultMode` 只有：

```text
webhook
polling
```

同步返回最终结果的 Provider 不额外定义第三种模式，而是在 `submit()` 返回里带：

```text
immediateResult
```

polling fallback 预先拿到的首次结果用：

```text
firstPollResult
```

所以不要新增一个 `sync` 状态或 `immediate` result mode；它是 submit 返回的附加结果，不是 Provider call 的模式。

---

## 10. `normalizeResult` 是厂商结果的出口

每条 Provider call 都要提供：

```text
normalizeResult(result, context)
```

它负责把厂商原始结果转成 AI 网关统一的 `ProviderResult`，后续任务仓储、artifact worker 和 Consumer callback 都按统一结果处理。

因此 Provider 适配不能只做到“submit 成功返回 request id”。它还必须说明结果怎么归一化，否则后续链路无法判断成功、失败、媒体 URL 和错误码。

---

## 11. 产品模型目录不是 AI registry

OpenCreator 对照：

- [Publisher 模型目录接口](../../../../../opencreate/opencreator-publisher/controller/v1/models.py)
- [Frontend 模型目录数据](../../../../../opencreate/opencreator-frontend/src/constants/availableModelInstances.tsx)

Publisher/Frontend 模型目录决定：

- 用户看见哪些模型。
- 下拉展示名和分组。
- 价格、权益、排序和可见性。
- 节点类型上可选择哪些模型。

AI registry 决定：

- 这个模型 ID 是否真正注册。
- 可走哪些 Provider。
- 参数 schema 怎么校验。
- 失败后能不能 fallback。

两边不能互相反推。产品目录有模型，不代表 AI registry 一定可执行；AI registry 有模型，也不代表产品目录必须展示。

---

## 12. Consumer 映射是跨仓桥接

OpenCreator 对照：

- [opencreator_ai.py](../../../../../opencreate/opencreator-consumer/model_gateway/providers/opencreator_ai.py)
- [model_mapper.py](../../../../../opencreate/opencreator-consumer/services/opencreator_ai/model_mapper.py)
- [options_builder.py](../../../../../opencreate/opencreator-consumer/services/opencreator_ai/options_builder.py)

Consumer 在提交前会做：

```text
业务节点模型名
  → OpenCreatorAIModelMapper.to_opencreator_model_id()
  → OpenCreatorAIOptionsBuilder.build()
  → POST /v1/tasks
```

这个映射解决业务层模型名和 AI registry ID 的差异。最终是否可执行仍由 `opencreator-ai` 的 `requireCoreModel()` 决定。

---

## 动手前要有的东西

### opencreator-ai

- `CoreProvider` 类型。
- `CoreModelEntity` 和 `CoreProviderCall` 类型。
- 至少一个 Provider client。
- 至少一个 Provider result normalizer。
- 至少一个模型文件。
- `CORE_MODELS` 汇总数组。
- `resolveCoreModelId()` / `requireCoreModel()`。
- `validateCoreModelOptions()`。
- `submitCoreTask()` 和 Robin fallback。

### Consumer

- 节点模型名到 AI registry ID 的映射。
- 节点参数到 AI `options` 的转换。
- 可选的 `options.provider` 透传规则。
- 建任务客户端。

### 产品目录

- Publisher 模型目录接口。
- Frontend 模型列表和节点可选项。
- 清楚标注：它们不是 AI registry 的权威源。

后续 Provider 提交后的轮询、Webhook、产物处理和 Consumer 回调，放到 [03-AI提交轮询Webhook产物与回调](../03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)。
