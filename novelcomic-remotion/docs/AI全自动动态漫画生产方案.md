# AI 全自动动态漫画生产方案

> 文档状态：实施计划  
> 适用工程：NovelComic、NovelComic Agent、NovelComic Remotion  
> 更新时间：2026-10-02  
> 目标：用户提供普通漫画、分镜图或脚本后，由 AI 自动完成素材处理、动画编排、配音字幕、审片修正与最终导出，不要求用户手工制作 PSD 或操作剪辑器。每次输出的视频片段目标时长为 15～18 秒，硬上限 18 秒、硬下限 5 秒，超出部分自动按批次输出，并向用户交付全部生产材料。

---

## 1. 执行摘要

本方案不使用 Seedance 2.0 为每个镜头生成完整视频，而是采用“静态素材生成一次 + 确定性 2D 动画重复渲染”的方式：

```text
漫画输入
→ 自动分格、OCR、镜头分析
→ 人物/背景分离与必要的局部补图
→ 生成透明 PNG 图层包
→ Agent 创建 Shot 并套用运动预设
→ 自动配音、字幕、BGM、音效
→ 低清预览与多模态审片
→ 自动修正或降级
→ Remotion 导出 1080P MP4
```

核心原则：

1. **不要求人工 PSD**：生产格式以 PNG 图层包 + `manifest.json` 为主，PSD 仅作为可选调试和美术交换格式。
2. **不要求本地大型 GPU**：优先复用现有阿里云图像分割和 NovelComic 图像编辑能力；复杂补图或多层拆分使用按次付费 API。
3. **Agent 不直接修改工程 JSON**：所有修改通过受约束、可校验、可幂等的工具执行。
4. **失败不阻塞成片**：分层失败时自动降级为整图推拉、横移、震屏和特效叠加。
5. **成本按镜头设上限**：普通镜头不调用昂贵模型，付费 API 只服务于确有价值的重点镜头。
6. **不能承诺绝对不失败**：目标是所有已知错误都能被检测、重试、回滚或降级，不允许静默错误进入成片。

预期成本目标：

- 10 分钟标准动态漫画：**50～200 元**
- 10 分钟高要求版本：**200～500 元**
- Seedance 2.0 同等 1080P 时长：一次成功约 **1500 元**，考虑重试可能达到 **3000 元**

以上是目标区间，必须通过 20～50 个真实漫画镜头的技术验证重新校准。

---

## 2. 产品目标与边界

### 2.1 产品目标

用户只需提供以下一种或多种输入：

- 普通漫画页
- 单独分镜图
- 故事脚本与角色设定
- 已有对白或音频
- 可选角色参考图

系统自动输出：

- 单段通常为 15～18 秒、且必须在 5～18 秒范围内的 1080P H.264 MP4；长内容自动输出有序分批片段
- 自动分镜与镜头节奏
- 推拉、横移、视差、呼吸、眨眼、口型、轻摆、震屏
- 光效、速度线、前景遮挡等图层效果
- 配音、字幕、BGM 和音效
- 可恢复、可继续编辑的工程草稿
- 可下载的完整生产材料包，包括原始输入、分镜、透明图层、manifest、音频、字幕、工程数据、预览和最终视频

### 2.1.1 输出批次时长约束

- 最终视频批次的目标时长为 15～18 秒，硬上限为 18 秒。
- 任意一个最终视频文件不得短于 5 秒或超过 18 秒。
- 总时长超过 18 秒时，系统必须自动生成多个 `OutputBatch`，按 `batchIndex` 顺序交付。
- 优先在 Shot 边界、对白停顿或自然转场处分批，不得为了凑满目标时长破坏一句完整对白。
- 如果单个 Shot 超过 18 秒，必须先拆分 Shot 或调整节奏，禁止输出超过 18 秒的文件。
- 最后一批不足 5 秒时，不得单独输出；必须与前一批重新分配 Shot、调整相邻批次边界或在不破坏内容的前提下调整镜头节奏，使所有批次均达到 5～18 秒。
- 项目总时长本身不足 5 秒时，应通过合理延长静帧、片尾或镜头节奏补足至 5 秒，并记录补足方式。
- 每个批次必须能够独立预览、校验、重试、渲染和下载；某一批次失败不得阻断其他已完成批次的交付。
- 系统可以额外提供播放清单和后续拼接信息，但不得用一个超过 18 秒的合并视频替代分批结果。

### 2.2 首版明确支持

- 整图 Ken Burns 推拉和横移
- 人物与背景双层视差
- 已成功拆分图层的局部动作
- 眼睛、嘴巴状态图切换
- 小幅呼吸、头发轻摆、气泡漂浮
- 简单淡入淡出、硬切和叠化
- 配音、字幕、BGM、音效
- AI 自动审片、重试和降级

### 2.3 首版明确不支持

- 完整骨骼动画
- 高精度网格变形和 Live2D 级绑定
- 任意角度连续人物转身
- 复杂手部动作自动重绘
- 真实 3D 摄像机
- AE 表达式兼容
- Photoshop 图层语义无损往返
- 任意平面漫画都能得到完美身体部件拆层
- 与完整视频生成模型相同的连续复杂动作

### 2.4 质量定义

本方案产物属于“高一致性轻量动态漫画”，优势是：

- 保留原漫画画风和角色身份
- 镜头、字幕、音频和节奏可控
- 修改局部内容无需重新生成整段视频
- 相同角色和素材可以缓存复用
- 成本远低于逐帧生成视频

它不等同于全动画番剧，也不以复杂连续运动为目标。

---

## 3. 当前工程能力盘点

### 3.1 已有图像分割能力

`opencreator-publisher` 已接入阿里云 `SegmentCommonImage`：

- API：`POST /api/v3/image-segmentation/common`
- 返回形式：`mask`、`whiteBK`、`crop` 或透明 PNG
- 当前供应商成本常量：`0.0016 RMB/call`
- 结果自动转存 NovelComic CDN
- 已有积分检查、扣费和幂等来源 ID

