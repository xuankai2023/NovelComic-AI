# 动态漫画高级 AE 功能实施方案

> 适用工程：`novelcomic-remotion`  
> 目标：补齐当前动态漫画编辑器尚未支持的高级 AE 类能力。  
> 原则：先建立稳定的数据协议和渲染边界，再逐项增加能力；每个阶段都必须可以独立降级、回滚和验收。

## 1. 目标和范围

本方案覆盖以下九项能力：

1. `.aep` 导入导出。
2. AE 表达式和 Graph Editor。
3. 父子级和 Pre-compose。
4. Mask、Track Matte、Blend Mode。
5. 3D 图层、3D 摄像机、灯光和景深。
6. 骨骼、Live2D 和网格变形。
7. 自动 AI 拆层和自动补图。
8. 音频音素级口型同步。
9. 完整 ZIP 交付打包。

这些能力不应全部直接塞进现有 `UndoableState` 和 `ImageLayer`。建议增加统一的高级合成层，并保持旧工程兼容：

```text
工程 JSON
  → 版本归一化
  → 高级图层协议
  → 运动/遮罩/父子级/3D 求值
  → 统一 Composite Scene
  → Player / 静帧 / Remotion / Lambda
```

## 2. 当前工程边界

### 2.1 可以复用的现有能力

- `UndoableState` 和现有多轨时间线。
- Image、Video、Audio、Text、Captions、GIF 和 Solid item。
- Shot、LayerPackage、motion、sprite 和批次模型。
- Remotion Player 和正式渲染入口。
- 工程校验、静帧预览、批次渲染和 manifest。
- Clean Plate、Cutout、L0 和质量预览。

### 2.2 不建议直接改造的部分

- 不在 React 组件内部复制运动求值。
- 不在渲染阶段随机生成动画或 AI 结果。
- 不通过 `eval` 执行任意 AE 表达式。
- 不直接逆向解析 `.aep` 二进制格式作为第一版方案。
- 不让 AI 服务直接修改工程 JSON。
- 不让 ZIP manifest 代替真实文件校验。
- 不让 3D、Live2D 和网格变形污染普通 2D 图层路径。

## 3. 总体架构

### 3.1 新增能力层

建议增加以下领域模块：

```text
src/editor/advanced/
├── interchange/       # AE/JSON/ZIP 导入导出
├── expressions/       # 安全表达式 AST 和求值
├── composition/       # Pre-compose 和嵌套 Composition
├── hierarchy/         # parent/child 关系和世界变换
├── masks/             # mask、matte、blend
├── three/             # 3D scene、camera、light
├── rigging/           # 骨骼、Live2D、mesh
├── ai-pipeline/       # 拆层、补图、质量门禁
├── lip-sync/          # phoneme、viseme、口型时间轴
└── packaging/         # ZIP、checksum、恢复和下载
```

### 3.2 统一高级图层协议

建议在现有 `Track` 和 `Item` 上增加可选引用，而不是把所有字段直接平铺：

```ts
type AdvancedLayer = {
  id: string;
  itemId: string;
  compositionId?: string;
  parentId?: string;
  transform?: LayerTransform2D | LayerTransform3D;
  masks?: MaskDefinition[];
  matte?: TrackMatteDefinition;
  blendMode?: BlendMode;
  expressionIds?: string[];
  rigBindingId?: string;
  depth?: number;
  enabled: boolean;
};
```

### 3.3 求值顺序

每一帧统一按以下顺序求值：

```text
时间范围
→ Shot / Pre-compose 局部帧
→ parent 世界变换
→ 关键帧和安全表达式
→ 2D 或 3D 几何
→ mask
→ track matte
→ opacity / fade
→ blend mode
→ 子合成叠加
→ camera
→ 景深和后处理
→ 音频/字幕/导出
```

同一套求值结果必须被以下入口复用：

- 编辑器 Canvas。
- Player。
- 静帧预览。
- 本地 Remotion 渲染。
- Lambda 渲染。

## 4. 数据版本和兼容策略

