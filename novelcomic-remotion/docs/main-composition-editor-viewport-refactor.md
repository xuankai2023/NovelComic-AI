# 主合成编辑视口重构方案

> 状态：实施方案
> 日期：2026-10-05
> 适用范围：Remotion 主合成画布、时间轴剪辑、图层变换、动效编辑和最终成片

## 1. 目标与结论

当前主画布是 `Remotion Player` 外层加 CSS 缩放、平移和 React 工具组件。它可以预览合成，但还不是一个完整的 AE 风格编辑视口：相机、图层交互、选区覆盖层和 Remotion 渲染职责混在一起，Pointer Move 期间也容易触发过多 React State 更新。

本方案的结论是：

> 保留 Remotion 作为主合成的真实预览和最终渲染引擎，重构其外层为 AE 风格的 EditorViewport；将相机、交互、覆盖层和渲染后端拆开；WebGL2 只用于蒙版、抠图、静态图像和高频像素编辑，不替换整个 Remotion 合成器。

目标架构：

```text
EditorShell
├── EditorState.undoableState (唯一持久化项目状态)
├── EditorViewport
│   ├── ViewportController
│   ├── RemotionPreviewSurface
│   ├── OverlaySurface
│   └── InteractionController
├── Timeline
└── ExportPipeline
```

数据和渲染边界：

```text
Project State     = 图层、时间、动效、蒙版的真实数据
Viewport State    = 缩放、平移、旋转、DPR
Remotion Player   = 主合成当前帧预览与最终渲染
Overlay Surface   = 选框、手柄、路径、参考线、工具光标
WebGL Surface     = 蒙版/静态图像的局部 GPU 编辑
React State       = 工具选择、面板参数和低频 UI 状态
```

## 2. AE 主画布的工作方式

AE 的主画布不是单一 Canvas。它至少包含以下逻辑层：

1. 项目和合成模型：保存图层、时间范围、关键帧、效果和嵌套合成。
2. 当前时间帧：时间轴修改当前帧，合成预览渲染该帧。
3. 预览渲染器：使用缓存、代理、GPU 合成和降级质量保证交互帧率。
4. 文档视口：独立维护缩放、平移、旋转、Fit 和 100%。
5. 编辑覆盖层：在预览内容上绘制边界框、锚点、路径、标尺和参考线。
6. 最终渲染器：读取同一个项目模型，但以高质量、可重复方式输出成片。

因此，AE 风格的关键不是把所有内容画到 WebGL Canvas，而是把“合成内容”和“编辑视口”分离。

### 2.1 生产级门禁

当前方案的方向正确，但在补齐以下门禁前，不能称为“动态漫画编辑器完成”：

- 当前帧编辑必须明确是修改静态基值还是创建/修改关键帧，不能用一次 `transform` 写入覆盖整段动画。
- 预览、Overlay、时间轴和导出必须使用同一个帧评估结果；不能各自维护 `currentFrame` 或重复计算父子变换。
- Object Matte / Roto Brush 必须支持按帧或按 Span 的 Matte 引用，并能被最终渲染器读取；单个 `maskAssetId` 只能表达静态蒙版。
- Viewport 的旋转、DPR、纹理 Y 方向和 CSS/device 坐标必须有统一矩阵契约；未实现旋转时必须固定为 `0`，不能保留“看起来支持”的字段。
- 所有异步解码、分割、传播、上传和导出都必须可取消，并通过版本号防止旧结果回写新会话。

## 3. 当前代码问题

### 3.1 主画布职责过重

当前主要文件：

- `src/editor/canvas/canvas.tsx`
- `src/editor/canvas/scaled-player.tsx`
- `src/editor/canvas/player.tsx`
- `src/editor/preview-size.tsx`
- `src/editor/preview-size-provider.tsx`

`Canvas` 同时处理：

- 缩放和平移状态
- 鼠标滚轮和空格拖拽
- Remotion Player 布局
- 画布尺寸测量
- 工具模式切换
- 时间轴和质量预览上下文

`ScaledPlayer` 又通过 CSS `transform: scale()`、DOM 宽高和 margin 修正来定位合成。这会导致：

- 主画布与选择并遮住画布的坐标系统不一致。
- Overlay 组件需要重复实现坐标换算。
- Pointer Move 期间更新 React State，拖动复杂图层时容易抖动。
- 未来加入旋转、标尺、参考线和嵌套合成时边界不清晰。

