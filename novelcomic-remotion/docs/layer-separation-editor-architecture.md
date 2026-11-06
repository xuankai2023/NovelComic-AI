# PS / AE 原型复刻版：拆层编辑器开发文档

> 状态：开发评审稿  
> 日期：2026-10-05  
> 原则：不重新发明拆层交互，静态图照 Photoshop，视频照 After Effects。

## 1. 产品定义

本功能直接复刻两套 Adobe 工作流：

| 场景 | 复刻对象 | 本项目名称 |
| --- | --- | --- |
| 静态漫画图片拆层 | Photoshop：Select and Mask（选择并遮住） | 选择并遮住 |
| 视频、序列帧逐帧拆层 | After Effects：Layer Panel + Object Matte / Roto Brush | 图层面板 / 对象遮罩 |

最终结构：

```text
同一个 Editor
同一个中央 Viewer 面板组
同一个 Timeline
同一个项目状态

Viewer 页签：
[合成] [图层：源图名称]
```

不创建第二个编辑器页面，不创建第二套时间线，不创建第二套图层状态。复制 Adobe 的信息架构和行为，不复制其代码、图标文件或品牌资产。

---

## 2. Adobe 行为基线

## 2.1 Photoshop 工作流

静态图片拆层完全按照 Photoshop“选择并遮住”：

1. 用户选中图片图层。
2. 点击“选择并遮住…”。
3. 中央仍显示当前图片，但进入专用编辑状态。
4. 左侧显示选择和边缘处理工具。
5. 顶部显示当前工具参数。
6. 右侧显示视图模式、边缘检测、全局调整和输出设置。
7. 画笔默认增加选区，按住 `Alt/Option` 减去选区。
8. 用户选择“输出到”。
9. 点击“确定”应用，点击“取消”丢弃。

Quick Mask 视觉规则也照抄：

- 未选区域覆盖红色。
- 默认红色不透明度 50%。
- 白色代表选中/保留。
- 黑色代表未选/隐藏。
- 灰色代表部分透明。
- Overlay 颜色和透明度只影响预览，不改变 Mask 数据。

## 2.2 After Effects 工作流

视频逐帧拆层完全按照 AE Layer Panel + Object Matte / Roto Brush：

1. 用户双击 Timeline 中的 Layer。
2. 中央 Viewer 面板组打开“图层：名称”页签。
3. Layer 页签显示源 Layer，不显示最终合成变换后的结果。
4. Timeline 保留，CTI 与 Layer 页签同步。
5. 用户在 Base Frame 创建前景选择。
6. 按住 `Alt/Option` 绘制背景排除区域。
7. 系统向前、向后传播 Matte。
8. 用户在错误第一次出现的帧添加修正笔画。
9. Refine Edge 处理头发、毛发、半透明和运动模糊边缘。
10. 完成后点击 Viewer 底部“冻结”。
11. 冻结完成后返回“合成”页签。

---

## 3. 整体布局

采用 Adobe 面板式布局：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 主工具栏                                                               │
├───────────────┬──────────────────────────────────────┬─────────────────┤
│               │ [合成] [图层：角色原图 ×]            │                 │
│ 项目 / 素材   ├──────────────────────────────────────┤ 属性 / 效果控件 │
│               │                                      │                 │
│ 图层列表      │              Viewer                  │ 视图模式        │
│               │                                      │ 边缘检测        │
│               │                                      │ 全局调整        │
│               │                                      │ 输出设置        │
├───────────────┴──────────────────────────────────────┴─────────────────┤
│ Timeline：图层、CTI、时间尺、拆层传播区间、关键帧                      │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Viewer 面板组

现有中央 Canvas 升级为 Viewer Panel Group。

