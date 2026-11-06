# 画布编辑、节点预览与 Remotion question

## 核心概念

- 这章是不是打开画布就跑模型？
  - 不是。
  - 这章从 `nodes` / `edges` 已经进入 store 之后开始。
  - Flow 只改图并保存。
  - Preview 只看已经成功的结果。
  - Remotion 只编辑和导出时间线。

- 改图、看结果、回填控制图、导出成片为什么要分开？
  - 改图写的是 `nodes` / `edges`。
  - 看结果读的是 `historyResults` 或 `getNodeResults`。
  - 回填写的是 Composer 附件，原生成结果留在原地。
  - 导出得到的是 `renderId` 或 `video.id`，不是 `flow_task_id`。

- `assemblePayload` 是什么？
  - 它是组装节点 `data` 上的字符串。
  - 里面放的是 Remotion 时间线 JSON。
  - 它跟着普通 `PATCH /api/v2/flow/project` 保存。
  - Publisher 不把它解析成 tracks 或 items。

- 撤销栈为什么刷新后没了？
  - `opUndoStack` 只在内存。
  - 它不进 IndexedDB，也不进 Publisher。
  - 刷新后图从上次保存恢复，撤销基线重新初始化。

## 画布状态

- 只读和 Preview 是不是同一个状态？
  - 不是。
  - `isReadonly` 把 Flow 切成 `preview`，编辑回调不挂。
  - 外壳 `viewMode === 'preview'` 只是盖一层 Preview。
  - 可编辑画布切到 Preview 时，Flow 仍是 `editor`。

- 只读页为什么不挂 Preview 覆盖层？
  - 只读页没有画布 / 预览切换。
  - 它只展示不能改的 Flow。
  - 标注、轨迹和组装编辑都属于可编辑画布。

- 未 ready 时为什么不能自动保存？
  - 项目还没加载完时，store 里的图可能是空的。
  - 这时记脏会把服务端项目写成空图。
  - `isWorkflowReady` 为 false，或 `isReadonly` 为 true，都不增加 `persistRevision`。

## 连线

- 连线为什么分两层？
  - 拖动中的 `isValidConnection` 只看自环和 pin 兼容。
  - 松手后的 `onConnect` 再看连接数和环。
  - 兼容表和上限表不能写进 `Flow.tsx`。

- `text` 能不能连到 `image`？
  - 不能。
  - `text`、`video`、`audio` 只能连同名 handle。
  - `image`、`subject`、`style` 可以互连，因为后两个先归一成 `image`。

- 成环和超限的表现为什么不一样？
  - 成环要提示，并且不加边。
  - 超过同一个 target handle 的上限时，直接不接上。
  - `checkConnectionLimit` 返回 true 表示阻止。

- 连接数按什么计数？
  - 只数同一个 target 节点上的同一个 target handle。
  - 表里没有的节点类型不限制。
  - 复制节点时，超限边直接丢掉。

## 撤销和保存

- 哪些改动会进入撤销栈？
  - 节点松手、新增、尺寸变化、边变化、删除、连线成功、修改输入文本、复制。
  - 框选、拖拽过程中的位移、缩放不入栈。
  - 只改模型或标签时会自动保存，但不一定能撤销回去。

- 撤销写回为什么要 `persist: false`？
  - 写回本身不要立刻当成一次新的用户编辑。
  - 随后 `markFlowDirty` 才会让 1.5 秒自动保存把它落盘。
  - 这样撤销栈和保存队列不会互相触发。

- 一次保存的顺序是什么？
  - 先做空图保护。
  - 再把本地草稿写成 `pending`。
  - 然后 `PATCH /api/v2/flow/project`。
  - 失败后按 2 秒、4 秒、8 秒、16 秒、30 秒重试。

- 断网时状态是什么？
  - 界面是 `offline`。
  - 本地仍保留 pending 草稿。
  - 恢复在线后可以补同步。

- 封面为什么不走 `saveAndSync`？
  - 封面不是 nodes / edges。
  - 它走 `PATCH /api/v2/flow/project/details`。
  - 图保存失败不应该和封面更新绑在同一次请求里。

- 保存前要去掉哪些字段？
  - 节点上的 `selected`、`measured`、`dragging`。
  - data 里的 `status`、`generated_data`、`llm_output`、`local_file`。
  - 这些是运行时字段，不应该污染项目定义。