### 3.2 编辑数据和临时交互没有明确分层

拖动、缩放、旋转属于一个连续交互，但最终项目状态需要一次性提交。若每个 Pointer Move 都直接写入项目 State，会造成：

- Undo 栈生成大量无意义步骤。
- 时间轴、Inspector、Player 和 Overlay 高频联动。
- 中高分辨率视频预览时交互延迟增加。

### 3.3 主合成和像素编辑的渲染需求不同

主合成需要支持视频、音频、文字、表达式、字幕、动效和 Remotion 组件；选择并遮住需要 MaskDocument、局部纹理上传、笔刷和像素网格。两者应共享视口基础设施，但不应强行使用同一个渲染后端。

### 3.4 当前实现审计结论

以下能力目前只能视为“部分存在”，不能在实施计划中按已完成能力计算：

| 能力 | 当前状态 | 生产门禁 |
| --- | --- | --- |
| Viewport 旋转 | `ViewportTransform` 有字段，但 `ViewportController` 的正逆变换未使用旋转 | 第一阶段固定为 `0`，或补齐完整矩阵和所有命中测试 |
| 高 DPI | Controller 和 Renderer 都记录 DPR，但缺少跨 DPR 的 GPU/Overlay 一致性测试 | 覆盖 DPR `1/1.25/1.5/2/3`、Resize 和奇数尺寸 |
| 动效关键帧 | `AdvancedProjectState` 已有 `motion.keyframes` 和 frame evaluator | 交互命令必须定义当前帧写入规则，不得直接覆盖基础 transform |
| Matte 持久化 | `ComicEditLayer.matte` 目前只有单个 `maskAssetId` 和 `frozen` | 增加 Frame/Span/Freeze Cache 引用，并接入导出解析 |
| 项目状态 | `UndoableState` 同时包含 `advanced` 和 `comicEditLayers` | 通过 Project Model Gateway 做原子读写和迁移 |
| GPU 失败恢复 | 有 Context Lost 监听和 Canvas2D fallback 入口 | 覆盖纹理分配失败、R8 不可用、旧异步结果和资源释放 |

已有的基础测试通过，不等于上述门禁通过；实施时必须把这些门禁写成自动化测试或可重复的浏览器验收记录。

## 4. 目标模块结构

建议新增目录：

```text
src/editor/viewport/
├── editor-viewport.tsx
├── viewport-controller.ts
├── viewport-store.ts
├── viewport-types.ts
├── viewport-math.ts
├── remotion-preview-surface.tsx
├── overlay-surface.tsx
├── interaction-controller.ts
├── transient-transform-store.ts
└── render-invalidation.ts
```

已有的选择并遮住模块继续复用同一套 `ViewportController`：

```text
src/editor/layer-panel/
├── document-viewport/
├── renderer/
├── brush/
├── history/
└── mask/
```

### 4.1 ViewportController

唯一维护相机变换：

```ts
type ViewportTransform = {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
  devicePixelRatio: number;
};

interface ViewportController {
  setViewportSize(width: number, height: number, dpr?: number): void;
  setDocumentSize(width: number, height: number): void;
  screenToDocument(point: Point): Point;
  documentToScreen(point: Point): Point;
  zoomAt(screenPoint: Point, nextZoom: number): void;
  panBy(delta: Point): void;
  fit(padding?: number): void;
  actualPixels(): void;
  getTransform(): ViewportTransform;
}
```

要求：

- GPU Canvas 和 Overlay Canvas CSS 尺寸始终等于 Viewer 可用区域。
- backing store 尺寸为 CSS 尺寸乘以 DPR。
- 缩放不再通过放大 Canvas DOM 尺寸实现。
- 主合成和选择并遮住使用同一套 Screen/Document 坐标转换。
- 变换测试误差小于 0.25 个文档像素。
- `screen` 使用 Viewer 内容区 CSS px，`device` 只用于 backing store 和绘制线宽；DPR 不得改变 100% 的逻辑缩放。
- 第一阶段若不实现旋转，`rotation` 必须固定为 `0`，并在类型和验收中标记为未启用；实现旋转时必须改用完整 affine matrix，同时更新 hit test、边界框、吸附和 Overlay。
- WebGL shader 的 viewport uniform 必须与其实际 device backing size 一致，或在 shader 内显式完成 CSS → device 转换；不能混用两种单位。

