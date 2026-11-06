# Compositor 工具系统功能修补实施方案

> 文档日期：2026-10-07  
> 适用项目：`novelcomic-remotion`  
> 对照项目：`../Compositor`  
> 目标：将当前 Web 文档编辑器从“工具栏外观与算法原型”提升为具备原生 Compositor 同等级交互闭环、编辑正确性、撤销一致性和可验收性的图像编辑器。

---

## 1. 文档目的

当前 Web 编辑器已经具备 Compositor 风格的菜单栏、工具栏、图层面板、画布和部分像素算法，但多数工具尚未形成完整的编辑链路。用户能够点击工具按钮，却经常看不到效果，或者效果与鼠标位置、当前图层和工具语义不一致。

本方案不是针对单个按钮打补丁，而是建立与原生 Compositor 对应的工具运行架构，并以逐阶段、可测试、可回滚的方式完成以下闭环：

1. 工具可用性判断与明确反馈。
2. 视口坐标、文档坐标、图层坐标和资源像素坐标的正确转换。
3. Pointer Down / Move / Up / Cancel 的独立工具会话。
4. 拖动过程中的实时预览和光标反馈。
5. 单次手势只产生一个可撤销历史项。
6. 工具配置、修饰键、快捷键和状态栏提示一致。
7. 导入、保存、重新打开和导出后结果一致。
8. 建立覆盖真实交互链路的自动化与像素验收。

---

## 2. 当前源码结论

### 2.1 当前 Web 实现

主要文件：

- `src/editor/workspace/tool-bar.tsx`：工具图标及工具状态切换。
- `src/editor/workspace/tool-options-bar.tsx`：少量画笔参数 UI。
- `src/editor/workspace/document-workspace-context.tsx`：文档、选择、当前工具和命令历史。
- `src/editor/workspace/document-canvas.tsx`：所有工具共享的 Pointer 事件入口。
- `src/editor/pixels/pixel-tools.ts`：画笔、橡皮、模糊、涂抹、渐变、选择等纯像素函数。
- `src/editor/pixels/mask-pixel-*.ts`：蒙版像素编辑和 Worker。
- `src/editor/commands/document-command-*.ts`：文档命令、历史和撤销/重做。
- `src/editor/viewport/viewport-controller.ts`：已有但尚未完整接入文档画布的视口控制能力。

当前 `document-canvas.tsx` 将绝大多数交互压缩在一个组件和一套通用手势中，存在以下结构性问题：

1. 工具栏点击主要只执行 `setTool(id)`。
2. 未实现的工具仍然进入通用矩形选区分支。
3. 像素编辑把文档坐标直接传给图层本地像素算法。
4. 画笔只在 Pointer Up 后一次性计算，没有实时像素预览。
5. 图层不可编辑、未选中、锁定或资源加载失败时静默返回。
6. 前景色/背景色只是静态 UI，画笔颜色实际写死。
7. 仿制图章、渐变、修复、对象选择等仅为简化算法示意。
8. 现有测试主要覆盖纯函数，没有覆盖真实工具交互链路。

### 2.2 原生 Compositor 对照实现

原生项目的工具能力分散在清晰的会话、文档和渲染层中：

- `../Compositor/Compositor/Document/EditorSession.swift`：工具状态和全局编辑会话。
- `../Compositor/Compositor/Rendering/EditorCanvas.swift`：鼠标、键盘、修饰键、坐标转换和工具分发。
- `../Compositor/Compositor/Document/BrushStroke.swift`：画笔笔迹、扩展边界、预览和提交。
- `../Compositor/Compositor/Document/EditorSession+Brush.swift`：画笔工具会话入口和历史提交。
- `../Compositor/Compositor/Document/Selection.swift`：选区状态和编辑。
- `../Compositor/Compositor/Document/MagicWand.swift`：魔棒选择。
- `../Compositor/Compositor/Document/ObjectSelection.swift`：对象选择。
- `../Compositor/Compositor/Document/CloneStamp.swift`：仿制源及对齐状态。
- `../Compositor/Compositor/Document/Gradient.swift`：渐变草稿、控制点和提交。
- `../Compositor/Compositor/Document/ShapeTool.swift`：形状草稿与图层创建。
- `../Compositor/Compositor/Document/TypeTool.swift`：文字草稿、内联编辑与提交。
- `../Compositor/Compositor/Document/SmudgeLiquify.swift`：涂抹和液化。
- `../Compositor/Compositor/Rendering/BrushCursorOverlay.swift`：画笔光标。
- `../Compositor/Compositor/Rendering/LiveMaskRenderer.swift`：蒙版实时预览。

关键差距不是代码行数，而是原生版本为每个工具维护独立状态机，并明确区分预览态与已提交文档态。

---

## 3. 修补完成的定义

“达到 Compositor 水平”在本项目中定义为：

### 3.1 功能闭环

每个展示在主工具栏中的工具必须满足以下全部条件：

- 可以明确判断当前是否可用。
- 不可用时按钮禁用或显示具体原因，不允许静默无反应。
- Pointer、键盘和修饰键语义稳定。
- 操作过程中有可见预览。
- Pointer Up 或确认操作后写入文档命令。
- Escape、Pointer Cancel 或切换工具可以恢复操作前状态。
- Undo/Redo 可以完整撤销或重做一次手势。
- 保存、重开和导出后结果不丢失。

### 3.2 正确性

- 任意平移、缩放、旋转后的图层均能在鼠标对应位置编辑。
- 画布缩放和设备像素比不影响编辑位置。
- 选区、蒙版和像素层使用统一且有声明的坐标空间。
- 像素工具只修改预期区域，不产生整图意外修改。
- 图层锁定、隐藏、不可编辑内容和资源加载失败均有确定行为。

### 3.3 体验

- 工具切换、画笔连续绘制和视口拖动不出现明显卡顿。
- 画笔拖动过程中至少以当前显示帧率更新预览，提交计算可异步进行。
- 光标形态、笔刷轮廓、采样点、渐变控制线和选区轮廓与工具状态一致。
- 快捷键不会在输入框、文字编辑器和菜单中误触发。

### 3.4 工程验收

- 所有工具有单元测试和至少一条交互测试。
- 坐标转换有旋转、缩放和设备像素比测试。
- 核心像素工具有固定 fixture 的像素快照。
- 工具能力矩阵不存在未解释的“UI 已展示但功能未实现”状态。

---

## 4. 目标架构

### 4.1 禁止继续扩展单体 DocumentCanvas

`document-canvas.tsx` 只保留：

- Canvas/overlay 容器。
- 渲染器生命周期。
- 浏览器 Pointer 事件入口。
- 将规范化事件转发给当前工具会话。
- 组合工具 overlay。

工具业务逻辑不得继续以更多 `if (tool === ...)` 堆入该组件。

### 4.2 新增工具控制层

建议目录：

```txt
src/editor/tools/
  types.ts
  tool-registry.ts
  tool-controller.ts
  tool-capabilities.ts
  coordinates.ts
  modifiers.ts
  sessions/
    move-tool-session.ts
    marquee-tool-session.ts
    lasso-tool-session.ts
    object-select-tool-session.ts
    brush-tool-session.ts
    eraser-tool-session.ts
    blur-tool-session.ts
    clone-stamp-tool-session.ts
    healing-tool-session.ts
    gradient-tool-session.ts
    eyedropper-tool-session.ts
    shape-tool-session.ts
    type-tool-session.ts
    hand-tool-session.ts
    zoom-tool-session.ts
  overlays/
    brush-cursor-overlay.tsx
    selection-overlay.tsx
    transform-overlay.tsx
    gradient-overlay.tsx
    clone-source-overlay.tsx
    shape-draft-overlay.tsx
    inline-text-overlay.tsx
```