### 4.1 Schema 版本

增加独立能力版本：

```ts
type ProjectSchema = {
  schemaVersion: number;
  advancedSchemaVersion?: number;
  compositions?: CompositionDefinition[];
  expressions?: ExpressionDefinition[];
  hierarchy?: LayerHierarchy;
  aiArtifacts?: AIArtifact[];
  delivery?: DeliveryPackageInfo;
};
```

### 4.2 兼容规则

- 没有 `advancedSchemaVersion` 的工程按普通 2D 工程读取。
- 旧工程不创建默认 parent、mask、3D 或 expression。
- 新字段缺失时使用静态 2D 默认值。
- 高版本工程不能静默降级后覆盖保存。
- 不支持的高级能力应保留原始数据和诊断，不应直接删除。
- 渲染前必须明确选择 `strict` 或 `fallback` 模式。

### 4.3 严格模式和降级模式

```text
strict:
  不支持的高级节点 → 阻止导出并给出错误

fallback:
  不支持的高级节点 → 尝试栅格化或替代渲染，并记录 warning
```

## 5. `.aep` 导入导出

### 5.1 现实边界

`.aep` 是 Adobe After Effects 的专有工程格式，不建议第一版直接逆向解析二进制文件。更可靠的路线是：

```text
AE 插件/脚本
→ 读取 AE 工程
→ 导出公开的中间格式
→ Remotion 导入中间格式
```

导出方向同理：

```text
Remotion 工程
→ 生成 AE 中间格式
→ AE 插件/脚本创建合成、图层和关键帧
→ 由 After Effects 保存为 .aep
```

### 5.2 中间格式

建议定义 `ComicAEExchangePackage`：

```text
project.json
assets/
  images/
  videos/
  audio/
  fonts/
shots.json
layers.json
motions.json
masks.json
expressions.json
manifest.json
```

每个图层至少包含：

- 稳定 `layerId`。
- `name`、`semantic` 和 `zIndex`。
- `from`、`durationInFrames`。
- 画布尺寸和像素比例。
- 2D/3D transform。
- parent 引用。
- mask、matte、blend 引用。
- motion 和 sprite 状态。
- 原始资产 checksum。

### 5.3 AE 侧适配器

建议提供两种适配器：

1. **AE 导出器**
   - 在 AE 中读取 Comp、Layer、Transform、Mask、Marker、Audio 和 Keyframe。
   - 将不支持的属性写入 `unsupportedProperties`。
   - 将源素材复制到交换包。
   - 生成 checksum 和原始路径映射。

2. **AE 导入器**
   - 创建 Comp 和对应图层。
   - 创建图片、视频、音频和文本图层。
   - 写入关键帧、父子级、mask 和部分 blend mode。
   - 对 Remotion 不支持的节点生成占位层或报告。

### 5.4 导入优先级

第一版只支持：

- 图片、视频、音频和文字。
- 2D Transform。
- Opacity。
- 基础关键帧。
- 简单 parent。
- 部分 mask。

第二版再支持：

- Pre-compose。
- Track Matte。
- Blend Mode。
- 3D 基础 transform。

以下内容即使在 AE 中存在，也必须明确报告为不支持：

- 任意插件效果。
- 任意表达式。
- 第三方脚本生成的自定义对象。
- 复杂粒子、Puppet 和不可导出的动态效果。

### 5.5 验收标准

- AE 导出包可以被 Remotion 导入。
- 导入后图层数量、顺序、时间和主要画面一致。
- 2D 关键帧首帧、中间帧、末帧一致。
- 不支持的属性不会静默丢失。
- Remotion 导出的交换包可以被 AE 适配器重新创建。
- 导入失败时原工程保持不变。

## 6. AE 表达式和 Graph Editor

### 6.1 表达式不能直接执行任意 JavaScript

不建议使用：

```ts
eval(expression)
```

应实现受限表达式语言：

```text
Expression Text
→ Lexer
→ Parser
→ AST
→ Dependency Check
→ Safe Evaluator
```

