# 动态漫画 Photoshop 类能力说明

> 适用工程：`novelcomic-remotion`
> 文档目的：说明动态漫画拆层的正确合成逻辑、当前代码真实状态，以及后续优化时必须遵守的规则。
> 关联实施清单：[动态漫画PS功能实现清单.md](./动态漫画PS功能实现清单.md)
> 关联验收清单：[动态漫画PS完整闭环测试清单.md](./动态漫画PS完整闭环测试清单.md)

## 1. 先确定正确答案

动态漫画不能把“原图”和“拆出来的透明图层”一直叠在一起作为最终画面。

正确结构是：

```text
原图 L0 备份层
    ├── 保留完整原图
    ├── 用于回看、恢复、重新抠图
    └── 最终动画默认隐藏

Clean Plate 底图
    ├── 尺寸与原图一致
    ├── 清除头发、嘴巴、眼睛等已拆区域
    └── 负责填补拆层后留下的区域

Cutout 动态图层
    ├── 透明 PNG
    ├── 使用原图坐标保存初始位置
    └── 通过位移、缩放、旋转和关键帧动画
```

以头发为例：

```text
source.png
    ├── L0 Source：完整原图，只做备份
    ├── clean-plate.png：头发原位置已经被补回
    └── hair.png：透明头发图层，初始位置与原图一致
```

最终普通预览和渲染必须是：

```text
Clean Plate + Hair Cutout
```

不能是：

```text
原图 L0 + Hair Cutout
```

后者在头发移动后会在原位置留下头发残影。

## 2. 三种状态必须分开

### 2.1 L0 Source

L0 是原始素材的备份，不是最终底图。

要求：

- 原始 asset 永远保留。
- 原始像素不能被覆盖。
- `Source` 模式显示完整原图。
- 普通动画和最终渲染默认不显示 L0。
- 重新抠图、失败恢复和人工比对都依赖 L0。

### 2.2 Clean Plate

Clean Plate 是与原图同尺寸的完整底图。

要求：

- 必须使用完整 source canvas 尺寸。
- 已拆出的头发、嘴巴、眼睛等区域必须被清除并补回。
- 可以来自纯色填充、克隆填充、OpenCV inpaint 或 AI inpaint。
- 生成失败时不能隐藏或破坏 L0。
- 只有通过尺寸、像素和重组检查后，才能作为最终底图。

### 2.3 Cutout

Cutout 是从原图中抠出的透明图层。

要求：

- 选区外 alpha 为 `0`。
- 默认使用紧边界 PNG。
- `bounds` 必须记录紧边界在原图中的位置。
- 初始位置必须与原图中的内容完全重合。
- 后续运动只作用于 Cutout，不修改 source asset。

## 3. 预览模式的固定语义

质量预览必须统一为以下语义：

| 模式 | 应显示内容 | 用途 |
| --- | --- | --- |
| `Normal` | `Clean Plate + Cutout + 其他最终图层` | 普通编辑和最终画面 |
| `Source` | `L0 Source` | 查看完整原图、恢复和比对 |
| `Layers` | `Clean Plate` 和拆出的 Cutout，不显示 L0 | 检查拆层结构和遮挡关系 |
| `Overlay` | Normal 与 L0 半透明叠加 | 查看对齐误差 |
| `Difference` | Normal 与 L0 差异混合 | 查看残影、错位和边缘错误 |
| `Mask` | mask 资产 | 查看选区和蒙版边界 |
| `Alpha` | 透明棋盘格 | 查看透明区域 |
| `Holes` | 暴露区域和质量问题标记 | 检查运动后是否出现透明洞 |

特别注意：

- `Normal` 不能简单地显示所有未隐藏轨道。
- `Source` 不能依赖当前 source item 是否已经被替换成 Clean Plate。
- `Layers` 不能把 L0 当作普通图层继续显示。
- 预览模式应根据图层角色判断，而不是只根据轨道数组顺序判断。