### 4.3 工具会话接口

```ts
export type ToolPointerEvent = {
  pointerId: number;
  viewportPoint: Point;
  documentPoint: Point;
  pressure: number;
  buttons: number;
  modifiers: ToolModifiers;
};

export interface ToolSession {
  readonly toolId: WorkspaceToolId;
  readonly status: 'idle' | 'active' | 'committing' | 'disabled';
  readonly cursor: ToolCursor;
  readonly disabledReason?: string;

  pointerDown(event: ToolPointerEvent): void | Promise<void>;
  pointerMove(event: ToolPointerEvent): void | Promise<void>;
  pointerUp(event: ToolPointerEvent): void | Promise<void>;
  pointerCancel(reason: 'escape' | 'pointer-cancel' | 'tool-change'): void;
  keyDown?(event: ToolKeyEvent): boolean;
  renderOverlay?(): React.ReactNode;
  dispose(): void;
}
```

约束：

- 每次激活只存在一个工具会话实例。
- 文档写入只能通过命令总线完成。
- Pointer Move 只更新草稿/预览，不直接产生历史项。
- Pointer Up 将整个手势提交为一个事务。
- 切换工具前必须调用当前会话的 `pointerCancel('tool-change')`。

### 4.4 工具注册表

工具栏、快捷键、选项栏、状态栏、禁用原因和 session factory 必须从同一注册表读取，避免多处定义不一致。

```ts
type ToolDefinition = {
  id: WorkspaceToolId;
  label: string;
  shortcut?: string;
  icon: React.ComponentType;
  requirements: ToolRequirement[];
  createSession(context: ToolContext): ToolSession;
  optionsPanel?: React.ComponentType;
  statusHint: string;
};
```

删除当前工具栏和选项栏各自维护的重复标签映射。

---

## 5. 坐标系统修补

这是所有像素工具可用的前置条件，必须作为第一批完成。

### 5.1 明确五种坐标空间

1. `Client Space`：浏览器事件的 `clientX/clientY`。
2. `Viewport Space`：编辑区域容器坐标，包含 pan/zoom。
3. `Document Space`：文档宽高中的逻辑坐标。
4. `Layer Local Space`：应用图层逆变换后的局部坐标。
5. `Asset Pixel Space`：实际栅格资源像素坐标。

### 5.2 必须提供的转换函数

```ts
clientToViewport(point, viewportRect)
viewportToDocument(point, viewportTransform)
documentToViewport(point, viewportTransform)
documentToLayer(point, layerWorldTransform)
layerToDocument(point, layerWorldTransform)
layerToAssetPixel(point, layer, asset)
assetPixelToLayer(point, layer, asset)
```

### 5.3 变换要求

- 支持 originX、originY、width、height、rotation 和父级组变换。
- 点击、笔刷大小和选区边界不得直接依赖 CSS 显示尺寸。
- DPR 仅用于渲染清晰度，不进入文档几何计算。
- 画笔直径按资源像素或文档像素定义时必须明确，不能混用。
- 对不可逆矩阵、零尺寸图层和越界点返回显式结果。

### 5.4 第一批回归案例

- 图层位于文档左上角。
- 图层居中且原点非零。
- 图层缩放为 50% 和 200%。
- 图层旋转 30°、90°。
- 图层位于变换过的组中。
- 画布 zoom 为 12.5%、100%、400%。
- DPR 为 1、2、3。

---

## 6. 视口系统修补

当前 `hand` 和 `zoom` 主要只有图标与 cursor，需要接入真实 ViewportController。

### 6.1 视口状态

```ts
type ViewportState = {
  zoom: number;
  panX: number;
  panY: number;
  followsFit: boolean;
};
```

状态只允许由统一 controller 修改，菜单栏、抓手、缩放工具、滚轮和适配画布共用同一来源。

### 6.2 抓手工具

- Pointer Down 记录当前 pan 和起点。
- Pointer Move 更新 pan，不修改文档。
- Pointer Up 结束会话，不产生文档历史。
- Space 临时切换抓手，释放后恢复原工具。
- 鼠标中键始终允许平移。
- 按下时 cursor 从 `grab` 变为 `grabbing`。

### 6.3 缩放工具

- 点击以鼠标下的文档点为中心放大。
- Alt/Option 点击缩小。
- 拖动可实现连续缩放时，中心点保持不漂移。
- 滚轮/触控板缩放与工具点击共享算法。
- Fit、Actual Pixels 和阶梯缩放共享 zoom 上下限。

---

## 7. 工具逐项修补要求

## 7.1 移动/变换工具

当前能力：可命中边界并平移选中图层，但缺少变换控件和精确命中。

必须补齐：

- 基于渲染顺序和实际 alpha 的可选命中策略。
- Auto-select Layer / Selection 选项真正生效。
- 多选、Shift 加选、Cmd/Ctrl 切换选择。
- 平移实时预览，Pointer Up 后提交一个历史事务。
- 八方向缩放、旋转手柄和中心点。
- Shift 约束比例、Alt/Option 从中心缩放。
- 旋转/缩放时支持父级变换。
- 锁定图层不可移动并显示原因。
- Escape 恢复操作前 transform。

对照源码：

- `EditorCanvas.swift` 中 move/transform drag。
- `LayerTransform.swift`。
- `TransformOverlay.swift`。

## 7.2 矩形/椭圆选框

必须补齐：

- 新建、加选、减选、交叉四种模式。
- Shift 正方形/圆形约束。
- Alt/Option 从中心绘制。
- 蚂蚁线实时预览。
- 选区移动而不是误建新选区。
- 选区边缘 feather、expand、contract 的统一数据模型。
- 选区必须记录在文档坐标空间，应用到图层前再转换。

## 7.3 套索/多边形套索

必须拆为两个 session：

- 自由套索：连续采样、距离阈值简化、闭合。
- 多边形套索：逐点点击、双击/Enter 闭合、Backspace 删除上一点。
- Escape 取消草稿。
- 边界外拖动支持视口自动滚动。
- 与选区模式和 feather 共用 SelectionController。

## 7.4 对象选择、魔棒和颜色范围

当前问题：对象选择仅为矩形内非透明像素，颜色范围取固定数组开头颜色。

必须补齐：

- 魔棒必须使用点击位置对应的图层像素作为 seed。
- 支持 tolerance、contiguous 和 sample merged。
- 颜色范围从用户点击/吸取颜色开始，不使用 `source.data[0]`。
- 对象选择必须提供明确后端：本地分割模型、服务端分割 API，或标记为实验功能。
- 异步选择期间显示进度，切换工具/文档时取消请求。
- 输出选区需要映射回文档空间。
- 算法失败不得生成空选区覆盖原选区。

## 7.5 画笔

必须补齐：

- 使用真实前景色。
- 笔刷大小、硬度、不透明度和压力生效。
- 点之间插值，避免快速拖动产生断点。
- 实时预览，不等待 Pointer Up 才显示。
- 圆形笔刷 cursor 随 zoom 正确显示。
- `[` / `]` 调整大小，Shift 组合调整硬度。
- 数字键调整 opacity。
- Shift 点击连接上一个落点。
- 操作仅影响活动像素图层或活动蒙版。
- 必要时扩展图层像素边界，并同步未放置蒙版。
- 一次连续笔迹只产生一个历史项。

