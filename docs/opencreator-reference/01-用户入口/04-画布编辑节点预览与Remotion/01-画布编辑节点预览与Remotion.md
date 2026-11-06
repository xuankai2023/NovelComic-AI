# OpenCreator 是怎么做画布编辑、节点预览与 Remotion 的

## 一、先说结论

项目进 store 之后，OpenCreator 把编辑分成三条链。改图会保存，看结果和做剪辑都从这张图出发，但它们不创建 workflow run。

```text
FlowStore 已有 nodes / edges
  → Flow 改节点和连线
  → 校验 pin、连接数、环
  → 内存撤销
  → IndexedDB pending
  → PATCH /api/v2/flow/project

切到 Preview
  → 按 nodeTag 展示最新成功结果
  → 标注或轨迹变成 Composer 的 control_reference

assembleNow
  → iframe init_data
  → payload_change 写回 assemblePayload
  → 导出走 POST /api/render 或 AutoEditor 的 POST /api/render2
```

必须分开的是：

- 图编辑：`Flow.tsx` 改 `nodes` / `edges`。
- 图保存：`syncManager` 写 IndexedDB，再 PATCH 项目。
- 结果预览：`CanvasPreviewView` 读已有结果。
- 局部回填：标注和轨迹交给 Composer，原生成结果留在原地。
- 剪辑：`assemblePayload` 是时间线字符串。`renderId` 是 Lambda 任务，`flow_task_id` 是画布 run。

规则细节在 [00-画布编辑节点预览与Remotion技术点.md](./00-画布编辑节点预览与Remotion技术点.md)。这篇按文件讲谁调用谁。

---

## 二、前端必须有的文件

按用户在画布上操作的顺序背。第 8 步才把图写到 Publisher。第 14 步才打开 Remotion。第 18 步的 `/api/render2` 和第 17 步的 `/api/render` 是两套接口。

1. `src/features/canvas-workflow/runtime/flow.store.ts`：图、撤销栈、脏标记。
2. `src/features/canvas-workflow/runtime/useReactFlow.tsx`：创建 store，并在脏标记变化后自动保存。
3. `src/features/canvas-workflow/components/Canvas.tsx`：区分编辑、只读和 Preview。
4. `src/features/canvas-workflow/components/Flow.tsx`：把 React Flow 的回调接到 store。
5. `src/lib/handleRules.ts`、`src/constants/pinConfigs.ts`、`src/lib/connectionLimits.ts`、`src/lib/cycleDetection.ts`：连线规则。
6. `src/features/canvas-workflow/hooks/flow/use-flow-undo-redo.ts`：撤销和重做。
7. `src/features/canvas-workflow/hooks/flowAction/use-create-node.tsx`、`hooks/flow/use-duplicate-nodes.ts`、`hooks/flow/use-hotkey-copy-node.tsx`：新建、复制、粘贴。
8. `src/lib/sync-manager.ts`、`src/api/modules/flow.ts`：本地草稿和 `PATCH /api/v2/flow/project`。
9. `src/features/canvas-workflow/components/panels/preview/build-preview-items.ts`：按 `nodeTag` 聚合。
10. `src/features/canvas-workflow/components/panels/canvas-preview-view.tsx`：Preview 覆盖层。
11. `src/features/canvas-workflow/components/panels/preview/use-preview-local-edit.ts`：局部标注。
12. `src/features/canvas-workflow/components/panels/preview/use-preview-motion-path.ts`：运动轨迹。
13. `src/features/canvas-workflow/components/custom_nodes/toolsNode/assembleNowNode.tsx`：收集素材，打开编辑器。
14. `src/components/remotion/iframe_editor.tsx`：iframe 协议。
15. `src/features/canvas-workflow/runtime/useCanvasProvider.tsx`：持有 `remotionNodeId`，挂上 iframe。
16. `src/components/remotion/AutoEditor/*`：节点内预览。
17. `opencreator-remotion` 的编辑器、状态和 `app/api/render/route.ts`。
18. `src/hooks/useRemotionRender.ts`、`src/api/modules/assemble.ts`：AutoEditor 的 `/api/render2`。

