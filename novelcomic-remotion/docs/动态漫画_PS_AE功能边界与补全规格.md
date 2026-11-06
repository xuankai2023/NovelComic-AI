# 动态漫画编辑器：Photoshop / After Effects 功能边界与补全规格

> 版本：v1.0  
> 基线日期：2026-10-06  
> 适用工程：`novelcomic-remotion`  
> 文档性质：产品范围、真实状态审计、开发顺序与验收底线  
> 核心原则：只实现动态漫画生产必需的 Photoshop / After Effects 类能力，不建设通用修图软件或通用影视后期软件。

---

## 0. 一句话结论

当前工程不是“什么都没有”，而是已经具备素材、时间线、基础合成、拆层、蒙版、Clean Plate、关键帧、镜头运动、眨眼/口型、部分高级合成与渲染交付能力；但界面中同时存在纯视觉外壳、只写入数据但未形成完整工作流的半成品，以及已经在底层实现却没有统一入口的能力。

后续不得继续按“仿 PS / 仿 AE 全家桶”扩张。正确目标是：

`漫画原图 → 选区/蒙版 → 拆层 → 补底 → 图层组织 → 关键帧/局部变形 → 对白/声音 → 镜头与转场 → 质量检查 → 渲染交付`

---

## 1. 本文档的强制边界

### 1.1 纳入范围

只纳入能直接完成下列动态漫画任务的功能：

1. 从漫画页或分镜图提取可动画图层。
2. 保留原图 L0，生成可恢复、非破坏性的蒙版和 Cutout。
3. 清除被拆对象并生成 Clean Plate。
4. 管理背景、人物、头发、眼睛、嘴型、前景、特效等语义图层。
5. 制作平移、缩放、旋转、透明度、锚点和缓动关键帧。
6. 制作推拉摇移、景深感分层、视差和镜头转场。
7. 制作眨眼、口型、呼吸、漂浮、头发摆动、轻量骨骼和网格变形。
8. 制作对白字幕、气泡、旁白、配音、音量和淡入淡出。
9. 检查残影、透明洞、边缘、错位、越界、时长和缺失资产。
10. 预览、保存、导入导出、批次渲染和交付验证。

### 1.2 明确排除

以下功能即使 Photoshop 或 After Effects 官方具备，也不进入本产品范围，除非未来出现明确的动态漫画生产案例并单独立项：

- Photoshop 通用修图：RAW 冲印、摄影降噪、皮肤精修、HDR、全套滤镜库、通道计算、印刷色管理、CMYK 分色、3D、神经滤镜全集、通用绘画工作室。
- Photoshop 通用设计：画板系统、网页切图、包装设计、复杂矢量排版、智能对象完整兼容、PSD 全特性编辑器。
- After Effects 通用影视后期：真实 3D 摄像机、灯光、阴影、Cinema 4D、粒子系统全集、绿幕键控全集、摄像机反求、稳定器、视频 Roto Brush、视频物体跟踪、专业调色、VR、第三方插件宿主。
- After Effects 高风险自动化：任意 JavaScript 表达式、脚本执行、插件执行、用户代码执行。
- 专业音频工作站：多轨混音台、EQ/压缩器全集、降噪母带、VST 插件。
- 与动态漫画无关的社交、协作、云盘、审阅、版权管理和素材商城。

### 1.3 禁止“假完成”

一个功能只有同时满足以下条件，才允许标记为“已完成”：

1. **入口真实**：按钮、菜单或快捷键可触发明确行为。
2. **状态真实**：结果进入工程状态，刷新或重新打开后不丢失。
3. **预览真实**：播放器当前帧能看到正确结果。
4. **渲染真实**：Remotion 最终渲染与编辑器预览语义一致。
5. **撤销真实**：写操作进入 Undo/Redo，异步上传失败不会留下脏引用。
6. **错误真实**：非法输入有可理解的错误，不静默失败，不用假数据兜底。
7. **测试真实**：至少有领域测试；关键画面能力还要有固定样例或像素级验收。

仅有 UI、仅有 TypeScript 类型、仅能写 JSON、仅在测试 fixture 中存在、仅在文档中描述，均不得算“已完成”。

---

## 2. Adobe 官方概念与本产品映射

本产品参考 Adobe 的行为语义，不追求 1:1 复制界面，也不宣称 PSD/AEP 全兼容。