- `合成`：现有 Remotion Composition 预览。
- `图层：{layerName}`：PS/AE 式源图层编辑。
- 双击 Timeline Layer 打开 Layer 页签。
- 已打开的 Layer 再次双击，只激活已有页签。
- Layer 页签可以关闭，合成页签不可关闭。
- 切换页签不改变 Timeline 当前时间。
- Layer 与 Composition 共用中央 Viewer 位置。

### 3.2 Timeline

Timeline 始终保留。

静态图片“选择并遮住”期间：

- 保留 CTI 和时间尺。
- 禁止播放。
- 禁止拖动、裁剪、删除当前 Item。
- 禁止调整 Track 顺序。
- 允许切换帧，但静态源图内容不变。

视频 Object Matte / Roto Brush 期间：

- 允许 CTI 拖动和逐帧移动。
- 允许分析传播。
- 禁止当前 Layer 的移动、裁剪和删除。
- Timeline 显示 Base Frame、Span、传播状态和冻结缓存。

---

## 4. 静态图片：Photoshop“选择并遮住”

## 4.1 入口

提供两个入口：

1. 图片图层选中时，顶部工具参数栏显示“选择并遮住…”按钮。
2. 图层右键菜单显示“选择并遮住…”。

进入条件：

- 只选中一个 Image Item。
- Asset 已加载且图片尺寸有效。
- 当前不处于 Crop、文字编辑或渲染锁定状态。

进入后：

- 暂停 Remotion Player。
- 打开 `图层：{name}` 页签。
- 默认激活快速选择工具。
- 有现存 Mask 则载入；否则创建空选择。
- 右侧切换为“选择并遮住”属性。

## 4.2 左侧工具栏

工具顺序照 Photoshop：

| 顺序 | 工具 | 本项目行为 |
| --- | --- | --- |
| 1 | 对象选择 | 点击或框选对象，调用自动分割获取初始选区 |
| 2 | 快速选择 | 根据颜色、纹理和边缘扩展选区 |
| 3 | 调整边缘画笔 | 沿头发、毛发、半透明边缘涂抹 |
| 4 | 画笔 | 直接编辑选区/Mask |
| 5 | 套索 | 自由套索增加或减去选区 |
| 6 | 多边形套索 | 用直线段创建选区 |
| 7 | 手形 | 平移 Viewer |
| 8 | 缩放 | 放大或缩小 Viewer |

第一期算法未完成时也保留相同位置和名称：

- 对象选择先调用现有 AI segmentation 服务。
- 快速选择可以先使用普通 Mask 画笔实现。
- 调整边缘画笔先记录 Refine 区域，后续接边缘算法。

不因算法暂缺重新设计工具栏。

## 4.3 顶部工具参数栏

选择类工具显示：

- 新建选区。
- 添加到选区。
- 从选区减去。
- 与选区交叉，第二期实现。
- 画笔大小。
- 硬度。
- 间距。
- “选择主体”。
- “反相”。

画笔行为：

- 默认笔画增加选区。
- 按住 `Alt/Option` 临时减去选区。
- `[` / `]` 调整画笔大小。
- `Shift + [` / `Shift + ]` 调整硬度。
- 松开 `Alt/Option` 恢复增加模式。

## 4.4 视图模式

右侧“视图模式”按 Photoshop 提供：

| 模式 | 表现 |
| --- | --- |
| 洋葱皮 | 通过透明度查看被移除区域和原图关系 |
| 虚线 | 显示选区蚂蚁线 |
| 叠加 | 未选区域显示半透明红色 |
| 黑底 | 在黑色背景上预览 Cutout |
| 白底 | 在白色背景上预览 Cutout |
| 黑白 | 显示 Alpha，白保留、黑隐藏、灰半透明 |
| 图层上 | 在最终合成下层内容上预览结果 |

附加控制：

- 透明度。
- Overlay 颜色。
- 显示边缘。
- 显示原稿。
- 高质量预览。

默认值：

```ts
{
  viewMode: 'overlay',
  overlayColor: '#ff0000',
  overlayOpacity: 0.5,
  showEdge: false,
  showOriginal: false,
  highQualityPreview: true
}
```

