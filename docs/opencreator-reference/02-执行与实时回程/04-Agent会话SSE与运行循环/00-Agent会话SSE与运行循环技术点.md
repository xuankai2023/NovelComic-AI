# Agent 会话、SSE 与运行循环：技术点

这组只讲 Agent 聊天运行链路。它不是画布 workflow run，也不是“一个 POST 请求直接流式返回完整对话”。OpenCreator 现网把 Agent 拆成两步：先创建可幂等的 run，再订阅这个 run 的 SSE 事件流。

先背三句话：

```text
Session 负责多轮会话事实；
Agent run 负责一次用户输入；
SSE 负责把这个 run 的事件按 Redis Stream cursor 续接给前端。
```

最短链路是：

```text
前端 sendMessage
  → 生成 session_id / client_request_id
  → POST /v1/agent/runs
  → client_request_id 幂等
  → session active run 互斥
  → RedisRunStore 创建 run 和 Stream
  → 后台 task 进入 AgentLoop
  → AgentLoop 加载 session、构造上下文、调用 LLM / tool
  → RedisRunStore.append_event()
  → GET /v1/agent/runs/{run_id}/events
  → SSE id = Redis Stream ID
  → 前端按 event id 去重、渲染消息和工具卡片
```

先把三层事实分开：

| 名字 | 作用 | 事实源 |
| --- | --- | --- |
| `session` | 多轮聊天、HITL、pipeline state、历史消息 | Mongo + Redis session cache |
| `run` | 某一次用户输入的执行实例 | Redis run meta + Redis Stream |
| `SSE` | 当前 run 的短期事件传输和断线续接 | Redis Stream ID / `Last-Event-ID` |

Agent SSE 的恢复边界是 `Last-Event-ID`，不是画布 WebSocket 的 `attach_flow(last_event_cursor)`。这两套协议不能混用。

相关专题：

- 登录到画布亮灯：[01-从登录到画布亮灯](../01-从登录到画布亮灯/01-从登录到画布亮灯.md)
- 工作流命令和 HITL：[02-工作流命令DAG与HITL](../02-工作流命令DAG与HITL/01-工作流命令DAG与HITL.md)
- 可恢复 WebSocket：[03-可恢复WebSocket](../03-可恢复WebSocket/03-可恢复WebSocket.md)

---

## 1. Agent run 是一次输入，不是一整个 session

Agent 前端每发送一次用户输入，就创建或复用一个 task-backed run：

```text
POST /v1/agent/runs
```

OpenCreator 对照源码：

- [server.py](../../../../../opencreate/opencreator-agent/creato/api/server.py)
- [agent_redis_run_store.py](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)
- [agent-chat-stream.ts](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts)

run 返回的是本轮执行身份：

```json
{
  "run_id": "run_xxx",
  "status": "queued",
  "created": true
}
```

同一个 session 可以有多轮 run，但同一时间只能有一个 active task-backed run。新的用户输入如果撞上已有 active run，要返回 `409 ACTIVE_RUN_EXISTS` 或让前端订阅已有 `active_run_id`。

常见 run 状态：

```text
queued / running / waiting_hitl / completed / failed / cancelled
```

其中 task-backed active run 主要按 `queued` 和 `running` 管理。工具触发的 HITL 长期恢复点在 session metadata，不要只靠 run status 判断。

---

## 2. client_request_id 做入口幂等

前端生成 `client_request_id`，随 `POST /v1/agent/runs` 一起提交。后端用下面的键记录这次请求对应的 `run_id`：

```text
request_key(user_id, session_id, client_request_id)
```

同一个 `client_request_id` 重试时，后端返回已有 run，而不是再开一个 AgentLoop。

这解决三类问题：

- 前端创建 run 超时后重试。
- 同一条用户输入被重复提交。
- 用户取消发生在 run 创建前后不同时间点。

取消也可以按 request 走：

```text
POST /v1/agent/runs/cancel-by-request
```