## 7.6 橡皮擦

- 与画笔共享笔刷采样、插值、压力和 cursor。
- 修改 alpha，不写入黑色或白色伪透明像素。
- 支持透明度渐变。
- 对不支持 alpha 的源资源，提交后统一转换为 PNG 资产。
- 蒙版模式下应擦除蒙版覆盖，而不是擦除图层像素。

## 7.7 模糊工具

当前 `boxBlur(source, radius)` 会处理整张图，必须删除此工具路径。

正确实现：

- 按笔刷 coverage 生成局部权重蒙版。
- 只在经过区域混合模糊结果。
- 支持 strength/opacity、多次叠加和压力。
- 预览使用局部 tile 或 GPU pass，提交使用确定性 CPU/Worker 算法。
- 不允许一次点击导致整图模糊。

## 7.8 涂抹/液化

- 若保留在 WorkspaceToolId 中，必须正式加入工具栏分组或从公开类型移除。
- 涂抹维护笔头携带颜色，不是简单复制上一点。
- 液化维护位移场或局部 warp mesh。
- 大图片使用 tile/Worker/GPU，禁止每个采样点克隆整张像素缓冲。
- 提交结果必须确定性且可撤销。

## 7.9 仿制图章

当前固定使用首点左上 24px 作为 source，必须替换。

必须补齐：

- Alt/Option 点击设置 clone source。
- 未设置 source 时禁止绘制并提示“按住 Alt/Option 点击设置取样点”。
- 画布显示 source 标记和同步预览圆环。
- 支持 Aligned 开关。
- source 与 target 经过各自图层坐标转换。
- 支持采样当前图层或合并可见图层。
- 每条笔迹锁定开始时的 source snapshot，避免边写边污染采样。

## 7.10 修复画笔

- 与画笔共享 stroke engine。
- 明确 Content-Aware / Proximity Match 等模式；无法实现时只展示真实支持项。
- 采样纹理和目标区域颜色/亮度需分离处理。
- Worker 中异步计算，预览与最终提交保持足够接近。
- 不能简单用周围十六个像素平均冒充最终能力。

## 7.11 渐变

- Pointer Down 创建起点，拖动创建终点。
- Overlay 显示方向线和两个控制点。
- 拖动控制点可修改草稿。
- Enter/Done 提交，Escape 取消。
- 支持前景到背景、前景到透明。
- 支持 Linear / Radial，其他模式按需求扩展。
- 颜色、opacity、reverse、dither 和选区限制来自 ToolOptions。
- 渐变不得忽略用户拖动长度并铺满固定黑白渐变。

## 7.12 吸管

当前已存在 `eyedropper()` 纯函数，但未接入画布。

必须补齐：

- 点击实时取样并更新前景色。
- 支持 Point、3×3、5×5 等采样半径。
- 支持 Current Layer / All Visible Layers。
- 按住鼠标拖动时连续预览颜色，松开确认。
- Escape 恢复原颜色。
- 采样合成画布时从 renderer 的可读输出获取，不直接读取单层资源。

## 7.13 形状

- Rectangle / Ellipse / Line 三种草稿。
- ToolOptions 提供形状类型、填充、线宽、圆角。
- Shift 约束比例或角度，Alt/Option 从中心创建。
- 拖动期间显示 vector draft。
- 提交时创建可编辑 shape layer，而不是提前栅格化。
- Escape 取消，切换工具自动结束或取消需有统一规则。

对照：`ShapeTool.swift` 和 `ShapeControls.swift`。

## 7.14 文字

- 单击创建点文字，拖动创建段落文本框。
- 使用真正的 inline textarea/contenteditable overlay。
- ToolOptions 提供字体、字号、颜色、对齐、tracking、leading。
- 编辑现有文字层时不新建重复图层。
- Cmd/Ctrl+Enter 或 Done 提交，Escape 取消。
- 输入法组合事件期间不得触发全局快捷键。
- 草稿不进入历史，最终提交只产生一个历史项。
- 字体加载失败时有 fallback 和提示。

对照：`TypeTool.swift`、`InlineTextEditor.swift`、`TypeControls.swift`。

## 7.15 抓手与缩放

按第 6 节实现。注意这两种工具修改视口状态，不写入文档历史。

---

## 8. 前景色、背景色和工具设置

新增 WorkspaceToolSettings：

```ts
type WorkspaceToolSettings = {
  foregroundColor: RGBA;
  backgroundColor: RGBA;
  brush: BrushSettings;
  cloneStamp: CloneStampSettings;
  gradient: GradientSettings;
  selection: SelectionToolSettings;
  eyedropper: EyedropperSettings;
  shape: ShapeSettings;
  type: TypeSettings;
};
```

要求：

- 工具设置与文档内容分离，不进入普通文档 Undo。
- 设置可以持久化到 local storage，但文档专属设置除外。
- 工具栏色块可以点击打开颜色选择器。
- `X` 交换前景/背景色，`D` 恢复默认黑白。
- ToolOptions 必须实际绑定设置，不保留无效控件。

---

## 9. 实时预览与提交模型

### 9.1 草稿层

所有需要拖动或输入的工具使用临时 Draft，不直接修改正式 DocumentState：

```ts
type ToolDraft =
  | PixelStrokeDraft
  | SelectionDraft
  | TransformDraft
  | GradientDraft
  | ShapeDraft
  | TextDraft;
```

### 9.2 预览渲染

渲染顺序建议：

1. 已提交文档 render graph。
2. 当前工具的像素或矢量 draft。
3. 选区蚂蚁线。
4. transform/gradient/shape 控制点。
5. 工具 cursor overlay。

### 9.3 提交

- Pointer Up/Done 将 draft 转换为一个或一组事务命令。
- Worker 返回时验证 projectId、document revision、layer id、asset id 和 transform 是否仍与开始时兼容。
- 过期结果直接丢弃，不覆盖用户后续编辑。
- Commit 失败保留原文档并显示错误。
- 大像素提交期间可继续渲染预览，但禁止在同一图层开启第二个冲突操作。

---

## 10. Worker 与性能修补

### 10.1 禁止主线程整图高频复制

当前部分像素函数在每个点或每次事件中克隆完整 PixelBuffer，不能用于生产级大图。

必须实现：

- 基于脏矩形的局部计算。
- Worker 传输使用 transferable ArrayBuffer。
- 画笔输入点批量发送，不逐点请求 Worker。
- 长笔迹使用固定时间片刷新预览。
- 大图按 tile 编辑和提交。
- 可取消任务和过期任务丢弃。

### 10.2 性能门槛

在开发机基准 fixture 上：

- 1920×1080 图层连续画笔预览不低于 45 FPS。
- 4096×4096 图层连续画笔预览不低于 30 FPS。
- Pointer Move 主线程单次处理目标低于 4ms。
- Undo/Redo 不重复同步解码原始图片。
- 工具切换不重新初始化整个 WebGL renderer。

---

## 11. 命令历史与持久化

### 11.1 历史粒度

- 一条连续笔迹 = 一个历史项。
- 一次 transform drag = 一个历史项。
- 一个渐变确认 = 一个历史项。
- 一段文字创建或一次文字编辑确认 = 一个历史项。
- 取消操作 = 零历史项。

### 11.2 资产生命周期