### 4.2 RemotionPreviewSurface

主合成不直接改写为 WebGL。`RemotionPreviewSurface` 负责包裹现有 `RemotionPlayer`：

```text
EditorViewport
└── RemotionPreviewSurface
    └── RemotionPlayer
        └── MainComposition
```

它只负责：

- 根据 ViewportController 定位 Player。
- 把合成尺寸、当前帧、FPS 和时长传入 Player。
- 在播放时切换预览质量。
- 在编辑状态下暂停或定位当前帧。
- 为 Overlay 提供相同的合成边界和变换。

Remotion Player 仍然是最终画面语义的来源，不能以截图纹理替代。

### 4.3 OverlaySurface

OverlaySurface 使用独立 Canvas 或 SVG 层，不写入导出结果：

- 选中图层边界
- 角点和边缘缩放手柄
- 旋转手柄
- 锚点
- 裁剪框
- 路径和节点
- 对齐线、标尺和安全框
- 画笔光标和像素网格

Overlay 动画和 Pointer Move 不应触发主项目 State 更新。

### 4.4 InteractionController

InteractionController 根据当前工具、Pointer 状态和相机变换生成编辑意图：

```text
Pointer Event
  → screenToDocument
  → hit test
  → transient transform / tool operation
  → Overlay 即时更新
  → Pointer Up
  → command
  → project state + undo transaction
```

工具应输出命令，而不是直接修改组件内部状态：

```ts
type EditorCommand =
  | {type: 'move-item'; itemId: string; frame: EditFrameContext; from: Point; to: Point}
  | {type: 'resize-item'; itemId: string; frame: EditFrameContext; from: Size; to: Size}
  | {type: 'rotate-item'; itemId: string; frame: EditFrameContext; from: number; to: number}
  | {type: 'crop-item'; itemId: string; frame: EditFrameContext; from: Crop; to: Crop}
  | {type: 'edit-mask'; itemId: string; frame: EditFrameContext; transaction: MaskTransaction};

type EditFrameContext = {
  rootFrame: number;
  compositionId: string;
  localFrame: number;
  fps: number;
  mode: 'base-value' | 'keyframe';
};
```

命令必须带版本、事务 ID、目标项目修订号和可逆的 before/after 快照。空操作（没有实际像素或数值变化）不得进入 Undo；`PointerCancel`、失焦、组件卸载和切换 Tab 必须结束或取消当前事务，不能留下半个命令。

## 5. 主画布状态模型

### 5.1 持久化状态

持久化状态继续使用现有项目模型：

- composition
- tracks
- items
- startFrame / durationInFrames
- transform
- opacity
- crop
- masks
- motion profile
- captions

这些数据由 `src/editor/state` 和现有写入上下文管理。

### 5.2 临时状态

以下状态不能在拖动过程中直接写入项目 State：

- 当前 Pointer 位置
- 正在拖动的图层临时位置
- 正在调整的尺寸
- 旋转角度预览值
- 当前 Hover 图层
- 画笔光标
- 当前 Overlay dirty rect

临时状态可以放在 `useRef`、外部 store 或专用 interaction controller 中，Pointer Up 后再提交。

### 5.3 时间状态

时间轴是主合成的时间来源：

```text
Timeline seek
  → playerRef.seekTo(frame)
  → MainComposition render current frame
  → Overlay 使用相同 frame 做 hit test 和绘制
```

预览、编辑和导出不能维护三套不同的时间状态。

### 5.4 动效编辑语义

动态漫画的“拖动图层”不是静态图片编辑，必须先定义当前帧写入规则：

1. `rootFrame`、嵌套合成的 `localFrame` 和源视频帧必须明确区分，所有帧都使用整数并限制在有效区间。
2. 图层存在 `motion.keyframes` 时，默认在当前帧创建或更新关键帧，并保留相邻关键帧的 easing；不得把当前值写回基础 `transform` 从而破坏整段动画。
3. 用户明确关闭自动关键帧时，才允许修改基础值，并且 Inspector、Timeline 和 Overlay 必须显示这是“全时段修改”。
4. 父子层、Precompose、Time Offset、表达式和锁定状态必须由同一个 frame evaluator 计算；交互层只能消费评估结果，不能自己拼接父变换。
5. 旋转、缩放和裁剪的命令必须记录编辑空间（local/world/source），否则在父层或嵌套合成下无法可靠撤销。