这样即使 run 还没创建完成，也能先登记取消意图，后续创建成功再关联取消。

---

## 3. session active run 互斥

Agent 会话不是并发聊天。OpenCreator 用 Redis 锁保护创建期：

```text
agent_run_store.acquire_session_run_lock(session_id, owner)
```

创建 run 时先拿 session run lock，再检查 active run。

语义是：

- 同一个 session 不能同时有两个 task-backed run。
- active run 状态主要包括 `queued`、`running`。
- HITL 暂停的长期恢复点在 session metadata，不要只看 active run key。

这和画布 workflow run 不一样。画布 run 绑定 `flow_task_id`；Agent run 绑定 `session_id + run_id + client_request_id`。

---

## 4. RedisRunStore 是 SSE 恢复窗口

Agent run 的运行时事件放在 Redis Stream：

```text
agent run stream
  → XADD event/data
  → id = Redis Stream ID
  → last_event_id 写入 run meta
```

OpenCreator 对照：

[agent_redis_run_store.py](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)

关键参数：

```text
RUN_TTL_SECONDS = 24h
RUN_STREAM_MAXLEN = 2000
```

这意味着 SSE 可以在短时间内断线续接，但 Redis Stream 不是永久聊天历史。永久事实要落到 Mongo session 存储里。

---

## 5. SSE id 就是恢复 cursor

前端订阅：

```text
GET /v1/agent/runs/{run_id}/events
Accept: text/event-stream
Last-Event-ID: <上次收到的 SSE id>
```

服务端读取：

```text
RedisRunStore.read_events(run_id, last_event_id=cursor, block_ms=15000)
```

每条 SSE：

```text
id: 1710000000000-0
event: chat.message.delta
data: {...}
```

没有事件时发送 heartbeat comment：

```text
: heartbeat
```

heartbeat 只用来保活连接，不是 Agent 状态事件，前端不能拿它更新聊天 UI。

---

## 6. 恢复窗口过期要回到历史同步

如果 `Last-Event-ID` 早于 Redis Stream 最早事件，后端抛：

```text
ResumeWindowExpiredError
```

HTTP 层返回：

```text
410 RESUME_WINDOW_EXPIRED
```

SSE 过程中发现过期，也会发 `agent.failed`，错误内容带 `RESUME_WINDOW_EXPIRED`。

前端不能拿同一个 cursor 无限重连。正确做法是重新拉 session messages 和必要的 workflow 状态，让 Mongo 里的 chat projection 恢复 UI。

---

## 7. AgentLoop 有两层并发保护

AgentLoop 内部还有：

```text
session lock
  + CREATO_MAX_CONCURRENT_REQUESTS 全局并发门
```

OpenCreator 对照：

[loop.py](../../../../../opencreate/opencreator-agent/creato/core/loop.py)

session lock 防止同一 session 的上下文和 metadata 被两个 loop 同时改。全局并发门控制整个 worker 上同时处理的 Agent 请求数量。

这两层和 `POST /v1/agent/runs` 的 Redis active run 互斥不冲突：入口防重复 run，loop 内防并发写 session。

---

## 8. SessionManager 分层保存事实

OpenCreator 的 Agent session 不是一张聊天表。

核心分层：

| 层 | 集合 / 缓存 | 作用 |
| --- | --- | --- |
| Session metadata | `agent_sessions` | session 列表、状态、HITL、pipeline state |
| Raw messages | `agent_messages` | LLM 上下文、用户消息、assistant、tool、workflow_event |
| Chat projection | `agent_chat_messages` | 前端聊天面板直接渲染 |
| Tool trace | `agent_tool_traces` | 工具输入、输出、耗时和错误 |
| Redis cache | `agent:session:*` | 24h 会话元信息和上下文缓存 |

OpenCreator 对照：

- [manager.py](../../../../../opencreate/opencreator-agent/creato/session/manager.py)
- [session.py](../../../../../opencreate/opencreator-agent/creato/schemas/session.py)

