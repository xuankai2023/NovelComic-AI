# OpenCreator 是怎么做 Agent 会话、SSE 与运行循环的

这篇按运行时视角讲一遍“谁调用谁”。如果要看机制拆解，读 [00-Agent会话SSE与运行循环技术点.md](./00-Agent会话SSE与运行循环技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一、先说结论

OpenCreator 的 Agent 聊天是 task-backed run 加 SSE 事件流。前端不是直接调用一个长连接聊天接口，而是先创建 run，后端在后台 task 中跑 AgentLoop，并把事件写入 Redis Stream；前端再用 SSE 订阅这个 run 的事件，用 `Last-Event-ID` 续接断线期间的输出。

```text
sendMessage()
  → POST /v1/agent/runs
  → run_id
  → GET /v1/agent/runs/{run_id}/events
  → agent.started
  → chat.message.created
  → chat.message.delta / thinking.delta / tool.*
  → chat.message.completed
  → run.completed / run.failed / run.cancelled
```

必须分清四个状态：

- 有 `session_id`：属于某个多轮会话。
- 有 `client_request_id`：这次用户输入有幂等身份。
- 有 `run_id`：后端已经接受这次输入并创建 task-backed run。
- 有 SSE `id`：前端知道事件续接位置。

这四个状态不要压成一个 `isRunning`。NovelComic 落地时，UI 可以只显示一个“正在生成”，但代码里必须保留这四层身份。

---

## 二、前端：创建 run，再读 SSE

按用户发送一条消息后的调用顺序看。第 4 步才创建 run，第 5 步才开始 SSE；前 3 步都只是准备会话、请求身份和运行状态。

1. `src/features/agent-chat/hooks/use-agent-run-controller.ts`：把发送、恢复、取消转成 Agent run 动作。
2. `src/features/agent-chat/runtime/agent-run-store.ts`：保存 active run、AbortController、取消标记和画布 refs。
3. `src/features/agent-chat/api/agent-chat.api.ts`：封装非 SSE 的普通 HTTP API。
4. `src/features/agent-chat/runtime/stream/agent-chat-stream.ts`：先 `POST /v1/agent/runs` 创建 run，再订阅 SSE。
5. `src/features/agent-chat/runtime/stream/agent-chat-event-replay.ts`：把 live / replay 事件投影成聊天 UI 状态。
6. `src/features/agent-chat/shared/agent-chat-types.ts`：定义前端事件、消息、part、工具和 HITL 类型。
7. `src/features/agent-chat/runtime/use-agent-chat.ts`：把 run、HITL、workflow 同步和反馈动作收口给组件。

### `src/features/agent-chat/hooks/use-agent-run-controller.ts`

OpenCreator 源码：[use-agent-run-controller.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/hooks/use-agent-run-controller.ts)

用户发送消息时，这层先准备：

- `session_id`：没有当前会话时创建一个新 session。
- `client_request_id`：一次用户输入的幂等 id。
- `workflow_snapshot`：当前画布的私有上下文快照。
- `metadata.files` / `rich_text_html`：附件和富文本上下文。
- optimistic user message 和 assistant message。

然后调用：

```text
runAgentChatStream()
```

恢复 active run 和取消 run 也从这里发起。

### `src/features/agent-chat/runtime/agent-run-store.ts`

OpenCreator 源码：[agent-run-store.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/agent-run-store.ts)

它保存运行时共享引用：

- `runAbortRef`
- `activeAgentRunIdRef`
- `activeAgentRequestRef`
- `resumeActiveRunInFlightRef`
- 用户主动取消过的 session / run
- 画布 nodes / edges / results / workflow 状态 refs

这层避免多个 hook 各自维护一份 run 状态，导致刷新恢复、取消和画布同步互相覆盖。

### `src/features/agent-chat/api/agent-chat.api.ts`

OpenCreator 源码：[agent-chat.api.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/api/agent-chat.api.ts)

封装普通 HTTP API，例如：

- `fetchAgentSessions()`
- `fetchActiveAgentRun()`
- `cancelAgentRun()`
- `cancelAgentRunByRequest()`
- `submitWorkflowSelection()`
- `submitGenerationConfirm()`
- `submitFeedback()`

创建 run 和订阅 SSE 不放在这里，仍由 `agent-chat-stream.ts` 处理。

### `src/features/agent-chat/runtime/stream/agent-chat-stream.ts`

OpenCreator 源码：[agent-chat-stream.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts)

第一步创建 run：

```text
POST {AGENT_BASE_URL}/v1/agent/runs
Authorization: Bearer <__opencreator_jwt>
```

body 里关键字段：

```json
{
  "message": "...",
  "session_id": "...",
  "flow_id": "...",
  "stream": true,
  "agent_model": "...",
  "client_request_id": "...",
  "client_request_sent_at_utc_ms": 1710000000000,
  "workflow_snapshot": {
    "flow_id": "...",
    "schema_version": 2,
    "snapshot_hash": "...",
    "nodes": [],
    "edges": []
  },
  "metadata": {
    "files": [],
    "rich_text_html": "..."
  }
}
```

成功后返回：

```json
{
  "run_id": "run_xxx",
  "status": "queued",
  "created": true
}
```

如果返回 `409 ACTIVE_RUN_EXISTS` 且带 `active_run_id`，前端转为订阅已有 active run，并通过 replay 补 UI。

第二步订阅 SSE：

```text
GET {AGENT_BASE_URL}/v1/agent/runs/{run_id}/events
Accept: text/event-stream
Authorization: Bearer <token>
```

`fetchEventSource()` 收到事件后按 `event.event` 分发。

### `src/features/agent-chat/runtime/stream/agent-chat-event-replay.ts`

OpenCreator 源码：[agent-chat-event-replay.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-event-replay.ts)

这层把事件 payload 归一化为 UI 投影，例如：

- 文本 delta。
- 工具 started / completed / failed。
- HITL 请求。
- workflow 节点状态。
- 任务 pipeline 状态。

live 事件和恢复 replay 要走同一套投影逻辑，否则刷新后工具卡片、HITL 卡片和任务面板会变形。

---

## 三、后端：保存事实，再推事件

按一次请求走进来的顺序看。HTTP 入口只创建 run 和打开事件读口；真正的推理与工具调用在后台 task 的 AgentLoop 里跑。

1. `creato/api/server.py`：Agent API 入口，创建 run、订阅 SSE、取消、active-run、历史消息。
2. `creato/services/agent_redis_run_store.py`：run meta、request 幂等、active run、Redis Stream、取消标记。
3. `creato/core/events.py`：统一事件名和 payload constructor。
4. `creato/core/loop.py`：加载 session，构造上下文，迭代 LLM 和 tool。
5. `creato/session/manager.py`：保存 raw messages、session metadata、chat projection、tool trace。
6. `creato/schemas/session.py`：定义 session、message、projection、tool trace 文档形状。
7. `creato/agents/main/profile.py`：定义 main Agent 的工具集合和默认运行配置。

### `creato/api/server.py`

OpenCreator 源码：[server.py](../../../../../opencreate/opencreator-agent/creato/api/server.py)

`POST /v1/agent/runs` 做这些事：

```text
验证 JWT
  → 规范化 flow_id / locale / model
  → 解析 client_request_id
  → 检查 request_key 是否已有 run
  → 获取 session run lock
  → 检查 active run
  → RedisRunStore.create_run()
  → _start_agent_run_task()
  → 返回 run_id
```

`GET /v1/agent/runs/{run_id}/events` 做这些事：

```text
验证 JWT
  → 读取 run meta
  → 校验 meta.user_id == 当前用户
  → 检查 task-backed run 是否还活着
  → resume_cursor = Last-Event-ID or 0-0
  → ensure_resume_available()
  → StreamingResponse(text/event-stream)
```

它还提供：

- `GET /v1/agent/sessions/{session_id}/active-run`
- `POST /v1/agent/runs/{run_id}/cancel`
- `POST /v1/agent/runs/cancel-by-request`
- `GET /v1/agent/sessions`
- `GET /v1/agent/sessions/{session_id}/messages`

旧 `POST /v1/agent/chat` 只返回 `410 USE_AGENT_RUNS`。

### `creato/services/agent_redis_run_store.py`

OpenCreator 源码：[agent_redis_run_store.py](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)

它负责 task-backed run 的运行时事实：

```text
create_run()
  → request_key NX
  → run meta hash
  → active_run_key(session_id)
  → stream TTL

append_event()
  → XADD stream
  → 更新 last_event_id / status
  → terminal event 清 active run

read_events()
  → ensure_resume_available()
  → XREAD
```

这层也是 `client_request_id` 幂等、session active run、取消标记和恢复窗口检查的核心。

### `creato/core/events.py`

OpenCreator 源码：[events.py](../../../../../opencreate/opencreator-agent/creato/core/events.py)

后端统一构造 `AgentEvent`：

```text
AgentEvent(event, data)
  → {"event": "...", "data": {...}}
```

SSE 层只负责把它格式化为：

```text
id: <redis-stream-id>
event: <event-name>
data: <json>
```

事件生产者不要直接拼 SSE 文本。

### `creato/core/loop.py`

OpenCreator 源码：[loop.py](../../../../../opencreate/opencreator-agent/creato/core/loop.py)

AgentLoop 外层先过两道并发保护：

```text
session lock
  → CREATO_MAX_CONCURRENT_REQUESTS 全局并发门
```

进入 `_process_message()` 后整理上下文：

```text
读取 session 历史
  → 恢复 task store
  → 处理 pending_hitl
  → 注入 hook / pipeline session constraints
  → 收集历史上传文件
  → memory retrieve
  → microcompact_history
  → 上下文裁剪
  → 必要时压缩 dropped history
  → build_messages()
```

构造好 prompt 后，会提前持久化当前用户消息，避免 SSE 中断或后端异常导致整轮用户输入丢失。

真正执行在 `_run_agent_loop()`：

```text
LLM
  → message.delta / thinking.delta
  → tool_calls
  → tool.started
  → 执行 tool
  → tool.completed / tool.failed / tool.event
  → tool result 回填
  → 下一次 LLM
```

### `creato/session/manager.py`

OpenCreator 源码：[manager.py](../../../../../opencreate/opencreator-agent/creato/session/manager.py)

长期事实写入顺序强调两点：

```text
append raw messages
  → upsert session metadata
  → rebuild chat projection
  → insert tool traces
  → write Redis session cache
```

前端实时 UI 来自 SSE；刷新后的历史 UI 来自：

```text
GET /v1/agent/sessions/{session_id}/messages
```

这条历史接口读取的是 chat projection，不是 Redis run stream。Redis run stream 只是短期恢复窗口。

---

## 四、运行时链路

### 1. 用户发送消息

```text
用户点击发送
  → useAgentRunController.sendMessage()
  → 准备 session_id
  → 生成 client_request_id
  → 插入 optimistic user / assistant message
  → 生成 workflow_snapshot
  → runAgentChatStream()
```

这时还没有 SSE，只是在准备创建 run。

### 2. 创建 Agent run

```text
runAgentChatStream
  → POST /v1/agent/runs
  → Agent API 验 JWT
  → 检查 client_request_id 幂等
  → 检查 session active run
  → RedisRunStore.create_run()
  → _start_agent_run_task()
  → 返回 run_id
```

这一步返回 `queued`，不表示 Agent 已经完成回答。

### 3. 订阅 SSE

```text
runAgentChatStream
  → GET /v1/agent/runs/{run_id}/events
  → Last-Event-ID or 0-0
  → RedisRunStore.read_events()
  → yield SSE
```

循环里：

```text
有事件
  → yield id/event/data

没有事件
  → yield heartbeat comment

终态事件
  → 结束 SSE
```

终态事件包括：

- `run.completed`
- `run.failed`
- `run.cancelled`

### 4. 后台 task 跑 AgentLoop

```text
_start_agent_run_task()
  → AgentLoop.run()
  → SessionManager.get_or_create(session_id)
  → _process_message()
  → _run_agent_loop()
```

AgentLoop 会不断产生事件并写入 Redis Stream：

```text
agent.started
chat.message.created
chat.message.delta
chat.part.upsert
tool.started / tool.completed / tool.failed
workflow.node_status
chat.message.completed
run.completed / run.failed / run.cancelled
```

### 5. 前端按事件更新 UI

`agent-chat-stream.ts` 收到事件后按事件名分发：

```text
agent.started
  → 绑定真实 session_id

chat.message.created
  → 创建 assistant message

chat.message.delta
  → 文本泵追加正文

chat.part.upsert
  → 更新工具卡片、HITL、workflow 卡片

chat.message.completed
  → 完成 assistant message

run.completed / run.failed / run.cancelled
  → 结束 run 生命周期
```

它还处理：

- `tool.event=hitl.request`：显示 HITL 输入或选择。
- `workflow.node_status`：同步聊天里的节点状态，必要时同步画布。
- `agent.failed`：生成失败消息和诊断。
- `agent.stopped`：取消态 UI。

### 6. 刷新恢复 active run

刷新或重新进入 session 时：

```text
GET /v1/agent/sessions/{session_id}/active-run
  → 如果有 active run_id
  → runAgentChatStream(existingRunId=run_id, hydrateMessagesFromReplay=true)
  → GET /v1/agent/runs/{run_id}/events
```

如果没有 active run，前端同步历史消息和画布状态。

恢复 active run 时，前端不会再发新的用户输入；它只是订阅已有 run 的 SSE，并根据 replay 事件补 UI。

### 7. 取消 run

已知 `run_id` 时：

```text
POST /v1/agent/runs/{run_id}/cancel
```

只知道 `client_request_id` 时：

```text
POST /v1/agent/runs/cancel-by-request
```

第二条用于 run 创建还在路上、前端已经点了取消的情况。前端取消时还会 abort 当前 SSE，并记录用户主动取消，避免马上 resume 同一个 run。

---

## 五、和画布运行链路的关系

Agent 可以通过工具操作画布和 workflow：

- `run_workflow`
- `get_workflow`
- `edit_workflow`
- `update_canvas_node`
- `get_workflow_results`

这些工具产生的 workflow 事件可以被桥接成 Agent SSE 的 `workflow.*` 事件，让聊天里显示节点进度或结果。

但边界必须清楚：

```text
Agent SSE
  → 聊天 UI、工具卡、HITL、部分 workflow 状态投影

画布 workflow WebSocket
  → 某个 flow_task_id 的完整可恢复运行事件
```

Agent SSE 不替代画布可恢复 WebSocket。

---

## 六、和 NovelComic 对照

NovelComic 迁移这组时，不要写成“一个 POST 直接返回 SSE 流”。按 OpenCreator 的现网模型，必须拆成：

1. `POST /v1/agent/runs`：创建可幂等 run。
2. `GET /v1/agent/runs/{run_id}/events`：订阅这个 run 的 SSE。
3. Redis Stream：保存短期事件和恢复 cursor。
4. Mongo session / chat projection：保存长期聊天事实。
5. `active-run`：刷新后找回正在跑的 run。
6. `cancel-by-request`：覆盖 run 尚未创建完成时的取消。

如果只看到文本能流式输出，但没有 `client_request_id` 幂等、session active run 互斥、`Last-Event-ID` 恢复和 Mongo 历史重建，这组还没完成。不要把旧 `POST /v1/agent/chat` 复活成新的主链路。
