# PS / AE 风格 DocumentViewport：WebGL2 画布优化方案

> 状态：实施方案  
> 日期：2026-10-05  
> 适用范围：静态图片“选择并遮住”、后续视频 Object Matte / Roto Brush  
> 目标：将当前 CPU 单 Canvas 原型升级为专业级浏览器图像编辑视口。

## 1. 背景与结论

当前图层编辑器已经能够读取原图像素、编辑 Alpha Mask、进行基础预览并提交蒙版，但中央画布仍采用单个 Canvas 完成大部分工作：

- 每次画笔或参数变化重新计算整张 RGBA 图像。
- 通过修改 Canvas DOM 尺寸实现缩放。
- 像素网格使用 CSS 背景模拟。
- 源图、Mask、Overlay 和工具视觉没有清晰分层。
- 大尺寸图片下，画笔延迟和预览重算成本会快速增加。
- 当前架构难以继续承载 AE 风格逐帧 Matte、通道查看和传播结果。

优化结论：

> 使用 WebGL2 渲染源图、Mask 和背景合成；使用独立 2D Canvas 渲染工具覆盖层；使用 MaskDocument 保存权威蒙版数据；使用 BrushEngine 和 Tile History 实现局部更新及撤销。

这不是 Photoshop 的内部源码实现。Photoshop 桌面版使用 Metal、Direct3D 等原生 GPU 技术；WebGL2 是浏览器环境中对应且兼容性成熟的实现方式。

## 2. 优化目标

### 2.1 用户体验目标

- 缩放和平移接近 Photoshop 文档视口手感。
- 100% 时一个源图像素对应一个 CSS 逻辑像素。
- 高倍缩放时显示严格对齐的像素网格。
- 画笔快速移动时无明显断点、跳点或严重延迟。
- Overlay、黑底、白底、黑白和 Onion Skin 可即时切换。
- 蚂蚁线、画笔光标、Show Edge 等覆盖层保持屏幕像素清晰。
- 4K 图片的普通蒙版绘制不因整图重算而明显卡顿。

### 2.2 工程目标

- 保留现有项目状态、图层结构和蒙版提交链路。
- 不创建第二个编辑器、第二条 Timeline 或重复图层状态。
- React State 只保存界面状态，不保存大体量逐像素数组。
- GPU Texture 仅作为显示缓存，不作为唯一真实数据。
- 每次笔画只更新受影响区域，不重新上传整张 Mask。
- 静态图和未来视频帧复用相同 Viewer 基础设施。

## 3. 总体架构

```text
DocumentViewport
├── ViewportController
│   ├── camera matrix
│   ├── zoom / pan / rotate
│   ├── fit / 100% / resize / DPR
│   └── document ↔ screen 坐标转换
│
├── WebGL2Renderer
│   ├── source texture
│   ├── mask texture
│   ├── background / lower-layers texture
│   ├── preview shader
│   ├── tile texture cache
│   └── dirty texture uploads
│
├── OverlayCanvas
│   ├── marching ants
│   ├── pixel grid
│   ├── edge / refine visualization
│   ├── brush cursor
│   └── rulers / guides / ROI
│
├── BrushEngine
│   ├── pointer sampling
│   ├── interpolated stamps
│   ├── pressure / spacing / hardness
│   ├── dirty rectangles
│   └── stroke lifecycle
│
├── MaskDocument
│   ├── authoritative alpha buffer
│   ├── tile storage
│   ├── local refinements
│   └── serialization / export
│
└── HistoryManager
    ├── undo tiles
    ├── redo tiles
    ├── memory budget
    └── transaction boundaries
```

核心原则：

```text
MaskDocument = 真实蒙版数据
WebGL Texture = 显示缓存
Overlay Canvas = 临时工具视觉
React State = UI 参数和会话状态
Worker / WASM = 重计算法和后台任务
```

## 4. 模块设计

## 4.1 ViewportController

ViewportController 是所有显示层共享的相机与坐标系统。

职责：

- 维护文档尺寸、视口尺寸、缩放、平移和旋转。
- 提供 Document → Screen 和 Screen → Document 转换。
- 实现适合窗口、填充窗口、100%、逐级缩放。
- 实现鼠标位置中心缩放。
- 处理 Retina / 高 DPI 显示。
- 为 WebGL Renderer 和 Overlay Canvas 提供相同矩阵。