### 6.2 第一版安全表达式

建议先支持以下函数和变量：

- `time`
- `frame`
- `fps`
- `value`
- `seed`
- `linear`
- `ease`
- `clamp`
- `lerp`
- `sin`
- `cos`
- `abs`
- `min`
- `max`
- `randomSeeded`

示例：

```text
value + [sin(time * 2) * 4, 0]
```

不允许：

- 网络请求。
- 文件读取。
- 任意对象访问。
- 任意函数调用。
- 动态导入。
- 修改工程状态。
- 非确定性随机数。

### 6.3 表达式数据结构

```ts
type ExpressionDefinition = {
  id: string;
  property:
    | 'x'
    | 'y'
    | 'scaleX'
    | 'scaleY'
    | 'rotation'
    | 'opacity';
  source: string;
  ast: ExpressionNode;
  dependencies: string[];
  seed?: number;
  enabled: boolean;
};
```

表达式只读输入，不直接修改工程。求值失败时返回：

```ts
{
  value: fallbackValue,
  diagnostics: ['EXPRESSION_EVALUATION_FAILED'],
  usedFallback: true
}
```

### 6.4 Graph Editor

Graph Editor 应编辑统一的 `KeyframeTrack`，而不是另建一套动画数据：

```ts
type KeyframeTrack = {
  property: string;
  keyframes: {
    frame: number;
    value: number;
    easing?: EasingName;
    handleIn?: Point;
    handleOut?: Point;
  }[];
};
```

第一版支持：

- 数值属性曲线。
- 添加、删除、移动关键帧。
- 曲线缩放和平移。
- 线性和缓动切换。
- 曲线值边界预览。

第二版再支持：

- 贝塞尔控制柄。
- 多属性叠加。
- 速度曲线。
- 表达式和关键帧混合。

### 6.5 验收标准

- 同一关键帧在普通时间线和 Graph Editor 中保持一致。
- 修改曲线后 Canvas、Player 和最终渲染一致。
- 表达式执行结果可重复。
- 非法表达式有可见错误，不会导致页面崩溃。
- 表达式不能写入不属于自己的图层或工程状态。

## 7. 父子级和 Pre-compose

### 7.1 父子级

父子级应使用稳定 ID：

```ts
type LayerHierarchy = {
  parentByLayerId: Record<string, string | null>;
};
```

世界变换计算：

```text
localTransform
→ parent localTransform
→ parent parentTransform
→ worldTransform
```

必须处理：

- 位置继承。
- 缩放继承。
- 旋转继承。
- 透明度继承。
- 锚点。
- 父级隐藏。
- 父级锁定。
- 父级循环引用。

### 7.2 父子级限制

- 禁止图层成为自己的父级。
- 禁止形成循环引用。
- 删除父级时必须明确选择“解除父子关系”或“保留世界姿态”。
- 子图层不能脱离 Shot 时间范围。
- 父级跨 Shot 引用必须被拒绝或转换为全局层。

### 7.3 Pre-compose

建议将 Pre-compose 设计为独立 `CompositionDefinition`：

```ts
type CompositionDefinition = {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  layerIds: string[];
  nestedCompositionIds: string[];
};
```

主工程只保留一个 Composition item：

```text
Main Composition
  └── Precomp Item
        └── Child Composition
              ├── Layer A
              ├── Layer B
              └── Layer C
```

### 7.4 Pre-compose 的时间协议

必须明确：

- 子合成局部帧。
- 父合成局部帧。
- 子合成开始帧。
- 子合成入点和出点。
- 子合成是否继承父级 camera。
- 子合成是否允许跨 Shot。

建议统一使用：

```text
childLocalFrame = parentLocalFrame - precomp.from
```

### 7.5 验收标准

- 父级移动、缩放、旋转能影响子级。
- 父级隐藏、锁定和透明度能正确影响子级。
- 解除父子关系后可选择保持当前世界姿态。
- Pre-compose 内部动画和外部动画都能生效。
- 嵌套合成不会造成时间偏移或无限递归。
- Pre-compose 与扁平化结果在支持范围内一致。

