# OpenCreator AI 模型注册、Provider 与 Robin

## 职责

AI registry 把规范模型 ID 映射成一组有序 Provider 调用。每个模型实体声明别名、展示名和 `robin_calls`；每个 call 声明厂商模型名、参数 schema、结果模式、提交和归一化函数。

这里的“展示名”不是产品模型目录。Publisher/Frontend 的模型目录决定下拉、价格、可见性和排序；`opencreator-ai` registry 决定执行时是否注册、允许哪些 Provider，以及失败后往哪家走。

## 入口

- `TaskService` 用 `resolveCoreModelId` 把请求别名收成 registry ID。
- `requireCoreModel` 在打厂商前确认模型已注册，未注册报错误码 `3008`。
- `submitCoreTask` 读取模型的 `robin_calls`，结合 `skip_providers` 和可选的指定 Provider 选择调用。
- 当前代码快照的权威源是 `CORE_MODELS` 和 `CoreProvider`：180 个注册模型实体、23 个 Provider；数字会随代码变化，详细清单见附录 C。

## 主链

```text
model_id/alias
  → resolveCoreModelId
  → requireCoreModel
  → 按 robin_calls 从前往后
  → 跳过 skip_providers 中的 provider:model_id
  → submit
  → 成功交出 provider_request_id/result_mode
  → 失败且未钉死 Provider：尝试下一家
```

`robin` 是有序 fallback，不是随机、加权或负载均衡。一次失败会把精确的 `provider:model_id` 写入跳过集合，再创建 fallback job；同一 Provider 的另一模型 ID 仍可是另一项。

## 关键状态/消息

- `CoreModelEntity`：`id`、`aliases`、`displayName`、`robin_calls`。
- `CoreProviderCall`：`provider`、厂商 `model_id`、`options_schema`、`result_mode`、`submit`、可选 `getResult`、`normalizeResult`。
- `result_mode` 只有 `webhook` 和 `polling`；同步结果通过 `immediateResult` 表达。
- `skip_providers` 与文档中的 `robin_skip_providers` 使用 `provider:model_id`。
- 请求参数显式钉死 Provider 时，失败后 `getRemainingRobinProviders` 返回空，不自动越权换厂商。

## 关键源码链接

- [180 个模型实体的权威数组](../../../../../opencreate/opencreator-ai/packages/core/src/models/index.ts)
- [23 个 Provider 与核心类型的权威定义](../../../../../opencreate/opencreator-ai/packages/core/src/types.ts)
- [别名、注册校验和 Robin 选择](../../../../../opencreate/opencreator-ai/packages/core/src/model-runtime.ts)
- [按模型参数约束](../../../../../opencreate/opencreator-ai/packages/core/src/model-constraints.ts)
- [模型约束数据](../../../../../opencreate/opencreator-ai/packages/core/data/model_constraints.json)
- [提交与 fallback worker](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-worker.ts)
- [Publisher 模型目录接口](../../../../../opencreate/opencreator-publisher/controller/v1/models.py)
- [Frontend 模型目录数据](../../../../../opencreate/opencreator-frontend/src/constants/availableModelInstances.tsx)
- [Consumer 模型 ID 映射和提交](../../../../../opencreate/opencreator-consumer/model_gateway/providers/opencreator_ai.py)

## 跨仓边界

- Publisher/Frontend 模型目录是产品目录，不是可执行注册表。
- Consumer 把节点模型名映射成 AI 的模型 ID，但最终注册校验在 opencreator-ai。
- opencreator-ai 负责 Provider 凭据、提交、结果模式和 fallback；不决定用户看到的售价。
- Publisher/Consumer 的计费配置不能反推 registry 一定已有对应 call，反向也一样。
- Agent 可能展示自己的聊天模型集合，不应与画布目录或 AI registry 合并统计。

## 遗留/未启用

- registry 是编译进进程的静态数组，新增项需发布 AI 服务，不是后台配置即时生效。
- `resolveCoreModelId` 找不到时会原样返回，真正失败推迟到 `requireCoreModel`。
- 源码中被注释的 import/export 或未放入 `CORE_MODELS` 的实现不计为已注册。
- “180/23”只描述当前代码快照；附录 C 由权威数组逐项核对，代码变化后仍需重新生成。