### 5.5 动态 Matte 数据契约

静态蒙版和逐帧 Matte 不能共用一个“单文件蒙版”假设：

```ts
type MatteReference =
  | {type: 'still-mask'; maskAssetId: string}
  | {type: 'frame-mask'; frames: Record<number, string>; sourceRevision: string}
  | {type: 'span-cache'; spans: MatteSpanRef[]; frozenRevision: string};

type MatteSpanRef = {
  startFrame: number;
  endFrame: number;
  direction: 'forward' | 'backward';
  cacheAssetId: string;
  algorithmRevision: string;
};
```

Object Matte / Roto Brush 的 Base Frame、修正笔画、传播 Span、Freeze 状态和缓存版本必须可持久化；导出时按 `rootFrame → sourceFrame → matteReference` 解析，不能只读取当前编辑页签的临时 `MaskDocument`。缓存失效必须由源素材版本、算法参数、笔画版本和项目修订号共同决定。

### 5.6 预览缓存与失效

所有预览请求使用同一类缓存键：

```ts
type RenderRequestKey = {
  projectRevision: string;
  compositionId: string;
  frame: number;
  quality: 'draft' | 'preview' | 'final';
  assetRevision: string;
  renderer: 'remotion' | 'layer-webgl' | 'canvas2d';
};
```

任何图层、关键帧、Matte、代理素材、字体、表达式或合成尺寸变化都必须递增对应 revision 并使旧请求失效。旧异步结果即使晚到也不得覆盖新帧；播放器、Overlay 和导出必须消费同一份 evaluated frame，而不是各自从缓存猜测状态。

### 5.7 生命周期与失败恢复

- 资源加载、视频解码、AI 分割、Matte 传播、纹理上传和导出都使用 `AbortController` 或等价取消协议。
- 切换图层、关闭页签、撤销、提交和重新加载项目时，旧任务必须停止或丢弃结果。
- 当前笔画、GPU Context、Worker、Object URL、RAF 和 Pointer Capture 都必须有明确的释放路径。
- 导出或“确定”操作先固定项目修订号和 Mask 版本；导出期间继续编辑时，导出固定快照，不读取半新半旧状态。
- 资源缺失、解码失败、纹理超限或 WebGL Context 丢失时，保留项目状态并进入可见的降级/重试状态，不能创建空白蒙版覆盖原内容。

## 6. 渲染策略

### 6.1 播放状态

- Remotion Player 正常播放。
- 降低非必要 Overlay 更新频率。
- 暂停复杂边缘分析和像素网格。
- 视频可以使用代理素材或低质量预览。

### 6.2 编辑状态

- Player 定位到当前帧并暂停。
- Overlay 响应 Pointer Move。
- 图层变换先走 transient transform。
- Pointer Up 后提交一个命令和一个 Undo transaction。

### 6.3 高质量预览

- 恢复原始素材或高质量代理。
- 重新计算蒙版、边缘和效果。
- 等待静止后再执行高成本操作。

### 6.4 WebGL2 的使用范围

适合 WebGL2：

- 静态图片预览
- Mask / Alpha 合成
- Overlay、On Black、On White、Black & White
- 像素网格
- 局部纹理上传
- 选择并遮住笔刷

暂不建议 WebGL2 接管：

- Remotion 视频播放
- 音频时钟
- React 文字组件
- 表达式和动态组件
- 最终导出合成

## 7. 分阶段迁移计划

### 阶段 0：建立保护线

目标：确保重构前后成片结果一致。

- 固定当前主合成截图和导出样本。
- 增加 `screenToDocument` / `documentToScreen` 测试。
- 增加图层变换命令的 undo/redo 测试。
- 记录 Fit、100%、缩放和平移的行为基线。
- 保留现有 `PreviewSizeContext` 作为 feature flag fallback。

完成标准：

- 当前项目仍能正常播放和导出。
- 新旧视口对同一坐标的误差小于 0.25 文档像素。

### 阶段 1：统一 ViewportController

改造文件：

- `src/editor/canvas/canvas.tsx`
- `src/editor/canvas/scaled-player.tsx`
- `src/editor/preview-size.tsx`
- `src/editor/preview-size-provider.tsx`
- `src/editor/layer-panel/document-viewport/viewport-controller.ts`

工作内容：