### `src/features/canvas-workflow/runtime/flow.store.ts`

OpenCreator 源码：[flow.store.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/runtime/flow.store.ts)

`createFlowStore()` 持有 `nodes`、`edges`、`isReadonly`、`isWorkflowReady`、`opUndoStack`、`opRedoStack`、`persistRevision`、`selectedWorkflowID`、`isActiveKeyMap`。

`setNodes` / `setEdges` 默认会记脏。未 ready 或只读时，脏标记补丁是空对象，`persistRevision` 不变。`saveNodesToHistory` 用简化后的节点做比较，所以改模型配置会保存，却不一定成为一次撤销。

### `src/features/canvas-workflow/runtime/useReactFlow.tsx`

OpenCreator 源码：[useReactFlow.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/runtime/useReactFlow.tsx)

导出 `FlowStoreProvider` 和 `useFlowStore`。

它在这里做两件事：`syncManager.init(patchFlowProject)`，以及订阅 `persistRevision`，1.5 秒后 `saveAndSync`。首页模板预览会关掉自动保存，并传入 `initialReadonly`。

### `src/features/canvas-workflow/components/Canvas.tsx`

OpenCreator 源码：[Canvas.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/Canvas.tsx)

根容器只读 `isReadonly`，自己不改图。

- 只读：`Flow mode="preview"`，有只读底栏，没有 `CreatorShell`，也没有 Preview 覆盖层。
- 可编辑：`Flow mode="editor"`，并把 `runAll` / `stopWorkflow` 传下去。`viewMode === 'preview'` 时盖上 `CanvasPreviewView`。

同一文件里的 `useAutoSaveFlowSnapshot` 保存封面，请求 `PATCH /api/v2/flow/project/details`。只读时封面保存也停。

### `src/features/canvas-workflow/components/Flow.tsx`

OpenCreator 源码：[Flow.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/Flow.tsx)

组件名是 `FlowCanvas`。`mode === 'preview'` 时，变更回调都是 `undefined`，节点不能拖、不能连，撤销和保存快捷键直接返回。

编辑态：

```text
onNodesChange
  → 拖拽中不入历史，也不记脏
  → 松手、新增、尺寸变化才 debounce 1 秒入撤销栈
  → setNodes

onEdgesChange
  → 立刻 saveNodesToHistory

onConnect
  → 自环或不兼容则返回
  → checkConnectionLimit，违规则返回
  → checkCycle，成环则 toast
  → addEdge，并入撤销栈

onNodesDelete
  → 删节点和连到它的边
  → saveNodesToHistory
```

删除键是 `Backspace`。文本框聚焦时 `isActiveKeyMap` 为 false，画布快捷键让路。Cmd/Ctrl+S 在 800ms 后保存。复制是 Cmd/Ctrl+C 和 Cmd/Ctrl+V，源码里没有 Cmd/Ctrl+D。

节点超过 40、边超过 60，或媒体节点超过 12，就打开 `onlyRenderVisibleElements`。

### 连线规则

- [handleRules.ts](../../../../../opencreate/opencreator-frontend/src/lib/handleRules.ts)：`isHandleCompatible`。`subject`、`style` 归一成 `image`。
- [pinConfigs.ts](../../../../../opencreate/opencreator-frontend/src/constants/pinConfigs.ts)：每种节点有哪些 pin。未登记类型返回空数组。
- [connectionLimits.ts](../../../../../opencreate/opencreator-frontend/src/lib/connectionLimits.ts)：`checkConnectionLimit`、`checkEdgeLimit`。上限表在 00 第 3 节。
- [cycleDetection.ts](../../../../../opencreate/opencreator-frontend/src/lib/cycleDetection.ts)：`checkCycle`。

`isValidConnection` 只拦自环和不兼容 pin。环和连接数在松手后的 `onConnect`。快捷菜单按 pin 兼容过滤可创建节点，那条加边路径没有再跑后两道校验。

### `use-flow-undo-redo.ts`

