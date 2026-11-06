# 动态漫画 Photoshop 类能力优化实施清单

> 适用工程：`novelcomic-remotion`
> 目标：把“手动描点生成透明图层”改造成真正可用于动态漫画的 `L0 + Clean Plate + Cutout` 非破坏式流程。
> 总览：[动态漫画PS功能清单README.md](./动态漫画PS功能清单README.md)
> 验收：[动态漫画PS完整闭环测试清单.md](./动态漫画PS完整闭环测试清单.md)

## 1. 实施总原则

所有拆层操作必须遵守：

```text
原图 L0 永远保留
    ↓
生成 mask
    ↓
生成透明 Cutout
    ↓
生成 Clean Plate
    ↓
Clean Plate + Cutout 进入 Normal 和最终渲染
    ↓
L0 只用于 Source、恢复和对比
```

禁止把以下状态当成最终完成：

```text
原图 L0 + Cutout
```

因为 Cutout 移动后，原图会留下残影。

## 2. 当前代码与目标的差距

### 2.1 当前已经存在

- `ComicEditLayer` 数据模型。
- polygon、bounds、maskAssetId、cutoutAssetId、cleanPlateAssetId 字段。
- 多边形描点工具。
- 钢笔工具。
- polygon mask 栅格化。
- 透明 cutout PNG 生成。
- cutout 初始位置按 source bounds 放回原图。
- LayerPackage 导入。
- 带 Clean Plate 的 LayerPackage 导入后隐藏 L0。
- `applyCleanPlateToState()` 底层函数。
- Normal、Source、Layers、Overlay、Difference、Mask 等质量预览入口。

### 2.2 必须优先修复

- 手动描点流程只生成 mask 和 cutout，没有自动进入 Clean Plate 流程。
- 手动拆层完成后 L0 仍作为可见底图。
- `applyCleanPlateToState()` 直接替换 source item 的 asset，导致 L0 item 和 Clean Plate item 没有分离。
- 手动流程没有明确的 Clean Plate track。
- Quality preview 不能只靠普通 track 是否隐藏来推断 L0、Clean Plate 和 Cutout 的角色。
- 没有“Clean Plate 准备完成后才允许隐藏 L0”的状态机。
- Clean Plate 生成失败时没有完整的 UI 恢复和错误状态。
- 运动后透明洞和原位置残影没有成为可见的验收结果。

## 3. 阶段 A：固定数据模型和图层角色

> 状态：已完成。已接入兼容归一化、source/clean-plate/cutout track role、item/track 引用校验和阶段 A 数据测试。

### A-1 扩展 `ComicEditLayer`

文件：

- `src/editor/comic/manual-layer-types.ts`
- `src/editor/compose/schemas.ts`
- `src/editor/state/types.ts`

在现有字段基础上增加或明确：

```ts
type CleanPlateStatus = 'missing' | 'processing' | 'ready' | 'failed';

type ComicEditLayer = {
  id: string;
  name: string;
  semantic: ComicLayerSemantic;

  sourceAssetId: string;
  sourceItemId?: string;
  sourceTrackId?: string;

  maskAssetId?: string;
  cutoutAssetId?: string;
  cleanPlateAssetId?: string;

  cutoutItemId?: string;
  cutoutTrackId?: string;
  cleanPlateItemId?: string;
  cleanPlateTrackId?: string;

  cleanPlateStatus: CleanPlateStatus;
  finalCompositionReady: boolean;

  sourceCanvas: {width: number; height: number};
  bounds: LayerBounds;
  polygon?: ManualLayerPoint[];
  anchor?: LayerAnchor;

  visible: boolean;
  locked: boolean;
  opacity: number;
  zIndex: number;
};
```

兼容规则：

- 旧工程没有新增字段时，`cleanPlateStatus` 默认为 `missing`。
- `finalCompositionReady` 默认根据 `cleanPlateAssetId` 和 track 是否存在推导。
- 不能删除旧的 `sourceAssetId`。
- 不把图片二进制写入工程 JSON。
- polygon、bounds 一律使用原图像素坐标。

### A-2 统一图层角色

新增明确的 role，推荐放在 `TrackType` 或漫画扩展字段中：

```ts
type ComicTrackRole =
  | 'source'
  | 'clean-plate'
  | 'cutout'
  | 'dialogue'
  | 'other';
```