推荐接口：

```ts
type ViewportTransform = {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
  devicePixelRatio: number;
};

interface ViewportController {
  setViewportSize(width: number, height: number): void;
  setDocumentSize(width: number, height: number): void;
  screenToDocument(point: Point): Point;
  documentToScreen(point: Point): Point;
  zoomAt(screenPoint: Point, nextZoom: number): void;
  panBy(screenDelta: Point): void;
  fit(): void;
  actualPixels(): void;
  getMatrix(): Float32Array;
}
```

实现要求：

- GPU Canvas CSS 尺寸始终等于 Viewer 可用区域。
- Canvas backing store 尺寸为 CSS 尺寸乘以 `devicePixelRatio`。
- 不再通过放大 Canvas DOM 宽高实现缩放。
- 平移和缩放使用统一矩阵，避免 Overlay 与图像错位。
- 非整数缩放允许平滑显示；高倍像素模式使用最近邻采样。

## 4.2 WebGL2Renderer

WebGL2Renderer 负责最终文档预览，不负责保存真实蒙版数据。

### 纹理

- `sourceTexture`：原始图片 RGBA 纹理。
- `maskTexture`：单通道 Alpha Mask，优先使用 `R8`。
- `backgroundTexture`：真实下层合成结果，可选。
- `edgeTexture`：Show Edge / Refine Edge 结果，可选。
- 视频阶段增加当前帧、前一帧和后一帧纹理。

### Shader 预览模式

Fragment Shader 根据 UI uniform 实时切换：

- Original。
- Onion Skin。
- Overlay。
- On Black。
- On White。
- Black & White。
- On Layers。
- Alpha Channel。
- Show Edge。

推荐 Uniform：

```ts
type PreviewUniforms = {
  viewMode: number;
  overlayColor: [number, number, number];
  overlayOpacity: number;
  showOriginal: boolean;
  showEdge: boolean;
  checkerSize: number;
};
```

### 局部更新

画笔结束或移动时，只上传受影响区域：

```ts
gl.texSubImage2D(
  gl.TEXTURE_2D,
  0,
  dirtyRect.x,
  dirtyRect.y,
  dirtyRect.width,
  dirtyRect.height,
  gl.RED,
  gl.UNSIGNED_BYTE,
  dirtyPixels,
);
```

不得在每次 Pointer Move 时重新创建和上传完整 RGBA 图片。

### GPU 兼容与恢复

- 检测 WebGL2 是否可用。
- 监听 `webglcontextlost` 和 `webglcontextrestored`。
- GPU Context 丢失后，从 MaskDocument 重建纹理。
- 不支持 `R8` 的设备回退到 RGBA8 Mask Texture。
- WebGL2 完全不可用时提供低性能 Canvas2D fallback，并显示提示。

## 4.3 OverlayCanvas

Overlay Canvas 覆盖在 WebGL Canvas 上方，尺寸和 DPR 与 GPU Canvas 一致。

它只绘制临时工具视觉，不写入源图或 Mask：

- 画笔轮廓。
- 当前 Pointer 十字中心。
- 像素网格。
- 选区蚂蚁线。
- Show Edge 边界。
- 套索路径和多边形节点。
- 标尺、参考线、ROI 和安全框。

### 像素网格

- 只在缩放达到设定阈值时显示，例如 800%。
- 网格位置由 ViewportController 的文档原点计算。
- 网格线使用 1 个设备像素宽度。
- 平移后仍必须严格经过文档像素边界。
- 非整数屏幕像素位置需要进行半像素或 DPR 对齐处理。

### 蚂蚁线

- 从 Mask 等值线提取选区边界。
- 轮廓结果按 Dirty Tile 增量更新。
- 使用屏幕空间黑白虚线绘制。
- 使用 `requestAnimationFrame` 更新 dash offset。
- 动画不触发源图、Mask Texture 或 React 组件重新渲染。

## 4.4 MaskDocument

MaskDocument 是唯一可信的 Alpha 数据源。

推荐第一阶段使用完整 `Uint8Array`，接口提前按 Tile 设计：

```ts
interface MaskDocument {
  width: number;
  height: number;
  getPixel(x: number, y: number): number;
  getRegion(rect: Rect): Uint8Array;
  mutateRegion(rect: Rect, operation: MaskMutation): DirtyRegion;
  replaceAll(alpha: Uint8Array): void;
  serialize(): Promise<Blob>;
}
```

