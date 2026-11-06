# OpenCreator 是怎么做队列、Outbox、并发锁与幂等的

## 一、先说结论

OpenCreator 的工作流副作用走两条账，中间没有跨库大事务。

```text
命令账：command_id → workflow_command lease → Redis Stream → Inbox lease
事件账：event_id → Outbox publish lease → RabbitMQ → Event Store → ACK
```

AI 另有一套 BullMQ。Agent 可以往 `run_flow` 投一条消息，不进入画布 Inbox / Outbox。

一条命令从点击走到画面，中间的认领是这一串。事件账嵌在第 9 步之后，不是另一条无关的管道：

```text
1. getOrCreateWorkflowCommand()
2. create_run() 事务写入 flow_task + workflow_command
3. dispatch_command()
     失败 → dispatch_state=pending_retry
     dispatcher_forever 每 2 秒再 _claim_command()
4. Redis Stream run_flow
5. claim_command()，先存 redelivery_payload
6. start 锁
     没有 durable run 且锁被占住 → 抛错 → mark_failed
     已 start_initialized → return → mark_completed
     有半截 run → 继续 init_nodes
7. init_flow_run → init_nodes → seed → start_flow → resume → mark_start_initialized
8. resume 锁 → transition_status → 先写 execution_plans → 再 submit
9. AI createOrGet(idempotency_key)
     provider-execution → artifact-processing → consumer-callback
10. POST /callbacks/models/{vendor}
      验签 → handle_callback_fast
      对不上 → pending_model_callback，响应仍是 accepted
11. InvocationFinalizer claim finalize_status
      写 results / usage，再聚合节点
12. Outbox claim → RabbitMQ
13. append_event() 之后 message.ack()
14. WebSocket replay
15. runWorkflowSideEffectOnce(event_id, scope)
```

读代码时抓住一个边界：每一层 ACK 只覆盖自己那一层。Stream 确认了运输，Inbox 才确认副作用。callback 的 `accepted` 确认 HTTP 已收下，Finalizer 才确认结果落库。Rabbit 确认 Publisher 已落 Event Store，不确认浏览器已经画完。

---

## 二、前端：稳定意图，再抑制本地副作用

相关文件：

1. [workflow-command-journal.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-command-journal.ts)
2. [workflow-side-effect-claim.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-side-effect-claim.ts)

### 1. journal 把一次点击定成一把 command_id

`getOrCreateWorkflowCommand(operationKey, request, prefix)`：

```text
sessionStorage 里已有这把 operationKey
  → 返回第一次的 commandId 和第一次的 payload
没有
  → 生成 wf_ / continue_ / cancel_ 前缀 id
  → 写入 workflow:v2:pending_commands
```

超时、断网、5xx 不调用 `abandonWorkflowCommand()`。确定性的 400、401、403、404、409、422 才丢掉这把 id。

journal 让重试带着同一把 `command_id`。服务端是否接成同一次 run，还要看 `workflow_command` 的唯一索引和 payload 比对。

### 2. 副作用 claim 不负责命令

`runWorkflowSideEffectOnce(eventId, scope, effect)` 的键是 `scope:eventId`。

```text
有 navigator.locks
  → locks.request("workflow-v2:" + claimKey)
没有
  → 直接读改 localStorage
```

`tryClaim()` 看到 24 小时内的同一键就返回 false。effect 失败会 `releaseClaim()`。存储坏了时返回 true，宁肯让副作用再跑一次，也不要卡住界面。积分入账的真正唯一键仍是服务端 `credits_inout_record.idempotency_key`。

---

## 三、Publisher：派发 lease 和结果 ACK

相关文件：

1. [services/workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)
2. [tasks/flow.py](../../../../../opencreate/opencreator-publisher/tasks/flow.py)
3. [database/mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py)
4. [services/workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)

### 1. 命令行自己有 lease

`_claim_command()` 用 `find_one_and_update`：

```text
pending 且 next_attempt_at <= now
或 dispatching 且 lease_expires_at <= now
  → status = dispatching
  → lease_token、lease_expires_at
```

`dispatch_command()` 在 claim 成功之后把 payload 交给 `FlowTask.run_flow.publish()`。队列名是 `run_flow`，broker 是 Redis Stream。发出去之后命令状态写成 `dispatched`。

payload 里的 `command_id` 填 `wire_command_id`。Consumer Inbox 认的是这把派发身份。

### 2. 结果回调先对齐字段，再落库，再 ACK

`workflow_v2_mq_callback()` 拒绝这些消息，不在校验失败时假装已经持久化：

- body 不是 JSON 对象
- `protocol_version` 缺失或不是 2
- header 和 body 的 `event_id`、`flow_run_id`、`command_id`、`protocol_version` 不一致
- 缺 `event_id`、`flow_run_id`、`command_id`

对齐之后：

