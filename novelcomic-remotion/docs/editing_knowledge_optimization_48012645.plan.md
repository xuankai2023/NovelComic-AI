---
name: Editing Knowledge Optimization
overview: 对照三项成片要求（节奏、字幕、BGM/音频合轨），审计当前视频剪辑流水线，识别工程能力缺口和知识缺陷，提出具体优化路线图。
todos:
  - id: p0-project-read
    content: "P0: 实现 cut_project_read 工具 -- 查看草稿结构（轨道/元素/时间码/资源URL）"
    status: pending
  - id: p0-item-edit
    content: "P0: 实现 cut_item_edit 工具 -- 裁剪(起止点)、音量(dB)"
    status: pending
  - id: p0-audio-add
    content: "P0: 实现 cut_audio_add 工具 -- 添加音频轨，自动按视频时长截断，支持音量/淡入淡出"
    status: pending
  - id: p0-subtitle-extend
    content: "P0: 扩展 cut_subtitle_generate -- 增加 font_size/color/highlight_color/stroke_width 参数"
    status: pending
  - id: p0-review-fix
    content: "P0: 修复审片断裂 -- video-review skill 中显式声明 media_understanding 工具链路"
    status: pending
  - id: p1-audio-timestamp
    content: "P1: cut_audio_add 进阶 -- 增加 start_ms 参数，支持旁白在指定 timestamp 开始"
    status: pending
  - id: p1-editing-skill
    content: "P1: 创建 editing-core 可加载技能（音频混音规则/字幕规范/节奏模板）"
    status: pending
  - id: p1-step6-enrich
    content: "P1: 充实 STEP6_INSTRUCTION -- 审片工具链路、BGM工作流、字幕决策树、自查清单"
    status: pending
  - id: p1-sop-restructure
    content: "P1: 重命名 SOP 文档，编写真正的剪辑 SOP"
    status: pending
  - id: p2-review-upgrade
    content: "P2: 升级 video-review 技能 -- 场景类型分类 + 动态权重"
    status: pending
  - id: p2-transitions
    content: "P2: 转场支持（需 Remotion API 侧配合）"
    status: pending
isProject: false
---

# 剪辑模块 MVP v1 — 工程方案

> 目标：让 agent 能够交付一个"能看"的成片 —— 节奏合理、有字幕（可控样式）、有 BGM（音量合理）。

---

## 一、我们要做到什么效果

目前 agent 的剪辑能力 = 把视频片段首尾拼起来 + 加默认字幕 + 渲染。无法裁剪、无法加音频、无法调字幕样式、甚至无法看到自己拼出来的草稿长什么样。

MVP v1 之后，agent 应具备的完整剪辑流程：

```
审片（media_understanding 看视频 → video-review 打分筛选）
  ↓
粗剪（cut_video_concat 拼接 PASS 片段）
  ↓
精剪（cut_project_read 查看草稿 → cut_item_edit 裁剪起止点/调音量）
  ↓
加音频（cut_audio_add 加 BGM，自动截断到视频时长，音量 -12dB）
  ↓
加字幕（cut_subtitle_generate 带样式参数：字号、颜色、描边）
  ↓
渲染导出（cut_render_export）
```

---

## 二、第一版工程能力 — 要做什么、做到什么边界

### 2.1 `cut_project_read` — 查看草稿（新工具）

**为什么需要**：目前 agent 拼完视频只拿到一句话摘要"已拼接 3 个视频，总时长 15s"，完全看不到草稿内部结构。后续所有编辑（裁剪、加音频、调音量）都需要先知道"手上有什么"。

**输入**：无必填参数（自动读取当前 session 的草稿）

**输出**：结构化的草稿摘要，包含：

- 画布尺寸、帧率、总时长
- 每条轨道（ID、是否静音、是否隐藏）
- 每个元素（ID、类型 video/audio/captions、起始时间、时长、关联资源 URL、音量 dB）

**实现位置**：`CutService` 新增 `read_project()` → 从 Redis 草稿读取 `project_json` 并格式化返回。工具类放 `creato/core/tools/cut/project_read.py`。

---

### 2.2 `cut_item_edit` — 编辑元素属性（新工具）

**为什么需要**：裁剪片段、调音量、加淡入淡出，都是修改草稿中某个 item 的属性。

**输入**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `item_id` | string | 是 | 要修改的元素 ID（从 `cut_project_read` 获取）|
| `video_start_from` | number | 否 | 片段起始偏移（秒），用于裁剪 |
| `duration_in_frames` | integer | 否 | 持续帧数，用于裁剪 |
| `decibel_adjustment` | number | 否 | 音量调节（dB，0=原始，负值=降低）|

**v1 边界**：只支持裁剪（起止点）和音量调节。不支持画面淡入淡出（P1）、不支持改位置（top/left）、不支持改播放速度（playbackRate）、不支持跨轨道移动。

**实现位置**：`CutService` 新增 `edit_item()` → 在 Redis 草稿中定位到指定 item，更新传入的字段，重新保存草稿。工具类放 `creato/core/tools/cut/item_edit.py`。

---

### 2.3 `cut_audio_add` — 添加音频轨道（新工具）

**为什么需要**：目前成片没有 BGM。Remotion 工程 JSON 完全支持 audio 类型的 item/asset/track，但没有工具往草稿里加。

**输入**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `audio_url` | string | 是 | 音频文件 URL（BGM / 旁白）|
| `decibel_adjustment` | number | 否 | 音量（dB），默认 `-12`。BGM 通常 -12 ~ -18 |
| `fade_in_seconds` | number | 否 | 淡入（秒），默认 `0.5` |
| `fade_out_seconds` | number | 否 | 淡出（秒），默认 `1.5` |

**v1 关键行为 — 音频自动截断到视频时长**：

