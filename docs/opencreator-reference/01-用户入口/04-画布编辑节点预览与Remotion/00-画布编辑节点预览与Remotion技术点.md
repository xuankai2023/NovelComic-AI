# 画布编辑、节点预览与 Remotion：这里面有哪些技术点

先把这块拆开。它不是“打开画布就跑模型”，也不是“在 Preview 上画一笔就改掉生成结果”。这篇从项目已经进入画布 store 之后讲起：React Flow 怎么改图并保存，Preview 怎么按 `nodeTag` 看结果，组装节点怎么把时间线交给独立的 Remotion。

打开画布、补拉历史结果、点击 Run，仍看 [02-画布登录门禁与项目加载](../02-画布登录门禁与项目加载/01-画布登录门禁与项目加载.md)。

主链是改图和保存：

```text
FlowStore 已有 nodes / edges
  → Flow 编辑节点和连线
  → pin 兼容、连接数、环检测
  → 撤销记在内存
  → syncManager 写入 IndexedDB
  → PATCH /api/v2/flow/project
```

从这张图上再分出两条旁路：

```text
切到 Preview
  → 按 nodeTag 取每个节点最新成功结果
  → 标注或运动轨迹导出 PNG
  → 上传 COS
  → 以 control_reference 交给 Composer

assembleNow 打开编辑器
  → iframe 发送 init_data
  → Remotion 编辑 tracks / items / assets
  → payload_change 写回 assemblePayload
  → 导出另走 POST /api/render，得到 renderId + bucketName
```

所以图能改、结果能看、标注能交回 Composer、剪辑能导出，是四件事。

OpenCreator 参考：

- 画布容器：[Canvas.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/Canvas.tsx)
- React Flow：[Flow.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/Flow.tsx)
- 画布 store：[flow.store.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/runtime/flow.store.ts)
- 自动保存：[sync-manager.ts](../../../../../opencreate/opencreator-frontend/src/lib/sync-manager.ts)
- Preview：[canvas-preview-view.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/canvas-preview-view.tsx)
- 聚合：[build-preview-items.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/build-preview-items.ts)
- 局部标注：[use-preview-local-edit.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/use-preview-local-edit.ts)
- 组装节点：[assembleNowNode.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/custom_nodes/toolsNode/assembleNowNode.tsx)
- iframe：[iframe_editor.tsx](../../../../../opencreate/opencreator-frontend/src/components/remotion/iframe_editor.tsx)
- Remotion 编辑器：[editor.tsx](../../../../../opencreate/opencreator-remotion/src/editor/editor.tsx)
- 工程类型：[types.ts](../../../../../opencreate/opencreator-remotion/src/editor/state/types.ts)
- Lambda 渲染：[route.ts](../../../../../opencreate/opencreator-remotion/app/api/render/route.ts)

---

## 1. 可编辑、只读、Preview 是三种页面状态

`Canvas` 看 `isReadonly` 决定 Flow 的 mode。

```text
isReadonly = false
  → Flow mode = editor
  → 可以拖、连、删、撤销、自动保存

isReadonly = true
  → Flow mode = preview
  → 编辑回调不挂，不记脏，不自动保存
```

分享页进入时会把 `isReadonly` 设为 true。非 owner 且分享类型不是 `collaborative` 时，加载项目也会把它设为 true。

可编辑画布还有一个外壳 `viewMode`：`canvas` 或 `preview`。它为 `preview` 时，只是在 React Flow 上盖 `CanvasPreviewView`。这时 Flow 仍是 `editor`。只读页没有视图切换，所以不挂这层覆盖层。

大图在编辑态会打开虚拟化。节点超过 40、边超过 60，或图片 / 视频 / 音频节点超过 12 时，Flow 加上 `canvas-performance-mode`，并设置 `onlyRenderVisibleElements`。

---

## 2. 图、撤销、结果、时间线要分开

