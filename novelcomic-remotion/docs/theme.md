# 项目主题色梳理

## 目标

这份文档先不改代码，只梳理当前项目里已经存在的颜色，并按后续可做主题模块的方式重新归类。

当前项目的颜色大致分成 3 层：

1. 编辑器 UI 基础主题色
2. 业务内容默认色
3. Tailwind 工具类里的中性色和透明度层

### 白色主题参考（剪映 / CapCut 风格浅色壳）

下表与各节中的「白色主题参考」列，按常见浅色剪辑壳对齐：**工作区大面**偏冷灰 `#F2F3F5`、**顶栏与面板**纯白 `#FFFFFF`、**主文案**近黑 `#1D2129`、**次级文案** `#86909C`、**细分割线** `#E5E6EB`、**轨道槽**可略浅 `#F7F8FA`。强调色与当前项目一致保留 `#0b84f3`（与剪映类主按钮蓝同属高饱和蓝，无需强行替换）。**业务识别色、校验红、吸附洋红等**在浅色壳上一般保持色相不变；仅把「深色 UI 专用」的底、边、滚动条、tooltip 等反相为浅色语义。

## 1. 当前主色盘

### 1.1 编辑器基础深色底盘

这部分是当前最稳定、最适合最先抽成主题 token 的一组。

| 分组 | 当前值 | 白色主题参考 | 作用 |
| --- | --- | --- | --- |
| `bg.base` | `#28282e` | `#F2F3F5` | 编辑器主背景 |
| `bg.panel` | `#212126` | `#FFFFFF` | 面板、弹层、音视频预览深底 |
| `border.default` | `#000000` / `#000` | `#E5E6EB` | 深色边框 |
| `accent.primary` | `#0b84f3` | `#0b84f3` | 焦点、选中框、交互强调 |
| `scrollbar.track` | `rgba(255, 255, 255, 0.04)` | `rgba(0, 0, 0, 0.04)` | 滚动条轨道 |
| `scrollbar.thumb` | `rgba(255, 255, 255, 0.2)` | `rgba(0, 0, 0, 0.12)` | 滚动条滑块 |

来源：

- `src/editor/editor-starter.css`

### 1.2 业务内容默认色

这部分不是编辑器壳子的颜色，而是用户创建内容时会直接看到的默认色。

| 分组 | 当前值 | 白色主题参考 | 作用 |
| --- | --- | --- | --- |
| `content.text.default` | `#ffffff` | `#1D2129` | 新建文字默认填充色（浅底上主文案） |
| `content.text.stroke` | `#000000` | `#FFFFFF` | 新建文字默认描边（暗字配浅描边时可改用 `#F7F8FA`） |
| `content.text.background` | `#808080` | `#E5E6EB` | 文字背景默认色 |
| `content.solid.default` | `#ffffff` | `#FFFFFF` | 新建纯色块默认色 |
| `content.caption.text` | `white` | `#FFFFFF` | 字幕文字默认色（叠在画面上多为亮字；若整轨浅底预览可再议） |
| `content.caption.stroke` | `black` | `#1D2129` | 字幕描边默认色（浅壳下描边改深灰，与亮字搭配时仍可用黑） |
| `content.caption.highlight` | `#39E508` | `#39E508` | 字幕高亮色（浅色壳可保持，与深壳一致） |

来源：

- `src/editor/items/text/create-text-item.ts`
- `src/editor/state/actions/background.ts`
- `src/editor/canvas/solid-drawing-tool.tsx`
- `src/editor/captioning/caption-section.tsx`

### 1.3 素材类型识别色

这组颜色更像“业务标签色”或“轨道识别色”，适合单独做成 `item` / `track` 主题分组。

