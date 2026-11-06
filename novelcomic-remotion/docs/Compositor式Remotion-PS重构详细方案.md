# Compositor 式 Remotion PS 重构详细方案

> 状态：Compositor 彻底重构施工合同已细化，待按 PR-0 -> 阶段一 -> 阶段二实施
>
> 目标工程：`novelcomic-remotion`
>
> 参照工程：`Compositor`
>
> 更新时间：2026-10-07

## 0. 先说结论

本次不是给 Remotion 增加一个 `.comp` 导入器，不是把 Compositor 的格式兼容到现有视频时间线里，也不是在旧编辑器上拼接一组 PS 工具。

本次目标是：**彻底按照 Compositor 的产品模型和工作流重构 `novelcomic-remotion`：以 Compositor 式图像合成编辑器作为第一产品入口，以 Document/Layer Tree/Mask/Adjustment/Effect/History 为唯一核心；Remotion 退回到预览、逐帧求值和视频输出引擎，动态漫画和视频能力作为其上的动画工作区。**

这里的“按照 Compositor 重构”是结构性目标，不是兼容性目标：新系统必须重新建立 Compositor 的文档真相源、图层树、非破坏编辑、命令历史、工程保存、导入导出和像素处理闭环；旧 `tracks/items` 编辑器只能作为迁移期适配器和后续 Animation Workspace，不能继续作为新 PS 工作区的基础。

因此，现有项目中以 `tracks/items/from/durationInFrames` 为中心的编辑器不能继续作为唯一真相源。它适合视频编排，不适合 Compositor 的静态图层文档。重构后必须有一套以 `Document -> Layer Tree -> Pixel/Mask/Effect/Adjustment` 为中心的文档模型，时间线只引用这个文档模型，不再拥有图层本体。

这份文档是后续施工合同，按它实施时不能重新引入以下做法：

- 不通过新增兼容字段继续扩展旧 `UndoableState`。
- 不把 Compositor 的图层语义压扁成一条条视频轨道。
- 不让 React 组件直接修改像素数组、文件或服务端工程记录。
- 不把 Remotion Player 当作 PS 画布本身。
- 不在没有命令、事务和历史记录的情况下直接 `setState`。
- 不把 `.comp` 作为浏览器端必须支持的兼容格式；Web 端定义自己的正式工程格式。

### 0.1 本方案的施工约束（先文档，后代码）

本文件本身是施工合同。每个阶段先完成“输入、输出、禁止事项、验收”四项定义，再开始写代码；没有通过当前阶段验收，不进入下一阶段。阶段一、二虽然只建立领域边界和持久化边界，但最终目标已经确定为彻底重构，不是为旧时间线增加一层兼容 API。

本项目采用 **TypeScript 负责浏览器/Remotion/服务端运行时，Python 负责离线校验、迁移向量和批量工程工具** 的边界：

- TypeScript 是运行时唯一实现，负责命令执行、React 状态、IndexedDB、API 和 Remotion 求值。
- Python 不直接修改浏览器状态，不复制一份业务规则；它只消费/生成正式 JSON，执行离线 schema 检查、迁移 fixture、批量资产清单和 CI 校验。
- 两种语言共用 `schemaVersion`、字段名、枚举值和 canonical JSON 规则。任何跨语言差异必须由固定 JSON fixture 暴露，不能靠“看起来一样”判断。
- Python 工具必须是可选的离线工具；没有 Python 时，TypeScript 的开发、构建和浏览器运行仍然完整可用。

阶段一、二不得要求用户同时理解旧 `UndoableState`、新 `DocumentState` 和服务端数据库记录。对外只暴露一个 `DocumentRepository` 和一个 `DocumentCommand` 协议，旧状态只能在迁移入口出现；阶段十三完成后，旧状态不得再参与 PS 主路径。

---

## 1. 参照对象：Compositor 到底要复制什么

Compositor 不是一个视频编辑器，而是一个以图层树为核心的非破坏性图像合成器。它的功能可以拆成以下八个域。

### 1.1 文档与工程

- 文档有固定宽高、分辨率、颜色空间。
- 工程是一个可保存、可恢复、可版本化的文档，而不是浏览器临时状态。
- 保存采用原子替换：素材先写入，清单最后一次性提交。
- 工程打开时可以被外部程序修改，编辑器检测外部变更并重新加载。
- 多项目标签页、最近项目、项目切换和关闭前未保存检查属于产品基础能力。
- 工程格式有显式 schema version，旧版本可迁移，新版本拒绝打开并给出明确错误。

### 1.2 图层树

- 图层以从下到上的顺序排列。
- 图层可以是普通像素层、文件夹、文字层、形状层、调整层。
- 文件夹可以嵌套，文件夹的可见性和不透明度会继承到子树。
- 图层可以重命名、复制、删除、拖拽排序、拖入/拖出文件夹。
- 图层支持锁定、隐藏、Solo、选择和多选。
- 图层支持在同一工程内复制粘贴，也支持跨工程复制粘贴。

### 1.3 非破坏性变换

- 移动、缩放、旋转、水平/垂直翻转不改源像素。
- 多图层或整个文件夹可以一起变换。
- 支持画布边缘、图层边缘、中心线、网格和辅助线吸附。
- 支持精确数值输入和键盘微调。
- 支持自由变形；变形操作在提交前是一个事务，提交后进入一次撤销记录。

### 1.4 蒙版与裁切

- 普通图层蒙版：白色显示、黑色隐藏、灰色半透明。
- 蒙版可以绘制、填充、反相、模糊、羽化、独立变换。
- 蒙版可以链接或解除链接图层变换。
- 剪贴蒙版/实时 alpha 来源独立于目标图层保存。
- 文件夹也可以有蒙版，蒙版作用于整个子树。
- 蒙版删除、应用、烘焙和解除链接必须是可撤销命令。

### 1.5 调整层与图层效果

- 调整层只改变其下方范围，不直接破坏像素。
- 至少支持 Hue/Saturation、Levels、Curves、Exposure、Gradient Map、Grain、Invert、Black & White、Color Balance、Gaussian Blur、Motion Blur、Add Noise。
- 图层效果与像素分离保存：Stroke、Drop Shadow、Color Overlay、Inner Shadow、Outer Glow、Inner Glow。
- 每种效果独立开关、参数可编辑、可撤销。
- 预览可以使用低分辨率或 GPU 近似，最终导出必须走完整分辨率。

### 1.6 选择、绘制和修图

- Rectangle/Ellipse Marquee。
- Freehand/Polygon Lasso。
- Magic Wand、Color Range、Object Selection。
- Select Subject、Expand、Contract、Feather。
- Brush、Eraser、Blur、Smudge、Clone Stamp、Spot Healing。
- Gradient、Shape、Type。
- Content-Aware Fill、Remove Background 等 AI/像素工具。

### 1.7 文字与形状

- 文字保持可编辑元数据，同时保留像素回退图。
- 段落框、字体、字号、颜色、对齐、字距、行距均可编辑。
- 文字支持局部字体和颜色 runs。
- 矩形、圆角矩形、椭圆、直线等形状保持可编辑样式。

### 1.8 导入、导出和渲染

- PNG/JPEG/HEIC/TIFF/SVG/RAW/PSD/PSB 作为输入来源。
- 导入复杂格式时要有转换报告，不能静默丢失内容。
- 导出静态图片时合成所有图层。
- Remotion 负责把图层文档在某个 frame 求值并渲染为图片或视频。
- 动画不是替代图层文档，而是图层属性的时间函数。

### 1.9 Compositor 功能逐项复刻索引

下面的链接是复刻时的第一参考实现和对应测试，不是泛泛的功能名称。每一项都必须在本项目的 parity matrix 中有 `planned / implemented / verified` 状态；只有实现和测试链接都存在，才能把该项标记为完成。链接路径相对于本文件所在的 `novelcomic-remotion/docs/` 目录。

parity matrix 的最小记录格式固定如下，后续施工不再重复向模型解释验收口径：

```json
{
  "featureId": "layer.mask.feather",
  "reference": ["../../Compositor/Compositor/Document/LayerMask.swift"],
  "stage": 6,
  "commandIds": ["mask.update"],
  "tests": ["src/editor/masks/layer-mask.test.ts"],
  "evidence": ["tests/fixtures/compositor-parity/layer-mask-feather.png"],
  "status": "planned",
  "parity": "equivalent"
}
```

`reference` 是 Compositor 源码，`tests` 和 `evidence` 必须换成本项目真实文件；`web-adapted` 只能用于平台实现不同但用户行为和像素结果等价的功能，不能用来掩盖缺失实现。

#### 工程、项目和图层

- 工程 manifest、版本校验、原子保存、缺失素材保护：[ProjectStore.swift](../../Compositor/Compositor/IO/ProjectStore.swift)、[project-format.md](../../Compositor/docs/project-format.md)。
- 外部文件变更监听和重新加载：[ProjectWatcher.swift](../../Compositor/Compositor/IO/ProjectWatcher.swift)、[ProjectController+ExternalChanges.swift](../../Compositor/Compositor/IO/ProjectController+ExternalChanges.swift)。
- 保存期间继续编辑、保存代次、关闭前等待：[ProjectController.swift](../../Compositor/Compositor/IO/ProjectController.swift)。
- 多项目标签、项目切换、最近项目：[ProjectTabs.swift](../../Compositor/Compositor/UI/ProjectTabs.swift)、[ProjectTabLayout.swift](../../Compositor/Compositor/UI/ProjectTabLayout.swift)、[RecentProjects.swift](../../Compositor/Compositor/IO/RecentProjects.swift)。
- 文档尺寸、图层数、内存预算和超大文件限制：[DocumentLimits.swift](../../Compositor/Compositor/Document/DocumentLimits.swift)、[LargeCanvasBrushTests.swift](../../Compositor/CompositorTests/LargeCanvasBrushTests.swift)。
- 图层树父子关系、排序、可见性、嵌套：[LayerGroups.swift](../../Compositor/Compositor/Document/LayerGroups.swift)、[LayersPanel.swift](../../Compositor/Compositor/UI/LayersPanel.swift)、[LayerTests.swift](../../Compositor/CompositorTests/LayerTests.swift)、[GroupTests.swift](../../Compositor/CompositorTests/GroupTests.swift)。
- 不透明度、锁定、混合模式和图层外观：[LayerAppearance.swift](../../Compositor/Compositor/Document/LayerAppearance.swift)、[BlendModePicker.swift](../../Compositor/Compositor/UI/BlendModePicker.swift)、[LayerAppearanceTests.swift](../../Compositor/CompositorTests/LayerAppearanceTests.swift)。
- 新建、复制、重命名、删除、拖拽重排、合并：[LayerGroups.swift](../../Compositor/Compositor/Document/LayerGroups.swift)、[LayerMerge.swift](../../Compositor/Compositor/Document/LayerMerge.swift)、[LayerTests.swift](../../Compositor/CompositorTests/LayerTests.swift)。
- 图层/文件夹复制粘贴和跨项目粘贴：[SelectionClipboard.swift](../../Compositor/Compositor/Document/SelectionClipboard.swift)、[SelectionClipboardTests.swift](../../Compositor/CompositorTests/SelectionClipboardTests.swift)。
- 工程历史、撤销/重做和事务合并：[DocumentHistory.swift](../../Compositor/Compositor/Document/DocumentHistory.swift)、[HistoryTests.swift](../../Compositor/CompositorTests/HistoryTests.swift)。

