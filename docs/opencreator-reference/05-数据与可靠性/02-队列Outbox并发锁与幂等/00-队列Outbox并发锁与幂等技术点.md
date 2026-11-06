# 队列、Outbox、并发锁与幂等：这里面有哪些技术点

这一组只讲一次副作用怎么被承认一次，一条事件怎么至少送到一次。DAG 怎么找 ready 节点，已经在工作流命令那组写过。这里从命令身份、lease、CAS、ACK 顺序讲起。

先背一句话：

```text
Inbox 承认命令一次；
Outbox 至少投递一次；
ACK 发生在事实落盘之后。
```

同一条命令要过完这些认领，中间不能跳：

```text
1. 前端 journal
     超时、断网、5xx：留着 command_id
     400 / 401 / 403 / 404 / 409 / 422：才 abandon

2. Publisher create_run
     先按 (user_id, command_id) 看 replay
     payload 相同：回原来的 flow_task_id
     payload 不同：409
     新命令：一个 Mongo 事务写入 flow_task + workflow_command

3. 派发 lease
     _claim_command：pending 到期，或 dispatching 的 lease 到期
     写成 dispatching
     Redis Stream run_flow，消息里的 command_id 是 wire_command_id
     成功后命令行 dispatched
     失败后 flow_task.dispatch_state = pending_retry
     dispatcher_forever 每 2 秒 dispatch_due_commands，再走同一把 lease

4. Consumer Inbox
     任何 init / continue / cancel 之前 claim_command
     身份 = command_id + protocol_version + command_type
            + flow_task_id + flow_run_id + payload_hash
     相同身份：第二次 claimed=false，直接 return
     身份变了：conflict=true，也不执行
     claim 时把完整运输体写进 redelivery_payload

5. start 锁
     锁被别人拿着，而且 flow_run_state 还不存在
     → 抛错，mark_failed，不能 mark_completed
     已经 start_initialized
     → 直接 return，然后 mark_completed
     库里有 run、但还没 start_initialized
     → 接着铺节点，这是修复半截 bootstrap

6. 节点 CAS 和 resume 锁
     SET opencreator:flow_resume_lock:{run_id} NX
     transition_status 的条件里带当前 status
     模型节点先把 execution_plans 写进 flow_node_state
     再按 result_id 提交
     提交不确定时 mark_submit_uncertain，不新造 result_id

7. AI 入队
     TaskRepository.createOrGet
     重复 idempotency_key：返回 existing，不插第二行
     BullMQ：provider-execution → artifact-processing → consumer-callback
     这三步做完，节点还没完成

8. HTTP 回调
     POST /callbacks/models/{vendor}
     先验 x-oc-signature
     handle_callback_fast
       按 vendor + external_task_id 对 invocation
       对不上再按 trace_id 补 external_task_id
       还对不上：upsert pending_model_callback，返回 matched=false
     响应体 status=accepted
     accepted 只表示 HTTP 收下了
     finalize_scheduled 才表示收尾已排队

9. Finalizer lease
     finalize_status 必须还在可认领集合里
     认领后写成 running，finalize_attempt_count + 1
     认领失败就停
     然后写 results、确认或回滚 usage、发 node_status

10. Outbox lease
      stable_event_id → claim event_id
      publishing lease 默认 30 秒
      publish RabbitMQ
      再按 lease token 标 sent
      发出去了但没标上 sent：下一轮可再投，event_id 不变

11. Publisher ACK
      workflow_v2_mq_callback
      protocol_version=2，header 和 body 对齐
      旧命令不能把终态 flow_task 改回去
      append_event：重复 event_id 返回原 cursor
      然后 message.ack()
      形状不合法且还没落库：reject，不重入队
      落库过程失败：nack，重入队

12. 浏览器
      attach / replay 用 event_cursor
      积分和统计用 runWorkflowSideEffectOnce(event_id, scope)
      节点变色不走这把 claim
```

