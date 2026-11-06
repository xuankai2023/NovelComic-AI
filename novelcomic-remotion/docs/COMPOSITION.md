# 工程 JSON 字段说明 (Composition JSON Schema)

本文档描述 OpenCreator Remotion 编辑器工程文件（`UndoableState`）的完整数据结构。Agent 在修改工程 JSON 时应严格遵循此 schema。

API 使用方法请参见 [api_docs.md](./api_docs.md)。

---

## 顶层结构 (UndoableState)

源码：`src/editor/state/types.ts`

| 字段                | 类型                    | 默认值 | 说明                                      |
| ------------------- | ----------------------- | ------ | ----------------------------------------- |
| `tracks`            | `TrackType[]`           | `[]`   | 轨道列表。**索引越小 = 层级越高（前景）** |
| `items`             | `Record<string, Item>`  | `{}`   | 元素字典，key 为 item `id`                |
| `assets`            | `Record<string, Asset>` | `{}`   | 资源字典，key 为 asset `id`               |
| `fps`               | `number`                | `30`   | 帧率                                      |
| `compositionWidth`  | `number`                | `1080` | 画布宽度（px）                            |
| `compositionHeight` | `number`                | `1920` | 画布高度（px）                            |
| `deletedAssets`     | `DeletedAsset[]`        | `[]`   | 已删除资源记录                            |

**关键约束：**

- `tracks[].items` 中存储的是 item 的 `id` 引用
- item 通过 `assetId` 关联到 `assets` 中的资源
- 帧数换算：`帧数 = 秒数 × fps`（如 5 秒 × 30fps = 150 帧）

---

## Track 轨道

源码：`src/editor/state/types.ts`

| 字段     | 类型       | 说明                         |
| -------- | ---------- | ---------------------------- |
| `id`     | `string`   | 轨道唯一 ID                  |
| `items`  | `string[]` | 该轨道包含的 item ID 列表    |
| `hidden` | `boolean`  | 是否隐藏（隐藏后不渲染画面） |
| `muted`  | `boolean`  | 是否静音（静音后不播放音频） |

> tracks 数组中 **索引 0 = 最上层**。字幕轨通常在索引 0，视频轨在最后。

---

## Item 元素

共 7 种类型：`video` | `audio` | `image` | `text` | `captions` | `solid` | `gif`

### 公共字段 (BaseItem)

源码：`src/editor/items/shared.ts`，所有 item 类型都包含：

| 字段                   | 类型      | 说明                                 |
| ---------------------- | --------- | ------------------------------------ |
| `id`                   | `string`  | 唯一标识                             |
| `type`                 | `string`  | 类型标识（见各子类型）               |
| `from`                 | `number`  | 起始帧                               |
| `durationInFrames`     | `number`  | 持续帧数                             |
| `top`                  | `number`  | Y 坐标（px）                         |
| `left`                 | `number`  | X 坐标（px）                         |
| `width`                | `number`  | 宽度（px）                           |
| `height`               | `number`  | 高度（px）                           |
| `opacity`              | `number`  | 不透明度（0~1）                      |
| `isDraggingInTimeline` | `boolean` | 拖拽状态标记，API 构建时固定 `false` |

### Mixin 扩展字段

部分 item 类型复用以下字段组：

| Mixin 名            | 字段           | 类型     | 说明           | 适用类型                                 |
| ------------------- | -------------- | -------- | -------------- | ---------------------------------------- |
| CanHaveRotation     | `rotation`     | `number` | 旋转角度（°）  | text, image, video, solid, gif, captions |
| CanHaveBorderRadius | `borderRadius` | `number` | 圆角半径（px） | image, video, solid, gif                 |
| CanHaveCrop         | `cropLeft`     | `number` | 左裁切（0~1）  | image, video, gif                        |
|                     | `cropTop`      | `number` | 上裁切（0~1）  |                                          |
|                     | `cropRight`    | `number` | 右裁切（0~1）  |                                          |
|                     | `cropBottom`   | `number` | 下裁切（0~1）  |                                          |

---

### video 视频

源码：`src/editor/items/video/video-item-type.ts`

继承：BaseItem + CanHaveRotation + CanHaveBorderRadius + CanHaveCrop