- 像素提交产生新 AssetRecord，并更新图层 assetId。
- Undo 后旧资产必须仍可访问。
- 历史截断后回收无引用资产。
- Data URL 只作为当前阶段兼容方案；生产环境应迁移到 Blob/IndexedDB/Object URL。
- 保存项目必须包含工具实际依赖的 mask、pixel、shape 和 text 数据。

### 11.3 并发保护

所有异步像素操作记录：

- 开始时 document revision。
- layer id。
- layer asset id。
- layer transform signature。
- mask asset id。

提交时不匹配则放弃结果或要求重算。

---

## 12. UI 可用性修补

### 12.1 工具禁用状态

ToolCapabilityResolver 根据当前文档与活动图层返回：

```ts
type ToolCapability =
  | {enabled: true}
  | {enabled: false; reason: string};
```

示例原因：

- “请先选择一个像素图层”。
- “当前图层已锁定”。
- “文字工具不能编辑组图层”。
- “请按住 Alt/Option 点击设置仿制源”。
- “当前浏览器无法读取跨域图片像素”。

### 12.2 状态反馈

- 状态栏显示当前工具操作说明。
- 静默 `return` 必须替换为禁用状态或 toast。
- Worker 操作显示局部 busy 状态，不要遮挡整个编辑器。
- 工具提交失败应包含可行动的错误信息。

### 12.3 工具分组

与原生 Compositor 一致，相关工具使用长按/二级菜单分组，而不是无限拉长单列工具栏：

- Marquee：矩形、椭圆。
- Lasso：自由、多边形。
- Wand：魔棒、对象选择、颜色范围/选择主体。
- Brush：画笔、橡皮。
- Retouch：修复、仿制、模糊、涂抹/液化。
- Shape：矩形、椭圆、线。

如果某个子工具未实现，不得只展示图标占位。

---

## 13. 测试与验收体系

### 13.1 单元测试

新增：

- `coordinates.test.ts`：全部坐标转换与逆变换。
- `tool-capabilities.test.ts`：图层类型、锁定和资源状态。
- 每个 tool session 独立状态机测试。
- brush interpolation、局部 blur、clone source、gradient bounds 测试。
- 异步提交过期保护测试。

### 13.2 React 交互测试

使用 Testing Library 或 Vitest Browser 覆盖：

- 点击工具后正确创建 session。
- 不可用工具有 disabled reason。
- Pointer Down/Move/Up 形成一次命令提交。
- Escape 取消且不生成历史。
- Hand/Zoom 只改变 viewport。
- Type 输入不会触发全局工具快捷键。

### 13.3 浏览器端到端测试

建议使用 Playwright，建立固定项目 fixture：

1. 导入一张带透明边缘的图片。
2. 将图层移动、缩放、旋转。
3. 在指定屏幕坐标画一条红线。
4. 验证导出像素出现在变换后的正确图层位置。
5. Undo 后恢复，Redo 后重现。
6. 保存并重新打开，结果一致。

必须覆盖工具：

- Move
- Marquee/Lasso
- Brush/Eraser/Blur
- Clone/Healing
- Gradient/Eyedropper
- Shape/Type
- Hand/Zoom

### 13.4 像素金图

目录建议：

```txt
tests/fixtures/compositor-parity/
  projects/
  inputs/
  expected/
  matrix.json
```

`matrix.json` 每项至少包含：

```json
{
  "featureId": "tool.brush.transformed-layer",
  "nativeSources": ["Document/BrushStroke.swift", "Rendering/EditorCanvas.swift"],
  "webSources": ["src/editor/tools/sessions/brush-tool-session.ts"],
  "status": "implemented",
  "tests": ["tests/e2e/tools/brush.spec.ts"],
  "pixelEvidence": ["expected/brush-transformed-layer.png"],
  "notes": ""
}
```

状态仅允许：

- `planned`
- `in-progress`
- `implemented`
- `unsupported`

`unsupported` 只能用于浏览器平台客观无法提供的底层系统能力，并且必须写明对应的 Compositor 源码、无法复刻的技术证据和不改变产品行为的承载方式。不得用平台差异隐藏未完成工作。

---

## 14. 当前施工范围：按 Compositor 源码复刻阶段 1 和阶段 2

本轮只实施以下两个阶段：

1. **阶段 1：坐标与视口基础。**
2. **阶段 2：工具会话框架与基础 Overlay。**

本轮先复刻阶段 1 和阶段 2，不代表缩减最终范围，也不允许重新设计另一套工具架构。阶段 1、2 必须直接以 Compositor 的 `CanvasViewport`、`EditorSession`、`EditorCanvas`、`Selection` 和 `TransformOverlay` 为母版，逐字段、逐方法、逐事件分支复刻。后续画笔、橡皮、模糊、仿制、修复、渐变、吸管、形状和文字继续遵循同一规则。

本文中的“复刻”具有以下强制含义：

- Compositor 源码是功能、状态和交互行为的唯一标准。
- Web 端必须为原生字段、方法、状态机和事件分支建立一一对应实现。
- 鼠标、键盘、修饰键、Cursor、Overlay、Cancel、Commit 和 History 边界必须保持一致。
- 浏览器 API 只替换 AppKit、NSView、NSCursor、CoreGraphics 等平台 API，不得改变产品行为。
- 不得自行简化、裁剪或重新解释原生工具语义。
- 原生存在但 Web 尚未完成的行为必须登记为未完成，不能标记为 Web 差异。
- 每一项复刻都必须有 Web 源码落点和测试证据。

本轮必须完成的源码复刻范围：

- Viewport 状态、坐标转换和图层命中。
- Hand、Zoom、Space 临时抓手和菜单缩放。
- ToolRegistry、ToolCapability、ToolController。
- Move、Marquee、Lasso 的 session 化。
- Selection、Transform、Cursor 基础 Overlay。
- 与以上内容直接相关的测试、状态栏和选项栏。

阶段 1、2 暂不进入以下后续工具源码，但基础类型和生命周期不得与 Compositor 冲突：

- 像素算法和 StrokeEngine。
- Type、Shape、Gradient 等具体编辑器。
- AI 分割和修复算法。
- 工程保存格式重构。

---

## 15. 阶段 1：坐标与视口基础

### 15.1 阶段目标：复刻 CanvasViewport

以 `Compositor/Rendering/CanvasViewport.swift` 为母版复刻坐标与视口系统，使浏览器事件、画布显示、图层命中、Overlay 和后续像素工具保持原生相同的坐标语义。

阶段 1 完成后必须满足：

- Hand 工具能够真实平移视口。
- Zoom 工具能够围绕鼠标位置缩放。
- Space 能够临时抓手平移，释放后恢复原工具。
- Fit、Actual Pixels、Zoom In、Zoom Out 共用一个 ViewportStore。
- Pointer 事件不再用 Canvas DOM 宽高比例直接推导文档坐标。
- 文档坐标能正确转换到带父级变换的图层局部坐标。
- 图层局部坐标能转换到资源像素坐标。
- DPR 只影响 backing store，不改变几何计算。

### 15.2 阶段 1 文件范围

新增：

```txt
src/editor/tools/
  coordinates.ts
  coordinates.test.ts
  pointer-event.ts

src/editor/viewport/
  document-viewport.tsx
  document-viewport.test.tsx
```

重点修改：

```txt
src/editor/viewport/viewport-controller.ts
src/editor/viewport/viewport-math.ts
src/editor/viewport/viewport-store.ts
src/editor/viewport/viewport-types.ts
src/editor/workspace/compositor-shell.tsx
src/editor/workspace/document-canvas.tsx
src/editor/workspace/menu-bar.tsx
src/editor/workspace/status-bar.tsx
src/editor/document/transform.ts
src/editor/render-graph/evaluate-document-frame.ts
```

