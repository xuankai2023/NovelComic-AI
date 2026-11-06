# Remotion 产品闭环与 AE 能力审计

审计日期：2026-10-06  
审计范围：`novelcomic-remotion/` 及其 Remotion 编辑器、Compose API、动态漫画生产脚本。  
本次只做评估文档，不修改 Remotion 代码。

## 结论

当前 Remotion **还没有形成完整产品闭环**，也不能按 AE 的标准称为完整视频编辑器。但它已经不是一个单纯的 Demo：它具备“动态漫画自动合成内核”，在输入素材、拆层包、配音服务、COS 和渲染后端都可用的前提下，可以稳定走完一条受约束的生产链路。

更准确的产品定位是：

> 面向动态漫画的 2D 时间线编辑器 + API 编排器 + Remotion 渲染交付流水线。

三个判断需要分开：

| 判断对象 | 当前结论 | 说明 |
| --- | --- | --- |
| 动态漫画成片能力 | **基本可用，但依赖外部条件** | 可导入 L0/拆层、对白/音频、2D motion，预览、批次渲染和交付 |
| 独立编辑器产品 | **未闭环** | 项目持久化、自动恢复、完整 motion UI、渲染任务生命周期和生产级错误恢复不足 |
| AE 替代品 | **不成立** | 只有 2D 图层、基础关键帧、部分高级合成数据，不具备 AE 的完整参数、效果、表达式、3D 和插件生态 |

仓库中的 README 已经给出相同方向的判断：项目更像“面向动态漫画的 Remotion 自动合成器”，不是 AE 替代品（`novelcomic-remotion/README.md:348-350`）。本审计进一步把“哪些功能存在”和“用户是否能独立完成生产闭环”拆开。

## 现有能力：哪些已经形成了可用链路

### 动态漫画生产链路

以下链路基本连通：

1. 创建工程，默认 `1080x1920 / 30fps`。
2. 创建和编辑 shot，维护 shot 与图层、对白的引用关系。
3. 导入 L0 原图或规范化 `LayerPackage` 拆层包。
4. 对 item 或 shot 写入 2D motion、镜头运动和 sprite 状态。
5. 写入对白、字幕和音频。
6. 做项目校验、单帧预览和批次规划。
7. 通过本地 Renderer 或 Remotion Lambda 提交 H.264 渲染。
8. 合并批次、生成 delivery manifest、checksum 和 ZIP 交付包。

对应 API 已覆盖 project、shot、layers、dialogue、motion、validate、preview、plan、render、merge、export 等环节（`novelcomic-remotion/README.md:323-346`）。动态漫画脚本还提供阶段快照和从指定阶段继续执行的能力（`novelcomic-remotion/README.md:386-431`）。

这意味着：对“上游已经完成识别、拆层和配音，Remotion 负责组装、运动和输出”的场景，当前系统已经具有较强的交付价值。

### 编辑器基础能力

通用编辑器基础设施较完整：多轨道、图片/视频/音频/文字/字幕/固态色/GIF、拖拽、裁切、扩展、rolling edit、吸附、复制粘贴、画布缩放、预览播放和基础 inspector 都已存在。相关开关在 `src/editor/flags.ts` 中大多开启，说明 Starter UI 不是空壳。

### 高级合成数据能力

代码中已经存在一套 Advanced composition 数据路径，包括：

- layer parent hierarchy；
- pre-compose / flatten；
- mask、track matte、blend mode；
- expression AST 的受限求值；
- subtitle、lip-sync、sprite 和部分 adjustment layer；
- external exchange package 的导入导出。

但这些能力主要集中在数据结构、求值器、API 和测试层，并不等于 AE 式完整 UI。尤其是普通 item motion 和 Advanced transform 仍是两套模型：`src/editor/motion/types.ts:19` 与 `src/editor/composition/types.ts:30`，求值也分散在 `src/editor/motion/evaluate.ts` 与 `src/editor/hierarchy/resolve-parent-transform.ts`。