```text
wire_command_id → workflow_command.command_id
  写进 event.client_command_id

flow_task 已经是 completed / failed / killed
  → 保持终态

flow_task 是 cancel_requested，而这条事件还不是终态
  → 保持 cancel_requested

事件想把状态改回 running / waiting_for_selection
  但 command_id 不是当前 current_wire_command_id
  → 事件可以进 Event Store，公开状态不回退
```

然后 `append_event()`。重复 `event_id` 返回原来的 cursor，`event_persisted` 仍为真。`flow_task.last_event_cursor` 只用更晚的 cursor 覆盖。最后 `message.ack()`。

形状不合法、并且还没开始落库：`reject(requeue=False)`。已经开始落库之后失败，或者其他异常：`nack(requeue=True)`。这两种都不是“已经持久化”的 ACK。

现码在 ACK 之后打点 `flow.v2_mq_ack_without_event_persist`。正常路径这个值是 0，用来把“健康的零”和“指标没上报”分开。

### 3. Event Store 的去重在 Lua 里

```text
KEYS: events stream, event_ids hash
ARGV: event_id, payload, ttl, maxlen, channel

HGET 已有 cursor → 返回 {cursor, 0}
否则 XADD → HSET → EXPIRE → PUBLISH → 返回 {cursor, 1}
```

键名：

```text
opencreator:wf:{flow_task_id}:events
opencreator:wf:{flow_task_id}:event_ids
```

通知频道是 `opencreator:workflow:v2:event-notifications`。频道消息只用于唤醒。replay 读 Stream。

---

## 四、Consumer：Inbox、CAS、Outbox

相关文件：

1. [services/workflow/flow_command_inbox_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_command_inbox_service.py)
2. [tasks/flow.py](../../../../../opencreate/opencreator-consumer/tasks/flow.py)
3. [services/workflow/flow_node_state_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_node_state_service.py)
4. [tasks/flow_resume.py](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py)
5. [services/workflow/flow_event_publish_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)
6. [tasks/setup.py](../../../../../opencreate/opencreator-consumer/tasks/setup.py)

### 1. run_flow 先 claim，再做副作用

Consumer `FlowTask.run_flow()` 收到消息后要先 `claim_command()`。`claimed=false` 且不是自己仍持有的 lease 时，后面的 `init_flow_run()`、cancel、continue 都不执行。

`conflict=true` 时不能当成重试再跑一遍。身份字段里任意一个变了，就是另一道命令用了同一个 id。

完成时：

```text
mark_completed(command_id, lease_token)
  status: processing → completed
  写 expires_at = now + FLOW_COMMAND_INBOX_RETENTION_SECONDS
```

失败时：

```text
mark_failed(command_id, lease_token, error)
  status: processing → failed
  写 next_attempt_at
  清掉 expires_at
```

两步更新都带 `lease_token`。token 对不上，更新行数为 0。

### 2. 过期命令另有一把 redelivery lease

`claim_due_redelivery()` 再找：

```text
有 redelivery_payload
并且执行 lease 已过期的 processing，或到期的 failed
并且 redelivery lease 也已过期或不存在
```

它写下 `redelivery_lease_token`。恢复服务把 `redelivery_payload` 原样 `aio_push` 回 `run_flow`，再 `mark_redelivery_enqueued()`。重投出去的仍是原来的 `command_id`。新的 Stream 消息进 Inbox 时，身份相同才能再次 claim。

### 3. 节点 CAS

`transition_status(run_id, node_id, from_statuses, status)` 的查询带 `status: {$in: from_statuses}`。没匹配到就返回 false。

执行权另看 `execution_claim_token`。恢复重排时 `requeue_orphaned_execution()` 把过期的 `RUNNING` CAS 回队列，plan 和 `result_id` 留在节点上。后到的旧 worker 因为 token 变了，不能再把这次提交算成自己的。

### 4. resume 锁

`FlowResumeTask.handle_resume()`：

```text
token = nanoid
SET opencreator:flow_resume_lock:{run_id} token NX EX FLOW_RESUME_LOCK_TTL_SECONDS
没拿到 → return
拿到 → _resume_once()
finally：GET 仍等于自己的 token 才 DEL
```

锁的默认 TTL 是 300 秒。拿到锁之后仍要走节点 CAS。锁只减少同时进入 `_resume_once()` 的次数。

### 5. Outbox

`publish()` 组装 outbox 文档后 `_claim_event(insert_document=...)`。claim 不到就读现有 `status` 并跳过。claim 到了就 `_publish_claimed()`。

目标队列默认 `settings.FLOW_TASK_RESULT_QUEUE`，也可以由调用方传入 `reply_queue`。

`replay_due_events(limit)` 循环 `_claim_next_due_event()`。单条投递失败会把这行标成 `failed` 并写延迟，然后继续下一条，不让一个坏目的地堵住整批。

发送已经成功、标记 `sent` 失败时，日志写明将依赖 `event_id` 去重。这是至少一次，不是恰好一次。

### 6. 调度锁

`_maintenance_scheduler()` 每 10 秒看一轮。每种 command 到了自己的 interval，才：

```text
SET opencreator:flow_maintenance_scheduler:{command}
    instance_id
    EX max(interval - 1, 1)
    NX
```

