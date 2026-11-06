# 可恢复 WebSocket：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`。

不在这一份：登录换 JWT、画布项目加载、运行态写进 flow store 的总路线、`llm_model_ready` 的发布顺序、`stopped` 收成 idle、每次物理连接更换 `connectionId`。这些在「从登录到画布亮灯」。HITL 的 `user_selection`、后继读 `selected_outputs` 在「工作流命令、DAG 与 HITL」。余额、升级弹窗、埋点、Sentry 不进这一份。`runWorkflowSideEffectOnce` 已经接在 `finish_flow` 上，不要把 OpenCreator runner 里的积分差额和埋点搬过来。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是 Redis key 前缀、类怎么拆、日志文案。

- WebSocket 路径是 `/api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。先 `accept()`，15 秒内等 `auth`，验 JWT，再按 `user_id + flow_task_id` 查 run。不属于当前用户关 `4404`。通过后发 `authenticated`，再等 `attach_flow`。body 里的 `flow_task_id`、`connection_id` 可以省略，出现了必须和 URL 一致。空 cursor 按 `0-0`。cursor 不是 Redis Stream ID 时关 `4400`
- `resume_ready` 之后前端才把连接标成 `connected`，并清零重连次数。`resume_ready` 带 `event_cursor`、`latest_event_cursor`、`status`。30 秒内没有 `resume_ready` 关 `4007`
- handler 成功后才写 `sessionStorage["workflow:v2:cursor:{flowTaskId}"]`。handler 抛错关 `4002`，不写 cursor。`onclose` 不调用 cancel
- 服务端 `4409` 时清掉这个 `flow_task_id` 的本地 cursor，这一次关闭不再排队重连
- 心跳是 30 秒一次 ping，10 秒内没有任何帧就关 `4000`。页面 hidden 时不发 ping。浏览器离线时不空转。回到 online 或页面重新可见会再试。退避是 `1s → 2s → 4s → 8s → 15s → 30s`，乘 0.8–1.2，最多 10 次
- Publisher 先 `append_event()`，再前进 `last_event_cursor`，然后才 ACK。同一个 `event_id` 返回原来的 cursor。`0-0` 在 Stream 被裁掉或过期时不可用，会去要 snapshot；要不到关 `4409`，并带 `resume_error`，`code` 是 `RESUME_WINDOW_EXPIRED`
- snapshot 先打 Consumer 蓝，再打绿，`GET /api/internal/workflow/{flow_task_id}/snapshot`。取到之后先发 `flow_snapshot`，再从当时的最新 cursor 往后 replay，然后 `resume_ready`。run 已经是终态时，会把 replay 边界补到包含这条终态事件
- `(flow_task_id, connection_id)` 的 generation 会递增。旧连接关 `4001`。客户端每次 open 换新的 `connectionId` 在亮灯第 5 节，这里不改
- 刷新会 `getActiveWorkflowRuns(flowId)`，再用本地 cursor attach。live 阶段从 Redis Stream 往后读。Pub/Sub 或通知 Stream 只是叫醒，丢了也还能从 Stream 追上。不要改这两套 key，也不要改成另一套事件仓
- 关页面只断 WebSocket。停跑仍走 cancel

# 1. 运行事件直接出现在这一帧上，同一个 event_id 不进第二次 handler

做完要达到：replay 和 live 推给浏览器的就是 Event Store 里的那条事件，顶层带原来的 `event_type`、`event_id`，再补上 `event_cursor` 和 `replayed`。replay 时 `replayed` 为 true，live 时为 false。

同一条物理连接里，见过的 `event_id` 最多留 500 个。再见到同一个 id，不再调用业务 handler，仍然把这条帧的 `event_cursor` 写入 sessionStorage。handler 抛错时的规则不变：关 `4002`，不记这个 id，也不写 cursor。

## 现在

`_send_workflow_events` 把事件包进 `event`，这一帧自己的 `event_type` 固定是 `workflow_event`，顶层没有 `event_id`。`useWebSocketFlow` 再把 `message.event` 拆开，所以 `node_status` 现在还能分发出去。

`workflow-resumable-websocket.ts` 没有已见 `event_id` 集合。同一条连接里这条事件再来一次，handler 会再跑一遍。

`novelcomic-publisher/tests/test_workflow_events_v2.py` 断言 `event_type == "workflow_event"`。前端 `workflow-resumable-websocket.test.ts`、`accept-resumable-websocket.test.ts`、`useWebSocketFlow.test.ts` 也在喂这种包。改完后，断言改成顶层就是原来的 `event_type`。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v2/flow_runs.py` 的 replay 和 `_event_loop` 发送，对照 OpenCreator `flow_runs.py` 里 `outbound = dict(event)` 再写上 `event_cursor`、`replayed`。删掉包一层 `workflow_event` 的发送。`flow_snapshot` 和 `resume_ready` 这两帧保持现在的独立事件，不要包进去。
2. `novelcomic-frontend/src/lib/workflow-resumable-websocket.ts` 的收包，对照 OpenCreator `dispatchMessage`。按顶层 `event_id` 去重，满 500 丢掉最早的。重复 id 仍推进 cursor。
3. `novelcomic-frontend/src/components/headBar/hooks/useWebSocketFlow.ts` 的 `extractWorkflowEvents`。没有嵌套 `event` 时，整帧就是业务事件。`resume_ready`、`resume_error`、`flow_snapshot` 仍走现在的分支。