关键文件：

- `opencreator-publisher/services/image_segmentation.py`
- `opencreator-publisher/controller/v3/image_segmentation.py`
- `opencreator-publisher/schemas/request_schemas/image_segmentation_request.py`
- `opencreator-frontend/src/api/modules/image-segmentation.ts`

该能力适合：

- 人物/主体抠图
- 前景物体提取
- 返回基础 mask

它不等于：

- 身体、眼睛、嘴巴、头发语义拆层
- 遮挡区域补全
- 多图层绘制顺序恢复

### 3.2 已有图像编辑能力

`opencreator-ai` 已接入：

- `opencreator/image-to-image/qwen-image-edit`
- `fal-ai/qwen-image-edit-plus`
- `fal-ai/qwen-image-edit-2511-multiple-angles`
- GPT Image、Gemini、Seedream 等图生图模型

关键文件：

- `opencreator-ai/packages/core/src/models/qwen-image.ts`
- `opencreator-ai/packages/core/src/api/fal/qwen-image.ts`
- `opencreator-agent/creato/core/tools/opencreator/node_model_catalog.py`

这些能力可用于：

- 生成闭眼状态
- 生成少量口型状态
- 修复局部画面
- 生成光效或装饰素材

当前缺口：

- 没有统一暴露 `image + mask + prompt` 的严格局部补图工具
- 没有 Qwen Image Layered 多层拆分模型
- 没有漫画专用语义分层工具

### 3.3 已有 Remotion 编辑能力

`opencreator-remotion` 已具备：

- 图片、视频、音频、文字、字幕、GIF 和色块 item
- 多轨时间线
- 轨道隐藏和静音
- 静态位置、尺寸、旋转、透明度和裁剪
- 图片和视频淡入淡出
- BGM/旁白音频轨
- 字幕识别
- 本地预览
- 工程 JSON
- Lambda H.264 导出

关键文件：

- `opencreator-remotion/src/editor/state/types.ts`
- `opencreator-remotion/src/editor/items/image/image-item-type.ts`
- `opencreator-remotion/src/editor/items/image/image-layer.tsx`
- `opencreator-remotion/src/editor/canvas/layers.tsx`
- `opencreator-remotion/app/api/render/route.ts`

当前缺口：

- 轨道没有业务名称
- 没有 Shot/Scene
- 图片属性整段固定
- 没有关键帧、循环、缓动、锚点
- 没有状态图切换
- 没有图片组 compose API
- Agent 摘要看不到图片几何和运动

### 3.4 已有 Agent 剪辑能力

当前 Agent 工具链主要面向视频：

```text
cut_video_concat
→ cut_project_read
→ cut_item_edit
→ cut_audio_add
→ cut_video_overlay
→ cut_subtitle_generate
→ cut_render_export
```

当前限制：

- 草稿必须从视频拼接开始
- 纯图片无法创建草稿
- 不能添加图片序列
- 不能写图片运动
- 不能添加脚本对白
- 不能导入图层包
- 没有给 Agent 使用的静帧预览和联系表
- Agent 不能把任意工程 JSON 注入现有 Redis 草稿

因此，仅给编辑器新增动画 UI 不能形成 Agent 自动生产闭环。

---

## 4. 目标系统架构

```text
┌──────────────────────────────────────────────┐
│ 用户输入                                      │
│ 漫画页 / 分镜图 / 脚本 / 角色图 / 音频         │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Comic Analyzer                               │
│ OpenCV 分格 / OCR / 角色识别 / 镜头分类       │
└──────────────────────┬───────────────────────┘
                       │ ShotSpec[]
                       ▼
┌──────────────────────────────────────────────┐
│ Layer Preparation Service                    │
│ 阿里云分割 / 脚本蒙版 / 局部补图 / 状态图生成 │
└──────────────────────┬───────────────────────┘
                       │ LayerPackage
                       ▼
┌──────────────────────────────────────────────┐
│ Comic Compose API                            │
│ Project / Shot / Layer / Motion / Dialogue   │
└──────────────────────┬───────────────────────┘
                       │ Revisioned Draft
                       ▼
┌──────────────────────────────────────────────┐
│ NovelComic Remotion                         │
│ 预览 / 关键帧 / 图层切换 / 音频 / 最终渲染   │
└──────────────────────┬───────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌───────────────────┐      ┌───────────────────┐
│ Preview QA        │      │ Final Render      │
│ 抽帧、多模态审片   │      │ 1080P MP4         │
└─────────┬─────────┘      └───────────────────┘
          │ 修正/降级
          └───────────────→ Agent Skill
```

最终渲染前增加批次规划：根据 Shot、对白停顿和转场生成目标 15～18 秒、硬范围 5～18 秒的 `OutputBatch[]`。渲染完成后由 Delivery Packager 汇总全部视频与生产材料，生成可下载材料包和清单。

### 4.1 服务职责

#### Comic Analyzer

负责：

- 漫画分格
- 阅读顺序推断
- OCR 与对白归属
- 人物位置与主要角色识别
- 镜头类型识别：远景、近景、对话、动作、环境
- 动画等级建议

优先采用：

- OpenCV 规则处理标准漫画格
- 视觉模型只处理不规则分格和语义判断

#### Layer Preparation Service

负责：

- 人物/背景分离
- 生成透明图层
- 生成眼睛和嘴巴状态补丁
- 必要时局部补图
- 图层对齐、边界和锚点计算
- 输出 `LayerPackage`

#### Comic Compose API

负责：

- 空项目创建
- Shot 管理
- 图层入轨
- 运动写入
- 对白、配音和音效入轨
- 工程摘要与校验
- 幂等、revision、回滚

#### Agent Skill

负责：

- 读取用户目标
- 编排工具调用
- 控制每镜头预算
- 选择动作预设
- 审片与修正
- 执行自动降级

#### Preview QA

负责：

- 静帧联系表
- 低清草稿
- 画面和音频质量检查
- 产生结构化问题，不只返回自然语言描述