## 产品闭环审计

“闭环”不是 API 数量够多，而是用户能够从打开工程到交付结果，并在中断、错误和重新打开后继续工作。按这个标准，当前状态如下：

| 环节 | 当前状态 | 是否闭环 | 关键证据与缺口 |
| --- | --- | --- | --- |
| 创建/打开工程 | 本地初始状态、URL 状态、localStorage 状态 | **部分** | 没有明确的项目列表、远端项目实体、权限和版本历史 |
| 素材导入 | 上传、远程素材、IndexedDB 缓存、URL 白名单 | **部分** | 资产缓存存在，但工程状态与资产存储不是一个可靠的项目存储层 |
| 时间线剪辑 | 基础剪辑和多媒体 item 可用 | **基本** | 可做通用 2D 时间线，但复杂层级与高级合成未完全产品化 |
| 动画编辑 | API 和数据结构较强，基础 property timeline 存在 | **部分** | motion 参数、曲线、路径、表达式没有形成统一可视化工作流 |
| 分镜编辑 | shot CRUD、引用校验、批次规划存在 | **部分** | README 明确指出缺少完整分镜管理面板（`README.md:90-93`） |
| 高级合成 | parent、pre-compose、mask/matte 有数据路径 | **部分** | 普通 item 与 Advanced layer 双模型；flatten 对变换、mask、matte 等有明确限制（`src/editor/composition/precompose.ts:216-230`） |
| 预览 | Player、单帧预览、质量预览存在 | **基本** | 预览和最终渲染的外部素材、字体、后端环境仍可能不一致 |
| 保存 | 手动 Save 写入 localStorage | **不闭环** | `src/editor/state/persistance.ts:7-50` 只有单 key、JSON 直写，没有原子保存、快照链和崩溃恢复 |
| 自动恢复 | 没有工程级 autosave/recovery | **不闭环** | IndexedDB 主要服务素材缓存，不是工程快照和命令日志 |
| Undo/Redo | 可用，但为完整状态快照 | **部分** | `src/editor/utils/undo-redo.tsx:5` 限制为 50 条；mask 又有独立 history，无法形成统一命令审计 |
| 渲染任务 | 本地/Lambda、进度查询、批次渲染 | **部分** | 依赖 COS、AWS/Lambda、Remotion site、ffmpeg；没有完整的取消、租约、断点重试和持久化任务状态 |
| 交付 | ZIP、manifest、checksum、批次合并 | **基本但有条件** | 合并依赖 ffmpeg/COS；缺失资源会进入 manifest，但不代表一定能生成可播放最终文件 |
| 错误与降级 | 校验、diagnostics、部分 fallback | **部分** | 降级路径存在，但没有统一的用户级错误恢复和工程回放协议 |
| 协作与权限 | 不在 Remotion 内核中 | **未闭环** | 没有工程级锁、协作游标、冲突解决、权限和审计入口 |

### 最关键的闭环断点

#### 1. 工程保存不是工程恢复

现在的保存是 `localStorage.setItem(key, JSON.stringify(state))`。它能满足“开发者在同一浏览器手动保存和加载”，不能满足：

- 浏览器崩溃后恢复最近一次编辑；
- 保存过程中断电或标签页被关闭时不损坏正式工程；
- 多个工程并存和版本回退；
- 工程状态、素材引用、渲染任务的一致性恢复。

#### 2. Undo/Redo 还是快照，不是编辑器内核

当前历史栈保存完整 `UndoableState`，最多 50 条（`src/editor/utils/undo-redo.tsx:5-45`）。这对小工程足够，对连续拖拽、蒙版笔刷、AI 批量编辑和协作都不够：内存占用大、无法合并语义操作、无法把操作写入日志，也无法在崩溃后回放。

#### 3. 动画参数还没有统一成一个模型

普通图片 motion 和 Advanced transform 各自定义 keyframe、默认值和求值流程。结果是：