OpenCreator 源码：[use-flow-undo-redo.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-flow-undo-redo.ts)

导出 `undo`、`redo`、`canUndo`、`canRedo`。

undo 把当前快照放进 redo，再把上一层克隆写回 store，`persist: false`，然后 `markFlowDirty('undo')`。已经成功的节点会按结果 store 拉回 `success`。`canUndo` 要留下加载时的那条基线。

### 新建、复制、粘贴

[use-create-node.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flowAction/use-create-node.tsx) 用 `${nodeType}-${Date.now()}-${nanoid(6)}` 做 id，补默认数据后 `addNode`。这一下本身不入撤销栈。

画布上的复制走 [use-duplicate-nodes.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-duplicate-nodes.ts)。store 里的 `duplicateNode` 没有被按钮调用。复制会换 id、平移 100、改写文本里的节点引用、把 `status` 设为 `idle`、丢掉超限边，大约 100ms 后入栈。

[use-hotkey-copy-node.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-hotkey-copy-node.tsx) 把选中节点放在内存 ref 里。粘贴 URL 或媒体文件会建输入节点；只选中一个同类型输入节点时，粘贴文件会替换上传。这个 hook 只看 `isActiveKeyMap`。

### `sync-manager.ts` 和 `flow.ts`

OpenCreator 源码：

- [sync-manager.ts](../../../../../opencreate/opencreator-frontend/src/lib/sync-manager.ts)
- [flow.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts)
- [flow-persistence.ts](../../../../../opencreate/opencreator-frontend/src/lib/flow-persistence.ts)
- [local-db.ts](../../../../../opencreate/opencreator-frontend/src/lib/local-db.ts)

```text
patchFlowProject
  → PATCH /api/v2/flow/project
  → Authorization: Bearer <__opencreator_jwt>
  → { flow_id, nodes, edges }
```

IndexedDB 库名 `OpenCreatorDB`，表 `workflows`，主键 `flow_id`。本地状态是 `synced`、`pending`、`failed`，内存里再加 `offline`。

菜单栏通过 `onStatusChange` 显示这四个状态，失败时可以 `manualRetry`。离开页面的立即保存、打开项目时的本地草稿回灌，也调用同一个 `saveAndSync`。

### Preview

OpenCreator 源码：

- [build-preview-items.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/build-preview-items.ts)
- [canvas-preview-view.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/canvas-preview-view.tsx)
- [nodeTags.ts](../../../../../opencreate/opencreator-frontend/src/constants/nodeTags.ts)

`CanvasPreviewView` 接收 `visible`、`focusRequest`、`chatExpanded`。数据来自 `useHistoryResults()` 和 `useNodeResults().getNodeResults`。覆盖层可见时会再 `refetchNode('__cut__')`。

桶、回退 tag、只取最新一条、`motionTrajectory` 不进桶、`__cut__` 按 URL 对齐，都在 00 第 6 节。这里的文件分工是：

- `preview-rail.tsx`：切桶。空桶禁用，`cut` 始终在列。
- `preview-stage.tsx`：单页，文本保存和重做从这里进。
- `preview-grid-view.tsx`：三列。点卡片后回到 gallery 的对应页。
- `preview-footer.tsx`：页码、gallery / grid、光标工具。
- `preview-empty-state.tsx`：没有任何 item 时的空态。
- `preview-tool-dock.tsx`：引用和 Vary。Vary 用 `scene_reference`，同样只进 Composer。

`CanvasPreviewView` 只被 `Canvas.tsx` 引用，没有从 feature barrel 再导出。

### 局部标注

OpenCreator 源码：

- [use-preview-local-edit.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/use-preview-local-edit.ts)
- [preview-annotation-compose.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/preview-annotation-compose.ts)
- [aws.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/aws.ts)

`usePreviewLocalEdit` 导出 PNG，用 `postUploadFile(file, { skipPreprocess: true })` 上传，再 `addRemoteAttachment` 和 `appendText`。附件字段见 00 第 7 节。成功后只清空叠加层。