至少可以可靠判断：

```text
source track       = L0 原图
clean-plate track  = 完整底图
cutout track       = 透明拆出层
```

不要再通过“某个 semantic 是 background”或“轨道数组位置”猜测是否为 L0。

### A-3 数据测试

文件：

- `src/editor/comic/manual-layer-types.test.ts`
- `src/editor/state/normalize-undoable-state.test.ts`

必须覆盖：

- 旧工程无新增字段时可以加载。
- source、mask、cutout、clean plate asset ID 可正确保存。
- bounds 超出 source canvas 时失败。
- clean plate 尺寸错误时失败。
- source track、clean plate track、cutout track ID 关系完整。
- L0 asset 不能被清理逻辑误删。

## 4. 阶段 B：修正手动描点拆层流程

### B-1 生成 Cutout 时建立“待补图”状态

文件：

- `src/editor/canvas/manual-layer-tool.tsx`
- `src/editor/canvas/pen-tool.tsx`
- `src/editor/state/actions/add-manual-layer.ts`

当前流程：

```text
描点
→ 生成 mask
→ 生成 cutout
→ 新增 cutout track
```

应改为：

```text
描点
→ 生成 mask
→ 生成 cutout
→ 保存 source/cutout/mask 关系
→ cleanPlateStatus = missing
→ 显示“需要生成 Clean Plate”
```

这一步可以暂时保持 L0 显示，但必须明确标记为“未完成最终合成”，不能把它当作最终画面。

### B-2 Cutout 初始位置

文件：

- `src/editor/state/actions/add-manual-layer.ts`
- `src/editor/state/actions/add-manual-layer.test.ts`

必须保证：

```text
cutout.bounds = 原图中的紧边界
cutout.left = sourceItem.left + bounds.x / sourceWidth * sourceItem.width
cutout.top = sourceItem.top + bounds.y / sourceHeight * sourceItem.height
```

验收：

- 原图尺寸为 `1000 x 2000` 时，任意 bounds 都能转换正确。
- Canvas 缩放和平移不影响保存的原图坐标。
- cutout 放回原始位置后与 source 对应区域重合，误差不超过 `1 px`。

### B-3 重做 polygon 时清理旧派生层

必须一起清理：

- 旧 mask asset。
- 旧 cutout asset。
- 旧 clean plate asset。
- 旧 cutout item。
- 旧 clean plate item。
- 旧派生 tracks。

不能删除：

- 原始 source asset。
- L0 source item。
- L0 source track。

## 5. 阶段 C：正确创建 Clean Plate

### C-1 不要用“替换 source item”代替 Clean Plate

当前 `apply-clean-plate.ts` 的替换逻辑需要改造。

禁止最终采用：

```ts
sourceItem.assetId = cleanPlateAsset.id;
```

推荐逻辑：

```text
L0 source item:
    assetId = sourceAssetId
    role = source
    hidden in final = true

Clean Plate item:
    assetId = cleanPlateAssetId
    role = clean-plate
    hidden in final = false
```

原始 source item 必须继续存在，`Source` 模式才能稳定显示原图。

### C-2 新增 Clean Plate track

建议新增：

- `src/editor/state/actions/create-clean-plate-layer.ts`
- 或在 `apply-clean-plate.ts` 中拆出独立 action。

输入：

```ts
type CreateCleanPlateInput = {
  state: EditorState;
  layerId: string;
  cleanPlateAsset: ImageAsset;
};
```

处理：

1. 找到 `ComicEditLayer`。
2. 校验 clean plate 类型为 image。
3. 校验尺寸与 source canvas 完全一致。
4. 保留原始 L0 item 和 track。
5. 新增或更新 clean plate item。
6. 新增或更新 clean plate track。
7. 记录 `cleanPlateAssetId`、`cleanPlateItemId`、`cleanPlateTrackId`。
8. 设置 `cleanPlateStatus = ready`。
9. 设置 `finalCompositionReady = true`。
10. 只有这一步成功后，才把 L0 标记为 final hidden。

### C-3 Clean Plate 生成方式

第一版按以下顺序实现：

1. 纯色填充。
2. 克隆填充。
3. OpenCV 小区域 inpaint。
4. 外部 AI inpaint。

