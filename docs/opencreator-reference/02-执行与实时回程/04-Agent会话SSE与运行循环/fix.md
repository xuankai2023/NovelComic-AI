# Agent 会话、SSE 与运行循环：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-agent`、`opencreator-frontend`。NovelComic 看 `novelcomic-agent`、`novelcomic-frontend`。

不在这一份：工具注册、Skills、MCP、某个工具怎么执行。这些在「Agent 工具、Skills 与 MCP」。画布 workflow 的 `attach_flow`、cursor、`4409` 在「可恢复 WebSocket」。节点 `select` 和 `continue` 在「工作流命令、DAG 与 HITL」。积分、埋点、PostHog、Sentry、蓝绿排空不进这一份。`run.failed` 里把死掉的 runner 收成终态要写，因为不写的话 SSE 会一直心跳；不要把整套 slot drain 搬过来。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是日志、类怎么拆、错误文案。

- 发送先 `POST /v1/agent/runs`，再 `GET /v1/agent/runs/{run_id}/events`。SSE 的 `id` 是 Redis Stream ID。`Last-Event-ID` 缺省按 `0-0`。空转时下行是 `: heartbeat`，前端不拿它改消息
- 同一个 `user_id + session_id + client_request_id` 再提交，返回已经有的 `run_id`，`created` 为 false，不再开第二个 loop
- 同一个 session 已经有 `queued` 或 `running` 的 task-backed run 时，返回 `409`，`detail.code` 是 `ACTIVE_RUN_EXISTS`，并带 `active_run_id`。`waiting_hitl` 不算这把互斥
- Stream 保留 24 小时，最多约 2000 条。cursor 早于当前最早一条时，订阅接口返回 `410`，`code` 是 `RESUME_WINDOW_EXPIRED`。订阅过程中窗口过期会再发一条 `agent.failed` 然后结束
- 终态事件是 `run.completed`、`run.failed`、`run.cancelled`。写入之后清掉这个 session 的 active run。基础 loop 默认 40 次，main profile 是 60
- 长期事实仍是 `agent_sessions`、`agent_messages`、`agent_chat_messages`、`agent_tool_traces`，外加 Redis `agent:session:*`。`save()` 先追加 raw messages，再写 session、投影、tool trace、缓存
- 工具 HITL 写在 `session.metadata["pending_hitl"]`。下一条用户输入走 `replace_last_tool_result()`，再追加 `hitl.resolved`，然后清掉 `pending_hitl`
- 前端发送会准备 `session_id`、`client_request_id`、乐观的用户消息和 assistant 消息，再订阅 SSE。刷新先查 `active-run`。取消会 abort 当前 SSE；有 `run_id` 走 cancel，只有 `client_request_id` 走 cancel-by-request。用户取消过的 session 不会马上再 resume
- 旧 `POST /v1/agent/chat` 和 `POST /api/v1/agent/chat/stop` 都是 `410`，`code` 是 `USE_AGENT_RUNS`。NovelComic 把 `code` 放在 JSON 顶层。OpenCreator 放在 `detail`。碰到这两条时收成 `HTTPException` 的 `detail`，不要把旧聊天实现补回来

# 1. 创建 run 要等锁，取消意图要先于 loop

做完要达到：`POST /v1/agent/runs` 成功时 HTTP 200，body 有 `run_id`、`status=queued`、`created`。`flow_id` 去掉空白。`X-User-Lang` 收成 locale，`X-Time-Zone` 收成时区。`agent_model` 解析成 preset id 和真实模型名，写进本次 run 的 metadata。私有上下文带 token、`flow_id`、`session_id`、`user_id`、时区、解析后的模型，以及规范化后的 `workflow_snapshot`。token 不要进会送给模型的可见消息。

`workflow_snapshot` 对不上当前 `flow_id`、缺 hash、缺采集时间或节点不是对象数组时，当成没有快照。前端提交的 `schema_version` 是 2，节点是 agent view，不是整份画布草稿。

创建前先看这个 `client_request_id` 是否已经登记取消。已经取消、run 还没有 meta：返回 `run_id`、`status=cancel_requested`、`created=false`，不启动 loop。已经有 meta：走第 2 节的取消，同样不启动 loop。