| 名字 | 放在哪里 | 表示什么 |
| --- | --- | --- |
| `nodes` / `edges` | `useFlowStore`，再进 IndexedDB 和 Publisher | 正在编辑的图 |
| `opUndoStack` | 只在内存，默认最多 20 步 | 撤销。刷新后清空 |
| `historyResults` | 本次打开画布后的 session | Preview 优先读的运行产物 |
| `getNodeResults` | `all_batch_fetch` 的缓存 | 服务端已有结果 |
| `assemblePayload` | 组装节点 data 上的字符串 | iframe 回写的剪辑快照，随图一起保存 |
| `UndoableState` | Remotion 编辑器，可进 `localStorage` | 时间线工程 |
| `renderId` + `bucketName` | Remotion Lambda | 一次视频渲染 |
| `flow_task_id` | Publisher workflow run | 一次画布执行 |

`historyResults` 是结果历史，撤销看 `useFlowUndoRedo`。`renderId` 也不是 `flow_task_id`。

---

## 3. 连线分两层校验

拖线过程中，`isValidConnection` 只做两件事：拒绝自环，并用 [handleRules.ts](../../../../../opencreate/opencreator-frontend/src/lib/handleRules.ts) 看 pin 是否兼容。

比较的是 handle id。`subject` 和 `style` 先归一成 `image`，所以这三种可以互连。`text`、`video`、`audio` 只能连同名 handle。不兼容时线接不上，也没有 toast。

松手后，`onConnect` 再做连接数和环检测。

环检测在 [cycleDetection.ts](../../../../../opencreate/opencreator-frontend/src/lib/cycleDetection.ts)。它只看已经存在的边，从新边的 target 往下走，能走回 source 就是环。成环时提示「检测到循环，无法连接」，不加边。自环在这一步返回 false，因为前面已经拒绝。

连接数在 [connectionLimits.ts](../../../../../opencreate/opencreator-frontend/src/lib/connectionLimits.ts)。只数同一个 target 节点上的同一个 target handle。表里没有的节点类型不限制。`checkConnectionLimit` 返回 true 表示要阻止，这时直接 return，没有 toast。

| 节点 type | handle | 上限 | 特例 |
| --- | --- | --- | --- |
| `scriptSplit` | text | 1 | |
| `imageUpscaler` / `backgroundEditor` / `relight` / `imageAngleControl` | image | 1 | |
| `videoUpscaler` / `videoToVideo` | video | 1 | |
| `klingMotionControl` | image、video | 各 1 | |
| `videoLipSync` | video、audio | 各 1 | |
| `imageAudioToVideo` | image、audio | 各 1 | |
| `videoMaker` | image | 8 | 选了 `opencreator/image-to-video/minimax-h3` 时为 9 |
| `omniVideoGeneration` | image 9、video 3、audio 3 | | 只选了 `opencreator/image-to-video/seedance-2.5` 时为 image 30、video 10、audio 10 |

复制节点用 `checkEdgeLimit`，超限的边直接丢掉。快捷菜单和双击模板加边时，没有再跑环检测和连接数。

---

## 4. 撤销在内存里，而且只比较一部分字段

`saveNodesToHistory` 写入 `opUndoStack`，入栈 debounce 1 秒，连续改动只留最后一张快照。新操作清空 redo。上限是 `MAX_UNDO_STEPS`，默认 20，可用 `VITE_MAX_UNDO_STEPS` 改。

会入栈的是：节点松手、新增、尺寸变化、边变化、删除、连线成功、修改输入文本、复制、分组和解组。

框选、拖拽过程中的位移、缩放不入栈。`updateNodeData` 改模型、标签和多数节点字段时会 `setNodes`，因此会自动保存，但撤销回不去。`createNode` 当下也不入栈，要等随后的尺寸变化。

比较是否变化时，`getSimplifiedWorkflowNode` 只看 `inputText`、`inputHint`、便签字段和尺寸。`selectedModels`、`imageBase64`、`modelConfigs` 变了，撤销栈也认为节点没变。

加载项目时先 `initOpUndoStack` 放一条基线。`canUndo` 要求栈长度大于 1，基线留着。undo / redo 写回时 `persist: false`，再 `markFlowDirty`，交给自动保存落盘。栈本身不进 IndexedDB，也不进 Publisher。