## 4.5 右侧属性面板

分组和顺序照 Photoshop：

### A. 视图模式

- View Mode。
- Transparency。
- Overlay Color。
- Show Edge。
- Show Original。

### B. 边缘检测

- Radius，单位 px。
- Smart Radius。

### C. 全局调整

- Smooth。
- Feather，单位 px。
- Contrast，单位 %。
- Shift Edge，单位 %。

### D. 输出设置

- Decontaminate Colors。
- Amount。
- Output To。

第一期真正生效：Smooth、Feather、Contrast、Shift Edge。其余参数允许分阶段接算法，但控件结构不变。

## 4.6 输出到

照 Photoshop 映射：

| Photoshop 输出 | 本项目行为 |
| --- | --- |
| 选区 | 保留临时选区，不生成新 Item；第一期隐藏 |
| 图层蒙版 | 将 Mask 绑定到当前 Image Item |
| 新建图层 | 生成透明 Cutout Item，不保留可编辑 Mask |
| 新建图层并带有图层蒙版 | 复制源图层并绑定 Mask；默认选项 |
| 新建文档 | 不适用，隐藏 |
| 新建文档并带有图层蒙版 | 不适用，隐藏 |

默认选择“新建图层并带有图层蒙版”，保证非破坏和可重进编辑。

## 4.7 底部动作

右下角只保留：

- `取消`
- `确定`

取消关闭 Layer 页签并丢弃未提交修改；确定按 Output To 提交一次全局 Undo，然后关闭页签并返回合成。

不得增加“生成”“应用”“返回”等同义按钮。

---

## 5. 视频：AE Layer Panel + Object Matte / Roto Brush

此部分第二阶段实施，但第一阶段预留数据结构。

## 5.1 Layer Panel

- 双击 Timeline 视频或序列帧 Layer。
- Viewer 打开 `图层：{name}` 页签。
- 显示源素材坐标，不应用 Composition 的 Position、Scale、Rotation 和 Camera。
- CTI 与 Timeline 同步。
- Viewer 底部显示 Layer 时间尺、Span 和 Freeze。

## 5.2 工具

| 工具 | 行为 |
| --- | --- |
| 对象遮罩 | 点击主体生成初始 Matte |
| 快速选择 | 在物体内部涂抹产生前景选择 |
| 选择画笔 | 手工增加或减去选择区域 |
| Roto Brush | 用前景/背景笔画指导分割 |
| 调整边缘 | 处理毛发、头发、透明和运动模糊边缘 |

规则：

- 前景笔画显示绿色。
- `Alt/Option` 背景排除笔画显示红色。
- Roto 初始笔画画在物体内部，不沿轮廓描边。
- Refine Edge 笔画覆盖 Matte 边界内外混合区域。

## 5.3 Base Frame

第一次创建 Matte 的帧成为 Base Frame：

- 在时间尺显示亮绿色块。
- 作为当前 Span 分割基准。
- 建议用户选主体完整、前后景分离清晰的帧。

```ts
type MatteBaseFrame = {
  frame: number;
  foregroundStrokes: MatteStroke[];
  backgroundStrokes: MatteStroke[];
  refineEdgeStrokes: MatteStroke[];
};
```

## 5.4 Span 与传播

- Base Frame 创建后产生向前和向后的传播范围。
- Span 使用灰色箭头/人字纹表达传播方向。
- Base Frame 左右两侧修正分别向对应方向传播。
- 在 Span 外绘制创建新的 Base Frame 和 Span。
- Span 边缘可拖动调整范围。

标准工作流：

1. Base Frame 做初始选择。
2. 前进一帧检查。
3. 在错误首次出现的帧修正。
4. 继续逐帧检查。
5. 检查 Refine Edge。
6. 完成后冻结。

## 5.5 通道查看

Viewer 底部照 AE 提供：