## 4. 当前代码真实状态

### 4.1 已经具备

| 能力 | 当前代码 | 状态 |
| --- | --- | --- |
| 原图资产保存 | `src/editor/assets/`、`ImageAsset` | 已有 |
| 图片图层和时间线 | `ImageItem`、`TrackType` | 已有 |
| 多边形描点 | `src/editor/canvas/manual-layer-tool.tsx` | 已有 |
| 钢笔路径拆层 | `src/editor/canvas/pen-tool.tsx` | 已有 |
| mask 栅格化 | `src/editor/comic/rasterize-mask.ts` | 已有 |
| cutout PNG 生成 | `src/editor/comic/create-cutout-asset.ts` | 已有 |
| 原图坐标和 bounds | `ComicEditLayer` | 已有 |
| Clean Plate 数据字段 | `cleanPlateAssetId` | 已有 |
| Clean Plate 替换底图的底层函数 | `apply-clean-plate.ts` | 部分已有 |
| LayerPackage 导入带 Clean Plate | `src/editor/comic/import-layers.ts` | 已有 |
| 导入带 Clean Plate 后隐藏 L0 | `hideL0PanelTrack()` | 已有 |
| 动画和 sprite 基础 | `src/editor/motion/`、`src/editor/comic/` | 已有 |
| Overlay、Difference、Mask 等质量预览入口 | `quality-preview-core.ts` | 部分已有 |

### 4.2 当前没有形成闭环

| 缺口 | 影响 |
| --- | --- |
| 手动描点完成后只生成 mask 和 cutout | 手动拆层没有自动进入 Clean Plate 流程 |
| 手动拆层默认仍保留 L0 显示 | Cutout 移动后原位置出现残影 |
| `applyCleanPlateToState()` 把 source item 的 asset 替换成 Clean Plate | L0 的“备份层”和 Clean Plate 的“最终底图”没有彻底分离 |
| 手动拆层没有独立 Clean Plate track | 无法稳定实现 `Normal = Clean Plate + Cutout` |
| Quality preview 主要按 track 分类判断 | 手动图层和导入图层的模式语义可能不一致 |
| Clean Plate 生成入口没有完整串到描点 UI | 用户不能从描点结果直接完成底图修复 |
| Clean Plate 通过条件不够严格 | 可能在补图失败时提前隐藏 L0 |
| 运动后透明洞检查没有作为编辑阻断 | 移动、缩放后可能暴露空洞 |

因此当前代码的准确结论是：

```text
导入 LayerPackage 且包内包含 Clean Plate：
    基本可以走 L0 隐藏、Clean Plate 显示、Cutout 动画的路径。

编辑器内手动描点：
    已经可以生成 Cutout 并放回原位置，
    但还没有完成 Clean Plate、L0 隐藏和最终合成闭环。
```

## 5. 当前代码中容易误判的地方

### 5.1 `addManualLayerToState()` 不等于完成拆层闭环

当前函数主要完成：

```text
保留 source item
新增 cutout item
新增 cutout track
保存 polygon、bounds、maskAssetId、cutoutAssetId
```

它没有完成：

```text
生成 clean plate
创建 clean plate track
隐藏 L0
把 Normal 切换到 Clean Plate + Cutout
```

### 5.2 `applyCleanPlateToState()` 不能继续采用“替换 source item”语义

原图 L0 和 Clean Plate 必须是两个不同的显示角色。

推荐改成：

```text
L0 item:
    assetId = sourceAssetId
    track role = source
    final hidden = true

Clean Plate item:
    assetId = cleanPlateAssetId
    track role = clean-plate
    final visible = true
```

不要把 L0 item 直接改成 Clean Plate item。原始 source asset 即使仍保存在 asset store，也不能只靠 asset store 代替 L0 图层，因为 `Source` 模式和图层恢复需要一个明确的 L0 item/track。

### 5.3 有 Cutout 不代表可以隐藏 L0

