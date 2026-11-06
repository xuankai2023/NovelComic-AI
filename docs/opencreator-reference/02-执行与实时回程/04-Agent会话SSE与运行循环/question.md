# Agent 会话、SSE 与运行循环 question

## 核心概念

- 这一组讲的是什么？
  - 只讲 Agent 聊天运行链路。
  - 它不是画布 workflow run。
  - 它也不是“一个 POST 请求直接流式返回完整对话”。

- 为什么要先背三句话？
  - Session 负责多轮会话事实。
  - Agent run 负责一次用户输入。
  - SSE 负责把这个 run 的事件按 Redis Stream cursor 续接给前端。

- 现网为什么拆成两步？
  - 先 `POST /v1/agent/runs` 创建可幂等的 run。
  - 再 `GET /v1/agent/runs/{run_id}/events` 订阅这个 run 的 SSE。
  - 后端在后台 task 里跑 AgentLoop，事件写入 Redis Stream。

- 为什么四个状态不能压成一个 `isRunning`？
  - 有 `session_id`：属于某个多轮会话。
  - 有 `client_request_id`：这次用户输入有幂等身份。
  - 有 `run_id`：后端已经接受这次输入并创建 task-backed run。
  - 有 SSE `id`：前端知道事件续接位置。
  - UI 可以只显示“正在生成”，代码里必须保留这四层身份。

## Session 与 Run

- Agent run 是一次输入还是整个 session？
  - 是一次用户输入的执行实例。
  - 同一个 session 可以有多轮 run。
  - 同一时间只能有一个 active task-backed run。

- 常见 run 状态有哪些？
  - `queued` / `running` / `waiting_hitl` / `completed` / `failed` / `cancelled`。
  - task-backed active run 主要按 `queued` 和 `running` 管理。
  - 工具触发的 HITL 长期恢复点在 session metadata，不要只靠 run status 判断。

- 新的用户输入撞上已有 active run 怎么办？
  - 返回 `409 ACTIVE_RUN_EXISTS`。
  - 或者让前端订阅已有 `active_run_id`。
  - 不要再开一个 AgentLoop。

- session 分层存什么？
  - `agent_sessions`：session 列表、状态、HITL、pipeline state。
  - `agent_messages`：LLM 上下文、用户消息、assistant、tool、workflow_event。
  - `agent_chat_messages`：前端聊天面板直接渲染。
  - `agent_tool_traces`：工具输入、输出、耗时和错误。
  - Redis `agent:session:*`：24h 会话元信息和上下文缓存。

- 为什么刷新后的历史 UI 不能只靠 Redis Stream？
  - Redis Stream 只是短期恢复窗口。
  - 永久事实要落到 Mongo 的 chat projection。
  - 历史接口读的是 `GET /v1/agent/sessions/{session_id}/messages`。

## 幂等与互斥

- `client_request_id` 解决什么？
  - 前端创建 run 超时后重试。
  - 同一条用户输入被重复提交。
  - 用户取消发生在 run 创建前后不同时间点。

- 后端用什么键做入口幂等？
  - `request_key(user_id, session_id, client_request_id)`。
  - 同一个 `client_request_id` 重试时，返回已有 run，而不是再开一个 AgentLoop。

- 为什么还要 session active run 互斥？
  - Agent 会话不是并发聊天。
  - 创建 run 时先拿 session run lock，再检查 active run。
  - 同一个 session 不能同时有两个 task-backed run。

- 取消为什么还要 `cancel-by-request`？
  - 已知 `run_id` 时走 `POST /v1/agent/runs/{run_id}/cancel`。
  - 只知道 `client_request_id` 时走 `POST /v1/agent/runs/cancel-by-request`。
  - 这样即使 run 还没创建完成，也能先登记取消意图。

## SSE 恢复

- SSE 怎么续接？
  - `GET /v1/agent/runs/{run_id}/events`。
  - `Accept: text/event-stream`。
  - `Last-Event-ID` 带上次收到的 SSE id。

- SSE id 是什么？
  - 就是 Redis Stream ID。
  - 每条 SSE 形如 `id` + `event` + `data`。
  - Agent SSE 的恢复边界是 `Last-Event-ID`，不是画布 WebSocket 的 `attach_flow`。