- 主画布接入 `ViewportController`。
- 删除主画布和选择并遮住之间重复的缩放数学。
- 统一鼠标中心缩放和空格拖拽。
- 保持 Remotion Player 的输出不变。

完成标准：

- 主合成和选择并遮住的 100% 都表示一个源像素对应一个文档像素。
- Resize 不改变文档点的位置。
- 不再依赖放大 Canvas DOM 尺寸实现缩放。

### 阶段 2：拆出 RemotionPreviewSurface

目标：让主画布只负责视口和 Player 容器。

- 将 `ScaledPlayer` 的布局逻辑迁移到 `RemotionPreviewSurface`。
- `Canvas` 只负责工具路由、相机和编辑上下文。
- 保留 `CanvasTransformationContext`，但改为从 ViewportController 派生。
- 给 Player 添加编辑态/播放态切换。

完成标准：

- 播放、暂停、seek 和导出结果不变。
- 主画布相机变化不触发项目 State 写入。

### 阶段 3：统一 OverlaySurface

- 迁移 `selection-border` 到统一 Overlay。
- 迁移 snapping、crop、pen path 和 brush cursor。
- 所有 Overlay 使用统一 Document → Screen 转换。
- 增加 Overlay dirty rect 和 requestAnimationFrame 调度。

完成标准：

- 缩放、平移和旋转后选框不偏移。
- Overlay 不进入视频导出。
- Pointer Move 不触发整棵 React 编辑器重渲染。

### 阶段 4：Transient Transform 与命令提交

- 移动、缩放、旋转、裁剪使用临时交互状态。
- Pointer Up 生成一个 `EditorCommand`。
- 命令进入项目 State 和 Undo 栈。
- Inspector、Timeline 和 Canvas 共享命令结果。

完成标准：

- 一次拖动只产生一个 Undo 步骤。
- 拖动视频图层时保持可交互帧率。
- 刷新或撤销后 Player、Timeline、Inspector 一致。

### 阶段 5：预览缓存和代理素材

- 视频层增加代理预览接口。
- 静态图层增加纹理缓存。
- 当前帧变化时只更新受影响的预览。
- 停止操作后执行高质量刷新。

完成标准：

- 多视频图层播放时不因 Overlay 或 Inspector 重渲染而明显掉帧。
- 最终导出不读取代理文件。

### 阶段 6：统一成片链路

- 确认预览和导出都从同一项目 State 派生。
- 增加当前帧、变换、蒙版、动效和字幕的导出回归测试。
- 清理旧的 PreviewSize 和重复坐标工具。
- 移除 feature flag fallback。

完成标准：

- 预览画面和导出画面在关键帧像素级一致。
- 旧项目状态可以正常加载。
- 所有图层编辑命令可撤销、重做和持久化。

## 8. 风险与取舍

### 风险一：直接替换 Remotion Player

风险：视频、音频、文字、表达式和导出结果出现偏差。

处理：主合成继续使用 Remotion Player，WebGL 只作为局部编辑后端。

### 风险二：Pointer Move 直接写项目 State

风险：拖动时 React 更新过多，Undo 栈膨胀。

处理：Transient Transform + Pointer Up Command。

### 风险三：预览和导出维护两套逻辑

风险：编辑器看到的结果和最终成片不一致。

处理：项目 State 是唯一真实来源，预览只是缓存和视图。

### 风险四：一次性重写整个 Canvas

风险：选择、拖拽、Timeline、Drop、快捷键和上下文菜单同时回归失败。

处理：按 Viewport、PreviewSurface、Overlay、Interaction、Cache 分阶段迁移，每阶段保留旧实现开关。

### 风险五：现有项目存在两套模型

当前仓库同时存在 `UndoableState`、`advanced` 合成模型和 `comicEditLayers` 关系模型。若新视口直接读写其中一套而渲染/导出读另一套，会出现“画布已移动但成片没变”或撤销不完整。

处理：增加明确的 Project Model Gateway，规定读写入口、迁移版本和原子提交边界；在 Gateway 落地前，不允许新视口直接修改任意模型内部字段。

### 风险六：DPR、旋转和纹理坐标不一致

现有 `ViewportController` 的 `rotation` 尚未参与坐标计算，WebGL 路径同时存在 CSS viewport 和 device backing store 两种尺寸，且 Source/Mask 的纹理 Y 方向需要统一约定。

处理：第一阶段固定旋转为 0；先通过 CSS/device/DPR/Y-flip 矩阵测试，再开放旋转和高阶 Overlay。