### 15.3 任务 1.1：统一 ViewportStore

#### 当前问题

`compositor-shell.tsx` 自己维护 `zoom`、`followsFit` 和 `fitRevision`，`document-canvas.tsx` 又根据 ResizeObserver 单独计算显示尺寸。项目已经存在 `ViewportController` 和 `ViewportStore`，但文档工作区没有以它们作为唯一状态源。

#### 修改要求

1. `WorkspaceBody` 创建且只创建一个 `ViewportStore`。
2. Store 生命周期与工作区一致，不随 React render 重建。
3. `DocumentCanvas` 只接收 `viewportStore`，删除 `zoom`、`followsFit`、`fitRevision` 和 `onFitZoomChange` props。
4. ResizeObserver 只调用：
   - `viewportStore.setViewportSize(width, height, devicePixelRatio)`；
   - `viewportStore.setDocumentSize(document.width, document.height)`。
5. 菜单栏 Fit、Actual Pixels、Zoom In、Zoom Out 全部调用 store/controller。
6. CSS 显示尺寸由 ViewportSnapshot 计算。
7. `pointsPerPixel` 统一表示 CSS points per document pixel；DPR 不进入 Pointer geometry。

#### 必须按原生方法逐项复刻

- `CanvasViewport.documentRect()` → Web `ViewportController.getDocumentRect()`。
- `CanvasViewport.documentPoint()` → Web `screenToDocument()`。
- `CanvasViewport.viewPoint()` → Web `documentToScreen()`。
- `CanvasViewport.fit()` → Web `ViewportController.fit()`。
- `CanvasViewport.resize()` → Web ResizeObserver 与 `setViewportSize()`，包括 DPR 变化时的 pan 语义。
- `CanvasViewport.setZoom()` → Web `ViewportController.zoomAt()`。
- `CanvasViewport.keyboardZoomTarget()` → Web 离散缩放方法。
- `CanvasViewport.translate()` → Web `ViewportController.panBy()`。
- `zoomRange`、`keyboardZoomLevels`、`followsFit`、`pointsPerPixel` 必须按原值和原语义复制。

### 15.4 任务 1.2：标准坐标 API

新增 `src/editor/tools/coordinates.ts`：

```ts
export type ToolPoint = {x: number; y: number};

export function clientToViewport(
  point: ToolPoint,
  viewportRect: DOMRectReadOnly,
): ToolPoint;

export function viewportToDocument(
  point: ToolPoint,
  snapshot: ViewportSnapshot,
): ToolPoint;

export function documentToViewport(
  point: ToolPoint,
  snapshot: ViewportSnapshot,
): ToolPoint;

export function documentToLayer(
  point: ToolPoint,
  document: DocumentState,
  layerId: string,
  frame?: number,
): ToolPoint | null;

export function layerToDocument(
  point: ToolPoint,
  document: DocumentState,
  layerId: string,
  frame?: number,
): ToolPoint | null;

export function layerToAssetPixel(
  point: ToolPoint,
  layer: LayerNode,
  asset: AssetRecord,
): ToolPoint | null;
```

实现规则：

- Client → Viewport 只减 host 的 `left/top`。
- Viewport ↔ Document 复用 `viewport-math.ts`，不写第二套公式。
- Document ↔ Layer 使用完整 world affine matrix 及 inverse。
- World matrix 必须包含父级组 transform。
- `evaluateLayerTransform()` 可以提供数值，但应抽取共享 affine 组合，避免 renderer 和 hit test 使用不同公式。
- `getLayerBounds()` 只能用于粗筛，不能用于精确逆变换。
- Layer → Asset Pixel 必须考虑显示宽高与资源原始像素尺寸的比例。
- 零尺寸、不可逆矩阵、缺失 layer/asset 返回 `null`。
- 坐标 API 不读取 DOM、不依赖 React、不修改文档。

统一矩阵接口：

```ts
type Affine2D = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

multiplyAffine(left, right)
invertAffine(matrix)
transformPoint(matrix, point)
layerLocalMatrix(transform)
layerWorldMatrix(document, layerId, frame)
```

矩阵组合顺序必须由测试固定，调用方不得自行拼接 rotation/scale/translation。

### 15.5 任务 1.3：规范化 Pointer 事件

新增 `src/editor/tools/pointer-event.ts`：

```ts
export type ToolModifiers = {
  shift: boolean;
  alt: boolean;
  meta: boolean;
  control: boolean;
  space: boolean;
};

export type ToolPointerEvent = {
  pointerId: number;
  pointerType: string;
  buttons: number;
  pressure: number;
  clientPoint: ToolPoint;
  viewportPoint: ToolPoint;
  documentPoint: ToolPoint;
  modifiers: ToolModifiers;
};
```

要求：

- React handler 同步提取字段，不把 SyntheticEvent 存入 session。
- 鼠标按下但 pressure 为 0 时回退为 1。
- Space 由独立键盘追踪器提供。
- Pointer capture 由阶段 2 的 ToolController 统一管理。
- `pointercancel`、`lostpointercapture` 和组件卸载必须能够取消会话。

### 15.6 任务 1.4：复刻 EditorCanvas 的 Hand 和临时抓手

- 按 `EditorCanvas.mouseDown()`、`mouseDragged()`、`mouseUp()` 中的 Hand/Space 分支逐项迁移。
- Pointer Down 保存 pan 起点和 client point。
- Pointer Move 使用 CSS 像素 delta 调用 `viewportStore.panBy()`。
- Pointer Up 结束，不写 DocumentCommand。
- Space 按下临时进入 Hand；释放后恢复原工具。
- 鼠标中键直接进入临时 Hand。
- Cursor：空闲 `grab`，拖动 `grabbing`。
- Fit 清零 pan；普通工具切换不清零 pan。

### 15.7 任务 1.5：复刻 EditorCanvas 和 EditorSession 的 Zoom

- 按 `EditorCanvas.mouseDown()` 的 Zoom 分支、`EditorSession.zoom(to:anchor:)` 和 `zoomKeyboard(by:)` 逐项迁移。
- 普通点击放大到下一个离散级别。
- Alt/Option 点击缩小到上一个离散级别。
- Anchor 使用 viewportPoint。
- 菜单栏缩放无鼠标 anchor 时使用 viewport 中心。
- Fit 使用单边 48px padding，与原生总计 96px 留白一致。
- Actual Pixels 定义为 1 文档像素对应 1 CSS pixel。
- Zoom 上限 32，下限从当前 0.05 改为 0.001，对齐原生。

### 15.8 任务 1.6：迁移图层命中

1. 按实际渲染顺序从顶部向下遍历。
2. 用 `documentToLayer()` 得到 local point。
3. 判断 local point 是否在 `[0,width] × [0,height]`。
4. 阶段 1 只做 local rect hit，不做 alpha hit。
5. 跳过有效隐藏图层和隐藏父组下的子层。
6. 锁定图层是否可选交由 Move session 配置。

### 15.9 阶段 1 测试