---

## 5. syncManager 保存的是图

对外状态是：

```text
synced | pending | failed | offline
```

内部虽然有 `isSyncing`，界面上仍显示 `pending`。

```text
saveAndSync
  → 本地 IndexedDB，sync_status = pending
  → 在线则 PATCH /api/v2/flow/project
  → body: { flow_id, nodes, edges }
  → 成功则 synced
  → 失败则 2s、4s、8s、16s、30s 重试
```

空图有保护：这次快照是空的、调用方又没允许空写、本地已经有内容时，直接返回，避免项目还没加载完就把服务端写成空图。自动保存那次调用允许空写。

触发点：

- `persistRevision` 变化后 1.5 秒。拖拽中 `persist: false`，松手才记脏。
- Cmd/Ctrl+S，800ms debounce。只读、未 ready、没有 `flowId` 时跳过。
- 离开页面时立即保存。
- 打开项目时，若本地是 `pending` 或 `failed`、曾经同步过、`server_updated_at` 等于服务端 `updated_at`、本地 `nodes` 不为空，先用本地图再同步。这和 [第 02 章](../02-画布登录门禁与项目加载/01-画布登录门禁与项目加载.md) 的草稿合并是同一套条件。

写入前 `getPersistableFlowSnapshot` 去掉 `selected`、`measured`、`dragging`，以及 data 里的 `status`、`generated_data`、`llm_output`、`local_file` 等运行时字段。

`!isWorkflowReady` 或 `isReadonly` 时不增加 `persistRevision`。

Publisher 的更新是异步的：接口马上返回成功，响应里经常没有 `updated_at`。前端仍把本地标成 synced。

封面走另一条接口：

```text
PATCH /api/v2/flow/project/details
```

`use-auto-save-flow.ts` 已整文件注释，现网保存以 `syncManager` 为准。

---

## 6. Preview 盖在画布上，按 nodeTag 取最新结果

`CanvasPreviewView` 在 `viewMode === 'preview'` 时可见。切走后组件还在，只是不接收点击，避免来回切换时重建。`AgentCanvasLayout` 默认就是 Preview。结果卡可以带 `nodeId` 调用 `showCanvasPreview`，强制打开并聚焦。

Preview 内部还有自己的 `viewMode`：`gallery` 或 `grid`。除 `scene-video` 默认 grid 外，其它桶默认 gallery。外壳的 `canvas | preview` 和这个字段不是一回事。

| 状态 | 含义 |
| --- | --- |
| `activeNodeTag` | 当前桶，初始 `cut` |
| `cursorMode` | `move`、`comment`、`motion` |
| `currentPage` | 当前桶里的页码，从 1 开始 |
| `historyResults` | 聚合时读取。标注和轨迹不写它 |

一个结果都没有时只显示空态。

桶来自 [nodeTags.ts](../../../../../opencreate/opencreator-frontend/src/constants/nodeTags.ts)，另外加 `cut`：

| 组 | nodeTag |
| --- | --- |
| text | `script`、`storyboard-prompt`、`motion-prompt`、`asset-prompt` |
| image | `character`、`environment`、`prop`、`storyboard` |
| video | `scene-video` |
| audio | `voiceover`、`bgm` |
| 剪辑 | `cut` |

`assembleNow` 进 `cut`。没有合法 tag 时，text 回退 `script`，image 回退 `storyboard`，video 回退 `scene-video`，audio 回退 `bgm`。

`buildPreviewItemsByNodeTag` 的输入是 `nodes`、`historyResults`、`getNodeResults`。

输入节点单独展示：文本读 `inputText`，图片读 `imageBase64`，视频读 `inputVideo`，音频读 `inputAudio`。带 `controlInputKind = motionTrajectory` 的图片输入不进任何桶，那是轨迹回填出来的参考图。

生成结果取 session 最新一条，没有再取服务端最新一条。排队、运行中、失败的 output 不展示。`splitText` 拆成多条文本。每个节点只展示最新一次运行。