推荐 Tile 尺寸：

- 默认 `256 × 256`。
- 小图片可使用完整连续 Buffer。
- 8K 或更大图片再启用 Tile 懒加载和纹理分页。

MaskDocument 不进入 React State。React 中仅保存版本号或会话脏状态。

## 4.5 BrushEngine

BrushEngine 不直接操作 Canvas DOM，它接收文档坐标下的 Pointer Sample。

数据流程：

```text
Pointer Event
  → ViewportController.screenToDocument
  → BrushEngine.addSample
  → 路径插值
  → 生成 Brush Stamps
  → MaskDocument 修改局部区域
  → 返回 Dirty Rect
  → WebGL2Renderer.uploadMaskRegion
  → OverlayCanvas 更新光标
```

### 笔刷要求

- 使用 Pointer Events。
- 支持 Pointer Capture。
- 使用相邻采样点插值，防止快速移动断笔。
- `spacing` 按笔刷直径百分比计算。
- 硬度控制径向衰减，不只是圆形二值覆盖。
- 支持 Add、Subtract、New 和后续 Intersect。
- `Alt/Option` 临时切换减去模式。
- 压感通过 `PointerEvent.pressure` 接入。
- 鼠标设备压力固定为 1。
- 一次 Pointer Down 到 Pointer Up 形成一个 History Transaction。

## 4.6 HistoryManager

当前整张 Mask 复制方式不适合 4K/8K 和长时间编辑。

HistoryManager 以修改前 Tile 快照保存撤销数据：

```ts
type HistoryTransaction = {
  id: string;
  label: string;
  beforeTiles: TileSnapshot[];
  afterTiles?: TileSnapshot[];
  timestamp: number;
};
```

要求：

- 每个笔画形成一个事务。
- 同一 Tile 在一个事务内只保存一次 Before 状态。
- Undo 后按需保存 Redo Tile。
- 设置历史内存预算，例如 256 MB。
- 超出预算时删除最早事务。
- AI 选区、反相、羽化和套索同样使用 HistoryManager。

## 5. 渲染循环

不使用 React Render 驱动每一帧 GPU 绘制。

推荐使用无效化渲染：

```text
Source changed      ─┐
Mask dirty          ─┤
Camera changed      ─┤→ invalidate() → requestAnimationFrame → render once
Preview mode changed─┤
Viewport resized    ─┘
```

只有蚂蚁线等动画覆盖层需要持续帧循环。普通静态状态不持续占用 GPU。

## 6. 文件结构建议

```text
src/editor/layer-panel/
├── document-viewport/
│   ├── document-viewport.tsx
│   ├── viewport-controller.ts
│   ├── viewport-matrix.ts
│   └── viewport-types.ts
├── renderer/
│   ├── webgl2-renderer.ts
│   ├── shader-program.ts
│   ├── texture-manager.ts
│   ├── shaders/
│   │   ├── document.vert.ts
│   │   └── preview.frag.ts
│   └── canvas2d-fallback.ts
├── overlay/
│   ├── overlay-renderer.ts
│   ├── draw-pixel-grid.ts
│   ├── draw-brush-cursor.ts
│   ├── draw-marching-ants.ts
│   └── contour-cache.ts
├── brush/
│   ├── brush-engine.ts
│   ├── brush-stamp.ts
│   ├── interpolate-stroke.ts
│   └── dirty-rect.ts
├── mask-document/
│   ├── mask-document.ts
│   ├── mask-tile.ts
│   └── mask-serialization.ts
├── history/
│   ├── history-manager.ts
│   └── tile-snapshot.ts
└── layer-panel.tsx
```

## 7. 与现有代码的迁移关系

### 保留

- `LayerPanelSession` 的 UI 状态。
- Viewer Tab 和 Timeline 集成。
- 现有图片加载和本地 URL 管理方式。
- `commitLayerMaskToState` 非破坏式提交链路。
- Mask PNG 和 Cutout PNG 输出。
- 项目级 Undo 与编辑锁定逻辑。

### 替换

- 替换当前 `renderPreview()` 全图 CPU 循环。
- 替换通过 DOM 宽高缩放 Canvas 的方式。
- 替换 CSS 像素网格。
- 替换整张 Mask Clone 的局部撤销方式。
- 替换 Pointer Move 直接盖圆的基础笔刷逻辑。