SSE 事件能断线续接，但用户刷新后的历史 UI 最终要靠 Mongo 的 chat projection 重建。

---

## 9. 运行循环不是只调一次 LLM

AgentLoop 的一轮输入会进入循环：

```text
加载 session
  → 处理 HITL resume
  → 收集历史文件、memory、pipeline 约束
  → microcompact 历史
  → 上下文裁剪 / 压缩
  → 构造 prompt
  → 持久化当前用户消息
  → LLM
  → 文本 delta 或 tool_calls
  → 执行 tool
  → tool result 回填
  → 下一轮
```

直到：

- 正常完成。
- 失败。
- 用户取消。
- 工具触发 HITL。
- 达到迭代上限。

基础 `AgentLoop` 默认 `max_iterations=40`。main profile 可以覆盖自己的配置，不能把某个 profile 的上限写死成所有 Agent 的固定上限。

---

## 10. HITL 是 session metadata 恢复，不是 SSE 卡片本身

工具触发 HITL 时，AgentLoop 会把 pending tool call 写入：

```text
session.metadata["pending_hitl"]
```

下一条用户输入进入同一个 session 后，会被转换成这个 tool call 的结果：

```text
pending_hitl
  → replace_last_tool_result()
  → session.messages append hitl.resolved tool_event
  → 清掉 pending_hitl
  → 继续 AgentLoop
```

前端看到的是 `tool.event` 里的 `hitl.request` 和 chat projection 中的 `hitl` part。真正恢复点在 session metadata。

---

## 11. 事件族以新协议为主，兼容旧名

后端事件定义在：

[events.py](../../../../../opencreate/opencreator-agent/creato/core/events.py)

主事件族：

- `agent.started`
- `agent.completed`
- `agent.failed`
- `agent.stopped`
- `chat.message.created`
- `chat.message.delta`
- `chat.part.upsert`
- `chat.message.completed`
- `session.state.updated`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `tool.event`
- `workflow.*`

前端仍兼容一些旧事件：

- `message.delta`
- `thinking.delta`
- `step.started`
- `step.completed`
- `llm.response.completed`

写 NovelComic 时可以兼容旧名，但新链路要以 `agent.*`、`chat.*`、`run.*` 为主。

---

## 12. Agent SSE 和画布 WebSocket 的边界

Agent 工具可以启动或观察 Publisher workflow，但 Agent SSE 不是画布 workflow 的完整可恢复事件总线。

| 链路 | 传输 | 恢复字段 | 事实源 |
| --- | --- | --- | --- |
| Agent 聊天 | SSE | `Last-Event-ID` | Agent Redis Stream + Mongo session |
| 画布 workflow run | WebSocket | `attach_flow(last_event_cursor)` | Publisher Workflow Event Store |

Agent SSE 可以把 `workflow.node_status` 转成聊天卡片、同步部分画布状态；但画布运行主链仍走可恢复 WebSocket。

---

## 写之前先有的东西

前端：

- `AGENT_BASE_URL` 可用。
- 能通过 `getToken({ template: "__opencreator_jwt" })` 拿 token。
- `useAgentRunController` 已能生成 `session_id`、`client_request_id` 和 optimistic message。
- `runAgentChatStream` 能创建 run 并订阅 SSE。
- 聊天 UI 能渲染 text、tool、HITL、workflow node result、generation confirm 等 part。

后端：

- Agent API 能验 JWT。
- Redis 可用于 run meta、request 幂等、active run、Stream 和取消标记。
- Mongo 有 `agent_sessions`、`agent_messages`、`agent_chat_messages`、`agent_tool_traces`。
- AgentLoop、SessionManager、AgentFactory 和 main profile 已接好。

这组做完，Agent 聊天能在断线后用 SSE id 续接；窗口过期时能回退到 Mongo 历史同步，而不是丢失整轮对话。只看到文本流式输出，不算这组完成。