| Adobe 官方概念 | 官方语义摘要 | 动态漫画中的对应实现 |
| --- | --- | --- |
| Photoshop 图层蒙版 | 白色显示、黑色隐藏、灰色半透明，非破坏性隐藏图层内容 | Cutout 蒙版、边缘修正、画笔增减蒙版 |
| Photoshop 选区 / 色彩范围 | 从像素或颜色范围建立选区，可增减、羽化、转蒙版 | 魔棒、色彩范围、选区增减、羽化、蒙版生成 |
| Photoshop 钢笔 / 矢量蒙版 | 用路径获得精确、可编辑边界 | 人物、头发、前景等硬边或可控边缘拆层 |
| Photoshop Content-Aware Fill | 根据周围像素填充被移除区域 | 从拆层区域生成 Clean Plate；不用于通用修图 |
| After Effects 图层变换 | Position、Scale、Rotation、Opacity、Anchor Point 可随时间变化 | 图层关键帧和镜头关键帧 |
| After Effects Graph Editor | 编辑值曲线或速度曲线及关键帧插值 | 动态漫画所需的简化值曲线、速度曲线、缓入缓出 |
| After Effects Mask | 每层可有一个或多个可动画蒙版 | 静态/动画蒙版、羽化、扩张、反相、Add/Subtract |
| After Effects Track Matte | 使用另一图层的 Alpha 或 Luma 控制目标图层可见性 | Alpha/Luma Matte，用于光效、遮挡和局部特效 |
| After Effects Parenting | 子层继承父层变换 | 头/眼/嘴、身体/手臂、镜头控制器等层级关系 |
| After Effects Pre-compose | 多层进入子合成，并在父合成中作为单层使用 | 角色组、镜头组、特效组的嵌套合成 |
| After Effects Puppet | 通过 pin 和网格让静态图自然变形 | 轻量骨骼 + 网格变形；只做漫画角色局部动作 |
| After Effects Motion Blur | 图层和合成双开关控制运动模糊 | 快速镜头或肢体运动的受控采样模糊 |

官方参考链接见文末“官方依据”。

---

## 3. 当前界面逐项真假审计

### 3.1 截图中的顶部区域

| 界面入口 | 当前判断 | 代码证据 | 处理决定 |
| --- | --- | --- | --- |
| 文件 / 编辑 / 合成 / 图层 / 效果 / 动画 / 视图 / 窗口 / 帮助 | **假入口** | `src/editor/editor.tsx` 的 `AeChrome` 只循环渲染 button，没有命令、菜单状态或 onClick | P0 移除不可用项或接入动态漫画命令菜单；禁止继续展示空菜单 |
| 标准 / 动画 / 效果 / 颜色 / 音频工作区 | **假入口** | 同文件只渲染静态按钮，只有“标准”写死 active | 改为“拆层 / 动画 / 对白音频 / 质检交付”四个真实工作区；不做 AE 全工作区克隆 |
| 工作区切换 / 帮助 / 更多 | **假入口** | 只有 title 和图标，没有行为 | 无真实内容前隐藏 |
| 主合成标题 | **展示项** | 固定字符串 | 接工程/合成名称；允许重命名 |

### 3.2 截图中的左侧素材区

| 入口 | 当前判断 | 已有能力 | 必须补齐 |
| --- | --- | --- | --- |
| Select | **可用** | 选择、画布变换、时间线选择 | 明确多选、锁定层、父子层选择优先级 |
| Upload | **可用** | 上传素材并进入资产库 | 上传失败重试、重复素材提示、格式/尺寸限制可见化 |
| Assets | **可用** | 图片/视频/音频/GIF/字幕资产展示，拖入或加入时间线，删除 | 动态漫画语义筛选：原图、Clean Plate、角色层、嘴型、眼睛、音频 |
| Properties | **可用** | 图像、视频、音频、文字、纯色检查器 | 将动态漫画关键属性集中，不要让用户在通用检查器中寻找 |
| Text | **可用** | 创建文字、字体、对齐、描边、背景等 | 增加对白气泡/旁白条预设和安全区，不扩展成完整排版软件 |
| Solid | **可用** | 创建纯色层 | 限定用途：遮罩、底色、闪白、暗角、气氛色、Track Matte |

### 3.3 截图中的右侧工具坞