- 音频 3 分钟 / 视频 30s → 只取前 30s
- 实现方式：audio item 的 `durationInFrames` = 草稿总帧数，`audioStartFromInSeconds` = 0
- Remotion 渲染时超出 item 帧范围的音频自动不播放，无需预处理

**v1 不做的**：

- ~~`start_ms` 参数（指定音频从视频第 N 秒开始播放）~~ → P1 再加
- ~~多段音频分时间段放置~~ → P1

**实现方式**：`CutService` 新增 `add_audio()` → 直接操作工程 JSON：

1. 用 `httpx` HEAD 请求或 probe API 获取音频时长
2. 创建 audio asset（`type: "audio"`, `remoteUrl`, `durationInSeconds`）
3. 创建 audio item（`type: "audio"`, `from: 0`, `durationInFrames: 草稿总帧数`, `decibelAdjustment`, fade 参数）
4. 新建 track 加入 `tracks` 数组
5. 保存草稿

工具类放 `creato/core/tools/cut/audio_add.py`。

---

### 2.4 扩展 `cut_subtitle_generate` — 字幕样式参数

**为什么需要**：目前只能选"4 种样式 + 3 个位置"，无法控制字号、颜色、描边。

**新增可选参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `font_size` | integer | 80 | 字号（px）|
| `color` | string | "white" | 文字颜色（CSS 值）|
| `highlight_color` | string | "#39E508" | 当前播放词高亮色 |
| `stroke_width` | integer | 4 | 描边宽度（px）|
| `stroke_color` | string | "black" | 描边颜色 |

**实现方式**：

1. 工具 `parameters` 中新增这 5 个可选字段
2. 透传到 `CutService.add_subtitle()`
3. 在 Remotion API 返回工程 JSON 后，遍历 `items` 中 `type === "captions"` 的 item，用传入的参数覆写对应字段
4. 保存草稿

**改动文件**：`creato/core/tools/cut/subtitle_generate.py` + `creato/services/cut_service.py`

---

### 2.5 修复审片断裂 — 串联 `video-review` 与 `media_understanding`

**问题**：审片 skill 告诉 agent "评什么"（3 维打分），但从未告诉 agent "用什么工具去看视频"。`media_understanding`（Gemini 多模态分析）完全能看视频，但 skill 和 Step 6 指令里一个字都没提。

**后果**：agent 要么凭空猜测打分（根本没看视频），要么运气好自己想到调 `media_understanding`。

**修复（纯知识层改动，不涉及代码）**：

- 在 [`video-review/SKILL.md`](creato/core/skills/video-review/SKILL.md) 执行流程中加入工具调用说明
- 在 [`instruction.py`](creato/core/pipelines/ugc_video/instruction.py) 的 `STEP6.REVIEW_AND_EDIT` 段补充 `media_understanding` 调用指引

---

## 三、Agent 知识层面需要补齐的点

以下是 agent 做剪辑决策时依赖的"知识"，需要以 skill 或 instruction 的形式写入。工程侧不涉及。

### 3.1 审片 skill 补全工具链路

**位置**：[`creato/core/skills/video-review/SKILL.md`](creato/core/skills/video-review/SKILL.md)

需要补充的内容：

- 显式声明：对每段视频调 `media_understanding(url, prompt=审片提示词)` 获取分析结果
- 提供标准审片 prompt 模板（要求 Gemini 按 3 维度打分）
- 说明基于 Gemini 返回结果如何映射到 PASS/DISCARD 判定

### 3.2 音频混音规则

目前 agent 不知道 BGM 应该设多少 dB、什么时候该用 instrumental、淡入淡出设多长。需要补充：

- BGM 音量：口播内容 -15 ~ -18dB，纯画面内容 -8 ~ -12dB
- `make_instrumental`：有人声口播时始终开启
- 淡入淡出：片头 0.3-0.5s 淡入，片尾 1-2s 淡出
- 音量判断逻辑：如果视频轨有人声对白 → BGM 额外降低 3-5dB

### 3.3 字幕选型决策

目前 agent 不知道什么场景该用什么字幕样式。需要补充：

- 口播/对话 → `default`（白字黑边逐词高亮）
- 产品展示/快节奏 → `animated-background`
- 强调关键词 → `colored-words`
- 平台字号参考：TikTok/抖音 70-90px 居中，YouTube 50-70px 底部
- 颜色规则：深色画面用白字，浅色画面加粗描边

### 3.4 Step 6 指令充实

**位置**：[`creato/core/pipelines/ugc_video/instruction.py`](creato/core/pipelines/ugc_video/instruction.py) `STEP6_INSTRUCTION`

当前只有 ~20 行，需要补充：

- 审片 → `media_understanding` 调用说明
- 审片结论如何指导后续剪辑（DISCARD 的段重生成、PASS 的段进粗剪）
- BGM 集成流程（何时加、用 `cut_audio_add`、音量多少）
- 字幕决策流程（根据内容类型选样式/颜色/字号）
- 渲染后自查清单（前 3 秒 Hook 是否有力、产品露出是否足够、音画是否同步、字幕是否可读）

### 3.5 剪辑 SOP 文档

**位置**：[`docs/dylan/cut/剪辑模块的SOP.md`](docs/dylan/cut/剪辑模块的SOP.md)

当前文件实际是"素材需求判断规则"，需重命名后另写真正的剪辑 SOP：

- 标准剪辑流程：审片 → 粗剪 → 精剪 → 音频合轨 → 字幕 → 渲染
- 每步使用的工具和顺序
- 质量检查点

### 3.6 （P1）`editing-core` 可加载技能

将上述 3.2 ~ 3.3 的零散知识统一收口为一个 `loadable_skill`（类比 `workflow-core`），Step 6 通过 `load_skill("editing-core")` 加载。