- [ ] Viewport/Document 正反转换互为 inverse。
- [ ] `zoomAt` 前后 anchor 对应同一 document point。
- [ ] DPR 1/2/3 不改变坐标结果。
- [ ] Translation、Scale、Rotation、Negative Scale 正反转换。
- [ ] 两级父组 world matrix。
- [ ] Layer local → Asset pixel 比例转换。
- [ ] 零 scale、缺失 layer/asset 返回 null。
- [ ] Hand 改变 pan，不改变 document revision。
- [ ] Space 临时抓手后恢复原工具。
- [ ] Zoom 点击围绕光标缩放。
- [ ] 旋转图层视觉范围内能够正确命中。

### 15.10 阶段 1 门禁

- [ ] `document-canvas.tsx` 不再出现基于 Canvas DOM 宽高的 document point 公式。
- [ ] `compositor-shell.tsx` 不再保存独立 zoom 状态。
- [ ] Hand 和 Zoom 有真实行为。
- [ ] 所有 pointer 工具接收同格式 ToolPointerEvent。
- [ ] 坐标测试覆盖父级、旋转、翻转、DPR 和资源比例。
- [ ] `npm run typecheck` 通过。
- [ ] Viewport/coordinates 定向测试通过。

---

## 16. 阶段 2：工具会话框架与基础 Overlay

### 16.1 阶段目标：复刻 EditorSession、EditorCanvas、Selection 和 TransformOverlay

把 `document-canvas.tsx` 中的工具判断拆成与原生 `EditorSession` + `EditorCanvas` 一一对应的 Web ToolSession，并完整复刻 Move、Marquee、Lasso 的状态、事件、Cursor、Overlay 和提交行为。

完成后：

- 工具栏、快捷键、选项栏、状态栏和 session factory 使用同一注册表。
- 未注册或不可用工具不会落入其他工具逻辑。
- 一个 pointer gesture 只由一个 session 接管。
- Preview/Draft 与 DocumentState 分离。
- Cancel 不写历史，Commit 只写一个事务。
- Overlay 更新不要求重绘正式文档 Canvas。

### 16.2 阶段 2 文件结构

```txt
src/editor/tools/
  types.ts
  tool-registry.ts
  tool-registry.test.ts
  tool-capabilities.ts
  tool-capabilities.test.ts
  tool-controller.ts
  tool-controller.test.ts
  modifiers.ts
  coordinates.ts
  pointer-event.ts
  sessions/
    hand-tool-session.ts
    zoom-tool-session.ts
    move-tool-session.ts
    marquee-tool-session.ts
    lasso-tool-session.ts
    unavailable-tool-session.ts
  overlays/
    tool-overlay-root.tsx
    selection-overlay.tsx
    transform-overlay.tsx
    cursor-overlay.tsx
```

### 16.3 任务 2.1：ToolRegistry

```ts
export type ToolDefinition = {
  id: WorkspaceToolId;
  label: string;
  shortcut?: string;
  statusHint: string;
  requirements: ToolRequirement[];
  cursor: ToolCursor;
  createSession(context: ToolSessionContext): ToolSession;
  OptionsPanel?: React.ComponentType;
};
```

要求：

- `WorkspaceToolId` 移到 `tools/types.ts`。
- ToolBar 删除本地 `TOOLS` 数组。
- ToolOptionsBar 删除本地 labels map。
- StatusBar 删除重复提示 map。
- 快捷键从 registry 生成。
- 每个公开工具必须有 definition。
- 尚未实现的工具使用 `UnavailableToolSession`，不能落入选区逻辑。
- 开发环境检查重复 id、重复快捷键和缺失 factory。

### 16.4 任务 2.2：ToolCapabilityResolver

```ts
export type ToolCapability =
  | {enabled: true}
  | {enabled: false; reason: string};
```

阶段 2 至少处理：

- 无文档。
- 无活动图层。
- 活动图层或父组锁定。
- 图层隐藏。
- Selection 不可编辑。
- 工具尚未实现。

不可用工具必须显示 reason。快捷键触发禁用工具时不得切换到错误工具。

### 16.5 任务 2.3：ToolSession 和 ToolController

```ts
export interface ToolSession {
  readonly toolId: WorkspaceToolId;
  readonly status: ToolSessionStatus;
  pointerDown(event: ToolPointerEvent): void | Promise<void>;
  pointerMove(event: ToolPointerEvent): void | Promise<void>;
  pointerUp(event: ToolPointerEvent): void | Promise<void>;
  pointerCancel(reason: ToolCancelReason): void;
  keyDown?(event: ToolKeyEvent): boolean;
  getOverlayState?(): ToolOverlayState | null;
  dispose(): void;
}
```

ToolController 统一负责：

- 当前 definition/session。
- Pointer capture。
- Escape、pointercancel、lost capture、工具切换和卸载取消。
- Space/middle mouse 临时 Hand。
- Overlay snapshot 发布。
- Capability 失效处理。
- 防止同时存在两个 active gesture。

生命周期：

1. 激活 definition 并创建 session。
2. Pointer Down 成功后 capture。
3. Pointer Move 只更新 draft/overlay。
4. Pointer Up commit 或结束视口操作。
5. Cancel 清除 draft，产生零历史项。
6. Dispose 必须幂等。

### 16.6 任务 2.4：按 EditorCanvas 复刻 MoveToolSession

MoveToolSession 必须按 `EditorCanvas` 的 Move 分支、TransformDrag 和 `TransformOverlay` 复刻。选择、命中、平移、Snap、Cursor、Cancel 和 Commit 不得自行简化。若 Resize/Rotate 的最终写入排在后续施工，也必须在本阶段复刻原生 geometry、handle hit、cursor 和状态接口，不能使用提示占位。

Pointer Down：

- 按 render order hit test。
- 普通点击替换选择。
- Shift/Cmd/Ctrl 按平台规则切换选择。
- 空白点击清空选择。
- 记录开始 transforms 和 document point。

Pointer Move：

- 使用开始状态计算 document delta，避免累计误差。
- 使用 `getDocumentSnapTargets()` 和 `snapBounds()`。
- 只更新 draft transforms、bounds 和 snap guides。
- 禁止每次 move dispatch command。

Pointer Up：

- 无移动时只保留选择变化。
- 有移动时生成多个 `layer.transform` commands。
- 使用一个 transaction 提交。
- 一次 drag 只能新增一个 Undo step。

Cancel：

- 清除 draft，不产生 transform command。
- Escape 恢复 Pointer Down 前选择；工具切换保留当前选择。

### 16.7 任务 2.5：按 Selection.swift 复刻 MarqueeToolSession

逐项复刻 `SelectionMode`、`displayedSelectionMode`、`beginLasso()`、`dragMarquee()`、`cancelLasso()` 和 `finishLasso()`。必须支持：

- Rectangle / Ellipse。
- Replace / Add / Subtract / Intersect。
- Shift 正方形/圆形约束。
- Pointer Move 只更新 SelectionDraft。
- Pointer Up 调用 `rectangleSelection()` / `ellipseSelection()` 和 `combineSelections()`。
- Escape 清除 draft并保留原 selection。

注意：当前 `selectionToRecord()` 只保存 bounds。提交 Lasso/组合选区前必须扩展 SelectionRecord 或保存正式 alpha/mask asset；禁止把复杂选区的 bounds 当成完整选区。

### 16.8 任务 2.6：按 Selection.swift 复刻 LassoToolSession

逐项复刻 `LassoDraft`、`extendLasso()`、`moveLassoCursor()`、`removeLastLassoPoint()`、`toggleLassoKind()` 和 `finishLasso()`。

Freehand：

- Down 建立 draft。
- Move 按文档坐标采样；相邻点距离小于 0.25 document pixel 时跳过。
- Up 闭合并提交。