| 分组 | 当前值 | 白色主题参考 | 作用 |
| --- | --- | --- | --- |
| `item.image` | `#3A7A44` | `#3A7A44` | 图片、GIF 类型标识（浅色时间轴上一般同色即可） |
| `item.gif` | `#3A7A44` | `#3A7A44` | GIF 类型标识 |
| `item.text` | `#7A5DE8` | `#7A5DE8` | 文字类型标识 |
| `item.video` | `#347EBF` | `#347EBF` | 视频类型标识 |
| `item.audio` | `#347EBF` | `#347EBF` | 音频类型标识 |
| `item.captions` | `#347EBF` | `#347EBF` | 字幕类型标识 |
| `item.solid` | `#B04BCF` | `#B04BCF` | 纯色块类型标识 |

来源：

- `src/editor/constants.ts`

### 1.4 状态色 / 功能色

这组颜色表达的是“状态”或“功能反馈”，不建议和品牌主色混在一起。

| 分组 | 当前值 | 白色主题参考 | 作用 |
| --- | --- | --- | --- |
| `state.error` | `#ef4444` | `#ef4444` | 输入校验错误 |
| `state.error.soft` | `rgba(239, 68, 68, 0.1)` | `rgba(239, 68, 68, 0.08)` | 错误背景弱态 |
| `state.selection.soft` | `rgba(11, 132, 243, 0.1)` | `rgba(11, 132, 243, 0.12)` | 选区浅蓝蒙层（浅底上略提高不透明度） |
| `state.snap.guide` | `#FF00FF` | `#FF00FF` | 画布吸附参考线 |
| `state.waveform.clipping` | `#FF7F50` | `#FF7F50` | 波形削顶提示 |
| `state.preview.warm` | `#FF9843` | `#FF9843` | 时间轴预览暖色底 |
| `state.preview.captions` | `#FF7F50` | `#FF7F50` | 字幕预览暖色底 |
| `state.preview.overlay` | `rgba(100,100,100,0.4)` | `rgba(29, 33, 41, 0.06)` | 时间轴下层预览蒙层（浅壳用淡前景蒙层） |
| `state.tooltip.dark` | `black` / `rgba(0, 0, 0, 0.8)` | `rgba(29, 33, 41, 0.92)` | Tooltip / 曲线底（浅主题下为深灰浮层，字用反色） |
| `state.shadow.soft` | `rgba(0, 0, 0, 0.1)` | `rgba(0, 0, 0, 0.08)` | 滑块阴影（浅底略轻） |

来源：

- `src/editor/constants.ts`
- `src/editor/inspector/controls/caption-controls/caption-timestamp-input.tsx`
- `src/editor/marquee-selection.tsx`
- `src/editor/timeline/timeline-item/timeline-item-waveform/draw-peaks.ts`
- `src/editor/timeline/timeline-item/timeline-item-preview.tsx`
- `src/editor/timeline/timeline-underlay-previews.tsx`
- `src/editor/timeline/timeline-item/timeline-item-fade-control/fade-curve.tsx`
- `src/editor/slider.tsx`

## 2. 当前隐式中性色

项目里还有一批没有写成 HEX，而是通过 Tailwind 工具类直接散落在组件里的颜色。这些也应该纳入主题体系。

### 2.1 白色透明层

当前大量出现的透明白层（深色壳上＝亮字与亮分隔）。**白色主题参考**改为以 `#1D2129` 为基的暗透明层，作用等价：

- `white` → `#1D2129`
- `white/90` → `rgba(29, 33, 41, 0.9)`
- `white/75` → `rgba(29, 33, 41, 0.75)`
- `white/50` → `rgba(29, 33, 41, 0.5)`
- `white/40` → `rgba(29, 33, 41, 0.4)`
- `white/20` → `rgba(29, 33, 41, 0.2)`
- `white/10` → `rgba(29, 33, 41, 0.1)`
- `white/5` → `rgba(29, 33, 41, 0.05)`

（若某处语义是「纯填充白块」而非字色，白色主题参考仍为 `#FFFFFF`。）

这些实际承担的是：

- 主文字
- 次级文字
- hover 背景
- 分割线
- 轻边框
- 进度条底色
- 滚动和控件弱态

### 2.2 黑色透明层

当前出现的黑色层。**白色主题参考**：