### 延后

- AI 自动分割服务升级。
- Smart Radius 算法。
- Decontaminate Colors。
- 视频传播与 Freeze。
- 8K 超大图 Tile Renderer。
- WebGPU Compute。

## 8. 分阶段实施计划

## 阶段 0：基准与保护

目标：建立性能基线，确保重构不破坏现有输出。

- 增加 1K、2K、4K 测试图片。
- 记录当前首次显示、单笔画和参数调整耗时。
- 为 Mask 输出增加像素一致性测试。
- 为坐标转换增加单元测试。
- 保留 Canvas2D 原实现作为短期 Feature Flag fallback。

完成标准：

- 能够对新旧 Renderer 输出进行 A/B 对比。
- Mask 提交结果拥有可重复验证的测试样本。

## 阶段 1：ViewportController

目标：先解决专业视口的坐标和高 DPI 基础。

- 固定 GPU Canvas 与 Overlay Canvas 的 DOM 尺寸。
- 完成 DPR backing store。
- 完成 Camera Matrix。
- 完成 Fit、100%、鼠标中心缩放和空格平移。
- 完成 Document ↔ Screen 坐标测试。

完成标准：

- WebGL 和 Overlay 使用相同矩阵。
- 连续缩放和平移后坐标误差小于 0.25 文档像素。
- Resize 后视口不跳变。

## 阶段 2：WebGL2 基础 Renderer

目标：由 GPU 显示源图。

- 初始化 WebGL2 Context。
- 上传 Source Texture。
- 实现全屏 Quad 和相机矩阵。
- 实现平滑和最近邻采样切换。
- 实现透明棋盘格。
- 实现 Context Lost 恢复。

完成标准：

- 源图显示方向、颜色和 Alpha 正确。
- Fit、100% 和高倍缩放清晰稳定。
- 不再放大 Canvas DOM 节点。

## 阶段 3：Mask Texture 与 Preview Shader

目标：GPU 实时合成蒙版预览。

- 增加 MaskDocument。
- 上传单通道 Mask Texture。
- Shader 实现 Overlay、黑底、白底、黑白和 Onion Skin。
- 增加真实 On Layers 输入接口。
- UI 参数通过 Uniform 更新。

完成标准：

- 切换视图模式不创建整张新 ImageData。
- 调整 Overlay 颜色和透明度可即时完成。
- 新旧 Mask 输出像素一致。

## 阶段 4：Brush Engine 与局部上传

目标：获得接近专业编辑器的画笔连续性和响应速度。

- 实现 Stroke 生命周期。
- 实现路径插值、Spacing 和硬度衰减。
- 计算 Dirty Rect。
- 使用 `texSubImage2D` 局部更新。
- 接入 Add、Subtract 和 Alt 临时减去。

完成标准：

- 快速画线无可见断点。
- 单次 Pointer Move 不重算或上传完整 Mask。
- 4K 图像连续绘制保持可交互帧率。

## 阶段 5：Overlay Canvas

目标：完成 Photoshop 风格工具视觉。

- 实现 DPR 清晰画笔光标。
- 实现严格对齐的像素网格。
- 实现 Mask 轮廓提取和蚂蚁线。
- 实现 Show Edge 和 Refine 区域。
- 为套索和多边形套索预留绘制接口。

完成标准：

- 光标、网格和蚂蚁线不进入导出结果。
- 覆盖层在缩放和平移后无明显错位。
- 蚂蚁线动画不触发 React 高频更新。

## 阶段 6：Tile History

目标：降低撤销内存，并统一所有 Mask 操作历史。

- 实现 Tile Snapshot。
- 接入笔画 Undo / Redo。
- 接入反相、AI 选区和全局调整。
- 增加历史内存预算。

完成标准：

- 4K Mask 多次笔画不再为每一步复制完整 Buffer。
- Undo / Redo 后 GPU 纹理和 MaskDocument 完全一致。

## 阶段 7：Worker / 算法扩展

目标：为高级选择和 AE 功能建立计算通道。

- 将大范围 Blur、Erode、Dilate 移入 Worker。
- 评估 WASM SIMD。
- 接入 AI Segmentation。
- 实现 Refine Edge、Smart Radius 和 Decontaminate Colors。
- 视频阶段接入帧纹理、Matte 传播和 Freeze Cache。