`locked` 为真才 `handle_maintenance.aio_push`。多实例里只有一个会把这类扫描放进 `flow_maintenance` 队列。

---

## 五、AI：阶段队列和回调签名

相关文件：

1. [packages/queues/src/queue-names.ts](../../../../../opencreate/opencreator-ai/packages/queues/src/queue-names.ts)
2. [packages/queues/src/workers.ts](../../../../../opencreate/opencreator-ai/packages/queues/src/workers.ts)
3. [apps/worker/src/main.ts](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts)
4. [packages/runtime/src/consumer-callback.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)
5. [packages/db/src/mongo.ts](../../../../../opencreate/opencreator-ai/packages/db/src/mongo.ts)

worker 挂四类处理：

```text
provider-execution        调厂商
artifact-processing       产物
consumer-callback         签名回调 Consumer
media-face-verification   人脸检测
```

另外还有队列 `consumer-callback-dlq`。回调失败可以进这条死信队列。DLQ 里有一条，说明自动投递停了，不等于 Consumer 节点已经失败收尾。

`ConsumerCallbackService` 发 HTTP 时：

```text
body = 公开结果 JSON
timestamp = 当前时间
idempotencyKey = randomUUID + ":" + timestamp
signature = HMAC(consumerWebhookSecret, timestamp, rawBody)
```

Consumer 验签通过并返回 2xx，只表示这次 HTTP 被接受。节点聚合、扣费确认、`finalize_status` 仍在 Consumer。下一次重试会换一把新的 `x-oc-idempotency-key`。去重要落在 `ai_callback_delivery (ai_task_id, attempt)`、`ai_task.idempotency_key` 和 provider event 三元组上。

---

## 六、Agent：能投 run_flow，不参加画布 Outbox

相关文件：

1. [creato/workflow/task_publisher.py](../../../../../opencreate/opencreator-agent/creato/workflow/task_publisher.py)
2. [creato/services/agent_redis_run_store.py](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)

`task_publisher.run_flow` 的队列默认 `CREATO_WORKFLOW__RUN_FLOW_QUEUE`，否则是 `run_flow`。参数外形和 Publisher / Consumer 的 `run_flow` 对齐，函数体不执行 DAG。

Agent 自己的 run 在 `RedisRunStore`：

```text
acquire_session_run_lock / release_session_run_lock
append_event / read_events
ensure_resume_available
write_checkpoint / read_checkpoint
```

`ResumeWindowExpiredError` 表示 Agent SSE 的事件窗过期。它和画布 WebSocket 的 `RESUME_WINDOW_EXPIRED` 不是同一把 Redis 键，也不能用画布 `event_cursor` 去续 Agent run。

---

## 七、四次 ACK 各确认什么

| 确认 | 发生时机 | 确认了 | 还没确认 |
| --- | --- | --- | --- |
| Redis Stream 消费位移 | Consumer 收下 `run_flow` | 运输层这条消息处理过 | Inbox 一定 claim 成功 |
| Inbox `completed` | `mark_completed(lease_token)` | 这把命令的副作用做完 | 事件已经到浏览器 |
| AI callback 2xx | Consumer HTTP 返回成功 | 这次回调请求被接受 | Finalizer 已完成 |
| RabbitMQ ACK | `append_event()` 返回之后 | Event Store 有这个 `event_id` | 浏览器已经应用 |
| WebSocket cursor | 前端持久化 `event_cursor` | 这个连接处理到哪 | 服务端可以丢掉事件 |

凭证也分开。用户 JWT 进 Publisher API。AI callback 用 `x-oc-signature`。内部快照用另一把 `INTERNAL_API_KEY`。队列账号不能代替这三把。

---

## 八、和 NovelComic 对照

搬这组时，最小可交付：

1. 前端 journal 在超时后复用 `command_id`，4xx 确定性拒绝才放弃。
2. Publisher 派发前有 `pending / dispatching` lease，发出去的是 `wire_command_id`。
3. Consumer 在初始化 run、continue、cancel 之前 `claim_command()`。
4. 相同身份重复投递不再执行；身份字段变化标成 conflict。
5. 节点 `transition_status()` 带 `from_statuses`。resume 有 run 锁，锁释放核对 token。
6. 事件先有稳定 `event_id` 和 Outbox 行，再发 RabbitMQ。
7. Publisher 先 `append_event()`，后 `message.ack()`。重复 `event_id` 也要能 ACK。
8. 前端非 UI 副作用按 `event_id + scope` claim。没有 Web Locks 时接受 best-effort。
9. AI 阶段队列和画布 Outbox 分开。callback header 里的幂等键每次新建，不拿它当唯一业务键。
10. Agent 的 run 锁和 SSE 恢复不写进 `flow_command_inbox`。

只做 Redis Stream、只做一张 Outbox 表、或只在前端防双击，都还没有这组的幂等。状态更新和 Outbox 插入现码也不是一个 Mongo 事务，所以还要有下一组的补偿扫描。