Redis Stream 的消费位移、Inbox 的 completed、callback 的 accepted、RabbitMQ 的 ACK、浏览器 cursor，各自只承认自己这一跳。

---

## 1. 幂等身份分成五层

| 层 | 身份 | 落点 | 挡住什么 |
| --- | --- | --- | --- |
| 用户意图 | `command_id` | 前端 journal、Publisher `workflow_command` | 同一次点击开第二个 run |
| 执行认领 | Inbox 的 `command_id` + `payload_hash` | `flow_command_inbox` | 同一道命令做两次副作用；换了 payload 则是冲突 |
| 节点迁移 | 当前 `status`、`execution_claim_token` | `flow_node_state` | 两个 worker 同时把节点推走 |
| 逻辑事件 | `event_id` | Outbox、Event Store、前端 handler | 同一条事件写两次、推两次副作用 |
| 厂商任务 | `ai_task_id`、`idempotency_key`、`(provider, provider_request_id, event_id)` | AI Mongo | 同一任务、同一次尝试、同一条厂商事件插两行 |

AI 每次 HTTP callback 还会带一个新的 `x-oc-idempotency-key`，值是 `randomUUID:timestamp`。这把钥匙每次投递都变。业务去重要靠 `ai_task_id` 和 provider 身份，不能只靠这个 header。

---

## 2. Publisher 先用 lease 认领命令，再推进 Redis Stream

[workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py) 的 `_claim_command()` 只认两类到期行：

```text
status = pending，并且 next_attempt_at 已到
status = dispatching，并且 lease_expires_at 已到
```

认领时写成 `dispatching`，带上新的 `lease_token` 和 `lease_expires_at`。派发出去之后，命令行进入 `dispatched`。

发给 Consumer 的 `command_id` 是 `wire_command_id`。用户看见的 `command_id` 留在 Publisher。回程事件再用 `wire_command_id` 查回 `client_command_id`。

这一步的 lease 解决的是“两个 Publisher 进程同时派发同一道命令”。它不代替 Consumer Inbox。

---

## 3. Redis Stream 只负责把命令送到执行仓

Publisher 的 [tasks/flow.py](../../../../../opencreate/opencreator-publisher/tasks/flow.py) 把 `run_flow` 发到 Redis Stream。Consumer 同名任务才执行。

Stream 重投只说明运输层又送了一次。副作用是否再做，看 Inbox `claim_command()` 还认不认。

Agent 的 [task_publisher.py](../../../../../opencreate/opencreator-agent/creato/workflow/task_publisher.py) 也可以往同一个 `run_flow` 队列 `publish()`。函数体是空的，真正执行仍在 Consumer。Agent 不写 `flow_command_inbox`，也不写画布 Outbox。

---

## 4. Inbox 用同一把 command_id 决定认还是冲突

[flow_command_inbox_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_command_inbox_service.py)

`claim_command()` 把这些字段当成身份：

```text
command_id
protocol_version
command_type
flow_task_id
flow_run_id
payload_hash
```

`payload_hash` 是 canonical JSON 的 SHA-256。键排序、分隔符固定。

认领条件是：这行还不存在，或者它已经是到期的 `processing` / 到期的 `failed`。成功则：

```text
status = processing
lease_token = 新的 uuid
lease_expires_at = now + FLOW_COMMAND_INBOX_LEASE_SECONDS
attempts += 1
清掉 expires_at、error、旧的 redelivery lease
```

默认 lease 是 300 秒，配置项 `FLOW_COMMAND_INBOX_LEASE_SECONDS`。

唯一索引冲突时再读现有行：

- 身份字段一致：已经有人认领或已经完成，这次 `claimed=false`，不是冲突。
- 任一身份字段不同：`conflict=true`。这是另一道命令撞上了同一个 id，不是重试。

`mark_completed()` 必须带着原来的 `lease_token`，把 `processing` 改成 `completed`，并写上 `expires_at`。lease 已经过期、被别人接走时，这次完成写不进去。