#### 蒙版、剪贴和调整

- 普通图层蒙版：绘制、填充、反相、禁用、删除：[LayerMask.swift](../../Compositor/Compositor/Document/LayerMask.swift)、[LayerMaskTests.swift](../../Compositor/CompositorTests/LayerMaskTests.swift)。
- 蒙版独立变换、链接/解除链接、羽化和模糊：[MaskTracing.swift](../../Compositor/Compositor/Document/MaskTracing.swift)、[MaskTransformTests.swift](../../Compositor/CompositorTests/MaskTransformTests.swift)。
- 剪贴蒙版、文件夹蒙版、live mask：[LiveLayerMask.swift](../../Compositor/Compositor/Document/LiveLayerMask.swift)、[LiveMaskRenderer.swift](../../Compositor/Compositor/Rendering/LiveMaskRenderer.swift)、[LiveMaskTests.swift](../../Compositor/CompositorTests/LiveMaskTests.swift)。
- Mask Alone、mask overlay 和选择/蒙版互转：[MaskAloneTests.swift](../../Compositor/CompositorTests/MaskAloneTests.swift)、[SelectionEdits.swift](../../Compositor/Compositor/Document/SelectionEdits.swift)。
- Hue/Saturation：[HueSaturation.swift](../../Compositor/Compositor/Document/HueSaturation.swift)、[HueSaturationSheet.swift](../../Compositor/Compositor/UI/HueSaturationSheet.swift)、[HueSaturationTests.swift](../../Compositor/CompositorTests/HueSaturationTests.swift)。
- Levels 和 Auto Levels：[Levels.swift](../../Compositor/Compositor/Document/Levels.swift)、[LevelsAutomatic.swift](../../Compositor/Compositor/Document/LevelsAutomatic.swift)、[LevelsSheet.swift](../../Compositor/Compositor/UI/LevelsSheet.swift)、[LevelsTests.swift](../../Compositor/CompositorTests/LevelsTests.swift)。
- Curves：[Curves.swift](../../Compositor/Compositor/Document/Curves.swift)、[CurvesControls.swift](../../Compositor/Compositor/UI/CurvesControls.swift)。
- Exposure、Gradient Map、Grain、Black & White、Color Balance、Invert：[ImageAdjustments.swift](../../Compositor/Compositor/Document/ImageAdjustments.swift)、[PixelInvert.swift](../../Compositor/Compositor/Document/PixelInvert.swift)、[AdjustmentLayerTests.swift](../../Compositor/CompositorTests/AdjustmentLayerTests.swift)。
- Gaussian Blur、Motion Blur、Noise：[Filters.swift](../../Compositor/Compositor/Document/Filters.swift)、[BlurTool.swift](../../Compositor/Compositor/Document/BlurTool.swift)、[FilterTests.swift](../../Compositor/CompositorTests/FilterTests.swift)。
- Stroke、Drop Shadow、Color Overlay、Inner Shadow、Outer Glow、Inner Glow：[LayerEffects.swift](../../Compositor/Compositor/Document/LayerEffects.swift)、[LayerEffectsSurface.swift](../../Compositor/Compositor/Rendering/LayerEffectsSurface.swift)、[InnerGlowTests.swift](../../Compositor/CompositorTests/InnerGlowTests.swift)、[OuterGlowTests.swift](../../Compositor/CompositorTests/OuterGlowTests.swift)。
- 调整预览、提交、取消和选区限定预览：[AdjustmentEditing.swift](../../Compositor/Compositor/Document/AdjustmentEditing.swift)、[EffectsPreviewCache.swift](../../Compositor/Compositor/Rendering/EffectsPreviewCache.swift)。

#### 变换、选择和画布

- 移动、缩放、旋转、翻转和非破坏性变换：[LayerTransform.swift](../../Compositor/Compositor/Document/LayerTransform.swift)、[LayerFlip.swift](../../Compositor/Compositor/Document/LayerFlip.swift)、[TransformInspector.swift](../../Compositor/Compositor/UI/TransformInspector.swift)、[TransformTests.swift](../../Compositor/CompositorTests/TransformTests.swift)。
- 多层/文件夹整体变换：[LayerTransform.swift](../../Compositor/Compositor/Document/LayerTransform.swift)、[GroupingSelectionTests.swift](../../Compositor/CompositorTests/GroupingSelectionTests.swift)。
- 自由变形和四角/边控制点：[Distort.swift](../../Compositor/Compositor/Document/Distort.swift)、[MetalWarp.swift](../../Compositor/Compositor/Rendering/MetalWarp.swift)、[DistortTests.swift](../../Compositor/CompositorTests/DistortTests.swift)。
- 画布边缘、图层边缘、中心线、网格和辅助线吸附：[Guides.swift](../../Compositor/Compositor/Document/Guides.swift)、[CanvasRulers.swift](../../Compositor/Compositor/UI/CanvasRulers.swift)、[ResizeSnapTests.swift](../../Compositor/CompositorTests/ResizeSnapTests.swift)。
- 精确数值输入、拖拽 scrub、箭头微调：[NumericScrub.swift](../../Compositor/Compositor/UI/NumericScrub.swift)、[SliderSnap.swift](../../Compositor/Compositor/UI/SliderSnap.swift)、[SliderSnapTests.swift](../../Compositor/CompositorTests/SliderSnapTests.swift)。
- 矩形/椭圆选框、自由套索、多边形套索：[Selection.swift](../../Compositor/Compositor/Document/Selection.swift)、[LassoControls.swift](../../Compositor/Compositor/UI/LassoControls.swift)、[SelectionTests.swift](../../Compositor/CompositorTests/SelectionTests.swift)。
- Magic Wand、按颜色选择：[MagicWand.swift](../../Compositor/Compositor/Document/MagicWand.swift)、[WandPixels.c](../../Compositor/Compositor/Rendering/WandPixels.c)、[MagicWandTests.swift](../../Compositor/CompositorTests/MagicWandTests.swift)。
- Color Range 选择：[ColorRangeSelection.swift](../../Compositor/Compositor/Document/ColorRangeSelection.swift)、[ColorRangeSheet.swift](../../Compositor/Compositor/UI/ColorRangeSheet.swift)。
- Object Selection：[ObjectSelection.swift](../../Compositor/Compositor/Document/ObjectSelection.swift)、[SmartEditTests.swift](../../Compositor/CompositorTests/SmartEditTests.swift)。
- Select Subject：[SubjectRemoval.swift](../../Compositor/Compositor/Document/SubjectRemoval.swift)、[SmartEditTests.swift](../../Compositor/CompositorTests/SmartEditTests.swift)。
- 选区 add/subtract/intersect、移动、复制内部像素：[SelectionEdits.swift](../../Compositor/Compositor/Document/SelectionEdits.swift)、[SelectionEditTests.swift](../../Compositor/CompositorTests/SelectionEditTests.swift)。
- Expand、Contract、Feather、边缘修整：[SelectionEdits.swift](../../Compositor/Compositor/Document/SelectionEdits.swift)、[SelectionFeatherTests.swift](../../Compositor/CompositorTests/SelectionFeatherTests.swift)。
- 从图层像素或蒙版载入选择：[SelectionClipboard.swift](../../Compositor/Compositor/Document/SelectionClipboard.swift)、[SelectionTests.swift](../../Compositor/CompositorTests/SelectionTests.swift)。
- Content-Aware Fill 和扩展画布填充：[ContentFill.swift](../../Compositor/Compositor/Document/ContentFill.swift)、[ContentFill.h](../../Compositor/Compositor/Rendering/ContentFill.h)。
- 裁切、比例、对称裁切和裁切吸附：[Crop.swift](../../Compositor/Compositor/Document/Crop.swift)、[CropControls.swift](../../Compositor/Compositor/UI/CropControls.swift)、[CropTests.swift](../../Compositor/CompositorTests/CropTests.swift)。
- Canvas Size、Image Size、Trim：[CanvasSize.swift](../../Compositor/Compositor/Document/CanvasSize.swift)、[CanvasResizer.swift](../../Compositor/Compositor/IO/CanvasResizer.swift)、[ImageResizer.swift](../../Compositor/Compositor/IO/ImageResizer.swift)、[ImageSizeTests.swift](../../Compositor/CompositorTests/ImageSizeTests.swift)、[ImageTrimTests.swift](../../Compositor/CompositorTests/ImageTrimTests.swift)。
- 标尺、辅助线、布局网格、像素网格和缩放显示：[CanvasRulers.swift](../../Compositor/Compositor/UI/CanvasRulers.swift)、[CanvasLinesOverlay.swift](../../Compositor/Compositor/Rendering/CanvasLinesOverlay.swift)、[CanvasViewport.swift](../../Compositor/Compositor/Rendering/CanvasViewport.swift)。

#### 绘制、修图、文字和形状

- Brush：尺寸、硬度、不透明度、平滑、直线、Paint/Erase：[BrushStroke.swift](../../Compositor/Compositor/Document/BrushStroke.swift)、[EditorSession+Brush.swift](../../Compositor/Compositor/Document/EditorSession+Brush.swift)、[BrushPixels.c](../../Compositor/Compositor/Rendering/BrushPixels.c)、[BrushTests.swift](../../Compositor/CompositorTests/BrushTests.swift)。
- Eraser 和原生分辨率绘制：[PixelAdjust.swift](../../Compositor/Compositor/Document/PixelAdjust.swift)、[NativeResolutionPaintTests.swift](../../Compositor/CompositorTests/NativeResolutionPaintTests.swift)。
- Blur tool（像素或蒙版）：[BlurTool.swift](../../Compositor/Compositor/Document/BlurTool.swift)、[BlurBrushTests.swift](../../Compositor/CompositorTests/BlurBrushTests.swift)。
- Smudge/Liquify：[SmudgeLiquify.swift](../../Compositor/Compositor/Document/SmudgeLiquify.swift)。
- Clone Stamp：对齐/不对齐、采样当前层/合成层：[CloneStamp.swift](../../Compositor/Compositor/Document/CloneStamp.swift)、[CloneStampTests.swift](../../Compositor/CompositorTests/CloneStampTests.swift)。
- Spot Healing：[SpotHealingTests.swift](../../Compositor/CompositorTests/SpotHealingTests.swift)、[ContentFill.swift](../../Compositor/Compositor/Document/ContentFill.swift)。
- Gradient：[Gradient.swift](../../Compositor/Compositor/Document/Gradient.swift)、[GradientControls.swift](../../Compositor/Compositor/UI/GradientControls.swift)、[GradientTests.swift](../../Compositor/CompositorTests/GradientTests.swift)。
- Shape：矩形、圆角矩形、椭圆、直线，保持可编辑：[ShapeTool.swift](../../Compositor/Compositor/Document/ShapeTool.swift)、[ShapeControls.swift](../../Compositor/Compositor/UI/ShapeControls.swift)、[ShapeToolTests.swift](../../Compositor/CompositorTests/ShapeToolTests.swift)。
- Type：段落框、字体、字号、颜色、对齐、tracking、leading、runs 和 inline 编辑：[TypeTool.swift](../../Compositor/Compositor/Document/TypeTool.swift)、[InlineTextEditor.swift](../../Compositor/Compositor/Rendering/InlineTextEditor.swift)、[TypeControls.swift](../../Compositor/Compositor/UI/TypeControls.swift)、[TypeToolTests.swift](../../Compositor/CompositorTests/TypeToolTests.swift)。
- Eyedropper、前景/背景色、颜色盘和完整拾色器：[ColorPalette.swift](../../Compositor/Compositor/Document/ColorPalette.swift)、[ColorPickerSheet.swift](../../Compositor/Compositor/UI/ColorPickerSheet.swift)、[ColorPickerTests.swift](../../Compositor/CompositorTests/ColorPickerTests.swift)。