文件建议：

- `src/editor/comic/clean-plate-fill.ts`
- `src/editor/comic/clean-plate.ts`
- `src/editor/comic/clone-fill.ts`
- `app/api/compose/layers/inpaint/route.ts`

每种方式都必须输出：

```ts
{
  cleanPlateAsset: ImageAsset;
  diagnostics: {
    method: string;
    repairedPixelCount: number;
    confidence?: number;
    warnings: string[];
  };
}
```

### C-4 失败处理

失败时：

- `cleanPlateStatus = failed`。
- `finalCompositionReady = false`。
- L0 继续可见。
- 原始 source asset 不变。
- UI 显示错误和失败原因。
- 可以重新选择填图方式。

## 6. 阶段 D：统一 Normal、Source、Layers

> 状态：代码实现完成，已补齐角色化轨道规划、未完成 Clean Plate 警告和预览测试。

文件：

- `src/editor/canvas/quality-preview-core.ts`
- `src/editor/canvas/quality-preview.tsx`
- `src/editor/canvas/layers.tsx`
- `src/editor/canvas/quality-preview-controls.tsx`

### D-1 Normal

逻辑必须是：

```text
显示：
  clean-plate
  cutout
  body/head/foreground/effect/dialogue

隐藏：
  L0 source
```

如果某个拆层还没有 Clean Plate：

- 显示明确的“等待 Clean Plate”状态。
- 不应该把“原图 + Cutout”静默当作最终通过。
- 可以提供临时编辑预览，但要带 warning。

### D-2 Source

只显示：

```text
L0 source track
```

必须确保显示的是 `sourceAssetId`，不能显示已经被替换成 Clean Plate 的 item。

### D-3 Layers

显示：

```text
Clean Plate + Cutout
```

不显示：

```text
L0 source
```

用于检查图层遮挡、位置和动画关系。

### D-4 Overlay 和 Difference

对比对象固定为：

```text
左/底层：Normal
右/上层：L0 Source
```

不能把当前未完成的“原图 + Cutout”当作 Normal 参与差异计算。

### D-5 预览单元测试

文件：

- `src/editor/canvas/quality-preview.test.ts`

至少覆盖：

- 有 Clean Plate 时 Normal 不包含 L0。
- 没有 Clean Plate 时 Normal 标记为未完成或 warning。
- Source 只包含 L0。
- Layers 不包含 L0。
- Overlay 和 Difference 使用同一份 Normal 轨道计划。

## 7. 阶段 E：导入 LayerPackage 和手动流程统一

> 状态：代码实现完成，外部 LayerPackage 与手动图层均通过统一导入链路生成 source、clean-plate、cutout 轨道。

文件：

- `src/editor/comic/manual-layer-package.ts`
- `src/editor/comic/import-layers.ts`
- `src/editor/comic/types.ts`

统一两种入口：

```text
外部 LayerPackage 导入
手动描点生成
```

最终都必须产生相同的逻辑结构：

```text
L0 source
Clean Plate
Cutout layers
```

### E-1 LayerPackage 规则

当 package 中存在 Clean Plate：

- 导入 Clean Plate track。
- 隐藏 L0。
- 导入 Cutout。
- 设置 `finalCompositionReady = true`。

当 package 中不存在 Clean Plate：

- 保留 L0。
- 设置 warning。
- 不得声称最终动态漫画闭环完成。

### E-2 手动层转 LayerPackage

`buildManualLayerPackage()` 必须：

- 使用 source asset 作为 `sourceUrl`。
- 使用 clean plate asset 作为 `isCleanPlate: true` 的底图。
- 使用 cutout asset 作为普通图层。
- 保持 bounds、anchor、zIndex 和 semantic。
- Clean Plate 缺失时，在 diagnostics 中写入明确 warning。

## 8. 阶段 F：图层面板操作

> 状态：已完成。已补齐手动层的 Cutout 重生成、Clean Plate 重建入口、L0 恢复、派生层删除与资源清理，并修复派生层复制后的 item/track 引用。

文件建议：

- `src/editor/sidebar/comic-layer-panel.tsx`
- `src/editor/state/actions/layer-panel.ts`
- `src/editor/inspector/inspector-dock.tsx`

每一行图层至少显示：