| 入口 | 当前判断 | 代码证据 | 产品归属 |
| --- | --- | --- | --- |
| 手动描点/Trace | **部分闭环** | `manual-layer-tool.tsx`、feature flag | 拆层 |
| 魔棒 | **可用但只到蒙版** | `pixel-selection-tool.tsx`，生成 mask 并写入图片 item | 拆层；需接选区预览、增减选区、Cutout/Clean Plate 提交 |
| 色彩范围 | **可用但只到蒙版** | 同上，全图颜色匹配 | 拆层；需接吸管增减采样与边缘净化 |
| 钢笔 | **部分闭环** | `pen-tool.tsx` 可生成 mask + cutout + 元数据 | 拆层；需接 Clean Plate 与统一提交事务 |
| 图层面板 | **Beta/部分闭环** | `src/editor/layer-panel/` 有文档视口、画笔、mask history、commit | 拆层；需验证大图、缩放、画笔与最终状态一致 |
| 高级合成 | **真实但产品入口过重** | `advanced-composition-panel.tsx`、`composition/*`、`AdvancedLayers` | 只保留父子、预合成、蒙版、Matte、必要混合模式和安全表达式预设 |
| 外部导入 | **可用/受限** | `external-import-panel.tsx`、AE/PSD 交换包测试 | 只支持交换包；不得声称直接完整解析 AEP/PSD |
| AI 流程 | **依赖外部服务的条件功能** | `ai-pipeline-panel.tsx`、分层与补底 API | 未配置服务时必须明确显示“未配置”，不得伪造进度或结果 |
| 声线配置 | **可用/依赖供应商** | `voice-profile-panel.tsx`、voice profile 领域逻辑 | 对白音频；只管理动态漫画角色声线 |

### 3.4 截图中的时间线头部

| 入口 | 当前判断 | 处理决定 |
| --- | --- | --- |
| 搜索图层和属性 | **假入口**：输入框未连接过滤逻辑 | P0 接真实图层/属性过滤，或在完成前隐藏 |
| 图层关系 | **假入口** | 接父子关系列和 Pick Whip 后再显示 |
| 图层开关 | **假入口** | 接显隐、锁定、Solo、音频开关列后再显示 |
| 图表编辑器按钮 | **假入口但底层另有真组件** | 顶部按钮需打开现有 `GraphEditor`；不能与检查器中的曲线编辑器形成两个状态源 |
| 时间轴菜单 | **假入口** | 只保留动态漫画命令：拆分、复制、预合成、关键帧、对齐镜头、删除 |

---

## 4. 当前真实能力总表

状态定义：

- **A 已闭环**：界面/数据/预览/渲染基本贯通。
- **B 半闭环**：核心实现存在，但入口、事务、渲染一致性或验收有缺口。
- **C 底层存在**：有类型、算法或 API，普通用户难以完成完整任务。
- **D 假入口**：只有界面或静态按钮。
- **E 未实现**：工程中没有可靠实现。

