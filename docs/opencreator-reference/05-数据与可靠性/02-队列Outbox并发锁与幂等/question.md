# 队列、Outbox、并发锁与幂等 question

## 核心概念

- “队列、Outbox、并发锁与幂等”讲的是什么？
  - 讲的是一次副作用怎么被承认一次，一条事件怎么至少送到一次。
  - 它从命令身份、lease、CAS 和 ACK 顺序讲起。
  - DAG 怎么找 ready 节点，已经在工作流命令那组写过。

- 先背哪三句话？
  - Inbox 承认命令一次。
  - Outbox 至少投递一次。
  - ACK 发生在事实落盘之后。

- 工作流副作用为什么是两条账？
  - 命令账：`command_id` → `workflow_command` lease → Redis Stream → Inbox lease。
  - 事件账：`event_id` → Outbox publish lease → RabbitMQ → Event Store → ACK。
  - 两条账中间没有跨库大事务。事件账嵌在执行之后，是同一条点击的后半段。

- 为什么每一层 ACK 不能互相代替？
  - Redis Stream 消费位移只说明运输层这条消息处理过。
  - Inbox `completed` 才说明这把命令的副作用做完。
  - AI callback 的 `accepted` 只说明这次 HTTP 被收下。
  - RabbitMQ ACK 说明 Event Store 已经能按 `event_id` 找到 cursor。
  - 浏览器 cursor 只说明这个连接处理到哪。

## 五层幂等身份

- 幂等身份分成哪五层？
  - 用户意图：`command_id`，落在前端 journal 和 Publisher `workflow_command`。挡住同一次点击开第二个 run。
  - 执行认领：Inbox 的 `command_id` 加 `payload_hash`。挡住同一道命令做两次副作用；换了 payload 则是冲突。
  - 节点迁移：当前 `status` 和 `execution_claim_token`。挡住两个 worker 同时把节点推走。
  - 逻辑事件：`event_id`。挡住同一条事件写两次、推两次副作用。
  - 厂商任务：`ai_task_id`、`idempotency_key`、`(provider, provider_request_id, event_id)`。挡住同一任务、同一次尝试、同一条厂商事件插两行。

- `x-oc-idempotency-key` 能不能当业务去重键？
  - 不能单独当。
  - 它的值是 `randomUUID:timestamp`，每次 HTTP 投递都变。
  - 业务去重要靠 `ai_task_id`、`ai_callback_delivery (ai_task_id, attempt)` 和 provider 身份。

## 前端与 Publisher 派发

- 前端 journal 什么时候留着 `command_id`？
  - 超时、断网、5xx 留着，下一次重试复用同一把 id 和第一次的 payload。
  - `400 / 401 / 403 / 404 / 409 / 422` 才 `abandonWorkflowCommand()`。
  - 服务端明确收下之后，journal 会清掉这把 id，下一次点击才是新命令。

- Publisher 派发 lease 认哪些行？
  - `status=pending` 并且 `next_attempt_at` 已到。
  - `status=dispatching` 并且 `lease_expires_at` 已到。
  - 认领时写成 `dispatching`，带上新的 `lease_token` 和 `lease_expires_at`。
  - 发出去之后命令行进入 `dispatched`。失败则把 `flow_task.dispatch_state` 写成 `pending_retry`，`dispatcher_forever` 每 2 秒再领。

- 发给 Consumer 的 `command_id` 是哪一把？
  - 是 `wire_command_id`。
  - 用户看见的 `command_id` 留在 Publisher。
  - 回程事件再用 `wire_command_id` 查回 `client_command_id`。
  - 这把 lease 解决的是两个 Publisher 进程同时派发同一道命令。它不代替 Consumer Inbox。

- Redis Stream 重投会不会再做一次副作用？
  - Stream 重投只说明运输层又送了一次。
  - 副作用是否再做，看 Inbox `claim_command()` 还认不认。

## Inbox、start 锁与节点 CAS

- Inbox 把什么当成同一道命令？
  - `command_id`、`protocol_version`、`command_type`、`flow_task_id`、`flow_run_id`、`payload_hash`。
  - `payload_hash` 是 canonical JSON 的 SHA-256，键排序、分隔符固定。
  - 身份一致：第二次 `claimed=false`，直接返回。
  - 任一身份字段不同：`conflict=true`，也不执行。
  - claim 时把完整运输体写进 `redelivery_payload`。

- `mark_completed()` 和 `mark_failed()` 为什么要带 `lease_token`？
  - 完成必须把 `processing` 改成 `completed`，并写上 `expires_at`。
  - 失败改成 `failed`，写 `next_attempt_at`，并清掉 `expires_at`。
  - lease 已经过期、被别人接走时，更新行数为 0，这次完成写不进去。
  - 失败行留在库里等重投，不交给 TTL。