#### Camera Raw、滤镜和渲染性能

- Camera Raw 基础曝光、白平衡、对比度、高光、阴影、纹理、清晰度、去雾：[CameraRaw.swift](../../Compositor/Compositor/Document/CameraRaw.swift)、[CameraRawControls.swift](../../Compositor/Compositor/UI/CameraRawControls.swift)、[CameraRawTests.swift](../../Compositor/CompositorTests/CameraRawTests.swift)。
- Camera Raw 曲线、HSL/Color Mixer、Color Grading：[CameraRawColor.swift](../../Compositor/Compositor/Document/CameraRawColor.swift)、[CameraRawColorControls.swift](../../Compositor/Compositor/UI/CameraRawColorControls.swift)。
- Camera Raw Detail、Optics、镜头校正、去色差：[CameraRawDetailOptics.swift](../../Compositor/Compositor/Document/CameraRawDetailOptics.swift)、[CameraRawDetailOpticsControls.swift](../../Compositor/Compositor/UI/CameraRawDetailOpticsControls.swift)。
- Camera Raw Geometry/Upright/透视校正：[CameraRawGeometryCalibration.swift](../../Compositor/Compositor/Document/CameraRawGeometryCalibration.swift)、[CameraRawGeometryCalibrationControls.swift](../../Compositor/Compositor/UI/CameraRawGeometryCalibrationControls.swift)。
- Camera Raw Bloom、Glow、Halation、Vignette、Grain、Dither：[CameraRaw.swift](../../Compositor/Compositor/Document/CameraRaw.swift)、[Dither.swift](../../Compositor/Compositor/Document/Dither.swift)、[DitherTests.swift](../../Compositor/CompositorTests/DitherTests.swift)。
- Lens Correction、Bloom/Glow、Tonal Contrast、Remove Background：[Filters.swift](../../Compositor/Compositor/Document/Filters.swift)、[LensPixels.c](../../Compositor/Compositor/Rendering/LensPixels.c)、[SubjectRemoval.swift](../../Compositor/Compositor/Document/SubjectRemoval.swift)。
- GPU 合成、分块渲染、降采样、噪声和效果缓存：[GPUCanvas.swift](../../Compositor/Compositor/Rendering/GPUCanvas.swift)、[TiledLayerRenderer.swift](../../Compositor/Compositor/Rendering/TiledLayerRenderer.swift)、[DownsampleCache.swift](../../Compositor/Compositor/Rendering/DownsampleCache.swift)、[RasterSnapshot.swift](../../Compositor/Compositor/Rendering/RasterSnapshot.swift)、[TiledLayerTests.swift](../../Compositor/CompositorTests/TiledLayerTests.swift)。
- 透明边界、图层效果和最终合成：[LayerRenderer.swift](../../Compositor/Compositor/Rendering/LayerRenderer.swift)、[LayerEffectsSurface.swift](../../Compositor/Compositor/Rendering/LayerEffectsSurface.swift)、[ImageExporter.swift](../../Compositor/Compositor/IO/ImageExporter.swift)。

#### 文件、PSD/PSB、AI 和应用壳

- JPEG、PNG、HEIC、TIFF、SVG 导入：[ImageImporter.swift](../../Compositor/Compositor/IO/ImageImporter.swift)、[ImageFileDrop.swift](../../Compositor/Compositor/IO/ImageFileDrop.swift)、[ImageImportTests.swift](../../Compositor/CompositorTests/ImageImportTests.swift)。
- PSD/PSB 读取、PackBits、图层、通道和转换报告：[PSDReader.swift](../../Compositor/Compositor/IO/PSD/PSDReader.swift)、[PSDChannelCoder.swift](../../Compositor/Compositor/IO/PSD/PSDChannelCoder.swift)、[PSDDocumentBuilder.swift](../../Compositor/Compositor/IO/PSD/PSDDocumentBuilder.swift)、[PSDConversionSheet.swift](../../Compositor/Compositor/UI/PSDConversionSheet.swift)、[PSBImportTests.swift](../../Compositor/CompositorTests/PSBImportTests.swift)。
- PSD 文字、颜色 runs、矢量和形状降级：[PSDText.swift](../../Compositor/Compositor/IO/PSD/PSDText.swift)、[PSDVector.swift](../../Compositor/Compositor/IO/PSD/PSDVector.swift)、[PSDVectorFixtures.swift](../../Compositor/CompositorTests/PSDVectorFixtures.swift)。
- RAW 导入和 develop 流程：[RawImporter.swift](../../Compositor/Compositor/IO/RawImporter.swift)、[RawDevelopSheet.swift](../../Compositor/Compositor/UI/RawDevelopSheet.swift)。
- JPEG 导出、透明背景导出、Quick Look 缩略图和 Copy Merged：[ImageExporter.swift](../../Compositor/Compositor/IO/ImageExporter.swift)、[JPEGExportSheet.swift](../../Compositor/Compositor/UI/JPEGExportSheet.swift)、[ExportTests.swift](../../Compositor/CompositorTests/ExportTests.swift)、[JPEGExportTests.swift](../../Compositor/CompositorTests/JPEGExportTests.swift)。
- `.comp` 外部工程格式、PNG 图层和 manifest：[writing-comp-files.md](../../Compositor/docs/writing-comp-files.md)、[ProjectStore.swift](../../Compositor/Compositor/IO/ProjectStore.swift)。
- Agent/脚本修改工程后的外部变更回写：[ProjectWatcher.swift](../../Compositor/Compositor/IO/ProjectWatcher.swift)、[ProjectController+ExternalChanges.swift](../../Compositor/Compositor/IO/ProjectController+ExternalChanges.swift)。
- 键盘快捷键、工具头部、面板和窗口布局：[KeyboardShortcuts.swift](../../Compositor/Compositor/UI/KeyboardShortcuts.swift)、[NavigationToolHeader.swift](../../Compositor/Compositor/UI/NavigationToolHeader.swift)、[ProjectWorkspace.swift](../../Compositor/Compositor/Document/ProjectWorkspace.swift)、[ProjectWorkspaceTests.swift](../../Compositor/CompositorTests/ProjectWorkspaceTests.swift)。
- 应用更新、签名和 notarization：这属于 macOS 发布层，不属于 Web/Remotion 运行时；参考 [release.sh](../../Compositor/scripts/release.sh) 和 [publish.sh](../../Compositor/scripts/publish.sh)，本项目要提供浏览器/PWA/部署等价物并单独验收。

---

## 2. 当前 `novelcomic-remotion` 的实际状态

当前项目并不是空项目，已有大量可复用能力，但组织方式仍是视频编辑器优先。

### 2.1 可以保留的基础设施

以下能力继续保留，但必须改成新文档模型的适配层：

- Next.js 15、React 19、TypeScript、Zod。
- Remotion 4 的 Composition、Player、Renderer、Lambda 入口。
- `src/editor/layer-panel/` 中的 WebGL2/Canvas2D 像素视口、画笔、mask buffer、viewport math。
- `src/editor/canvas/` 中的主画布、选择框、缩放和平移基础设施。
- `src/editor/advanced/` 中部分调整层、路径、网格和外部交换能力的算法实现。
- `src/editor/project/` 中的 IndexedDB 草稿、快照、恢复、schema 检查和自动保存机制。
- COS 预签名上传、远程资产缓存、资产本地化和下载任务。
- `src/editor/comic/` 中的拆层、clean plate、动态漫画语义和 AI 处理能力，但它们只能成为文档命令的消费者。
- 现有测试基础设施和 `vitest`。

### 2.2 必须改变的核心假设

当前状态中的这些字段不能继续作为最终模型：

```ts
tracks: TrackType[];
items: Record<string, EditorStarterItem>;
from: number;
durationInFrames: number;
```

它们只能在动画工作区或 Remotion 适配层中存在。原因如下：

1. Compositor 的图层有父子树，而普通轨道只有平面顺序。
2. 文件夹、调整层、效果和蒙版不等价于媒体 item。
3. 静态图层没有 `from/duration` 语义，却必须能先完成像素编辑。
4. 一个图层可能在不同时间拥有不同变换，但图层本体不应该因此复制成多个 item。
5. 当前 `adjustmentLayers`、`layerGroups`、`comicEditLayers` 已经在补偿轨道模型缺口，继续增加字段会导致双写和同步错误。

当前工作区里 `FEATURE_AE_FRONTEND = false` 的未提交改动可以保留，它表示 AE 前端壳暂时隐藏；但最终方案不能停留在“隐藏旧时间线”，必须把新的 PS 工作区接成默认入口。

---

## 3. 目标产品形态

### 3.1 默认入口