| 模块 | 功能 | 状态 | 当前代码位置 | 结论 |
| --- | --- | --- | --- | --- |
| 素材 | 上传、资产库、拖入时间线 | A | `assets/*`、`editor-sidebar.tsx` | 保留 |
| 素材 | 图片/视频/音频/GIF/字幕 | A | `items/*` | 视频仅作辅助素材，不扩展视频剪辑全功能 |
| 项目 | 多轨时间线、裁切、移动、吸附、播放 | A | `timeline/*` | 保留 |
| 项目 | Shot 分镜数据、增删改、时长重排 | B | `comic/upsert-shot.ts` 等 | 缺统一分镜 UI 和镜头级操作闭环 |
| 拆层 | 手动多边形描点 | B | `manual-layer-tool.tsx` | 可生成 Cutout，需统一补底提交 |
| 拆层 | 钢笔路径 | B | `pen-tool.tsx` | 当前更接近折线路径；需明确曲线控制柄产品要求 |
| 拆层 | 魔棒连通选区 | B | `advanced/pixel-selection.ts`、`pixel-selection-tool.tsx` | 缺选区编辑与拆层提交 |
| 拆层 | 色彩范围 | B | 同上 | 缺多采样、Fuzziness 语义和结果预览 |
| 拆层 | 蒙版画笔编辑、历史 | B | `layer-panel/*` | 需大图性能、撤销和提交一致性验收 |
| 拆层 | mask 栅格化、羽化、扩张、反相 | A/C | `comic/rasterize-mask.ts` | 算法存在，需统一 UI 暴露 |
| 拆层 | Cutout PNG 与原图 bounds | A | `create-cutout-asset.ts` | 保留 |
| 补底 | 纯色、克隆、本地修补 | B | `clean-plate-fill.ts` | 应成为离线兜底 |
| 补底 | 外部 AI inpaint | B | `clean-plate.ts`、API routes | 依赖服务；必须有失败回退 |
| 补底 | L0 / Clean Plate / Cutout 分离 | B | `manual-layer-types.ts`、导入逻辑 | 历史手动路径仍需统一事务 |
| 质检 | Normal/Source/Layers/Overlay/Difference/Mask/Alpha/Holes | B | `quality-preview*` | 语义已有；需保证所有拆层来源一致 |
| 质检 | 重组分数、透明洞、边缘指标 | B/C | `quality-metrics.ts` | 接 UI 阻断与报告 |
| 动画 | X/Y、Scale、Rotation、Opacity、Anchor | A | `motion/types.ts`、`evaluate.ts` | 核心保留 |
| 动画 | Linear/Ease/贝塞尔手柄 | A/B | `easing.ts`、`curve.ts`、GraphEditor | 顶部入口是假，检查器入口是真；需统一 |
| 动画 | 循环 repeat / ping-pong | A | `motion/types.ts`、`evaluate.ts` | 保留 |
| 动画 | 呼吸、漂浮、头发摆动预设 | A | `motion/presets.ts` | 保留并产品化 |
| 动画 | 眨眼 Sprite | A | `build-sprite-motion.ts` | 保留 |
| 动画 | 三态口型与音素 cue | A/B | `build-sprite-motion.ts` | 有音素 cue 支持；自动对齐入口需统一 |
| 动画 | 骨骼层级 | B | `advanced/bone-rig.ts`、motion inspector | 只支持动态漫画轻量骨骼 |
| 动画 | 网格变形 | B | `mesh-warp-image.tsx`、motion types | 需画布编辑网格与边界保护 |
| 合成 | 父子级 | B | `composition/advanced-actions.ts`、frame evaluation | 需要时间线直接操作和渲染回归 |
| 合成 | 预合成/嵌套/扁平化 | B | `composition/precompose.ts`、`advanced-layers.tsx` | 只服务角色组、镜头组、特效组 |
| 合成 | 图层蒙版 | B | `composition/types.ts`、`advanced-layer-style.ts` | CSS 快路径只支持单个 add polygon；复杂模式需统一栅格渲染 |
| 合成 | Alpha/Luma Track Matte | B | `masks/track-matte.ts`、advanced renderer | 需要资源/层语义和导出验证 |
| 合成 | 混合模式 | B | image/advanced blend modes | 只开放动态漫画白名单 |
| 合成 | 安全表达式 | C/B | `advanced/expressions.ts` | 不做 AE JavaScript；只保留受限预设和安全 AST |
| 镜头 | 推、拉、左摇、右摇 | A | camera motion presets | 保留 |
| 镜头 | 焦点 X/Y、二维虚拟摄像机 | A/B | shot camera motion | 命名必须写“2D 镜头”，不能冒充 AE 3D Camera |
| 镜头 | 多层视差 | C/B | 可由父子/层级/关键帧组合 | 需要专用 UI 和预设 |
| 镜头 | 真实 3D 摄像机/灯光/景深 | E 且排除 | 无 | 不做 |
| 效果 | 图片模糊、暗化、基础透明度 | A/B | image fit/style | 保留作为镜头辅助 |
| 效果 | 通用 AE 效果库 | E 且排除 | 无 | 不做 |
| 效果 | 运动模糊 | E | 无稳定帧采样实现 | 动态漫画需要，列为 P1 |
| 对白 | 文字、字幕、样式 | A | text/captions inspector | 增加气泡/旁白预设 |
| 音频 | 音频轨、音量、淡入淡出、配音 | A/B | audio item/inspector、voice routes | 保留；缺角色/对白工作流整合 |
| 输出 | 本地/Lambda 渲染、批次规划 | A | `rendering/*`、`comic/plan-batches.ts` | 保留 |
| 输出 | 交付包、manifest、checksum 验证 | A | `export-package.ts`、`verify-package.ts` | 保留 |
| 导入 | LayerPackage / 手动拆层包 | A/B | import/export package | 保留 |
| 导入 | PSD manifest 适配 | C/B | `advanced/psd-package.ts` | 只能宣称“受限图层清单交换” |
| 导入 | AEP / Live2D 原生工程 | E 且排除 | 当前为 convert-first | 不直接解析；要求先烘焙/转换 |

---

## 5. 必须补齐的动态漫画功能全集

以下列表是本产品的功能底线。未列入本节的 Adobe 功能默认不做。

### 5.1 P0：拆层闭环与真实界面

#### P0-1 统一选区模型

必须支持：

- 新建、替换、添加、减去、相交。
- 羽化、扩张/收缩、反相。
- 魔棒容差与连续区域开关。
- 色彩范围的主采样、加采样、减采样、Fuzziness。
- 选区遮罩叠加预览：红色 Overlay、黑白 Mask、透明 Alpha。
- 选区转图层蒙版、选区转 Cutout、选区用于 Clean Plate。

边界：