## 8. Mask、Track Matte 和 Blend Mode

### 8.1 Mask 数据结构

```ts
type MaskDefinition = {
  id: string;
  layerId: string;
  mode: 'add' | 'subtract' | 'intersect' | 'none';
  inverted: boolean;
  feather: number;
  expansion: number;
  opacity: number;
  path: MaskPath;
  animatedPath?: KeyframeTrack[];
};
```

第一版 Mask 支持：

- 矩形。
- 椭圆。
- 多边形。
- 简单贝塞尔路径。
- Add、Subtract、Intersect。
- Invert。
- Feather。
- Expansion。

### 8.2 Mask 渲染

不要只依赖 CSS `clip-path`，因为 CSS 和正式渲染的细节可能不同。建议使用统一的离屏渲染路径：

```text
source layer
→ offscreen bitmap
→ rasterized mask
→ alpha composite
→ next layer
```

浏览器预览和 Remotion 渲染都使用同一个 mask 计算模块。

### 8.3 Track Matte

```ts
type TrackMatteDefinition = {
  matteLayerId: string;
  type: 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
};
```

求值顺序：

```text
matte layer
→ matte alpha/luma
→ target layer
→ multiply target alpha
```

必须禁止：

- Matte layer 指向自己。
- Matte 循环。
- 跨 Pre-compose 的未定义引用。
- Matte 层被错误导出成普通可见层。

### 8.4 Blend Mode

第一版建议支持：

- `normal`
- `multiply`
- `screen`
- `overlay`
- `darken`
- `lighten`

优先使用统一的 Canvas/WebGL composite 实现，不要让 CSS `mix-blend-mode` 成为唯一正式渲染实现。

### 8.5 验收标准

- Mask 只影响目标图层。
- Mask 动画在关键帧之间连续。
- Track Matte 的 alpha/luma 结果正确。
- Blend Mode 在 Canvas、Player、静帧和最终渲染一致。
- mask、matte 和 blend 的嵌套组合不会产生黑边或透明错误。
- 不支持的混合模式进入严格模式时阻止导出，降级模式时产生 warning。

## 9. 3D 图层、3D 摄像机、灯光和景深

### 9.1 技术路线

3D 能力不建议在现有 2D DOM 图层上继续堆叠。建议新增 Three.js 或等价 WebGL 场景：

```text
3D Layer Graph
→ Three.js Scene
→ Camera
→ Lights
→ Depth / Postprocessing
→ Canvas Texture
→ Remotion Frame
```

编辑器 Canvas 和 Remotion 渲染必须使用同一套场景描述和材质参数。

### 9.2 3D 图层数据

```ts
type Transform3D = {
  position: {x: number; y: number; z: number};
  rotation: {x: number; y: number; z: number};
  scale: {x: number; y: number; z: number};
  anchor: {x: number; y: number; z: number};
};

type Camera3D = {
  projection: 'perspective' | 'orthographic';
  position: Point3D;
  rotation: Point3D;
  focalLength?: number;
  fieldOfView?: number;
  near: number;
  far: number;
};
```

### 9.3 灯光

第一版支持：

- Ambient light。
- Directional light。
- Point light。

每个灯光至少有：

- 位置。
- 颜色。
- 强度。
- 衰减。
- 是否投射阴影。

### 9.4 景深

景深建议作为渲染后处理，不直接修改原始图层：

```text
scene color
→ depth buffer
→ focus distance
→ bokeh postprocess
→ output frame
```

需要明确：

- focus distance。
- aperture。
- blur amount。
- near/far blur。

### 9.5 动态漫画的实际优先级

动态漫画首版不必追求完整影视级 3D。建议先实现：

1. 2.5D 平面图层。
2. 正交摄像机。
3. 位置、旋转和深度排序。
4. 简单透视摄像机。
5. 环境光和方向光。
6. 景深后处理。

### 9.6 验收标准