OpenCreator 对照：

- `opencreator-publisher/controller/v2/flow_runs.py` 里 replay 发送和 `_event_loop`
- `opencreator-frontend/src/lib/workflow-resumable-websocket.ts` 的 `rememberEventId` 和 `dispatchMessage`

# 2. 空闲时 ping 要有 pong

做完要达到：`resume_ready` 之后同时收客户端消息和推事件。客户端 `ping` 时回 `pong`，带上 `flow_task_id`、`connection_id`。`pong` 和 `ack` 忽略。别的消息回 `resume_error`，`code` 是 `UNSUPPORTED_MESSAGE`，连接保持开着。推事件的一边继续只读 Stream。

任意一帧都算心跳还活着，包括这颗 `pong`。打开物理连接的超时是 30 秒，到点关 `4004`。30 秒 ping、10 秒无帧关 `4000`、hidden 时不 ping，这些不用改。

## 现在

`workflow_run_events` 在 `resume_ready` 之后只进 `_event_loop`。这个循环只 `xread` 再下发，不读 WebSocket。客户端的 ping 没有回应。

节点停在 `select`，或模型调用中间没有新事件时，下一次 ping 之后 10 秒关 `4000`，然后按退避重连。

`OPEN_TIMEOUT_MS` 是 15 秒。慢握手会先被 `4004` 关掉。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v2/flow_runs.py`，对照 OpenCreator `_receive_loop`，以及 `resume_ready` 之后 `asyncio.wait` 同时等收包和推送。发送加锁，避免 pong 和事件帧叠在一起。旧 generation 不再写，这条已经有，保持。
2. `novelcomic-frontend/src/lib/workflow-resumable-websocket.ts` 的 `OPEN_TIMEOUT_MS` 改成 30 秒，关闭码仍是 `4004`。

OpenCreator 对照：

- `opencreator-publisher/controller/v2/flow_runs.py` 的 `_receive_loop`、`_event_loop`，以及握手结束后的两个 task
- `opencreator-frontend/src/lib/workflow-resumable-websocket.ts` 的 `CONNECT_TIMEOUT_MS`

# 3. 比最新一条还新的 cursor 不能当还能 replay

做完要达到：`last_event_cursor` 落在当前 Stream 最早一条和最新一条之间，含这两头，才算还能 replay。比最新还新，和比最早还旧一样，走现有的 snapshot。snapshot 取到就从最新 cursor 继续；取不到就发 `RESUME_WINDOW_EXPIRED` 并关 `4409`。

`0-0` 在 Stream 还从开头保留、或这次 run 还没写过 cursor 时，仍然可用。这条已经对齐，不要改。

## 现在

`WorkflowEventStore.is_cursor_available` 对非空 cursor 只判断「不早于当前最早一条」。比最新还新的 id 也会返回 true。接着 replay 是空的，`resume_ready` 把 cursor 收成当时的 high watermark。这条连接没有把窗口里的事件送给前端。

## 改哪些文件

1. `novelcomic-publisher/app/services/workflow_event_store.py` 的 `is_cursor_available`，对照 OpenCreator `cursor_is_available`。在已有的最早一条比较之外，加上不得晚于最新一条。

OpenCreator 对照：

- `opencreator-publisher/services/workflow_event_store.py` 的 `cursor_is_available`

# 4. resume_ready 的 status 决定这次 run 还在不在跑

做完要达到：`resume_ready.status` 继续用 `flow_task.status`。Publisher 只在对应事件写入 Stream 之后才改这个字段。`get_run_summary()` 不要改成去读 Consumer 的 `flow_run_state`。

前端收到 `resume_ready` 后：

- `pending`、`running`、`waiting_for_selection`、`waiting_input`、`cancel_requested`：保持正在跑
- `completed`、`failed`、`killed`，以及 `success`、`error`、`cancelled`、`canceled`、`stopped` 这些写法：结束这次运行，断开这条事件连接，清掉该 `flow_task_id` 的 cursor。`success` 收成完成，`stopped` / `cancelled` 收成 killed
- 还在跑，而这批节点上留着 `failed`：把这些节点的 `data.status` 收成 `idle`。历史结果整条都是失败、且没有 `running` 或 `pending` 输出时，放一条 `running` 占位，让后续 live 事件接着画

`resume_error` 只有 `RESUME_WINDOW_EXPIRED` 走第 5 节。其他 `resume_error` 不要把这次 run 收成停止，也不要清节点。

## 现在

`onResumeReady` 不看 `status`，一律 `setIsRunning(true)`。replay 里的 `finish_flow` 已经把运行收掉，紧接着的 `resume_ready` 又把它打开。

`onResumeError` 在不是 cursor 过期时，会 `setIsRunning(false)` 并 `resetRunningNodeStatus()`。

`flow_killed` 和 `finish_flow` 走同一个 `onFinishFlow`。取消会被当成一次成功结束：清掉 active run，并把还在跑的节点收成 idle，不断开连接，也不清 cursor。OpenCreator 的 `flow_killed` 单独走 `onFlowKilled`，按 killed 收口。

`workflow_error` 只把能认出的节点写成 `failed`，并把 `isRunning` 关掉。OpenCreator 会收掉这次会话、断开连接、清 cursor。

## 改哪些文件

1. `novelcomic-frontend/src/components/headBar/hooks/useWebSocketFlow.ts` 的分发。`flow_killed` 改走 `onFlowKilled`，不要和 `finish_flow` 共用。`node_status=stopped` 仍按亮灯第 4 节，这里不改。
2. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onResumeReady`、`onResumeError`、`onFlowKilled`、`onWorkflowError`，对照 OpenCreator `onResumeReady`、`reconcileAuthoritativeRunStatus`、`onFlowKilled`、`onWorkflowError`。节点 `data.status` 和历史结果沿用亮灯第 1 节的写法。不要带上任务面板、积分和埋点。