打开 `novelcomic-remotion` 后默认进入 Compositor 式图像合成工作区：

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 文件 编辑 图层 选择 蒙版 效果 滤镜 视图 窗口 帮助   项目名   保存状态        │
├──────────┬──────────────────────────────────────────────┬──────────────────┤
│ 工具栏    │                                              │ Layers           │
│           │              Document Canvas                 │ ┌──────────────┐ │
│ Move      │          (WebGL2 / Canvas fallback)          │ │ Adjustment   │ │
│ Marquee   │                                              │ │ Group        │ │
│ Lasso     │                 selection/mask overlay       │ │ Character    │ │
│ Wand      │                                              │ │  Body        │ │
│ Brush     │                                              │ │  Hair        │ │
│ Eraser    │                                              │ └──────────────┘ │
│ Gradient  │                                              │ Inspector       │
│ Shape     │                                              │ properties      │
│ Type      │                                              │                  │
├──────────┴──────────────────────────────────────────────┴──────────────────┤
│ 状态栏：缩放、颜色空间、文档尺寸、内存、后台任务、当前工具帮助             │
└────────────────────────────────────────────────────────────────────────────┘
```

动画/动态漫画时间线通过“动画”工作区进入，不再默认占据主屏幕底部。它读取同一份 DocumentState 的属性轨道。

### 3.2 视觉和交互原则

- 参考 Compositor 的克制、工具优先、图层优先布局，不使用营销页、卡片堆叠和大面积装饰。
- 左侧工具是固定工具栏；工具参数出现在顶部工具选项栏。
- 右侧 Layers 面板是所有图层结构操作的权威入口。
- Inspector 根据当前选区显示 Transform、Appearance、Mask、Effects、Adjustment、Text 等分组。
- 画布只负责显示与直接操作，不直接决定数据结构。
- 所有破坏性操作都先产生预览，再通过“应用/取消”提交一次命令。
- 所有按钮、快捷键、菜单动作必须能映射到同一个 command id，保证 UI、快捷键、Agent API 行为一致。

---

## 4. 目标工程架构

### 4.1 总体分层

```text
Browser UI
  ├─ CompositorShell
  ├─ ToolController
  ├─ CanvasViewport
  ├─ LayerTree
  ├─ Inspector
  └─ AnimationWorkspace
          │ commands / transactions
          ▼
Editor Domain (pure TypeScript)
  ├─ DocumentState
  ├─ LayerTree invariants
  ├─ Pixel selection/mask operations
  ├─ Transform/snapping
  ├─ Effects/adjustments
  ├─ Command bus + history
  └─ Remotion frame evaluation
          │ DTO / repository
          ▼
Remotion Backend (same repository)
  ├─ Project API
  ├─ Asset API
  ├─ Snapshot API
  ├─ Command API
  ├─ Render API
  ├─ Object storage adapter
  ├─ Job/lease adapter
  └─ Audit/observability
          │
          ▼
Remotion Renderer / COS / Lambda / Worker
```

### 4.2 目录重构目标

建议新建以下目录，不把新逻辑继续堆到 `src/editor/comic` 或旧 `src/editor/state`：

```text
src/editor/document/
  types.ts                    # 正式文档模型
  defaults.ts                 # 默认文档和默认图层
  normalize.ts                # 版本归一化
  validate.ts                 # 文档不变量
  selectors.ts                # 纯查询
  tree.ts                     # 父子树、排序、可见性、锁定

src/editor/commands/
  command-types.ts            # 所有命令 id 和输入输出
  command-bus.ts              # 事务边界
  command-history.ts          # undo/redo、合并和重做
  layer-commands.ts
  mask-commands.ts
  selection-commands.ts
  transform-commands.ts
  effect-commands.ts
  adjustment-commands.ts
  project-commands.ts

src/editor/pixels/
  surface-types.ts
  tile-store.ts
  selection-buffer.ts
  mask-buffer.ts
  raster-operations.ts
  worker-protocol.ts
  workers/

src/editor/render-graph/
  build-render-graph.ts
  evaluate-document-frame.ts
  render-layer.ts
  render-mask.ts
  render-adjustment.ts
  render-effects.ts
  remotion-props.ts

src/editor/workspace/
  compositor-shell.tsx
  menu-bar.tsx
  tool-bar.tsx
  tool-options-bar.tsx
  document-canvas.tsx
  layers-panel.tsx
  inspector-panel.tsx
  status-bar.tsx
  animation-workspace.tsx

src/server/project/
  project-repository.ts
  snapshot-repository.ts
  command-service.ts
  asset-service.ts
  render-service.ts
  project-schema.ts

tools/document/
  validate_document.py        # 离线 schema/fixture 校验，不参与浏览器运行时
  migrate_document.py         # 批量迁移 JSON，输出报告，不覆盖源文件
  canonical_json.py           # 与 TS 固定序列化规则对拍
tests/fixtures/document/
  schema-v1-valid.json
  schema-v1-invalid-*.json
  migration-*.json
```

旧目录可以暂时作为迁移适配层，但新 UI 不得直接依赖旧轨道字段。

---

## 5. 正式数据模型

### 5.1 顶层文档

```ts
export type DocumentState = {
  schemaVersion: 1;
  documentId: string;
  projectId: string;
  name: string;
  colorSpace: 'sRGB';
  width: number;
  height: number;
  resolution: number;
  rootLayerIds: string[];       // bottom -> top
  layers: Record<string, LayerNode>;
  assets: Record<string, AssetRecord>;
  selections: Record<string, SelectionRecord>;
  guides: Guide[];
  animation?: AnimationDocument;
  metadata: DocumentMetadata;
};
```

`DocumentState` 是编辑器的唯一业务真相源。React store、Remotion props、IndexedDB 快照和服务端快照都由它生成，不能反过来让这些存储结构成为业务模型。

### 5.2 图层节点

```ts
export type LayerNode = {
  id: string;
  name: string;
  kind: 'pixel' | 'group' | 'adjustment' | 'text' | 'shape';
  parentId: string | null;
  order: number;
  visible: boolean;
  locked: boolean;
  solo: boolean;
  opacity: number;
  blendMode: BlendMode;
  transform: LayerTransform;
  content: LayerContent;
  mask?: RasterMask;
  liveMaskSourceId?: string;
  effects?: LayerEffects;
  animation?: LayerAnimation;
};
```

约束：

- `group` 不得拥有 `pixelAssetId`。
- `adjustment` 不得同时拥有普通像素内容。
- `parentId` 必须指向 group 或为空。
- 任意父链不能形成环，最大深度 64。
- 同一父节点下 `order` 唯一。
- `opacity` 必须在 `0..1`。
- `visible`、`locked`、`solo` 是文档属性，不是 UI 临时状态。
- 删除节点前必须明确处理子树、蒙版来源和引用它的动画轨道。

### 5.3 资产和像素表面

```ts
export type AssetRecord = {
  id: string;
  kind: 'raster' | 'mask' | 'font' | 'audio' | 'video';
  originalName: string;
  mimeType: string;
  width?: number;
  height?: number;
  byteSize: number;
  objectKey: string;
  previewObjectKey?: string;
  contentHash: string;
};
```

浏览器不能把完整大图像素长期放在 React state。像素必须进入 `TileStore` 或 IndexedDB/OPFS 缓存，业务状态只保存资产引用和版本 hash。

### 5.4 变换

```ts
export type LayerTransform = {
  originX: number;
  originY: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  sampling: 'high' | 'smooth' | 'nearest';
};
```

这里必须统一坐标系：文档坐标原点在左上，Y 向下，所有交互/蒙版/选择/导出均使用文档像素坐标。屏幕坐标只能在 viewport adapter 中出现。

### 5.5 蒙版

```ts
export type RasterMask = {
  assetId: string;
  enabled: boolean;
  linkedToLayer: boolean;
  placement?: LayerTransform;
  invert: boolean;
  feather: number;
};

export type LiveMask = {
  sourceLayerId: string;
  mode: 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
};
```

普通蒙版、文件夹蒙版和剪贴蒙版必须在同一套 render graph 中求值，不能由三个 UI 子系统分别实现。

### 5.6 调整层和效果

调整层和效果均采用明确的 discriminated union，不能使用 `Record<string, unknown>`：

```ts
export type AdjustmentContent =
  | {kind: 'hue-saturation'; hue: number; saturation: number; lightness: number; colorize: boolean}
  | {kind: 'levels'; channels: LevelsChannel[]}
  | {kind: 'curves'; channels: CurveChannel[]}
  | {kind: 'exposure'; exposure: number; offset: number; gamma: number}
  | {kind: 'gradient-map'; shadows: Color; highlights: Color; reversed: boolean}
  | {kind: 'grain'; amount: number; monochromatic: boolean; seed: number}
  | {kind: 'invert'}
  | {kind: 'black-white'; settings: BlackWhiteSettings}
  | {kind: 'color-balance'; settings: ColorBalanceSettings}
  | {kind: 'gaussian-blur'; radius: number}
  | {kind: 'motion-blur'; angle: number; distance: number}
  | {kind: 'add-noise'; amount: number; gaussian: boolean; monochromatic: boolean; seed: number};
```

效果结构：

```ts
export type LayerEffects = {
  stroke?: StrokeEffect;
  dropShadow?: ShadowEffect;
  colorOverlay?: ColorOverlayEffect;
  innerShadow?: ShadowEffect;
  outerGlow?: GlowEffect;
  innerGlow?: GlowEffect;
};
```

每个效果都包含 `enabled`，隐藏效果不应从文档中删除。

### 5.7 动画

动画不拥有图层，只拥有属性：

```ts
export type LayerAnimation = {
  properties: Record<AnimatedProperty, PropertyTrack>;
};

export type PropertyTrack = {
  baseValue: number;
  keyframes: Array<{
    frame: number;
    value: number;
    easing: Easing;
  }>;
};
```

静态编辑永远在 frame 0 作用于 `DocumentState`；动画工作区只是编辑 `animation.properties`。这样既能复刻 Compositor，也能保持 Remotion 动画输出。

---

## 6. 前端重构方案

### 6.1 Shell 与工作区

`src/editor/editor.tsx` 改成 `CompositorShell`，职责只有布局和上下文装配：

```text
EditorRoot
  ProjectProvider
  CommandProvider
  SelectionProvider
  ToolProvider
  DocumentViewportProvider
  └─ CompositorShell
      ├─ MenuBar
      ├─ ToolOptionsBar
      ├─ WorkspaceBody
      │   ├─ ToolBar
      │   ├─ DocumentCanvas
      │   ├─ LayersPanel
      │   └─ InspectorPanel
      ├─ StatusBar
      └─ Optional AnimationWorkspace
```

现有 `AeChrome`、AE 工作区栏和默认时间线头部不再作为主界面。`FEATURE_AE_FRONTEND` 不能成为产品分叉；完成迁移后应删除该开关和旧 AE 壳，动画工作区使用新的显式 workspace 状态。

### 6.2 工具栏

工具顺序按 Compositor 工作流固定：

1. Move/Transform
2. Marquee Rectangle
3. Marquee Ellipse
4. Lasso
5. Polygon Lasso
6. Magic Wand
7. Object Select
8. Brush
9. Eraser
10. Blur
11. Clone Stamp
12. Healing
13. Gradient
14. Shape
15. Type
16. Hand
17. Zoom

每个工具必须拥有：

- `toolId`。
- `ToolOptions` schema。
- pointer 状态机。
- preview overlay。
- commit/cancel 行为。
- keyboard shortcut。
- command id。
- 单元测试和浏览器验收。

### 6.3 Canvas

`DocumentCanvas` 不能直接把所有图层渲染成 DOM 图片堆叠。目标渲染管线：

```text
DocumentState
  -> buildRenderGraph(frame, quality)
  -> GPU layer compositor / Canvas2D fallback
  -> selection/mask/transform overlays
