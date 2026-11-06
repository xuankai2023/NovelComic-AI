# AI 模型注册、Provider 与 Robin：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-ai`、`opencreator-consumer`。NovelComic 看 `novelcomic-ai`、`novelcomic-consumer`。

不在这一份：建单 HTTP 信封、请求体 trim、`ai_task` 字段、fallback 的状态名和 `jobId`。这些在「AI 任务契约与状态机」。厂商请求体、轮询循环、Webhook 验签、产物上传、回调签名和重试在「AI 提交、轮询、Webhook、产物与回调」。这里只补 registry 里有哪些模型、一条 call 长什么样、`submitCoreTask()` 在一次调用里怎么换下一家、提交前的约束预校验，以及 Consumer 的模型别名表。

产品目录的下拉、价格和排序不在这里改。目录里有没有某个名字，不改变 `CORE_MODELS`。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。差的是类名和文件怎么拆。

- `extractRequestedProviderFromOptions()`：只认字符串。`trim` 后转小写，空字符串当成没有钉死
- `stripProviderFromOptions()`：删掉 `provider` 这一个键，其余键原样留下
- 别名比较是大小写敏感的全等。同一个名字命中多项时，`CORE_MODELS` 里先出现的那项胜出。`displayName` 不参与查找
- `options.provider` 钉死之后，`getRemainingRobinProviders()` 返回空数组
- 跳过键是 `provider:model_id`。同一个 Provider 的另一个厂商模型 ID 仍留在后面
- `models/index.ts` 里 Youchuan 视频两个模型保持注释，不进 `CORE_MODELS`

# 1. 类型按现码收紧

做完要达到：`CoreProvider` 只收这 23 个字符串：

```text
fal
google
openai
anthropic
xai
byteplus
volcengine
ideogram
minimax
runway
luma
fish_audio
replicate
deer
kie
baidu
sufy
kling
qnaigc
aliyun
tencent
youchuan
gemini_openai
```

`CoreProviderResultMode` 只有 `webhook` 和 `polling`。同步结果放在 `CoreSubmitResult.immediateResult` 上。轮询兜底预先拿到的首次结果放在 `firstPollResult`。不要再有 `sync`。

`CoreModelEntity.robin_calls` 是必填数组。`CoreProviderCall` 是：

```text
provider
model_id                 厂商模型 ID
options_schema           Zod schema，必填
result_mode
submit(context)          context 已去掉 provider，并做过第 5 节的图片 URL 改写
getResult?(provider_request_id, context)
normalizeResult(result, context)   返回 Promise
```

`submit()` 成功时至少返回 `provider`、`model_id`、`result_mode`、`provider_request_id`。可以另带 `provider_status`、`raw_summary`、`immediateResult`、`firstPollResult`。

`CoreRunContext` 带 `config`、`ai_task_id`、`model_id`、`options`、`uploader`。`webhook_url`、`logger`、`mediaAssetResolver`、`onProviderAttemptFailed` 有才放。`submitCoreTask()` 的入参要带 `config`，以及可选的 `execution_options`、`skip_providers`。没传 uploader 时用 `passThroughUploader`：`uploadRemoteUrl` 只返回 `{ url }`。真正把产物传到对象存储留在下一节。

`listCoreModels()` 返回 `{ model_id, aliases?, displayName }`。不返回 `robin_calls`。

没有 `registerCoreModel()`。进程启动后不能再往数组里推模型。

## 现在

`CoreProvider` 是 `'byteplus' | 'kie' | 'unknown'` 再加任意字符串。`result_mode` 含 `sync`。`options_schema` 是 JSON Schema 对象，而且可选。`robin_calls` 可选。`submit()` 吃的是 `{ ai_task_id, model_id, options, webhook_url }`。`getResult()` 吃的是 `{ request_id, model_id }`。`normalizeResult()` 同步返回 `{ status: succeeded | failed | processing }`。