session 锁拿不到时，50 毫秒一次，最多 20 次。仍然拿不到：已经有 task-backed active run 就返回 `409 ACTIVE_RUN_EXISTS` 和 `active_run_id`；还没有就返回 `409`，`code` 是 `ACTIVE_RUN_CREATE_IN_PROGRESS`，`active_run_id` 为空。拿到锁之后再查一次 request key 和 active run。`create_run()` 成功后、启动 task 前，再查一次取消标记；已经取消就收成第 2 节，不调用 loop。

前端碰到 `409` 且带 `active_run_id`：丢掉这一次乐观插入的用户消息和 assistant 消息，改成订阅那个 run，并用 replay 把 UI 补上。`ACTIVE_RUN_CREATE_IN_PROGRESS` 按创建失败重试，重试间隔 `1s、3s、8s`，最多 3 次。不要把 `SESSION_RUN_LOCKED` 当成还有一个可以订阅的 run。

## 现在

锁失败立刻 `409`，`code` 是 `SESSION_RUN_LOCKED`，没有 `active_run_id`。创建路径不读取消标记，取消发生在 run 落库之前时，loop 仍会启动。新建成功返回 `202`。

`agent_model`、locale、时区没有收进 metadata。`workflow_snapshot` 会整段塞进系统消息。前端快照的 `schema_version` 是 1，来源是 `getPersistableFlowSnapshot`。

`409` 只要解析出 `active_run_id` 就直接订阅。乐观消息留着，`hydrateMessagesFromReplay` 传进去也没有被使用。没有 `ACTIVE_RUN_CREATE_IN_PROGRESS` 这条重试。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `create_agent_run`，对照 OpenCreator `create_agent_run`、`_return_existing_request_run`、`_resolve_agent_model_runtime`。模型 preset 对照 `opencreator-agent/creato/config/model_presets.py` 的 `list_agent_model_presets`。快照规范化继续用现有的 `normalize_request_workflow_snapshot`，不要另写一套。
2. `novelcomic-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts` 的创建 run。`409` 带 `active_run_id` 时打开 replay，并去掉这次乐观消息。`ACTIVE_RUN_CREATE_IN_PROGRESS` 走上面的三次重试。
3. `novelcomic-frontend/src/features/agent-chat/hooks/use-agent-run-controller.ts` 的发送快照，对照 `toAgentWorkflowView`，`schema_version` 用 2。

OpenCreator 对照：

- `opencreator-agent/creato/api/server.py` 的 `create_agent_run`
- `opencreator-agent/creato/config/model_presets.py`
- `opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts` 的 `createRun`
- `opencreator-frontend/src/lib/agent-workflow-view.ts` 的 `AGENT_VIEW_SCHEMA_VERSION`、`toAgentWorkflowView`
- `opencreator-frontend/src/features/agent-chat/hooks/use-agent-run-controller.ts` 里组 `workflowSnapshotPayload` 的那段

# 2. 取消：run 还没有时只登记，queued 要写成终态

做完要达到：`POST /v1/agent/runs/cancel-by-request` 先写下取消标记。这时还没有 `run_id`，返回 `{status: "cancel_requested"}`。有 `run_id` 但还没有 meta，返回 `{status: "cancel_requested", run_id}`。有 meta 就和按 `run_id` 取消同一条路径。

按 `run_id` 取消：run 不存在是 `404`，不是当前用户是 `403`。已经是 `completed`、`failed`、`cancelled` 时原样返回这个 status，不再写事件。本进程里的 task 还在，就 cancel 它并等它结束；结束之后 meta 已经是终态，返回那个 status。

task 还没起来、公开 status 仍是 `queued`：写入 `agent.stopped` 和 `run.cancelled`，返回 `{status: "cancelled", run_id}`。status 已经是 `running`、task 不在本进程：只留下取消标记，返回 `{status: "cancel_requested", run_id}`，由持有 loop 的那一侧收尾。

## 现在