| 查看模式 | 快捷键 | 表现 |
| --- | --- | --- |
| RGB | 默认 | 显示源画面 |
| Alpha | `Alt/Option + 4` | 显示黑白 Alpha |
| Alpha Boundary | `Alt/Option + 5` | 原图叠加分割边界 |
| Alpha Overlay | `Alt/Option + 6` | 前景原色，背景覆盖颜色 |
| Refine Edge X-ray | `Alt/Option + X` | 查看半透明边缘区域 |

## 5.6 效果控件

右侧切换为 Object Matte 或 Roto Brush & Refine Edge：

- Feather。
- Contrast。
- Shift Edges。
- Reduce Chatter。
- Render Refine Edge。
- Base Refine Edge Radius。

传播参数独立分组。传播参数变化要求重新传播；Matte 外观参数允许冻结后调整。

## 5.7 Freeze

- Viewer 右下固定显示“冻结”。
- 点击后计算 Span 内未完成帧。
- 显示总进度和当前帧进度。
- 已计算帧写入缓存。
- 完成后锁定传播数据并随项目保存。
- 冻结后笔画工具不可编辑。
- 再次点击解除冻结。
- 解除后修改笔画或传播参数才重新计算。
- Span 使用紫色缓存条显示冻结结果。

---

## 6. 状态模型

## 6.1 临时 Layer 会话

临时状态不写入项目 UndoableState：

```ts
type LayerPanelSession = {
  id: string;
  itemId: string;
  assetId: string;
  mediaType: 'still' | 'video';
  currentFrame: number;
  dirty: boolean;

  activeTool:
    | 'object-select'
    | 'quick-select'
    | 'refine-edge'
    | 'brush'
    | 'lasso'
    | 'polygon-lasso'
    | 'hand'
    | 'zoom';

  operation: 'new' | 'add' | 'subtract' | 'intersect';
  viewMode:
    | 'onion-skin'
    | 'marching-ants'
    | 'overlay'
    | 'on-black'
    | 'on-white'
    | 'black-white'
    | 'on-layers'
    | 'alpha-boundary'
    | 'alpha-overlay'
    | 'refine-edge-xray';

  maskDraft: MaskDraft;
  localHistory: MaskHistory;
  baseFrames: MatteBaseFrame[];
  spans: MatteSpan[];
  frozen: boolean;
  freezeProgress: number | null;
};
```

## 6.2 持久化 Matte

继续使用现有 `ComicEditLayer`，增加可选字段：

```ts
type ComicEditLayer = ExistingComicEditLayer & {
  matte?: {
    type: 'still-mask' | 'object-matte' | 'roto-brush';
    maskAssetId?: string;
    baseFrames?: MatteBaseFrame[];
    spans?: MatteSpan[];
    frozen?: boolean;
    frozenCacheAssetId?: string;
    properties: {
      feather: number;
      contrast: number;
      shiftEdge: number;
      reduceChatter?: number;
      refineEdgeRadius?: number;
    };
  };
};
```

第一期静态图写入 Mask/Cutout/Bounds、`matte.type = 'still-mask'` 和最终边缘参数。

---

## 7. 坐标和渲染

Layer Panel 显示源 Asset 像素空间，不使用 Composition 空间：

```text
Pointer Client 坐标
→ Viewer Local 坐标
→ 去除 Pan
→ 除以 Zoom
→ Source Pixel 坐标
```

规则：

- 选区、笔画、Mask 和 Refine Edge 数据全部使用源图坐标。
- Position、Scale、Rotation 不参与 Mask 编辑。
- 返回 Composition 后再应用 Item Transform。
- 1:1 时一个源像素对应一个 CSS 像素。
- 400% 以上显示像素网格。
- Mask 只存 Alpha Buffer。
- Pointer Move 只更新 Dirty Bounds。
- 单次 Stroke 结束才写本地历史。

Layer Surface 分三层：