OpenCreator 对照：

- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `onResumeReady`、`reconcileAuthoritativeRunStatus`
- `opencreator-publisher/services/workflow_runs_v2.py` 的 `get_run_summary`。NovelComic 这份已经只读 `flow_task`，保持即可

# 5. 刷新和 cursor 过期用 run 快照把节点画回去

做完要达到：`GET /api/v2/flow/runs` 和 `GET /api/v2/flow/runs/{flow_task_id}` 的每条 run 带上 `flow_task`、`flow_run_state`、`flow_node_state`、`snapshot_cursor`、`last_event_id`。

`snapshot_cursor` 是这条 `flow_task.last_event_cursor`，没有则是 `0-0`。公开的 `status` 仍是 `flow_task.status`。`flow_node_state` 按这次 `flow_run_id` 读取，按 `node_id` 排序。Consumer 的 run 状态可以先终态，只要对应事件还没进 Stream，公开 `status` 就不要提前改成终态。

刷新这个画布时：

- active 列表里的每一条 run 都恢复，不只第一条
- 只处理当前这块画布的 `flow_id`。会话要记下 `flowId`，刷新时别把同一标签页里另一块画布的 run 画过来
- `sessionStorage` 里还记着、属于这块画布、但 active 列表里没有的 `flow_task_id`，再 GET 一次。已经终态就画出节点结果，清 cursor，不再 attach
- 有 `flow_node_state` 并且有 `snapshot_cursor`：先把节点画上，把本地 cursor 写成 `snapshot_cursor`，再 attach。attach 只补这个 cursor 后面的事件
- 没有节点快照：清掉本地 cursor，从 Stream 开头重放，让 handler 把画面补上

