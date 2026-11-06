# Remotion 动态漫画 MVP 实施规格

> 本文是后续代码修改的执行合同。实现过程中如果发现代码与本文冲突，先更新本文的边界和验收标准，再修改代码。
> 上游依据：[Remotion 产品闭环与 AE 能力审计](./Remotion产品闭环与AE能力审计.md)
> 适用工程：novelcomic-remotion
> 状态：待实现
> 版本：MVP-1.0
> 编写日期：2026-10-06

## 1. 决策摘要

本 MVP 的产品定位是：

> 面向内部制作人员的动态漫画 2D 编辑器和 Remotion 渲染交付工具。

MVP 只承诺一条可恢复、可验收、可交付的生产链路：

~~~text
创建/打开工程
→ 导入原图或 LayerPackage
→ 管理分镜、图层、对白和音频
→ 编辑 2D motion
→ 校验工程
→ 预览/抽帧
→ 提交渲染并跟踪任务
→ 重试或取消
→ 生成 MP4 和 ZIP 交付包
~~~

完成 MVP 后可以称为“动态漫画制作产品 MVP”，不能称为：

- AE 替代品；
- AEP/PSD/AE Plugin 兼容工作站；
- 多人协作 SaaS；
- 无限规模的云端非线性编辑器。

本规格优先解决审计中四个闭环断点：

1. 工程持久化、自动保存、崩溃恢复和版本列表。
2. 普通 motion 与 Advanced transform 的统一属性求值入口。
3. 编辑命令、拖拽、蒙版历史（本 MVP 不开放蒙版编辑）统一进入一条 Undo/Redo 链。
4. 渲染任务的提交、进度、取消、重试、失败和输出追溯。

## 2. 目标用户与运行约束

### 2.1 目标用户

- 内部动态漫画制作人员或技术美术；
- 已经拥有原图、拆层包、对白文本和音频，或能从上游服务获得这些输入；
- 允许在同一浏览器内完成单用户编辑和交付；
- 可以接受本地浏览器工程存储，暂不要求云端项目同步。

### 2.2 运行约束

| 项目 | MVP 约束 |
| --- | --- |
| 默认画布 | 1080x1920 |
| 默认帧率 | 30fps |
| 视频编码 | 仅 H.264 |
| 编辑模式 | 单用户、单活动工程、单浏览器标签页 |
| 工程存储 | 浏览器 IndexedDB；localStorage 仅存 UI 偏好 |
| 资产存储 | 复用现有 IndexedDB 资产缓存和远程 URL 白名单 |
| 渲染后端 | 本地 Renderer 必须可用；Lambda 为可选能力 |
| 远程项目数据库 | 不在 MVP 内 |
| 协作/权限 | 不在 MVP 内 |

### 2.3 工程规模上限

继续使用现有领域上限，不在 UI 侧偷偷放宽：

- MAX_SHOTS = 500；
- MAX_ITEMS = 10_000；
- MAX_ASSETS = 20_000；
- MAX_KEYFRAMES_PER_ITEM = 2_000；
- 请求体上限继续使用 MAX_REQUEST_BODY_BYTES；
- 超过浏览器 IndexedDB 配额时必须显示“存储空间不足”，不得静默丢失编辑。

## 3. MVP 范围

### 3.1 必须交付的能力

| 能力 | MVP 要求 | 完成判定 |
| --- | --- | --- |
| 工程管理 | 新建、列表、打开、重命名、复制、归档/删除、最近打开 | 刷新浏览器后仍能打开多个工程 |
| 工程保存 | 自动快照、原子提交、版本列表、恢复最近快照 | 关闭/刷新后可恢复最后一次已提交编辑 |
| 资产 | 本地上传、HTTPS 远程素材、IndexedDB 缓存、失败重试 | 素材状态可见，缺失素材会被校验阻断 |
| 分镜 | 新建、重命名、时长、起始帧、cut/crossfade、删除 | shots、关联轨道和对白引用一致 |
| 2D motion | 位置、缩放、旋转、透明度、锚点、关键帧、四种 easing、循环、预设 | Viewer、预览帧和视频渲染一致 |
| 镜头 motion | 每个 shot 的 x/y/scale 关键帧和四种镜头预设 | 镜头运动只影响所属 shot |
| Sprite | 眨眼、规则 mouth-flap；音素数据可选 | 无音素时规则方案仍能生产 |
| 对白/字幕/音频 | 对白文本、字幕样式、音频引用、基本时间范围 | 对白可被 shot 管理并出现在预览/交付清单 |
| 校验 | 错误、警告、对象定位、修复提示 | 错误时禁止渲染和完整交付 |
| 预览 | Player 播放、质量预览、单帧预览 | 当前工程帧和渲染输入一致 |
| 渲染任务 | 本地/Lambda 适配、进度、取消、失败、手动重试、输出 URL | 刷新页面后任务仍可继续查询 |
| 批次交付 | 复用已有规划、批次渲染、合并和 ZIP | 可得到批次视频、完整 MP4、manifest 和 checksum |
| 诊断 | 环境前置条件、资产、字体、COS、ffmpeg、Lambda | 用户能知道失败原因和下一步动作 |