- 不做 Photoshop 所有选区命令。
- 不做面向摄影的“主体选择”产品体系；AI 自动分层统一进入 AI 拆层流程。

验收：

- 同一选区在画布、mask 资产、Cutout alpha 和最终渲染中边界一致。
- 选区操作可撤销；关闭工具再打开仍能读取当前工作结果。

#### P0-2 统一蒙版编辑器

必须支持：

- 黑/白画笔增减蒙版。
- 画笔大小、硬度、流量；橡皮擦等价于反向画笔，不建设通用绘画系统。
- 缩放、平移、适合窗口、100% 像素检查。
- 蒙版历史、撤销/重做、重置。
- 边缘净化最小集：羽化、对比度、边缘偏移、去除彩边开关。
- 提交前显示 bounds、alpha 覆盖率和边缘警告。

边界：

- 不做混色笔、纹理笔刷、艺术笔刷、压感绘画、笔刷商城。

#### P0-3 原子化拆层提交

一次“完成拆层”必须作为一个事务完成：

1. 保留 L0 source asset、item、track。
2. 写入 selection/mask 元数据。
3. 生成并保存 mask PNG。
4. 生成紧边界 Cutout PNG。
5. 保存 sourceCanvas、bounds、anchor、semantic。
6. 生成或更新 Clean Plate。
7. 新建/更新 clean-plate track 和 cutout track。
8. 只有 Clean Plate 通过检查后才能隐藏 L0。
9. Normal 预览切换为 Clean Plate + Cutout。
10. 整个操作一次 Undo 可回退，不留下孤儿资产。

#### P0-4 Clean Plate 工作区

必须支持：

- 快速模式：纯色、克隆、本地 inpaint。
- AI 模式：外部 inpaint 服务。
- 采样源控制：允许/禁止区域。
- 原图、结果、Overlay、Difference 对比。
- 失败时保留 L0，绝不自动用空图或原图冒充 Clean Plate。
- 多个拆层区域可累计补底，不覆盖已确认区域。

#### P0-5 图层面板

动态漫画图层必须显示：

- 缩略图、名称、语义、显隐、锁定、Solo。
- L0 / Clean Plate / Cutout / Matte / Effect / Dialogue 角色标签。
- 层级缩进、父级、预合成归属。
- 蒙版缩略图与链接状态。
- 资产丢失、补底未完成、越界等错误徽标。
- 拖拽排序必须同步渲染 z-order 和交付包顺序。

#### P0-6 删除所有假入口

在命令未实现之前：

- 不显示空的顶部菜单。
- 不显示不可切换的工作区。
- 不显示无行为的搜索、图层关系、图层开关、图表编辑器按钮。
- 不允许点击后只改变高亮、不改变工程状态。

可接受替代方案：按钮置灰并明确写“开发中”，但生产版本默认隐藏。

### 5.2 P1：AE 类动态漫画动画闭环

#### P1-1 属性级关键帧时间线

必须支持：

- 展开图层属性：位置、缩放、旋转、透明度、锚点。
- 每个属性独立秒表、添加/删除关键帧、上一帧/下一帧跳转。
- 多选关键帧、框选、复制粘贴、拖动时间、等距分布。
- Hold、Linear、Ease In、Ease Out、Ease In-Out。
- 自动关键帧默认关闭。
- 图层局部帧与全局帧转换必须明确。

当前底层已有 keyframe 和曲线采样，不得另建第二套动画数据结构。

#### P1-2 简化 Graph Editor

必须支持：

- 值曲线和速度曲线二选一。
- X、Y、Scale、Rotation、Opacity 属性筛选。
- 贝塞尔手柄拖动、断开/联动手柄、缓入缓出预设。
- 曲线编辑直接修改现有 `handleIn/handleOut/easing`。
- 顶部“图表编辑器”按钮和检查器 GraphEditor 打开同一个组件、同一个状态源。

边界：

- 不复制 AE 全部图表选项。
- 不做任意效果属性图表，先限定动态漫画变换属性。

#### P1-3 父子级和控制器

必须支持：

- 下拉选择父层和 Pick Whip。
- 设置父级时保持世界坐标。
- 防止自己为父、跨合成父级和循环依赖。
- 解除父级时保持当前世界姿态。
- 提供 Null/控制器，但只作为角色或镜头控制器，不做通用 AE Null 系统扩张。

推荐动态漫画层级：

`角色控制器 → 身体 → 头 → 眼睛/嘴巴/头发`

#### P1-4 预合成

必须支持：