| 字段                            | 类型      | 默认值 | 说明                               |
| ------------------------------- | --------- | ------ | ---------------------------------- |
| `type`                          | `'video'` | —      | 类型标识                           |
| `assetId`                       | `string`  | —      | 关联的 video asset ID              |
| `videoStartFromInSeconds`       | `number`  | `0`    | 视频源起始偏移（秒），用于截取片段 |
| `decibelAdjustment`             | `number`  | `0`    | 音量调整（dB，0 = 原始）           |
| `playbackRate`                  | `number`  | `1`    | 播放倍速                           |
| `audioFadeInDurationInSeconds`  | `number`  | `0`    | 音频淡入（秒）                     |
| `audioFadeOutDurationInSeconds` | `number`  | `0`    | 音频淡出（秒）                     |
| `fadeInDurationInSeconds`       | `number`  | `0`    | 画面淡入（秒）                     |
| `fadeOutDurationInSeconds`      | `number`  | `0`    | 画面淡出（秒）                     |
| `keepAspectRatio`               | `boolean` | `true` | 是否锁定宽高比                     |

### audio 音频

源码：`src/editor/items/audio/audio-item-type.ts`

继承：BaseItem（无 rotation / borderRadius / crop）

| 字段                            | 类型      | 默认值 | 说明                  |
| ------------------------------- | --------- | ------ | --------------------- |
| `type`                          | `'audio'` | —      | 类型标识              |
| `assetId`                       | `string`  | —      | 关联的 audio asset ID |
| `audioStartFromInSeconds`       | `number`  | `0`    | 音频源起始偏移（秒）  |
| `decibelAdjustment`             | `number`  | `0`    | 音量调整（dB）        |
| `playbackRate`                  | `number`  | `1`    | 播放倍速              |
| `audioFadeInDurationInSeconds`  | `number`  | `0`    | 淡入（秒）            |
| `audioFadeOutDurationInSeconds` | `number`  | `0`    | 淡出（秒）            |

### image 图片

源码：`src/editor/items/image/image-item-type.ts`

继承：BaseItem + CanHaveRotation + CanHaveBorderRadius + CanHaveCrop

| 字段                       | 类型      | 默认值 | 说明                  |
| -------------------------- | --------- | ------ | --------------------- |
| `type`                     | `'image'` | —      | 类型标识              |
| `assetId`                  | `string`  | —      | 关联的 image asset ID |
| `keepAspectRatio`          | `boolean` | `true` | 是否锁定宽高比        |
| `fadeInDurationInSeconds`  | `number`  | `0`    | 淡入（秒）            |
| `fadeOutDurationInSeconds` | `number`  | `0`    | 淡出（秒）            |

### text 文本

源码：`src/editor/items/text/text-item-type.ts`

继承：BaseItem + CanHaveRotation

| 字段                       | 类型                            | 默认值    | 说明                                            |
| -------------------------- | ------------------------------- | --------- | ----------------------------------------------- |
| `type`                     | `'text'`                        | —         | 类型标识                                        |
| `text`                     | `string`                        | —         | 文本内容                                        |
| `color`                    | `string`                        | —         | 文本颜色（CSS 值）                              |
| `align`                    | `'left' \| 'center' \| 'right'` | —         | 对齐方式                                        |
| `fontFamily`               | `string`                        | —         | 字体名称                                        |
| `fontStyle`                | `{variant, weight}`             | —         | 字体样式，如 `{variant:'normal', weight:'700'}` |
| `fontSize`                 | `number`                        | —         | 字体大小（px）                                  |
| `lineHeight`               | `number`                        | —         | 行高倍数                                        |
| `letterSpacing`            | `number`                        | `0`       | 字间距（px）                                    |
| `direction`                | `'ltr' \| 'rtl'`                | `'ltr'`   | 文本方向                                        |
| `resizeOnEdit`             | `boolean`                       | `true`    | 编辑时自动调整大小                              |
| `strokeWidth`              | `number`                        | `0`       | 描边宽度（px，0 = 无）                          |
| `strokeColor`              | `string`                        | `'black'` | 描边颜色                                        |
| `fadeInDurationInSeconds`  | `number`                        | `0`       | 淡入（秒）                                      |
| `fadeOutDurationInSeconds` | `number`                        | `0`       | 淡出（秒）                                      |
| `background`               | `TextItemBackground \| null`    | `null`    | 文本背景                                        |