- 缩略图。
- 图层名称。
- 角色：L0、Clean Plate、Cutout。
- semantic：hair、mouth、eye、body 等。
- 可见开关。
- 锁定开关。
- 当前是否准备好最终合成。

必须支持：

- 选择。
- 重命名。
- 显示/隐藏。
- 锁定/解锁。
- 上移/下移。
- 复制。
- 删除。
- 重新生成 Cutout。
- 重新生成 Clean Plate。
- 恢复 L0。

已实现入口：

- Cutout 行的刷新按钮会按原 polygon 重新生成 mask 和透明 Cutout，并使旧 Clean Plate 失效。
- Cutout/Clean Plate 行支持恢复 L0，恢复后重新显示 source track。
- 删除手动层时保留 L0 source item、source track 和 source asset，只清理派生 item、track、asset。
- 派生层复制后会重新绑定复制的 item/track，并将复制层标记为等待 Clean Plate。

锁定后的图层不能：

- 拖动。
- 缩放。
- 旋转。
- 删除。
- 通过普通 Canvas 交互修改。

所有操作必须接入现有 undo/redo。

## 9. 阶段 G：动画接入

> 状态：已完成。已接入 Cutout 运动、眼睛眨眼、嘴型切换、首帧对齐校验和 L0 动画保护。

### G-1 动画对象

动画只作用于 Cutout 或其他最终图层：

```text
hair cutout       → hair-sway
eye sprite        → blink
mouth sprites     → mouth-flap
body/head         → breathing、float、transform
shot              → camera motion
```

不允许对 L0 做最终动画，也不允许用 L0 作为运动后的底图。

### G-2 初始位置

每个 Cutout 在第 0 帧必须满足：

```text
cutout 的视觉位置 = 原图中对应内容的位置
```

之后再叠加：

- translate。
- scale。
- rotate。
- opacity。
- sprite state。
- easing。

### G-3 运动后检查

至少检查：

- 头发移动 `10 px`。
- 嘴巴切换 closed/half/open。
- 眼睛切换 open/closed。
- Cutout 缩放 `0.95` 和 `1.05`。
- Cutout 旋转少量角度。
- shot camera push/pull。

检查结果：

- 原位置没有残影。
- 原位置没有透明洞。
- 新位置没有明显黑边。
- 角色层级没有被破坏。

已实现入口：

- 属性面板的“运动”中可配置 `hair-sway`、呼吸、漂浮、关键帧、循环和镜头运动。
- 属性面板新增精灵动画区，可从工程图片资产中选择 open/closed/half 状态，应用 blink 或 mouth-flap。
- mouth-flap 自动读取当前分镜对白区间；没有对白时按钮保持禁用。
- `applyMotion()` 和 `applySpriteMotion()` 拒绝写入 `source` 角色轨道。
- 运动验收拒绝非 identity 首帧，并检查 Clean Plate 是否覆盖运动后的画布。

## 10. 阶段 H：质量检查和导出

文件：

- `src/editor/comic/quality-metrics.ts`
- `src/editor/comic/validate-motion-exposure.ts`
- `src/editor/canvas/quality-preview-core.ts`
- `src/editor/comic/export-package.ts`
- `src/editor/comic/delivery-manifest.ts`

质量指标至少包括：

```text
recompositionScore
alphaHoleRatio
edgeArtifactScore
sourceAlignmentError
cleanPlateCoverage
```

阻断条件建议：

- Clean Plate 缺失：不能标记最终合成完成。
- Clean Plate 尺寸错误：不能隐藏 L0。
- source alignment error 超过阈值：显示错误。
- alpha hole ratio 超过阈值：显示错误或 warning。
- 资源上传未完成：不能导出最终包。

导出包必须包含：

```text
project.json
manifest.json
source/L0 原图
clean-plate.png
mask.png
cutout/*.png
预览帧
动画配置
```

## 11. 推荐修改顺序

按以下顺序实施，不要先做高级 Photoshop 功能：

### 第 1 步：修正数据和 role

- [x] 明确 source、clean-plate、cutout 三类 track role。
- [x] 扩展 `ComicEditLayer` 的状态和 item/track 引用。
- [x] 增加旧工程兼容。
- [x] 增加数据单元测试。

### 第 2 步：修正手动描点结果