只有满足以下条件才允许隐藏 L0：

- Clean Plate 资产存在。
- Clean Plate 尺寸与 source canvas 一致。
- Clean Plate 上传或本地资源可读取。
- Clean Plate 与 mask 的对应区域通过像素检查。
- Cutout bounds、初始位置和原图坐标通过对齐检查。
- 重组后的画面没有明显空洞、残影和错位。

## 6. 推荐的数据关系

建议将“资产、显示图层和编辑元数据”分开表达：

```ts
type ComicEditLayer = {
  id: string;
  name: string;
  semantic: ComicLayerSemantic;

  sourceAssetId: string;
  sourceItemId: string;
  sourceTrackId: string;

  maskAssetId?: string;
  cutoutAssetId?: string;
  cleanPlateAssetId?: string;

  cutoutItemId?: string;
  cutoutTrackId?: string;
  cleanPlateItemId?: string;
  cleanPlateTrackId?: string;

  cleanPlateStatus: 'missing' | 'processing' | 'ready' | 'failed';
  finalCompositionReady: boolean;

  sourceCanvas: {width: number; height: number};
  bounds: {x: number; y: number; width: number; height: number};
  polygon?: Array<{x: number; y: number}>;
  anchor?: {x: number; y: number};

  visible: boolean;
  locked: boolean;
  opacity: number;
  zIndex: number;
};
```

如果暂时不增加所有 ID 字段，至少要保证可以从 `ComicEditLayer`、items 和 tracks 反向找到：

```text
sourceAssetId → L0 item/track
cleanPlateAssetId → Clean Plate item/track
cutoutAssetId → Cutout item/track
```

## 7. 推荐最终渲染结构

一个 shot 的最终结构建议是：

```text
track:shot:L0-source          hidden=true
track:shot:clean-plate        hidden=false
track:shot:body               hidden=false
track:shot:head               hidden=false
track:shot:hair               hidden=false
track:shot:eye                hidden=false
track:shot:mouth              hidden=false
track:shot:foreground         hidden=false
track:shot:dialogue           hidden=false
```

渲染顺序要由 `zIndex` 和 track role 决定，不能假设“数组前后”永远代表视觉前后。

## 8. 动态漫画需要的 Photoshop 类能力

### P0：必须完成

- 原图 L0 备份、隐藏和恢复。
- 多边形描点、拖动、删除、闭合和撤销。
- mask 生成和透明 cutout 生成。
- cutout 初始位置与原图对齐。
- Clean Plate 生成、应用和失败恢复。
- Normal、Source、Layers 三种稳定预览模式。
- 图层显示/隐藏、锁定、重命名、排序、复制、删除。
- 保存和重载后保持资产关系。
- 运动后检查透明洞和原位置残影。

### P1：提升质量

- 羽化、扩展、收缩和边缘修复。
- 纯色填充和克隆填充。
- OpenCV 小区域补图。
- AI inpaint 服务接入。
- Overlay、Difference、Alpha 和质量报告。
- 头发摆动、眼睛切换、嘴型切换。
- 首帧、中间帧、末帧截图验收。

### P2：高级能力

- 魔棒。
- 色彩范围。
- 钢笔曲线。
- 图层分组和搜索。
- 调整图层。
- 混合模式。
- PSD 导入导出。
- 网格、骨骼和高级变形。

## 9. 最终验收结论

以下状态才能称为“动态漫画拆层完成”：

```text
原图 L0 仍然可以恢复
Clean Plate 已经补齐拆出区域
Cutout 初始位置与原图一致
Normal 显示 Clean Plate + Cutout
Source 显示完整 L0
Layers 不显示 L0
Cutout 移动后原位置没有残影
Cutout 移动后没有透明洞
保存重载后关系不丢失
最终渲染与编辑器预览一致
```

如果只有下面的结果：

```text
原图 + 透明 Cutout
```

只能称为“完成了复制选区到新图层”，不能称为“完成了动态漫画拆层”。