- 将选中图层预合成为角色组、镜头组或特效组。
- 双击进入子合成、面包屑返回主合成。
- 子合成有独立时间线范围，但默认继承主工程 fps。
- 预合成层可整体变换、透明度、蒙版、Matte 和关键帧。
- 扁平化前给出不支持项说明，不得丢蒙版、Matte、表达式或尺寸信息。

#### P1-5 Track Matte 与混合模式白名单

Track Matte 必须支持：

- Alpha、Alpha Inverted、Luma、Luma Inverted。
- Matte 层可在时间线上明确识别；被用作 Matte 时默认不单独渲染。
- 防止自引用、循环和跨合成引用。

混合模式只开放：

- Normal
- Multiply
- Screen
- Overlay
- Add/Linear Dodge（若渲染后端可一致实现）
- Darken
- Lighten
- Difference（主要用于质检）

其余模式不进入首版 UI，即使底层枚举存在。

#### P1-6 2D 镜头与视差

必须支持：

- 推近、拉远、左/右/上/下摇移。
- 镜头关键帧、焦点位置、镜头持续时间和安全边界。
- 背景/中景/人物/前景的视差系数。
- 镜头运动不能露出 Clean Plate 之外的透明区域。
- 一键“适合画面”“填满画面”“聚焦角色”“聚焦对白”。

边界：

- 产品文案统一为“2D 镜头”或“虚拟镜头”，不叫“3D 摄像机”。

#### P1-7 角色局部动画

必须支持：

- 呼吸、漂浮、头发摆动、衣角摆动、轻微手臂摆动。
- 眨眼：随机种子、间隔范围、闭眼持续帧。
- 口型：闭/半开/全开；优先使用音素 cue，无 cue 时使用对白节奏规则。
- 动作预设应用后可展开为普通关键帧。
- 动作幅度必须有安全上限，避免漫画层穿帮。

#### P1-8 轻量 Puppet：骨骼与网格

必须支持：

- 根骨骼、子骨骼、父子关系、旋转与位置关键帧。
- 网格控制点、固定点、局部变形关键帧。
- 网格不得越出 Cutout 安全范围导致大面积空洞。
- 预设：头部轻摆、手臂轻摆、头发摆动、衣摆摆动。

边界：

- 不复制 AE Advanced Puppet 的全部 Pin 类型。
- 不做 Live2D 参数编辑器、物理系统和模型市场。

#### P1-9 运动模糊

必须支持：

- 合成总开关 + 图层开关。
- 基于变换关键帧的多采样；预览可降采样，最终渲染使用固定质量。
- 只对快速平移、旋转、缩放和网格/骨骼变形生效。
- 默认关闭，动态漫画预设按镜头选择开启。

边界：

- 不做 Pixel Motion Blur 视频分析。

### 5.3 P1：对白、声音与文字

#### P1-10 对白工作流

必须支持：

- 对白绑定 shot、角色、声线、字幕/气泡样式和时间范围。
- 文本修改后可选择仅更新文字、重新配音、重新生成口型。
- 同一角色复用 voice profile。
- 对白超出 shot 时阻止保存或提示自动延长镜头。

#### P1-11 气泡与旁白

必须支持：

- 对话气泡、思考气泡、旁白框、屏幕字幕四类预设。
- 自动换行、最大行数、内边距、描边、阴影、尾巴方向。
- 竖屏安全区和遮挡人物检查。
- 文字入场只做淡入、缩放、打字机、轻弹四类预设。

边界：

- 不建设完整字体设计软件或 AE Text Animator 全功能。

#### P1-12 音频最小集

必须支持：

- 音量、静音、淡入淡出、波形显示。
- 对白、旁白、BGM、音效四类音频角色。
- 自动 ducking：对白出现时压低 BGM。
- 峰值过载警告和缺失音频提示。

边界：

- 不做专业 EQ、压缩、混响、插件链。

### 5.4 P1：动态漫画特效白名单

只实现以下特效，不建立通用效果商城：

1. 高斯模糊：背景虚化、速度感。
2. 阴影：气泡、人物与前景分离。
3. 外发光：能量、魔法、强调线。
4. 色调/亮度/饱和度：镜头情绪统一，参数控制在简化范围。
5. 闪白/闪黑：打击、转场。
6. 震屏：冲击反馈，必须限制幅度和持续时间。
7. 速度线/集中线：漫画专用生成层。
8. 轻量粒子预设：灰尘、火星、雨、雪、花瓣；仅内置预设，不做粒子编辑器。
9. 暗角和氛围色叠加。
10. 镜头交叉淡化、推拉转场、遮挡切换。

所有特效必须能关键帧化强度或透明度，并进入最终渲染。

### 5.5 P2：自动化与批量生产

#### P2-1 自动拆层建议

