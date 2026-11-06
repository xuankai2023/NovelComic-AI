# 可恢复 WebSocket question

## 核心概念

- 这一组从哪里开始讲？
  - 从前端拿到 `flow_task_id` 开始。
  - 打开画布、读取项目、创建 workflow run 已经在前面几组解决。
  - 这里讲断线重连、cursor 回放、事件去重和节点状态继续更新。

- 为什么要先背三句话？
  - WebSocket 不创建 run。
  - WebSocket 不提交整张图。
  - WebSocket 只订阅某个 `flow_task_id` 的运行事件。

- 这条链最短怎么走？
  - `POST /api/v2/flow/runs` 返回 `flow_task_id`。
  - 生成本次物理连接 `connection_id`。
  - 连接 `WS /api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。
  - 首帧 auth，校验 Clerk JWT。
  - 第二帧 `attach_flow(last_event_cursor)`。
  - Publisher 从 Event Store replay 漏掉的事件。
  - 收到 `resume_ready` 后再接 live events。
  - 前端 handler 成功处理后推进 cursor。

- 为什么 `onopen` 不等于已经恢复？
  - `onopen` 只表示网络握手完成。
  - 之后还可能失败在取 token、验 JWT、run 归属、cursor 过期或 replay 中途断线。
  - 前端只有收到 `resume_ready`，才能认为这条运行事件流真正可用。

## 连接绑定

- 连接地址是什么？
  - `{NEXT_PUBLIC_WEBSOCKET_URL}/api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。

- `flow_task_id` 从哪里来？
  - 来自 `POST /api/v2/flow/runs`。
  - 不是来自 `/canvas/{flowId}`。
  - 它是一次逻辑执行实例。

- `connection_id` 是什么？
  - 一次物理连接身份。
  - 断线重连时可以重新生成。
  - 服务端用它配合 generation 防止旧连接继续推事件。

- 为什么打开画布不立刻连 WebSocket？
  - 打开画布时还没有 `flow_task_id`。
  - WebSocket 是某次 run 的事件读口，不是页面连接。

## 认证

- 为什么 token 放在第一帧，不放 URL？
  - 浏览器原生 `WebSocket` 构造器不能像 `fetch` 一样自由加 `Authorization` header。
  - OpenCreator 没有把 JWT 放进 query。
  - 服务端先 `accept()`，再要求第一条消息必须是认证帧。

- auth 消息长什么样？
  - `event_type` 是 `auth`。
  - `protocol_version` 是 `2`。
  - `token` 是 `__opencreator_jwt`。

- 服务端认证顺序是什么？
  - `accept()`。
  - 15 秒内等 auth。
  - `JwtService` 校验 token，得到 `user_id`。
  - `get_run_summary(user_id, flow_task_id)`。
  - 确认 run 属于当前用户。

- JWT 合法就一定能订阅吗？
  - 不一定。
  - JWT 合法但 run 不属于当前用户，也不能订阅事件。
  - 服务端应返回类似 `4404` 并关闭连接。

## attach 与 cursor

- 认证后为什么还要 attach？
  - auth 只证明当前连接是谁。
  - attach 才说明要订阅哪个 `flow_task_id`，以及从哪个 cursor 开始补事件。

- attach 消息里有什么？
  - `event_type=attach_flow`。
  - `protocol_version=2`。
  - `flow_task_id`、`connection_id`。
  - `last_event_cursor`。

- 服务端对 attach 校验什么？
  - 第二帧必须是 `attach_flow`。
  - body 里的 `flow_task_id` 和 `connection_id` 如果出现，必须和 URL 一致。
  - `last_event_cursor` 必须是合法 Redis Stream ID。
  - 空 cursor 按 `0-0` 处理。

- cursor 存在哪里？
  - 前端写入 `sessionStorage["workflow:v2:cursor:{flowTaskId}"]`。
  - NovelComic 当前实现也可能用 `workflow:v2:event_cursor:{flowTaskId}`。
  - 关键是按 `flow_task_id` 保存最近成功处理的 Redis Stream ID。

- 为什么 handler 成功后才推进 cursor？
  - 如果 handler 失败但 cursor 已经越过该事件，下次重连就不会再 replay 这一帧。
  - 画布状态会永久缺一段。