- start 锁挡住的是哪一种半截状态？
  - 锁被别人拿着，而且 `flow_run_state` 还不存在：抛错，`mark_failed`，不能 `mark_completed`。
  - 已经 `start_initialized`：直接返回，然后 `mark_completed`。
  - 库里有 run、但还没 `start_initialized`：接着铺节点，这是修复半截 bootstrap。

- 节点 CAS 和 resume 锁各管什么？
  - `transition_status()` 的条件里带当前 `status`。两个 worker 同时把 `idle` 改成 `running`，只有一个 `matched`。
  - 模型节点还有 `execution_claim_token`。`owns_execution_claim()` 要求节点仍是 `RUNNING` 且 token 还是自己的。
  - `requeue_orphaned_execution()` 用 plan token 和 claim token 做 CAS。旧 worker 的 token 失效，新 worker 仍用原来的 `result_id`。
  - `SET opencreator:flow_resume_lock:{run_id} NX`，默认 TTL 300 秒。拿不到锁就返回。释放时先读出现值，等于自己的 token 才删除。
  - 这把锁缩小的是两个 resume 同时扫 ready 节点。锁过期之后，CAS 仍然要能挡住重复提交。

- 提交不确定时为什么不能新造 `result_id`？
  - 模型节点先把 `execution_plans` 写进 `flow_node_state`，再按 `result_id` 提交。
  - 提交结果不清楚时走 `mark_submit_uncertain`。
  - 新造 `result_id` 会把同一次计划拆成两次尝试。

## AI、Finalizer 与 Outbox

- AI 入队做完，节点完成了吗？
  - 没有。
  - `TaskRepository.createOrGet` 遇到重复 `idempotency_key` 返回 existing，不插第二行。
  - BullMQ 顺序是 `provider-execution` → `artifact-processing` → `consumer-callback`。
  - 这三步做完，节点还要等签名 callback，再进 Finalizer。

- HTTP 回调的 `accepted` 表示什么？
  - `POST /callbacks/models/{vendor}` 先验 `x-oc-signature`。
  - `handle_callback_fast` 按 `vendor + external_task_id` 对 invocation，对不上再按 `trace_id` 补。
  - 还对不上：upsert `pending_model_callback`，返回 `matched=false`。响应体仍是 `status=accepted`。
  - `accepted` 只表示 HTTP 收下了。`finalize_scheduled` 才表示收尾已排队。

- Finalizer 怎么避免两个人一起写结果？
  - `finalize_status` 必须还在可认领集合里，认领后写成 `running`，`finalize_attempt_count + 1`。
  - 认领失败就停。
  - 然后写 `results`、确认或回滚 usage、发 `node_status`。
  - `finalize_status=done` 才表示节点侧收尾写完。

- Outbox 为什么是至少一次？
  - `stable_event_id` 用 canonical JSON 的 SHA-256 前 32 位，前缀 `wfe_`。同一组 parts 得到同一个 `event_id`。
  - 先 claim 成 `publishing`，lease 默认 30 秒，再 `publish_message()`，再按 lease token 标 `sent`。
  - 发出去了但没标上 `sent`：下一轮可再投，`event_id` 不变。
  - Publisher 用同一个 `event_id` 回到原来的 cursor，不另开一条逻辑事件。
  - `publish()` 自己插入 Outbox 行，不和节点状态更新包在同一个 Mongo session 里。状态已变、Outbox 还没有这行时，终态缺口由清扫那组补。

## Publisher ACK 与浏览器

- `workflow_v2_mq_callback()` 的顺序是什么？
  - 先校验 `protocol_version=2`，header 和 body 的 `event_id`、`flow_run_id`、`command_id` 不能互相打架。
  - 用 `wire_command_id` 查回 `client_command_id`。
  - 终态 `flow_task` 不被旧事件改回去。旧命令也不能把公开状态改回 `running`。
  - `append_event()`：重复 `event_id` 返回原 cursor，`event_persisted` 仍为真。
  - 然后才 `message.ack()`。
  - 形状不合法且还没落库：`reject(requeue=False)`。落库过程失败：`nack(requeue=True)`。

- Event Store 的去重在哪里？
  - 在 Lua 里。`HGET event_id` 已存在就返回原来的 cursor，`inserted=0`。
  - 不存在才 `XADD`、`HSET`、`EXPIRE`、`PUBLISH`。
  - Pub/Sub 只负责叫醒在线连接。断线之后读的是 Stream。
  - WebSocket 发出去之后没有再向 RabbitMQ 要一次 ACK。

- 前端副作用 claim 管什么？
  - `runWorkflowSideEffectOnce(eventId, scope)` 的键是 `scope:eventId`。
  - 有 `navigator.locks` 时用 `workflow-v2:` 前缀的锁，再看 localStorage 里 24 小时内是否已有这次 claim。
  - effect 抛错会删掉 claim，允许再试。存储坏了时返回 true，宁肯让副作用再跑一次。
  - 积分入账的真正唯一键仍是服务端 `credits_inout_record.idempotency_key`。
  - 节点变色不走这把 claim。