## Preview

- Preview 的输入是什么？
  - `nodes`。
  - `historyResults`。
  - `getNodeResults`。
  - 每个节点只取最新一条，session 优先于服务端。

- 运行中和失败的结果为什么不进桶？
  - Preview 展示的是可继续创作的成功产物。
  - 排队、运行、失败都不算可预览结果。
  - 一个结果都没有时只渲染空态。

- `nodeTag` 怎么决定桶？
  - text 进剧本、分镜提示、动作提示、资产提示。
  - image 进角色、环境、道具、分镜。
  - video 进视频，audio 进配音或背景音乐。
  - `assembleNow` 固定进 `cut`。

- 为什么 `motionTrajectory` 图片不进 Preview？
  - 它是轨迹回填出来的参考图。
  - 它不是新的生成结果。
  - 再放进桶会造成控制图和原图混在一起。

## 标注和轨迹

- 标注会不会改掉原结果？
  - 不会。
  - 它导出 PNG，上传 COS，再交给 Composer。
  - 原结果的 `mediaUrl` 和 `historyResults` 保持不变。

- 标注附件用什么来源？
  - `tag` 是 `control_reference`。
  - `controlSource` 是 `preview_product_control`。
  - 还要带 `sourceNodeId`、`sourceResultId`、`sourceOutputIndex`。

- 文本保存为什么不走标注上传？
  - 文本改的是已有结果内容。
  - 它请求 `PATCH /api/v3/result`。
  - 成功后再更新 session。
  - 标注和轨迹只上传新的控制图。

- 轨迹什么时候才连边？
  - 提交时只新建或更新 `imageInput`。
  - 这个节点带 `controlInputKind: motionTrajectory`。
  - Composer 真正发送时，`onSend` 才向下游找兼容的 image pin。
  - 发送时还要再跑兼容、重复边、连接数和环检测。

## iframe

- 打开独立编辑器时传什么？
  - 只发 `init_data`。
  - 字段只有 `project_name`、`assets`、`assemblePayload`。
  - 这里的 `assets` 是入边素材，不是 Remotion 时间线里的 `UndoableState.assets`。

- 父页面怎么确认消息来自编辑器？
  - `source` 必须是 `remotion-editor`。
  - `origin` 必须等于 iframe origin。
  - 不满足这两条的消息直接忽略。

- `payload_change` 写到哪里？
  - 写到当前组装节点的 `data.assemblePayload`。
  - 相同字符串不重复写。
  - 随后由普通自动保存带走。
  - `changeRemotionNodeData` 保持空函数，不负责回写。

- `close_window` 做什么？
  - 清空 `remotionNodeId`。
  - 卸掉全屏 iframe。
  - 不删除节点，也不清空 `assemblePayload`。

- iframe 的 `src` 为什么不能填 `REMOTION_BASE_URL`？
  - `REMOTION_BASE_URL` 是 AutoEditor 的 render2 host。
  - iframe 只加载独立编辑器 origin。
  - 两个地址混用会把节点内下载和独立编辑器导出打到同一个服务。

## Remotion 工程

- 默认工程是什么？
  - 30fps。
  - 宽 736，高 414。
  - tracks、items、assets 初始为空。

- 工程存在哪里？
  - `FEATURE_SAVE_BUTTON` 打开时，存在 localStorage 的 `remotion-editor-starter-state-v3`。
  - 关闭时，`loadState` / `saveState` 抛 `Save button feature flag is disabled`。
  - 这份本地工程不能代替节点上的 `assemblePayload`。

- 编辑器收到 `init_data` 后怎么恢复？
  - 有合法 `assemblePayload` 时，直接恢复时间线。
  - 没有时，用父页面传入的素材生成 assets、items 和 tracks。
  - 工程变化后发 `payload_change`，关闭时发 `close_window`。

## 两条导出

- 独立编辑器导出打哪个接口？
  - `POST /api/render`。
  - body 含宽高、fps、tracks、items、assets。
  - codec 固定 `h264`。
  - 成功返回 `renderId` 和 `bucketName`。

- 进度怎么查？
  - 独立编辑器大约每 2 秒 `POST /api/progress`。
  - body 是 `bucketName` 和 `renderId`。
  - `done` 后用 `outputFile` 下载 mp4。