```

Canvas 必须支持：

- fit、25%、50%、100%、200%、400% 和自定义缩放。
- Space 临时 Hand。
- 中键平移。
- 画布边界、图层边缘、中心和辅助线吸附。
- 变换框、旋转手柄、自由变形控制点。
- 像素网格阈值和像素坐标光标。
- checkerboard 透明背景。
- 选择轮廓、mask overlay、quick mask、solo/mask-alone 预览。

主画布的绘制和像素工具不得把整张图复制进 React state。笔刷、选区、mask refine、滤镜预览都必须使用 tile 或 Worker。

### 6.4 Layers 面板

Layers 面板要完全按 Compositor 语义重写，不再把 Track 当成图层：

- 树形展开/折叠。
- 拖拽重排和拖入文件夹。
- 文件夹显示继承后的可见/锁定状态。
- 图层缩略图、mask 缩略图、效果徽标、调整层图标。
- 点击缩略图选择像素，Option/Alt 点击选择蒙版。
- 双击名称内联重命名。
- 右键菜单：新建、复制、删除、合并、编组、解组、剪贴、应用蒙版、删除蒙版、导出。
- 多选后整体变换、编组、合并和复制。
- 搜索只改变视图，不改变文档。

面板底部按钮按 Compositor：新建图层、新建组、添加蒙版、添加效果、添加调整层、删除。

### 6.5 Inspector

Inspector 根据选中对象显示以下 sections：

- Transform：X/Y/W/H/rotation/scale/flip/sampling。
- Appearance：opacity/blend mode/visibility/lock。
- Mask：enabled/invert/feather/link/placement/source。
- Effects：六类效果的添加、删除、启用和参数。
- Adjustment：对应调整层的专用控件。
- Text：字体、字号、颜色、段落框、对齐、tracking、leading、runs。
- Animation：当前属性的 keyframes 和 easing。

所有数值输入必须支持拖拽 scrub、键盘箭头和直接输入；所有更新必须经过 command bus，禁止组件里直接修改对象引用。

### 6.6 菜单和快捷键

菜单必须有真实行为，不允许只有装饰性按钮：

- File：New/Open/Save/Save As/Export/Close。
- Edit：Undo/Redo/Cut/Copy/Paste/Duplicate/Fill/Transform。
- Layer：New/Group/Merge/Mask/Effects/Adjustment/Arrange。
- Select：All/None/Inverse/Expand/Contract/Feather/Subject/Color Range。
- Mask：Add/Apply/Delete/Invert/Disable/Link/Unlink。
- Filter：Blur/Sharpen/Noise/Color。
- View：Zoom/Grid/Guides/Snap/Mask Alone/Pixel Grid。
- Window：Layers/Inspector/History/Animation/Tasks。

快捷键至少覆盖 Compositor/Photoshop 习惯：V、M、L、W、B、E、G、T、H、Z、Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z、Cmd/Ctrl+J、Cmd/Ctrl+G、Cmd/Ctrl+Shift+G、Cmd/Ctrl+S、Cmd/Ctrl+O、Cmd/Ctrl+E。

---

## 7. 后端重构方案

### 7.1 边界

前后端都放在 `novelcomic-remotion` 仓库，但职责分离：

- `app/api/**` 只做 HTTP、鉴权、解析、响应。
- `src/server/**` 负责数据库、对象存储、任务和权限。
- `src/editor/document/**` 负责纯领域逻辑。
- Server 不调用 React，不依赖浏览器 API。
- 浏览器不直接拼数据库记录，不直接写对象存储 key。

Remotion API 仍然属于本项目：预览帧、静态导出、动画渲染、批量渲染都从这里出发。Publisher/Agent/AI 可以调用这些 API，但不能绕过文档命令修改工程。

### 7.2 项目 API

目标接口：

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId

GET    /api/projects/:projectId/snapshot
POST   /api/projects/:projectId/snapshots
GET    /api/projects/:projectId/snapshots/:snapshotId
POST   /api/projects/:projectId/restore

POST   /api/projects/:projectId/commands
POST   /api/projects/:projectId/commands/batch
GET    /api/projects/:projectId/history

POST   /api/projects/:projectId/assets/presign
POST   /api/projects/:projectId/assets/complete
DELETE /api/projects/:projectId/assets/:assetId

POST   /api/projects/:projectId/render/preview
POST   /api/projects/:projectId/render/image
POST   /api/projects/:projectId/render/video
GET    /api/projects/:projectId/render/:renderId
POST   /api/projects/:projectId/render/:renderId/cancel
```

### 7.3 Command API

所有写操作采用统一 envelope：

```json
{
  "projectId": "project_123",
  "expectedRevision": 41,
  "clientRequestId": "req_abc",
  "commands": [
    {
      "id": "layer.rename",
      "layerId": "layer_body",
      "name": "Body"
    }
  ]
}
```

成功响应：

```json
{
  "projectId": "project_123",
  "revision": 42,
  "contentHash": "sha256:...",
  "state": {"...": "DocumentState"},
  "events": [
    {"type": "layer.renamed", "layerId": "layer_body"}
  ]
}
```

规则：

- `expectedRevision` 不匹配返回 409，不静默覆盖。
- `clientRequestId` 保证重试幂等。
- 单个命令批次事务性提交，失败全部回滚。
- 服务端重新执行 `normalize -> validate -> apply`，不相信客户端传来的派生字段。
- 服务端保存 command/event 审计记录，便于恢复和问题定位。

### 7.4 存储

推荐边界：

- PostgreSQL：project、document snapshot、revision、command journal、render job、权限和审计。
- 对象存储/COS：原始图片、mask、缩略图、导出文件、渲染视频。
- Redis：短期任务进度、render lease、取消信号、asset processing 状态。
- 浏览器 IndexedDB/OPFS：离线草稿、tile cache、临时历史和最近打开项目。

浏览器本地存储不是服务端事实来源。它只支持离线和崩溃恢复。

### 7.5 资产上传

资产流程必须是：

```text
创建 asset intent
  -> presigned upload
  -> 完成回调（校验 hash、mime、尺寸）
  -> 生成缩略图/代理图
  -> asset ready
  -> command 引用 assetId
```

图层命令只能引用状态为 `ready` 的资产。上传中的 asset 不得进入可渲染快照。

### 7.6 渲染 API

渲染请求只接受 `projectId + revision`，或者显式传入已经校验过的 `DocumentState` hash：

```json
{
  "revision": 42,
  "frame": 0,
  "format": "png",
  "quality": "final"
}
```

视频渲染：

```json
{
  "revision": 42,
  "composition": "Main",
  "fps": 30,
  "startFrame": 0,
  "endFrame": 180,
  "codec": "h264"
}
```

Render worker 必须固定 revision，渲染过程中项目的新修改不能改变当前输出。

---

## 8. Remotion 在新架构中的位置

### 8.1 唯一求值入口

新增：

```ts
evaluateDocumentFrame({
  document,
  frame,
  quality,
}): EvaluatedDocumentFrame
```

它完成：

1. 图层树排序。
2. 父级 transform 累积。
3. 可见性/锁定/solo 计算。
4. 动画属性插值。
5. mask 链和文件夹 mask 计算。
6. adjustment/effect render nodes 生成。
7. 资源引用和 fallback 处理。

浏览器 Canvas、Remotion Player、静帧预览和最终 Renderer 都必须调用同一套求值逻辑。不得让 Canvas 自己解释一套、Remotion 再解释一套。

### 8.2 Remotion Composition

`src/remotion/main.tsx` 只负责：

- 接受 `EvaluatedDocumentFrame` 或 `DocumentState + frame`。
- 按 render graph 输出最终画面。
- 读取字体、图片、视频和音频。
- 在服务器渲染环境中关闭所有交互 overlay。

Remotion 不负责：

- 图层拖拽。
- 选择轮廓交互。
- 笔刷和选择操作。
- 历史栈。
- 项目保存。

### 8.3 静态合成和动画输出

- 静态图片编辑 frame 默认为 0。
- 动态漫画为图层属性添加 keyframes 后才产生非零时间轴。
- 没有动画的文档可直接导出 PNG/JPEG，也可作为 1 帧 Remotion composition。
- 有动画的文档通过 Animation Workspace 编辑，仍然不复制图层。

---

## 9. 命令和历史系统

### 9.1 命令统一模型

```ts
type EditorCommand =
  | {id: 'layer.create'; payload: CreateLayerPayload}
  | {id: 'layer.rename'; payload: RenameLayerPayload}
  | {id: 'layer.move'; payload: MoveLayerPayload}
  | {id: 'layer.transform'; payload: TransformLayerPayload}
  | {id: 'mask.paint'; payload: PaintMaskPayload}
  | {id: 'mask.add'; payload: AddMaskPayload}
  | {id: 'selection.commit'; payload: SelectionPayload}
  | {id: 'adjustment.update'; payload: UpdateAdjustmentPayload}
  | {id: 'effect.update'; payload: UpdateEffectPayload}
  | {id: 'asset.attach'; payload: AttachAssetPayload};
```

每个命令必须提供：

- `validate`。
- `apply`。
- `inverse` 或可恢复的 before/after patch。
- `mergeKey`，用于合并连续拖动。
- `serialize`，用于服务端 journal。
- `affectedLayerIds`。
- `pixelCost` 和撤销内存估算。

### 9.2 交互事务

以拖动变换为例：

```text
pointerdown -> begin transaction
pointermove -> 只更新 preview transform
pointerup   -> 计算最终 transform
             -> apply command
             -> push undo
             -> schedule autosave
pointercancel/blur -> cancel transaction
```

画笔和 mask 也遵循相同规则，但像素操作使用 tile diff 或压缩 patch，不能为每个 pointermove 创建快照。

### 9.3 Undo/Redo

- 逻辑命令和像素命令共用一个历史序列。
- 每个历史项都有 `revision`、`commandId`、`beforeHash`、`afterHash`。
- 连续 scrub/slider/brush stroke 合并成一个历史项。
- 空操作不进入历史。
- 还原快照不能破坏已上传资产，只改变文档引用。
- 服务端历史和浏览器历史分别存在，但服务端 revision 是最终事实。

---

## 10. 性能和像素处理

### 10.1 不能做的事情

- 不在 React state 放整张 `Uint8ClampedArray`。
- 不在 pointermove 中调用 `getImageData` 读取全画布。
- 不在每个图层更新时重新下载远程资源。
- 不在主线程执行大图 mask refine、content fill、blur 和导出前全量合成。

### 10.2 目标实现

- 预览按 256 或 512 像素 tile 管理。
- 选区和蒙版在 Worker 中计算。
- WebGL2 负责缩放、混合、mask、基础滤镜和多图层合成。
- Canvas2D 作为没有 WebGL2 时的 fallback。
- 导出渲染使用完整分辨率分块，避免单个 texture 超过 GPU 限制。
- 每个项目记录近似内存预算，接近上限时主动降低 preview quality。
- 图层缩略图、mask 缩略图和合成预览都有 LRU cache。

### 10.3 性能验收指标

- 1920x1080、50 个图层、4 个蒙版：100% 缩放下拖动变换保持 60fps，低于 30fps 时自动降级 preview。
- 8000x8000 单图：打开后 2 秒内显示低分辨率预览，后台完成 tile 加载。
- 1000 次连续笔刷操作：主线程单帧不超过 16ms，撤销内存不超过配置预算。
- 相同 revision 的静帧预览和最终 PNG 像素差异为 0，允许 GPU 浮点误差阈值由测试固定。

---

## 11. 动态漫画能力如何保留

本次是 PS 主导重构，不是删除动态漫画。

### 11.1 静态拆层

- AI 拆层结果生成 `pixel` 图层和 `RasterMask`。
- clean plate 生成普通像素层或 background replacement layer。
- 角色、身体、头发、眼睛、嘴巴等语义写入 layer metadata。
- 语义不是轨道名称的隐式约定，而是图层节点的明确 metadata。

### 11.2 眨眼和口型

- 仍然使用 asset state/viseme，但挂到同一个图层的 `animation` 或 `stateSequence`。
- 不再为每个状态创建互相独立、容易失步的轨道。
- Render graph 在 frame 求值时选择当前 asset。

### 11.3 Shot 和镜头

- Shot 变成 `AnimationDocument` 的时间区间和 camera track。
- shot 的 camera transform 作用于 render graph 根节点。
- shot 不改变图层树本身。

### 11.4 配音、字幕和批量渲染

- 音频和字幕属于 animation tracks/attachments，不混入静态图层树。
- 批量渲染读取固定 revision 的动画文档。
- 生产脚本可以继续使用，但所有写入先转成 command 或 server-side document mutation。

---

## 12. 迁移施工顺序

不能一次性重写所有文件。建议按以下阶段，每一阶段都可运行和验收。阶段 0-8 建立新编辑器和动态漫画闭环，阶段 9-12 补齐 Compositor 功能等价、文件互操作和应用壳，阶段 13 才允许移除旧主路径。只有阶段 0-13 全部通过，才可以称为“功能完整闭环”。

### 阶段 0：冻结边界和基线

目标：防止旧 AE/视频逻辑继续扩散。

工作：

- 保留现有未提交的 `FEATURE_AE_FRONTEND=false` 方向。
- 建立 `document/commands/render-graph/workspace` 目录。
- 禁止新功能直接增加 `TrackType` 的 PS 字段。
- 为旧轨道编辑器标记 `Animation Legacy Workspace`。
- 建立当前项目的 typecheck、unit、browser smoke 基线。

验收：

- 旧动态漫画工程仍能打开和渲染。
- 新代码不新增 `TrackType`/`EditorStarterItem` 的 PS 属性。

### 阶段 1：DocumentState 和 schema（只做领域模型，不改 UI）

#### 1.1 固定输入和输出

输入只有两类：新建文档参数，或带 `schemaVersion` 的 JSON。输出只有 `DocumentState`、`DocumentIssue[]`、规范化 JSON 和迁移报告。阶段一不读取 React state、不写 IndexedDB、不调用 API。

#### 1.2 必须实现的文件

```text
src/editor/document/types.ts             # DocumentState 和所有 discriminated union
src/editor/document/limits.ts            # 尺寸、层深、图层数、资产大小上限
src/editor/document/defaults.ts          # 空白文档和五类图层工厂
src/editor/document/validate.ts           # 纯函数校验，不修复输入
src/editor/document/normalize.ts         # 删除 undefined、排序稳定化、默认值补齐
src/editor/document/migrations.ts        # v0 -> v1，显式 registry，拒绝未来版本
src/editor/document/hash.ts              # canonical JSON + SHA-256
src/editor/document/legacy-adapter.ts   # UndoableState -> DocumentState，一次性入口
tools/document/canonical_json.py         # 与 TS 对拍的规范序列化
tools/document/validate_document.py      # 离线校验和 fixture 报告
tests/fixtures/document/**
```

#### 1.3 不变量（必须有测试名和错误码）

- `width/height` 为整数，范围 `1..32768`；`resolution` 为正数，范围 `1..2400`。
- `rootLayerIds` 与 `layers` 一一对应；根节点 `parentId=null`，子节点必须指向 `group`。
- 任意父链不能成环，最大深度 64；同一父节点的 `order` 唯一且为非负整数。
- `pixel` 必须是 `{assetId}`，`group` 只能是 `{group:true}`，`adjustment/text/shape` 不能混入其他 content。
- mask/liveMask/effects 的引用必须存在；`liveMask.sourceLayerId` 不能指向自身或其子树。
- `opacity`、颜色通道、效果参数和 transform 数值必须有限；不接受 `NaN`、`Infinity` 或静默截断。
- `schemaVersion` 高于当前版本时返回 `SCHEMA_TOO_NEW`，不尝试降级打开。

#### 1.4 规范化、迁移和哈希规则

- `validate` 只报告问题，绝不改变输入；`normalize` 只接收已通过结构校验的对象。
- normalize 后对象必须深拷贝；字典键按 UTF-8 字节序排序，数组顺序只按文档语义排序，不能对 `rootLayerIds`、keyframes、points 盲目排序。
- `undefined` 字段不进入 canonical JSON；`null` 必须保留；数字使用 JSON 标准表示，禁止 `-0`。
- hash 输入固定为 `normalize(document)`，输出小写 SHA-256；不把项目名称、保存时间、快照 id、request id 放入内容 hash。
- Python 和 TypeScript 使用同一组 canonical JSON fixture，至少包含中文名称、空数组、`null`、浮点数和嵌套图层。

#### 1.5 阶段一验收

- 通过默认文档、五类工厂、v0->v1 迁移和高版本拒绝测试。
- 非法 parent、cycle、重复 order、超尺寸、越界 opacity、缺失资产引用均返回稳定错误码。
- 同一文档在 TS/Python 中 canonical JSON 和 SHA-256 完全相同；字段顺序变化不改变 hash。
- 旧项目只可通过 `legacy-adapter` 转换；新模块不得 import `UndoableState` 作为业务输入。

### 阶段 2：Command Bus 和 Project Repository（接持久化，不改主 UI）

#### 2.1 必须实现的文件

```text
src/editor/commands/document-command-types.ts
src/editor/commands/document-command-bus.ts
src/editor/commands/document-command-history.ts
src/editor/project/document-repository.ts       # 接口、CAS、冲突类型
src/editor/project/indexeddb-document-repository.ts
src/editor/project/document-project-adapter.ts   # 旧 ProjectContext 的窄适配器
src/editor/project/document-repository.test.ts
src/editor/commands/document-command-bus.test.ts
tests/fixtures/document/commands/**
```

旧 `src/editor/commands/command-bus.ts` 和旧 `ProjectStore` 暂不重写；它们继续服务旧动态漫画入口。新命令总线和仓储必须有明确的 `Document` 前缀，阶段九再统一收口，避免两套协议被误用。

#### 2.2 Command 协议

```ts
type DocumentCommand = {
  id: string;
  requestId: string;
  projectId: string;
  expectedRevision: number;
  type: DocumentCommandType;
  payload: unknown;
  transactionId?: string;
  mergeKey?: string;
  createdAt: string;
};
```

阶段二只实现不会破坏模型边界的命令：`document.rename`、`layer.create`、`layer.update`、`layer.delete`、`layer.reorder`、`project.replace`。每个 handler 都必须提供 `validate/apply/inverse`；apply 后再次执行完整 `validate + normalize`，失败则整个事务回滚。

#### 2.3 Repository 协议

- `createProject` 产生 revision `0` 的初始 snapshot；snapshot 不可变，revision 单调递增。
- `commit(command, document)` 使用 `expectedRevision` 做 CAS；不匹配返回 `RevisionConflictError`，其中包含 `expectedRevision`、`actualRevision`、`currentSnapshot` 和本地待提交文档，UI 可选择 reload/duplicate/overwrite（overwrite 必须生成新 request）。
- `requestId` 是幂等键：同一 project 下相同 requestId + 相同 payload 返回第一次结果；相同 requestId + 不同 payload 返回 `IDEMPOTENCY_KEY_REUSED`。
- IndexedDB 使用独立数据库 `novelcomic-remotion-document-v1`，至少包含 `projects`、`snapshots`、`drafts`、`requests` 四个 object store；写 snapshot、更新 project、删除 draft 必须是一个原子事务。
- draft 可以频繁覆盖，不推进 revision；snapshot 只在 command/autosave/manual/restore 提交。刷新优先加载 snapshot，再按 `updatedAt` 判断是否显示 draft 恢复。
- 服务端 adapter 只接受 `DocumentState` 和 command DTO，不接受 React state；网络失败保留本地 draft，并返回可重试错误。

#### 2.4 历史和冲突恢复

- undo/redo 只保存 command + inverse，不保存整份 React state；连续相同 `mergeKey` 在 300ms 内合并为一个历史项。
- undo/redo 本地先执行并写 draft；服务端提交作为独立 command，不能绕过总线直接覆盖 snapshot。
- 冲突恢复必须保留三份信息：`baseSnapshot`、`localDocument`、`remoteSnapshot`；默认不丢弃任何一份，不自动 last-write-wins。

#### 2.5 阶段二验收

- 浏览器刷新、关闭重开、IndexedDB draft 恢复、snapshot 回滚、undo/redo 全部有自动化测试。
- 两个并发客户端用同一 `expectedRevision` 时，一个成功、一个得到结构化冲突；重复 request 不产生第二个 snapshot。
- 同 request id 不同 payload 被拒绝；事务中任一命令失败时 revision、snapshot、draft 均不发生部分写入。
- `project-context.tsx` 只通过 `document-project-adapter` 使用新仓储；新 UI 不能读取 `tracks/items`。

### 阶段 3：Compositor Shell 和图层树

工作：

- 重写 `editor.tsx` 为 `CompositorShell`。
- 新建 MenuBar、ToolBar、ToolOptionsBar、LayersPanel、InspectorPanel、StatusBar。
- `ComicLayerPanel` 改为通用 LayerTree；动态漫画语义作为徽标。
- 文件夹、重命名、拖拽排序、可见、锁定、多选、复制、删除全部走命令。

验收：

- 只使用图层树即可完成空白文档到多层合成。
- Canvas、LayerTree、Inspector 三者选择同步。

### 阶段 4：Canvas render graph

工作：

- 把现有 `Layers`/`AdvancedLayers` 合并到 `render-graph`。
- 实现根合成、父级 transform、opacity、blend mode、folder visibility。
- 接入 WebGL2 renderer 和 Canvas2D fallback。
- Remotion `Main` 使用同一 `evaluateDocumentFrame`。

验收：

- 浏览器预览、Remotion Player、静帧输出三者一致。
- 50 层图层树和嵌套组正确渲染。

### 阶段 5：Transform、Snap 和 Selection

工作：

- Move/Transform 工具。
- Rulers、guides、grid、snap。
- Marquee/Lasso/Wand/Color Range。
- Selection buffer、feather、expand、contract、inverse。

验收：

- 所有选区结果可转为 mask。
- 坐标转换误差小于 0.25 文档像素。

### 阶段 6：Mask 和像素 Worker

> 完成状态：2026-10-07 已完成。主路径只使用 `DocumentState`、`DocumentCommand`、统一 render graph 和像素 Worker；旧 `items/tracks` Layer Panel、Select and Mask、AE 图层面板兼容组件及对应旧验收契约已删除。

工作：

- 普通 mask、folder mask、live mask、mask alone。
- Brush/Eraser/Blur/Refine Edge。
- tile diff 和历史压缩。
- 把现有 `layer-panel` 能力迁入统一 command。

验收：

- 蒙版白/黑/灰语义正确。
- 移动图层、解除链接、应用蒙版和删除蒙版均可撤销。

实际交付：

- `src/editor/pixels/`：Brush/Eraser/Blur/Refine Edge、Mask 编解码、64px tile diff 和 Worker/fallback client。
- `mask.attach / mask.update / mask.remove / mask.apply / live-mask.set / live-mask.remove`：全部通过 `DocumentCommandHistory` 执行和撤销。
- 普通蒙版、文件夹蒙版、live mask、Mask Alone 已接入浏览器画布与 Remotion render graph。
- `src/editor/layer-panel/`、旧 Select and Mask 按钮、旧 AE/track 图层面板链路已删除，不再保留双写或兼容状态。
- 自动验收见 `src/editor/acceptance/compositor-stage6.test.ts`。

### 阶段 7：Adjustment、Effects、Text、Shape

> 完成状态：2026-10-07 已完成。调整层、图层效果、文字和 Shape 均通过 `DocumentCommand` 与统一 render graph 实现；旧 tracks/items 阶段七验收、AE 导出入口和非 Compositor 兼容代码已删除。

工作：

- 完整调整层 union 和 Inspector。
- 六类图层效果。
- 可编辑文字和 shape metadata。
- 图层效果预览和最终导出一致性测试。

验收：

- 每种效果至少有创建、编辑、启用/禁用、删除、撤销、保存重载测试。

实际交付：

- 完成 12 类 `AdjustmentContent` union 的校验、Inspector 参数编辑、Canvas2D 预览和 Remotion 最终渲染映射。
- 完成描边、投影、颜色叠加、内阴影、外发光、内发光六类图层效果；创建、更新、开关、删除和撤销全部经 `effect.*` 命令。
- 文字图层支持正文、字体、字号、颜色、对齐、行高、字距和 runs；Shape 支持矩形、圆角矩形、椭圆、直线、填充、描边和圆角 metadata。
- 调整层只处理同父级、位于其下方的前序兄弟图层，输入顺序稳定；Canvas 预览和 Remotion 使用同一 render graph。
- 删除旧 `stage7-contract`、tracks/items 阶段七验收脚本、固定 fixture、报告 artifact、package script 及 AE 导出兼容入口，不保留双轨逻辑。
- 自动验收见 `src/editor/acceptance/compositor-stage7.test.ts`。

### 阶段 8：服务端项目、资产和渲染闭环

工作：

- Next API 接入正式 Project/Asset/Snapshot/Command/Render 服务。
- 对象存储资产 hash、缩略图、代理图和清理任务。
- 固定 revision 渲染、取消、进度、失败重试。
- AI clean plate、拆层、TTS、字幕改为命令或异步任务回写。

验收：

- 完整流程：新建 -> 导入 -> 图层编辑 -> 保存 -> 刷新 -> 静帧 -> 视频 -> 下载。

### 阶段 9：文件互操作和项目工作区闭环

> 完成状态：2026-10-07 已完成。正式工程包、Compositor `.comp` 互操作、8-bit RGB PSD/PSB 转换、图片导入导出、工程标签与外部变更检测已接入；旧 AE/Live2D 交换协议和旧 PSD LayerPackage 兼容入口已删除。

工作：

- 实现 PNG/JPEG/HEIC/TIFF/SVG 导入、静态图片导出、Copy Merged 和缩略图生成。
- 实现 Web 工程包格式：manifest、图层资产目录、mask 资产、schema version、原子替换和损坏工程保护。
- 对 PSD/PSB 做 8-bit RGB 的可编辑转换；不可编辑内容必须进入转换报告，不能静默栅格化或丢失。
- 提供 `.comp` 兼容导入/导出适配器，正式存储仍使用 Web 工程格式；Agent/脚本通过 manifest 和命令 API 修改工程。
- 实现多项目标签、最近项目、关闭前未保存检查、外部工程变更检测和重新加载。

对应参考：[ImageImporter.swift](../../Compositor/Compositor/IO/ImageImporter.swift)、[ImageExporter.swift](../../Compositor/Compositor/IO/ImageExporter.swift)、[ProjectStore.swift](../../Compositor/Compositor/IO/ProjectStore.swift)、[ProjectWatcher.swift](../../Compositor/Compositor/IO/ProjectWatcher.swift)、[PSDDocumentBuilder.swift](../../Compositor/Compositor/IO/PSD/PSDDocumentBuilder.swift)、[writing-comp-files.md](../../Compositor/docs/writing-comp-files.md)。

验收：

- 每种支持格式都有真实输入 fixture、转换报告、失败保护和导出回读测试。
- 外部进程原子替换工程后，编辑器能提示变更并选择 reload/keep local。
- 工程包损坏、版本过高、缺少图层资产时，当前打开的工程不被替换。

实际交付：

- `src/editor/io/project-package.ts` 定义 Web 工程包 `novelcomic-document-package`，包含 `manifest.json`、规范化 `document.json`、资产目录、SHA-256 校验和；读取时拒绝未来版本、路径穿越、重复条目、缺失或篡改资产。
- `src/editor/io/project-package-fs.ts` 通过临时文件写入后原子 rename，失败时保留原工程。
- `src/editor/io/image-io.ts` 支持 PNG/JPEG/HEIC/TIFF/SVG 导入和 PNG/JPEG 静态导出协议；`copyMerged` 使用同一渲染回调，不创建第二套图层状态。
- `src/editor/io/comp-adapter.ts` 读写 Compositor 1-11 manifest，覆盖组、变换、混合、蒙版、调整、文字、形状和 guides，并在缺失素材或不安全路径时拒绝替换。
- `src/editor/io/psd-adapter.ts` 校验 PSD/PSB 头部，仅接受 8-bit RGB；可编辑文字、形状和像素层分别转换，无法编辑内容进入转换报告。
- `src/editor/workspace/project-workspace.ts` 提供多项目标签、最近项目、脏工程关闭保护和外部 reload/keep-local 决策；`external-change-watcher.ts` 提供 debounce 与 revision/hash 变化检测。
- 删除 `novelcomic-ae-exchange`、`novelcomic-live2d-render`、旧 PSD LayerPackage 和 After Effects API 入口；这些协议不再作为 Compositor 文档兼容层存在。

### 阶段 10：完整像素工具和 Camera Raw 对齐

> 完成状态：2026-10-07 已完成。阶段十主路径只保留 Compositor `DocumentState`、像素 Worker 和统一 render graph；旧 tracks/items 像素工具、AE 交换入口和兼容型高级图层实现不再参与 PS 工作区。

工作：

- 补齐 Brush、Eraser、Blur、Smudge/Liquify、Clone Stamp、Spot Healing、Gradient、Shape、Type、Eyedropper。
- 补齐 Rectangle/Ellipse Marquee、Lasso/Polygon Lasso、Magic Wand、Color Range、Object Selection、Select Subject。
- 补齐 Expand/Contract/Feather、selection-to-mask、mask-to-selection、Content-Aware Fill、Remove Background。
- 补齐 Camera Raw 的 Light、Color、Curve、Mixer、Color Grading、Detail、Optics、Geometry、Bloom/Glow、Vignette、Dither。
- 所有工具支持预览/取消/应用、选区限定、Worker/GPU 预览和完整分辨率导出。

对应参考：[EditorSession+Brush.swift](../../Compositor/Compositor/Document/EditorSession+Brush.swift)、[CloneStamp.swift](../../Compositor/Compositor/Document/CloneStamp.swift)、[SmudgeLiquify.swift](../../Compositor/Compositor/Document/SmudgeLiquify.swift)、[Selection.swift](../../Compositor/Compositor/Document/Selection.swift)、[MagicWand.swift](../../Compositor/Compositor/Document/MagicWand.swift)、[ObjectSelection.swift](../../Compositor/Compositor/Document/ObjectSelection.swift)、[CameraRaw.swift](../../Compositor/Compositor/Document/CameraRaw.swift)、[CameraRawColor.swift](../../Compositor/Compositor/Document/CameraRawColor.swift)、[CameraRawDetailOptics.swift](../../Compositor/Compositor/Document/CameraRawDetailOptics.swift)、[CameraRawGeometryCalibration.swift](../../Compositor/Compositor/Document/CameraRawGeometryCalibration.swift)。

验收：

- 每个工具至少有创建/预览/取消/应用/撤销/保存重载/导出回读测试。
- 大图使用 tile/Worker，不把完整像素数组放进 React state；GPU 与 Canvas2D fallback 的关键 fixture 差异有上限。
- 每个调整和滤镜至少有 identity、边界、非 identity 三组像素 fixture。

实际交付：

- `src/editor/pixels/pixel-tools.ts` 提供不可变 Brush、Eraser、Blur、Smudge/Liquify、Clone Stamp、Spot Healing、Gradient、Eyedropper、Magic Wand、Color Range、Object Selection、Select Subject、选区形态学、selection/mask 转换、Content-Aware Fill 和 Remove Background；所有操作都可以在 Worker 或同步 fallback 中执行。
- `src/editor/pixels/camera-raw.ts` 提供 Light、Color、Curve、Mixer、Color Grading、Detail、Optics、Geometry、Bloom、Vignette、Grain 和 Dither 的统一 CPU 求值；预览与完整分辨率导出共用同一函数，默认参数为 identity。
- `PixelEditSession` 统一预览、取消和应用事务；`pixel.replace`、`camera-raw.update` 通过 `DocumentCommandBus` 进入历史，可撤销、可保存和可回放。
- Camera Raw 以正式 `AdjustmentContent` 存储，并由 render graph 在 Canvas2D/WebGL fallback 路径求值；React 状态不保存完整像素数组。
- 自动验收见 `src/editor/acceptance/compositor-stage10.test.ts`、`src/editor/pixels/pixel-tools.test.ts` 和 `src/editor/pixels/pixel-edit-session.test.ts`。

### 阶段 11：应用壳、快捷键和 Agent 闭环

工作：

- 完成菜单、工具选项栏、数值 scrub、快捷键映射、可访问性和面板布局持久化。
- 实现浏览器多标签、最近工程、任务中心、后台保存、断网重试和错误恢复。
- 实现 Agent/脚本 API：新建工程、导入素材、创建/更新/排序图层、添加 mask/effect/adjustment、提交命令、读取 revision、导出结果。
- 对 `.comp`/manifest 外部变更建立 debounce、revision 检查和冲突提示。

对应参考：[KeyboardShortcuts.swift](../../Compositor/Compositor/UI/KeyboardShortcuts.swift)、[NumericScrub.swift](../../Compositor/Compositor/UI/NumericScrub.swift)、[ProjectTabs.swift](../../Compositor/Compositor/UI/ProjectTabs.swift)、[ProjectController.swift](../../Compositor/Compositor/IO/ProjectController.swift)、[ProjectWatcher.swift](../../Compositor/Compositor/IO/ProjectWatcher.swift)。

验收：

- 鼠标、快捷键、菜单、Agent API 对同一操作产生同一个 command id 和同一种历史记录。
- 后台保存、刷新恢复、外部修改、网络失败和并发冲突均不会静默丢稿。
- Agent 从空白工程开始可以完成导入、分层、合成、保存、静帧导出和 Remotion 视频导出。

### 阶段 12：Compositor parity matrix 和全链路验收

工作：

- 将 1.9 的每一项登记到 `tests/fixtures/compositor-parity/matrix.json`，字段至少包含 `featureId`、参考源码、命令 id、阶段、测试、像素证据和当前状态。
- 每项功能至少具备领域测试、浏览器 smoke、持久化回读、撤销/重做和最终导出验证；像素工具增加 PNG diff 和 alpha diff。
- 建立从“新建 -> 导入 -> 编辑 -> 预览 -> 保存 -> 刷新 -> 冲突恢复 -> 静帧 -> 视频 -> 下载”的单条全链路验收。
- 建立功能差异报告：明确标记 `equivalent`、`web-adapted`、`unsupported`；只要还有 `unsupported`，不能宣称全功能完成。

验收：

- 1.9 中所有 P0/P1 功能均为 `verified`，没有未解释的 `planned` 或 `implemented`。
- 同一 fixture 在 Canvas preview、静帧 PNG、Remotion 视频首帧和导出图片中通过差异阈值。
- 任意失败都保留输入工程、命令日志、revision、浏览器截图和像素 diff，能够复现。

### 阶段 13：移除旧主路径

仅在阶段 0-12 全部通过后执行：

- 删除默认旧 AE Chrome。
- 删除主界面中以 tracks/items 为中心的渲染分支。
- 删除 `FEATURE_AE_FRONTEND`。
- 旧时间线只保留为 Animation Workspace 适配器。
- 更新 README、部署文档和 API 文档。

---

## 13. 文件级改造清单

### 第一批必须新增

- `src/editor/document/types.ts`
- `src/editor/document/validate.ts`
- `src/editor/document/normalize.ts`
- `src/editor/document/tree.ts`
- `src/editor/commands/command-types.ts`
- `src/editor/commands/command-bus.ts`
- `src/editor/commands/command-history.ts`
- `src/editor/render-graph/evaluate-document-frame.ts`
- `src/editor/render-graph/build-render-graph.ts`
- `src/editor/workspace/compositor-shell.tsx`
- `src/editor/workspace/layers-panel.tsx`
- `src/editor/workspace/inspector-panel.tsx`
- `src/server/project/project-repository.ts`
- `src/server/project/command-service.ts`
- `src/server/project/asset-service.ts`

阶段九互操作边界：

- `src/editor/io/project-package.ts`
- `src/editor/io/project-package-fs.ts`
- `src/editor/io/image-io.ts`
- `src/editor/io/comp-adapter.ts`
- `src/editor/io/psd-adapter.ts`
- `src/editor/io/external-change-watcher.ts`

### 第二批必须重写

- `src/editor/editor.tsx`
- `src/editor/canvas/composition.tsx`
- `src/editor/canvas/layers.tsx`
- `src/editor/layer-panel/layer-panel.tsx`
- `src/editor/sidebar/comic-layer-panel.tsx`
- `src/editor/project/project-context.tsx`
- `src/editor/project/project-store.ts`
- `src/editor/state/normalize-undoable-state.ts`
- `src/remotion/main.tsx`

### 第三批转为适配器或次级工作区

- `src/editor/timeline/**`
- `src/editor/advanced/**`
- `src/editor/comic/**`
- `src/editor/compose/**`
- `src/editor/rendering/**`

它们不能直接删除。迁移完成前必须通过 adapter 读取/写入 `DocumentState`，否则会破坏已有动态漫画生产链路。

---

## 14. 测试和验收矩阵

### 14.1 领域测试

- 文档 schema：默认值、非法值、高版本拒绝、迁移。
- 图层树：插入、排序、嵌套、循环、删除子树、解组。
- 变换：单层、多选、文件夹、旋转、翻转、snap。
- 蒙版：绘制、反相、羽化、独立变换、folder mask、live mask。
- 调整层：每个 kind 的 identity 和非 identity 参数。
- 效果：参数边界、启用/禁用、透明度。
- 选择：add/subtract/intersect、expand/contract/feather。
- 历史：命令合并、撤销、重做、空操作、取消事务。
- render graph：嵌套组、blend、mask、adjustment 顺序。

### 14.2 API 测试

- project CRUD。
- expectedRevision 冲突。
- clientRequestId 幂等。
- 资产上传完成前不可引用。
- snapshot restore。
- render 固定 revision。
- 取消、重试和失败状态。

### 14.3 浏览器验收

至少覆盖：

1. 新建 1920x1080 文档。
2. 导入三张图片并排序。
3. 建立文件夹并拖入两层。
4. 改名、隐藏、锁定、复制、删除。
5. 变换、吸附、撤销、重做。
6. 添加蒙版并用画笔修改。
7. 添加 Hue/Saturation 和 Gaussian Blur。
8. 添加 Drop Shadow、Stroke、Color Overlay。
9. 添加文字和形状。
10. 保存、刷新、恢复。
11. 导出静帧。
12. 添加关键帧并用 Remotion 输出视频。

### 14.4 像素验收

- 关键 fixture 固定输入图层和 mask。
- 对比 Canvas preview、静帧 PNG、视频首帧。
- 记录 RGB 差异、alpha 差异、边缘差异和透明区域错误。
- 对 GPU 和 Canvas2D fallback 分别验收。

---

## 15. 不纳入本轮的内容

这里要区分“彻底按照 Compositor 重构”和“复制 Compositor 的 macOS 实现”。前者必须由阶段 0-12 完成；后者只做 Web/Remotion 等价实现。以下内容不照搬原生实现细节，但不能因此跳过对应的产品能力：

- SwiftUI/AppKit 窗口管理。
- macOS 菜单栏、原生文件选择器和系统快捷键注册；Web 端必须提供等价菜单、文件选择和快捷键行为。
- Metal 专有 API；Web 端使用 WebGL2/WASM/Canvas fallback，并以像素 fixture 验证结果。
- Compositor 自身未支持的能力不冒充已支持：参考工程明确只接受 8-bit RGB 的 PSD/PSB，不承诺 CMYK；本项目同样要给出明确拒绝/转换报告。
- Compositor 的原生 `.comp` 包不是 Web 端唯一真相源，但阶段 9 必须提供可读写的兼容适配器和外部变更闭环。
- macOS 自动更新、签名和 notarization 不属于浏览器运行时；本项目要在发布层提供部署、版本更新和完整性校验等价物，或在 parity matrix 中明确标记为平台差异。

这些是平台差异，不是功能豁免，也不是回退到兼容方案的理由。产品层仍然必须遵守 Compositor 的图层、蒙版、调整、效果、工程和命令语义；Web 端只是用 TypeScript、WebGL2、WASM、Canvas 和 Remotion 重新实现同一套产品结构。

---

## 16. 最终完成标准

只有满足以下条件，才能说“Remotion 的 PS 部分已经按 Compositor 重构完成”：

1. 默认首页是按照 Compositor 彻底重构的图像编辑工作区，不是旧 AE 时间线加兼容入口。
2. 工程真相源是 `DocumentState` 图层树，而不是 `tracks/items`。
3. 图层、组、蒙版、剪贴、调整层、效果、文字和形状均可保存/恢复。
4. 所有修改都经过命令总线，并具备撤销/重做和 revision。
5. Canvas、静帧和 Remotion 输出共用同一 render graph。
6. 资产上传、项目保存、快照恢复、冲突处理和渲染任务均由 `novelcomic-remotion` 后端闭环。
7. 动态漫画能力挂在图层文档和属性动画之上，不再通过复制图层到多条轨道实现。
8. 旧视频时间线只作为动画工作区，不再决定 PS 主界面的数据结构。
9. 关键操作有领域测试、API 测试、浏览器验收和像素证据。
10. 文档中明确列出的旧入口、旧开关和旧双写路径已删除，而不是继续隐藏。
11. 1.9 功能索引中的每一项都有对应的 `featureId`、本项目实现、参考源码、自动化测试和验收证据。
12. `compositor-parity/matrix.json` 中没有未解释的 `planned`、`implemented` 或 `unsupported` 项；平台差异必须标记为 `web-adapted` 并有等价验收。
13. 从新建工程到导入、编辑、保存、刷新、冲突恢复、静帧、Remotion 视频和下载的全链路测试通过。
14. 只有达到以上条件，才能宣称“Compositor 功能完整闭环”；阶段 0-8 通过只能称为“核心编辑器和动态漫画闭环”。

---

## 17. 推荐立即执行的前三个 PR

在本方案下，PR-0 必须先落文档和 fixture；没有它，阶段一的跨语言一致性无法验收。

### PR-0：施工合同和跨语言 fixture

- 固定本文件中的 schema、错误码、canonical JSON 和阶段边界。
- 加入 `tests/fixtures/document/` 的 valid/invalid/migration/command 样本。
- 加入 Python 离线校验入口和 TypeScript fixture 测试。
- 只允许文档、fixture、校验脚本变更，不改编辑器行为。

### PR-1：文档模型和命令边界

- 新建 `DocumentState`、schema、validate、normalize。
- 新建 legacy adapter 和 canonical hash。
- 不改 UI，不接 IndexedDB，只把旧状态迁移测试跑通。
- 目标是建立唯一真相源。

### PR-2：Compositor Shell 和 Layer Tree

- （阶段二完成并通过 CAS/幂等验收后）用新的 Shell 替换旧 AE 主壳。
- 完成图层树、组、重命名、排序、显隐、锁定、删除。
- 画布先复用现有静态渲染，暂不加入高级像素工具。

### PR-3：Render Graph 和 Mask

- 统一 Canvas/Remotion/静帧求值。
- 迁移 mask buffer、brush、mask alone。
- 加入像素级 fixture 和 browser smoke。

完成这三个 PR 后，项目才真正从“视频编辑器里塞 PS 工具”切换成“Compositor 式图像编辑器，Remotion 负责时间和输出”。