## 调度锁与 Agent

- 维护调度的 Redis 锁管什么？
  - 每种维护命令一把 `opencreator:flow_maintenance_scheduler:{command}`。
  - `SET key instance_id EX (interval - 1) NX`。拿到锁的实例才把命令推进 `flow_maintenance`。
  - 这把锁避免多实例同时塞同一类扫描。
  - 扫描内部还要靠 Inbox redelivery lease、Outbox publish lease 和节点 CAS。
  - `FLOW_MAINTENANCE_SCHEDULER_ENABLED` 关掉之后，lease 和唯一索引仍在，只是没有人周期重投。

- Agent 往 `run_flow` 投消息，会不会写画布 Inbox？
  - 不会。
  - Agent 的 `task_publisher.run_flow` 可以 `publish()` 到同一个队列，函数本身不执行 DAG。
  - Agent 不写 `flow_command_inbox`，也不写画布 Outbox。
  - Agent 自己的 run 锁、checkpoint 和 `ResumeWindowExpiredError` 在 `RedisRunStore`。它和画布 WebSocket 的 cursor 不是同一把 Redis 键。

## NovelComic 迁移

- 搬这组时最小要交付什么？
  - 前端 journal 在超时后复用 `command_id`，确定性 4xx 才放弃。
  - Publisher 派发前有 `pending / dispatching` lease，发出去的是 `wire_command_id`。
  - Consumer 在 start、continue、cancel 之前 `claim_command()`。相同身份不再执行，身份变化标成 conflict。
  - 节点 `transition_status()` 带 `from_statuses`。resume 锁释放时核对 token。
  - 事件先有稳定 `event_id` 和 Outbox 行，再发 RabbitMQ。
  - Publisher 先 `append_event()`，后 `message.ack()`。重复 `event_id` 也要能 ACK。
  - 前端非 UI 副作用按 `event_id + scope` claim。
  - AI 阶段队列和画布 Outbox 分开。callback header 里的幂等键每次新建。
  - Agent 的 run 锁和 SSE 恢复不写进 `flow_command_inbox`。

- 什么不算这组做完？
  - 只做 Redis Stream。
  - 只做一张 Outbox 表。
  - 只在前端防双击。
  - 状态更新和 Outbox 插入现码也不是一个 Mongo 事务，终态缺口要留给下一组补偿扫描。

## 面试短答

- 一句话讲这组？
  - 命令用 `command_id` 和 Inbox lease 承认一次副作用，事件用稳定 `event_id` 和 Outbox 至少投递一次，Publisher 在 Event Store 落盘之后才 ACK RabbitMQ。

- 一句话讲为什么 Stream ACK 不等于命令做完？
  - Stream 只确认运输，Inbox 的 `mark_completed(lease_token)` 才确认这把命令的副作用。

- 一句话讲为什么发出去还可能再投一次？
  - 发送成功和标 `sent` 是两步。lease 对不上时下一轮仍用同一个 `event_id` 再投，Event Store 回到原 cursor。

- 一句话讲 NovelComic 迁移重点？
  - claim 写在副作用前面，ACK 写在持久化后面。不要先打开 RabbitMQ 自动 ACK，再回头补 Event Store。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 前端 `settleWorkflowCommand()` 在超时、网络错误和 5xx 时留着 journal，确定性 4xx 才 abandon。成功收下后清掉这把 id。
  - Publisher `_claim_command()` 只领到期的 `pending` 或到期的 `dispatching`。发出去的 `command_id` 是 `wire_command_id`。失败把 `dispatch_state` 写成 `pending_retry`。
  - Consumer 在 start、continue、cancel 之前 `claim_command()`。相同身份 `claimed=false`，身份变化 `conflict=true`，后面的初始化不执行。
  - `mark_completed()` / `mark_failed()` 都带 `lease_token`。失败清掉 `expires_at`。过期命令可以 `claim_due_redelivery()`，重投仍是原来的 `command_id`。
  - start 锁被占住且还没有 durable run 时抛错，Inbox 标 failed。已经 `start_initialized` 则直接返回。半截 run 会接着铺节点。
  - `transition_status()` 带 `from_statuses`。`requeue_orphaned_execution()` 用 plan token 和 claim token 做 CAS，`result_id` 留在节点上。
  - resume 锁是 `opencreator:flow_resume_lock:{run_id}`，TTL 300 秒，释放前核对 token。
  - AI `createOrGet` 按 `idempotency_key` 返回已有任务。callback 每次新建 `x-oc-idempotency-key`，并带 `x-oc-signature`。
  - Finalizer 先把 `finalize_status` 收成 `running`，认领失败就停。
  - Outbox 用 `wfe_` 稳定 `event_id` 和 publish lease。发出去但没标上 `sent` 时打 warning，下一轮仍用原 `event_id`。
  - Publisher `workflow_v2_mq_callback()` 先 `append_event()`，再更新更晚的 cursor，最后 `ack()`。形状不合法且未落库则 reject 且不重入队。落库失败则 nack 并重入队。重复 `event_id` 返回原 cursor 后仍然 ACK。终态 `flow_task` 不被旧事件改回去。
  - 前端 `runWorkflowSideEffectOnce()` 按 `scope:eventId` claim。effect 失败会释放 claim。
  - 维护调度锁是 `opencreator:flow_maintenance_scheduler:{command}`，可以用配置关掉。
  - Agent 会把消息写进 `run_flow`，不写 `flow_command_inbox`。自己的 session run 锁和 `ResumeWindowExpiredError` 在 `RedisRunStore`。