`CORE_MODELS` 是一份可改的拷贝，`registerCoreModel()` 能在运行时追加。`listCoreModels()` 返回完整实体。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/types.ts`。对照 OpenCreator `packages/core/src/types.ts` 的 `CoreProvider`、`CoreModelEntity`、`CoreProviderCall`、`CoreSubmitResult`、`CoreRunContext`。
2. `novelcomic-ai/packages/core/src/model-runtime.ts` 的 `listCoreModels()`。删掉 `registerCoreModel()`。`packages/core/src/index.ts` 不再导出它。

# 2. 未注册和钉死 Provider 的抛错对象

做完要达到：`requireCoreModel()` 找不到时抛 `OpenCreatorAiError`。`kind` 是 `not_found`，`error_code` 是 `3008`，文案是 `Model is not registered: ${model}`。`model` 是调用时传入的原字符串。`resolveCoreModelId()` 不 `trim`。对上 `id` 或 `aliases` 才返回规范 id，对不上就原样返回。

钉死的 Provider 不在该模型 `robin_calls` 里时，抛 `OpenCreatorAiError`。`kind` 是 `validation_error`，`error_code` 是 `3007`，文案是 `Provider "${requested}" is not available for model ${id}. Allowed: ${list}`。`list` 是去重后的 provider 名，逗号加空格拼接。

上一节已经把这两种错收成 HTTP 404 和 400。这里只改抛出的对象，让那个 handler 能接到。

`selectCoreCall()` 按厂商模型 ID 对不上时，抛普通 `Error`，文案是 `Provider ${provider}/${providerModelId} is not registered for model ${id}`。没有厂商模型 ID 时，中间没有斜杠，provider 空着就写成 `default`。

对上规则：

- 字符串完全相同
- 注册的厂商模型 ID 是 `happyhorse-1.1-image2video` 时，`happyhorse-1.1-i2v` 和 `happyhorse-1.1-r2v` 也算同一条 call
- 注册 ID 里含有 `{mode}` 时，这一段可以是 `standard` 或 `pro`

## 现在

未注册是 `CoreModelNotRegisteredError`，`code` 是 `MODEL_NOT_REGISTERED`。`resolveCoreModelId()` 会先 `trim`。钉死了不存在的 Provider 是 `CoreProviderNotAvailableError`，文案是 `Provider is not available for model ${id}: ${provider}`。没有 call 时是 `CoreProviderCallNotFoundError`。没有按厂商模型 ID 做 `{mode}` 和 Happy Horse 的对应。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/model-runtime.ts` 的 `resolveCoreModelId()`、`requireCoreModel()`、`assertPinnedProviderAllowed()`、`selectCoreCall()`。对照 OpenCreator 同名函数。

# 3. `CORE_MODELS` 按现码的数组注册

做完要达到：`packages/core/src/models/index.ts` 的 `CORE_MODELS` 与 OpenCreator 当前数组逐项相同，顺序相同。当前是 180 个模型。权威是这个数组。模型文件写了、没 import、没放进数组，`requireCoreModel()` 找不到。

每一项的 `id`、`aliases`、`displayName`，以及 `robin_calls` 的顺序、`provider`、厂商 `model_id`、`result_mode`、`options_schema`，都对照 OpenCreator 同名模型文件和 `packages/core/src/api/**` 里的 call。厂商 HTTP 路径和请求体留在下一节，但 call 要接上现码的 `submit`、`getResult`、`normalizeResult`，否则 `result_mode` 和 schema 对不上。

`kie-image-v1` 不在这个数组里。`requireCoreModel("kie-image-v1")` 走第 2 节的未注册错误。

四条 Midjourney 的 id 已经相同：

```text
opencreator/text-to-image/midjourney-v8-1
opencreator/image-to-image/midjourney-v8-1
opencreator/text-to-image/midjourney-v8-2
opencreator/image-to-image/midjourney-v8-2
```

V8.1 两条的别名仍是 `opencreator/text-to-image/midjourney-v8` 和 `opencreator/image-to-image/midjourney-v8`。V8.2 没有别名。

这四条 call 要改成现码：

- Provider 是 `youchuan`
- V8.1 文生图和图生图的厂商模型 ID 都是 `midjourney-v8.1`
- V8.2 两条都是 `midjourney-v8.2`
- `result_mode` 是 `polling`，带 `getResult`
- schema 是现码的 Zod。`prompt` 必须是非空字符串。`aspect_ratio` 缺省可以，有值时要像 `16:9` 这种正整数比。`image_weight`、`style_weight` 缺省可以，有值时可以是数字或数字字符串，范围分别是 0 到 3、0 到 1000。V8.1 的 `style_version` 缺省可以，有值时数字或数字字符串都必须是 6。图生图还要有垫图或风格参考 URL