- heartbeat 是不是状态事件？
  - 不是。
  - 没有事件时发送 `: heartbeat` 只用来保活。
  - 前端不能拿它更新聊天 UI。

- 恢复窗口过期怎么办？
  - `Last-Event-ID` 早于 Redis Stream 最早事件时，抛 `ResumeWindowExpiredError`。
  - HTTP 层返回 `410 RESUME_WINDOW_EXPIRED`。
  - 前端不能拿同一个 cursor 无限重连。
  - 正确做法是重新拉 session messages 和必要的 workflow 状态。

- RedisRunStore 的窗口有多大？
  - `RUN_TTL_SECONDS = 24h`。
  - `RUN_STREAM_MAXLEN = 2000`。
  - SSE 可以短时间断线续接，但不是永久聊天历史。

## AgentLoop

- 运行循环是只调一次 LLM 吗？
  - 不是。
  - 它会加载 session、处理 HITL resume、收集文件和 memory、裁剪上下文、调 LLM、执行 tool、回填 tool result，再进入下一轮。

- 循环什么时候停？
  - 正常完成。
  - 失败。
  - 用户取消。
  - 工具触发 HITL。
  - 达到迭代上限。

- 为什么不能把 60 写成所有 Agent 的固定上限？
  - 基础 `AgentLoop` 默认 `max_iterations=40`。
  - main profile 可以覆盖自己的配置。
  - 不同 profile 上限不同。

- AgentLoop 有哪两层并发保护？
  - session lock：防止同一 session 的上下文和 metadata 被两个 loop 同时改。
  - `CREATO_MAX_CONCURRENT_REQUESTS`：控制整个 worker 同时处理的 Agent 请求数量。
  - 这两层和入口的 Redis active run 互斥不冲突。

- 为什么要提前持久化当前用户消息？
  - 避免 SSE 中断或后端异常导致整轮用户输入丢失。
  - 用户消息属于长期事实，不能只活在这次 SSE 里。

## Agent HITL

- Agent HITL 的恢复点在哪？
  - 工具触发 HITL 时，pending tool call 写入 `session.metadata["pending_hitl"]`。
  - 下一条用户输入会被转换成这个 tool call 的结果。
  - 真正恢复点在 session metadata，不是 SSE 卡片本身。

- HITL resume 怎么走？
  - `pending_hitl`。
  - `replace_last_tool_result()`。
  - session.messages append `hitl.resolved` tool_event。
  - 清掉 `pending_hitl`。
  - 继续 AgentLoop。

- 它和工作流 HITL 能共用吗？
  - 不能。
  - 工作流 HITL 是 node select，走 `POST /runs/{flow_task_id}/continue`。
  - Agent HITL 是工具 interrupt，走同一 session 的下一条用户输入。

## 事件与边界

- 主事件族有哪些？
  - `agent.started` / `agent.completed` / `agent.failed` / `agent.stopped`。
  - `chat.message.created` / `chat.message.delta` / `chat.part.upsert` / `chat.message.completed`。
  - `session.state.updated`。
  - `run.completed` / `run.failed` / `run.cancelled`。
  - `tool.started` / `tool.completed` / `tool.failed` / `tool.event`。
  - `workflow.*`。

- 为什么还兼容旧事件名？
  - 前端仍可能收到 `message.delta`、`thinking.delta`、`step.started` 等。
  - 写 NovelComic 时可以兼容旧名，但新链路要以 `agent.*`、`chat.*`、`run.*` 为主。
  - 不要把旧 `POST /v1/agent/chat` 复活成新的主入口，它现网返回 `410 USE_AGENT_RUNS`。

- Agent SSE 和画布 WebSocket 有什么边界？
  - Agent 聊天走 SSE，恢复字段是 `Last-Event-ID`，事实源是 Agent Redis Stream + Mongo session。
  - 画布 workflow run 走 WebSocket，恢复字段是 `attach_flow(last_event_cursor)`，事实源是 Publisher Workflow Event Store。
  - Agent 工具可以启动或观察 Publisher workflow，但 Agent SSE 不是画布完整可恢复事件总线。

## 前端链路

- 用户发送一条消息后，前 3 步在做什么？
  - 准备 `session_id`。
  - 生成 `client_request_id` 和 optimistic message。
  - 整理 `workflow_snapshot`、附件和运行状态。
  - 第 4 步才创建 run，第 5 步才开始 SSE。