- 自动识别背景、前景、身体、头、头发、眼睛、嘴和特效。
- 输出 confidence，低置信度必须进入人工蒙版工作区。
- AI 结果只是草稿，不得直接隐藏 L0 或覆盖人工结果。

#### P2-2 自动动作建议

- 根据语义给出默认动作，不自动提交。
- 头发 → sway；身体 → breathing；前景 → parallax；眼睛 → blink；嘴 → lip-sync。
- 用户确认后才写入 motion。

#### P2-3 批量质检与渲染

- 逐 shot 检查缺失资产、透明洞、越界、残影、口型缺帧、对白越界、音频过载。
- 错误阻断最终交付；警告允许用户签字放行。
- 批次渲染后校验文件、时长、分辨率、帧率、checksum 和 manifest。

---

## 6. 推荐的真实工作区

不要继续使用“标准 / 动画 / 效果 / 颜色 / 音频”这套空壳。改为四个与生产阶段一致的工作区：

### 6.1 拆层

- 左：素材、原图、语义列表。
- 中：高性能文档视口、选区和蒙版编辑。
- 右：选区/蒙版属性、Clean Plate、提交。
- 下：图层列表，不显示完整视频时间线。

### 6.2 动画

- 左：素材与动作预设。
- 中：合成预览。
- 右：属性、父子级、蒙版、Matte、骨骼/网格。
- 下：属性级关键帧时间线与 Graph Editor。

### 6.3 对白音频

- 左：对白列表、角色和声线。
- 中：画面与气泡安全区。
- 右：文字、气泡、口型、音量。
- 下：对白、配音、BGM、音效波形时间线。

### 6.4 质检交付

- 左：shot 检查清单。
- 中：Normal / Source / Overlay / Difference / Alpha / Holes。
- 右：问题、修复跳转、渲染设置。
- 下：批次与交付状态。

---

## 7. 数据模型边界

### 7.1 必须只有一个真相源

- 普通图片动画继续使用 `ImageItem.motion`。
- 高级图层层级、预合成、Matte 和安全表达式使用 `AdvancedProjectState`。
- 不允许同一属性同时由普通 item、advanced layer 和临时 UI state 三处独立控制。
- 若 advanced layer 接管 item 变换，必须定义覆盖顺序并在 UI 标明。

推荐顺序：

`基础 item 几何 → item motion → 父子/预合成变换 → shot 2D camera → quality preview override`

### 7.2 L0、Clean Plate、Cutout 不得混用

- L0 永远指原始图像备份。
- Clean Plate 永远是清除拆层对象后的完整画布。
- Cutout 永远是带 alpha 的可动画紧边界图层。
- 不允许把 source item 的 assetId 直接永久替换为 Clean Plate 来假装闭环。
- 无合格 Clean Plate 时，Normal 必须显式显示“Source fallback”，不得静默冒充最终结果。

### 7.3 外部格式声明

- PSD：支持“受限图层清单/交换包”，不是完整 PSD 编辑。
- AE：支持项目导出的受限交换包或烘焙媒体，不直接承诺 AEP 解析。
- Live2D：支持渲染后的图片/视频或自定义交换数据，不承诺模型编辑。
- 不支持项必须在导入前评估并列出，不允许导入后静默丢失。

---

## 8. 统一验收标准

### 8.1 功能验收

每项功能必须验证：

- 新建、编辑、删除。
- Undo/Redo。
- 保存、刷新、重新加载。
- 预览帧与最终渲染帧一致。
- 1080×1920、30fps 默认工程。
- 横图、竖图、超大图和透明图。
- 中文文件名、重复文件名、缺失远程 URL。
- 资产上传失败、AI 服务未配置、请求超时。

### 8.2 拆层验收

- Source 模式只显示 L0。
- Normal 模式在完成后只显示 Clean Plate + Cutout + 最终图层。
- Cutout 初始重组与 L0 高度一致。
- Cutout 移动后原位置无残影，背景无透明洞。
- Mask 外 alpha 为 0，bounds 与原图坐标一致。
- 低质量 Clean Plate 不得隐藏 L0。

### 8.3 动画验收

- 首、中、尾帧姿态正确。
- Linear 和 Ease 曲线可见差异。
- 贝塞尔手柄修改后预览和渲染一致。
- 父层变换不造成子层跳变。
- 预合成进出后时间与画面不漂移。
- 循环边界不跳帧。
- 镜头运动不暴露画布外空洞。

### 8.4 性能底线

