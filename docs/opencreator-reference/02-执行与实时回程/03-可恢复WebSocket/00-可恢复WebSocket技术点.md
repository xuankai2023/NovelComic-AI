# 可恢复 WebSocket：这里面有哪些技术点

这组只讲点击 Run 之后的事件连接。打开画布、读取项目、创建 workflow run 已经在前面几组解决；这里从前端拿到 `flow_task_id` 开始，到断线重连、cursor 回放、事件去重和节点状态继续更新为止。

先背一句话：

```text
WebSocket 不创建 run；
WebSocket 不提交整张图；
WebSocket 只订阅某个 flow_task_id 的运行事件。
```

最短链路：

```text
POST /api/v2/flow/runs
  → 返回 flow_task_id
  → 生成本次物理连接 connection_id
  → WS /api/v2/flow/runs/{flow_task_id}/events/{connection_id}
  → 首帧 auth，校验 Clerk JWT
  → 第二帧 attach_flow(last_event_cursor)
  → Publisher 从 Event Store replay 漏掉的事件
  → resume_ready
  → live events
  → 前端 handler 成功处理后推进 cursor
```

所以 `onopen` 只表示网络握手完成，不表示事件已经恢复。前端只有收到 `resume_ready`，才能认为这条运行事件流真正可用。

---

## 1. 连接绑定 run，不绑定页面

OpenCreator 的 v2 连接地址是：

```text
{NEXT_PUBLIC_WEBSOCKET_URL}/api/v2/flow/runs/{flow_task_id}/events/{connection_id}
```

相关文件：

- [workflow-resumable-websocket.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)
- [flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)

`flow_task_id` 是一次逻辑执行实例。它来自 `POST /api/v2/flow/runs`，不是来自 `/canvas/{flowId}`。

`connection_id` 是一次物理连接身份。断线重连时可以重新生成。服务端用它配合 generation 防止旧连接继续推事件。

---

## 2. token 放在第一帧，不放 URL

浏览器原生 `WebSocket` 构造器不能像 `fetch` 一样自由加 `Authorization` header。OpenCreator 没有把 JWT 放进 query，而是让服务端先接受连接，再要求第一条消息必须是认证帧：

```json
{
  "event_type": "auth",
  "protocol_version": 2,
  "token": "<Clerk JWT>"
}
```

服务端流程：

```text
accept()
  → 15 秒内等 auth
  → JwtService 校验 token
  → 得到 user_id
  → get_run_summary(user_id, flow_task_id)
  → 确认 run 属于当前用户
```

JWT 合法但 run 不属于当前用户，也不能订阅事件。

---

## 3. attach_flow 才决定恢复位置

认证通过后，前端发送第二帧：

```json
{
  "event_type": "attach_flow",
  "protocol_version": 2,
  "flow_task_id": "...",
  "connection_id": "...",
  "last_event_cursor": "1710000000000-0"
}
```

服务端校验：

- 第二帧必须是 `attach_flow`。
- body 里的 `flow_task_id` 和 `connection_id` 如果出现，必须和 URL 一致。
- `last_event_cursor` 必须是合法 Redis Stream ID。
- 空 cursor 按 `0-0` 处理。

`attach_flow` 的含义是：从这个 cursor 后面补事件，然后进入实时订阅。

---

## 4. Event Store 是事实源

Publisher 的事件事实源是 Redis Stream Event Store。Consumer 回程事件先经过 RabbitMQ 到 Publisher，Publisher 写入 Event Store 后再 ACK。

事件写入顺序在 `WorkflowEventStore.append_event()`：

```text
append_event()
  → ensure_event_identity()
  → XADD event
  → 记录 event_id 到 cursor 的映射
  → 设置 TTL
  → PUBLISH 通知连接有新事件
```

恢复读取走 `WorkflowEventStore.replay()`，live 追赶走 `WorkflowEventStore.read_live()`。Pub/Sub 只是低延迟通知，不是可靠事件仓。即使通知丢失，WebSocket 事件循环也会继续从 Stream 追赶。

---

## 5. cursor 是恢复边界

Redis Stream ID 类似：

```text
1710000000000-0
```

前端把最近成功处理的 cursor 写入：

```text
sessionStorage["workflow:v2:cursor:{flowTaskId}"]
```

关键规则：

```text
handler 成功
  → 才推进 cursor

handler 抛错
  → 关闭连接
  → 不标记这一帧已处理
```

如果 handler 失败但 cursor 已经越过该事件，下次重连就不会再 replay 这一帧，画布状态会永久缺一段。

---

## 6. event_id 和 cursor 不是一回事

`event_cursor` 解决“从哪里继续读”。

`event_id` 解决“同一个事件有没有重复处理”。

OpenCreator 有两层去重：