- AutoEditor Download 打哪个接口？
  - `POST /api/render2`。
  - 进度是 `GET /api/render2?id={video.id}&type=VIDEO_RENDERING`。
  - 完成时读取 `video.url`。
  - 它不调用 `/api/render`，也不调用 `/api/progress`。

- 为什么两个任务 id 不能混查？
  - `renderId` 只属于 Lambda 渲染。
  - `video.id` 只属于 render2。
  - 用错 id 会把两条进度当成同一次导出。

- Lambda 规格为什么要固定？
  - composition 名是 `Main`。
  - site 名是 `remotion-editor-starter`。
  - 超时 240 秒，内存 3009MB，磁盘 10240MB。
  - `functionName` 由这组数字通过 `speculateFunctionName` 算出来，deploy 必须保持一致。

## NovelComic 当前实现自查

- 只看本章，NovelComic 当前做到了什么？
  - 可编辑画布能改图、连线、删除、复制，只读画布不挂编辑回调。
  - 改图后先写 IndexedDB，再 PATCH 项目。
  - Preview 能按桶展示最新成功结果，没有结果时是空态。
  - 标注和轨迹能把控制图交回 Composer，文本保存单独走结果接口。
  - 组装节点能打开 iframe，并把 `payload_change` 写回 `assemblePayload`。
  - 独立编辑器和 AutoEditor 的渲染接口已经分开。

- 当前能不能算完整版完成？
  - 可以。
  - 主链路和完整版行为都已经接上：节点内 30fps 预览、Imports、时间线删除和撤销、初始化顺序、封面 details、快捷键和离开页面保存、Preview 页脚和 Vary。
  - 真实云渲染仍要配置 AWS、COS 和 PostHog。没有配置时导出地址回退到 Lambda 原文件。

- 完整版里封面和快捷键怎么保存？
  - Cmd/Ctrl+S 等待 800ms，离开页面立刻调用 `saveAndSync`。
  - 封面从最新成功图片或视频取 URL，请求 `PATCH /api/v2/flow/project/details`。
  - 这次请求不修改 nodes / edges。

- 当前测试覆盖了哪些？
  - 连线规则、保存清洗、同步重试、脏标记和撤销写回。
  - Preview 分桶、空态、标注、轨迹和文本保存。
  - `assemblePayload` 默认值和入边素材收集。
  - Remotion 消息往返、保存开关和 render payload 校验。
  - render2 payload 形状，以及独立编辑器不提供 `/api/render2`。

- 当前还缺什么测试？
  - 浏览器里真实拖拽、连线、撤销和刷新恢复。
  - 断网后恢复补同步。
  - iframe 和父页面的真实 `postMessage`。
  - 配好 AWS 后的真实 Lambda 导出和 mp4 下载。
  - AutoEditor 对真实 `/api/render2` 的轮询。

- 怎么判断本章主链路验收通过？
  - 可编辑画布能拖、连、删、复制，只读画布这些操作不生效。
  - `text` 不能连到 `image`，`image` 可以连 `subject` 和 `style`。
  - 成环被拒绝并有提示，超限的线接不上。
  - Cmd/Ctrl+Z 能撤销，刷新后撤销栈清空，图按上次保存恢复。
  - 改图后 IndexedDB 先 pending，再 PATCH 项目；离线是 offline。
  - Preview 按 nodeTag 显示最新成功结果，没有结果时是空态。
  - 标注后原结果不变，Composer 收到 `preview_product_control`。
  - 轨迹生成 `motionTrajectory` 图片输入，发送时才连边。
  - `payload_change` 写回节点字符串，`close_window` 关闭全屏。
  - AutoEditor 仍用 `video.id`，独立编辑器仍用 `renderId`。

- 怎么判断本章完整版验收通过？
  - 主链路验收全部通过。
  - 节点内能用播放器预览，Download 能轮询到 `video.url`。
  - iframe 里能编辑完整时间线，关闭后父页面保留 `assemblePayload`。
  - `FEATURE_SAVE_BUTTON` 打开时，工程在 `remotion-editor-starter-state-v3`。
  - `POST /api/render` 返回 `renderId` 和 `bucketName`，进度到 `done` 后能下载 mp4。
  - 封面仍走 details，离开页面能立即保存，两条进度互不查询。