```text
Source Bitmap Layer
Mask / Matte Preview Layer
Selection / Stroke Interaction Layer
```

---

## 8. Undo / Redo

Layer 页签打开时：

- `Cmd/Ctrl + Z` 撤销当前 Mask/Stroke。
- `Cmd/Ctrl + Shift + Z` 重做当前 Mask/Stroke。
- 不触发项目 Track/Item Undo。

点击“确定”后：

- 所有资源和图层变化合并为一次项目级 Undo。
- 回到 Composition 后一次 Undo 完整撤销拆层。

点击“取消”不产生项目级历史。

---

## 9. 项目提交

默认模拟 Photoshop“新建图层并带有图层蒙版”。

### 9.1 准备资源

不修改 EditorState：

1. 读取 MaskDraft。
2. 应用 Smooth、Feather、Contrast、Shift Edge。
3. 生成完整尺寸 Mask PNG。
4. 生成透明 Cutout 预览。
5. 计算非透明 Bounds。
6. 上传或写入 Asset 缓存。

### 9.2 原子提交

一次 `setState({commitToUndoStack: true})`：

- 新增 Mask Asset。
- 新增 Cutout Asset。
- 复制 Image Item。
- 给新 Item 绑定 `maskAssetId`。
- 新增或更新 Track。
- 新增或更新 `comicEditLayers`。
- 选中新 Item。

准备失败不得留下半成品 Item 或 Track。

---

## 10. 代码改造

## 10.1 保留

- `src/editor/canvas/canvas.tsx` 的 `canvasRef`。
- `src/editor/canvas/scaled-player.tsx` 作为 Composition Surface。
- `src/editor/canvas/player.tsx` 作为合成播放器。
- `src/editor/state/types.ts` 的统一项目状态。
- `src/editor/comic/manual-layer-types.ts` 的关系模型。
- `src/editor/comic/rasterize-mask.ts`。
- `src/editor/comic/create-cutout-asset.ts`。
- `src/editor/comic/layer-segmentation.ts`。

## 10.2 新增目录

```text
src/editor/viewer/
├── viewer-panel-group.tsx
├── viewer-tabs.tsx
├── viewer-tab-state.ts
└── composition-surface.tsx

src/editor/layer-panel/
├── layer-panel.tsx
├── layer-panel-provider.tsx
├── layer-panel-state.ts
├── layer-panel-toolbar.tsx
├── layer-panel-options-bar.tsx
├── layer-panel-properties.tsx
├── layer-panel-footer.tsx
├── show-channel-controls.tsx
├── selection/
│   ├── object-selection-tool.ts
│   ├── quick-selection-tool.ts
│   ├── refine-edge-tool.ts
│   ├── brush-selection-tool.ts
│   ├── lasso-tool.ts
│   └── polygon-lasso-tool.ts
├── mask/
│   ├── mask-buffer.ts
│   ├── mask-renderer.ts
│   ├── mask-refinements.ts
│   ├── mask-history.ts
│   └── mask-worker.ts
├── roto/
│   ├── matte-stroke.ts
│   ├── base-frame.ts
│   ├── matte-span.ts
│   ├── propagation.ts
│   └── freeze-cache.ts
└── commit/
    ├── output-to.ts
    └── commit-layer-mask.ts
```

## 10.3 Canvas 目标结构

```tsx
<ViewerPanelGroup ref={canvasRef}>
  <ViewerTabs />
  {activeTab.type === 'composition' ? (
    <CompositionSurface playerRef={playerRef} />
  ) : (
    <LayerPanel sessionId={activeTab.sessionId} />
  )}
</ViewerPanelGroup>
```

`CompositionSurface` 继续使用现有 `ScaledPlayer`。`LayerPanel` 不是第二个 Editor，也不使用第二个 Timeline。

---

## 11. 第一阶段交付：做成 Photoshop

第一阶段只支持静态 Image Item，目标是接近 Photoshop Select and Mask，不只是“能画 Mask”。