剪辑还有虚拟节点 `__cut__`。session 最新一条没有 URL 时用服务端；有 URL 时按 CDN 地址对齐服务端那条，避免旧 cut 盖住新的。

---

## 7. 标注和轨迹都交回 Composer，原结果留着

`comment` 只在 gallery 的图片、视频、剪辑上进入画笔。文本结果打开的是右侧编辑，不涂抹。

标注提交：

```text
导出 PNG
  → postUploadFile，skipPreprocess
  → POST /api/v2/cos/presign
  → PUT presigned_url
  → addRemoteAttachment
  → appendText
  → 聚焦 Composer
  → 清空叠加层
```

附件是 `tag: control_reference`，`controlSource: preview_product_control`，并带 `sourceNodeId`、`sourceResultId`、`sourceOutputIndex`。这一步不写 `historyResults`，也不改原来的 `mediaUrl`。用户还要自己在 Composer 里发送。

文本「编辑保存」是另一条：`PATCH /api/v3/result`，body 含 `flow_id`、`node_id`、`result_id`、`result`，然后更新 session 历史。

`motion` 只对普通图片生效，轨迹自己合成出来的 item 不能再套一次。提交后同样上传 COS，附件的 `controlSource` 是 `motion_path`。同时新建或更新一个 `imageInput`：

```text
controlInputKind = motionTrajectory
motionPathSourceItemId = 当前 PreviewItem.id
```

已有同一 `motionPathSourceItemId` 的输入节点就更新它的 `imageBase64`，否则新建在源节点左侧。因为带了 `motionTrajectory`，这张图不会再进 Preview。

连线发生在 Composer 真正发送时。附件的 `onSend` 从结果节点向下游找第一个兼容的 image pin，再过兼容性、重复边、连接数和环检测。连不上就提示，不硬连。轨迹说明文字只写进 Preview 里那条本地合成 item，不写进 Composer 文本框。

---

## 8. iframe 回写的是 assemblePayload 字符串

`assembleNow` 的 Imports「开始编辑」和 Auto Edit 的 Open Editor，都会：

```text
setRemotionNodeId(id)
localStorage['OP_REMOTION_NODE_ID'] = id
```

`CanvasProvider` 在有 `remotionNodeId` 时挂全屏 `RemotionFrame`。iframe 的 `src` 只有 origin：

```text
NEXT_PUBLIC_IFRAME_ORIGIN
默认 https://dev-remotion.opencreator.io
```

入站、出站都校验这个 origin。消息都带 `source: "remotion-editor"`。

Frontend 只发出 `init_data`：

```text
project_name = inputHint
assets = getRemotionNodeData(nodeId)
assemblePayload = 节点上的字符串
```

这里的 `assets` 是 `AssembleAsssetItem[]`，由组装节点扫描入边得到：`type`、`value`、可选的 `preview`、`duration`、`resultId`、`nodeId`。它不是 Remotion 时间线里的 `UndoableState.assets`。节点 data 上的 `assembleAssets` 不进这条消息。

Frontend 接收：

| type | 行为 |
| --- | --- |
| `close_window` | 清空 `remotionNodeId`，卸掉 iframe |
| `payload_change` | 把 `payload` 写入该节点 `data.assemblePayload` |
| `posthug` | 交给 PostHog |

`useCanvasProvider` 里的 `changeRemotionNodeData` 是空函数，iframe 也没有调用它。回写就是 `payload_change` 之后的 `setNodes`。相同字符串不会重复写。

`opencreator-remotion` 当前没有 `message` 监听，也不会主动发 `payload_change`。协议在 Frontend。迁移时要在编辑器里补上：接收 `init_data`，工程变化时发 `payload_change`，关闭时发 `close_window`。

---

## 9. Remotion 工程存在浏览器里

`UndoableState` 的字段是 `tracks`、`items`、`assets`、`fps`、`compositionWidth`、`compositionHeight`、`deletedAssets`。默认 30fps，宽 736，高 414，轨道和素材为空。