---

## 5. 漫画素材处理方案

### 5.1 分格

优先使用脚本：

1. 灰度化与自适应阈值
2. 检测长直线和封闭轮廓
3. 合并相邻边框
4. 按阅读方向排序
5. 输出每格 bounding box

不规则跨格、无边框漫画交给视觉模型。

### 5.2 分层等级

每个镜头先分类，再决定费用和处理方式。

#### L0：整图镜头

适用：

- 环境镜头
- 拆层置信度低
- 大量复杂遮挡
- 无需局部动作

能力：

- 推拉
- 横移
- 震屏
- 光效、速度线

成本最低，不需要图像分割。

#### L1：人物/背景双层

处理：

- 调用现有阿里云分割
- 原图保留为底图或背景来源
- 人物透明 PNG 作为前景

能力：

- 轻微视差
- 人物小幅呼吸
- 前后景速度差

注意：

- 原图作为底图时，人物大幅移动会出现残影
- 必须限制运动幅度，或对人物位置执行局部补图

#### L2：局部状态图

处理：

- 定位眼睛、嘴巴
- 生成完整眼周和嘴周补丁
- 状态图必须覆盖原区域，避免底图重影

能力：

- 眨眼
- 2～5 档口型
- 轻微表情变化

#### L3：多部件图层

处理：

- 多层拆分模型或组合分割
- 拆分头、身体、手臂、头发、前景
- 对暴露区域执行补图

能力：

- 局部摆动
- 更明显的呼吸
- 头发和手臂轻动作
- 多平面视差

只用于重点镜头。

### 5.3 补图策略

补图不是所有镜头的默认步骤。

```text
是否会露出原本被遮挡区域？
├── 否 → 不补图
└── 是
    ├── 小洞 + 简单纹理 → OpenCV inpaint
    ├── 中等洞 + 可裁切 → mask inpaint API
    ├── 多次失败 → 限制动作范围
    └── 仍失败 → 降级为整图镜头
```

OpenCV 适合：

- 天空、墙面、地面
- 模糊背景
- 单色区域
- 小面积缺口

模型补图适合：

- 复杂线稿
- 人物移开后的背景
- 身体和衣服结构
- 较大遮挡区域

### 5.4 眼睛与嘴巴

脚本可以：

- 根据锚点切换状态图
- 使用 `scaleY` 做快速眨眼
- 根据音频振幅切换口型
- 控制最短开口时间，避免高频闪烁

脚本不能凭空产生：

- 闭眼时的正确线稿
- 张嘴后的牙齿、舌头和口腔

因此采用：

1. 普通远景：不生成专用状态，使用小幅几何变换。
2. 对话近景：生成一次眼周和 3 档嘴周状态补丁。
3. 同角色同角度状态图缓存复用。
4. 只有特写才调用高质量图像编辑。

---

## 6. 图层包数据规范

### 6.1 目录格式

```text
project-assets/
└── shot-001/
    ├── source.png
    ├── background.png
    ├── character.png
    ├── eye-open.png
    ├── eye-closed.png
    ├── mouth-closed.png
    ├── mouth-half.png
    ├── mouth-open.png
    ├── foreground.png
    └── manifest.json
```

### 6.2 LayerPackage

```ts
type LayerPackage = {
  schemaVersion: 1;
  projectId: string;
  shotId: string;
  sourceUrl: string;
  canvas: {
    width: number;
    height: number;
  };
  layers: ComicLayer[];
  diagnostics: LayerDiagnostics;
};

type ComicLayer = {
  layerId: string;
  name: string;
  semantic:
    | 'background'
    | 'foreground'
    | 'body'
    | 'head'
    | 'arm-left'
    | 'arm-right'
    | 'hair'
    | 'eye-open'
    | 'eye-closed'
    | 'mouth-closed'
    | 'mouth-half'
    | 'mouth-open'
    | 'effect'
    | 'other';
  imageUrl: string;
  zIndex: number;
  visible: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  anchor: {
    x: number;
    y: number;
  };
  confidence: number;
  motionPolicy:
    | 'static'
    | 'camera-only'
    | 'subtle'
    | 'free';
};

type LayerDiagnostics = {
  recompositionScore: number;
  alphaHoleRatio: number;
  edgeArtifactScore: number;
  requiresFallback: boolean;
  warnings: string[];
};
```

### 6.3 规范要求

- 坐标以原始画布左上角为原点
- `anchor.x/y` 使用 0～1 归一化坐标
- 图层图像可以裁切，但必须提供 `bounds`
- `layerId` 在同一 Shot 内稳定
- 相同请求重试必须复用 `shotId/layerId`
- 所有远程素材必须有可供 Lambda 访问的 `remoteUrl`
- 禁止把图片二进制写入工程 JSON

### 6.4 OutputBatch 与材料交付包

```ts
type OutputBatch = {
  batchId: string;
  batchIndex: number;
  fromFrame: number;
  durationInFrames: number;
  shotIds: string[];
  status: 'pending' | 'rendering' | 'completed' | 'failed';
  videoUrl?: string;
  checksum?: string;
};

type DeliveryPackageManifest = {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  batches: OutputBatch[];
  files: Array<{
    path: string;
    category:
      | 'source'
      | 'panel'
      | 'layer'
      | 'manifest'
      | 'audio'
      | 'subtitle'
      | 'project'
      | 'preview'
      | 'final-video';
    url: string;
    checksum: string;
    sizeBytes: number;
  }>;
};
```

批次要求：

- `fps * 5 <= durationInFrames <= fps * 18`，该条件属于最终渲染硬校验。
- 批次规划优先产生 15～18 秒的视频；5～15 秒只用于自然段落收尾或无法在不破坏内容的情况下继续填充的批次。
- 批次边界优先落在 Shot 边界；不得直接截断对白、字幕和音频。
- 尾批不足 5 秒时必须与相邻批次重新平衡，禁止直接渲染。
- `batchIndex` 从 1 连续递增，重试时保持稳定。
- 每个批次记录独立状态、错误、成本、视频 URL 和内容 hash。