- 当前实现能不能算本章主交付完成？
  - 可以算本章主交付完成。
  - 因为命令 lease、Inbox、节点 CAS、Outbox lease、Event Store 去重和 ACK 顺序都在副作用前面或落盘后面。
  - 这不等于状态更新和 Outbox 插入已经是一个 Mongo 事务。那条缺口留给清扫补偿。

- 当前测试覆盖了哪些本章风险？
  - 同一 payload 不会被 Inbox 认领两次，身份变化标成 conflict。过期 processing lease 可以再领。错误 lease 不能完成，失败会清掉 `expires_at`。
  - Publisher 派发 claim 按用户收窄，两个 dispatcher 只有一个能领到。Redis 失败后重试仍是原来的 `command_id`。
  - MQ 回调先落事件再 ACK。重复 `event_id` 不产生第二条 Stream 记录。`append_event` 失败时 nack，畸形消息 reject 且不落库。终态和 `cancel_requested` 不被旧事件改回去。
  - start 锁被占住且没有 run 时不会把 Inbox 标完成。resume 锁 TTL 使用配置值。
  - 到期 Outbox 重放保持原来的 `event_id`。
  - AI 重复 `idempotency_key` 返回 existing。两次 callback 的 `x-oc-idempotency-key` 不同。
  - 前端同一 `event_id + scope` 第二次跳过；effect 失败后可以再试。
  - 关掉维护调度后不再塞扫描命令。Agent 拿不到别人的 session run 锁。

- 和 OpenCreator 现码相比，还要单独记住哪些差别？
  - Event Store 在线键是 `workflow:v2:events:{flow_task_id}` 和 `workflow:v2:event-cursors:{flow_task_id}`。OpenCreator 写的是 `opencreator:wf:{flow_task_id}:events` 和 `event_ids`。去重仍在 Lua 里，先看 `event_id` 再 `XADD`。
  - 没有 Redis client 时，Event Store 还会 upsert Mongo `workflow_events`。在线 replay 仍走 Redis。
  - OpenCreator 在 ACK 之后打点 `flow.v2_mq_ack_without_event_persist`。NovelComic 目前没有这颗零值指标。
  - Agent 的 `task_publisher` 会真正 `XADD` 到 `run_flow`。它仍然不写画布 Inbox 和 Outbox。

- 如果同一条命令做了两次副作用，当前应该怎么排查？
  - 先看第二次是不是新的 `command_id`。浏览器丢了 journal，下一次点击会生成新命令。
  - 再看 Inbox 是否 `claimed=true`。`conflict=true` 时不应该执行。
  - 再看完成更新是否带了原来的 `lease_token`。token 对不上时，完成写不进去，另一轮可能接走。
  - 节点侧看 `transition_status` 的 `matched_count`，以及 `execution_claim_token` 是否还是这次提交的那把。

- 如果浏览器看到同一条事件两次，当前应该怎么排查？
  - 先看两次的 `event_id` 是否相同。相同则是至少一次投递，Event Store 应返回原 cursor。
  - 再看 Outbox 是否发出后没标上 `sent`。lease 丢失时会再投，逻辑事件仍是同一条。
  - 积分和统计应走 `runWorkflowSideEffectOnce`。节点变色可以再次应用，不走这把 claim。

- 什么时候才算本章完整验收？
  - 同一 `command_id` 加同一 payload：Inbox 只 claimed 一次。
  - 同一 `command_id` 加不同 payload：conflict，不执行。
  - 节点 CAS 失败的一方不再提交模型。
  - 同一 `event_id` 重投：Event Store 返回原 cursor，然后 ACK。
  - 发送成功但没标 `sent`：靠 `event_id` 收成一次逻辑事件。
  - 前端同一 `event_id` 的积分副作用只执行一次。
  - AI callback 的新 idempotency header 不会单独被当成业务去重键。