- 2.5D 图层按 z 深度和摄像机移动产生视差。
- 摄像机运动不会造成错误裁切或黑边。
- 透视变化在 Canvas 和最终渲染一致。
- 灯光不会影响不支持 3D 的普通图层。
- 景深只影响画面模糊，不改变图层时间和位置。
- 无 WebGL 或 Lambda 不支持时，可以回退到 2D 或阻止严格导出。

## 10. 骨骼、Live2D 和网格变形

### 10.1 分阶段实现

这三类能力复杂度不同，不应一次实现：

| 阶段 | 能力 |
|---|---|
| R1 | 2D 骨骼、刚性部件绑定 |
| R2 | Mesh 顶点变形和权重 |
| R3 | Live2D/外部运行时适配 |

### 10.2 骨骼数据

```ts
type Bone = {
  id: string;
  parentId?: string;
  restTransform: Transform2D;
  animatedTransform?: KeyframeTrack[];
};

type BoneBinding = {
  layerId: string;
  boneId: string;
  offset: Transform2D;
  weight?: number;
};
```

第一版骨骼只支持刚性图层：

```text
bone transform
→ bound image transform
→ layer render
```

### 10.3 网格变形

```ts
type MeshBinding = {
  layerId: string;
  vertices: Point2D[];
  indices: number[];
  weights: Record<string, number[]>[];
  restVertices: Point2D[];
};
```

需要 WebGL 或 Canvas 变形路径。普通 CSS transform 无法实现可靠的网格变形。

### 10.4 Live2D

Live2D 应采用适配器，不应复制整个运行时：

```text
Live2D model
→ external runtime adapter
→ rendered frame / transparent sequence
→ Remotion video or image item
```

第一版可采用透明视频或序列帧作为交付方式，后续再考虑在编辑器中实时运行 Live2D。

### 10.5 降级方案

- 没有骨骼数据：回退到普通图层运动。
- Mesh 无法渲染：回退到原始 PNG。
- Live2D 运行时不可用：使用预渲染透明视频。
- 权重异常：保留静态姿态并生成 warning。

### 10.6 验收标准

- 骨骼父子关系和关节运动连续。
- 图层绑定不会漂移。
- 网格变形边界没有破洞或黑边。
- Live2D 透明输出能正确叠加到动态漫画场景。
- 保存重载后绑定和动画保持一致。

## 11. 自动 AI 拆层和自动补图

### 11.1 总体流程

```text
原图
→ 任务创建
→ 主体/人物分割
→ 语义部件检测
→ mask 后处理
→ Clean Plate / Inpaint
→ 图层包生成
→ 质量诊断
→ 人工确认或自动降级
```

### 11.2 AI 任务状态

```ts
type AIJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs-review';
```

每个 AI 任务必须保存：

- `jobId`。
- `inputAssetId`。
- `inputChecksum`。
- 模型和版本。
- 参数。
- 供应商请求 ID。
- 结果资产 ID。
- 置信度。
- 诊断。
- 重试次数。

### 11.3 拆层策略

建议分三级：

#### L0：整图

不拆层，直接使用原图做推拉、横移和转场。

#### L1：人物和背景

拆出人物、背景和前景，支持有限视差。

#### L2：语义部件

拆出头、身体、头发、眼睛、嘴巴、手臂和效果层，支持局部运动和 sprite。

#### L3：复杂多部件

仅在高价值镜头使用，包含多次补图、遮挡推断和人工复核。

### 11.4 自动补图

补图流程必须使用 source + mask：

```text
source image
→ target mask
→ inpaint request
→ candidate clean plate
→ edge / alpha / recomposition diagnostics
→ accept or reject
```

不能直接覆盖原图。每个候选结果需要：

- 原图引用。
- mask 引用。
- 生成提示词或参数。
- 模型版本。
- checksum。
- 质量分数。
- 是否被接受。

### 11.5 质量门禁

至少检查：

- Clean Plate 尺寸。
- mask 和 source 尺寸一致。
- alpha 洞比例。
- 重组差异。
- 边缘伪影。
- 人物残影。
- 运动后暴露区域。
- 关键区域人工确认状态。