必须完成：

- 合成 / 图层 Viewer 页签。
- 双击 Layer 打开图层页签。
- 左侧 PS 顺序工具栏。
- 顶部选择模式和画笔参数。
- Overlay / 黑底 / 白底 / 黑白 / 图层上预览。
- 默认红色 50% Overlay。
- 画笔增加，Alt/Option 减去。
- Smooth / Feather / Contrast / Shift Edge。
- Output To。
- 取消 / 确定。
- 新建图层并带有图层蒙版。
- 局部 Undo/Redo。
- 一次项目级提交和一次全局 Undo。

允许暂缓算法但不能改变 UI：

- 对象选择精度。
- 快速选择边缘感知精度。
- Smart Radius。
- Decontaminate Colors。
- 高级 Refine Edge。

明确禁止：

- 自创“生成”按钮。
- 自创“专注模式”页面。
- 隐藏整个 Timeline。
- 将 Layer Panel 放到新路由。
- 破坏性删除源图像素。

---

## 12. 第二阶段交付：做成 After Effects

- 视频/序列帧 Layer Panel。
- Object Matte / Quick Selection / Selection Brush / Refine Edge。
- Base Frame。
- 双向 Span。
- 逐帧修正。
- Alpha / Alpha Boundary / Alpha Overlay / X-ray。
- Feather / Contrast / Shift Edges / Reduce Chatter。
- Propagation。
- Freeze / Unfreeze。
- 紫色冻结缓存条。
- 缓存随项目保存。

---

## 13. 对照验收

## 13.1 Photoshop 对照

测试人员同时打开 Photoshop Select and Mask 与本编辑器：

1. 选择同一张人物图。
2. 进入选择并遮住。
3. 检查工具顺序。
4. 检查 Overlay 默认红色 50%。
5. 画笔增加选区。
6. Alt/Option 减去选区。
7. 切换 Overlay、黑底、白底、黑白、图层上。
8. 调整 Smooth、Feather、Contrast、Shift Edge。
9. 输出到“新建图层并带有图层蒙版”。
10. 确定返回合成。
11. 检查源图仍在，新图层带可编辑 Mask。

完成路径、控件分组或术语明显不同则不通过。

## 13.2 After Effects 对照

测试人员同时打开 AE Layer Panel 与本编辑器：

1. 双击 Timeline Layer。
2. 检查同一 Viewer 面板组是否打开 Layer 页签。
3. 在 Base Frame 绘制前景笔画。
4. Alt/Option 绘制背景笔画。
5. 前进一帧检查传播。
6. 在错误首帧修正。
7. 检查 Span、Base Frame 和方向提示。
8. 切换 Alpha、Boundary、Overlay、X-ray。
9. 点击 Freeze。
10. 检查进度、紫色缓存条和锁定状态。
11. 返回 Composition 检查最终 Matte。

Layer、Timeline、Span 和 Freeze 的关系明显不同则不通过。

---

## 14. 实现原则

开发和测试以 Adobe 官方行为为准：

- Photoshop Quick Mask：默认红色 50% 覆盖；白增加选择，黑减少选择，灰产生部分透明。
- Photoshop Select and Mask：Quick Selection、Refine Edge Brush、Brush、Lasso、视图模式、全局调整和 Output To。
- AE：Composition、Layer 与 Timeline 共享项目和当前时间。
- AE Roto/Object Matte：Base Frame、前景/背景修正、Span 传播、Alpha 通道、Refine Edge 和 Freeze。

实现出现歧义时，不创建新的交互规则，先回到 Photoshop 或 After Effects 的对应行为确认。

## 15. 结论

静态图把 Photoshop“选择并遮住”搬进现有 Viewer；视频把 After Effects“Layer Panel + Object Matte/Roto Brush”搬进同一个 Viewer；底部始终使用现有 Timeline，结果始终写回同一套项目图层状态。