两条取消都返回 `{run_id, cancelled: true}`。run 还不存在时 `run_id` 是 null，仍然 `cancelled: true`。`queued` 且 task 还没登记时，不写 `agent.stopped` 和 `run.cancelled`。已经终态的 run 也会再标一次取消。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `cancel_agent_run`、`cancel_agent_run_by_request`，对照 OpenCreator `_cancel_agent_run_by_id`。第 1 节创建前发现取消标记时调用同一条路径。

OpenCreator 对照：

- `opencreator-agent/creato/api/server.py` 的 `_cancel_agent_run_by_id`、`cancel_agent_run_by_request`

# 3. 断线后用 Last-Event-ID 续上，同一个 event id 不再画第二次

做完要达到：订阅用 `fetchEventSource`。`onopen` 要求 2xx 且 `Content-Type` 含 `text/event-stream`。连接在终态之前关掉，按 `1s、2s、4s、8s、15s、30s` 重连，最多 10 次。重连带上最后一条 SSE `id` 作为 `Last-Event-ID`。

同一条订阅里见过的 `id` 最多留 500 个。再见到同一个 id，不再更新消息。心跳 comment 仍然不进消息。

`410`，以及流里的 `agent.failed` 内容是恢复窗口过期时：停止重连，重新拉 `GET /v1/agent/sessions/{session_id}/messages`，把历史画回去。不要拿同一个 cursor 再订阅。

服务端在 `xread` 抛 Redis 错误时结束这条 SSE，让前端按上面的间隔重连。窗口过期时的 `agent.failed` 带上 `last_event_id` 和 `earliest_event_id`。`410` 的 `detail` 带 `code`、`message`、`last_event_id`、`earliest_event_id`。

刷新恢复 active run 时带 `hydrateMessagesFromReplay`。replay 和 live 走同一套投影，已有的 assistant 气泡按 `message_id` 合并，文本不要再追加一遍。

## 现在

`subscribeAgentRunEvents` 只 `fetch` 一次。流中途断开不会带 `Last-Event-ID` 再连。没有已见 `id` 集合。`chat.message.delta` 对同一 `part_id` 是把 `text` 拼到后面，replay 会把同一段再拼一次。

`hydrateMessagesFromReplay` 只出现在参数里，订阅时没有读它。HTTP `410` 会调 `onResumeWindowExpired` 并拉历史。流中间那条 `agent.failed` 被当成普通终态，停掉 run，不会拉历史。`410` 的 `detail` 没有 `message` 和 `last_event_id`。`xread` 失败会把生成器打崩，前端没有重连。

## 改哪些文件

1. `novelcomic-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts`，对照 OpenCreator `fetchEventSource`、`shouldSkipSeenEventId`、`onerror`。第 1 节的 `409` 重试留在同一个文件里。恢复窗口过期对照 `isResumeWindowExpiredStreamError`：停重连，把失败文案留给历史同步。
2. `novelcomic-frontend/src/features/agent-chat/hooks/use-agent-run-controller.ts` 的 `resumeActiveRun`。`hydrateMessagesFromReplay` 为 true 时，先按 replay 补消息，再接 live。
3. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `stream_agent_run_events`。`410` 和流内 `agent.failed` 补上 cursor。Redis 读失败时结束这条响应。终态仍然只认 `run.completed`、`run.failed`、`run.cancelled`。

OpenCreator 对照：

- `opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts` 的 `seenEventIds`、`onerror`、`shouldHydrateMessagesFromReplay`
- `opencreator-agent/creato/api/server.py` 的 `stream_agent_run_events`

# 4. 后台 task 不在了，订阅要看到 run.failed

做完要达到：公开 status 还是 `queued` 或 `running`，但这条 run 的 task 已经不在本进程时，先写入终态再继续读 Stream。事件顺序是：仍在跑的 workflow 节点各一条 `workflow.node_status` 和 `workflow.node_failed`，status 为 `failed`，`error_code` 为 `RUNNER_INTERRUPTED`；然后 `workflow.failed`；然后 `agent.failed`，`error` 为 `RUNNER_INTERRUPTED`；然后 `run.failed`。写完之后 active run 按已经对齐的终态规则清掉。