## Event Store

- Event Store 是什么？
  - Publisher 的事件事实源，底层是 Redis Stream。
  - Consumer 回程事件先经过 RabbitMQ 到 Publisher，写入 Event Store 后再 ACK。

- `append_event()` 做什么？
  - 确保 `event_id` 身份。
  - `XADD` 事件。
  - 记录 `event_id → cursor`。
  - 设置 TTL。
  - `PUBLISH` 通知连接有新事件。

- 为什么 Pub/Sub 不是可靠事件仓？
  - 它只是低延迟通知。
  - 即使通知丢失，WebSocket 事件循环也会继续从 Stream 追赶。
  - 恢复读取走 `replay()`，live 追赶走 `read_live()`。

- `event_id` 和 cursor 有什么区别？
  - `event_cursor` 解决“从哪里继续读”。
  - `event_id` 解决“同一个事件有没有重复处理”。

- 两层去重分别是什么？
  - Publisher Event Store 维护 `event_id → event_cursor`，重复 append 同一 `event_id` 时返回原 cursor。
  - 前端 transport 维护已见 `event_id` 集合，避免同一连接内 replay 和 live 重复触发 handler。

- Toast、埋点能不能靠 cursor 去重？
  - 不能。
  - 这类副作用要走独立的 side-effect claim。
  - 节点状态每个 tab 都要自己更新，不走 side-effect claim。

## resume_ready 与心跳

- 什么时候才能把连接状态改成 `connected`？
  - 只有收到 `resume_ready`。
  - 这时才能清零重连计数，并开始把后续 live events 交给业务 handler。

- `resume_ready` 里有什么？
  - `event_cursor`。
  - `latest_event_cursor`。
  - `status`，例如 `running`。

- 心跳策略是什么？
  - 大约每 30 秒 ping。
  - 10 秒内没有任何返回帧，就 `close(4000, "heartbeat_timeout")` 并进入重连。
  - 页面 hidden 时暂缓主动 ping，避免后台定时器节流造成误判。

- 重连退避是什么？
  - `1s → 2s → 4s → 8s → 15s → 30s`。
  - 再乘 0.8-1.2 的随机抖动。
  - 浏览器离线时等 `online`，页面重新可见时也会尝试恢复。

- 重连成功看什么？
  - 仍然看 `resume_ready`，不是新的 socket `onopen`。

## generation 与关闭码

- generation 解决什么问题？
  - 服务端为 `(flow_task_id, connection_id)` 维护 generation。
  - 同一个逻辑 connection 被新的物理 socket 占用时，generation + 1。
  - 新连接成为当前连接，旧连接关闭，不能继续推事件。

- cursor 过期为什么不是普通断线？
  - 如果 cursor 超出保留窗口，且服务端不能 snapshot 恢复，这是协议错误。
  - 这时不能无限重连同一个 cursor。
  - 前端要重置运行视图、重新查询 run 状态或提示用户刷新。

- 服务端常见关闭码有哪些？
  - `4401`：缺少 auth 或 JWT 失败。
  - `4404`：run 不存在或不属于当前用户。
  - `4400`：attach、cursor 或协议字段无效。
  - `4409`：cursor 超出保留窗口，且无法 snapshot 恢复。
  - `4001`：同一个 connection ID 已被更新连接替换。
  - `1011`：服务端内部错误。

- 前端主动关闭的典型原因？
  - `4000`：心跳超时。
  - `4001`：消息 JSON 解析失败。
  - `4002`：业务 handler 抛错。
  - `4003`：获取鉴权 token 失败。
  - `4004`：连接超时。
  - `4005`：重置 cursor 后换一条物理连接。
  - `4007`：连接后 30 秒内没有收到 `resume_ready`。

## v1 与刷新恢复

- 为什么 v1 和 v2 不要混用？
  - 旧 v1 路径把命令和结果绑在普通 WebSocket 上。
  - 它依赖实例内连接表，没有 v2 cursor 恢复语义。
  - 当前主链是 REST 命令 + Redis Stream + RabbitMQ + Event Store + v2 WebSocket。

- 刷新后怎么恢复？
  - `GET /api/v2/flow/runs?flow_id=...&status=active`。
  - 找到 active `flow_task_id`。
  - 读取 sessionStorage cursor。
  - 重新建立 WebSocket 并 `attach_flow(last_event_cursor)`。