`mark_failed()` 同样要带 lease。它把状态改成 `failed`，写 `next_attempt_at`，并清掉 `expires_at`。失败行留在库里等重投，不交给 TTL。

---

## 5. 节点推进用条件更新，resume 再用一把 run 锁

节点状态迁移在：

[flow_node_state_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_node_state_service.py)

`transition_status()` 的过滤条件带上当前状态：

```text
run_id + node_id + status ∈ from_statuses
  → 才把 status 写成新值
```

两个 worker 同时把 `idle` 改成 `running`，只有一个 `matched`。后来的那个看 `matched_count`，不再执行提交。

模型节点还有 `execution_claim_token`。`owns_execution_claim()` 要求节点仍是 `RUNNING` 且 token 还是自己的。恢复把过期执行打回队列时，`requeue_orphaned_execution()` 用 plan token 和 claim token 做 CAS，旧 worker 的 token 失效，新 worker 仍用原来的 `result_id`。

同一条 run 的推进还有 Redis 锁：

```text
opencreator:flow_resume_lock:{run_id}
SET key token EX FLOW_RESUME_LOCK_TTL_SECONDS NX
```

默认 TTL 300 秒。拿不到锁就直接返回。释放时先读出现值，等于自己的 token 才删除，避免删掉下一任的锁。

这把锁缩小的是“两个 resume 同时扫 ready 节点”。它不代替节点 CAS。锁过期之后，CAS 仍然要能挡住重复提交。

---

## 6. Outbox 用 publish lease，发送成功和标 sent 是两步

[flow_event_publish_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)

类注释写着 transactional outbox。现码的 `publish()` 自己插入 Outbox 行，不和节点状态更新包在同一个 Mongo session 里。状态先落库、进程再死掉，可能出现“状态已变、Outbox 还没有这行”。终态缺口由清扫那组补 `finish_flow` / `flow_killed`。

一条逻辑事件的 `event_id` 来自：

```text
stable_event_id(*parts)
  → canonical JSON
  → SHA-256 前 32 位
  → wfe_{digest}
```

同一组 parts 得到同一个 `event_id`。

`_claim_event()` 能接住的行：

```text
pending
failed 且 next_attempt_at 已到，或没有 next_attempt_at
publishing 且 publish_lease_expires_at 已到，或没有 lease
```

接住之后写成 `publishing`，lease 默认 30 秒（`FLOW_EVENT_OUTBOX_PUBLISH_LEASE_SECONDS`）。唯一键冲突说明这行已经是 `sent`，或者另一把活 lease 还在，当前调用直接返回。

`_publish_claimed()` 先 `publisher.publish_message()`，再按 `event_id + publishing + publish_lease_token` 更新成 `sent`，并写 `expires_at`。默认保留 7 天（`FLOW_EVENT_OUTBOX_RETENTION_SECONDS`）。

如果消息已经发出，更新 `sent` 时 lease 对不上，代码打 warning 并仍然返回成功。下一轮可能再投一次。Publisher 用同一个 `event_id` 回到原来的 cursor，不另开一条逻辑事件。

---

## 7. RabbitMQ ACK 在 Event Store 落盘之后

[database/mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py) 的 `workflow_v2_mq_callback()`：

```text
解码 JSON
  → protocol_version 必须是 2
  → header 和 body 的 event_id / flow_run_id / command_id 不能互相打架
  → 用 wire_command_id 查回 client_command_id
  → 终态 flow_task 不被旧事件改回去
  → WorkflowEventStore.append_event()
  → 用更晚的 cursor 更新 flow_task
  → message.ack()
```

[workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py) 的 Lua 是：

```text
HGET event_id
  已存在 → 返回原来的 cursor，inserted=0
不存在 → XADD events
       → HSET event_id → cursor
       → EXPIRE 两把键
       → PUBLISH 唤醒
```