两条入口都要做这个判断：`GET /v1/agent/runs/{run_id}/events` 一开始，以及 `GET /v1/agent/sessions/{session_id}/active-run`。active-run 发现 task 已经死了，就把 run 收成上面的失败，响应 `{run_id: null}`。还活着时返回 `{run_id, status}`，status 用 meta。没有 active run 也是 `{run_id: null}`，不要再包一层 `status: idle` 和整份 meta。

空读之后如果 meta 仍是 `queued` 或 `running` 而 task 已死，同样走上面的写入，然后继续读，把刚写下的 `run.failed` 推给当前连接。不要在这种空读上只发 heartbeat。

## 现在

事件循环只在 meta 已经是 `completed`、`failed`、`cancelled` 时再读一次尾部然后关闭。task 中途没了、Stream 里没有终态事件时，会一直 `: heartbeat`。

`active-run` 只看 meta status。`queued` 或 `running` 就返回 `run_id`，另外带上整份 meta。没有 run 时是 `{run_id: null, status: "idle"}`。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `stream_agent_run_events`、`get_active_agent_run`，对照 OpenCreator `_is_task_backed_run_alive`、`_mark_run_interrupted`、`_get_live_active_run`。节点失败事件只把聊天里还能看到的运行中节点收成失败。画布那条 WebSocket 不要在这里重放。

OpenCreator 对照：

- `opencreator-agent/creato/api/server.py` 的 `_mark_run_interrupted`、`_get_live_active_run`、`stream_agent_run_events` 里空读之后的存活判断

# 5. 正文按 token 刷出，长历史要裁，失败也要留在投影里

做完要达到：loop 里的文本增量先是 `message.delta`。服务端按 50 毫秒或 256 字刷成一条 `chat.message.delta`，思考按 200 毫秒或 800 字刷成 `thinking.delta`。结束、取消、工具调用前把缓冲区强制刷完。前端 `chat.message.delta` 和 `thinking.delta` 都进当前 assistant 气泡。

进模型前：microcompact，再按 token 预算裁历史。切口落在完整的 tool call 边界上，裁完的第一条是 user。被裁掉的部分压缩进上下文，不要只留最近 80 条原文。全局并发门读 `CREATO_MAX_CONCURRENT_REQUESTS`，默认 500；小于等于 0 表示不限制。main profile 的 60 次上限保持，不要改成所有 profile 共用这一个数。

用户消息在调用模型前写入 Mongo。这一轮后来失败：把失败写进 session 和聊天投影，再发 `agent.failed` 和 `run.failed`。用户在这条用户消息已经落库之后取消：投影里留下取消态，再发 `agent.stopped` 和 `run.cancelled`。刷新后历史接口能读到这轮用户消息和这个终态，不只有 SSE 里闪过的字。

交互卡片在 run 还没结束时就 upsert 进 `agent_chat_messages`：`workflow_select`、`generation_confirm`，以及 `workflow.selection_resolved` 变成的 runtime status。同一 `part_id` 后来的事件覆盖这一条，workflow 节点结果按已有合并规则叠到同一张卡上。

## 现在

`_call_llm` 等整段返回之后，才发一条 `chat.message.delta` 和一条 `thinking.delta`。没有 `message.delta`，也没有按时间和字数刷出。

`_trim_history` 返回 `messages[-80:]`。没有 token 预算，也没有把丢掉的历史压缩回去。全局门默认 8，还读了 `AGENT_MAX_CONCURRENT_REQUESTS`。