材料包至少包含：

- 用户原始输入及其元数据
- 自动分格后的每个分镜图和 `ShotSpec`
- 所有透明 PNG、状态图、背景补图及 `LayerPackage`
- TTS、对白、BGM、音效及混音前后的音频
- SRT 或 VTT 字幕
- 可恢复工程 JSON、schema 版本和素材引用清单
- 联系表、低清预览、质量诊断和降级记录
- 所有最终 5～18 秒视频片段、播放顺序清单和 checksum

若第三方授权不允许分发某项素材，必须在清单中明确标记缺失项、原因和可替代信息，不得静默省略。

---

## 7. 编辑器数据模型改造

### 7.1 Track 扩展

```ts
type TrackType = {
  id: string;
  name?: string;
  shotId?: string;
  semantic?: string;
  items: string[];
  hidden: boolean;
  muted: boolean;
};
```

### 7.2 Shot 模型

```ts
type Shot = {
  id: string;
  name: string;
  from: number;
  durationInFrames: number;
  layerTrackIds: string[];
  transitionIn?: ShotTransition;
  transitionOut?: ShotTransition;
  cameraMotion?: TransformAnimation;
  dialogueIds: string[];
};
```

Shot 是动态漫画的业务边界：

- 修改镜头时长时同步调整镜头内图层
- 删除 Shot 时原子删除关联图层
- 镜头统一推拉由 `cameraMotion` 控制
- 局部图层动作在 Shot 内独立计算

### 7.3 ImageItem 动画模型

```ts
type TransformKeyframe = {
  frame: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  opacity?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
};

type TransformAnimation = {
  keyframes: TransformKeyframe[];
  loop?: 'none' | 'repeat' | 'ping-pong';
  loopStartFrame?: number;
  loopEndFrame?: number;
  anchorX?: number;
  anchorY?: number;
};

type SpriteState = {
  frame: number;
  assetId: string;
};

type ImageMotion = {
  transform?: TransformAnimation;
  spriteStates?: SpriteState[];
  preset?: {
    id: string;
    parameters: Record<string, number | string | boolean>;
  };
};
```

`ImageItem` 新增：

```ts
motion?: ImageMotion;
shotId?: string;
layerId?: string;
semantic?: string;
```

### 7.4 渲染规则

1. 静态 `left/top/width/height/rotation` 作为 rest pose。
2. 当前帧在 item 的局部时间内求值。
3. 裁剪完成后应用 transform。
4. transform origin 使用 anchor。
5. sprite 状态切换必须离散，不做图片 URL 连续插值。
6. 预览和 Lambda 使用同一求值函数。
7. 画布选框也使用同一求值函数，避免动画过程中选框错位。

### 7.5 MVP 动作预设

```text
camera-push
camera-pull
camera-pan-left
camera-pan-right
parallax
breathing
blink
mouth-flap
hair-sway
float
shake-soft
shake-hard
flash
fade
```

预设必须有安全参数范围。例如：

- 呼吸缩放：1.00～1.03
- 头发旋转：±1°～3°
- 普通视差：不超过安全可见边界
- 震屏：短时、回到原点
- 嘴型切换：限制每秒切换频率

---

## 8. Compose API 与 Agent 工具

### 8.1 必须新增的 HTTP API

#### 创建纯图片工程

```text
POST /api/compose/project/create
```

请求：

```json
{
  "clientRequestId": "req-001",
  "compositionWidth": 1080,
  "compositionHeight": 1920,
  "fps": 30
}
```

#### 创建 Shot

```text
POST /api/compose/shot/create
```

支持：

- `shotId`
- `startMs`
- `durationMs`
- `layerPackage`
- `cameraMotion`

#### 添加图片序列

```text
POST /api/compose/image/sequence
```

用于不拆层的整图 MVP。

#### 导入图层包

```text
POST /api/compose/layers/import
```

要求批量原子写入：

- assets
- items
- tracks
- shot

#### 写入运动

```text
POST /api/compose/item/motion
```

支持：

- 预设
- 参数
- 原始关键帧
- 状态图

#### 添加脚本对白

```text
POST /api/compose/dialogue/add
```

不能只依赖 ASR。漫画对白应直接生成 caption/text item。

#### 静帧预览

```text
POST /api/compose/project/preview-frame
```

支持指定：

- `frame`
- `width`
- `format`

#### 联系表

```text
POST /api/compose/project/contact-sheet
```

用于 Agent 一次检查多个镜头。

#### 规划输出批次

```text
POST /api/compose/project/plan-batches
```

根据 Shot、对白和转场生成目标 15～18 秒、硬范围 5～18 秒的 `OutputBatch[]`。返回批次边界、包含的 Shot、预计时长和边界选择原因。

#### 分批渲染

```text
POST /api/compose/project/render-batches
```

要求：

- 每批独立任务、独立状态和独立重试
- 服务端再次校验单批必须在 5～18 秒范围内
- 尾批不足 5 秒时拒绝渲染，并要求重新规划相邻批次
- 支持仅重渲失败批次
- 返回有序视频 URL 和播放清单

#### 导出生产材料

```text
POST /api/compose/project/export-package
```

汇总原始输入、中间材料、工程数据、诊断记录和最终视频，生成 `DeliveryPackageManifest` 及可下载压缩包。

### 8.2 必须扩展的 API

`item/edit` 增加：

- `left/top/width/height`
- `rotation/opacity`
- crop
- motion
- `expectedRevision`

`project/summary` 增加：

- track name
- shot
- layer
- 几何
- motion
- asset readiness
- preview URLs

`project/validate` 增加：

- image item 与 image asset 类型一致
- 图片尺寸有效
- motion 数值和关键帧合法
- sprite asset 完整
- Shot 内图层时长一致
- 轨道重叠和时间线空洞
- 图层越界和安全区域警告
- 音频、字幕和工程时长一致性

### 8.3 Agent 命令