- `black` → `#E5E6EB`（分割线、浅边框）或 `#86909C`（图标/次级，视语义二选一）
- `black/20` → `rgba(29, 33, 41, 0.12)`
- `rgba(0, 0, 0, 0.8)` → `rgba(255, 255, 255, 0.92)`（浅底浮层）或 `rgba(29, 33, 41, 0.92)`（仍要深色弹层时）
- `rgba(0, 0, 0, 0.1)` → `rgba(0, 0, 0, 0.06)`

这些主要承担：

- 深色边框
- 浮层底
- 描边
- 阴影
- 激活态底色

### 2.3 Tailwind 默认中性色

当前代码里直接使用了这些 Tailwind 色名。**白色主题参考**（语义对齐剪映式浅壳，可用自定义 token 收口）：

- `neutral-300` → `#86909C`（次级文案、弱化图标）
- `neutral-400` → `#C9CDD4`（更弱一级）
- `neutral-700` → `#E5E6EB`（浅壳上的 hover 边、分隔，原深灰边角色）
- `slate-400` → `#86909C`
- `blue-500` → `#0b84f3`（与项目主强调一致）
- `red-400` → `#ef4444`（与 `state.error` 对齐）

这说明目前项目的颜色体系还没有完全收口，仍然有一部分依赖 Tailwind 默认调色板。

## 3. 推荐的主题分层

如果后面要做“主题模块”，建议不要按页面拆，而是按语义拆。

### 3.1 基础层 `foundation`

负责最底层视觉基座。

```ts
foundation: {
  bgBase: string;
  bgPanel: string;
  borderDefault: string;
  accentPrimary: string;
  scrollbarTrack: string;
  scrollbarThumb: string;
}
```

**白色主题参考**：`bgBase` → `#F2F3F5`，`bgPanel` → `#FFFFFF`，`borderDefault` → `#E5E6EB`，`accentPrimary` → `#0b84f3`，`scrollbarTrack` → `rgba(0, 0, 0, 0.04)`，`scrollbarThumb` → `rgba(0, 0, 0, 0.12)`。

### 3.2 文本层 `text`

负责所有文本和透明白层。

```ts
text: {
  primary: string;
  secondary: string;
  muted: string;
  inverse: string;
}
```

建议第一版可先映射：

- `text.primary` -> `white`；**白色主题参考** → `#1D2129`
- `text.secondary` -> `neutral-300`；**白色主题参考** → `#86909C`
- `text.muted` -> `neutral-400`；**白色主题参考** → `#C9CDD4`

### 3.3 表面层 `surface`

负责 hover、active、overlay、弱分隔线这类“半透明表面”。

```ts
surface: {
  hover: string;
  active: string;
  subtle: string;
  separator: string;
  overlay: string;
}
```

建议第一版可先映射：

- `surface.hover` -> `white/5`；**白色主题参考** → `rgba(29, 33, 41, 0.05)`
- `surface.active` -> `white/10`；**白色主题参考** → `rgba(29, 33, 41, 0.08)`
- `surface.subtle` -> `white/20`；**白色主题参考** → `rgba(29, 33, 41, 0.12)`
- `surface.separator` -> `white/10`；**白色主题参考** → `#E5E6EB` 或 `rgba(29, 33, 41, 0.08)`
- `surface.overlay` -> `rgba(100,100,100,0.4)`；**白色主题参考** → `rgba(29, 33, 41, 0.06)`

### 3.4 状态层 `state`

负责校验、吸附、警告、错误。

```ts
state: {
  error: string;
  errorSoft: string;
  selectionSoft: string;
  snapGuide: string;
  warning: string;
}
```

建议第一版可先映射：

- `state.error` -> `#ef4444`；**白色主题参考** → `#ef4444`
- `state.errorSoft` -> `rgba(239, 68, 68, 0.1)`；**白色主题参考** → `rgba(239, 68, 68, 0.08)`
- `state.selectionSoft` -> `rgba(11, 132, 243, 0.1)`；**白色主题参考** → `rgba(11, 132, 243, 0.12)`
- `state.snapGuide` -> `#FF00FF`；**白色主题参考** → `#FF00FF`
- `state.warning` -> `#FF7F50`；**白色主题参考** → `#FF7F50`