用户消息在 loop 前 `save()` 了。失败和取消只往 Stream 写事件，不再把这轮终态写进投影。`SessionManager` 没有 `upsert_chat_projection_part`。投影要等整轮 `save()` 才重建。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/core/loop.py` 的 `_process_message`、`_run_agent_loop`、`_trim_history`，对照 OpenCreator `_persist_user_message_early`、`_trim_history`、`_compress_dropped`、`_persist_agent_failure_after_error`、`_persist_agent_cancelled_after_early_user`。文本增量先发 `message.delta`。
2. `novelcomic-agent/src/novelcomic_agent/api/server.py` 里消费 loop 事件、写入 Stream 的那段，对照 `flush_delta_buffers` 和 `persist_live_chat_part`。刷出策略对照 `opencreator-agent/creato/api/delta_flush.py`。
3. `novelcomic-agent/src/novelcomic_agent/session/manager.py` 增加 `upsert_chat_projection_part`。最终 `save()` 的重建继续保留，和中途 upsert 用同一套 part 合并。

OpenCreator 对照：

- `opencreator-agent/creato/core/loop.py` 的 `_on_text_delta`、`_trim_history`、`_compress_dropped`、`_persist_user_message_early`
- `opencreator-agent/creato/api/server.py` 的 `flush_delta_buffers`、`persist_live_chat_part`、`_should_persist_live_chat_part`
- `opencreator-agent/creato/api/delta_flush.py`
- `opencreator-agent/creato/session/manager.py` 的 `upsert_chat_projection_part`

# 6. HITL 的下一条输入要变成带选项的 tool result，刷新后卡片还在

做完要达到：`pending_hitl.type` 只认 `select` 和 `ask`，别的按 `select`。恢复时 `replace_last_tool_result()` 的正文是用户这条回复。`select` 在选项里对上 id 或 label，投影事件带 `selected_option_id` 和 `submitted_reply_label`。`ask` 带 `answers`。然后追加 `hitl.resolved`，清掉 `pending_hitl`，再继续 loop。

`run.completed` 到来时，如果当前 status 已经是 `waiting_hitl`，status 保持 `waiting_hitl`，不要清 active run。`tool.event` 且 `event_name` 为 `hitl.request` 时写成 `waiting_hitl`，这点和现码一致，保留。

聊天投影除了现在的 text、tool_step、hitl，还要能从本轮 raw 事件还原 workflow 节点结果、`workflow_select`、`generation_confirm`。同一条 HITL 被 resolved 之后，历史接口读出的 part status 是 resolved，并带上当时的选项或回答。

工作流选择和生成确认不走下一条聊天消息。session 锁还被这次工具调用拿着，再发聊天会排在它后面。

- `POST /v1/agent/workflow/select` 的 body 有 `flow_task_id`、`node_id`、`selected_indices`。确认后把对应 select 卡写成已解决，并追加一条 runtime 消息
- `POST /v1/agent/generation/confirm` 的 body 有 `confirm_id`、`group_id`、`action`（`approve` 或 `reject`）、`params`。`group_id` 默认 `all`，只作用于还没决策的行。卡片不属于当前用户返回 `403`。未知 `group_id` 返回 `400`。没有这张卡返回 `404`

工具内部怎么改节点参数、怎么守卫模型，留在「Agent 工具、Skills 与 MCP」。这一节只补请求体、归属校验，以及投影里的卡片状态。

## 现在

`_resolve_pending_hitl` 把用户原文直接写进 tool result。`hitl.resolved` 的 payload 没有 `selected_option_id` 和 `answers`。

`_status_after_event` 见到 `run.completed` 一律写成 `completed` 并清 active run。`waiting_hitl` 守不住。

`_build_chat_messages_for_turn` 只处理 user、assistant、tool_call、tool_result、tool_event。workflow 节点结果、选择卡、生成确认卡刷新后不在历史里。

`WorkflowSelectRequest` 只有 `flow_task_id`，响应是当时的 snapshot。`GenerationConfirmRequest` 只有 `confirm_id`，找到卡就返回 `confirmed`。没有 `group_id`、`action`、`params`。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/core/loop.py` 的 `_resolve_pending_hitl`、`_persist_hitl_interrupt`，对照 OpenCreator `_process_message` 里 `pending_hitl` 那段。
2. `novelcomic-agent/src/novelcomic_agent/services/agent_redis_run_store.py` 的 `_status_after_event`。在已有的 `waiting_hitl` 判断之外，`run.completed` 不要把 `waiting_hitl` 收成 `completed`。
3. `novelcomic-agent/src/novelcomic_agent/session/manager.py` 的 `_build_chat_messages_for_turn`，对照 `_workflow_select_part`、`_workflow_node_result_part`、`_generation_confirm_chat_part`、`_apply_hitl_resolution_to_parts`。
4. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `workflow_select`、`generation_confirm`。请求体补上上面的字段。写投影用第 5 节的 upsert。