`tracks` 的每一条有 `id`、`items`、`hidden`、`muted`。`assets` 和 `items` 都是以 id 为 key 的字典。这是时间线，随 `assemblePayload` 回到画布节点，Publisher 不解析它。

`ContextProvider` 挂在 Remotion 应用根上。初始化顺序是：切语言用的 sessionStorage，然后 URL `#state=`，然后 localStorage。`initialized` 之前不渲染编辑器。

`FEATURE_SAVE_BUTTON` 当前是 `true`。工程 key：

```text
localStorage['remotion-editor-starter-state-v3']
```

把它设为 `false` 时，没有语言切换快照就不读 URL 和 localStorage 工程；`loadState()` 和 `saveState()` 抛出 `Save button feature flag is disabled`；保存按钮和保存快捷键也不挂。素材还在上传时，`saveState` 同样拒绝保存。

这份 localStorage 不是 `PATCH /api/v2/flow/project`。画布侧要留住的剪辑快照，仍是节点上的 `assemblePayload`。

---

## 10. `/api/render` 和 `/api/render2` 是两条导出

独立编辑器打的是 iframe 自己的 Next 服务。

```text
POST /api/render
body: compositionWidth, compositionHeight, fps, tracks, items, assets, codec
codec 只能是 h264

成功: { type: "success", bucketName, renderId }

POST /api/progress
body: { bucketName, renderId }
```

进度大约每 2 秒查一次。`done` 里的 `outputFile` 会尽量拷到 COS 的 `renders/{renderId}/{outputName}`，文件名形如 `cut_video_yyyyMMddHHmmss.mp4`。

Lambda 函数名由磁盘 10240MB、内存 3009MB、超时 240 秒这组数字通过 `speculateFunctionName` 算出来。composition 名是 `Main`，site 名是 `remotion-editor-starter`。deploy 必须用同一组数字。

画布里的 `AutoEditor` 仍在用，组装节点默认 tab 就是 `auto_edit`。它用 `@remotion/player` 在节点里预览。Download 走另一个 host：

```text
REMOTION_BASE_URL
默认 https://remotion-api-dev.opencreator.io

POST /api/render2
GET  /api/render2?id={video.id}&type=VIDEO_RENDERING
```

进度状态是 `PENDING`、`PROCESSING`、`COMPLETED`、`ERROR`。任务 id 是 `video.id`。这条实现不在 `opencreator-remotion` 仓库里，`useRemotionRender` 也只给 AutoEditor 的下载用。

| | 独立编辑器 | AutoEditor |
| --- | --- | --- |
| host | `NEXT_PUBLIC_IFRAME_ORIGIN` | `REMOTION_BASE_URL` |
| 提交 | `POST /api/render` | `POST /api/render2` |
| 进度 | `POST /api/progress` | `GET /api/render2` |
| 任务 id | `renderId` + `bucketName` | `video.id` |
| 成片 | `outputFile` | `video.url` |

---

## 动手前要有的东西

### 前端

- 第 02 章已经把 `nodes` / `edges` 写入 `useFlowStore`，`isWorkflowReady` 会变成 true
- `@xyflow/react` 和它的基础 CSS
- IndexedDB `OpenCreatorDB.workflows`
- `historyResults` 和 `NodeResultsProvider`
- `POST /api/v2/cos/presign`
- Composer 的 `addRemoteAttachment` 和 `appendText`
- `VITE_IFRAME_ORIGIN` 与 `VITE_REMOTION_URL` 两个不同地址

### 后端

- `PATCH /api/v2/flow/project`，按当前用户更新 nodes / edges
- `PATCH /api/v2/flow/project/details`，只更新封面等详情
- `POST /api/v3/result/all_batch_fetch`
- `PATCH /api/v3/result`，给 Preview 文本保存

### Remotion

- `UndoableState` 和 `ContextProvider`
- 与 Frontend 对齐的 `init_data`、`payload_change`、`close_window`
- `POST /api/render` 和 `POST /api/progress`

运行中的节点状态看 workflow run。Preview 只展示已经成功的结果，Remotion 进度只表示这一次 mp4 渲到哪里。
