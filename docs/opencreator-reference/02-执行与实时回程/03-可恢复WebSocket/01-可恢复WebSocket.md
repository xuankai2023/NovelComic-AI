# OpenCreator 是怎么做可恢复 WebSocket 的

这篇按运行时视角讲一遍“谁调用谁”。如果要看机制拆解，读 [00-可恢复WebSocket技术点.md](./00-可恢复WebSocket技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一句话结论

OpenCreator 的可恢复 WebSocket 是 workflow run 的事件读口。前端先用 REST 创建 run，拿到 `flow_task_id`；再连接 WebSocket，首帧认证，第二帧 attach；Publisher 从 Event Store 按 cursor 回放旧事件，再继续推实时事件。

```text
runAll()
  → POST /api/v2/flow/runs
  → 得到 flow_task_id
  → workflow-resumable-websocket 建连
  → auth
  → authenticated
  → attach_flow(last_event_cursor)
  → replay
  → resume_ready
  → live events
  → handler 更新画布节点
```

必须分清四个状态：

- `onopen`：浏览器和服务端握手成功。
- `authenticated`：JWT 已通过，并确认 run 属于当前用户。
- `resume_ready`：cursor 后的事件已经 replay 完，可以接 live events。
- `connected`：前端运行态认可这条连接可用。

`onopen` 不等于连接已恢复。真正的成功点是 `resume_ready`。

---

## 1. 前端：run 创建后才建连

运行入口在 [useWorkflowRunner.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts)。

用户点击 Run 后，前端先走 REST：

```text
runAll()
  → command journal 生成 command_id
  → postCreateWorkflowRun()
  → POST /api/v2/flow/runs
  → 返回 flow_task_id / flow_run_id / trace_id
```

只有拿到 `flow_task_id` 后，才进入事件连接：

```text
startWebSocketForFlow(flow_task_id)
```

WebSocket 不负责创建 run，也不负责把 nodes / edges 提交给后端。它只负责读取这个 run 的事件。

---

## 2. useWebSocketFlow 管生命周期和分发

前端连接管理在 [useWebSocketFlow.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWebSocketFlow.ts)。

它负责：

- 启动某个 `flow_task_id` 的事件连接。
- 注册各类事件 handler。
- 处理 `resume_ready`、`resume_error`、`flow_snapshot`、`flow_killed`。
- 把节点事件转给 `useWorkflowRunner` 和节点状态管理逻辑。
- 刷新恢复时带上上次 cursor 重新 attach。

这层不直接实现底层 socket 协议。底层协议在 [workflow-resumable-websocket.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)。

---

## 3. workflow-resumable-websocket 实现协议

连接地址：

```text
{NEXT_PUBLIC_WEBSOCKET_URL}/api/v2/flow/runs/{flowTaskId}/events/{connectionId}
```

物理连接打开后，前端第一步取 JWT：

```text
getToken({ template: "__opencreator_jwt" })
```

然后发送 auth：

```json
{
  "event_type": "auth",
  "protocol_version": 2,
  "token": "<__opencreator_jwt>"
}
```

收到 `authenticated` 后，再发送 attach：

```json
{
  "event_type": "attach_flow",
  "protocol_version": 2,
  "flow_task_id": "...",
  "connection_id": "...",
  "last_event_cursor": "..."
}
```

如果本地没有 cursor，就传 `null` 或等价空值，让服务端从头恢复。

---

## 4. Publisher：WebSocket 入口仍在 flow_runs.py

后端 WebSocket 入口在 [flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)。

它和 run 的 REST 接口放在同一个 controller 下：

```text
POST /api/v2/flow/runs
POST /api/v2/flow/runs/{flow_task_id}/continue
POST /api/v2/flow/runs/{flow_task_id}/cancel
GET  /api/v2/flow/runs
GET  /api/v2/flow/runs/{flow_task_id}
WS   /api/v2/flow/runs/{flow_task_id}/events/{connection_id}
```

WebSocket endpoint 的核心顺序：

```text
accept()
  → 等 auth
  → JwtService 校验 token
  → get_run_summary(user_id, flow_task_id)
  → 发送 authenticated
  → 等 attach_flow
  → 校验 cursor
  → replay
  → 发送 resume_ready
  → 进入 event loop
```

JWT 合法不代表一定能订阅。服务端还要确认这个 run 属于当前用户。

---

## 5. Event Store 负责 replay 和 live 追赶

事件存储在 [workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)。

Consumer 的执行事件不是直接推给浏览器，而是先进入 Publisher：

```text
Consumer outbox
  → RabbitMQ v2 reply queue
  → Publisher database/mq.py
  → WorkflowEventStore.append_event()
  → ACK RabbitMQ
```

Event Store 写入 Redis Stream 后，生成 `event_cursor`：

```text
1710000000000-0
```

WebSocket attach 时，服务端按 `last_event_cursor` 读取后面的事件：

```text
WorkflowEventStore.replay(flow_task_id, last_event_cursor)
  → 逐条发送给前端
  → replay 完成后发送 resume_ready
```

连接进入 live 阶段后，后端继续用 `WorkflowEventStore.read_live()` 从最新 cursor 往后追事件。Pub/Sub 只负责唤醒等待中的连接，真正的事件正文仍从 Redis Stream 读。

浏览器断线时，Consumer 和 Publisher 仍继续处理事件。浏览器回来后用 cursor 补读。

---

## 6. 前端 handler 成功后才推进 cursor

前端收到事件后，不应该先保存 cursor 再跑业务 handler。

正确顺序：

```text
收到 event
  → 检查 event_id 是否已处理
  → 调业务 handler
  → handler 成功
  → 保存 event_cursor
```

保存位置：

```text
sessionStorage["workflow:v2:cursor:{flowTaskId}"]
```

如果 handler 抛错，连接会关闭，cursor 不推进。下次重连还能 replay 这一帧。

---

## 7. 前端 handler 才真正改变画布

WebSocket transport 不直接知道节点怎么变色。它只把事件交给上层。

[useWebSocketFlow.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWebSocketFlow.ts) 会分发这些事件：

- `start_flow`
- `node_status`，再按 `ready` / `running` / `success` / `select` / `pause` / `failed` 分支处理
- `llm_model_ready`
- `llm_model_status`
- `finish_flow`
- `flow_killed`
- `workflow_error`

[useWorkflowRunner.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts) 和节点状态管理逻辑把事件写回画布：

```text
node_status=running
  → 节点进入 running

node_status=success
  → 写结果
  → 节点点亮

node_status=failed
  → 节点失败
  → 写错误态

node_status=select
  → 显示候选
  → 等用户 continue

finish_flow
  → run 结束
```

所以可恢复 WebSocket 的目标不是“连接保持不断”，而是“断了也能恢复到同一批事件处理结果”。

---

## 8. 心跳和重连保护 live 阶段

连接进入 live 阶段后，前端会定期 ping：

```text
每 30 秒 ping
  → 10 秒内没收到任何帧
  → close(4000, "heartbeat_timeout")
  → reconnect
```

重连时复用同一个 `flow_task_id`，重新生成或沿用连接身份，并带上本地保存的 `last_event_cursor`。

重连成功仍以 `resume_ready` 为准。

```text
reconnect
  → open
  → auth
  → attach_flow(last_event_cursor)
  → replay missing events
  → resume_ready
```

如果浏览器离线，前端等待 `online`。如果页面隐藏，主动心跳会收敛，避免后台定时器导致误判。

---

## 9. 服务端 event loop 只做投递，不重新判 DAG

WebSocket 服务端循环不重新计算 DAG，也不决定节点是否 ready。

它只做：

```text
从 Event Store 读取事件
  → 发送给当前连接
  → 等 Pub/Sub 通知或周期性追赶
  → 连接关闭时退出
```

DAG 的执行事实在 Consumer，事件事实在 Event Store。WebSocket 只是事件事实的一个可恢复读口。

---

## 10. 刷新恢复靠 active run 和 cursor

页面刷新后，物理 socket 已经断开，但 run 可能还在继续。

前端重新打开画布后：

```text
GET /api/v2/flow/runs?flow_id=...&status=active
  → 找到 active flow_task_id
  → 读取 sessionStorage cursor
  → 重新建立 WebSocket
  → attach_flow(last_event_cursor)
```

这就是为什么“关闭 WebSocket”不等于“停止任务”。停止任务要走：

```text
POST /api/v2/flow/runs/{flow_task_id}/cancel
```

---

## 11. 和 NovelComic 对照

NovelComic 接这块时，不要先写一个能 `onopen` 的 socket 就算完成。

顺序应该是：

1. 先保证 `POST /api/v2/flow/runs` 能返回 `flow_task_id`。
2. 再让前端能用 `flow_task_id` 建 v2 WebSocket。
3. 再实现 auth 首帧和 run 归属校验。
4. 再实现 `attach_flow(last_event_cursor)`。
5. 再实现 Event Store replay 和 `resume_ready`。
6. 再把事件分发到画布节点 handler。
7. 最后补心跳、重连、generation、关闭码和 cursor 过期处理。

如果只是连接成功但没有 Event Store 和 cursor，刷新后仍然会丢事件；如果只有 cursor 但 handler 失败也推进，画布会出现不可恢复的状态洞。