多条 `robin_calls` 的顺序就是数组顺序。例如 Nano Banana 2 文生图是 `google`、`tencent`、`sufy`、`baidu`、`fal`。VIP 是 `baidu` 然后 `fal`。其余模型不要在这里手写第二套顺序，以 OpenCreator 该模型文件里的数组为准。

## 现在

`CORE_MODELS` 只有 `kie-image-v1` 和上面四条 Midjourney。KIE 那条 call 是 `kie:z-image`，`result_mode` 是 `webhook`。

四条 Midjourney 的 `submit()` 直接抛需要凭证。`normalizeResult()` 固定返回 `processing`。厂商模型 ID 是 `midjourney-v8-1-text` 这一类。`result_mode` 是 `webhook`，没有 `getResult`。schema 只要求 `prompt`。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/models/index.ts`。对照 OpenCreator `packages/core/src/models/index.ts`。
2. `novelcomic-ai/packages/core/src/models/` 下已启用的模型文件。对照 OpenCreator 同目录。Youchuan 视频继续不要放进数组。
3. 每条 call 对照 OpenCreator `packages/core/src/api/` 里创建它的文件。HTTP 客户端的字节布局留在下一节。

# 4. 一次 `submitCoreTask()` 里按数组换下一家

做完要达到：`submitCoreTask()` 自己按剩余 call 往下试。成功的那一家就是返回值。前面失败的几家不另开队列 job。

顺序是：

```text
requireCoreModel(model_id)
  → 读取 options.provider
  → 钉死的名字不在 robin_calls 里：第 2 节的 3007
  → preValidateModelInput()，用的是去掉 provider 之后的 options
  → 主跳厂商 = 钉死的 provider，否则是 robin_calls[0].provider
  → 组 context：先改写图片 URL，再去掉 provider
  → 从前往后试 call