**TextItemBackground：**

| 字段                | 类型     | 说明             |
| ------------------- | -------- | ---------------- |
| `color`             | `string` | 背景色           |
| `horizontalPadding` | `number` | 水平内边距（px） |
| `borderRadius`      | `number` | 背景圆角（px）   |

### captions 字幕

源码：`src/editor/items/captions/captions-item-type.ts`

继承：BaseItem + CanHaveRotation

| 字段                         | 类型                            | 默认值                             | 说明                     |
| ---------------------------- | ------------------------------- | ---------------------------------- | ------------------------ |
| `type`                       | `'captions'`                    | —                                  | 类型标识                 |
| `assetId`                    | `string`                        | —                                  | 关联的 caption asset ID  |
| `captionStyle`               | `CaptionStyleType`              | `'default'`                        | 字幕动画风格，见下方枚举 |
| `fontFamily`                 | `string`                        | `'TikTok Sans'`                    | 字体                     |
| `fontStyle`                  | `{variant, weight}`             | `{variant:'normal', weight:'600'}` | 字体样式                 |
| `fontSize`                   | `number`                        | `80`                               | 字号（px）               |
| `lineHeight`                 | `number`                        | `1.2`                              | 行高倍数                 |
| `letterSpacing`              | `number`                        | `0`                                | 字间距（px）             |
| `align`                      | `'left' \| 'center' \| 'right'` | `'center'`                         | 对齐                     |
| `color`                      | `string`                        | `'white'`                          | 文字颜色                 |
| `highlightColor`             | `string`                        | `'#39E508'`                        | 当前播放词高亮色         |
| `strokeWidth`                | `number`                        | `4`                                | 描边宽度（px）           |
| `strokeColor`                | `string`                        | `'black'`                          | 描边颜色                 |
| `direction`                  | `'ltr' \| 'rtl'`                | `'ltr'`                            | 文本方向                 |
| `pageDurationInMilliseconds` | `number`                        | `2000`                             | 每页字幕显示时长（ms）   |
| `captionStartInSeconds`      | `number`                        | `0`                                | 字幕起始时间偏移（秒）   |
| `maxLines`                   | `number`                        | `2`                                | 最大显示行数             |
| `fadeInDurationInSeconds`    | `number`                        | `0`                                | 淡入（秒）               |
| `fadeOutDurationInSeconds`   | `number`                        | `0`                                | 淡出（秒）               |

**CaptionStyleType 枚举：**

| 值                      | 说明                       |
| ----------------------- | -------------------------- |
| `'default'`             | 默认（白字黑边，逐词高亮） |
| `'colored-words'`       | 彩色单词                   |
| `'scaling-words'`       | 缩放单词动画               |
| `'animated-background'` | 带动画背景                 |

### solid 色块

源码：`src/editor/items/solid/solid-item-type.ts`

继承：BaseItem + CanHaveRotation + CanHaveBorderRadius

| 字段                       | 类型      | 默认值  | 说明               |
| -------------------------- | --------- | ------- | ------------------ |
| `type`                     | `'solid'` | —       | 类型标识           |
| `color`                    | `string`  | —       | 填充颜色（CSS 值） |
| `keepAspectRatio`          | `boolean` | `false` | 是否锁定宽高比     |
| `fadeInDurationInSeconds`  | `number`  | `0`     | 淡入（秒）         |
| `fadeOutDurationInSeconds` | `number`  | `0`     | 淡出（秒）         |

### gif 动图

源码：`src/editor/items/gif/gif-item-type.ts`

继承：BaseItem + CanHaveRotation + CanHaveBorderRadius + CanHaveCrop

| 字段                       | 类型      | 默认值 | 说明                |
| -------------------------- | --------- | ------ | ------------------- |
| `type`                     | `'gif'`   | —      | 类型标识            |
| `assetId`                  | `string`  | —      | 关联的 gif asset ID |
| `gifStartFromInSeconds`    | `number`  | `0`    | GIF 起始偏移（秒）  |
| `playbackRate`             | `number`  | `1`    | 播放倍速            |
| `keepAspectRatio`          | `boolean` | `true` | 是否锁定宽高比      |
| `fadeInDurationInSeconds`  | `number`  | `0`    | 淡入（秒）          |
| `fadeOutDurationInSeconds` | `number`  | `0`    | 淡出（秒）          |