```text
comic_project_create
comic_analyze
comic_shot_create
comic_layer_prepare
comic_layers_import
comic_motion_apply
comic_dialogue_add
comic_voice_add
comic_audio_mix
comic_project_read
comic_project_validate
comic_preview_frame
comic_preview_render
comic_batch_plan
comic_batch_render
comic_package_export
comic_render_export
```

每个命令必须：

- 使用 JSON Schema
- 返回 `draftId`
- 返回新 `revision`
- 返回结构化错误
- 带 `clientRequestId`
- 支持幂等重试

---

## 9. Agent Skill

### 9.1 Skill 输入

- 用户目标
- 漫画或素材 URL
- 输出比例
- 期望时长
- 语言
- 风格强度
- 成本上限
- 可选角色声音

### 9.2 固定工作流

```text
1. 分析用户输入
2. 建立成本预算
3. 漫画分格和对白提取
4. 为每格选择 L0/L1/L2/L3
5. 准备图层包
6. 创建工程和 Shot
7. 应用镜头运动
8. 应用角色局部运动
9. 添加对白、TTS、字幕
10. 添加 BGM 和音效
11. 工程校验
12. 联系表审片
13. 低清视频审片
14. 修正或降级
15. 按 Shot 和对白边界规划目标 15～18 秒、硬范围 5～18 秒的输出批次
16. 逐批校验并渲染，失败时仅重试对应批次
17. 汇总全部生产材料并生成交付包
18. 向用户返回有序视频列表、播放清单和材料包
```

### 9.3 Agent 权限边界

Agent 可以：

- 选择动作预设
- 选择镜头时长
- 决定动画等级
- 决定是否调用付费 API
- 决定修正或降级

Agent 不可以：

- 手写整个 `UndoableState`
- 生成任意 asset/item ID
- 绕过校验直接渲染
- 无限重试付费模型
- 覆盖比当前更新的草稿 revision
- 在没有 remoteUrl 的情况下触发最终渲染

### 9.4 成本控制

Skill 必须维护：

```ts
type CostBudget = {
  projectLimitRmb: number;
  shotLimitRmb: number;
  maxPaidCallsPerShot: number;
  maxRetriesPerOperation: number;
  spentRmb: number;
};
```

默认策略：

- L0：0 元
- L1：使用现有分割
- L2：最多 3 次图像编辑
- L3：仅重点镜头
- 单镜头连续失败两次后降级
- 达到项目预算 80% 时停止非必要增强

---

## 10. 可靠性设计

### 10.1 状态机

```text
CREATED
→ ANALYZING
→ PREPARING_ASSETS
→ COMPOSING
→ VALIDATING
→ PREVIEWING
→ REVIEWING
→ FIXING
→ READY_TO_RENDER
→ PLANNING_BATCHES
→ RENDERING_BATCHES
→ PACKAGING
→ DELIVERED
```

失败状态：

```text
RETRYABLE_FAILED
DEGRADED
PERMANENT_FAILED
CANCELLED
```

### 10.2 幂等

以下操作必须支持 `clientRequestId`：

- 创建项目
- 创建 Shot
- 图层导入
- 音频添加
- 字幕添加
- 运动写入
- 预览渲染
- 最终渲染

重复请求必须返回第一次成功结果，不得重复添加轨道或扣费。

### 10.3 Revision

所有草稿修改使用：

```text
expectedRevision → compare-and-set → newRevision
```

冲突返回：

```json
{
  "code": "DRAFT_REVISION_CONFLICT",
  "retryable": true,
  "expectedRevision": 12,
  "actualRevision": 13
}
```

Agent 重新读取摘要后再修改。

### 10.4 批量原子性

图层包导入必须：

1. 验证所有 URL。
2. 构建临时 assets/items/tracks。
3. 完整校验。
4. 一次提交到草稿。
5. 失败不留下半套轨道。

### 10.5 草稿保留

- 渲染成功后不立即删除草稿
- 至少保留 7～30 天
- 最终工程生成内容 hash
- 相同 hash 的重复渲染可以复用结果
- 支持从最终工程 fork 新草稿
- 用户交付完成前不得清理任何被材料包引用的源文件或中间材料
- 材料包至少与草稿保持相同保留期，并提供过期时间
- 单批重渲不得改变其他批次的 URL、顺序和 checksum

### 10.6 结构化错误

统一格式：

```json
{
  "type": "error",
  "code": "LAYER_RECOMPOSITION_FAILED",
  "message": "图层重组与原图差异过大",
  "retryable": true,
  "projectId": "project-1",
  "shotId": "shot-5",
  "layerId": "hair-front",
  "traceId": "trace-xxx",
  "suggestedAction": "DEGRADE_TO_L1"
}
```

---

## 11. 自动质量门禁

### 11.1 图层质量

自动检查：

- 重组图与原图的像素/感知差异
- alpha 破洞比例
- 边缘白边和黑边
- 人脸身份差异
- 图层尺寸和位置
- 重复残影
- 生成图层是否为空

处理：

```text
通过 → 允许局部动画
边缘问题 → 羽化/腐蚀/膨胀修复
补图问题 → 重试一次
仍失败 → 降级
```

### 11.2 动画质量

自动检查：

- 图层运动后是否暴露透明区域
- 是否超出安全裁切范围
- 锚点是否合理
- 眨眼频率是否异常
- 口型是否高频闪烁
- 呼吸幅度是否过大
- 震屏是否回到原点

### 11.3 时间线质量

- 不允许黑帧
- Shot 之间不允许无意空洞
- 所有图层覆盖 Shot 时长
- 字幕不超出画布
- 音频不产生削波
- 对白与口型区间一致
- BGM 时长覆盖工程或正确淡出
- 每个最终批次时长必须在 5～18 秒范围内，通常保持在 15～18 秒
- 不允许出现不足 5 秒的孤立尾批
- 批次边界不截断对白、字幕、音效尾部和必要转场
- 批次顺序连续，首尾帧不存在重复、遗漏或黑帧
- 材料清单中的文件可访问，checksum、大小和分类完整