- 同一个“位置/缩放/透明度”概念存在两套 schema；
- inspector、AI、Compose API 不能自然共享同一套参数定义；
- 表达式、参数链接、曲线编辑难以一次性覆盖所有属性；
- 后续做精确缓存时很难按属性定位失效范围。

#### 4. 渲染链路能运行，但不是完整任务系统

`submitRender()` 会选择 local 或 Lambda backend（`src/editor/rendering/submit-render.ts:56-68`），本地渲染完成后还要上传 COS（`src/editor/rendering/render-media-local.ts:83-103`）。这属于“提交渲染并得到结果”的链路，不等于生产任务系统。当前还缺：

- 持久化 render job 和 worker 租约；
- 取消后端任务并释放资源；
- 失败后的幂等重试和断点续渲染；
- 渲染版本、输入快照、输出文件之间的可追溯关系；
- 本地预览、Lambda、最终交付之间的确定性一致性验证。

## 按 AE 标准的差距

| AE 能力域 | Remotion 当前能力 | 判断 |
| --- | --- | --- |
| 图层、时间线、基础 2D transform | 完整度较高 | 可用于动态漫画 |
| 关键帧与缓动 | 支持有限字段和四种 easing | 可用，但不是 Graph Editor 级别 |
| 统一参数/Knob | 普通 motion 与 Advanced transform 分裂 | P0 缺口 |
| 父子层级 | Advanced layer 支持 parent，普通 item 路径未统一 | 部分 |
| Pre-compose | 有创建、求值、flatten 数据路径 | 部分；公开参数、模板和版本化不足 |
| Mask / Track Matte / Blend | Advanced 数据路径和校验存在 | 部分；UI、组合规则和渲染覆盖不足 |
| Shape Layer | 未形成产品能力 | 缺失 |
| Effects | 有有限 adjustment CSS filter | 远低于 AE 效果体系 |
| Expressions | 有受限 AST 求值 | 不是 AE 表达式兼容层 |
| Graph Editor / motion path | 未完成产品化 | 缺失 |
| 3D layer / camera / light / depth | 未实现 | 缺失 |
| Puppet / mesh warp / roto | 有部分 mesh/pen 数据，但非完整变形和跟踪系统 | 缺失或实验性 |
| PSD / AEP / AE plugin ABI | 只有自定义 exchange package 和告警式降级 | 不可视为原生兼容 |
| 音频剪辑 | 有音频 item、波形、淡入淡出、播放速率 | 基础可用 |
| 字幕 | 有多种字幕样式和生成接口 | 动态漫画场景可用 |
| 渲染与交付 | H.264、本地/Lambda、批次和 ZIP | 生产依赖明显 |
| 多人协作、权限、审计 | 不在 Remotion 内核 | 缺失 |

外部导入报告也明确写出：AE expressions、plugins、3D layers 和 unsupported effects 不会执行；Live2D physics 和 parameters 只作为已渲染媒体处理（`src/editor/advanced/external-import.ts:939-952`）。因此不能把 exchange package 导入称为 AEP 兼容。

## 能不能做出“完整产品”

### 可以直接做的产品形态

当前代码足以支撑下面这类产品：

- 面向内部制作团队的动态漫画生产工具；
- 输入已经拆层的漫画页和对白/音频，快速生成竖屏成片；
- API 优先、人工只做少量时间线修正和验收；
- 单用户或低并发，工程由上游系统或脚本管理；
- 以 H.264 视频和交付 ZIP 为主要产物。

### 不能直接宣称的产品形态

当前不能直接宣称：

- 面向普通用户的完整 AE 替代编辑器；
- 可长期保存大量工程的云端 NLE；
- 支持崩溃恢复、版本回滚和多人协作的 SaaS 编辑器；
- AEP/PSD/AE plugin 的兼容工作站；
- 不依赖外部 AI、COS、ffmpeg、Lambda 配置的一键生产产品。

## 建议的完成门槛

### 门槛 A：动态漫画 MVP

目标是让内部人员能稳定交付，不追求 AE 兼容。