```

没钉死时，试全部 `robin_calls`。钉死时，只试这家 Provider 的 call。同一家可以有多条厂商模型 ID，这次调用里会按数组继续试。

worker 传进 `submitCoreTask()` 的 `skip_providers` 只取 `job.data.skip_providers`，没有这个字段就是空数组。不回退读任务文档上的 `robin_skip_providers`。上一节的 fallback job 已经把要跳过的键放进 job data。

`skip_providers` 里已有的 `provider:model_id` 跳过。然后：

- `submit()` 抛错：记下这次失败，试下一条
- `result_mode` 和 submit 返回都是 `polling`，没有 `immediateResult`，并且有 `getResult`：立刻做一次首次查询。结果是 `failed` 或查询抛错，试下一条。否则把这次查询放进 `firstPollResult` 并返回
- call 登记的是 `webhook`，但 submit 返回 `polling`：这次不要做首次查询，把 submit 结果返回。后面的轮询在下一节
- `immediateResult.status` 是 `failed`：试下一条
- 其余成功：返回这次 submit

全部跳过或全部失败：循环里的第一个值是 Error 就原样抛出。第一个值不是 Error，或者一个值都没有，就抛 `No provider call available for model ${id}`。不要再包一层 `CoreProviderSubmitError`。

`submitCoreTask()` 不再调用 `validateCoreModelOptions()`。Zod 校验只在上一节的建单路径。

`getRemainingRobinProviders()` 用规范 id 精确查找，不再走 `resolveCoreModelId()`。模型不在数组里就返回空，不抛未注册。当前 call 用 `provider` 和厂商 `model_id` 字符串全等比，不用第 2 节的 Happy Horse 和 `{mode}` 对应。那套对应只给 `selectCoreCall()`。下标对不上就返回空。对上之后返回它后面的全部 call，不过滤 `skip_providers`。钉死时在查找之前就返回空，所以同一家后面的厂商模型 ID 也不会变成新的队列 job。

队列里的 fallback 仍按上一节写状态和 `jobId`。钉死时因为这里返回空，不会再入队。

失败回调 `onProviderAttemptFailed` 的 `phase` 是 `submit`、`first_poll` 或 `immediate`。回调自己抛错只记日志，继续试下一家。telemetry 的字段留在下一节。

## 现在

`submitCoreTask()` 只调用滤完之后的第一条。`submit()` 抛错会被收成 `CoreProviderSubmitError`，同一次调用不会试下一家。函数里面还会再跑一遍 `validateCoreModelOptions()`。

`getRemainingRobinProviders()` 会先把别名收成规范 id。worker 在 job data 没有 `skip_providers` 时会改读任务上的 `skip_providers`。没有首次查询，也没有 `immediateResult` 失败后换下一家。`submitCoreTask()` 也不收 `config`。

## 改哪些文件

1. `novelcomic-ai/packages/core/src/model-runtime.ts` 的 `submitCoreTask()`、`orderedCalls()`、`getRemainingRobinProviders()`。对照 OpenCreator `runModelSubmit()` 和 `createRunContext()`。
2. `novelcomic-ai/packages/runtime/src/provider-worker.ts` 只接上「一次 submit 可能返回后面那一家」以及失败回调。状态名、`robin_skip_providers` 和 `jobId` 保持上一节，不要在这里改。

# 5. 约束预校验和进厂商前的图片 URL

做完要达到：`model-constraints.ts` 只提供 `getModelConstraints()`、`getProviderEntry()`、`getModelConstraintsConfig()`、`updateModelConstraintsConfig()`。查找顺序是模型 id、展示名、`_default`。不要再用这份 JSON 生成执行用的 options schema，也不要再导出第二套 `validateCoreModelOptions()`。

`preValidateModelInput()` 在第 4 节、选 call 之前执行。没有约束记录就返回。`_default` 在现码里存在，所以多数模型会落到它。

它只检查这些：

- `promptRequired` 时，`prompt` 不是字符串，或 `trim` 之后是空的：`validation_error`，`error_code` `3001`，文案 `Prompt is required for ${displayName}`
- `promptMaxLength` 比的是 `prompt.length`，不去空白。主跳厂商是 `google`，或约束里的 `provider` 是 `google_gemini`，跳过字符长度。否则超长是 `3006`，文案 `Prompt exceeds maximum length of ${max} characters`，`error_params` 是 `{ maxLength, currentLength }`
- `options.duration` 可以是数字或数字字符串。值是 `-1` 并且 `supportsAutoDuration` 时放过。高于 `videoDurationMax` 是 `4004`，文案 `Video duration ${duration}s exceeds maximum ${max}s`。低于 `videoDurationMin` 是 `4011`，文案 `Video duration ${duration}s is below minimum ${min}s`。两次的 `error_params` 都是 `{ minDuration, maxDuration, currentDuration }`
- `image_width` 和 `image_height` 要同时是数字或数字字符串，并且任一边低于 `imageMinWidth` 或 `imageMinHeight`：`4003`，文案 `Image dimensions ${w}x${h} are below minimum`。`error_params` 是 `{ minWidth, minHeight, currentWidth, currentHeight }`。只检查下限
- `file_size` 大于 `maxFileSizeBytes`：`4002`。文案是 `File size exceeds maximum of ${label}`，没有 `maxFileSizeLabel` 时 label 用 `${字节数} bytes`。`error_params.maxSize` 在没有 label 时只放字节数字符串，不带 ` bytes`。`currentSize` 是原来的 `file_size`

JSON 里的 `pricing` 不参与这段判断，也不当售价。

进 call 之前改写 options 里的 URL。只看键名和父对象，不看文件后缀。host 不是 `resource.opencreator.io` 或 `cos-resource.opencreator.io` 的不动。解析失败的字符串不动。

会改写的键，名字先转小写：

- 这些全名：`image`、`mask`、`mask_url`、`input_reference`、`image_tail`、`init_image`、`start_frame_url`、`end_frame_url`、`first_frame_url`、`last_frame_url`、`cover_url`、`thumbnail_url`
- 名字里含 `image`，并且以 `url` 或 `urls` 结尾
- 对象的 `type` 是 `image`、`input_image` 或 `image_url`，或者父键已经算图片键：里面的 `url`，以及以 `url` 或 `_url` 结尾的键，也改

数组沿用父键。改写结果：

- URL 里还没有 `imageMogr2`：没有查询串就接 `?imageMogr2/format/png`，已有查询串就接 `&imageMogr2/format/png`
- 已有 `imageMogr2` 并且有 `/format/某格式`：把格式换成 `png`
- 已有 `imageMogr2` 但没有格式：URL 里有 `?` 就接 `/format/png`，否则接 `?format/png`

## 现在

`model-constraints.ts` 把 `params` 收成字段约束，`validateCoreModelOptions()` 在转不出 JSON Schema 时把 options 原样放过。`packages/core/src/index.ts` 还导出 `registerCoreModelOptionConstraints`、`getCoreModelOptionConstraints`、`listCoreModelOptionConstraints`。数据里只有 `kie-image-v1` 和 KIE 的 retry。没有 `preValidateModelInput()`。进 `submit()` 之前也不改写 COS 图片 URL。

## 改哪些文件

1. `novelcomic-ai/packages/core/data/model_constraints.json`。对照 OpenCreator 同路径文件。
2. `novelcomic-ai/packages/core/src/model-constraints.ts` 和 `packages/core/src/index.ts`。对照 OpenCreator `model-constraints.ts`。删掉用 `params` 做执行校验的那一层，以及 `registerCoreModelOptionConstraints` 这组导出。`updateModelConstraintsConfig()` 只换 getter 背后的对象。导出的 `MODEL_CONSTRAINTS_CONFIG` 仍是启动时那一份。
3. 新增 `novelcomic-ai/packages/core/src/pre-validate.ts`。对照 OpenCreator `pre-validate.ts`。
4. 新增图片 URL 改写，对照 OpenCreator `packages/core/src/imagekit-url.ts` 的 `forceImageKitPngImageInputs()`。由第 4 节的 context 调用。

# 6. Consumer 别名表按现码两张字典

做完要达到：`to_opencreator_model_id(legacy_model_id, config_name="")` 与 OpenCreator 现码一致。

```text
legacy_model_id 以 opencreator/ 开头
  → 原样返回，不再查表