画法：每个节点写 `data.status` 和一条历史结果。`success` 再写 `setNodeResults`。别的仍在跑的 run 占用的节点不要改。WebSocket 上的 `flow_snapshot` 用同一套画法。不要再写组件里的 `NodeStatusMap`。

cursor 过期时：用上面的 GET 把节点画上，把本地 cursor 设成 `snapshot_cursor`，再以关闭码 `4005` 换一条物理连接。接下来的 attach 带这个 cursor。GET 失败就停在 exhausted，提示实时连接断开。不要清成空 cursor 再去 attach。空 cursor 会被当成 `0-0`，窗口已经没了就会再 `4409`。

现在收到 `4409` 会清 cursor 并停掉这一条 socket 的重连，这点留着。缺的是随后的快照和按 `snapshot_cursor` 重连。

## 现在

`WorkflowRunResponse` 没有 `flow_node_state`、`flow_run_state`、`snapshot_cursor`、`last_event_id`。`list_workflow_runs` 和 `get_workflow_run` 只倒出 `flow_task` 文档。

`restoreActiveRun` 只取 active 列表的第一条，GET 之后只用来 `setActiveRun`，然后用 sessionStorage 里的 cursor attach。cursor 已经停在最后一条时，刷新后没有新事件，节点不会回到运行中的样子。sessionStorage 里已经结束的 run 不会再 GET，结果也不会画回去。

`recoverExpiredCursor` 先清 cursor。run 还没结束就 `startWebSocketForFlow(flowTaskId)`，不带 cursor。`resetCursorAndReconnect` 也会把 cursor 清掉再关 `4005`。

`onFlowSnapshot` 把状态写进 `setNodeStatuses` 和 `setNodeResults` 的组件状态。画布若读 flow store，这一帧到不了节点上。

## 改哪些文件

1. `novelcomic-publisher/app/schemas/workflow_runs_v2.py` 的 `WorkflowRunResponse`，补上上面四个字段。
2. `novelcomic-publisher/app/services/workflow_runs_v2.py`，对照 OpenCreator `_response_with_snapshot`。`get_run` 和 active 列表走它。`get_run_summary` 仍只读 `flow_task`，给 WebSocket 握手用。
3. `novelcomic-publisher/app/controller/v2/flow_runs.py` 的 `list_workflow_runs`、`get_workflow_run` 改为返回这份带快照的响应。
4. `novelcomic-frontend/src/api/modules/flow.ts` 的 `WorkflowRunResponse` 补上同样的字段。
5. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `restoreActiveRun`、`onFlowSnapshot`、`recoverExpiredCursor`，对照 OpenCreator `restoreActiveRuns`、`applyWorkflowSnapshot`、`onResumeError`。过期后重连对照 `reattachFromCursor`：先写入 `snapshot_cursor`，再关 `4005`。不要调用现在的 `resetCursorAndReconnect`。
6. `novelcomic-frontend/src/lib/workflow-resumable-websocket.ts` 增加按给定 cursor 重连的方法，对照 `reattachFromCursor`。第 1 节的 event_id 去重留在同一个文件里，这一节只补换连接时带上的 cursor。

OpenCreator 对照：

- `opencreator-publisher/services/workflow_runs_v2.py` 的 `_response_with_snapshot`、`get_run`、`list_active_runs`
- `opencreator-publisher/schemas/workflow_runs_v2.py` 的 `WorkflowRunResponse`
- `opencreator-frontend/src/api/modules/flow.ts` 的 `WorkflowRunSnapshot`
- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `applyWorkflowSnapshot`、`restoreActiveRuns`、`onResumeError`、`onFlowSnapshot`
- `opencreator-frontend/src/lib/workflow-resumable-websocket.ts` 的 `reattachFromCursor`