建议结果：

```text
score >= passThreshold      → 自动通过
warningThreshold <= score   → 进入人工复核
score < warningThreshold    → 自动回退到上一等级
```

### 11.6 人工复核

AI 拆层完成后必须提供：

- Source 预览。
- Layers 预览。
- Normal 重组预览。
- Overlay。
- Difference。
- 透明洞提示。
- 接受、重试、修改 mask、回退 L0/L1 的按钮。

### 11.7 验收标准

- AI 任务失败不会破坏原工程。
- 同一输入 checksum 可以命中缓存。
- 失败可重试，重试不会重复创建孤立图层。
- 拆层结果能进入现有 LayerPackage 流程。
- 补图结果通过质量门禁后才允许隐藏 L0。
- 低置信或高风险镜头自动降级。

## 12. 音频音素级口型同步

### 12.1 处理流程

```text
音频
→ ASR
→ forced alignment
→ phoneme sequence
→ viseme mapping
→ mouth state timeline
→ spriteStates
→ 逐帧渲染
```

### 12.2 数据结构

```ts
type PhonemeSpan = {
  phoneme: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

type VisemeSpan = {
  viseme: string;
  startFrame: number;
  endFrame: number;
};

type LipSyncTrack = {
  dialogueItemId: string;
  language: string;
  phonemes: PhonemeSpan[];
  visemes: VisemeSpan[];
  mouthAssetByViseme: Record<string, string>;
  maxSwitchesPerSecond: number;
};
```

### 12.3 Viseme 映射

不能直接把每个 phoneme 当成一张嘴图。应先归并为少量视觉状态：

```text
closed
→ bilabial
→ open
→ wide
→ round
→ teeth
→ rest
```

不同语言使用不同映射表：

- 中文。
- 英文。
- 日文。
- 其他语言后续扩展。

### 12.4 时间边界

- 所有音频时间最终转换为工程帧。
- 采用明确的取整规则。
- 口型不能越出对白时间。
- 相邻状态过短时合并。
- 限制每秒最大切换次数。
- 对低置信 phoneme 使用上一状态或中性状态。

### 12.5 和现有 mouth-flap 的关系

现有规则口型应保留为 fallback：

```text
phoneme lip sync 成功 → 使用 viseme 时间轴
phoneme 失败或未配置 → 使用 mouth-flap 规则
音频失败             → 使用静止嘴型或字幕降级
```

### 12.6 验收标准

- 口型只发生在对白期间。
- 音频开始和结束边界没有明显提前或滞后。
- 同一音频和配置重复处理结果一致。
- 口型切换不会超频闪烁。
- Canvas、Player、静帧和最终视频一致。
- phoneme 服务失败时能回退到规则 mouth-flap。

## 13. 完整 ZIP 交付打包

### 13.1 交付目录

建议标准目录：

```text
delivery/
├── project/
│   ├── project.json
│   ├── shots.json
│   └── advanced.json
├── assets/
│   ├── source/
│   ├── layers/
│   ├── clean-plates/
│   ├── masks/
│   ├── sprites/
│   ├── audio/
│   └── fonts/
├── previews/
│   ├── contact-sheet.png
│   ├── first-frame.png
│   ├── middle-frame.png
│   └── last-frame.png
├── renders/
│   ├── batch-000.mp4
│   └── batch-001.mp4
├── diagnostics/
│   ├── validation.json
│   ├── quality.json
│   └── ai-jobs.json
├── manifest.json
└── checksums.sha256
```

### 13.2 Manifest

```ts
type DeliveryManifest = {
  packageId: string;
  projectId: string;
  schemaVersion: number;
  createdAt: string;
  files: {
    path: string;
    category: string;
    size: number;
    sha256: string;
    contentType: string;
    required: boolean;
  }[];
  batches: {
    batchId: string;
    batchIndex: number;
    startFrame: number;
    endFrame: number;
    durationInFrames: number;
    videoPath?: string;
  }[];
  warnings: string[];
};
```