1. 固定一种工程存储方案，至少支持多个 project 和版本列表。
2. 将当前手动 Save 改成自动快照、原子写入和启动恢复。
3. 为 motion、shot、layer、dialogue 做完整 UI，不要求用户直接改 JSON/API。
4. 明确渲染前置条件：素材、字体、COS、ffmpeg、Lambda 配置全部可检查。
5. 统一 render job 状态、取消、重试、超时和最终输出引用。
6. 为“导入 → 编辑 → 预览 → 渲染 → 下载”做一条真实浏览器验收测试。

达到这里，可以称为“动态漫画制作产品 MVP”。

### 门槛 B：生产级编辑器

在门槛 A 之上补齐：

1. 统一 `Property<T>` 参数内核，普通 item 和 Advanced layer 共用求值链。
2. 统一 Command Bus，支持拖拽合并、事务、回放和命令日志。
3. 建立按节点/属性失效的 Render DAG 与缓存，避免项目级 hash 重算。
4. 让 pre-compose 支持公开参数、模板实例和版本迁移。
5. 把 mask、matte、adjustment、字幕、sprite 的编辑状态统一纳入同一历史和恢复模型。
6. 增加渲染输入快照与输出 manifest 的可追溯关联。

达到这里，才适合称为“生产级 2D 动态漫画编辑器”。

### 门槛 C：AE 级产品

这不是在现有模块上补几个按钮，而是另一个规模的产品线，至少需要：

- 完整统一参数系统和 Graph Editor；
- Shape/Mask/Path/Track Matte/Effect 体系；
- 3D layer、camera、light、depth；
- 表达式语言兼容或清晰的替代语言；
- PSD/AEP/插件/媒体交换策略；
- 高级变形、跟踪、音频混音和色彩管理；
- 项目数据库、权限、协作、审计和长期兼容迁移。

不建议把“支持 AE”作为 Remotion 当前阶段的目标。更合理的路线是把动态漫画的 2D 专用体验做深，再提供受限、可解释的交换包。

## 推荐优先级

### P0：不补就不能称为闭环

1. 工程持久化、自动保存、崩溃恢复和版本迁移。
2. 统一 motion/Advanced 的 Property 参数模型。
3. 统一 Command Bus，消除普通编辑和 mask history 的分裂。
4. 渲染任务状态机：提交、进度、取消、重试、失败、完成、输出校验。
5. 完整 motion/shot/layer UI，让 API 能力真正可被编辑器用户使用。

### P1：不补会限制规模和维护成本

1. Render DAG、节点 hash、内存/磁盘缓存和精确失效。
2. 插件注册表和 schema migration 注册机制。
3. Pre-compose 公开属性、模板实例和版本化。
4. 字体、素材、渲染器版本的确定性锁定。
5. 浏览器 E2E 验收：刷新恢复、资产失败、渲染失败、重复提交、交付下载。

### P2：按产品定位选择

1. 音素级口型和角色声线系统。
2. Live2D runtime 或其他角色变形 runtime。
3. 更丰富的动态漫画预设和预览缩略图。
4. PSD/AE 受限交换包，而不是直接追求原生插件兼容。

## 验证记录

- `pnpm test`：108 个测试文件、378 个测试全部通过。
- 当前测试主要验证领域函数、数据转换、API 路由和部分验收场景；这不能替代浏览器端的完整产品流程验收。
- 本次尝试执行 `pnpm exec tsc --noEmit` 和 `pnpm lint` 时，Corepack 试图从 npm 下载项目指定的 pnpm 版本，但当前环境网络失败，因此本次没有得到类型检查和 lint 结果。
- 本文档没有修改 Remotion 源码、配置或测试。

最终结论：**现在可以继续做动态漫画生产 MVP，但还不能说 Remotion 部分已经功能闭环，更不能按 AE 标准称为完整产品。** 最先应该补的是保存/恢复、统一参数、命令历史和渲染任务生命周期。