### 3.5 业务层 `content`

负责用户创建内容时的默认颜色。

```ts
content: {
  textDefault: string;
  textStroke: string;
  textBackground: string;
  solidDefault: string;
  captionText: string;
  captionStroke: string;
  captionHighlight: string;
}
```

**白色主题参考**：与 §1.2 表一致——`textDefault` → `#1D2129`，`textStroke` → `#FFFFFF`，`textBackground` → `#E5E6EB`，`solidDefault` → `#FFFFFF`，`captionText` → `#FFFFFF`，`captionStroke` → `#1D2129`，`captionHighlight` → `#39E508`。

### 3.6 类型标识层 `item`

负责时间轴和素材类型识别。

```ts
item: {
  image: string;
  gif: string;
  text: string;
  video: string;
  audio: string;
  captions: string;
  solid: string;
}
```

**白色主题参考**：与 §1.3 表一致，各色相保持 `#3A7A44` / `#7A5DE8` / `#347EBF` / `#B04BCF`（浅色时间轴上通常无需改色相）。

## 4. 第一版建议收口后的色系

如果只做第一版主题模块，建议先收成下面这几组，不要一次把所有透明度和 Tailwind 工具类都铺开。每项后 **→** 为白色主题参考值。

### A. 基础深色主题

- `#28282e` → `#F2F3F5`
- `#212126` → `#FFFFFF`
- `#000000` → `#E5E6EB`
- `#0b84f3` → `#0b84f3`

### B. 文本和层级灰阶

- `white` → `#1D2129`
- `white/90` → `rgba(29, 33, 41, 0.9)`
- `white/75` → `rgba(29, 33, 41, 0.75)`
- `white/50` → `rgba(29, 33, 41, 0.5)`
- `white/20` → `rgba(29, 33, 41, 0.2)`
- `white/10` → `rgba(29, 33, 41, 0.1)`
- `white/5` → `rgba(29, 33, 41, 0.05)`
- `neutral-300` → `#86909C`
- `neutral-400` → `#C9CDD4`
- `neutral-700` → `#E5E6EB`

### C. 内容默认色

- `#ffffff`（新建文字填充）→ `#1D2129`
- `#ffffff`（新建纯色块）→ `#FFFFFF`
- `#000000`（描边）→ `#FFFFFF`（绕暗字）或 `#E5E6EB`（浅分割语义时）
- `#808080` → `#E5E6EB`
- `#39E508` → `#39E508`

### D. 业务识别色

- `#3A7A44` → `#3A7A44`
- `#7A5DE8` → `#7A5DE8`
- `#347EBF` → `#347EBF`
- `#B04BCF` → `#B04BCF`

### E. 状态反馈色

- `#ef4444` → `#ef4444`
- `#FF00FF` → `#FF00FF`
- `#FF7F50` → `#FF7F50`
- `#FF9843` → `#FF9843`

## 5. 当前主题化的主要问题

目前真正阻碍主题模块化的，不是颜色太多，而是颜色来源太分散：

- `editor-starter.css` 已经有一小部分 CSS 变量，但范围太小
- `constants.ts` 里有业务类型色
- 内容默认色分散在文字、字幕、纯色块逻辑中
- 很多组件直接写了 `white/5`、`neutral-300`、`black/20`
- 一部分颜色是 HEX，一部分是颜色名，一部分是 Tailwind 语义类

## 6. 下一步建议

下一步如果你要我继续做，我建议按这个顺序：

1. 先新建统一的 `theme` 配置文件，定义 `foundation/text/surface/state/content/item`
2. 先把 `editor-starter.css` 里的基础变量迁进去
3. 再替换掉 `constants.ts` 里的类型色和内容默认色
4. 最后清理散落在组件里的 `white/5`、`neutral-300`、`black/20`

这样改动风险最小，也最容易逐步验证。