- Publisher Event Store 维护 `event_id → event_cursor`，重复 append 同一 `event_id` 时返回原 cursor。
- 前端 transport 维护一个有限大小的已见 `event_id` 集合，避免同一连接内 replay 和 live 重复触发 handler。

Toast、埋点、提示这类副作用还要走独立的 side-effect claim。不要把 cursor 当成所有副作用的全局去重器。

---

## 7. resume_ready 才算连接成功

浏览器 `onopen` 后仍可能失败在：

- 获取 Clerk token。
- JWT 验证。
- run 归属验证。
- attach body 校验。
- cursor 已经过期。
- replay 中途断线。

因此前端连接状态只能在收到下面事件后改成 `connected`：

```json
{
  "event_type": "resume_ready",
  "event_cursor": "...",
  "latest_event_cursor": "...",
  "status": "running"
}
```

这时才能清零重连计数，并开始把后续 live events 交给业务 handler。

---

## 8. 心跳只证明连接还活着

前端心跳策略大致是：

```text
每 30 秒 ping
  → 10 秒内没有任何返回帧
  → close(4000, "heartbeat_timeout")
  → 进入重连
```

页面 hidden 时会暂缓主动 ping，避免浏览器后台定时器节流造成误判。

重连退避：

```text
1s → 2s → 4s → 8s → 15s → 30s
```

再乘 0.8-1.2 的随机抖动。浏览器离线时等 `online`，页面重新可见时也会尝试恢复。

---

## 9. generation 防止旧连接乱入

服务端为 `(flow_task_id, connection_id)` 维护 generation。

如果同一个逻辑 connection 被新的物理 socket 占用：

```text
generation + 1
  → 新连接成为当前连接
  → 旧连接关闭
  → 旧连接不能继续推事件
```

这能避免网络抖动后两条 socket 同时向同一个前端运行态发事件。

---

## 10. cursor 过期是协议错误，不是普通断线

如果前端带来的 cursor 已经超出保留窗口，并且服务端也不能提供 snapshot 恢复，服务端会返回恢复失败或关闭连接。

这时不能无限重连同一个 cursor。前端要把它当成需要重置运行视图、重新查询 run 状态或提示用户刷新的场景。

常见关闭码：

| code | 含义 |
| --- | --- |
| `4401` | 缺少 auth 首帧或 JWT 验证失败 |
| `4404` | run 不存在，或者不属于当前用户 |
| `4400` | attach、cursor 或协议字段无效 |
| `4409` | cursor 超出保留窗口，且无法 snapshot 恢复 |
| `4001` | 同一个 connection ID 已被更新连接替换 |
| `1011` | 服务端内部错误 |

前端主动关闭的典型原因：

| code | 含义 |
| --- | --- |
| `4000` | 心跳超时 |
| `4001` | 消息 JSON 解析失败 |
| `4002` | 业务 handler 抛错 |
| `4003` | 获取鉴权 token 失败 |
| `4004` | 连接超时 |
| `4005` | 重置 cursor 后换一条物理连接 |
| `4007` | 连接后 30 秒内没有收到 `resume_ready` |

---

## 11. v1 和 v2 不要混用

旧 v1 路径：

```text
/api/v1/flow/flow_task/{ws_id}
```

它把命令和结果绑在普通 WebSocket 上，依赖实例内连接表，没有 v2 cursor 恢复语义。

当前主链是：

```text
REST 命令
  + Redis Stream 命令队列
  + RabbitMQ 结果回程
  + Publisher Redis Event Store
  + v2 可恢复 WebSocket
```

写 NovelComic 时不要因为 v1 文件仍存在，就把 run 创建、事件恢复和节点状态全部塞回一条普通 socket。

---

## 动手前要有的东西

前端：

- `POST /api/v2/flow/runs` 能返回 `flow_task_id`。
- `useWorkflowRunner` 能保存当前 active run。
- `getToken({ template: "__opencreator_jwt" })` 可用。
- `workflow-command-journal.ts` 已经能稳定命令身份。
- 节点状态 handler 已经能把事件写回画布 store。
- `workflow-reconnect-policy.ts` 已经定义重连上限和退避策略。

后端：

- `flow_runs.py` 已经有 run 创建、查询、取消、继续接口。
- `WorkflowRunV2Service.get_run_summary()` 能按 `user_id + flow_task_id` 查归属。
- `workflow_event_store.py` 能 append、replay、去重。
- RabbitMQ v2 reply 消费已经能把 Consumer 事件写入 Event Store。
- Redis 可用于 Stream、Pub/Sub、connection generation 和 TTL。

这组做完，刷新页面或网络抖动后，前端能用 cursor 补回断线期间的事件，而不是重新跑一遍工作流。