文本保存不走这个 hook。`preview-stage.tsx` 调用 [results.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/results.ts) 的 `patchNodeResult`：

```text
PATCH /api/v3/result
{ flow_id, node_id, result_id, result }
```

然后 `setHistoryResults`。

### 运动轨迹

OpenCreator 源码：

- [use-preview-motion-path.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/use-preview-motion-path.ts)
- [preview-motion-path-domain.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/preview/preview-motion-path-domain.ts)

工具是 `idle`、`subject`、`number`、`arrow`、`eraser`。草稿按当前 item id 留在内存里，换 workflow 才清。

提交后的建节点和连线写在 `canvas-preview-view.tsx`：`createMotionPathInputNode` 在提交时建或更新 `imageInput`；`connectMotionPathInputNode` 挂在附件的 `onSend` 上，发送时再跑 `isHandleCompatible`、`checkConnectionLimit`、`checkCycle`。`environment` 桶会多一条 `model` 显示为 `Motion Editor` 的本地 item，不写 `NodeResults`。

### 组装节点和 iframe

OpenCreator 源码：

- [assembleNowNode.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/custom_nodes/toolsNode/assembleNowNode.tsx)
- [iframe_editor.tsx](../../../../../opencreate/opencreator-frontend/src/components/remotion/iframe_editor.tsx)
- [useCanvasProvider.tsx](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/runtime/useCanvasProvider.tsx)
- [assemble.ts](../../../../../opencreate/opencreator-frontend/src/types/assemble.ts)

默认 tab 是 `auto_edit`。两个打开入口都执行 `setRemotionNodeId`，并把 id 写入 `OP_REMOTION_NODE_ID`。节点用入边维护 `AssembleAsssetItem[]`。

`RemotionFrame` 在关闭时不渲染。打开后 `src` 等于 `NEXT_PUBLIC_IFRAME_ORIGIN`。加载完成后发送 `init_data`。收到 `payload_change` 就改对应节点的 `assemblePayload`；收到 `close_window` 就清空 `remotionNodeId`。

`changeRemotionNodeData` 的函数体是空的。类型上有 `onChange`、`onExport`、`onClose`，运行时没有使用。

### AutoEditor

OpenCreator 源码：

- [AutoEditor/index.tsx](../../../../../opencreate/opencreator-frontend/src/components/remotion/AutoEditor/index.tsx)
- [useRemotionRender.ts](../../../../../opencreate/opencreator-frontend/src/hooks/useRemotionRender.ts)
- [assemble.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/assemble.ts)

`auto_edit` tab 用 `@remotion/player` 在节点内播放，fps 30。Open Editor 仍只是打开 iframe。Download 调用：

```text
POST {REMOTION_BASE_URL}/api/render2
GET  {REMOTION_BASE_URL}/api/render2?id={taskId}&type=VIDEO_RENDERING
```

默认 host 是 `https://remotion-api-dev.opencreator.io`。返回 `{ video: { id, status, progress, url } }`。这套请求不打到 iframe origin，也不进 `opencreator-remotion` 的 `/api/render`。

---

## 三、Remotion 仓必须有的文件

1. `src/editor/flags.ts`：含 `FEATURE_SAVE_BUTTON`。
2. `src/editor/state/types.ts`：`UndoableState`、`EditorState`。
3. `src/editor/state/initial-state.ts`：空工程默认值。
4. `src/editor/state/persistance.ts`：读写 `remotion-editor-starter-state-v3`。
5. `src/editor/context-provider.tsx`：按「语言切换 → URL → localStorage」初始化。
6. `src/editor/editor.tsx`：编辑器页面。页面路由在 `app/[locale]/page.tsx`，默认语言 `zh-CN`。
7. `src/editor/rendering/render-state.ts`：提交渲染并轮询。
8. `app/api/render/route.ts`：`POST /api/render`。
9. `app/api/progress/route.ts`：`POST /api/progress`。
10. `src/remotion/constants.ts`：Lambda 规格，和 deploy 用同一组数字。