- [x] 保留 L0 source item/track。
- [x] 生成 mask 和 cutout。
- [x] cutout 放回原图位置。
- [x] 标记 `cleanPlateStatus = missing`。
- [x] 不把未完成状态当作最终画面。

### 第 3 步：完成 Clean Plate

- [x] 新增纯色填充。
- [x] 新增克隆填充。
- [x] 保留 AI/OpenCV API 入口。
- [x] 创建独立 Clean Plate item/track。
- [x] Clean Plate 通过后才隐藏 L0。
- [x] 失败时保持 L0 可见。

阶段 B、C 已落地的入口：

- `src/editor/state/actions/add-manual-layer.ts` 保留 L0，只新增 Cutout，并将状态设为 `missing`。
- `src/editor/state/actions/apply-clean-plate.ts` 创建独立 Clean Plate item/track，不再替换 source item。
- `src/editor/comic/create-clean-plate-asset.ts` 使用 source + mask 生成本地 Clean Plate PNG。
- 图层面板的 Cutout 行提供“生成 Clean Plate/补图”入口。
- `src/editor/canvas/quality-preview-core.ts` 按显式 role 计算 Normal、Source、Layers，并在缺少 Clean Plate 时给出 warning。
- Clean Plate 失败会恢复 L0 可见，成功后才设置 `finalCompositionReady = true`。

### 第 4 步：修正三种预览

- [x] Normal = Clean Plate + Cutout。
- [x] Source = L0。
- [x] Layers = Clean Plate + Cutout，不含 L0。
- [x] Overlay/Difference 使用正确的两组结果。

### 第 5 步：接入动画和质量检查

- [x] hair-sway。
- [x] blink。
- [x] mouth-flap。
- [x] alpha hole。
- [x] recomposition difference。
- [x] 保存重载。
- [x] 导出和最终渲染。

### 第 6 步：再补高级能力

- [ ] 魔棒。
- [ ] 色彩范围。
- [ ] 钢笔曲线优化。
- [ ] 图层分组。
- [ ] 调整图层。
- [ ] 混合模式。
- [ ] PSD 导入导出。

## 12. 最小可交付版本

第一版不要以“按钮齐全”为完成标准，至少要完成：

```text
上传原图
→ L0 保留
→ 多边形描点
→ mask
→ cutout
→ Clean Plate
→ Clean Plate 独立 track
→ L0 隐藏
→ Normal 正确合成
→ Source 可恢复
→ Cutout 可移动
→ 原位置无残影
→ 保存重载
→ 导出和渲染
```

只有这条链路通过后，才继续扩展魔棒、色彩范围、钢笔、分组、调整图层和 PSD。

## 13. 最终验收表

### P0：必须通过

- [ ] 原图 L0 资产和 item/track 始终保留。
- [ ] 手动描点生成合法 polygon。
- [ ] mask 尺寸等于原图。
- [ ] cutout 为透明紧边界 PNG。
- [ ] cutout 初始位置与原图一致。
- [ ] Clean Plate 与原图同尺寸。
- [ ] Clean Plate 独立于 L0。
- [ ] Normal 不显示 L0。
- [ ] Source 只显示 L0。
- [ ] Layers 不显示 L0。
- [ ] Cutout 移动后原位置没有残影。
- [ ] Cutout 移动后没有透明洞。
- [ ] 保存和重新加载后关系不丢失。

### P1：质量通过

- [ ] 纯色填充可用。
- [ ] 克隆填充可用。
- [ ] AI/OpenCV inpaint 失败可恢复。
- [ ] Overlay/Difference 可定位问题。
- [ ] 头发可以摆动。
- [ ] 眼睛可以眨眼。
- [ ] 嘴巴可以切换口型。
- [ ] 首帧、中间帧、末帧通过像素或人工检查。

### P2：高级能力

- [ ] 魔棒进入同一套 mask/cutout/clean plate 流程。
- [ ] 色彩范围进入同一套流程。
- [ ] 钢笔路径进入同一套流程。
- [ ] 图层分组和调整图层真实影响画面。
- [ ] PSD 导入导出可用。

## 14. 一句话判断是否完成

```text
如果头发或嘴巴移动后，原位置仍然能看到原图内容，
说明只完成了 Cutout，还没有完成动态漫画拆层闭环。
```
