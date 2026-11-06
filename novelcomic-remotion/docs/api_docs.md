# OpenCreator Remotion — API 文档

> 基于 Remotion 的视频合成服务。通过 API 可以拼接视频、叠加视频、自动生成字幕、渲染导出最终视频。
>
> 所有接口均为 `POST` 请求，`Content-Type: application/json`。

---

## 目录

- [1. 视频拼接 — POST /api/compose/concat](#1-视频拼接--post-apicomposeconcat)
- [2. 自动字幕 — POST /api/compose/subtitle](#2-自动字幕--post-apicomposesubtitle)
- [3. 视频叠加 — POST /api/compose/overlay](#3-视频叠加--post-apicomposeoverlay)
- [4. 剪辑编辑 API](#4-剪辑编辑-api)
- [5. 视频渲染 — POST /api/render + POST /api/progress](#5-视频渲染--post-apirender--post-apiprogress)
- [附录 A: 视频探测 — POST /api/compose/probe](#附录-a-视频探测--post-apicomposeprobe)
- [附录 B: 工程 JSON 结构概览](#附录-b-工程-json-结构概览)
- [附录 C: 典型工作流](#附录-c-典型工作流)
- [附录 D: 错误处理](#附录-d-错误处理)

---

## 1. 视频拼接 — POST /api/compose/concat

将多个视频按数组顺序拼接为一个工程文件。

### 请求地址

```
POST /api/compose/concat
```

### 请求参数


| 字段                  | 类型             | 必填  | 说明                     |
| ------------------- | -------------- | --- | ---------------------- |
| `videos`            | `VideoInput[]` | ✅   | 视频数组，按顺序拼接             |
| `compositionWidth`  | `number`       | ❌   | 画布宽度，默认 `1080`         |
| `compositionHeight` | `number`       | ❌   | 画布高度，默认 `1920`         |
| `fps`               | `number`       | ❌   | 帧率，默认 `30`             |
| `existingProject`   | `object`       | ❌   | 已有工程 JSON，传入则在此基础上追加视频 |


#### VideoInput 对象


| 字段                  | 类型        | 必填  | 说明                                 |
| ------------------- | --------- | --- | ---------------------------------- |
| `remoteUrl`         | `string`  | ✅   | 视频的远程 URL（必须是可公开访问的 HTTP/HTTPS 地址） |
| `filename`          | `string`  | ❌   | 文件名，不传则从 URL 自动提取                  |
| `durationInSeconds` | `number`  | ❌   | 视频时长（秒），不传则自动探测                    |
| `width`             | `number`  | ❌   | 视频宽度（px），不传则自动探测                   |
| `height`            | `number`  | ❌   | 视频高度（px），不传则自动探测                   |
| `hasAudioTrack`     | `boolean` | ❌   | 是否有音频轨，不传则自动探测                     |
| `size`              | `number`  | ❌   | 文件大小（字节）                           |
| `mimeType`          | `string`  | ❌   | MIME 类型，如 `"video/mp4"`            |
| `remoteFileKey`     | `string`  | ❌   | S3 文件 Key（用于后续字幕识别优化）              |


> **提示：** `durationInSeconds`、`width`、`height` 三个字段只要有一个缺失，服务端就会自动通过 URL 探测完整元数据。你可以只传 `remoteUrl` 一个字段。

### 成功响应

```json
{
  "type": "success",
  "project": {
    /* 完整工程 JSON (UndoableState) */
  }
}
```

### 错误响应

```json
{
  "type": "error",
  "error": "错误信息"
}
```

### 示例

#### 最简请求 — 只传 URL

```json
{
  "videos": [
    {"remoteUrl": "https://resource.opencreator.io/remotion/video1.mp4"},
    {"remoteUrl": "https://resource.opencreator.io/remotion/video2.mp4"}
  ]
}
```

#### 完整请求 — 指定元数据和画布

```json
{
  "videos": [
    {
      "remoteUrl": "https://resource.opencreator.io/remotion/video1.mp4",
      "filename": "video1.mp4",
      "durationInSeconds": 5.8,
      "width": 704,
      "height": 1280,
      "hasAudioTrack": true,
      "size": 700102,
      "mimeType": "video/mp4",
      "remoteFileKey": "remotion/20260409/default/video1.mp4"
    },
    {
      "remoteUrl": "https://resource.opencreator.io/remotion/video2.mp4"
    }
  ],
  "compositionWidth": 1080,
  "compositionHeight": 1920,
  "fps": 30
}
```

#### 在已有工程基础上追加视频

```json
{
  "videos": [
    {"remoteUrl": "https://resource.opencreator.io/remotion/video3.mp4"}
  ],
  "existingProject": {
    /* 上一次 API 返回的 project 对象 */
  }
}
```

### 常见错误


| 错误信息                                   | 原因                   | 解决方案                   |
| -------------------------------------- | -------------------- | ---------------------- |
| `videos must be a non-empty array`     | `videos` 字段缺失或为空数组   | 确保传入至少一个视频对象           |
| `videos[0].remoteUrl is required`      | 某个视频对象缺少 `remoteUrl` | 每个视频必须有 `remoteUrl` 字段 |
| `Could not determine video dimensions` | 视频 URL 无法访问或格式不支持    | 检查 URL 是否可公开访问         |


---

## 2. 自动字幕 — POST /api/compose/subtitle

自动识别视频中的语音并生成字幕。支持两种输入模式（二选一）：

- **模式 A：传视频 URL** — 自动探测元数据、识别语音、生成带字幕的完整工程
- **模式 B：传已有工程 JSON** — 识别工程中所有非静音视频/音频轨，或通过 `itemIds` 指定要生成字幕的素材

> **⚠️ 行为变更（v2026.05）：** 本接口字幕的**字体 / 字重 / 行高 / 文字颜色 / 描边 / 翻页时长**已固化为统一品牌预设（Montserrat Black + 白字 + #0A0909 描边 8px + 1000ms 翻页）。HTTP body 上**只有 `captionStyle`、`captionPosition`、`options.highlightColor`、`options.letterSpacing` 4 个字段可调**。其他 options 字段（如 `color` / `strokeColor` / `fontSize` 等）即使传入也会被忽略。

### 请求地址

```
POST /api/compose/subtitle
```

### 请求参数


| 字段                | 类型         | 必填     | 说明                                                                 |
| ----------------- | ---------- | ------ | ------------------------------------------------------------------ |
| `videoUrl`        | `string`   | ⚡ 模式 A | 视频 URL，与 `project` 二选一                                             |
| `project`         | `object`   | ⚡ 模式 B | 已有工程 JSON（UndoableState），与 `videoUrl` 二选一                          |
| `itemIds`         | `string[]` | ❌      | 模式 B 可选；只为指定 video/audio item 生成字幕                                 |
| `captionStyle`    | `string`   | ❌      | 字幕样式，默认 `"animated-background"`（与编辑器默认 `"default"` 不同）             |
| `captionPosition` | `string`   | ❌      | 字幕位置，默认 `"bottom"`                                                 |
| `provider`        | `string`   | ❌      | 字幕识别厂商，默认 `"elevenlabs"`                                           |
| `language`        | `string`   | ❌      | 强制识别语言，默认 `"auto"`；中文场景**强烈建议**显式传 `"zh"`，英文场景传 `"en"`             |
| `options`         | `object`   | ❌      | 仅支持 `highlightColor` 和 `letterSpacing` 两个字段，其他字段传了会被忽略，详见下面 options 表 |


#### captionStyle 可选值


| 值                       | 说明                   |
| ----------------------- | -------------------- |
| `"default"`             | 默认样式（白字黑边，逐词高亮）      |
| `"colored-words"`       | 彩色单词样式               |
| `"scaling-words"`       | 缩放单词动画               |
| `"animated-background"` | 带动画背景的高亮块样式（**本接口默认值**） |


#### captionPosition 可选值


| 值          | 说明     | 大致位置（1920px 高画布） |
| ---------- | ------ | ---------------- |
| `"top"`    | 上方     | 距顶部 ~5%          |
| `"center"` | 居中     | 垂直居中             |
| `"bottom"` | 下方（默认） | 距底部 ~5%          |


#### provider 可选值


| 值              | 说明                    |
| -------------- | --------------------- |
| `"elevenlabs"` | ElevenLabs Scribe（默认） |
| `"openai"`     | OpenAI Whisper        |


#### language 可选值


| 值        | 说明                                                                  |
| -------- | ------------------------------------------------------------------- |
| `"auto"` | 自动检测（默认）。识别引擎自己猜语言，准确率最低，可能误判（如中文被识别为日语、英文被识别为印地语）                  |
| `"zh"`   | 强制按中文识别。**中文场景必传**；底层会把 `zh` 映射成 ElevenLabs 的 `zho` 或 Whisper 的 `zh` |
| `"en"`   | 强制按英文识别。英文场景建议传，避免被识别为印地语/马来语等                                      |


#### options 可调字段（仅 2 个）


| 字段                | 类型       | 默认值         | 说明                                                                              |
| ----------------- | -------- | ----------- | ------------------------------------------------------------------------------- |
| `highlightColor`  | `string` | `"#00FF00"` | 当前播放词高亮颜色（animated-background 样式下是高亮块的背景色）。推荐从下方 5 个品牌色挑一个                       |
| `letterSpacing`   | `number` | `-0.2`      | 字距（px，允许负值）。**英文场景**推荐 `-0.2`；**中文场景**推荐 `-10`（中文字符宽度大，需要更紧凑的字距） |


##### 推荐的 highlightColor 品牌色


| 调性  | HEX         | 适用场景            |
| --- | ----------- | --------------- |
| 亮绿色 | `"#00FF00"` | 默认；活力、科技、户外     |
| 淡粉色 | `"#FFB6C1"` | 美妆、生活、轻量内容      |
| 明黄色 | `"#FFFF00"` | 警示、突出、餐饮        |
| 柔紫色 | `"#C9A8FF"` | 时尚、艺术、夜景        |
| 冰蓝色 | `"#7DF9FF"` | 冷淡、科技、海洋        |


#### 已固化（无法通过 API 修改）的字幕样式


以下字段由服务端按品牌预设强制注入，**调用方传值会被忽略**：


| 字段                           | 固化值        | 说明              |
| ---------------------------- | ---------- | --------------- |
| `fontFamily`                 | `Montserrat` | Google Fonts，运行时按需加载 |
| `fontWeight`                 | `"900"`    | Black 字重        |
| `lineHeight`                 | `1.2`      | 行高              |
| `color`                      | `"#FFFFFF"` | 文字颜色            |
| `strokeColor`                | `"#0A0909"` | 描边颜色            |
| `strokeWidth`                | `8`        | 描边宽度（px）        |
| `pageDurationInMilliseconds` | `1000`     | 每页字幕合并窗口（ms）    |
| `fontSize`                   | `80`       | 字号（px，沿用底层默认）   |
| `maxLines`                   | `2`        | 每页最大行数（沿用底层默认）  |


> 如果后续需要调整以上字段，需要改服务端代码（`app/api/compose/subtitle/route.ts` 的 `SUBTITLE_PRESET_OPTIONS`），不是 API 参数。

### 成功响应

```json
{
  "type": "success",
  "project": {
    /* 完整工程 JSON，包含视频轨和字幕轨 */
  }
}
```

### 错误响应

```json
{
  "type": "error",
  "error": "错误信息"
}
```

### 示例

#### 最简调用 — 全走默认

```json
{
  "videoUrl": "https://resource.opencreator.io/remotion/my-video.mp4"
}
```

等价于 `captionStyle=animated-background` + `captionPosition=bottom` + `highlightColor=#00FF00` + `letterSpacing=-0.2`，适合英文视频。

#### 英文场景 — 推荐写法

```json
{
  "videoUrl": "https://resource.opencreator.io/remotion/my-video.mp4",
  "language": "en",
  "options": {
    "highlightColor": "#00FF00",
    "letterSpacing": -0.2
  }
}
```

#### 中文场景 — 必须显式传 language + letterSpacing

```json
{
  "videoUrl": "https://resource.opencreator.io/remotion/my-video.mp4",
  "language": "zh",
  "options": {
    "highlightColor": "#C9A8FF",
    "letterSpacing": -10
  }
}
```

> 中文场景**强烈建议**显式传 `"language": "zh"`，这会同时提升识别准确率并触发后端的繁→简转换更稳。中文场景仍使用 `Montserrat`（拉丁字体）作为 fontFamily，浏览器/Remotion 会用系统字体回退渲染中文字形。如发现中文渲染效果不佳，请反馈以便后续支持中文字体切换。

#### 换字幕样式 / 改字幕位置

```json
{
  "videoUrl": "https://resource.opencreator.io/remotion/my-video.mp4",
  "captionStyle": "colored-words",
  "captionPosition": "top",
  "options": {
    "highlightColor": "#FFFF00",
    "letterSpacing": -0.2
  }
}
```

#### 模式 B — 传已有工程 JSON

```json
{
  "project": {
    "tracks": [...],
    "items": {...},
    "assets": {...},
    "fps": 30,
    "compositionWidth": 1080,
    "compositionHeight": 1920,
    "deletedAssets": []
  },
  "itemIds": ["video-item-1", "audio-item-2"],
  "captionStyle": "animated-background",
  "captionPosition": "bottom",
  "provider": "elevenlabs",
  "options": {
    "highlightColor": "#7DF9FF",
    "letterSpacing": -0.2
  }
}
```

> **注意：** 如果 API 返回结果外层有 `type: "success"` 包裹，实际工程在 `project` 字段中。你可以直接传 `response.project` 作为 `project` 参数。`itemIds` 可从 `/api/compose/project/summary` 返回的 `summary.items[].itemId` 获取。

### 行为说明

- **样式固化**：所有除 `highlightColor` / `letterSpacing` 之外的外观字段由服务端 `SUBTITLE_PRESET_OPTIONS` 强制注入，调用方无法通过 API 修改。如需切换品牌风格，请联系后端。
- **captionStyle 默认值差异**：本接口默认 `animated-background`（带高亮块），与编辑器内 `default` 样式不同；如需还原编辑器默认样式可显式传 `captionStyle: "default"`。
- **字幕文本后处理**（无需调用方关心）：识别引擎返回的原始字幕在落库前会经过以下统一清洗：
  1. **繁体 → 简体**：使用 OpenCC 把所有汉字统一转为简体（厂商无法保证简体输出，因此用后处理保底）
  2. **过滤 emoji 和标点**：去掉所有 emoji、零宽字符、控制字符、中英文标点符号（包括句号、逗号、引号、省略号等）
  3. **保留**：字母、数字、汉字、空格、`-` `_` `/`
  4. **丢弃空 token**：清洗后文本为空的 token（如纯标点 / 纯 emoji）会被整条丢弃，不会出现在最终字幕中
- **模式 B 的智能逻辑：**
  - 自动跳过 **静音轨道**（`track.muted === true`）上的素材
  - 如果传入 `itemIds`，只处理这些指定 item；指定 item 必须是 `video` 或 `audio`
  - 自动跳过没有音频轨的纯视频（如纯图片序列）
  - 为每个视频/音频片段 **单独生成字幕**，不会跨片段
  - 对被裁剪过的 item，会按 `videoStartFromInSeconds` / `audioStartFromInSeconds` 修正字幕时间
  - 如果某个片段没有识别到语音（如纯背景音乐），则不生成该片段的字幕
  - 字幕轨始终放在最顶层（前景），确保不被视频遮挡
- **字体加载**：`Montserrat` 由 Lambda 渲染时通过 `@remotion/google-fonts` 从 CDN 按需拉取，不需要预先 bundle 到 site 中。本接口的样式更新**无需重新部署 Lambda site**。

### 常见错误


| 错误信息                                                 | 原因                         | 解决方案                                                      |
| ---------------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| `请提供 videoUrl 或 project，二选一`                         | 两个参数都没传                    | 传入 `videoUrl` 或 `project`                                 |
| `ELEVENLABS_API_KEY is not configured on the server` | 默认 ElevenLabs 识别缺少 API Key | 在 `.env` 中设置 `ELEVENLABS_API_KEY`，或传 `provider: "openai"` |
| `OPENAI_API_KEY is not configured on the server`     | 使用 OpenAI 识别时缺少 API Key    | 在 `.env` 中设置 `OPENAI_API_KEY`                             |
| `工程中没有找到视频或音频资源，无法生成字幕`                              | 工程中没有可处理的媒体                | 确保工程中有视频或音频素材且未全部静音                                       |
| `未识别到任何语音内容`                                         | 字幕识别服务未识别到语音               | 视频中可能没有人声或语音不清晰                                           |


---

## 3. 视频叠加 — POST /api/compose/overlay

在已有工程的指定时间点叠加一个视频画中画，居中显示在画布上方。

### 请求地址

```
POST /api/compose/overlay
```

### 请求参数


| 字段                  | 类型           | 必填  | 说明                                        |
| ------------------- | ------------ | --- | ----------------------------------------- |
| `videoUrl`          | `string`     | ✅   | 叠加视频的远程 URL                               |
| `startMs`           | `number`     | ✅   | 叠加视频出现的时间点（毫秒），如 `2000` 表示第 2 秒开始出现       |
| `project`           | `object`     | ❌   | 已有工程 JSON，不传则以叠加视频本身新建工程                  |
| `scale`             | `number`     | ❌   | 叠加视频相对画布的缩放比例，范围 `(0, 1]`，默认 `0.8`（即 80%） |
| `video`             | `VideoInput` | ❌   | 叠加视频的元数据（同拼接接口的 VideoInput），不传则自动探测       |
| `left`              | `number`     | ❌   | 叠加视频左上角 X 坐标（px）                          |
| `top`               | `number`     | ❌   | 叠加视频左上角 Y 坐标（px）                          |
| `width`             | `number`     | ❌   | 叠加视频宽度（px），需与 `height` 同时提供               |
| `height`            | `number`     | ❌   | 叠加视频高度（px），需与 `width` 同时提供                |
| `muted`             | `boolean`    | ❌   | 叠加视频所在轨道是否静音，默认 `true`                    |
| `decibelAdjustment` | `number`     | ❌   | 叠加视频音量调整（dB），默认 `0`                       |
| `durationMs`        | `number`     | ❌   | 叠加片段持续时间（ms），不传则使用素材剩余时长                  |
| `sourceStartMs`     | `number`     | ❌   | 叠加视频从素材内部第几毫秒开始播放                         |
| `borderRadius`      | `number`     | ❌   | 叠加视频圆角（px），默认 `0`                         |
| `fadeInMs`          | `number`     | ❌   | 画面淡入毫秒数，默认 `0`                            |
| `fadeOutMs`         | `number`     | ❌   | 画面淡出毫秒数，默认 `0`                            |


### 成功响应

```json
{
  "type": "success",
  "project": {
    /* 更新后的工程 JSON */
  }
}
```

### 错误响应

```json
{
  "type": "error",
  "error": "错误信息"
}
```

### 示例

#### 在已有工程第 2 秒处叠加视频

```json
{
  "project": {
    /* 拼接/字幕 API 返回的 project */
  },
  "videoUrl": "https://resource.opencreator.io/remotion/overlay.mp4",
  "startMs": 2000
}
```

#### 自定义缩放比例（60%）

```json
{
  "project": {
    /* 已有工程 */
  },
  "videoUrl": "https://resource.opencreator.io/remotion/overlay.mp4",
  "startMs": 5000,
  "scale": 0.6
}
```

#### 不传工程 — 以叠加视频本身创建新工程

```json
{
  "videoUrl": "https://resource.opencreator.io/remotion/overlay.mp4",
  "startMs": 0
}
```

### 行为说明

- 叠加视频会作为一个 **新轨道** 添加到工程最顶层（前景），确保显示在底层视频上方
- 如果传入 `width` + `height`，使用指定尺寸；否则按 `scale` 比例缩放并保持原始宽高比
- 如果传入 `left` / `top`，使用指定位置；否则在画布上居中
- `startMs` 换算为帧数：`fromFrame = Math.round((startMs / 1000) * fps)`
- 叠加视频默认静音；如需保留声音，传 `muted: false`
- 可通过 `sourceStartMs` 和 `durationMs` 做素材内部裁剪
- 如果需要多次叠加，可以多次调用此接口，每次传入上一次返回的 `project`

### 常见错误


| 错误信息                  | 原因          | 解决方案               |
| --------------------- | ----------- | ------------------ |
| `videoUrl 是必填参数`      | 没有传叠加视频 URL | 提供 `videoUrl`      |
| `startMs 是必填参数（毫秒数）`  | 没有传开始时间     | 提供 `startMs`（数字类型） |
| `startMs 不能小于 0`      | 开始时间为负数     | 传入 >= 0 的值         |
| `scale 必须在 (0, 1] 之间` | 缩放超出范围      | 使用 0.1 ~ 1 之间的值    |


---

## 4. 剪辑编辑 API

以下接口都遵循同一个模式：传入完整 `project`，返回更新后的 `project` 或结构化摘要。时间输入统一使用毫秒，服务端内部会根据 `project.fps` 转换为帧。

### 4.1 工程摘要 — POST /api/compose/project/summary

将完整工程 JSON 转为适合第三方或 agent 阅读的时间线摘要。

#### 请求参数


| 字段        | 类型       | 必填  | 说明                       |
| --------- | -------- | --- | ------------------------ |
| `project` | `object` | ✅   | 完整工程 JSON（UndoableState） |


#### 成功响应

```json
{
  "type": "success",
  "summary": {
    "compositionWidth": 1080,
    "compositionHeight": 1920,
    "fps": 30,
    "durationInFrames": 300,
    "durationInSeconds": 10,
    "tracks": [
      {
        "trackId": "track1",
        "muted": false,
        "hidden": false,
        "itemIds": ["item1"]
      }
    ],
    "items": [
      {
        "itemId": "item1",
        "type": "video",
        "trackId": "track1",
        "assetId": "asset1",
        "fromMs": 0,
        "durationMs": 10000,
        "sourceStartMs": 0,
        "remoteUrl": "https://example.com/video.mp4",
        "decibelAdjustment": 0
      }
    ],
    "warnings": []
  }
}
```

### 4.2 元素编辑 — POST /api/compose/item/edit

修改已有 item 的时间线位置、持续时间、素材内部起点、音量和淡入淡出。

#### 请求参数


| 字段        | 类型       | 必填  | 说明                           |
| --------- | -------- | --- | ---------------------------- |
| `project` | `object` | ✅   | 完整工程 JSON                    |
| `itemId`  | `string` | ✅   | 要编辑的 item ID，可从 summary 接口获取 |
| `patch`   | `object` | ✅   | 要修改的字段                       |


#### patch 可选字段


| 字段                  | 类型       | 说明                                 |
| ------------------- | -------- | ---------------------------------- |
| `fromMs`            | `number` | item 在时间线上的起始时间                    |
| `durationMs`        | `number` | item 在时间线上的持续时间                    |
| `sourceStartMs`     | `number` | 素材内部起点，video/audio/gif/captions 支持 |
| `decibelAdjustment` | `number` | 音量调整（dB），video/audio 支持            |
| `audioFadeInMs`     | `number` | 音频淡入毫秒数，video/audio 支持             |
| `audioFadeOutMs`    | `number` | 音频淡出毫秒数，video/audio 支持             |
| `fadeInMs`          | `number` | 画面淡入毫秒数，支持有画面淡入字段的 item            |
| `fadeOutMs`         | `number` | 画面淡出毫秒数，支持有画面淡出字段的 item            |


#### 示例

```json
{
  "project": {"...": "..."},
  "itemId": "item1",
  "patch": {
    "sourceStartMs": 1200,
    "durationMs": 3200,
    "decibelAdjustment": -6,
    "audioFadeOutMs": 500
  }
}
```

### 4.3 添加音频 — POST /api/compose/audio/add

向工程添加 BGM 或旁白音频轨。

#### 请求参数


| 字段                  | 类型                                 | 必填  | 说明                  |
| ------------------- | ---------------------------------- | --- | ------------------- |
| `project`           | `object`                           | ✅   | 完整工程 JSON           |
| `audioUrl`          | `string`                           | ✅   | 音频远程 URL            |
| `startMs`           | `number`                           | ❌   | 音频在时间线上的开始时间，默认 `0` |
| `sourceStartMs`     | `number`                           | ❌   | 音频素材内部起点，默认 `0`     |
| `durationMs`        | `number | "auto_project_duration"` | ❌   | 持续时间；默认自动截断到工程剩余时长  |
| `decibelAdjustment` | `number`                           | ❌   | 音量调整，默认 `-15`       |
| `fadeInMs`          | `number`                           | ❌   | 淡入毫秒数，默认 `500`      |
| `fadeOutMs`         | `number`                           | ❌   | 淡出毫秒数，默认 `1500`     |


> 音频文件名、时长、大小和 MIME 类型会通过 `audioUrl` 自动探测，不需要在请求中传入。

### 4.4 工程校验 — POST /api/compose/project/validate

渲染前检查工程结构是否完整。

#### 请求参数


| 字段        | 类型       | 必填  | 说明        |
| --------- | -------- | --- | --------- |
| `project` | `object` | ✅   | 完整工程 JSON |


#### 成功响应

```json
{
  "type": "success",
  "valid": true,
  "issues": []
}
```

`issues[].severity` 为 `"error"` 或 `"warning"`。常见校验包括缺失 item、缺失 asset、缺失 `remoteUrl`、持续时间非法、素材内部起点超过素材时长等。

---

## 5. 视频渲染 — POST /api/render + POST /api/progress

将工程 JSON 渲染为最终视频文件。分为两步：**启动渲染** → **轮询进度**。

### 5.1 启动渲染 — POST /api/render

#### 请求地址

```
POST /api/render
```

#### 请求参数


| 字段                  | 类型       | 必填  | 说明                                    |
| ------------------- | -------- | --- | ------------------------------------- |
| `compositionWidth`  | `number` | ✅   | 画布宽度                                  |
| `compositionHeight` | `number` | ✅   | 画布高度                                  |
| `tracks`            | `array`  | ✅   | 轨道数组                                  |
| `items`             | `object` | ✅   | 元素字典（key: item ID）                    |
| `assets`            | `object` | ✅   | 资源字典（key: asset ID）                   |
| `codec`             | `string` | ❌   | 编码格式：仅支持 `"h264"`（MP4）；不传时默认 `"h264"` |


> **提示：** 这些字段全部来自上面 concat/subtitle API 返回的 `project` 对象，直接展开即可。

#### 成功响应

```json
{
  "type": "success",
  "bucketName": "remotionlambda-xxxxx",
  "renderId": "xxxxxxxx"
}
```

#### 错误响应

```json
{
  "type": "error",
  "error": "错误信息"
}
```

#### 示例

```json
{
  "compositionWidth": 1080,
  "compositionHeight": 1920,
  "tracks": [
    {
      "id": "track1",
      "items": ["item1", "item2"],
      "hidden": false,
      "muted": false
    }
  ],
  "items": {
    "item1": {
      "id": "item1",
      "type": "video",
      "from": 0,
      "durationInFrames": 174,
      "assetId": "asset1",
      "...": "..."
    },
    "item2": {
      "id": "item2",
      "type": "video",
      "from": 174,
      "durationInFrames": 302,
      "assetId": "asset2",
      "...": "..."
    }
  },
  "assets": {
    "asset1": {
      "id": "asset1",
      "type": "video",
      "remoteUrl": "https://resource.opencreator.io/video1.mp4",
      "...": "..."
    },
    "asset2": {
      "id": "asset2",
      "type": "video",
      "remoteUrl": "https://resource.opencreator.io/video2.mp4",
      "...": "..."
    }
  }
}
```

> **快捷写法：** 如果你从 concat/subtitle API 拿到 `result`，可以这样构造 render 参数：
>
> ```javascript
> const project = result.project;
> const renderBody = {
>   ...project, // 展开 tracks, items, assets, compositionWidth, compositionHeight
>   codec: 'h264', // 可选；不传也会默认导出 MP4
> };
> // 注意去掉 fps 和 deletedAssets（render API 不需要）
> ```

---

### 5.2 查询进度 — POST /api/progress

拿到 `renderId` 后，轮询此接口获取渲染进度。

#### 请求地址

```
POST /api/progress
```

#### 请求参数


| 字段           | 类型       | 必填  | 说明                                |
| ------------ | -------- | --- | --------------------------------- |
| `bucketName` | `string` | ✅   | 来自 `/api/render` 返回的 `bucketName` |
| `renderId`   | `string` | ✅   | 来自 `/api/render` 返回的 `renderId`   |


#### 响应格式

**渲染中：**

```json
{
  "type": "in-progress",
  "overallProgress": 0.45,
  "costs": {
    "price": 0.008,
    "displayCost": "$0.008",
    "currency": "USD",
    "disclaimer": "Estimated cost for function invocations only...",
    "estimatedBillingDurationInMs": 200000
  }
}
```

**渲染完成：**

```json
{
  "type": "done",
  "outputFile": "https://resource.opencreator.io/renders/xxxxxxxx/out.mp4",
  "outputSizeInBytes": 24340246,
  "outputName": "editor-export.mp4",
  "costs": {
    "price": 0.013,
    "displayCost": "$0.013",
    "currency": "USD",
    "disclaimer": "Estimated cost for function invocations only. Does not include S3 storage.",
    "estimatedBillingDurationInMs": 340706
  }
}
```

**渲染失败：**

```json
{
  "type": "error",
  "error": "错误信息"
}
```

#### costs 对象


| 字段                             | 类型       | 说明                           |
| ------------------------------ | -------- | ---------------------------- |
| `price`                        | `number` | 实际 USD 金额（float），如 `0.013`   |
| `displayCost`                  | `string` | 格式化显示，如 `"$0.013"`           |
| `currency`                     | `string` | 货币类型，固定 `"USD"`              |
| `disclaimer`                   | `string` | 费用说明（仅 Lambda 计算费用，不含 S3 存储） |
| `estimatedBillingDurationInMs` | `number` | 预估 Lambda 总计费时长（毫秒）          |


#### 轮询示例（JavaScript）

```javascript
async function waitForRender(bucketName, renderId) {
  while (true) {
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({bucketName, renderId}),
    });
    const data = await res.json();

    if (data.type === 'done') {
      console.log('视频地址:', data.outputFile);
      console.log('文件大小:', data.outputSizeInBytes, 'bytes');
      console.log('渲染费用:', data.costs?.displayCost);
      return data;
    }

    if (data.type === 'error') {
      throw new Error(data.error);
    }

    console.log('进度:', Math.round(data.overallProgress * 100) + '%');
    await new Promise((r) => setTimeout(r, 1500)); // 每 1.5 秒轮询一次
  }
}
```

### 常见错误


| 错误信息                                | 原因              | 解决方案                                          |
| ----------------------------------- | --------------- | --------------------------------------------- |
| `compositionHeight is not a number` | 缺少画布尺寸          | 确保传入 `compositionWidth` 和 `compositionHeight` |
| `tracks is not an array`            | `tracks` 不是数组   | 检查传入的工程 JSON 结构                               |
| `codec must be "h264"`              | 编码格式错误          | 只支持 `"h264"`（MP4），或不传 `codec` 使用默认值           |
| `bucketName is not set`             | progress 请求缺少参数 | 传入 render 返回的 `bucketName` 和 `renderId`       |


---

## 附录 A: 视频探测 — POST /api/compose/probe

通过 URL 探测视频的元数据信息。

### 请求地址

```
POST /api/compose/probe
```

### 请求参数


| 字段    | 类型       | 必填  | 说明        |
| ----- | -------- | --- | --------- |
| `url` | `string` | ✅   | 视频的远程 URL |


### 成功响应

```json
{
  "type": "success",
  "durationInSeconds": 5.8,
  "width": 704,
  "height": 1280,
  "hasAudioTrack": true,
  "fps": 30,
  "mimeType": "video/mp4",
  "size": 700102,
  "name": "video1.mp4"
}
```

---

## 附录 B: 工程 JSON 结构概览

所有 compose API 返回的 `project` 都是 `UndoableState` 类型：

```javascript
{
  "tracks": [                     // 轨道数组，索引越小 = 层级越高（前景）
    {
      "id": "trackId",
      "items": ["itemId1", ...],  // 该轨道包含的元素 ID 列表
      "hidden": false,            // 是否隐藏
      "muted": false              // 是否静音
    }
  ],
  "items": {                      // 元素字典
    "itemId1": {
      "id": "itemId1",
      "type": "video",            // video | audio | captions | text | image | solid | gif
      "from": 0,                  // 起始帧
      "durationInFrames": 174,    // 持续帧数
      "assetId": "assetId1",      // 关联的资源 ID
      // ... 其他属性（位置、大小、透明度等）
    }
  },
  "assets": {                     // 资源字典
    "assetId1": {
      "id": "assetId1",
      "type": "video",            // video | audio | caption | image | gif
      "remoteUrl": "https://...", // 远程访问地址
      "remoteFileKey": "...",     // S3 文件 Key
      "durationInSeconds": 5.8,
      "width": 704,
      "height": 1280,
      // ... 其他元数据
    }
  },
  "fps": 30,                      // 帧率
  "compositionWidth": 1080,       // 画布宽度
  "compositionHeight": 1920,      // 画布高度
  "deletedAssets": []
}
```

---

## 附录 C: 典型工作流

### 流程 1：拼接视频 → 生成字幕 → 渲染

```
Step 1:  POST /api/compose/concat   →  拿到 project_v1
Step 2:  POST /api/compose/project/summary → 查看 itemId 和时间线
Step 3:  POST /api/compose/item/edit → 精剪片段（可选）
Step 4:  POST /api/compose/audio/add → 加 BGM（可选）
Step 5:  POST /api/compose/subtitle →  把 project 传入，拿到含字幕工程
Step 6:  POST /api/render           →  把 project 传入，拿到 renderId（默认 MP4）
Step 7:  POST /api/progress (轮询)  →  拿到最终视频 URL + 费用
```

```javascript
// Step 1: 拼接
const concatRes = await fetch('/api/compose/concat', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    videos: [
      {remoteUrl: 'https://resource.opencreator.io/video1.mp4'},
      {remoteUrl: 'https://resource.opencreator.io/video2.mp4'},
    ],
  }),
});
const {project: projectV1} = await concatRes.json();

// Step 2: 加字幕
const subtitleRes = await fetch('/api/compose/subtitle', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    project: projectV1,
    captionPosition: 'bottom',
  }),
});
const {project: projectV2} = await subtitleRes.json();

// Step 3: 渲染
const renderRes = await fetch('/api/render', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    compositionWidth: projectV2.compositionWidth,
    compositionHeight: projectV2.compositionHeight,
    tracks: projectV2.tracks,
    items: projectV2.items,
    assets: projectV2.assets,
    codec: 'h264', // 可选；不传也会默认导出 MP4
  }),
});
const {bucketName, renderId} = await renderRes.json();

// Step 4: 轮询进度
const result = await waitForRender(bucketName, renderId);
console.log('最终视频:', result.outputFile);
console.log('渲染费用:', result.costs?.price, 'USD');
```

### 流程 2：单视频直接加字幕 → 渲染

```
Step 1:  POST /api/compose/subtitle (传 videoUrl)  →  拿到 project
Step 2:  POST /api/render                          →  渲染
Step 3:  POST /api/progress (轮询)                 →  拿到视频
```

### 流程 3：拼接视频 → 叠加画中画 → 加字幕 → 渲染

```
Step 1:  POST /api/compose/concat    →  拿到 project_v1（主视频拼接）
Step 2:  POST /api/compose/overlay   →  传入 project_v1 + 叠加视频 URL + startMs，拿到 project_v2
Step 3:  POST /api/compose/subtitle  →  传入 project_v2，拿到 project_v3（含字幕）
Step 4:  POST /api/render            →  渲染
Step 5:  POST /api/progress (轮询)   →  拿到最终视频
```

---

## 附录 D: 错误处理

所有接口错误时都返回统一格式：

```json
{
  "type": "error",
  "error": "具体错误描述"
}
```

HTTP 状态码：

- `200` — 成功（包括 `type: "success"` 的响应）
- `400` — 请求参数错误
- `500` — 服务端内部错误

### 建议的错误处理模式

```javascript
async function callApi(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (data.type === 'error') {
    throw new Error(`API 错误 [${url}]: ${data.error}`);
  }

  return data;
}
```

### 超时与重试建议


| 接口                      | 预计耗时                     | 建议超时             |
| ----------------------- | ------------------------ | ---------------- |
| `/api/compose/concat`   | 2-10 秒（取决于视频数量和探测）       | 30 秒             |
| `/api/compose/subtitle` | 10-60 秒（取决于视频时长和字幕识别耗时）  | 120 秒            |
| `/api/render`           | 1-3 秒（仅启动任务）             | 10 秒             |
| `/api/progress`         | 即时返回                     | 10 秒（轮询间隔 1-2 秒） |
| 渲染总时长                   | 30 秒 - 5 分钟（取决于视频时长和复杂度） | —                |