---

## Asset 资源

Asset 是媒体文件的元数据，被 item 通过 `assetId` 引用。

### 公共字段 (BaseAsset)

所有 asset 类型共享：

| 字段            | 类型             | 说明                        |
| --------------- | ---------------- | --------------------------- |
| `id`            | `string`         | 唯一标识                    |
| `filename`      | `string`         | 文件名                      |
| `size`          | `number`         | 文件大小（字节）            |
| `mimeType`      | `string`         | MIME 类型，如 `'video/mp4'` |
| `remoteUrl`     | `string \| null` | 远程 URL（CDN / S3）        |
| `remoteFileKey` | `string \| null` | S3 文件 Key                 |

### video 视频资源

| 字段                | 类型      | 说明           |
| ------------------- | --------- | -------------- |
| `type`              | `'video'` | 类型标识       |
| `durationInSeconds` | `number`  | 时长（秒）     |
| `width`             | `number`  | 宽度（px）     |
| `height`            | `number`  | 高度（px）     |
| `hasAudioTrack`     | `boolean` | 是否包含音频轨 |

### audio 音频资源

| 字段                | 类型      | 说明       |
| ------------------- | --------- | ---------- |
| `type`              | `'audio'` | 类型标识   |
| `durationInSeconds` | `number`  | 时长（秒） |

### image 图片资源

| 字段     | 类型      | 说明       |
| -------- | --------- | ---------- |
| `type`   | `'image'` | 类型标识   |
| `width`  | `number`  | 宽度（px） |
| `height` | `number`  | 高度（px） |

### gif 动图资源

| 字段                | 类型     | 说明       |
| ------------------- | -------- | ---------- |
| `type`              | `'gif'`  | 类型标识   |
| `durationInSeconds` | `number` | 时长（秒） |
| `width`             | `number` | 宽度（px） |
| `height`            | `number` | 高度（px） |

### caption 字幕资源

| 字段       | 类型        | 说明         |
| ---------- | ----------- | ------------ |
| `type`     | `'caption'` | 类型标识     |
| `captions` | `Caption[]` | 字幕数据数组 |

**Caption 结构**（来自 `@remotion/captions`）：

| 字段          | 类型             | 说明                     |
| ------------- | ---------------- | ------------------------ |
| `text`        | `string`         | 字幕文本（通常是一个词） |
| `startMs`     | `number`         | 起始时间（ms）           |
| `endMs`       | `number`         | 结束时间（ms）           |
| `timestampMs` | `number \| null` | 时间戳（ms）             |
| `confidence`  | `number \| null` | 识别置信度（0~1）        |

---

## 常用剪辑字段速查

对外 API 建议使用毫秒作为输入单位，工程 JSON 内部仍使用帧和秒。换算方式：

```text
帧数 = 毫秒 / 1000 * fps
毫秒 = 帧数 / fps * 1000
```

### 时间线位置

| 字段               | 单位  | 适用类型  | 说明                      |
| ------------------ | ----- | --------- | ------------------------- |
| `from`             | frame | 所有 item | item 在时间线上的起始帧   |
| `durationInFrames` | frame | 所有 item | item 在时间线上的持续帧数 |

### 素材内部起点

| 字段                      | 单位   | 适用类型 | 说明                           |
| ------------------------- | ------ | -------- | ------------------------------ |
| `videoStartFromInSeconds` | second | video    | 视频素材内部起点，用于裁剪开头 |
| `audioStartFromInSeconds` | second | audio    | 音频素材内部起点，用于裁剪开头 |
| `gifStartFromInSeconds`   | second | gif      | GIF 素材内部起点               |
| `captionStartInSeconds`   | second | captions | 字幕资产内部起点               |

### 音量与淡入淡出

| 字段                            | 单位   | 适用类型                                 | 说明                                            |
| ------------------------------- | ------ | ---------------------------------------- | ----------------------------------------------- |
| `decibelAdjustment`             | dB     | video, audio                             | 音量调整；`0` 为原音量，BGM 推荐 `-12` 到 `-18` |
| `audioFadeInDurationInSeconds`  | second | video, audio                             | 音频淡入                                        |
| `audioFadeOutDurationInSeconds` | second | video, audio                             | 音频淡出                                        |
| `fadeInDurationInSeconds`       | second | video, image, text, solid, gif, captions | 画面淡入                                        |
| `fadeOutDurationInSeconds`      | second | video, image, text, solid, gif, captions | 画面淡出                                        |