### 13.3 打包流程

```text
收集工程和资产
→ 检查文件存在
→ 计算 size 和 checksum
→ 生成 manifest
→ 校验 manifest 与文件数量
→ 写入 ZIP
→ 重新解压到临时目录
→ 二次校验 checksum
→ 上传对象存储
→ 返回下载信息
```

不能只生成 manifest 而不检查文件是否真实存在。

### 13.4 ZIP 生成要求

- 文件路径必须规范化，禁止路径穿越。
- 不允许把租户外文件写入 ZIP。
- 对大文件使用流式打包。
- 支持取消。
- 支持失败后清理临时文件。
- 支持重复请求幂等。
- 使用 package ID 和输入 revision 生成稳定任务键。
- 上传后再次校验对象大小和 checksum。
- 下载时检查权限、过期时间和租户归属。

### 13.5 验收标准

- ZIP 可以完整下载和解压。
- manifest 中每个 required 文件都真实存在。
- 解压后 checksum 全部匹配。
- 工程 JSON 可以重新加载。
- 预览帧、音频、字幕、图层和视频可被识别。
- 任何一个文件缺失时打包失败或明确标记 warning。
- 相同工程和 revision 重复打包不会生成重复业务结果。

## 14. API 和任务边界

### 14.1 建议 API

```text
POST /api/advanced/aep/import
POST /api/advanced/aep/export
POST /api/advanced/expression/validate
POST /api/advanced/expression/apply
POST /api/advanced/composition/create
POST /api/advanced/composition/flatten
POST /api/advanced/mask/apply
POST /api/advanced/matte/apply
POST /api/advanced/three/render-preview
POST /api/advanced/rig/create
POST /api/advanced/ai/layer-job
POST /api/advanced/ai/inpaint-job
POST /api/advanced/lip-sync/create
POST /api/advanced/package/create
GET  /api/advanced/jobs/:jobId
GET  /api/advanced/package/:packageId
```

### 14.2 任务共性

所有异步任务都应返回：

- `jobId`。
- `status`。
- `retryable`。
- `progress`。
- `diagnostics`。
- `inputRevision`。
- `resultRevision`。
- `providerRequestId`，如有外部供应商。

### 14.3 原子性

高级能力必须遵循：

```text
读取工程
→ 校验输入
→ 计算候选结果
→ 校验候选结果
→ 一次性写入新工程
```

失败时返回原工程，不允许半写入。

## 15. 推荐实施阶段

### 阶段 A：交付和 AI 基础

优先实现：

1. 完整 ZIP 交付打包。
2. AI 拆层任务。
3. 自动补图任务。
4. AI 质量门禁和人工复核。
5. 音素级口型同步。

原因：这些能力直接提升动态漫画生产闭环，且可以复用现有 LayerPackage、Clean Plate、sprite 和 manifest。

### 阶段 B：2D 合成基础

实现：

1. 父子级。
2. Pre-compose。
3. Mask。
4. Track Matte。
5. Blend Mode。
6. Graph Editor。
7. 安全表达式。

原因：这些能力共享统一的 2D 合成和求值基础。

### 阶段 C：AE 交换

实现：

1. `ComicAEExchangePackage`。
2. AE 导出脚本/插件。
3. Remotion 导入。
4. Remotion 导出。
5. AE 侧导入脚本。
6. 不支持属性报告。

不要在没有交换协议的情况下直接做 `.aep` 二进制解析。

### 阶段 D：2.5D 和 3D

实现：

1. 2.5D 平面图层。
2. 深度排序。
3. 正交和透视摄像机。
4. 环境光和方向光。
5. 简单景深。
6. Three.js 与 Remotion 帧渲染一致性。

### 阶段 E：骨骼、网格和 Live2D

实现：

1. 刚性 2D 骨骼。
2. Mesh 顶点变形。
3. Live2D 透明视频/序列帧适配。
4. 后续再评估实时 Live2D runtime。

## 16. 测试计划

### 16.1 单元测试