## 9. 性能预算

建议首期目标：

| 指标 | 目标 |
| --- | --- |
| 2K 图片首次显示 | 小于 300 ms，不含网络下载 |
| 4K 图片首次显示 | 小于 700 ms，不含网络下载 |
| Camera 缩放和平移 | 目标 60 FPS，最低可接受 45 FPS |
| 普通画笔反馈 | 输入到显示小于 32 ms |
| Mask 局部上传 | 单次只覆盖 Dirty Rect |
| 视图模式切换 | 小于 16 ms 或下一帧完成 |
| Overlay 光标 | 60 FPS，无 React 高频重渲染 |
| 历史内存 | 默认上限 256 MB，可配置 |

性能测试必须覆盖：

- 1920 × 1080。
- 2048 × 2048。
- 3840 × 2160。
- 4096 × 4096。
- Retina DPR 2。
- 集成显卡和独立显卡环境。

## 10. 测试方案

### 单元测试

- Camera Matrix 正反转换。
- 鼠标中心缩放不漂移。
- Dirty Rect 合并和裁剪。
- Stroke 插值和 Spacing。
- 硬度衰减。
- Tile History Undo / Redo。
- Mask PNG 序列化。

### GPU 输出测试

- 使用固定源图和 Mask 渲染至离屏 Framebuffer。
- 读取像素并与期望结果比较。
- 覆盖 Overlay、黑底、白底、黑白和 Onion Skin。
- 为不同 Alpha 值验证 Shader 混合公式。

### 浏览器集成测试

- 打开图层页签。
- Fit、100% 和滚轮缩放。
- 空格平移和手形工具。
- 画笔添加、Alt 减去。
- 高倍像素网格。
- Undo / Redo。
- 切换预览模式。
- Context Lost 模拟恢复。
- 提交后原图保留且 Mask 正确。

## 11. 风险与处理

### 色彩差异

浏览器图片解码、Canvas 和 WebGL 的颜色空间可能存在差异。

处理：

- 第一阶段统一按 sRGB 处理。
- 保留 ICC / 广色域元数据评估项。
- Shader 中避免重复 Gamma 转换。
- 使用标准色块进行像素比对。

### GPU 最大纹理尺寸

部分设备无法上传超大单纹理。

处理：

- 启动时读取 `MAX_TEXTURE_SIZE`。
- 超限图片进入 Tile Texture 模式。
- 首期可明确提示超限，并回退 Canvas2D。

### WebGL Context 丢失

处理：

- MaskDocument 和源图资源必须可重建。
- Context 恢复后重建 Shader、Buffer 和 Texture。
- 编辑中的 Mask 不因 Context Lost 丢失。

### React 高频更新

处理：

- Camera、Pointer 和 Stroke 使用 Ref / Controller 对象。
- 只在状态栏需要时节流同步缩放百分比和坐标。
- GPU 和 Overlay Render Loop 不依赖组件每帧 Render。

## 12. 边界情况与不变量

本节是实施时必须逐项处理的边界清单。没有明确行为的边界情况，不应依赖浏览器默认行为或临时判断。

### 12.1 文档与资源输入

| 边界情况 | 必须行为 |
| --- | --- |
| 图片宽高为 0、负数、NaN 或非整数 | 拒绝创建 DocumentViewport，显示可恢复错误，不初始化 GPU 资源 |
| 图片解码失败、Blob URL 失效或远程 URL 不可访问 | 保留会话和原 Item，允许重试或取消，不创建空白 Mask 覆盖原数据 |
| 图片 EXIF 方向未归一化 | 上传纹理前统一方向，Mask 坐标始终对应视觉方向后的像素坐标 |
| Source 与现有 Mask 尺寸不一致 | 禁止静默拉伸；要求显式重采样或放弃旧 Mask，并记录操作来源 |
| 图片超过 `MAX_TEXTURE_SIZE` | 自动进入 Tile Renderer 或明确回退，不尝试必然失败的整图纹理上传 |
| 图片尺寸乘积导致 TypedArray 分配失败 | 在分配前估算内存，拒绝操作并给出尺寸及预计内存提示 |
| 完全透明图片 | 仍可编辑 Alpha；选择主体不得把透明 RGB 噪声识别为前景 |
| 灰度图、无 Alpha 图、预乘 Alpha 图 | 解码后统一为约定的 RGBA / Straight Alpha 表示 |
| 跨域图片污染 Canvas | 图片读取必须通过可控 Blob、本地缓存或正确 CORS；不得等到导出时才发现不可读 |