### 字幕样式

| 字段                         | 单位      | 说明             |
| ---------------------------- | --------- | ---------------- |
| `fontSize`                   | px        | 字幕字号         |
| `strokeWidth`                | px        | 描边宽度         |
| `strokeColor`                | CSS color | 描边颜色         |
| `color`                      | CSS color | 普通文字颜色     |
| `highlightColor`             | CSS color | 当前词高亮颜色   |
| `maxLines`                   | lines     | 每页最大行数     |
| `pageDurationInMilliseconds` | ms        | 字幕分组合并窗口 |

---

## 完整示例

一个包含 1 个视频 + 1 条字幕的最小工程：

```json
{
  "tracks": [
    {
      "id": "track-captions",
      "items": ["caption-1"],
      "hidden": false,
      "muted": false
    },
    {
      "id": "track-video",
      "items": ["video-1"],
      "hidden": false,
      "muted": false
    }
  ],
  "items": {
    "video-1": {
      "id": "video-1",
      "type": "video",
      "from": 0,
      "durationInFrames": 150,
      "top": 0,
      "left": 0,
      "width": 1080,
      "height": 1920,
      "opacity": 1,
      "isDraggingInTimeline": false,
      "rotation": 0,
      "borderRadius": 0,
      "cropLeft": 0,
      "cropTop": 0,
      "cropRight": 0,
      "cropBottom": 0,
      "assetId": "asset-video-1",
      "videoStartFromInSeconds": 0,
      "decibelAdjustment": 0,
      "playbackRate": 1,
      "audioFadeInDurationInSeconds": 0,
      "audioFadeOutDurationInSeconds": 0,
      "fadeInDurationInSeconds": 0,
      "fadeOutDurationInSeconds": 0,
      "keepAspectRatio": true
    },
    "caption-1": {
      "id": "caption-1",
      "type": "captions",
      "from": 0,
      "durationInFrames": 150,
      "top": 1632,
      "left": 54,
      "width": 972,
      "height": 192,
      "opacity": 1,
      "isDraggingInTimeline": false,
      "rotation": 0,
      "assetId": "asset-caption-1",
      "captionStyle": "default",
      "fontFamily": "TikTok Sans",
      "fontStyle": {"variant": "normal", "weight": "600"},
      "fontSize": 80,
      "lineHeight": 1.2,
      "letterSpacing": 0,
      "align": "center",
      "color": "white",
      "highlightColor": "#39E508",
      "strokeWidth": 4,
      "strokeColor": "black",
      "direction": "ltr",
      "pageDurationInMilliseconds": 2000,
      "captionStartInSeconds": 0,
      "maxLines": 2,
      "fadeInDurationInSeconds": 0,
      "fadeOutDurationInSeconds": 0
    }
  },
  "assets": {
    "asset-video-1": {
      "id": "asset-video-1",
      "type": "video",
      "filename": "intro.mp4",
      "size": 5242880,
      "remoteUrl": "https://resource.opencreator.io/remotion/intro.mp4",
      "remoteFileKey": "remotion/intro.mp4",
      "mimeType": "video/mp4",
      "durationInSeconds": 5,
      "hasAudioTrack": true,
      "width": 1080,
      "height": 1920
    },
    "asset-caption-1": {
      "id": "asset-caption-1",
      "type": "caption",
      "filename": "captions.srt",
      "size": 256,
      "remoteUrl": null,
      "remoteFileKey": null,
      "mimeType": "application/json",
      "captions": [
        {
          "text": "Hello ",
          "startMs": 0,
          "endMs": 500,
          "timestampMs": 250,
          "confidence": 0.95
        },
        {
          "text": "World",
          "startMs": 500,
          "endMs": 1000,
          "timestampMs": 750,
          "confidence": 0.98
        }
      ]
    }
  },
  "fps": 30,
  "compositionWidth": 1080,
  "compositionHeight": 1920,
  "deletedAssets": []
}
```
