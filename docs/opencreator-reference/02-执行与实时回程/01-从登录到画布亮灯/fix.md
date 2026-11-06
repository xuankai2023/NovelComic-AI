# 从登录到画布亮灯：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-consumer`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-consumer`。

不在这一段：登录换 JWT、画布项目加载和 IndexedDB 草稿、HITL 候选勾选和 `user_selection` 形状、选中节点跑、单节点跑、对话面板、`POST /v1/agent/runs`、Agent 工具、运行附件、预扣读哪份定价。余额不足拦住 Run 也归支付清单。自定义节点的外观归画布编辑那一节；这一段只把运行态写进已有节点的 `data.status`。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是 id 用 uuid 还是 nanoid、类怎么拆、日志文案。

- `workflow:v2:pending_commands` 在 `sessionStorage`。同一 `operationKey` 未结束时复用第一次的 id 和 payload。`400 / 401 / 403 / 404 / 409 / 422` 才丢掉本地命令。超时、断网、5xx 保留。HTTP `202` 成功后两边都会清掉这次创建命令
- `POST /api/v2/flow/runs`、continue、cancel 都返回 `202`。响应有 `flow_task_id`、`flow_run_id`、`trace_id`、`status`、`idempotent_replay`。相同 `command_id` 加相同 payload 返回原 run。相同 id 换 payload 是冲突
- `create_run()` 把 `flow_task` 和 `workflow_command` 放进同一事务，提交之后才派发。派发进 Redis Stream `run_flow`，消息带 `protocol_version=2`、`command_id`、`reply_queue`
- Consumer 先 `claim_command`。start、continue、cancel 都会进 `run_flow`。start 会 `init_flow_run`、`init_nodes`、发布 `start_flow`，再 `handle_resume`。重复 `command_id` 不会再初始化一次
- 输入节点在 Consumer 里完成，并先后发布 `node_status=running` 和 `node_status=success`。模型节点会提交 AI task。聚合完成后发布 `node_status=success` 或 `failed`，失败时后继是 `stopped`
- 事件先写 outbox，再进 v2 reply queue。Publisher 在 `append_event()` 成功之后才 ACK。同一个 `event_id` 返回原来的 cursor。形状不合法且还没落库时不重新入队
- WebSocket 路径是 `/api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。打开后先发 `auth`，紧接着发 `attach_flow`。`resume_ready` 之后才把这条连接当成接上。handler 成功后才写 `workflow:v2:cursor:{flowTaskId}`。handler 失败关闭码 `4002`，不写 cursor。`4409` 清本地 cursor。心跳超时会关连接。`onclose` 不调用 cancel
- 刷新后 `getActiveWorkflowRuns(flowId)` 能找回未结束的 run，再用本地 cursor 去 attach
- 关页面只断 WebSocket。停跑要 `POST /api/v2/flow/runs/{flow_task_id}/cancel`，Consumer 会 `_stop_flow_for_kill`

# 1. 运行态写进 flow store 的节点

做完要达到：点击 Run 之后，画面上的节点就是 flow store 里的那批。`node_status=success` 把该节点 `data.status` 写成 `success`。模型占位到达时写成 `running`。点 Run 时，将要执行的节点先写成 `queued`。

## 现在

`useNodeStatusManager` 收到的是 `setNodeStatuses`，写的是组件状态里的 `NodeStatusMap`。`workflow-runtime-provider.tsx` 不调用 `setNodes`。

`canvasEditorContent.tsx` 把加载好的 `workflow` 交给 `agent-canvas-layout.tsx`。那里用 `workflow.nodes` 重造一种 `novelComicCanvasNode`，`data.status` 取自上面的 map。`nodesDraggable` 是 false。`features/canvas-workflow/components/Canvas.tsx` 和 `Flow.tsx` 读的是 flow store，这条路由没有挂它们。`Flow.tsx` 的 `CanvasWorkflowNode` 也不读 `data.status`。

`runAll()` 和 `onStartFlow` 会把全部节点标成 `ready`。OpenCreator 在发出创建请求之前，把这次要跑的节点写成 `queued`。`onStartFlow` 只重置这些节点的历史结果，并保留已完成的那条，不把节点改成 `ready`。

OpenCreator 的 `onNodeRunning` 写历史结果，状态是 `running`、`outputs` 为空。它不在这里改 `data.status`。`onLlmModelReady` 才调用 `setRunningNodeStatus`。`onNodeSuccess` 调用 `setSucessNodeStatus`，把 `data.status` 写成 `success`，并 `setHistoryResults`、`setNodeResults`。函数名 `setSucessNodeStatus` 保持这个拼写。

`novelcomic-frontend` 里已经有 `setHistoryResults` 和 `setNodeResults`。`useWorkflowRunner.ts` 没有调用它们，结果只进 provider 里的 `runtimeNodeResults`，预览读不到。

## 改哪些文件

1. `novelcomic-frontend/src/components/headBar/hooks/useNodeStatusManager.ts`，对照 OpenCreator `components/headBar/hooks/useNodeStatusManager.ts`。入参改成 `setNodes`。`setRunningNodeStatus` 写 `data.status = 'running'`。`changeNodesStatus` 在传入 `queued` 或 `idle` 时写这个值。`resetRunningNodeStatus` 把 `queued`、`running`、`select` 收成 `idle`。
2. `novelcomic-frontend/src/components/canvas/workflow-runtime-provider.tsx`，对照 OpenCreator `components/canvas/workflow-runtime-provider.tsx`。`setSucessNodeStatus`、`setPauseNodeStatus`、`setSelectNodeStatus` 写 flow store。对外仍提供 `runAll` 和 `stopWorkflow`。
3. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onStartFlow`、`onNodeRunning`、`onNodeSuccess`、`onLlmModelReady`。历史结果走现有的 `setHistoryResults`。节点结果走现有的 `setNodeResults`。这一份文件后面只补本节点名的 handler，不要把 OpenCreator 那份里的选择条、积分差额和埋点一起搬过来。
4. `novelcomic-frontend/src/components/canvas/agent-canvas-layout.tsx` 和 `canvas-editor-content/canvasEditorContent.tsx`。当前路由渲染 `features/canvas-workflow/components/Canvas.tsx`，节点来自 flow store。Run、Stop 仍调用 runtime 的 `runAll`、`stopWorkflow`。
5. `novelcomic-frontend/src/features/canvas-workflow/components/Flow.tsx` 的 `CanvasWorkflowNode` 显示 `data.status`。节点种类和外观仍用现在这套。