Polygonal：

- 单击添加点。
- Pointer Move 更新预览线段。
- 双击或 Enter 闭合。
- Backspace 删除上一点。
- Escape 取消。
- Session 跨多次 click 保持 active。

最终闭合时才 rasterize SelectionBuffer，Pointer Move 不创建整张 alpha buffer。

### 16.9 任务 2.7：按 TransformOverlay.swift 复刻基础 Overlay

Overlay 顺序：

1. Snap guides。
2. Selection marching ants。
3. Marquee/Lasso draft。
4. Transform bounds/handles。
5. Tool cursor。

`TransformOverlayGeometry`、Selection ants、Lasso draft、Snap guides 和 Cursor 显示条件必须逐项复刻。要求：

- Overlay 与正式 renderer 分离。
- Marching ants 动画只刷新 overlay。
- Transform box 使用 world corners，不用 AABB 冒充旋转框。
- 建立八个 resize handle 和 rotation handle geometry/hit test。
- Resize/Rotate commit 留到后续阶段。

### 16.10 任务 2.8：精简 DocumentCanvas

阶段 2 后 `document-canvas.tsx` 只允许包含：

- Renderer 生命周期。
- Viewport host/canvas 尺寸同步。
- DOM 事件转 ToolController。
- Pointer capture plumbing。
- ToolOverlayRoot。
- Loading/error boundary。

必须移出：

- 所有 `if (tool === ...)` 工具算法分支。
- `strokeRef`、`selectionPathRef`、`gestureRef`。
- 内联 `hitLayer()`。
- 重复坐标计算函数。
- 像素工具 commit 逻辑。

尚未迁移的像素工具使用 UnavailableToolSession 或独立 LegacyPixelToolAdapter，不能留在 DocumentCanvas。

### 16.11 阶段 2 测试

- [ ] 所有 WorkspaceToolId 都有唯一 definition。
- [ ] 未实现工具返回 unavailable session。
- [ ] 工具切换先 cancel 后 dispose。
- [ ] pointercancel/lost capture 会取消 session。
- [ ] 同时只能 capture 一个 pointer。
- [ ] Move 拖动中只更新 draft。
- [ ] Move Up 只产生一个历史项。
- [ ] Move Escape 不改变 transform。
- [ ] Rectangle/Ellipse 和四种 combine mode 正确。
- [ ] Freehand/Polygonal Enter、DoubleClick、Backspace、Escape 正确。
- [ ] Draft 不写 DocumentState。
- [ ] Overlay 更新不会调用 `RenderGraphRenderer.render()`。
- [ ] Pan/Zoom 后 Overlay 与文档对齐。

### 16.12 阶段 2 门禁

- [ ] DocumentCanvas 只负责宿主、renderer、事件桥和 overlay。
- [ ] ToolBar、ToolOptionsBar、StatusBar、快捷键使用同一 Registry。
- [ ] Move、Marquee、Lasso 都由独立 session 实现。
- [ ] 未实现工具不会进入其他工具分支。
- [ ] ToolController cancel/commit 生命周期有测试。
- [ ] 一次 gesture 最多产生一个历史项。
- [ ] Overlay 更新不重建 render graph。
- [ ] Typecheck 和阶段 1、2 定向测试通过。

---

## 17. 阶段 1、2 强制施工顺序

1. `refactor(viewport): make viewport store the workspace source`
2. `feat(coordinates): add affine document layer asset mapping`
3. `feat(viewport): implement hand zoom and temporary pan`
4. `test(viewport): cover dpr nesting rotation and flipped layers`
5. `feat(tools): add registry capabilities and unavailable sessions`
6. `feat(tools): add controller pointer lifecycle and overlays`
7. `refactor(tools): move selection and move gestures into sessions`
8. `test(tools): add move marquee lasso interaction coverage`
9. `refactor(canvas): reduce canvas to host and event bridge`

每个提交必须 typecheck 通过，不覆盖当前工作区中不相关的未提交修改。

---

## 18. 阶段 1、2 复刻约束

### 18.1 SelectionRecord 数据不足

`selectionToRecord()` 当前只保留 bounds，不能表达 Lasso 或组合选区。阶段 2 必须扩展 schema、保存 mask asset，或明确临时 workspace-only 限制。

### 18.2 禁止渲染与编辑 transform 分叉

`evaluate-document-frame.ts` 已有父级 transform 合成。应抽取共享 affine 逻辑，让 Renderer、Coordinates、Hit Test 和 Overlay 共用；禁止再写一套近似公式。

### 18.3 当前工作区有未提交修改

实施前只检查目标文件：

```bash
git status --short
git diff -- src/editor/workspace src/editor/viewport \
  src/editor/document src/editor/render-graph
```

禁止 checkout/reset 清除现有修改。

---

## 19. Compositor 源码复刻清单

本节是强制复刻清单。施工时必须完整打开对应的 Compositor 源码，把字段、方法、状态、事件分支和测试语义迁移到 Web 对应文件。

### 19.1 阶段 1、2 必读母版源码

阶段 1 必须完整读取并复刻：

1. Web `src/editor/viewport/viewport-controller.ts` 全文。
2. Web `src/editor/viewport/viewport-math.ts` 全文。
3. Web `src/editor/viewport/viewport-store.ts` 全文。
4. Web `src/editor/workspace/document-canvas.tsx:105-590`。
5. Web `src/editor/render-graph/evaluate-document-frame.ts:62-115,253-265`。
6. 原生 `Compositor/Rendering/CanvasViewport.swift` 全文。
7. 原生 `Compositor/Document/EditorSession.swift:930-990`。
8. 原生 `Compositor/Rendering/EditorCanvas.swift:1737-2024`。

阶段 2 必须继续完整读取并复刻：

1. Web `document-workspace-context.tsx:30-280,430-510`。
2. Web `tool-bar.tsx`、`tool-options-bar.tsx`、`status-bar.tsx` 全文。
3. Web `document/selection.ts` 全文。
4. Web `document-command-history.ts` 全文。
5. 原生 `Document/Selection.swift:1-230`。
6. 原生 `Rendering/TransformOverlay.swift:1-90,179-188`。
7. 原生 `EditorCanvas.swift:790-855,1430-1516,1660-2110,2300-2390`。

### 19.2 阶段 1 源码复刻映射表

| 任务 | Web 复刻落点 | Compositor 母版源码 | 强制复刻要求 |
|---|---|---|---|
| Viewport 状态 | `viewport-controller.ts:19-138` | `CanvasViewport.swift:5-83` | 完整复制字段语义、范围、fit、resize、anchor zoom、keyboard zoom 和 translate。 |
| Store | `viewport-store.ts:10-69` | `EditorSession` 中 viewport 的所有调用点 | Web Store 仅作为平台容器，公开行为必须与原生 EditorSession 一致。 |
| 屏幕/文档转换 | `viewport-math.ts:3-46` | `CanvasViewport.swift:18-32` | 逐公式迁移，并用同输入 fixture 验证同结果。 |
| Fit | `ViewportController.fit():78-92` | `CanvasViewport.fit():35-41` | 单边 48px padding 对齐原生总计 96px。 |
| Anchor zoom | `ViewportController.zoomAt():106-116` | `CanvasViewport.setZoom():56-64` | 完整复刻 anchor 保持、clamp 和 followsFit=false。 |
| 离散缩放 | `compositor-shell.tsx` 的 ZOOM_LEVELS | `CanvasViewport.swift:12-14` | 常量移入 ViewportController。 |
| Hand | `sessions/hand-tool-session.ts` | `EditorCanvas.swift:1798-1803,1843-1850,2002` | 复刻 Space、Hand、拖动、结束和 Cursor 行为。 |
| Zoom | `sessions/zoom-tool-session.ts` | `EditorCanvas.swift:1839-1841`、`EditorSession.swift:968-982` | 复刻点击、Alt、键盘级别、anchor 和状态变化。 |
| Pointer 坐标 | `document-canvas.tsx:218-260` | `CanvasViewport.documentPoint():25-28` | 删除 DOM 比例公式，走标准链路。 |
| Layer bounds | `document/transform.ts:17-33` | `TransformOverlayGeometry` | AABB 只粗筛，精确命中用 inverse matrix。 |
| World transform | `evaluate-document-frame.ts:95-115,253-265` | 原生 LayerTransform/group path | 抽取共享 affine 逻辑。 |
| Hit test | `document-canvas.tsx:227-251` | `EditorCanvas.swift:1669` 附近 | 阶段 1 用 inverse matrix + local rect。 |