重复投递也会走到 `append_event()`。只要这次调用返回了，`event_persisted` 就是真，然后才 ACK。ACK 认的是“Event Store 已经能按这个 `event_id` 找到 cursor”，不只认“这次是不是新 XADD”。

Pub/Sub 只负责叫醒在线连接。断线之后读的是 Stream。

WebSocket 发出去之后没有再向 RabbitMQ 要一次 ACK。连接不在线，事件已经在 Stream 里。

---

## 8. 前端本地副作用再用一把 claim

服务端去重之后，浏览器仍可能收到同一条 replay。积分刷新、统计上报走：

[workflow-side-effect-claim.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-side-effect-claim.ts)

```text
claimKey = scope + ":" + eventId
navigator.locks.request("workflow-v2:" + claimKey)
  → localStorage 里 24 小时内已有这次 claim：跳过
  → 没有：写上时间戳，执行 effect
  → effect 抛错：删掉 claim，允许再试
```

没有 Web Locks 时，退回 localStorage 的读改写。两个标签页可能同时通过检查。这是 best-effort，不是服务端唯一索引。

UI 画节点颜色不走这把 claim。事件可以再次应用到界面。只有会重复扣费、重复打点的副作用才 claim。

---

## 9. AI 用队列拆阶段，用唯一键收重复

[queue-names.ts](../../../../../opencreate/opencreator-ai/packages/queues/src/queue-names.ts)：

```text
provider-execution
artifact-processing
consumer-callback
consumer-callback-dlq
media-face-verification
```

worker 在 [apps/worker/src/main.ts](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts) 里把四个 processor 挂上。BullMQ job 完成，只说明 AI 这一段做完了。Consumer 节点要等签名 callback，再进 Finalizer。

callback 请求在 [consumer-callback.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)：

```text
x-oc-timestamp
x-oc-signature          HMAC，密钥是 consumer webhook secret
x-oc-idempotency-key    每次投递新生成
```

HTTP 2xx 表示 Consumer 收下了这次请求。`finalize_status=done` 才表示节点侧收尾写完。两步都要有。签名也不能代替 RabbitMQ 的账号权限，队列 ACK 也不是用户鉴权。

---

## 10. 维护调度的 Redis 锁只管“谁来发扫描”

[tasks/setup.py](../../../../../opencreate/opencreator-consumer/tasks/setup.py) 里，每种维护命令一把锁：

```text
opencreator:flow_maintenance_scheduler:{command}
SET key instance_id EX (interval - 1) NX
```

拿到锁的实例才把命令推进 `flow_maintenance`。这把锁避免多实例同时塞同一类扫描。扫描内部还要靠 Inbox redelivery lease、Outbox publish lease 和节点 CAS。调度锁过期，不代表业务副作用可以做第二次。

`FLOW_MAINTENANCE_SCHEDULER_ENABLED` 可以关掉整段调度。关掉之后，lease 和唯一索引仍在，只是没有人周期重投。

---

## 动手前要有的东西

1. 上一组的唯一索引已经在启动路径上，尤其是 Inbox `command_id` 和 Outbox `event_id`。
2. 工作流命令那组已经能把 v2 command 放进 Redis Stream，并把事件放进 RabbitMQ。
3. Publisher Event Store 的 `append_event()` 已经按 `event_id` 去重。
4. AI `/v1/tasks` 和 callback 入口已经存在。
5. Redis、RabbitMQ 在本地可用。

做完这组后，验收目标是：

```text
同一 command_id + 同一 payload：Inbox 只 claimed 一次
同一 command_id + 不同 payload：conflict
节点 CAS 失败的一方不再提交模型
同一 event_id 重投：Event Store 返回原 cursor，然后 ACK
发送成功但没标 sent：靠 event_id 收成一次逻辑事件
前端同一 event_id 的积分副作用只执行一次
AI callback 的新 idempotency header 不会单独被当成业务去重键
```