### 11.4 多模态审片

联系表检查：

- 人物一致性
- 字幕遮挡
- 构图和安全区

低清视频检查：

- 运动是否突兀
- 镜头节奏
- 口型、配音和字幕同步
- 转场和音效

审片结果必须转换成结构化修改任务，不能只输出自然语言建议。

---

## 12. 自动降级矩阵

| 问题 | 首次处理 | 再次失败 | 最终降级 |
| --- | --- | --- | --- |
| 分格失败 | 视觉模型重试 | 使用整页滚动 | 整页 Ken Burns |
| 人物分割失败 | 调整 mask/模型 | 图像编辑重试 | 整图运动 |
| 背景补图失败 | 裁切区域重试 | 限制位移 | 取消局部视差 |
| 闭眼图失败 | 再生成一次 | 几何压扁 | 禁用眨眼 |
| 口型失败 | 再生成一次 | 原嘴 scaleY | 禁用口型 |
| 多层拆分失败 | 降为人物/背景 | 降为整图 | 整图推拉 |
| 动画越界 | 缩小参数 | 更换预设 | 静态镜头 |
| 字幕遮脸 | 调整位置 | 缩小字号 | 分页显示 |
| 渲染失败 | 原任务重试 | 降低并发/分辨率 | 回退有效草稿 |

降级后的镜头仍必须保留：

- 原图
- 正确对白
- 配音
- 字幕
- 基础镜头运动

---

## 13. 成本模型

### 13.1 已知价格

#### 现有阿里云通用图像分割

- 工程内供应商成本常量：`0.0016 RMB/call`
- 120 镜头全部调用约 0.192 元供应商成本
- 实际 NovelComic 用户积分价格由产品定价决定

#### Qwen Image Layered 托管 API 参考

- 2 层约 $0.05
- 4 层约 $0.10
- 8 层约 $0.20

#### 图像局部补图参考

- Qwen Image Edit/Inpaint：约 $0.03/百万像素
- 1024×1024 约 0.21 元
- 1080×1920 约 0.43 元
- 实际以供应商账单为准

#### Remotion Lambda

- 官方示例 10 分钟 HD 约 $0.10 Lambda 计算成本
- 不含存储、带宽和可能的 Remotion 商业许可
- 10 分钟内容通常产生 34～40 个批次；必须计入任务启动、材料打包、存储和下载带宽开销

### 13.2 10 分钟 / 120 镜头预算

推荐分配：

| 镜头类型 | 占比 | 数量 | 单镜头目标 |
| --- | ---: | ---: | ---: |
| L0 整图 | 45% | 54 | 接近 0 元 |
| L1 人景 | 30% | 36 | 低于 0.1 元 |
| L2 状态图 | 20% | 24 | 0.5～2 元 |
| L3 多层 | 5% | 6 | 2～8 元 |

目标预算：

- 分格与基础分割：低于 5 元
- 状态图：12～48 元
- 多层拆分与补图：12～48 元
- TTS、Agent、视觉审片：20～80 元
- 存储和渲染：5～20 元
- 重试缓冲：20%～50%

合计目标：

- 标准版本：50～200 元
- 高要求版本：200～500 元

### 13.3 Seedance 2.0 对照

公开参考中，1080P 5 秒约 12.39 元：

- 1 分钟约 149 元
- 10 分钟约 1487 元
- 平均生成两次约 3000 元

分层方案便宜的原因：

- 不为每一帧运行视频扩散模型
- 静态图层生成一次即可反复渲染
- 相同角色状态图可以复用
- 修改字幕、音频和节奏不需要重生成画面
- 普通镜头使用脚本和确定性变换

### 13.4 成本风险

可能导致成本失控：

- 每个镜头都拆 8 层
- 每个镜头都生成专用口型
- 不限制自动重试
- 整图而不是局部裁切补图
- 相同角色素材不缓存
- Agent 无预算意识

必须记录：

- 每 Shot 的供应商调用
- 输入/输出分辨率
- 调用次数
- 重试次数
- 成本
- 最终采用等级

---

## 14. 安全与合规

必须处理：

- 漫画版权和用户授权
- 用户素材的保留期
- 完整生产材料包的保留期与用户下载权限
- 第三方模型的数据使用政策
- 供应商是否用于训练
- 生成式补图的内容安全
- 对象存储访问权限
- 签名 URL 过期
- 多租户素材隔离
- 日志不得记录完整密钥和敏感 URL

要求：

- 每个素材记录 owner
- Agent 工具继承用户身份
- 草稿读取和渲染前执行归属校验
- CDN URL 与私有原图分离
- 可按用户请求删除中间图层和成片
- 材料包只能由项目 owner 或授权成员下载
- 下载使用有时效的签名 URL，不得在日志中记录完整下载地址
- 删除项目时必须同时删除各批次视频、材料包及其派生文件

---

## 15. 实施阶段

### Phase 0：技术验证

目标：回答“现有能力对真实漫画是否有效”，暂不建设完整产品。

任务：

- 选择 20～50 个代表性镜头
- 包含远景、近景、多人、复杂头发、强光效和遮挡
- 测试阿里云分割
- 测试 OpenCV 分格
- 测试眼周/嘴周补丁
- 测试严格 mask 补图 API
- 测试图层重组检查
- 记录时间、成本和失败原因

通过条件：

- 标准漫画分格成功率达到可用水平
- 人景分离对主要画风有效
- 至少 70% 镜头可以采用 L0/L1 无付费增强完成
- 补图调用成本和质量可接受
- 能建立明确的降级规则

### Phase 1：单镜头动态插画

任务：

- LayerPackage
- Track name/semantic
- ImageItem motion
- 通用运动求值函数
- 图片状态切换
- 眨眼、口型、呼吸、轻摆预设
- 图片时长编辑
- 预览与 Lambda 一致
- 动画选框同步

通过条件：