- 拆层文档视口支持至少 8K 单图，不在主线程反复全尺寸复制像素。
- 画笔操作保持可交互；昂贵计算在 pointer up 或 worker 中完成。
- 时间线 500 shot、10,000 item 的上限不能因新面板全量重渲染而失效。
- 最终渲染必须确定性；随机眨眼、粒子和预设必须使用 seed。

### 8.5 不得遗留

- 空按钮、空菜单、点击无反馈。
- `#REF` 类断引用、孤儿资产、丢失 mask、循环父级。
- 预览有效但导出失效。
- 导出有效但重新加载丢状态。
- AI 失败后写入伪结果。
- 用原图叠 Cutout 冒充完成拆层。

---

## 9. 实施顺序

### 第一阶段：去假与拆层闭环

1. 隐藏或接通所有假入口。
2. 统一 selection/mask 工作状态。
3. 将魔棒、色彩范围、钢笔、手动描点接入同一个提交事务。
4. 完成 L0 + Clean Plate + Cutout 三层闭环。
5. 完成拆层质量预览和阻断规则。

### 第二阶段：动画 UI 闭环

1. 属性级关键帧时间线。
2. 统一 Graph Editor。
3. 父子级和控制器。
4. 预合成导航。
5. Track Matte 与混合模式白名单。
6. 2D 镜头与视差预设。

### 第三阶段：角色动作与对白

1. 眨眼/口型产品入口。
2. 骨骼和网格画布编辑。
3. 气泡/旁白工作流。
4. 对白、声线、音频、自动 ducking。
5. 运动模糊和动态漫画特效白名单。

### 第四阶段：自动化与交付

1. AI 分层人工确认。
2. 自动动作建议。
3. 批量质量扫描。
4. 批次渲染与交付报告。

---

## 10. Definition of Done

一个版本只有满足以下全部条件，才可对外称“动态漫画 PS/AE 功能已补齐”：

- 截图中所有可见按钮均有真实行为，或已从生产界面移除。
- 任意一张漫画图可在编辑器内完成选区、蒙版、Cutout、Clean Plate 和重组。
- 拆出的图层可完成关键帧、父子级、预合成、Matte、局部变形和 2D 镜头。
- 眼睛、嘴、头发和身体均有对应的动态漫画动作路径。
- 对白可绑定角色、声线、气泡、字幕和口型。
- 质量预览能发现残影、透明洞、错位和越界。
- 保存后重开工程，状态完整。
- 编辑器预览、预览帧、批次渲染和最终交付画面一致。
- 所有 P0/P1 功能有自动测试和至少一个真实漫画固定样例。
- 文档、UI 和代码对功能状态的描述一致，不再出现“文档说有、按钮点了没反应、渲染不生效”。

---

## 11. 官方依据

以下只作为行为语义参考，访问基线为 2026-10-06：

### Photoshop

- 图层蒙版：<https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/add-layer-masks.html>
- 蒙版与色彩范围：<https://helpx.adobe.com/photoshop/desktop/create-manage-layers/color-adjustment-fill-layers/use-layer-masks-to-target-adjustment-or-fill-layers.html>
- 矢量蒙版与钢笔：<https://helpx.adobe.com/photoshop/desktop/create-masks/layer-masks/mask-layers-with-vector-masks.html>
- Content-Aware Fill：<https://helpx.adobe.com/photoshop/desktop/repair-retouch/remove-objects-fill-space/remove-objects-with-content-aware-fill.html>

### After Effects

- 动画、关键帧、Graph Editor、表达式：<https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/animation-basics/animation-basics.html>
- 关键帧设置与选择：<https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/animation-keyframes/setting-selecting-deleting-keyframes.html>
- 蒙版：<https://helpx.adobe.com/after-effects/desktop/drawing-painting-and-paths/work-with-masks/create-masks.html>
- 预合成与嵌套：<https://helpx.adobe.com/after-effects/desktop/work-with-compositions/precomposing-and-nesting/precomposing-nesting-pre-rendering.html>
- Puppet：<https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/animate-with-puppet-tools/animating-puppet-tools.html>
- 运动模糊：<https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/assorted-animation-tools/assorted-animation-tools.html>

---

## 12. 最终产品边界

本项目最终应被描述为：

> 一个面向动态漫画的 2D 拆层、合成、角色轻动画、对白配音和批量渲染工具，采用 Photoshop 的非破坏性选区/蒙版/补底思想，以及 After Effects 的图层、关键帧、父子级、预合成和 Matte 思想。

不得描述为：

> 浏览器版 Photoshop、浏览器版 After Effects、完整 PSD 编辑器、完整 AEP 编辑器、Live2D 替代品或通用视频后期软件。

这条边界是后续评审、开发排期和功能取舍的最终依据。