### 19.3 阶段 2 源码复刻映射表

| 任务 | Web 复刻落点 | Compositor 母版源码 | 强制复刻要求 |
|---|---|---|---|
| Tool ids | `tools/types.ts` | `EditorSession.swift:90-118` | 工具枚举、分组属性和判断属性逐项复刻。 |
| Tool switch | `tool-controller.ts` | `EditorSession.swift:362` 及工具 press/select 方法 | 复刻切换前取消、模式保持和快捷键行为。 |
| ToolBar | `tool-bar.tsx:24-82` | 原生工具 rail | UI 保留，数据改读 Registry。 |
| Options | `tool-options-bar.tsx:5-132` | `UI/*Controls.swift` | 本阶段只接基础工具，其余 unavailable。 |
| Status | `status-bar.tsx` | 原生帮助/cursor feedback | 状态提示和禁用原因来自 Registry。 |
| Pointer dispatch | `tool-controller.ts` 和各 session | `EditorCanvas.swift:1737-2110` | 每个原生分支必须有明确 Web 接收者，禁止默认 fallback。 |
| Move | `move-tool-session.ts` | `EditorCanvas.swift:1669,1834-2024` | 逐项复刻 selection、drag、snap、cursor、commit 和 cancel。 |
| Snap | `document/snap.ts` | 原生 TransformSnap path | 复用 Web snap，输入使用 gesture start。 |
| Marquee/Lasso | `marquee-tool-session.ts`、`lasso-tool-session.ts` | `Selection.swift:119-230` | 逐项复刻 mode、draft、采样、闭合、取消和提交。 |
| Combine | `document/selection.ts:3-21` | `Selection.swift:119-134,209-230` | Web 已有算法，补 mode 和正式存储。 |
| Polygonal | 当前与 freehand 共用 | `Selection.swift:164-207` | 独立跨 click session。 |
| Transform Overlay | `overlays/transform-overlay.tsx` | `TransformOverlay.swift:3-89` | 完整复刻 geometry、handle hit、rotation handle 和显示条件。 |
| Selection Overlay | `overlays/selection-overlay.tsx` | `TransformOverlay.swift:90-188` 及 selection draw 方法 | 复刻 ants、draft、缩放细节和显示条件。 |
| History | `document-command-history.ts` | `beginEdit/endEdit` | Web 用 transaction；一手势一历史。 |
| Cancel | 当前无统一入口 | `cancelLasso` 和 Escape paths | Controller 统一 cancel。 |

### 19.4 符号速查

原生：

| 功能 | 文件与符号 |
|---|---|
| 工具枚举 | `Document/EditorSession.swift:90 NavigationTool` |
| 工具切换 | `Document/EditorSession.swift:362 selectTool` |
| Viewport | `Rendering/CanvasViewport.swift:5 CanvasViewport` |
| Anchor Zoom | `CanvasViewport.swift:56 setZoom` |
| Pointer Down/Drag/Up | `Rendering/EditorCanvas.swift:1737/1843/2025` |
| Selection Draft | `Document/Selection.swift:141 beginLasso` |
| Marquee Drag | `Selection.swift:155 dragMarquee` |
| Lasso Points | `Selection.swift:165 extendLasso` |
| Selection Commit | `Selection.swift:211 finishLasso` |
| Transform Geometry | `Rendering/TransformOverlay.swift:3` |

Web：

| 功能 | 文件与符号 |
|---|---|
| Viewport | `viewport/viewport-controller.ts:19 ViewportController` |
| Viewport math | `viewport/viewport-math.ts:3-46` |
| Viewport store | `viewport/viewport-store.ts:10 ViewportStore` |
| Tool ids | `workspace/document-workspace-context.tsx:30` |
| Canvas host | `workspace/document-canvas.tsx:105` |
| Pointer handlers | `document-canvas.tsx:262/293/310` |
| Hit test | `document-canvas.tsx:227` |
| Move commit | `document-workspace-context.tsx:223` |
| Layer bounds | `document/transform.ts:17` |
| Selection | `document/selection.ts:8-27` |
| World transform | `render-graph/evaluate-document-frame.ts:95-115,253-265` |
| Command history | `commands/document-command-history.ts` |

### 19.5 复刻执行规则

1. 先读本文件第 14–20 节。
2. 完整读取 19.1 中列出的 Web 与 Compositor 源码，不得只看摘要或局部片段。
3. 为每个原生字段、方法和事件分支建立 Web 对应实现。
4. 平台 API 替换必须在代码注释中标明对应的原生文件和符号。
5. 原生存在但尚未迁移的行为必须列为未完成，不得标成 Web 差异。
6. 阶段 1、2 不提前实现后续工具，但基础状态和接口必须能承载其原生行为。
7. 修改前检查目标文件 git diff，保留用户已有修改。
8. 定向测试通过后，仍需完成阶段 1、2 的完整交互验收。

推荐验证：

```bash
npm run typecheck
npx vitest run \
  src/editor/viewport/viewport-controller.test.ts \
  src/editor/tools/coordinates.test.ts \
  src/editor/tools/tool-controller.test.ts \
  src/editor/tools/tool-registry.test.ts \
  src/editor/document/stage5.test.ts
```

---

## 20. 阶段 1、2 源码复刻完成标准

1. ViewportStore 是 pan/zoom/fit/actual pixels 的唯一状态源。
2. 坐标转换覆盖 client、viewport、document、layer 和 asset pixel。
3. Renderer、Hit Test 和 Overlay 使用同一 world transform 语义。
4. Hand 和 Zoom 具备完整操作行为。
5. ToolRegistry 是工具元数据唯一来源。
6. ToolController 管理 pointer、cancel、capture 和临时工具。
7. Move、Marquee、Lasso 已迁移为独立 ToolSession。
8. Selection/Transform Overlay 不触发正式文档重绘。
9. 未实现工具有明确 unavailable 状态。
10. 一次手势最多产生一个历史项，取消产生零历史项。
11. `document-canvas.tsx` 不再承载工具算法。
12. 阶段 1、2 的 typecheck、定向测试和浏览器交互测试全部通过。

除以上工程标准外，19.2 和 19.3 的每一条母版源码都必须具备 Web 对应实现和测试证据。只要仍存在未迁移的原生字段、方法或事件分支，阶段就不得标记完成。完成后再按同样的源码复刻规则进入画笔、像素编辑和其他工具阶段。