资源加载需要使用请求版本号或 `AbortController`。当用户快速切换图层、关闭 Tab 或重新载入 Asset 时，旧异步结果不得覆盖新会话。

### 12.2 尺寸、DPR 与坐标精度

必须维护以下不变量：

```text
document coordinate：以源图左上角为原点，单位为源像素
screen coordinate：以 Viewer 内容区左上角为原点，单位为 CSS px
device coordinate：Canvas backing store 坐标，单位为 device px
Mask 坐标：始终与 document coordinate 一一对应
```

边界处理：

- Viewer 宽高为 0（隐藏面板、折叠布局、初始化中）时暂停渲染，不执行 Fit 除法。
- `devicePixelRatio` 在窗口跨屏、系统缩放或浏览器缩放后变化时，重建 backing store 并重绘 Overlay。
- 缩放值必须验证为有限正数，并限制在约定范围内，例如 1%–6400%。
- Camera Matrix 和逆矩阵不可逆时立即回退到上一个有效 Transform。
- Pointer 落在文档外时，不写 Mask；笔刷半径越界时仅裁剪 Dirty Rect，不改变画笔中心坐标。
- 文档边缘像素必须可完整绘制，Dirty Rect 采用半开区间 `[left, right)`、`[top, bottom)`，避免多一列或少一列。
- 100% 模式需要定义清楚：一个文档像素对应一个 CSS px；DPR 只提高显示采样，不改变逻辑缩放比例。
- 像素网格由文档边界转换到设备像素后绘制，不以累计加法生成，防止长距离浮点漂移。
- 旋转不是第一阶段必需能力；在实现前 `rotation` 必须固定为 0，不能保留一个实际未被所有模块支持的可变状态。

坐标往返测试必须覆盖四个角、中心、负平移、极限缩放、DPR 1/1.25/1.5/2/3，以及宽高为奇数的文档。

### 12.3 WebGL2 与纹理上传

初始化时必须读取并记录：

- `MAX_TEXTURE_SIZE`。
- `MAX_RENDERBUFFER_SIZE`。
- `MAX_VIEWPORT_DIMS`。
- 可用纹理单元数量。
- `R8/RED` 上传路径是否正常。

纹理边界要求：

- 明确统一 WebGL 纹理 Y 方向，禁止在 Shader、上传代码和坐标转换中重复翻转。
- 上传单通道 Mask 前设置并恢复 `UNPACK_ALIGNMENT`，特别处理宽度不是 4 的倍数。
- Source Texture 明确 `premultiplyAlpha` 和颜色空间策略，避免黑边、白边和重复 Gamma 转换。
- Dirty Rect 为空、宽高为 0 或完全位于文档外时，不调用 `texSubImage2D`。
- Dirty Rect 必须裁剪到纹理范围，上传 Buffer 长度必须严格等于区域面积。
- Texture 创建或上传后检查 GL Error；生产环境可采样检查，开发环境应严格检查。
- Context Lost 期间停止所有 GL 调用，但继续保留 MaskDocument 和未提交历史。
- Context Restore 后按固定顺序重建 Program、Buffer、Source Texture、Mask Texture 和 Uniform State。
- 恢复失败时切换 Canvas2D fallback，不能让 Viewer 永久空白。

浏览器或系统报告 WebGL2 可用，不代表资源一定能分配成功。纹理分配失败、GPU Reset 和显存不足都必须走相同的可恢复失败路径。

### 12.4 Pointer、触控笔与笔画生命周期

一次合法笔画必须遵循：

```text
Idle → PointerDown → ActiveStroke → PointerUp/Cancel → CommitHistory → Idle
```

必须处理：