OpenCreator 对照：

- `opencreator-agent/creato/core/loop.py` 里 `pending_hitl` 的 select / ask 分支
- `opencreator-agent/creato/services/agent_redis_run_store.py` 的 `_status_after_event`
- `opencreator-agent/creato/session/manager.py` 的 `_build_chat_messages_for_turn`、`_resolve_workflow_select_part`
- `opencreator-agent/creato/api/server.py` 的 `workflow_select`、`generation_confirm`

# 7. 历史按投影分页，反馈和模型列表走现成接口

做完要达到：`GET /v1/agent/sessions` 只返回当前用户的会话。可以带 `workflow_id`。`limit` 默认 10，最大 50。`after` 是上一页最后一条的 `session_id`，按 `updated_at` 往前翻。响应是 `{sessions, has_more}`。每条只有列表字段：`session_id`、`workflow_id`、`status`、`summary`、`turn_count`、`last_message_preview`、`current_hitl`、`pipeline_state`、时间。不要把整份 metadata 倒出去。

`GET /v1/agent/sessions/{session_id}/messages`：session 不存在返回 `404`。`user_id` 对不上返回 `403`。不要 `get_or_create`。读的是 `agent_chat_messages`。支持 `turns` / `before_turn`，也支持 `limit` / `before_seq`。响应带 `messages`、`has_more`、`session_state`。`session_state` 含 `revision`、`status`、`current_hitl`、`pipeline_state`。

`PUT /v1/agent/sessions/{session_id}/feedback` 的 `rating` 只接受 `like` 和 `dislike`，按 `session_id + turn + user_id` upsert。`DELETE` 带 `turn`，删当前用户的这一条。session 不属于当前用户同样 `403`，不存在 `404`。

`GET /v1/agent/models` 返回 `{default_model, models}`。`models` 来自和创建 run 同一份 preset 列表，默认项 `is_default` 为 true。

前端 `fetchAgentSessions` 继续传 `workflow_id`、`limit`、`after`。`fetchAgentMessages` 继续能按 `before_seq` 翻页。`submitFeedback` / `deleteFeedback` 的 rating 用 `like` / `dislike`。`fetchAgentModels` 读上面的列表，创建 run 时提交选中的 preset id。

## 现在

会话列表把 Mongo 文档整份返回，不按 `workflow_id` 过滤，没有 `after` 和 `has_more`。`limit` 默认 20，最大 100。

历史接口先 `get_or_create`。没有这份 session 时得到一份空的内存 session，`user_id` 为空就通过归属检查，返回空消息，而不是 `404`。

没有 feedback 路由，也没有 `GET /v1/agent/models`。前端已经在调这两个地址。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/session/manager.py` 增加 `list_sessions`。`get_messages_page` 补上 `turns` 和 `before_turn`，没有文档时不要创建 session。
2. `novelcomic-agent/src/novelcomic_agent/api/server.py` 的 `list_agent_sessions`、`get_agent_session_messages`，加上 feedback 的 PUT、DELETE，以及 `GET /v1/agent/models`。preset 和第 1 节共用。
3. `novelcomic-frontend/src/features/agent-chat/api/agent-chat.api.ts` 的 feedback rating 收成 `like` | `dislike`。会话和消息的查询参数跟上面的接口对齐。

OpenCreator 对照：

- `opencreator-agent/creato/session/manager.py` 的 `list_sessions`、`get_messages_page`
- `opencreator-agent/creato/api/server.py` 的 `list_sessions`、`get_session_messages`、`submit_feedback`、`list_agent_models`
- `opencreator-frontend/src/features/agent-chat/api/agent-chat.api.ts` 的 `fetchAgentSessions`、`fetchAgentMessages`、`submitAgentFeedback`、`fetchAgentModels`