### 风险七：逐帧 Matte 无法落到导出

如果 Matte 只存在 Layer Panel 会话或单个静态 `maskAssetId`，预览可以显示但导出无法重建传播结果。

处理：先定义持久化的 MatteReference、Frame/Span 缓存和导出解析器，再开放 Roto Brush 的完整 UI。

## 9. 验收清单

### 视口

- [ ] Fit、100%、鼠标中心缩放正确。
- [ ] 空格拖拽和中键拖拽正确。
- [ ] DPR 设备上画面和 Overlay 清晰。
- [ ] 缩放和平移后坐标误差小于 0.25 文档像素。

### 编辑

- [ ] 图片、视频、文字可以移动、缩放、旋转。
- [ ] 拖动一次只产生一个 Undo 步骤。
- [ ] 裁剪、吸附、路径和辅助线使用统一坐标。
- [ ] Overlay 不进入导出结果。

### 时间轴和动效

- [ ] Timeline seek 后主画布显示正确帧。
- [ ] 动效播放和暂停状态正确。
- [ ] 视频、音频和字幕时间同步。
- [ ] 当前帧编辑不会破坏最终导出。
- [ ] 有动画的图层在当前帧拖动只修改当前关键帧/自动关键帧，不覆盖整段 motion。
- [ ] Precompose、父子层、Time Offset、表达式下的 local/world/source 坐标编辑可逆。
- [ ] Object Matte / Roto Brush 的 Base Frame、Span、Freeze 和逐帧缓存可保存、恢复并参与导出。

### 性能

- [ ] Pointer Move 不复制整份项目 State。
- [ ] 静态蒙版绘制只上传 dirty rect。
- [ ] 4K 蒙版连续绘制保持可交互。
- [ ] 多视频预览可以启用代理素材。
- [ ] 渲染请求具备 revision、取消和过期结果丢弃机制。
- [ ] 4K 连续交互达到明确的 P95 输入到显示延迟和帧率门槛，而不是只写“保持可交互”。

### 成片

- [ ] 预览和导出使用相同项目 State。
- [ ] 导出结果不依赖 Overlay 或临时变换。
- [ ] 旧项目可以加载和导出。
- [ ] WebGL2 不可用时仍可通过 Canvas2D fallback 编辑。
- [ ] 导出读取固定项目快照和固定 Matte 版本，不受导出期间继续编辑影响。
- [ ] 缺失资源、解码失败、GPU Context Lost、Worker 失败和上传失败都有可恢复路径。

### 边界矩阵

- [ ] 帧：`0`、最后一帧、超出范围、负数、整数帧率、嵌套合成和 Time Offset。
- [ ] 交互：Pointer Cancel、窗口失焦、第二个 Pointer、Space/Alt 中途切换、空操作和快速切 Tab。
- [ ] 视口：零尺寸、Resize、DPR `1/1.25/1.5/2/3`、奇数文档尺寸、极限缩放和未启用旋转。
- [ ] 资源：缺失 Asset、视频未解码、代理不存在、纹理超限、Context Lost、旧请求晚到。
- [ ] 状态：自动关键帧开关、锁定/隐藏父层、撤销/重做、刷新恢复、旧 schema 迁移和提交失败回滚。

## 10. 推荐的第一份代码改动

第一步不应重写整个渲染器，而应先完成以下小范围重构：

1. 将现有 `ViewportController` 移到公共 `src/editor/viewport/`。
2. 为主画布创建 `RemotionPreviewSurface`。
3. 让 `Canvas` 使用统一 ViewportController，不再直接依赖 `PreviewSizeContext` 的缩放数学。
4. 保留现有 Player 和所有导出逻辑。
5. 迁移选择框和缩放手柄到 OverlaySurface。
6. 加入 transient transform，但只在 Pointer Up 时提交 State。

在这六步之前，必须先写出并通过以下契约测试：`EditFrameContext` 关键帧语义、父子/嵌套合成 frame evaluator、CSS/device/DPR 坐标、RenderRequestKey 过期丢弃、MatteReference 导出解析和 Pointer Cancel 事务回收。否则只是把现有问题换了一个目录名。

完成这一步后，主画布就会具备 AE 风格的核心交互，同时不会改变 Remotion 视频和动效的渲染语义。之后再逐步加入代理素材、缓存和局部 GPU 优化。