- `pointercancel`、窗口失焦、Tab 切换、组件卸载和 Pointer Capture 丢失。
- Pointer Up 发生在 Canvas 外部。
- 多指触摸或第二支 Pointer 进入；第一阶段只允许一个活动绘制 Pointer，其余用于手势或忽略。
- Space、Alt/Option 在笔画中途按下或松开。Add/Subtract 模式应在每个 Sample 明确定义，或在笔画开始时锁定，不能行为不确定。
- 压力值为 0、NaN、缺失或设备始终返回 0.5；必须按 pointerType 提供安全默认值。
- 采样点时间戳相同、顺序异常或距离极大；插值算法必须限制最大补点数量，避免事件恢复后一次生成百万 Stamp。
- Brush Size 小于 1 px、大于文档尺寸、Spacing 为 0 或超过 1000%。所有参数进入 BrushEngine 前统一 Clamp。
- 硬度 0% 和 100% 的端点公式必须稳定，不产生除零或 Alpha NaN。
- 同一点长按时是否累积必须由 Flow 模型定义；第一阶段若无 Flow，应保证重复 Sample 不意外加深。

中断笔画的默认策略：保留已经显示的有效 Stamp，并作为一个可撤销事务提交；只有显式取消工具操作时才整体回滚。

### 12.5 Dirty Rect、Tile 与历史

- Tile 坐标、像素坐标和 Dirty Rect 全部使用整数。
- 一个事务修改同一 Tile 多次时，只保存一次 Before Snapshot。
- 笔画跨越大量 Tile 时，历史系统必须先检查内存预算，避免中途只记录一部分 Undo 数据。
- History Transaction 未正常结束时，不得进入 Undo Stack。
- Undo / Redo 期间禁止并发写入同一 MaskDocument；操作结束后统一上传受影响 Tile。
- 新操作发生后清空 Redo Stack。
- 超出历史预算时按完整事务淘汰，不能删除事务中的部分 Tile。
- AI 全图替换、反相和大半径羽化可能覆盖所有 Tile，应允许压缩 Snapshot 或临时提高预算后给出提示。
- Tile 边缘笔刷计算必须包含足够 Halo，羽化或卷积不能在 Tile 接缝产生可见边线。
- 空操作不进入历史，例如笔刷完全在文档外、Subtract 作用于全黑区域。

### 12.6 Shader 与预览模式

所有预览模式必须共享同一 Alpha 定义：0 为隐藏，255 为完整保留。

需要重点验证：

- Mask Alpha 为 0、1、127、128、254、255。
- Source Alpha 为 0 但 RGB 非零的隐藏颜色。
- Source Alpha 与 Mask Alpha 同时为半透明。
- Overlay Opacity 为 0% 和 100%。
- Overlay Color 为黑、白和高饱和颜色。
- On Black / On White 不得改变 Mask 本身。
- Black & White 模式只显示 Mask，不受 Source RGB 和 Source Alpha 污染。
- Show Original 绕过 Refinement 结果，但不能替换或重置原始 Mask。
- On Layers 缺少下层合成纹理时显示明确的透明背景 fallback，不能伪装成真实下层。

Shader 编译失败时记录 Shader 名称和日志，并自动回退到最低能力预览；不得因一个高级模式失败导致整个 Viewer 不可用。

### 12.7 Overlay 与动画

- Overlay Canvas 必须设置 `pointer-events: none`，输入统一由 Viewer Input Layer 接收。
- Brush Cursor 在文档外隐藏或切换为禁止状态，不能继续显示可绘制反馈。
- 画笔直径小于一个屏幕像素时仍提供最小可见光标，但真实 Stamp 大小不被改变。
- 蚂蚁线轮廓为空时停止动画循环。
- 页面隐藏时暂停蚂蚁线 RAF；恢复显示后重置时间基准，避免 Dash 相位突然跳跃。
- 超大复杂轮廓需要简化或分 Tile 缓存，不能每帧重新进行全图轮廓提取。
- Pixel Grid、Marching Ants 和 Cursor 使用屏幕空间线宽，不随文档缩放变粗。
- Overlay 重绘不得触发 Source Texture 或 Mask Texture 重传。

### 12.8 并发、保存与销毁

- 导出或点击“确定”时，必须先结束活动笔画并固定一个 Mask 版本。
- 导出过程中继续编辑时，应导出固定版本或暂时锁定编辑，不能读取一半新一半旧的数据。
- 切换图层、关闭 Tab、取消编辑时，必须取消 Worker、轮廓提取、图片解码和上传任务。
- 组件卸载时释放 Texture、Framebuffer、Buffer、Program、RAF 和事件监听器。
- Object URL 仅在所有消费者释放后撤销。
- 用户取消时不写项目状态；GPU Cache 和临时 History 可以销毁。
- 提交成功但远程上传失败时，沿用现有 Pending Upload 恢复机制，不丢失本地 Asset。
- 多个 Layer Tab 同时存在时，每个会话独立保存 MaskDocument 和 History；可共享只读 Source Texture Cache，但不能共享可写 Mask。