### 3.2 复用现有能力，不重写领域逻辑

下列模块作为 MVP 的领域基础，优先补 UI、持久化和任务编排，不重新实现同一套规则：

- src/editor/comic/upsert-shot.ts、edit-shot.ts、delete-shot.ts；
- src/editor/comic/apply-motion.ts、apply-sprite-motion.ts；
- src/editor/motion/evaluate.ts、presets.ts、diagnostics.ts；
- src/editor/comic/validate-project.ts；
- src/editor/comic/plan-batches.ts、merge-batches.ts、delivery-manifest.ts、export-package.ts；
- app/api/compose/project/* 已有的 create、validate、summary、preview、plan、render、merge、export 路由；
- app/api/render/route.ts 和 app/api/progress/route.ts 的输入校验与后端适配。

### 3.3 MVP 不做的能力

以下内容必须隐藏、禁用或显示“非 MVP 能力”，不能留下点击后无行为的入口：

- 3D layer、3D camera、light、depth、景深；
- Shape Layer、Graph Editor 的完整曲线编辑器；
- 任意 AE expressions、AE plugin ABI；
- AEP 原生导入/导出；
- PSD 原生往返编辑；MVP 只接受规范化 LayerPackage，已有受限 PSD manifest 入口不作为交付承诺；
- Live2D runtime、physics、参数驱动角色；
- Puppet、roto、完整 mesh warp、运动跟踪；
- 可视化 Mask/Track Matte 编辑。已有 Advanced mask/matte 数据允许保留、校验和渲染，但 MVP UI 只读；
- 多人协作、锁、游标、冲突合并、权限、审计日志；
- 云端项目列表、云端版本库和跨设备同步；
- AI 拆层、inpaint、ASR、TTS provider 管理。上游服务可以产出结果，Remotion 只消费结果；
- 除 H.264 之外的编码器、色彩管理工作站和音频混音台；
- 无限嵌套 pre-compose、模板实例参数和跨工程引用。

## 4. 用户闭环与状态门禁

### 4.1 标准生产流程

1. 打开根路径，进入工程列表。
2. 新建动态漫画工程，默认 1080x1920/30fps，得到 projectId。
3. 上传原图、导入远程原图或导入规范化 LayerPackage。
4. 创建或编辑 shot，确认起始帧、时长和转场。
5. 将图层、对白、音频和字幕归属到 shot。
6. 选中图层或 shot，使用 motion 面板添加预设或关键帧。
7. 点击“校验”，处理所有 error；warning 可以明确确认后继续。
8. 使用 Player 播放，必要时生成单帧预览或质量预览。
9. 创建渲染任务。任务必须绑定当前工程快照，不读取之后的未保存修改。
10. 在任务面板中查看进度、取消或重试。
11. 所有需要的批次完成后合并完整 MP4，生成 manifest 和 ZIP。
12. 下载交付包；交付包中的工程、视频、预览、素材清单和 checksum 必须可追溯到同一输入快照。

### 4.2 全局门禁

| 状态 | 允许操作 | 禁止操作 |
| --- | --- | --- |
| loading | 等待初始化 | 编辑、渲染 |
| dirty | 编辑、校验、预览 | 直接声称已保存 |
| saving | 编辑；保存请求排队 | 关闭前不提示 |
| saved | 全部 MVP 操作 | 无 |
| save-error | 编辑、重试保存、导出本地备份 | 静默离开 |
| validation-error | 定位并修复工程 | 渲染、完整交付 |
| validation-warning | 明确确认后渲染/交付 | 无确认直接交付 |
| rendering | 查看任务、取消、继续编辑 | 修改该任务的输入快照 |
| render-failed | 查看原因、重试、改工程后新建任务 | 将失败任务伪装为成功 |
| delivery-incomplete | 下载不完整包作为诊断包 | 显示为完整交付 |

## 5. 工程数据与版本模型

### 5.1 存储层次

运行时拆成五层，职责不能混合：

~~~text
ProjectRecord       工程索引、名称、当前快照指针
ProjectSnapshot     某个 revision 的完整不可变工程状态
EditorState         当前编辑器运行时状态、选中项、播放头、临时任务
AssetCache          素材二进制/Blob 缓存，不代替工程快照
RenderJob           渲染输入快照、后端句柄、进度和输出
~~~

EditorState 的选中项、播放头、面板折叠、缩放、临时拖拽状态不写入项目快照；工程内容、素材引用、shot、motion、dialogue 和高级数据写入项目快照。

### 5.2 IndexedDB 数据库

新建独立数据库 novelcomic-remotion-mvp，不要修改现有素材缓存数据库的 store 语义。

| Object Store | 主键 | 内容 |
| --- | --- | --- |
| projects | projectId | ProjectRecord |
| snapshots | snapshotId | ProjectSnapshot，按 projectId + revision 索引 |
| renderJobs | jobId | RenderJob，按 projectId、status、createdAt 索引 |
| drafts | projectId | 正在写入但尚未成为 current snapshot 的恢复草稿 |

localStorage 只能继续保存语言、主题、时间线高度、吸附和 Auto-Key 等偏好；禁止再保存完整工程。

### 5.3 ProjectRecord

~~~ts
type ProjectRecord = {
  projectId: string;
  name: string;
  schemaVersion: 3;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  currentSnapshotId: string;
  currentRevision: number;
  archived: boolean;
};
~~~

规则：

- projectId 使用稳定 UUID，创建后不可变；
- name 只用于列表和导出显示，不参与内容 hash；
- 归档项目默认不出现在“最近项目”，可以恢复；
- 删除前必须二次确认，删除 projects、snapshots、drafts、renderJobs 的本项目记录；
- 删除资产缓存不是工程删除的副作用，资产缓存由独立清理策略处理。

### 5.4 ProjectSnapshot

~~~ts
type ProjectSnapshot = {
  snapshotId: string;
  projectId: string;
  revision: number;
  savedAt: string;
  reason: 'create' | 'command' | 'autosave' | 'manual' | 'restore' | 'import';
  contentHash: string;
  state: UndoableStateV3;
};
~~~

规则：

- snapshot 不可变，恢复会生成一个新的 reason: restore snapshot；
- revision 在同一工程内单调递增；
- contentHash 复用 src/editor/comic/content-hash.ts 的稳定 hash 语义；
- 相同 contentHash 不重复创建自动快照，但手动“保存版本”可以留下带标签的版本记录；
- 默认保留最近 50 个快照，手动版本在空间不足时优先保留；
- 快照写入失败时不得更新 currentSnapshotId。

### 5.5 UndoableStateV3 与旧工程兼容

运行时可以继续使用现有 UndoableState 字段，但新增版本字段：

~~~ts
type UndoableStateV3 = UndoableState & {
  schemaVersion: 3;
  propertyGraph: PropertyGraphV1;
};
~~~

迁移规则：

1. schema undefined/1/2 先走现有 normalizeUndoableState()。
2. 将 item.motion.transform、shot.cameraMotion 和可编辑 Advanced transform 转成 propertyGraph。
3. 旧字段作为兼容 projection 保留，不能在 UI 中直接写入。
4. 现有 Remotion composition 和外部 API 在提交前通过 materializeLegacyMotion() 得到兼容输入。
5. 不认识的新 schema 必须阻止编辑，并提供“下载原始工程”入口。
6. 迁移过程中任何字段不能静默丢弃；无法转换的 Advanced 字段进入 warning，并原样保留。

MVP 不提供从 schema 3 降级回 schema 1/2 的保存能力。

## 6. 统一 Property 模型

### 6.1 目标

普通 image item、shot camera 和 Advanced layer 使用同一套数值属性求值函数；UI、Command、预览、渲染和校验不再各自实现一套关键帧规则。

### 6.2 类型

~~~ts
type PropertyEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

type NumericKeyframe = {
  frame: number;
  value: number;
  easing: PropertyEasing;
  hold?: boolean;
  handleIn?: {x: number; y: number};
  handleOut?: {x: number; y: number};
};

type NumericProperty = {
  baseValue: number;
  keyframes: NumericKeyframe[];
};

type PropertyOwner =
  | {kind: 'item'; id: string}
  | {kind: 'shot'; id: string}
  | {kind: 'advanced-layer'; id: string};

type PropertySet = {
  owner: PropertyOwner;
  properties: Record<string, NumericProperty>;
  loop: 'none' | 'repeat' | 'ping-pong';
  loopStartFrame?: number;
  loopEndFrame?: number;
};

type PropertyGraphV1 = {
  version: 1;
  sets: Record<string, PropertySet>;
};
~~~

### 6.3 MVP 支持的属性

| Owner | 可编辑属性 |
| --- | --- |
| image item | anchorX、anchorY、x、y、scaleX、scaleY、rotation、opacity |
| shot | x、y、scale |
| Advanced layer | 只读显示；可求值 x、y、scaleX、scaleY、rotation、opacity |

约束：

- item 和 shot 的关键帧使用 owner 局部帧；
- frame 必须是整数，且位于 [0, durationInFrames - 1]；
- scaleX/scaleY 必须大于 0，opacity 必须在 [0, 1]；
- 同一 owner、同一 property、同一 frame 只能有一个 keyframe；
- UI 只显示四种 easing；hold 和曲线 handle 可以由已有数据读取，但 MVP 不做独立 Graph Editor；
- loop 窗口必须完整且 end >= start；
- 预设最终展开为同一 PropertySet，预设参数只作为来源元数据保存。

### 6.4 求值顺序

~~~text
baseValue
→ local keyframe interpolation
→ loop remap
→ Advanced parent world transform（只读已有层级）
→ shot camera transform
→ fade/visibility
→ Remotion frame render
~~~

必须只有一个公开求值入口：

~~~ts
evaluatePropertyGraph({graph, owner, frame, durationInFrames})
~~~

src/editor/motion/evaluate.ts 和 src/editor/hierarchy/resolve-parent-transform.ts 可以作为内部实现，但 Viewer、preview-frame 和最终渲染不得各自复制插值规则。

### 6.5 写入规则

- Inspector 数字输入、Canvas 拖拽、Timeline 关键帧、motion 预设和 Compose API 都转换成 UpdatePropertyCommand；
- 连续 pointer move 只更新 transient preview；pointer up 生成一个 command；
- Escape、pointercancel、Undo 在 pointer up 前恢复拖拽起始值；
- Auto-Key 关闭时修改当前值不自动新增 keyframe；
- Auto-Key 开启时只在当前 owner 和当前帧更新已启用属性；
- 删除一个 property 的最后一个 keyframe 时清除该 property 的 animated 标记。

## 7. Command Bus 与 Undo/Redo

### 7.1 Command 结构

~~~ts
type ProjectCommand = {
  id: string;
  type:
    | 'project.rename'
    | 'asset.add'
    | 'asset.remove'
    | 'track.update'
    | 'track.reorder'
    | 'item.create'
    | 'item.update'
    | 'item.delete'
    | 'shot.upsert'
    | 'shot.edit'
    | 'shot.delete'
    | 'property.update'
    | 'sprite.update'
    | 'dialogue.update'
    | 'layer-package.import'
    | 'project.restore';
  payload: unknown;
  transactionId?: string;
  mergeKey?: string;
  createdAt: string;
};
~~~

每个 command 必须有：

~~~text
apply(state, command) -> {state, inverse}
validate(command, state) -> ProjectIssue[]
~~~

src/editor/compose/apply-command.ts 保留为领域校验和归一化入口；在其上增加编辑器侧 Command Bus，不再让 UI 组件直接修改 undoableState。

### 7.2 事务边界

以下操作各自只产生一条可撤销事务：

- 导入一个完整 LayerPackage；
- 新建/编辑/删除一个 shot；
- 应用一个 motion 预设；
- 一次 pointer drag；
- 添加一段对白和它的音频引用；
- 生成并应用一次 sprite motion；
- 一次批量删除。

事务内部可以更新多个 item、track、asset 和引用，但不能留下半成品状态。

### 7.3 历史边界

- 内存中最多保留 100 条 committed command；
- 新 command 会清除 redo 分支；
- 相同 mergeKey 的连续输入在 300ms 内合并；
- Undo/Redo 本身会触发自动快照，但不写入新的 command；
- 选中项、播放头、时间线缩放、面板展开状态不进入历史；
- MVP 不持久化完整 command log，不承诺跨浏览器回放；崩溃恢复依赖 ProjectSnapshot。

### 7.4 不能绕过 Command Bus 的入口

以下文件和模块不能直接 setState({undoableState: ...}) 写工程内容：

- src/editor/inspector/**；
- src/editor/timeline/**；
- src/editor/canvas/**；
- src/editor/shot-panel/**；
- src/editor/sidebar/** 中会修改工程的面板；
- Compose API 的客户端调用适配层。

初始化、迁移、恢复和渲染任务状态可以绕过工程 command，但必须通过明确的系统事务函数。

## 8. 保存、自动恢复与版本列表

### 8.1 原子保存协议

保存一个工程必须在同一个 IndexedDB transaction 中完成：

1. 校验当前 state 和资产状态；
2. 写入新的 ProjectSnapshot；
3. 更新 ProjectRecord.currentSnapshotId/currentRevision/updatedAt；
4. 删除超出保留策略的旧自动快照；
5. 删除对应 drafts 记录。

如果任意一步失败，current pointer 不变，界面显示 save-error，并保留待恢复 draft。

### 8.2 自动保存策略

- command commit 后 1 秒 debounce；
- 连续编辑最多 5 秒必须发起一次保存；
- 同一时间只允许一个 save transaction；
- 保存中产生的新 command 合并为下一次保存，不阻塞编辑；
- 资产正在上传、存在 asset error 时不能标记为 saved；
- 保存状态必须在顶部栏显示：未保存、保存中、已保存、保存失败。

### 8.3 启动恢复

启动时按以下顺序加载：

1. URL 指定的 projectId；
2. 最近打开的工程；
3. 没有工程时显示工程列表，不自动创建隐藏工程。

如果 drafts 中存在比 current snapshot 更新的 draft，显示恢复对话框：

- 恢复 draft：生成 reason: restore 新快照；
- 丢弃 draft：只删除 draft，不删除正式版本；
- 下载 draft：导出 JSON 备份后再处理。

### 8.4 版本列表

版本列表最少显示：

- revision；
- 保存时间；
- 保存原因；
- 内容 hash 前 8 位；
- 是否当前版本；
- 是否存在关联渲染任务。

支持：查看摘要、恢复、删除自动版本。恢复不覆盖旧版本，必须创建新 revision。

## 9. 渲染任务系统

### 9.1 任务数据

~~~ts
type RenderJobStatus =
  | 'queued'
  | 'validating'
  | 'submitted'
  | 'running'
  | 'cancel-requested'
  | 'succeeded'
  | 'failed'
  | 'canceled';

type RenderJob = {
  jobId: string;
  projectId: string;
  inputSnapshotId: string;
  inputContentHash: string;
  kind: 'preview-frame' | 'full-video' | 'batch' | 'merge' | 'delivery';
  batchId?: string;
  backend: 'local' | 'lambda';
  status: RenderJobStatus;
  attempt: number;
  maxAttempts: 3;
  progress: number;
  renderId?: string;
  bucketName?: string;
  outputFile?: string;
  outputName?: string;
  outputSizeInBytes?: number;
  checksum?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};
~~~

EditorState.renderingTasks 可以继续作为现有组件的投影，但 renderJobs 是可恢复任务的唯一事实来源。

### 9.2 状态转换

~~~text
queued
  → validating
  → submitted
  → running
  → succeeded

queued/validating/submitted/running
  → cancel-requested
  → canceled

validating/submitted/running
  → failed(retryable?)
  → queued                  手动重试，attempt + 1
~~~

规则：

- succeeded/failed/canceled 是终态；
- attempt >= 3 时不再显示自动重试按钮，只允许基于新工程快照重新提交；
- 任务提交前必须保存或复用一个明确的输入 snapshot；
- 任务运行期间用户可以继续编辑，但不会改变该任务的 input snapshot；
- 任务输出必须保存 URL、文件名、大小和 checksum；
- 刷新后根据 renderJobs 恢复轮询；轮询失败不能删除任务；
- 轮询连续失败三次后标记 failed(retryable: true)，并保留后端句柄；
- 输出 URL 不是 HTTPS 或 local 允许的本地结果时，任务不能进入 succeeded。

### 9.3 任务提交前置条件

创建 full-video、batch 或 delivery 任务必须：

1. 获取最新保存 snapshot；
2. 执行 /api/compose/project/validate；
3. 执行渲染能力 preflight；
4. 有 error 时拒绝提交；
5. 有 warning 时要求用户点击“仍然提交”；
6. 在 RenderJob 中写入 inputSnapshotId 和 inputContentHash。

### 9.4 取消协议

新增 POST /api/render/cancel：

~~~json
{
  "bucketName": "local",
  "renderId": "..."
}
~~~

后端必须通过 backend adapter 实现：

- local：中止对应 Renderer 子进程并清理临时状态；
- lambda：调用 Remotion Lambda 的停止接口；
- 后端已经完成时返回当前终态，不把成功结果误标记成取消；
- 后端不支持取消时返回 409 CANCEL_UNSUPPORTED，前端不能显示“已取消”。

### 9.5 进度轮询

- 初次提交后立即查询一次；
- 正常间隔 2 秒；
- 网络失败时使用 2、4、8 秒退避，最多连续失败三次；
- 页面隐藏时可以降为 5 秒，但任务状态必须持续存储；
- done、error 和 canceled 立即停止轮询；
- 不允许使用递归请求导致无法取消的 Promise 链，必须由可取消的 polling controller 管理。

## 10. 渲染与交付边界

### 10.1 渲染模式

| 模式 | 触发条件 | 产物 |
| --- | --- | --- |
| 单帧预览 | 用户选择当前帧 | PNG/预览 URL |
| 全片渲染 | 工程可直接一次渲染 | 一个 H.264 MP4 |
| 批次渲染 | 用户选择批次或工程需要分批 | 每个 batch 一个 MP4 |
| 批次合并 | 所有 batch 成功 | final-video/full.mp4 |
| 交付打包 | 最终视频和清单准备完毕 | ZIP、manifest、checksum |

默认批次区间继续使用现有 5–18s 规划规则；MVP 不提供用户手工拖动批次边界的编辑器。

### 10.2 交付成功定义

只有同时满足以下条件，界面才显示“交付成功”：

- 工程校验没有 error；
- 必要 warning 已明确确认；
- 所有要求的 batch 已 succeeded；
- final-video/full.mp4 已生成或明确选择“仅批次交付”；
- manifest.json、project/project.json、files.json 存在；
- 必要文件均有 URL、大小和 checksum；
- ZIP 上传成功并可返回稳定 URL。

缺少素材或文件时可以生成诊断包，但状态必须是 delivery-incomplete，不得伪装成完整交付。

### 10.3 环境能力检查

新增 GET /api/compose/capabilities，只返回能力和原因，不返回密钥：

~~~ts
type ComposeCapabilities = {
  renderBackend: 'local' | 'lambda';
  local: {available: boolean; reason?: string};
  lambda: {configured: boolean; reason?: string};
  ffmpeg: {available: boolean; reason?: string};
  cos: {configured: boolean; reason?: string};
  fonts: {available: boolean; missing?: string[]};
  exportPackage: {available: boolean; reason?: string};
};
~~~

渲染和交付按钮必须依据该结果显示前置条件，而不是提交后才返回一个无上下文的 500。

## 11. 校验规则与降级

### 11.1 Error：必须阻断

至少包括：

- 工程 schema 过新或迁移失败；
- item、track、shot、dialogue、asset 引用不存在；
- 素材 URL 非 HTTPS 或不在允许域名；
- 图片、音频、视频资产加载失败；
- keyframe 越界、重复、非有限或 scale/opacity 非法；
- crossfade 长度不合法；
- sprite 引用的 asset 不存在；
- 输入快照和任务声明的 content hash 不一致；
- 渲染后端、ffmpeg、COS 或 Lambda 必要配置缺失；
- 批次缺失、重复、帧范围不连续；
- 最终视频缺失或无法下载。

### 11.2 Warning：必须可解释

至少包括：

- clean plate 缺失或 diagnostics 低于建议阈值；
- Advanced mask/matte/expression/plugin 字段只读降级；
- 字体不可用，使用替代字体；
- 远程素材未缓存，将在渲染时下载；
- 没有音素数据，mouth-flap 使用规则方案；
- Lambda 未配置，只能本地渲染；
- 交付包包含标记为 missing 的非关键诊断文件。

每条 issue 必须带 code、message、对象 ID、suggestion；点击 issue 能定位到 shot、track、item 或 asset。

## 12. UI 规格

### 12.1 工程列表

必须显示：

- 工程名称；
- 最近打开时间；
- 最近保存时间；
- 画布规格和 fps；
- 当前版本号；
- 最近一次保存/渲染状态。

操作：新建、打开、重命名、复制、归档、恢复归档、删除、导入 JSON、导出 JSON 备份。

### 12.2 顶部栏

保留现有编辑器布局，但顶部必须有：

- 工程名；
- dirty/saving/saved/save-error 状态；
- 版本列表；
- 校验按钮和 error/warning 数量；
- 预览帧按钮；
- 渲染按钮；
- 交付按钮；
- 当前后端能力提示。

所有可见按钮必须有真实行为；未实现的 AE 菜单项和工作区入口必须隐藏或置灰并带原因。

### 12.3 Shot 面板

复用 src/editor/shot-panel/，第一版采用表单和按钮，不做复杂拖拽排序。每个 shot 显示：

- 名称；
- 起始帧和秒数；
- 时长；
- layer track 数量；
- dialogue 数量；
- cut/crossfade 和 crossfade 帧数；
- camera motion 状态；
- error/warning 标记。

删除 shot 前明确告知将删除或解绑的 item、track 和资产；删除逻辑继续调用领域函数，不由 UI 自己拼接数组。

### 12.4 Motion 面板

复用现有 src/editor/inspector/controls/motion-controls.tsx，收口为四个区域：

1. Transform：位置、缩放、旋转、透明度、锚点。
2. Keyframes：frame、数值、easing、删除和导航。
3. Presets：breathing、float、hair-sway、camera-push、camera-pull、pan-left、pan-right。
4. Sprite：blink、mouth-flap、closed/half/open asset 选择。

第一版不开放表达式、Graph Editor、Advanced layer transform 写入、mask path 和 3D 控件。

### 12.5 渲染任务面板

每条任务显示：

- 类型、工程名、revision、content hash 前 8 位；
- backend、attempt、状态、百分比、开始/结束时间；
- 当前错误和 retryable；
- 查看输出、下载、取消、重试。

任何任务输出必须显示它来自哪个 input snapshot，避免用户误把旧视频当成当前工程结果。

## 13. API 契约

### 13.1 继续使用的路由

| 路由 | MVP 用途 |
| --- | --- |
| POST /api/compose/project/create | 创建默认动态漫画工程 |
| POST /api/compose/shot/create | 创建 shot |
| POST /api/compose/shot/edit | 编辑 shot |
| POST /api/compose/shot/delete | 删除 shot |
| POST /api/compose/layers/import | 导入 LayerPackage |
| POST /api/compose/layers/restore-l0 | 恢复原图轨道 |
| POST /api/compose/dialogue/add | 添加对白/字幕 |
| POST /api/compose/dialogue/voice | 添加音频引用 |
| POST /api/compose/item/motion | 应用 item/shot motion |
| POST /api/compose/item/edit | 编辑 item |
| POST /api/compose/project/validate | 返回结构化 issues |
| POST /api/compose/project/summary | 工程摘要 |
| POST /api/compose/project/preview-frame | 单帧预览 |
| POST /api/compose/project/plan-batches | 批次规划 |
| POST /api/compose/project/render-batches | 批次提交 |
| POST /api/compose/project/merge-batches | 批次合并 |
| POST /api/compose/project/export-package | ZIP 交付包 |
| POST /api/render | 全片或单批次渲染提交 |
| POST /api/progress | 查询渲染进度 |

这些路由都是无状态的，不能把浏览器工程写进 Node 全局变量。

### 13.2 MVP 新增路由

| 路由 | 请求 | 返回 |
| --- | --- | --- |
| GET /api/compose/capabilities | 无 | ComposeCapabilities |
| POST /api/render/cancel | bucketName + renderId | 当前任务终态或取消结果 |

### 13.3 API 一致性

- 所有 Compose route 继续使用 runComposeRoute、Zod schema 和 draftEnvelopeSchema；
- clientRequestId 用于重复提交幂等；
- expectedRevision 不匹配时返回冲突，不覆盖更新后的工程；
- 路由错误必须返回稳定 code、message、retryable 和对象 ID；
- API 输入在发送前使用 materializeLegacyMotion()，服务端再校验，不能只依赖前端。

## 14. 文件修改清单

以下是实现时的建议分工；标记为“新增”的文件不存在时创建，标记为“修改”的文件保留现有行为并补齐 MVP 约束。

### 14.1 工程与存储

新增：

- src/editor/project/types.ts；
- src/editor/project/project-store.ts；
- src/editor/project/project-migrations.ts；
- src/editor/project/project-hash.ts；
- src/editor/project/project-context.tsx；
- src/editor/project/project-list-panel.tsx；
- src/editor/project/recovery-dialog.tsx；
- src/editor/project/version-list.tsx。

修改：

- src/editor/state/types.ts：增加 V3/propertyGraph 和项目运行时引用；
- src/editor/state/persistance.ts：从完整 localStorage 改为 IndexedDB store 适配器；
- src/editor/state/normalize-undoable-state.ts：接入 schema 3 migration；
- src/editor/state/initial-state.ts：无工程时不创建隐藏持久化工程；
- src/editor/context-provider.tsx：挂载项目上下文、autosave 和恢复状态；
- src/editor/editor.tsx、src/editor/top-panel.tsx：挂载工程列表和保存状态。

### 14.2 Command 与属性

新增：

- src/editor/commands/types.ts；
- src/editor/commands/command-bus.ts；
- src/editor/commands/command-history.ts；
- src/editor/property/types.ts；
- src/editor/property/migrate-motion.ts；
- src/editor/property/evaluate-property.ts；
- src/editor/property/materialize-motion.ts；
- src/editor/property/property-commands.ts。

修改：

- src/editor/compose/apply-command.ts：成为领域 command 的统一校验入口；
- src/editor/utils/undo-redo.tsx：改为消费 command history，保留现有 UI API；
- src/editor/motion/types.ts、evaluate.ts、transform-property-timeline.ts：使用 Property 适配层；
- src/editor/comic/apply-motion.ts、apply-sprite-motion.ts：改为生成/应用 command；
- src/editor/inspector/**、src/editor/timeline/**、src/editor/canvas/**：禁止直接修改工程状态。

### 14.3 渲染任务与前置检查

新增：

- src/editor/rendering/render-job-types.ts；
- src/editor/rendering/render-job-store.ts；
- src/editor/rendering/render-job-machine.ts；
- src/editor/rendering/render-backend.ts；
- src/editor/rendering/render-preflight.ts；
- src/editor/rendering/render-job-panel.tsx；
- app/api/compose/capabilities/route.ts；
- app/api/render/cancel/route.ts。

修改：

- src/editor/rendering/submit-render.ts：返回可持久化 backend handle；
- src/editor/rendering/local-render-jobs.ts：增加可取消子进程和终态读取；
- src/editor/rendering/render-state.ts：从 RenderJob 投影兼容旧任务指示器；
- src/editor/rendering/types.ts：扩展 cancel、progress、output 校验类型；
- app/api/progress/route.ts：统一 done/error/canceled 语义；
- src/editor/compose/render-batches.ts：将批次结果写入 RenderJob；
- src/editor/action-row/delivery-package-button.tsx：接入门禁和任务引用。

### 14.4 UI 与验收

修改：

- src/editor/shot-panel/shot-panel.tsx：接入 Command Bus、保存状态和 issue 定位；
- src/editor/inspector/controls/motion-controls.tsx：接入 PropertyGraph；
- src/editor/inspector/inspector-dock.tsx：显示 MVP 支持的 motion/diagnostics；
- src/editor/timeline/property-timeline/**：统一关键帧写入和拖拽事务；
- src/editor/canvas/player.tsx、src/editor/canvas/quality-preview.tsx：统一求值入口；
- src/editor/sidebar/**：未实现能力按 capability flag 隐藏或禁用；
- src/editor/flags.ts：增加 FEATURE_MVP_PROJECT_STORE、FEATURE_MVP_RENDER_JOBS、FEATURE_MVP_PROPERTY_GRAPH。

## 15. 实施顺序

必须按依赖顺序推进，不允许先堆 UI 再补持久化。

### 阶段 0：锁定基线

- 记录当前 commit、未提交变更和固定验收工程；
- 运行 pnpm test、pnpm typecheck、pnpm build、pnpm lint；
- 记录已有失败，不把环境问题伪装成 MVP 通过；
- 确认当前审计文档和本规格没有未决冲突。

完成门禁：基线命令结果已记录，固定验收工程可以打开和播放。

### 阶段 1：项目存储与迁移

- 实现 IndexedDB schema、原子快照、版本列表、恢复和删除；
- 接入 schema 1/2 → 3 migration；
- 保留现有 JSON 导入/导出作为故障备份；
- 移除完整工程的 localStorage 读写。

完成门禁：新建两个工程，分别编辑、刷新、关闭、恢复，内容互不串扰。

### 阶段 2：Command Bus 与 PropertyGraph

- 实现 command 类型、事务、inverse、merge 和 100 条历史；
- 完成 item/shot transform 迁移和唯一求值入口；
- 将 Inspector、Timeline、Shot Panel 和 motion API 接入；
- 为旧字段 projection 和 render materialization 加测试。

完成门禁：Viewer、单帧预览、本地渲染对同一帧给出同一变换；一次拖拽只能 Undo 一次。

### 阶段 3：MVP UI 收口

- 工程列表、顶部保存状态、版本列表、恢复对话框；
- shot 表单、motion 面板、校验面板；
- 隐藏 AE 非目标入口；
- 处理 1024px 和宽屏布局。

完成门禁：用户不需要编辑 JSON 或调用 API 即可完成一条工程编辑流程。

### 阶段 4：RenderJob

- 实现本地和 Lambda backend adapter；
- 实现持久化状态机、进度轮询、取消、失败和重试；
- 将批次结果、合并结果和输出 checksum 关联到 input snapshot；
- 增加 capabilities preflight。

完成门禁：刷新页面、网络短暂断开、渲染失败、取消和重复提交均有确定结果。

### 阶段 5：交付与浏览器验收

- 完成 full/batch/merge/delivery 任务串联；
- 缺文件时显示不完整，不显示成功；
- 验证 ZIP 内容、manifest、checksum 和重新加载工程；
- 固定真实工程完成端到端验收。

完成门禁：从新建工程到下载完整 MP4/ZIP 的流程可重复执行。

## 16. 测试与验收清单

### 16.1 纯函数/领域测试

必须覆盖：

- ProjectRecord、snapshot revision 和 content hash；
- IndexedDB save transaction 的 pointer 原子性；
- schema 1/2/3 migration 和未知 schema 阻断；
- Property keyframe 插值、hold、四种 easing、loop 和边界帧；
- item/shot/Advanced property materialize 前后一致；
- command apply/inverse、事务、mergeKey、redo 清除；
- shot crossfade、dialogue 引用、layer package 原子导入；
- validation error/warning 分级；
- RenderJob 所有合法/非法状态转换；
- retry attempt 上限、cancel 竞态、done 与 cancel 同时到达；
- delivery manifest 缺文件、checksum 和 batch 顺序。

### 16.2 浏览器验收

使用固定真实漫画样例执行：

1. 新建工程，关闭页面，重新打开并确认工程存在。
2. 新建两个工程，确认名称、素材、shot、版本完全隔离。
3. 上传一张原图，刷新后仍可预览；制造一次 asset error，确认保存和渲染被阻断。
4. 创建两个 shot，设置 crossfade，修改时长，确认对白和图层随 shot 正确移动。
5. 应用 breathing、camera-push 和 mouth-flap，确认预览即时变化。
6. 在 Timeline 连续拖拽关键帧，Undo 一次恢复整个拖拽。
7. 开启 Auto-Key 和关闭 Auto-Key 各修改一次，检查只写入符合规则的 keyframe。
8. 生成 error 和 warning，各验证渲染门禁和“仍然提交”流程。
9. 提交本地渲染，刷新页面，继续看到进度并取得输出。
10. 取消本地渲染，确认进程终止、任务进入 canceled。
11. 制造一次可重试失败，重试最多三次，输入快照不变化。
12. 规划多个 batch，单独重试失败 batch，合并后检查 playOrder。
13. 生成 ZIP，解压检查 project/project.json、manifest.json、files.json、视频和 checksum。
14. 缺失必要文件时确认 UI 显示 delivery-incomplete，不能标记交付成功。

### 16.3 性能与安全验收

- 常规 1080x1920、10 个 shot、100 个 item 工程的输入响应不因 autosave 明显卡顿；
- 保存写入不阻塞播放和拖拽；
- 远程 URL 继续执行 HTTPS 和 allow-list 校验，不能通过 project JSON 绕过；
- 错误信息不包含 AWS/COS 密钥；
- 渲染任务只允许访问它自己的 renderId/bucketName；
- 不能因为刷新页面而重复提交同一个 clientRequestId。

## 17. MVP 完成定义（Definition of Done）

只有全部条件满足才可以把状态改为“已完成”：

1. 工程列表、多个工程、版本列表和恢复可用。
2. 完整工程不再依赖 localStorage 保存。
3. schema 1/2 工程可迁移到 schema 3，未知 schema 有清晰阻断。
4. 工程修改都经过 Command Bus；拖拽、批量导入和 shot 操作有明确事务边界。
5. item、shot camera 和 Advanced transform 使用同一 Property 求值入口。
6. motion、shot、dialogue、preview 和 validate 可以由 UI 完成，不要求用户改 JSON。
7. RenderJob 在刷新、短暂网络失败、取消、失败和重试后仍有确定状态。
8. 渲染任务、输入快照、输出视频和 manifest 可以互相追溯。
9. 缺失素材、字体、ffmpeg、COS、Lambda 等前置条件在提交前可见。
10. pnpm test、pnpm typecheck、pnpm build、pnpm lint 和固定浏览器验收结果已记录。
11. 所有未实现的 AE 能力都有明确的 capability flag 或隐藏入口。
12. 文档中的端到端流程可以由一名内部用户在不调用底层 API 的情况下完成。

## 18. MVP 之后的路线

只有 MVP 完成并稳定运行后，才考虑以下 P1/P2：

- Render DAG、节点级 hash 和缓存失效；
- pre-compose 公开参数和模板版本；
- 更完整的 mask/matte/adjustment UI；
- 音素级口型和角色声线分配；
- PSD/受限 AE 交换包；
- 多用户工程数据库、权限和协作；
- Graph Editor、表达式替代语言、3D 和变形 runtime。

这些项目不能反向扩大本 MVP 的验收范围，也不能以“数据结构已经存在”宣称产品能力已经完成。