OpenCreator 对照：

- `opencreator-frontend/src/components/headBar/hooks/useNodeStatusManager.ts`
- `opencreator-frontend/src/components/canvas/workflow-runtime-provider.tsx`
- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onStartFlow`、`onNodeRunning`、`onNodeSuccess`、`onLlmModelReady`
- `opencreator-frontend/src/components/canvas/agent-canvas-layout.tsx` 里挂 `Canvas` 的那一层

# 2. 全局 Run 用画布上的当前图

做完要达到：Run 提交的 `nodes` / `edges` 是 flow store 里现在这份。标注、分组、便签不进图。有节点既不是任何边的 source，也不是 target 时，不创建 run。文本输入没有 `inputText`、图片输入没有 `imageBase64`、要选模型的节点没有 `selectedModels` 时，不创建 run，并把该节点 `data.status` 写成 `failed`。通过这些检查之后才 `postCreateWorkflowRun`。

## 现在

`useWorkflowRunner.ts` 的 `runAll(flowId)` 用 provider 收到的 `workflow.nodes` / `workflow.edges`。那是进入页面时加载的项目。用户随后改过的 store 不会进这次请求。没有连通检查，也没有空输入检查。`run_mode` 固定 `global`。

OpenCreator 的 `runAll` 调用 `sendFlowData(nodes, edges)`，`nodes` / `edges` 来自 flow store。`generateFlowGraph` 去掉类型 `Run Button`。再去掉 `textAnnotationNode`、`textAnnotationNodeLeft`、`groupNode`、`stickyNodesNode`。未连接时提示后返回，`isRunning` 回到 false。`checkIsInputNodeEmpty` 命中时同样不发请求，并把该节点写成 `failed`。发出去的 `flow_task` 先经过 `prepareFlowTask`：补模型默认参数，`relight` 改成 `imageToImage`，`inputText` 从 HTML 转成 markdown。

`operationKey` 在 OpenCreator 是 `create:{flowId}:{runMode}:{intentScope}`。全局 Run 的 scope 是 `all`。NovelComic 现在是 `create:{flowId}:global`。全局 Run 改成 OpenCreator 这把 key。选中节点和单节点的 key 仍不在这一段。

## 改哪些文件

1. 新增 `novelcomic-frontend/src/lib/generateFlow.tsx`，对照 OpenCreator `src/lib/generateFlow.tsx` 的 `generateFlowGraph`。这一段只用它产出的 `mainFlow`。
2. 新增 `novelcomic-frontend/src/lib/isGraphConnected.tsx`，对照 OpenCreator 同名文件的 `checkIsInputNodeEmpty`。`SELECT_MODEL_NODE_TYPES` 用 NovelComic 现有节点类型常量。
3. 新增 `novelcomic-frontend/src/components/headBar/lib/prepareFlowTask.ts`，对照 OpenCreator `components/headBar/lib/prepareFlowTask.ts`。
4. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `runAll`。图从 flow store 取。检查失败不调用 `postCreateWorkflowRun`。

余额、升级弹窗、性能打点不进这四个文件的本次 diff。

# 3. 模型节点先出占位，再逐条更新

做完要达到：模型节点开始执行时，浏览器先收到 `node_status=running`，再收到 `start_running_llm_models`，再收到 `llm_model_ready`。`llm_model_ready` 的 `result_placeholders` 写进该节点历史结果，每条占位的状态是 `running`。之后的 `llm_model_status` 按 `result_id` 替换对应占位。节点 `data.status` 仍保持 `running`，直到 `node_status=success`。

## 现在

`novelcomic-consumer/app/tasks/flow_resume.py` 的 `_process_ready_node` 对模型节点只发布一次 `node_status=running`，然后 `ModelInvocationService.submit_planned_node`。没有 `start_running_llm_models`，也没有 `llm_model_ready`。

前端 `useWebSocketFlow.ts` 已经能把这两种事件分发出去。`onLlmModelReady` 只把整次事件收成一条 `running` 结果，不读 `result_placeholders`。`onLlmModelStatus` 再走一遍通用状态函数，不按 `result_id` 替换占位。

OpenCreator 的 `_publish_node_started` 连发上面三个事件。`llm_model_ready` 的 `event_id` 用 `stable_event_id("llm_model_ready", run_id, node_id)`。占位放在 `result_placeholders`。前端用 `result_id` 当 `uniKey`。`llm_model_status` 找到同一 `result_id` 就替换，找不到就追加。`splitText` 成功时把 JSON 数组拆成多条文本。

输入节点仍只走 `node_status`。它们不发 `llm_model_ready`。

## 改哪些文件

1. `novelcomic-consumer/app/tasks/flow_resume.py`，在模型节点提交前补上 OpenCreator `_publish_node_started` 的三个事件。占位来自现有 `ModelInvocationPlanner` 的计划。事件仍走现有 `FlowEventPublishService.publish`。
2. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onLlmModelReady`、`onLlmModelStatus`，对照 OpenCreator 同名 handler 里写 `outputs` 的那一段。
3. `useWebSocketFlow.ts` 的分发已经有了，这一节不改事件名。