`ContextProvider` 挂在 Remotion 的 root layout，不挂在画布节点上。Frontend 的 iframe 只写 origin，Next 会把 `/` 重定向到 `/zh-CN`。

`POST /api/render` 先校验宽高、fps、至少一个 item，以及素材的 `remoteUrl`。`codec` 不是 `h264` 就失败。成功返回 `bucketName` 和 `renderId`。`POST /api/progress` 再按这两个字段查到 `outputFile`。

当前仓库没有监听父页面 `postMessage` 的代码。编辑器状态、保存和 Lambda 可以先按这些文件搬；要让画布上的 `assemblePayload` 跟着变，还得在编辑器里补 `init_data`、`payload_change`、`close_window`。

---

## 四、Publisher 只保存图和文本结果

图同步：

```text
PATCH /api/v2/flow/project
  → workflow_project.py 的 update_workflow
  → 异步更新 nodes / edges
  → HTTP 立即成功
```

更新按 `flow_id + user_id`。它不改 `flow_id`、`user_id`、`created_at`。`assemblePayload` 只是节点 data 里的字符串，跟着 nodes 一起 patch，Publisher 不把它解析成时间线。

撤销栈不到这里。封面不到这里。Remotion Lambda 也不经过 Publisher 或 Consumer。

文本 Preview 的保存是 `PATCH /api/v3/result`。标注和轨迹的 PNG 只上传 COS。

---

## 五、运行时链路

### 1. 改图

```text
isWorkflowReady = true，且不是只读
  → Flow mode = editor
  → setNodes / setEdges
  → persistRevision + 1
  → 1.5 秒后 saveAndSync
```

未 ready 时写入不记脏。

### 2. 连线

```text
拖动中：isValidConnection 看自环和 pin
松手：checkConnectionLimit，再 checkCycle，通过后 addEdge
```

### 3. 撤销和刷新

```text
Cmd/Ctrl+Z
  → 写回上一张快照，persist: false
  → markFlowDirty
  → 自动保存

刷新
  → 撤销栈清空
  → 图从 IndexedDB 或 Publisher 恢复
```

### 4. 打开 Preview

```text
viewMode = preview
  → historyResults 的最新一条，否则 getNodeResults 的最新一条
  → 成功结果按 nodeTag 进桶
```

没有成功结果就是空态。节点还在跑时，Preview 不把排队中的 output 当成结果。

### 5. 标注和轨迹

```text
导出 PNG
  → COS
  → Composer control_reference
```

标注同时 `appendText`。轨迹额外写一个 `motionTrajectory` 图片输入，等消息发送时再连边。两条都不改原结果。

### 6. 打开并回写剪辑器

```text
setRemotionNodeId
  → iframe onLoad
  → init_data
  → payload_change
  → setNodes 写 assemblePayload
  → 随后走普通自动保存

close_window
  → 卸掉 iframe
```

Remotion 页面若没有发这些消息，全屏层关不掉，节点上的 `assemblePayload` 也不会变。

### 7. 导出

```text
独立编辑器
  → POST /api/render
  → POST /api/progress

AutoEditor Download
  → POST /api/render2
  → GET /api/render2
```

`renderId` 查不到 render2 的任务，`video.id` 也查不到 `/api/progress`。

---

## 六、和 NovelComic 对照

NovelComic 里还没有 `Flow.tsx`、`CanvasPreviewView`、`RemotionFrame`。第 02 章若只完成项目读取，本章还没开始。

顺序是：

1. `nodes` / `edges` 能稳定进 store，`isWorkflowReady` 可用。
2. 接 `Flow.tsx`、连线规则和撤销。
3. 接 `syncManager` 和 `PATCH /api/v2/flow/project`。刷新后图还在，再做 Preview。
4. Preview 先聚合和空态，再做标注、轨迹、文本保存。
5. 最后接 `assembleNow`、iframe，以及分开的 `/api/render` 和 `/api/render2`。

Preview 为空，先看节点有没有成功结果。iframe 打开后工程没有回到节点上，先看 Remotion 有没有发出 `payload_change`。