- 表达式 AST 解析和安全性。
- 表达式确定性。
- parent 世界变换。
- 循环 parent 拒绝。
- Pre-compose 局部帧换算。
- Mask 布尔组合。
- Matte alpha/luma。
- Blend Mode。
- 3D 相机投影。
- 骨骼变换。
- Viseme 映射和边界。
- ZIP 路径安全和 checksum。

### 16.2 集成测试

- 高级工程保存和重载。
- 普通 2D 工程不受新字段影响。
- Pre-compose 与 Shot 同时存在。
- Mask、matte 和 blend 同时作用。
- AI 拆层失败回退 L0。
- AI 补图失败保留原图。
- phoneme 服务失败回退 mouth-flap。
- ZIP 生成后重新解压和加载。
- 本地渲染与 Lambda 渲染一致。

### 16.3 人工视觉测试

每个高级功能至少验证：

- 首帧。
- 中间帧。
- 末帧。
- Shot 边界。
- 保存重载。
- Canvas/Player/静帧/最终视频一致性。
- 失败和回退画面。

可沿用：

[动态漫画 AE 类功能人工校验步骤.md](./动态漫画AE类功能人工校验步骤.md)

并为本文新增能力补充以下人工章节：

- AEP 交换结果对比。
- 表达式和曲线结果对比。
- parent 和 Pre-compose 对比。
- Mask/matte/blend 叠加对比。
- 3D 透视和景深对比。
- AI 拆层和补图人工复核。
- 音频和 phoneme 口型同步。
- ZIP 解压和 checksum 复核。

## 17. 完成标准

### P0：生产闭环

- [ ] AI 拆层失败可以回退 L0。
- [ ] 自动补图不会覆盖原图。
- [ ] phoneme 失败可以回退规则口型。
- [ ] ZIP 包实际包含 manifest 声明的文件。
- [ ] ZIP 解压后 checksum 全部通过。
- [ ] 普通工程和旧工程不受影响。

### P1：高级 2D

- [ ] parent 变换正确。
- [ ] Pre-compose 时间和坐标正确。
- [ ] Mask、Track Matte、Blend Mode 可组合。
- [ ] Graph Editor 和普通关键帧数据一致。
- [ ] 安全表达式可确定性求值。

### P2：外部交换

- [ ] AE 中间格式可以从 AE 导出。
- [x] Remotion 可以导入中间格式。
- [ ] Remotion 可以导出中间格式。
- [x] 不支持的 AE 属性有明确报告。
- [ ] 不会静默丢失素材或关键帧。

### P3：3D 和高级变形

- [ ] 2.5D 视差和摄像机可用。
- [ ] 3D 基础摄像机和灯光可用。
- [ ] 景深在正式渲染中可用。
- [ ] 骨骼绑定和网格变形可保存、重载和渲染。
- [x] Live2D 预渲染适配结果可进入动态漫画工程。

## 18. 风险和决策

### 18.1 不要一次实现全部功能

这些能力横跨：

- 工程协议。
- 编辑器交互。
- 2D 合成。
- WebGL/3D。
- AI 异步任务。
- 外部 AE 适配。
- 媒体打包和对象存储。

应按阶段交付，每阶段都有可用的动态漫画结果。

### 18.2 不支持就显式报告

导入或渲染遇到不支持能力时，不允许：

- 静默删除。
- 伪装成已经还原。
- 只显示按钮成功。
- 生成无法解释的画面差异。

必须在报告中显示：

- 属性路径。
- 不支持原因。
- 是否使用了降级。
- 降级后的画面风险。

### 18.3 动态漫画优先级

对当前产品，推荐优先级为：

```text
AI 拆层/补图
→ 音素级口型
→ ZIP 交付
→ parent/Pre-compose
→ mask/matte/blend
→ Graph Editor/表达式
→ 2.5D/3D
→ 骨骼/网格/Live2D
→ 完整 AEP 往返
```

优先完成能够直接提升“漫画输入 → 动态视频 → 可交付材料”成功率的能力，再实现完整 AE 兼容。