OpenCreator 对照：

- `opencreator-consumer/tasks/flow_resume.py` 的 `_publish_node_started`
- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onLlmModelReady`、`onLlmModelStatus`

# 4. `stopped` 把节点收成 idle

做完要达到：收到 `node_status=stopped` 时，该节点 `data.status` 变成 `idle`。任务列表里这条记成 `stopped`。另一个仍在跑的 run 占着同一个节点时，这个节点保持原状态。

## 现在

Consumer 的 `_stop_flow_for_kill` 和 `NodeAggregationService` 已经会发布 `node_status=stopped`。`useWebSocketFlow.ts` 的 `dispatchNodeStatus` 只单独处理 ready、running、success、select、pause、failed。`stopped` 落到 `onNodeStatus`。`applyNodeStatusEvent` 没有 `stopped` 这一支，节点会停在 `ready` 或 `running`。

OpenCreator 有 `onNodeStopped`。它按 `run_id` 找到任务并 `updateTaskNode(..., { status: 'stopped' })`。节点本身写成 `idle`。`collectNodeIdsOwnedByOtherActiveRuns` 命中时跳过画布写入。

## 改哪些文件

1. `novelcomic-frontend/src/components/headBar/hooks/useWebSocketFlow.ts` 的 `dispatchNodeStatus`，`stopped` 调用 `onNodeStopped`。
2. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 增加 `onNodeStopped`，对照 OpenCreator 同名函数。
3. 任务状态用现有 `TasksBox` 能读到的那份任务数据。没有对应任务记录时，仍然把节点写成 `idle`。

`stop_descendants` 已经在聚合里。这一节不改 Consumer 的失败传播。

# 5. 每次物理连接用新的 connectionId

做完要达到：每一次 `open` 都新建 `connectionId`，并把 generation 加一。`attach_flow` 带上这个 `connection_id`，以及 `protocol_version=2`、`flow_task_id`、`last_event_cursor`。旧 generation 的消息直接丢掉。旧 socket 被服务端以 `4001` 替换后，它的 `onclose` 不再排队重连。新连接自己走退避。

## 现在

`workflow-resumable-websocket.ts` 在构造时生成一次 `connectionId`。`openSocket()` 重连仍用这一条，URL 也仍是这一条。`attach_flow` 没有 `connection_id`。Publisher 允许缺这个字段，所以第一跳还能接上。

客户端没有 generation。`onclose` 里除了主动关闭和 `4409`，都会 `scheduleReconnect`。服务端 `claim_connection_generation` 会把旧连接用 `4001` 踢掉。旧连接的 `onclose` 再用同一个 `connectionId` 连回来，新旧帧会一起改节点状态。

OpenCreator 的 `openPhysicalSocketOnce` 每次 `++socketGeneration`，并 `createConnectionId()`。`onmessage` 先看 generation，对不上就返回。旧 socket 的 `onclose` 发现 generation 已经变了，就不再 `scheduleReconnect`。`attach_flow` 带 `connection_id`。

`4002` 不写 cursor、`4409` 清 cursor、心跳和 `resume_ready` 已经对齐。这一节只改连接身份。

## 改哪些文件

1. `novelcomic-frontend/src/lib/workflow-resumable-websocket.ts`，对照 OpenCreator `src/lib/workflow-resumable-websocket.ts` 的 `openPhysicalSocketOnce`、generation 判断和 `attach_flow` 帧。
2. Publisher `flow_runs.py` 已经用 URL 上的 `connection_id` 做 generation。帧里缺 `connection_id` 时现在放行。客户端补上字段之后，继续用现有的「缺省或等于 URL」判断，不要改成另一次认证。

# 补齐顺序

先改状态写入和画布挂载，让 `success` 出现在 flow store 的节点上。

然后改 `runAll` 的图来源和创建前检查。检查失败时不发 `POST /api/v2/flow/runs`。

然后补 `llm_model_ready` 和 `stopped`。最后改重连的 `connectionId`。

不要新写一条 WebSocket。不要改 `create_run` 的幂等和 `202`。不要在这一段改 Continue 的 `user_selection`。