- 关闭 WebSocket 等于停止任务吗？
  - 不等于。
  - 停止任务要走 `POST /api/v2/flow/runs/{flow_task_id}/cancel`。

## NovelComic 迁移

- 为什么不能先写一个能 `onopen` 的 socket 就算完成？
  - 没有 Event Store 和 cursor，刷新后仍然会丢事件。
  - 只有 cursor 但 handler 失败也推进，画布会出现不可恢复的状态洞。

- 推荐顺序是什么？
  - 先保证 `POST /api/v2/flow/runs` 能返回 `flow_task_id`。
  - 再让前端能用 `flow_task_id` 建 v2 WebSocket。
  - 再实现 auth 首帧和 run 归属校验。
  - 再实现 `attach_flow(last_event_cursor)`。
  - 再实现 Event Store replay 和 `resume_ready`。
  - 再把事件分发到画布节点 handler。
  - 最后补心跳、重连、generation、关闭码和 cursor 过期处理。

## 面试短答

- 一句话讲可恢复 WebSocket？
  - 它是某次 workflow run 的事件读口：先 REST 拿到 `flow_task_id`，再首帧 auth、第二帧 attach cursor，从 Event Store replay 后收到 `resume_ready`，才开始接 live events。

- 一句话讲为什么 `onopen` 不够？
  - `onopen` 只证明握手成功，认证、归属、cursor 和 replay 都还没做；真正可用点是 `resume_ready`。

- 一句话讲 cursor 规则？
  - handler 成功才推进 cursor；handler 抛错就关连接、不标记已处理，重连才能补回这一帧。

- 一句话讲安全边界？
  - 首帧必须带 JWT，并且按 `user_id + flow_task_id` 确认 run 归属，不能让合法用户监听别人的 run。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 前端已有 `workflow-resumable-websocket.ts`，能按 `flow_task_id` 建连。
  - 首帧会发 JWT auth，随后发 `attach_flow`。
  - 本地会按 `flow_task_id` 保存 cursor。
  - Publisher `flow_runs.py` 已有 WebSocket 入口，能等 auth、校验 run、replay 后进入事件循环。
  - `useWebSocketFlow` 已能处理 `resume_ready` 并分发节点事件。

- 当前实现能不能算本章主链路打通？
  - 可以算协议骨架打通。
  - 因为 auth、attach、Event Store replay 和前端 handler 入口都在。
  - 这不等于完整 OpenCreator 可恢复连接。

- 当前测试覆盖了哪些本章风险？
  - 覆盖了前端会带 JWT 查询 active run、创建 run 后进入事件连接。
  - 覆盖了 Publisher 按用户隔离读取 run。
  - 还没有完整覆盖心跳超时、generation 顶替旧连接、cursor 过期 `4409` 和 handler 失败不推进 cursor 的端到端验收。

- 为什么说当前还不是完整可恢复 WebSocket？
  - 心跳、退避抖动、页面 hidden 策略和完整关闭码还需要对齐。
  - generation 防止旧连接乱入还需要继续确认。
  - cursor 过期后的 snapshot 恢复或重置运行视图还不完整。
  - 刷新后“active run + cursor replay 让节点重新亮灯”还缺完整验收。

- 当前安全边界是什么？
  - WebSocket 首帧必须 auth。
  - Publisher 用 JWT 得到 `user_id`，再按 `user_id + flow_task_id` 查 run。
  - run 不属于当前用户时不能 replay 事件。

- 如果 WebSocket 连上了但节点不更新，当前应该怎么排查？
  - 先确认有没有收到 `resume_ready`，不要只看 `onopen`。
  - 再确认 Event Store 里是否已经有 `node_status`。
  - 再确认 handler 有没有成功写画布 store。
  - 再确认 cursor 是不是在 handler 失败时被错误推进。

- 什么时候才算本章完整验收？
  - 创建 run 后能 auth + attach + `resume_ready`。
  - 节点事件能更新画布。
  - 刷新或断线后能按 cursor 补事件。
  - 别人的 run 不能订阅。
  - cursor 过期不会死循环重连。
  - 关闭 WebSocket 不会取消任务。