- 一个镜头可完成导入、动画、保存、恢复和导出
- 抽取首中尾帧与预览一致
- 动画数据进入工程 JSON
- 旧工程可正常加载

### Phase 2：多镜头动态漫画

任务：

- Shot 模型
- Shot 创建、删除、调整时长
- 相邻镜头硬切和叠化
- 镜头统一 camera motion
- 图片序列 compose API
- 图层包原子导入 API
- 脚本对白 API
- 5～18 秒输出批次规划，目标时长为 15～18 秒
- 分批渲染、独立重试和播放清单
- 全量生产材料导出

通过条件：

- 至少 20 个镜头连续编排
- 调整一个 Shot 不破坏其他 Shot
- 无黑帧和轨道空洞
- BGM 自动铺满工程
- 任意输出视频必须在 5～18 秒范围内，通常保持在 15～18 秒
- 可以下载包含全部生产材料的完整交付包

### Phase 3：Agent 闭环

任务：

- 新增 `comic_*` 工具
- Redis 草稿支持纯图片创建
- revision 与 clientRequestId
- 漫画专用 Skill
- 项目摘要扩展
- 校验工具暴露给 Agent
- 静帧和联系表
- 低清草稿审片
- 自动修正与降级

通过条件：

- 用户只提供漫画素材即可生成成片
- Agent 不接触完整原始工程 JSON
- 工具重复调用不产生重复轨道
- 渲染后草稿可以继续编辑

### Phase 4：生产化

任务：

- 队列、超时和取消
- 成本账本
- 供应商 fallback
- 指标和告警
- 失败任务恢复
- 多租户隔离
- 内容安全
- 压力测试

通过条件：

- 流水线完成率达到目标
- 所有失败都能定位到阶段和 Shot
- 预算超限能自动停止非必要增强
- 渲染失败可从有效草稿恢复

---

## 16. 推荐任务拆分

### 工作包 A：漫画预处理

- A1 OpenCV 分格器
- A2 OCR 与对白归属
- A3 现有分割 API 适配
- A4 图层包生成
- A5 OpenCV 小洞补图
- A6 mask inpaint provider
- A7 眼睛/嘴巴补丁生成
- A8 图层质量诊断

### 工作包 B：编辑器动画

- B1 动画类型和 schema
- B2 动画求值器
- B3 ImageLayer 渲染
- B4 锚点与 scaleX/scaleY
- B5 sprite 状态切换
- B6 Inspector 控件
- B7 关键帧时间线标记
- B8 画布选框同步
- B9 motion presets
- B10 向后兼容与工程迁移

### 工作包 C：Shot 与 Compose API

- C1 Shot schema
- C2 project/create
- C3 image/sequence
- C4 layers/import
- C5 shot/create/edit/delete
- C6 item/motion
- C7 dialogue/add
- C8 summary 扩展
- C9 validate 扩展
- C10 preview-frame/contact-sheet
- C11 batch planner
- C12 batch render 与独立重试
- C13 delivery package 与材料清单

### 工作包 D：Agent

- D1 comic tools
- D2 draft revision
- D3 idempotency
- D4 Skill
- D5 预算控制
- D6 结构化审片
- D7 自动修正
- D8 自动降级

### 工作包 E：生产化

- E1 Trace ID
- E2 阶段进度
- E3 成本明细
- E4 告警与重试
- E5 草稿恢复
- E6 压力测试
- E7 安全与租户测试

---

## 17. 测试计划

### 17.1 单元测试

- 动画关键帧插值
- loop/ping-pong
- 锚点变换
- sprite 状态边界
- Shot 时长换算
- 图层 bounds
- 成本预算
- 幂等 key
- revision 冲突

### 17.2 契约测试

- Agent Tool JSON Schema
- Compose API 请求/响应
- LayerPackage schemaVersion
- Remotion input props
- Publisher 分割返回值
- 错误 code 和 retryable

### 17.3 集成测试

- 漫画页到分镜
- 分镜到图层包
- 图层包到工程
- 工程到预览
- 预览修正到最终导出
- 同一请求重复执行
- 处理中断后恢复
- 长工程自动拆成目标 15～18 秒、硬范围 5～18 秒的有序批次
- 仅失败批次重渲，不影响已完成批次
- 完整材料包生成、下载和 checksum 校验

### 17.4 视觉回归

固定测试集：

- 单人近景
- 多人对话
- 复杂头发
- 手臂遮挡
- 模糊背景
- 强光效
- 黑白漫画
- 彩色漫画
- 不规则分格

保存关键帧基线，比较：

- 重组差异
- 透明边缘
- 人脸一致性
- 字幕位置
- 动画安全区

### 17.5 故障注入

- 分割供应商超时
- 补图返回空图
- CDN URL 失效
- 上传中断
- Redis revision 冲突
- 重复 webhook
- Lambda 渲染失败
- Agent 重复调用
- 预算耗尽
- 单个 Shot 超过 18 秒
- 尾批不足 5 秒且需要重新平衡
- 批次渲染部分失败
- 材料打包时文件缺失或签名 URL 过期

---

## 18. MVP 验收标准

### 功能

- [ ] 输入普通漫画，无需用户提供 PSD
- [ ] 自动分格并建立正确阅读顺序
- [ ] 自动选择 L0/L1/L2/L3
- [ ] 自动生成图层包
- [ ] 至少支持整图、人景和局部状态三类动画
- [ ] 支持推拉、横移、视差、呼吸、眨眼、口型、轻摆、震屏
- [ ] 自动添加对白、配音、字幕、BGM 和音效
- [ ] 自动生成联系表和低清预览
- [ ] 自动修正或降级
- [ ] 最终输出单段在 5～18 秒范围内、通常为 15～18 秒的 1080P MP4
- [ ] 长内容自动按顺序分批输出
- [ ] 尾批不足 5 秒时自动重新平衡相邻批次
- [ ] 向用户交付原始输入、中间图层、音频字幕、工程数据、诊断记录和最终视频

### 可靠性