- `409 ACTIVE_RUN_EXISTS` 时前端怎么做？
  - 转为订阅已有 active run。
  - 通过 replay 补 UI。
  - 不再发新的用户输入。

- 刷新后怎么恢复？
  - `GET /v1/agent/sessions/{session_id}/active-run`。
  - 如果有 active `run_id`，用 existingRunId 订阅 SSE，并 hydrate messages from replay。
  - 如果没有 active run，同步历史消息和画布状态。

## NovelComic 迁移

- 为什么不要写成“一个 POST 直接返回 SSE 流”？
  - 现网模型必须拆成创建 run 和订阅 SSE。
  - 还要有 Redis Stream、Mongo session、active-run 和 cancel-by-request。
  - 只看到文本能流式输出，不算这组完成。

- 推荐最小闭环是什么？
  - `POST /v1/agent/runs` 可幂等。
  - `GET /v1/agent/runs/{run_id}/events` 可按 `Last-Event-ID` 续接。
  - Redis Stream 保存短期事件。
  - Mongo chat projection 保存长期聊天事实。
  - `active-run` 支持刷新恢复。
  - `cancel-by-request` 覆盖 run 尚未创建完成时的取消。

## 面试短答

- 一句话讲 Agent 会话、SSE 与运行循环？
  - 前端先创建可幂等的 Agent run，后台 AgentLoop 把事件写入 Redis Stream，前端再用 SSE 按 `Last-Event-ID` 续接；长期聊天事实在 Mongo session，不在这次 SSE 里。

- 一句话讲 session 和 run 的区别？
  - session 是多轮会话和 HITL 恢复点，run 是某一次用户输入的短期执行实例。

- 一句话讲为什么恢复窗口过期要回历史同步？
  - Redis Stream 有 TTL 和 maxlen，过期 cursor 已经读不到；UI 必须回退到 Mongo chat projection，而不是死循环重连。

- 一句话讲和画布 WebSocket 的差别？
  - Agent SSE 用 `Last-Event-ID` 续接一次聊天 run，画布 WebSocket 用 `attach_flow` 续接一次 workflow run，两套协议不能混用。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 前端 `AssistantProvider` 能消费首页 handoff，并调用画布 `runAll()`。
  - `novelcomic-agent` 只有包结构和配置骨架。
  - 还没有 `POST /v1/agent/runs`、SSE events、RedisRunStore、AgentLoop 和 session 分层存储。

- 当前实现能不能算本章主链路打通？
  - 不能。
  - 首页到画布的 handoff 不等于 Agent run + SSE。
  - 当前 handoff 走的是画布 workflow `runAll()`，不是 Agent 聊天主链。

- 当前测试覆盖了哪些本章风险？
  - 覆盖了首页 handoff 被画布 AssistantProvider 消费。
  - 还没有覆盖 `client_request_id` 幂等、active run 互斥、`Last-Event-ID` 续接和 `410 RESUME_WINDOW_EXPIRED`。

- 为什么说当前还不是 Agent 会话链路？
  - 没有 task-backed run。
  - 没有 SSE 事件流。
  - 没有 Mongo chat projection。
  - 没有 session lock 和 HITL metadata。
  - 不能把画布 Run 亮灯误认为 Agent 聊天已完成。

- 当前安全边界应该先准备什么？
  - Agent API 必须能验 `__opencreator_jwt`。
  - 读取 run / session / events 都要按当前用户过滤。
  - 不能让前端传 `user_id` 查询别人的会话。

- 如果只看到文本在流式输出，当前应该怎么理解？
  - 这最多说明 UI 能显示增量文本。
  - 还不能说明 run 幂等、断线续接、历史重建和取消语义已经成立。

- 什么时候才算本章完整验收？
  - 发送消息会创建 run，再订阅 SSE。
  - 同一 `client_request_id` 重试不会开第二个 loop。
  - 同一 session 不能并发两个 active run。
  - 断线后能按 SSE id 续接。
  - 窗口过期能回退到 Mongo 历史。
  - 刷新能找回 active run 或历史消息。
  - 取消能覆盖 run 尚未创建完成的情况。