否则先查 CONFIG_SCOPED_LEGACY_TO_OPENCREATOR_MODEL_ID[config_name][legacy_model_id]
  → 再查 LEGACY_TO_OPENCREATOR_MODEL_ID
  → 都没有就抛错
```

不 `strip`。`" opencreator/text-to-image/fast-sdxl"` 不会因为首尾空白被收成已注册 id。`config_name` 也不 `strip`。

两张字典的键和值与 OpenCreator `services/opencreator_ai/model_mapper.py` 逐项相同。`opencreator/` 开头的 id 靠第一行返回，不必再写进字典。命中字典时不要调用 `note_legacy_model_id()`，也不要改 `legacy_call_volume` 的计数。

找不到时抛 `MissingOpenCreatorAIModelMapping`。它是 `OpenCreatorAIError`，不是裸 `ValueError`。`error_code` 是 `5923`，`error_origin` 是 `oc-consumer`。内部文案是 `missing opencreator-ai model mapping: legacy_model_id=${id}`，有 `config_name` 时再接 `, config_name=${config_name}`。对外文案是 `The AI model route is temporarily unavailable. Please try again later.`

`is_known_missing("test-debug-model")` 为真。说明是 `test-only model_config row; not an OpenCreator AI production model`。调用 `to_opencreator_model_id("test-debug-model")` 仍然抛上面的错，这个函数只做查询。

`mapping_report()` 返回 `mapped_count`、`missing_count`、`missing`。`mapped_count` 是两张表的条数相加。

上一节已经规定 options 怎么铺开、以及请求信封。这里不要再改字段改名。

## 现在

映射表只有 `kie-image-v1`、`kie-image`、`z-image`，以及 `imageModel`、`image_model`、`text_to_image_config` 下的 `default`。`opencreator/` 开头的 id 也会进这张表，对不上就抛错。`model_id` 和 `config_name` 会 `strip`。

错误类型是 `ValueError`，文案是 `Missing OpenCreator AI model mapping for ...`。没有 `5923`，没有 `is_known_missing()`。`mapping_report()` 返回的是 `models` 和 `scoped_models`。

## 改哪些文件

1. `novelcomic-consumer/app/services/opencreator_ai/model_mapper.py`。对照 OpenCreator `services/opencreator_ai/model_mapper.py`。
2. `novelcomic-consumer/app/services/opencreator_ai/errors.py` 的 `MissingOpenCreatorAIModelMapping`。对照 OpenCreator `services/opencreator_ai/errors.py`。