- [ ] 重试不会重复添加素材或重复扣费
- [ ] 草稿使用 revision 防并发覆盖
- [ ] 图层批量导入原子提交
- [ ] 无 remoteUrl 的素材不能最终渲染
- [ ] 无黑帧和无意时间线空洞
- [ ] 渲染成功后草稿仍可继续修改
- [ ] 任意单镜头处理失败不阻断整部视频
- [ ] 任意单批渲染失败不影响其他已完成批次
- [ ] 服务端拒绝渲染短于 5 秒或超过 18 秒的批次
- [ ] 材料包文件清单、checksum 和下载权限校验通过

### 质量

- [ ] 原漫画角色身份和画风保持稳定
- [ ] 普通镜头不出现明显透明洞
- [ ] 眼睛和嘴巴补丁无明显漂移
- [ ] 动画不露出未补全区域
- [ ] 字幕不遮挡主要人脸
- [ ] 配音、字幕和口型时间基本一致

### 成本

- [ ] 每 Shot 记录实际成本
- [ ] 达到预算阈值时停止非必要增强
- [ ] 普通镜头优先使用 L0/L1
- [ ] 10 分钟标准成片目标低于 200 元
- [ ] 与 Seedance 2.0 同时长基准对照

### 观测

- [ ] 每个项目有 traceId
- [ ] 每个 Shot 有处理阶段和错误原因
- [ ] 能查看供应商调用和费用
- [ ] 能区分 Agent 错误、模型质量错误、供应商错误和渲染错误

---

## 19. 决策记录

### 决策 1：PNG 图层包优先于 PSD

原因：

- AI 服务天然输出 RGBA 图片
- Remotion 直接消费图片
- 避免生成 PSD 后再解析
- JSON 可以准确表达 bounds、anchor 和 motion policy

PSD 仅作为可选导出。

### 决策 2：不在 MVP 部署本地大型模型

原因：

- 当前开发机为 M4 16GB
- 大型拆层模型通常依赖 CUDA 和大显存
- 已有低价阿里云分割
- 云端 API 可按次调用

后续调用量稳定后，再评估租用 L40S/A100 自托管。

### 决策 3：不追求所有镜头完整拆层

原因：

- 成本和失败率过高
- 很多镜头整图运动已经足够
- 动态漫画质量更依赖节奏、配音和构图，而不是每格层数

### 决策 4：Agent 不能直接写工程 JSON

原因：

- 容易生成无效 ID、错误轨序和断裂引用
- 无法保证幂等
- 难以恢复和增量修改

必须通过工具和 Compose API。

### 决策 5：必须建设降级，不承诺模型永不出错

原因：

- 图像分割和补图属于概率模型
- 外部供应商和网络会失败
- 无人生产要求“总能成片”，而不是“所有镜头都完美拆层”

---

## 20. 第一批立即执行事项

按顺序执行：

1. 建立 20～50 镜头真实测试集。
2. 调用现有阿里云分割，记录透明边缘和漫画适配度。
3. 编写 OpenCV 分格技术验证。
4. 选定一个严格 mask inpaint API。
5. 验证眼周/嘴周完整补丁方案。
6. 固化 `LayerPackage` schema。
7. 在 Remotion 实现最小 ImageItem motion 求值。
8. 实现纯图片 `project/create + image/sequence`。
9. 实现目标 15～18 秒、硬范围 5～18 秒的批次规划、分批渲染和单批重试。
10. 实现全量生产材料清单与材料包导出。
11. 用 20 镜头打通预览、分批导出和材料交付。
12. 测量实际成本后再决定是否接入 Qwen Image Layered。

第一阶段不要同时做：

- 完整 PSD 写回
- 复杂粒子系统
- 网格变形
- 完整曲线编辑器
- 本地大型模型部署
- 多供应商全面接入

先证明：

```text
普通漫画
→ 自动分格
→ 低成本分层
→ Agent 自动动画
→ 配音字幕
→ 自动审片
→ 目标 15～18 秒、硬范围 5～18 秒的稳定分批出片
→ 完整生产材料交付
```

---

## 21. 外部参考

- ag-psd：https://github.com/Agamnentzar/ag-psd
- Qwen Image Layered：https://github.com/QwenLM/Qwen-Image-Layered
- Qwen Image Layered API 参考：https://wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-layered
- Qwen Image Edit Inpaint：https://fal.ai/models/fal-ai/qwen-image-edit/inpaint
- See-through：https://github.com/shitagaki-lab/see-through
- SAM 2：https://github.com/facebookresearch/segment-anything-2
- Inpaint Anything：https://github.com/geekyutao/inpaint-anything
- Remotion Lambda 成本示例：https://www.remotion.dev/docs/lambda/cost-example
- Seedance 2.0 火山引擎模型页：https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seedance-2-0

外部 API 价格会变化，实施时必须以供应商控制台和实际账单为准。

---

## 22. 最终结论

该方案技术上可行，并且比“所有镜头使用 Seedance 2.0 生成视频”更适合动态漫画：

- 原画一致性更高
- 镜头和音频更可控
- 可以局部修改
- 素材可以复用
- 单位成片成本显著更低

真正需要建设的不是一个 PSD 导入按钮，而是以下完整闭环：

```text
漫画分析
+ 图层准备
+ Shot/动画模型
+ Agent Compose API
+ 自动质量门禁
+ 幂等与恢复
+ 成本控制
+ 自动降级
```

只要严格执行“普通镜头低成本、重点镜头高质量、失败镜头自动降级”，就可以在不要求人工拆 PSD、不依赖本地大型 GPU 的前提下，让 AI 借助 NovelComic 编辑器自动完成动态漫画生产。

最终交付以“目标 15～18 秒、硬范围 5～18 秒的有序视频批次 + 全量生产材料包”为统一产品形态。长内容不输出单个长视频，而是按 Shot 和对白自然边界分批；不足 5 秒的尾批必须与相邻批次重新平衡。用户不仅获得最终视频，也获得后续复用、修改和重新渲染所需的全部可交付材料。