### 12.9 性能降级策略

定义明确的能力等级：

| 等级 | 能力 | 行为 |
| --- | --- | --- |
| A | WebGL2 + R8 + 完整纹理 | 使用完整 GPU 路径 |
| B | WebGL2 + RGBA8 Mask | 功能相同，显存占用增加 |
| C | WebGL2 Tile Renderer | 支持超过单纹理限制的大图 |
| D | Canvas2D fallback | 保留基础绘制和提交，关闭高成本动态预览 |
| E | 无可用渲染路径 | 只允许取消或下载原资源，不允许产生错误 Mask |

降级必须对用户透明说明当前能力，但不得自动降低 Mask 数据精度。高质量预览可以降级，编辑结果不能静默降级。

## 13. 实施门禁与测试矩阵

每个阶段合并前必须通过对应门禁：

| 门禁 | 必须通过的内容 |
| --- | --- |
| 正确性 | CPU 参考实现与 GPU 输出的像素差异在约定容差内 |
| 坐标 | 缩放、平移、Resize、DPR 变化后采样点仍落在同一文档像素 |
| 恢复 | Context Lost、资源加载失败、关闭 Tab 不丢项目数据 |
| 性能 | 4K 连续笔画不发生整图 CPU 合成和整图纹理上传 |
| 内存 | 长时间绘制后历史和 GPU 资源保持在预算范围 |
| 生命周期 | Mount/Unmount、图层快速切换无残留监听器和异步回写 |
| 回退 | 禁用 WebGL2 后 Canvas2D fallback 能完成基础编辑与提交 |

建议自动化矩阵：

```text
文档：1×1、奇数尺寸、透明图、2K、4K、超 MAX_TEXTURE_SIZE
DPR：1、1.25、1.5、2、3
缩放：最小值、Fit、100%、800%、最大值
输入：鼠标、触控板、触控笔、Pointer Cancel、窗口失焦
Mask：全黑、全白、单像素、软边、跨 Tile 边界
GPU：R8、RGBA8 fallback、Context Lost、纹理分配失败
生命周期：快速切图层、关闭 Tab、取消、提交、上传失败
```

生产构建之外，建议增加一个开发诊断面板，显示：Renderer 等级、DPR、纹理尺寸、Mask 版本、Dirty Rect、上传字节数、活动 Tile、历史内存和最近一帧耗时。诊断面板只在开发模式启用。

## 14. Definition of Done

当以下条件全部满足，才能认为 WebGL2 DocumentViewport 第一阶段完成：

- 原图、Mask 和预览模式由 WebGL2 合成。
- 不再通过放大 Canvas DOM 实现缩放。
- 不再因每次笔画重算整张 RGBA 图片。
- MaskDocument 是唯一可信的蒙版数据源。
- 画笔拥有路径插值、Spacing、硬度和 Dirty Rect。
- Mask Texture 使用局部上传。
- Overlay Canvas 实现 DPR 清晰光标和像素网格。
- 蚂蚁线是真实 Mask 轮廓动画。
- Undo / Redo 使用 Tile History。
- 现有非破坏式提交和导出逻辑保持兼容。
- TypeScript、Lint、单元测试、生产构建和浏览器集成测试通过。
- 4K 测试图片达到约定的交互性能指标。
- 上述边界测试矩阵全部有明确测试或人工验收记录。
- 不存在未处理的 Pointer Cancel、Context Lost、异步加载竞态或资源销毁路径。
- WebGL2、RGBA8 Mask 和 Canvas2D fallback 至少各完成一次端到端提交验证。

## 15. 最终建议

本次优化应视为渲染内核迁移，而不是 Canvas 样式升级。

推荐按以下优先级实施：

1. ViewportController。
2. WebGL2 Source Renderer。
3. MaskDocument 与 Preview Shader。
4. BrushEngine 与局部 Texture Upload。
5. Overlay Canvas。
6. Tile History。
7. Refine Edge、AI Segmentation 和 AE 视频能力。

实施过程中保持现有 Canvas2D 版本作为 Feature Flag 回退，直到 WebGL2 路径完成输出一致性和性能验收后，再删除旧 Renderer。
