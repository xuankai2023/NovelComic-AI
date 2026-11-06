# OpenCreator 的可恢复 WebSocket

## 结论

OpenCreator 当前画布运行主链使用 v2 WebSocket：

```text
REST 创建 run
  → WebSocket 只传运行事件
  → 首帧 auth
  → 第二帧 attach_flow(cursor)
  → replay
  → resume_ready
  → 实时事件
```

WebSocket 不负责提交整张流程图，也不负责创建 run。

## 一、连接地址

前端连接：

```text
{VITE_WEBSOCKET_URL}/api/v2/flow/runs/{flowTaskId}/events/{connectionId}
```

- `flowTaskId`：逻辑执行实例。
- `connectionId`：本次物理连接 ID，重连时重新生成。

关键文件：

- [`workflow-resumable-websocket.ts`](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)
- [`flow_runs.py`](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)

## 二、为什么 token 放在第一帧

浏览器原生 `WebSocket` 构造器不能像普通 `fetch` 一样自由添加
`Authorization` 请求头。

OpenCreator 没有把 JWT 放进 URL query，而是：

1. HTTP 鉴权中间件看到 websocket scope 时放行；
2. endpoint 先 `accept()`；
3. 15 秒内要求第一条 JSON 消息是 `auth`；
4. endpoint 自己调用 `JwtService` 验证 token。

第一帧：

```json
{
  "event_type": "auth",
  "protocol_version": 2,
  "token": "<Clerk JWT>"
}
```

服务端验证：

```text
JWT 签名和 sub
  → user_id
  → get_run_summary(user_id, flow_task_id)
  → 确认这个 run 属于当前用户
```

成功后返回：

```json
{
  "event_type": "authenticated",
  "flow_task_id": "...",
  "connection_id": "...",
  "trace_id": "..."
}
```

JWT 合法但 run 不属于这个用户，也不能订阅其事件。

## 三、第二帧 attach_flow

认证成功后，客户端发送：

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

- 第二帧必须是 `attach_flow`；
- body 可以省略 `flow_task_id` 和 `connection_id`；如果提供，其值必须与 URL 一致；
- cursor 必须是合法 Redis Stream ID。

空 cursor 按 `0-0` 处理。

## 四、为什么 onopen 不等于已恢复

浏览器 `onopen` 只说明 TCP / WebSocket 握手完成。

之后仍可能失败在：

- 获取 Clerk token；
- JWT 验证；
- run 归属验证；
- cursor 校验；
- cursor 已经过期；
- replay 中途断线。

所以前端只有收到：

```json
{
  "event_type": "resume_ready",
  "event_cursor": "...",
  "latest_event_cursor": "...",
  "status": "running"
}
```

才把连接状态改成 `connected`，并把重连计数清零。

## 五、replay 和 cursor

Publisher 把每个 run 的事件写入 Redis Stream Event Store。

事件被写入后得到类似：

```text
1710000000000-0
```

的 Stream ID，作为 `event_cursor`。

前端把最近成功处理的 cursor 写入：

```text
sessionStorage["workflow:v2:cursor:{flowTaskId}"]
```

重连时把 cursor 放进 `attach_flow`。Publisher 从该位置之后 replay 漏掉的事件，再发送 `resume_ready`。

关键原则：

```text
handler 成功
  → 才推进 cursor

handler 抛错
  → 关闭连接
  → 不把这一帧标成已处理
```

否则 UI 处理失败但 cursor 已越过该事件，下一次重连也补不回来。

## 六、事件去重

事件有稳定 `event_id`。

Publisher Event Store 维护：

```text
event_id → event_cursor
```

重复写入同一个 `event_id` 时返回原 cursor，不再追加第二份事件。

前端 transport 还维护一个最多 500 个 `event_id` 的内存集合，避免同一物理会话中的 replay 重复触发 handler。

此外，Toast、埋点等副作用使用独立的 side-effect claim。它和 cursor 不是同一个去重器。

## 七、心跳和重连

前端策略：

```text
每 30 秒发送 ping
  → 10 秒内没有任何返回帧
  → close(4000, "heartbeat_timeout")
  → 进入重连
```

页面处于 hidden 时暂缓主动 ping，避免浏览器后台定时器节流造成误判。

重连退避大致为：

```text
1s → 2s → 4s → 8s → 15s → 30s
```

再乘 0.8–1.2 的随机抖动，最多尝试 10 次。

浏览器离线时等待 `online` 事件；页面重新可见时也会尝试恢复。

重连成功的判断仍是 `resume_ready`，不是新的 socket `onopen`。

## 八、同 connectionId 的代际

Publisher 为 `(flow_task_id, connection_id)` 维护 generation。

如果同一个逻辑 connection ID 被新的物理 socket 占用：

```text
generation + 1
  → 新连接成为当前连接
  → 旧连接关闭
  → 旧连接不能继续推事件
```

这避免网络抖动后两条 socket 同时向同一个前端逻辑连接发送消息。

## 九、关闭码

服务端常见关闭码：

- `4401`：缺少 auth 首帧或 JWT 验证失败。
- `4404`：run 不存在，或者不属于当前用户。
- `4400`：attach / cursor 等协议无效。
- `4409`：cursor 已超出保留窗口，且无法取得 snapshot。
- `4001`：同一个 connection ID 已被更新连接替换。
- `1011`：服务端内部错误。

前端主动关闭的典型原因：

- `4000`：心跳超时。
- `4001`：消息 JSON 解析失败。
- `4002`：业务 handler 抛错。
- `4003`：获取鉴权 token 失败。
- `4004`：连接超时。
- `4005`：重置 cursor 后换一条物理连接。
- `4007`：连接后 30 秒内没有收到 `resume_ready`。

## 十、Event Store 与实时通知

Publisher 的真相源是 Redis Stream，不是进程内连接表，也不是 Pub/Sub。

写事件时大致执行：

```text
XADD event
  → 记录 event_id 与 cursor
  → 设置 TTL
  → PUBLISH “这个 flow 有新事件”
```

Pub/Sub 只负责低延迟叫醒 `_event_loop`。即使通知丢失，事件循环也会周期性从 Stream 追赶，所以不会把 Pub/Sub 当成可靠事件仓。

## 十一、v1 与 v2 不要混用

旧 v1 路径：

```text
/api/v1/flow/flow_task/{ws_id}
```

它把命令和结果绑在普通 WebSocket 上，依赖实例内连接表，没有 v2 cursor 恢复语义。

当前画布运行主链是：

```text
REST 命令
  + Redis Stream 命令队列
  + RabbitMQ 结果回程
  + Publisher Redis Event Store
  + v2 可恢复 WebSocket
```

阅读代码时看到 v1 文件仍存在，不表示当前画布 Run 仍走 v1。
