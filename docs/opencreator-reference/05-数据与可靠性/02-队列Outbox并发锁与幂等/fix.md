# 队列、Outbox、并发锁与幂等：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-publisher`、`opencreator-consumer`、`opencreator-ai`、`opencreator-agent`、`opencreator-frontend`。NovelComic 看同名的 `novelcomic-*`。

不在这一份：Mongo `workflow_events` 后备和 Redis Event Store 的 key，已经写在数据集合第 6 节。浏览器帧、cursor 上界已经写在可恢复 WebSocket。`execution_plans` 和节点 `outputs` 已经写在工作流命令第 1 节。`createOrGet` 的集合名和 11000 已经写在 AI 任务契约第 4 节。回调验签、`parse_callback`、`pending_model_callback`、以及 HTTP 入口改调 `schedule_finalize()`，已经写在 AI Webhook 第 9 节。这一份不改那套解析，只补 Finalizer 自己的认领。

# 已经对齐，不要重写

这些路径对过现码，认领结果已经相同。差的是类放在哪个文件、id 用 uuid 还是 nanoid、日志文案。

- 前端 `workflow:v2:pending_commands`：超时、断网、5xx 留着 `command_id`，`400 / 401 / 403 / 404 / 409 / 422` 才 abandon。`runWorkflowSideEffectOnce` 的键是 `scope:eventId`，有 Web Locks 时用 `workflow-v2:` 前缀。effect 抛错会删掉 claim。存储写失败仍执行 effect。节点变色不走这把 claim
- `create_run()`、`continue_run()`、`cancel_run()` 把 `flow_task` 和 `workflow_command` 放进同一个事务，提交之后才派发。`_claim_command()` 只认到期的 `pending`，或到期的 `dispatching`。发出去的 `command_id` 是 `wire_command_id`。失败把命令写回 `pending`，`dispatch_state` 写成 `pending_retry`，并清掉 `expires_at`。`workflow_command_dispatcher_forever()` 按 `WORKFLOW_COMMAND_DISPATCH_INTERVAL_SECONDS`（默认 2 秒）再领。不要改成 funboost
- Inbox 身份是 `command_id + protocol_version + command_type + flow_task_id + flow_run_id + payload_hash`。`payload_hash` 是排序后 JSON 的 SHA-256。相同身份第二次 `claimed=false`。任一身份字段不同是 `conflict=true`，后面的副作用不跑。`mark_completed()` 才写 `expires_at`。`mark_failed()` 写 `next_attempt_at` 并清掉 `expires_at`。两步都带 `lease_token`。redelivery lease 另算
- start 锁键是 `opencreator:flow_start_lock:{run_id}`，`SET NX`，TTL 是 `FLOW_START_LOCK_TTL_SECONDS`（300 秒）。锁被别人拿着且 `flow_run_state` 还不存在：抛错，外面 `mark_failed`。已经 `start_initialized`：直接返回，然后 `mark_completed`。有半截 run：继续铺节点。`init_nodes` 之后再读一次，cancel 已经赢了就走 kill tail，不发 `start_flow`
- `transition_status()` 的条件带 `status ∈ from_statuses`。`claim_planned_execution()` 写入 `execution_claim_token`。`execution_claim_is_current()` 要求节点仍是 `running` 且 token 还是自己的。`requeue_orphaned_execution()` 把过期的 `running` CAS 回 `queued`，`execution_plans` 和 `result_id` 留着。resume 锁键是 `opencreator:flow_resume_lock:{run_id}`，拿不到就返回，释放时先读出现值，等于自己的 token 才删除
- `stable_event_id` 是 canonical JSON 的 SHA-256 前 32 位，前缀 `wfe_`。Outbox 能接住 `pending`、到期的 `failed`、到期的 `publishing`。接住后写成 `publishing`，lease 默认 30 秒。发出去之后按 `publish_lease_token` 标 `sent` 并写 `expires_at`。lease 对不上时打 warning，仍算这次发送成功，下一轮靠同一个 `event_id` 收成一条。`replay_due_events()` 里一条失败标成 `failed` 后继续下一条
- Publisher 先 `append_event()`，重复 `event_id` 返回原 cursor，然后才 `message.ack()`。形状不合法且还没落库：`reject(requeue=False)`。已经开始落库之后失败：`nack(requeue=True)`。Lua 仍是 `HGET` 已有就返回，否则 `XADD → HSET → EXPIRE → PUBLISH`。key 和字段名 `event` 保持现码
- AI 队列名是 `provider-execution`、`artifact-processing`、`consumer-callback`、`consumer-callback-dlq`、`media-face-verification`。`x-oc-idempotency-key` 每次是 `randomUUID:timestamp`。业务去重仍靠 `ai_task.idempotency_key` 和 `ai_callback_delivery (ai_task_id, attempt)`
- Agent `run_flow` 只往 Redis Stream 追加消息，不写 `flow_command_inbox`，也不写 `flow_event_outbox`。SSE 的锁和 `ResumeWindowExpiredError` 留在 `RedisRunStore`。不要改成 funboost 空函数
- 维护调度锁键是 `opencreator:flow_maintenance_scheduler:{command}`，`SET NX`，过期 `max(interval - 1, 1)`。没拿到锁也把这轮的 `last_run` 拨过去。`FLOW_MAINTENANCE_SCHEDULER_ENABLED=false` 时不启动循环。`flow_maintenance` 这条流 `max_retry_times=0`：扫描抛错也 XACK，下一轮靠调度再推一条新消息
- `run_flow` 的 consumer group 仍是 `novelcomic_consumer_group`。intake 心跳键仍是 `opencreator:consumer:heartbeat:{instance_id}`。不要改成 `opencreator_group`，也不要去读 `funboost_hearbeat_queue__str`

# 1. `run_flow` 这一次处理完就 XACK

做完要达到：`FlowStreamWorker` 对一条 Stream 消息，`run_flow()` 返回或抛错之后都 `XACK`。这和 OpenCreator `run_flow` 的 `max_retry_times=0` 一样：运输层这条消息不再留在 pending。副作用没做完时，Inbox 行是 `failed` 或 lease 到期，由 `redeliver_due_workflow_commands` 用原来的 `redelivery_payload` 再 `XADD` 一条新消息。

`claim_command()` 用来做哈希的对象带这些字段：

```text
flow_task_id
flow_run_type
flow_run_id
dag
ws_id
user_selection
start_ids
end_ids
user_id
trace_id
session_id
flow_id
source
locale          normalize_user_locale(locale, default="en")
reply_queue
```

`start_ids` / `end_ids` 缺了就留 `null`，不要收成 `[]`。`sentry_trace`、`sentry_baggage`、`publish_timestamp` 只放进 `redelivery_payload`，不进这把哈希。`redelivery_payload` 还要带上 `command_id` 和 `protocol_version`。

`lease_token` 是空字符串时抛错，不要带着空 token 去 `mark_completed()`。`mark_failed()` / `mark_completed()` 返回 false 时只记 warning，行留给下一轮 redelivery。

## 现在

`run_flow()` 抛错时，`_handle_message()` 在 `XACK` 之前 return。这条消息停在 `novelcomic_consumer_group` 的 pending 里，而读的是 `>`，没有人再领它。Inbox 扫出来的是另一条新消息，旧 pending 一直堆着。

哈希对象没有 `session_id`、`source`，`locale` 没有先规范化，`start_ids` 空值被收成 `[]`。`redelivery_payload` 直接存了整段原始消息。

## 改哪些文件

1. `novelcomic-consumer/app/tasks/flow.py` 的 `FlowTask.run_flow()` 和 `FlowStreamWorker._handle_message()`。对照 OpenCreator `tasks/flow.py` 里 v2 claim 之前组 `command_payload` / `redelivery_payload` 的那一段，以及 `max_retry_times=0` 对应的「这一次结束就确认运输」。consumer group 名字保持 `novelcomic_consumer_group`。
2. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `redeliver_due_workflow_commands()`。重投体仍是当时存下的 `redelivery_payload`，原样再推进 `run_flow`。

# 2. resume 进 `flow_resume`，Inbox 不等它做完

做完要达到：`start_flow` 写进 Outbox 之后，把 `handle_resume` 推进 Redis Stream `flow_resume`（配置项 `flow_resume_queue_name`，默认 `flow_resume`），然后 `mark_start_initialized()`。调用方这时才 `mark_completed()`。resume 自己的锁规则不变。

continue：

```text
库里没有这条 run
  → 抛错，外面 mark_failed
status 不是 running，或已 cancel_requested，或 terminal_owner 是 cancel / finish
  → return，然后 mark_completed
restored_select_to_success 和 already_applied_select_to_success 都是 0
  → return，然后 mark_completed
already_applied_select_to_success > 0
  → 仍入队 resume，不再次改选择
mark_pending_resume() 返回 false
  → 不入队
```

`recover_running_flows()` 的查询只匹配 `flow_resume_queue` 等于当前这个队列名。半截 v2、还没 `start_initialized` 的 run 仍跳过。扫出来的 run id 也是推进 `flow_resume`，不在维护任务里把 `_resume_once()` 跑完。

节点聚合要再推进一次 resume 时，同样只入队。

进程启动时，在现有 `FlowStreamWorker` 旁边再挂一个 `flow_resume` 的消费者，group 仍是 `novelcomic_consumer_group`。这条流也是处理完就 XACK，包含抛错。重试靠 `recover_running_flows` 再入队，加上 resume 锁和节点 CAS。

cancel 比 start 先到、run 还不存在时，写入墓碑：`status=stopped`，`terminal_owner=cancel`，`cancel_tombstone=true`，`cancel_requested=true`。start 的 `init_flow_run` 过滤是 `run_id` 且 `cancel_requested` 不是 true。撞上 `DuplicateKeyError` 就停，不把墓碑改回 running。对已有行只补 `pending_resume` 和 `updated_at`。

cancel 命令看到 run 已经是 `success` / `failed`，或 `terminal_owner` 是 `finish`，就 return，然后 `mark_completed`，不再杀尾。其余情况都走 `_stop_flow_for_kill`，包括刚写下的墓碑。

`_stop_flow_for_kill` 先 `claim_cancellation`。只在 `status` 仍是 running、还没 `cancel_requested`、没有 `terminal_owner`、finish 不在 `in_progress` 时，把 `status` 收成 `stopped`、`terminal_owner` 收成 `cancel`。已经是 stopped 且 `terminal_owner` 是 cancel 的行直接拿回。没拿到就停。拿到之后才把还没终态的活跃节点收成 stopped，发 `flow_killed`，然后 `mark_terminal_event_outbox_recorded`。

finish 先 `claim_finishing`：`status` 仍是 running、没有 `cancel_requested`，并且 `terminal_owner` 空，或 finish 租约超过 60 秒。认领把 `terminal_owner` 写成 `finish`、`finish_status` 写成 `in_progress`。`complete_finishing` 只在这份认领还在、且 cancel 没赢时写下终态。

`mark_pending_resume(true)` 只匹配 `status` 是 running、`cancel_requested` 不是 true、`terminal_owner` 不是 `cancel` 或 `finish`。返回 false 就不入队。`pending=false` 仍无条件清掉。

`_resume_once` 开头、每一轮，以及提交模型之前，查杀停：Redis `opencreator:flow_task:kill:{flow_task_id}` 还在，或这条 run 的 `cancel_requested` 为 true。循环里命中就 `_stop_flow_for_kill` 并 return。提交前命中就抛错，这次不创建调用。Publisher 的 `kill_flow_task` 用 `SETEX` 把这个 key 写成 `1`，TTL 600 秒。

`finish_flow` 和 `flow_killed` 发布成功后立刻 `mark_terminal_event_outbox_recorded`。清扫只补这个标记还没写上的终态，不在这一份重做。

## 现在

`_bootstrap_start()`、continue、`node_aggregation_service._enqueue_resume()`、`recover_running_flows` 的维护循环，都是直接 `await FlowResumeTask.handle_resume()`。start 的 Inbox lease 要盖住整段 resume，包括模型提交。`flow_resume` 有配置、健康检查会 `XLEN`，没有消费者。

continue 在 run 还不存在时什么也不做，然后 `mark_completed()`。这条命令不会再被领。

cancel 只在已有 running 行上打 `cancel_requested`。run 还不存在就当命令做完，随后 start 仍会插入一条 running。杀尾只在返回的 `status` 仍是 running 时做，而且是先停节点，再 `mark_killed` 收成 `killed`。

`init_flow_run` 对已有行也会改写 `pending_resume` 和 `user_selection`。`mark_pending_resume(true)` 只要 `run_id` 在就返回 true。

resume 循环不看杀停标记。`finish_flow` / `flow_killed` 发出后不写 `terminal_event_outbox_recorded`，现有 reconcile 会把每次正常结束再发一遍。

`recover_running_flows()` 还会匹配没有 `flow_resume_queue` 的 run。

## 改哪些文件

1. `novelcomic-consumer/app/tasks/flow_resume.py`。加一个和 `FlowStreamWorker` 同样的 Stream 消费，队列名用 `flow_resume_queue_name`。对照 OpenCreator `tasks/flow_resume.py` 的入队时机、`_resume_once()` 里的杀停检查、`_stop_flow_for_kill()` 先认领再发 `flow_killed`，以及 `finish_flow` / `flow_killed` 发出后的 `mark_terminal_event_outbox_recorded`。锁释放仍只在自己的 token 还在时删除。不要把 funboost 的 `@boost` 搬过来。
2. `novelcomic-consumer/app/tasks/flow.py` 的 `_bootstrap_start()`、continue 和 cancel 分支。对照 OpenCreator `tasks/flow.py` 里 `handle_resume.aio_push`、continue 在入队前的判断，以及 cancel 在 `success` / `failed` 或 `terminal_owner=finish` 时不再杀尾。
3. `novelcomic-consumer/app/services/workflow/flow_run_state_service.py` 的 `request_cancel()`、`init_flow_run()`、`mark_pending_resume()`。对照 OpenCreator 同名文件的墓碑、`cancel_requested != true` 过滤、`claim_cancellation()`、`claim_finishing()`、`complete_finishing()`。
4. `novelcomic-publisher/app/services/flow.py`。补上 `kill_flow_task()`，key 是 `opencreator:flow_task:kill:{flow_task_id}`。
5. `novelcomic-consumer/app/services/workflow/node_aggregation_service.py` 的 `_enqueue_resume()`。
6. `novelcomic-consumer/app/tasks/flow_maintenance.py` 里 `recover_running_flows` 之后的循环。
7. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `recover_running_flows()` 查询。对照 OpenCreator 同名方法里 `flow_resume_queue` 那个等值条件。
8. `novelcomic-consumer/app/main.py` 的 `lifespan()`。resume 消费者和 `FlowStreamWorker` 一起启动、一起停。

# 3. Outbox 发扁平事件，v2 结果队列由 Publisher 声明

做完要达到：Outbox 行里 `queue_name` 是结果队列的默认名，`reply_queue` 和 `ws_id` 另存。`payload` 是事件 JSON 字符串。发送时目标队列用 `reply_queue`，没有才用 `queue_name`。

事件本体是扁平的。这些字段在顶层，不包进 `payload`：

```text
event_id
event_type
run_id
flow_task_id
flow_run_id
command_id
protocol_version
trace_id
ws_id
status
node_id
node_outputs
time_stamp
```

`start_flow`、`finish_flow`、`flow_killed`、`node_status` 的字段对照 OpenCreator `tasks/events/flow_events.py` 里对应的事件类，再经 `publish()` 补上 `flow_task_id`、`command_id`、`protocol_version`、`trace_id`。`event_id` 仍用现在的 `stable_event_id(...)`。

发出去的 RabbitMQ 消息在正文里写入 `mq_send_timestamp`。headers 带上有值的 `ws_id`、`event_id`、`flow_task_id`、`flow_run_id`、`command_id`、`protocol_version`。`protocol_version == 2` 时，Consumer 不再 `declare_queue`。发布是 `mandatory=true`。有值时 AMQP `message_id` 用 `event_id`，`correlation_id` 用 `flow_task_id`，`type` 用 `event_type`。

Publisher 声明并消费的 v2 结果队列参数是：

```text
x-single-active-consumer = true
x-dead-letter-exchange = ""
x-dead-letter-routing-key = {v2 队列名}.dlq
```

死信队列名是 `{v2 队列名}.dlq`，durable。队列名仍是现在的 `flow_result.workflow.v2.{app_env}`，由 `v2_result_queue_name()` 决定。本地如果这条队列已经按不带这些参数的方式声明过，先删掉再启动，否则 RabbitMQ 会拒绝再次声明。

`replay_due_events()` 用行里存的 `reply_queue`、`ws_id`、`payload` 再发一次。第一把 lease 还活着或行已经是 `sent` 时，不再发第二次。

## 现在

`publish()` 把业务字段放进 `payload`，RabbitMQ 正文是包了一层的事件对象。`queue_name` 直接写成 `reply_queue`，行上没有单独的 `reply_queue` / `ws_id`。`MessagePublisher.publish()` 每次都 `declare_queue(durable=True)`，不带死信参数，不写 headers，也不是 `mandatory`。没有 `message_id`、`correlation_id`、`type`。

Publisher 的 `workflow_v2_reply_consumer_forever()` 也是 `declare_queue(durable=True)`，没有 single-active-consumer，没有 DLQ。

## 改哪些文件

1. `novelcomic-consumer/app/services/workflow/flow_event_publish_service.py` 的 `publish()`、`_publish_claimed()`。对照 OpenCreator 同名文件：`payload` 存 JSON 字符串，`reply_queue` 和 `ws_id` 分开存，发送目标是 `reply_queue or queue_name`。
2. `novelcomic-consumer/app/database/mq.py` 的 `MessagePublisher.publish()`。对照 OpenCreator `database/mq.py` 的 `publish_message()`：注入 `mq_send_timestamp`、写 headers、v2 队列不再声明。
3. `novelcomic-consumer/app/tasks/flow.py`、`app/tasks/flow_resume.py`、`app/services/workflow/node_aggregation_service.py`、`app/services/workflow/flow_recovery_service.py` 里所有 `FlowEventPublishService.publish()`。对照 OpenCreator 同路径的 `publish(event=...)`，把现在塞进 `payload=` 的 `status` / `node_id` / `outputs` 放到事件顶层。`node_outputs` 对上 OpenCreator 的字段名。
4. `novelcomic-publisher/app/database/mq.py` 的 `workflow_v2_reply_consumer_forever()`。对照 OpenCreator `start_workflow_v2_mq_consumer()` 的 `V2_REPLY_QUEUE_ARGUMENTS` 和 DLQ 声明。队列名继续用现有的 `V2_REPLY_QUEUE_NAME`。

# 4. 公开状态只认事件顶层，终态不被派发失败改回去

做完要达到：`workflow_v2_mq_callback()` 用三处对齐同一个 `flow_task_id`：header、正文、以及 `ws_id` 以 `v2:` 开头时冒号后面的那段。三处都有值时必须相同。

状态只读事件顶层的 `status`。`finish_flow` 在 `append_event()` 之前把权威状态写回 `event["status"]`，replay 读到的就是这份：

```text
flow_killed                         → killed
workflow_error                      → failed
start_flow                          → running
node_status 且 status=select        → waiting_for_selection
finish_flow 且 status 是 fail / failed / error / stopped → failed
finish_flow 且 status 是 success / completed            → completed
finish_flow 的其他 status
  当前公开状态已是 fail / failed / error → failed
  否则                                 → completed
flow_status                         按 OpenCreator 同名分支
```

节点自己的 `failed` 不能把 `flow_task.status` 收成终态。已经是 `completed` / `failed` / `killed` 的 run 保持终态。`cancel_requested` 只接受终态事件把它推走。旧 `command_id` 不能把公开状态改回 `running` 或 `waiting_for_selection`。

`workflow_error` 在落库前先走 OpenCreator `normalize_upstream_workflow_error_event()`：`event_type` 收成 `workflow_error`，`status` 收成 `failed`。

同一次 `flow_task` 更新再写 `current_flow_run_id`，值和这次事件的 `flow_run_id` 相同。`last_event_cursor` 仍只接受更晚的 cursor。

ACK 之后打两个计数：`flow.v2_mq_ack_total` 加 1，`flow.v2_mq_ack_without_event_persist` 在这条成功路径上加 0。`event_persisted` 在 `append_event()` 返回后就是真，重复 `event_id` 也一样。

派发失败时，`_finish_claim()` 只在 `flow_task.status` 还不是 `killed` 时把 `dispatch_state` 写成 `pending_retry`。成功派发时同时写上 `current_flow_run_id`。

非 cancel 派发只在公开状态是 `cancel_requested` 或 `killed` 时跳过。入队用这条命令自己的 `command["flow_run_id"]`。

## 现在

`_status_from_event()` 会读 `payload.status`。`finish_flow` 空状态直接收成 `completed`，其他未知状态原样写进 `flow_task.status`。没有把权威状态写回事件。`flow_task` 更新不写 `current_flow_run_id`。`flow_task_id` 不从 `v2:` 的 `ws_id` 补。

`_finish_claim()` 用 `status != cancelled` 当过滤。一条已经 `killed` 的 run，派发失败仍会被写成 `pending_retry`。非 cancel 的跳过集合里还有 `cancelled`。入队用的是 run 上的 `flow_run_id`，不是这条命令的 `flow_run_id`。

ACK 之后没有 `flow.v2_mq_ack_total` 和 `flow.v2_mq_ack_without_event_persist`。

## 改哪些文件

1. `novelcomic-publisher/app/database/mq.py` 的 `_status_from_event()`、`_authoritative_status()`、`workflow_v2_mq_callback()`。对照 OpenCreator `database/mq.py` 里 `_workflow_v2_flow_task_id()`、`_workflow_v2_authoritative_status()` 和 `workflow_v2_mq_callback()` 写回 `event["status"]`、`current_flow_run_id`、以及 ACK 之后那两个计数的位置。错误事件对照 `utils/flow_ws_errors.py` 的 `normalize_upstream_workflow_error_event()`。
2. `novelcomic-publisher/app/services/workflow_runs_v2.py` 的 `_dispatch_claimed()` 和 `_finish_claim()`。对照 OpenCreator 同名方法里 `current_flow_run_id`，以及失败更新的 `status != killed`。

# 5. Finalizer 先认领，再在请求外面跑完

做完要达到：`schedule_finalize(invocation_id)` 在当前事件循环里创建任务并返回 true。没有事件循环时返回 false，不在 HTTP 请求里把收尾跑完。并发上限是 `CALLBACK_FINALIZE_CONCURRENCY`，默认 50，按当前 event loop 一把信号量。

`run_finalize_async()` 的认领条件：

```text
force=false    finalize_status ∈ pending, failed
force=true     再加 running
认领成功       finalize_status=running，finalize_attempt_count + 1，清掉 finalize_error
matched 为 0   停，不写 results
```

认领之后按 `callback_status` 收尾：`success` 走成功，`timeout` 走超时，其余走失败。收尾写完按 `invocation_id` 把 `finalize_status` 写成 `done` 并记下 `finalize_finished_at`，不再要求行仍是 `running`。收尾抛错同样只按 `invocation_id` 把 `finalize_status` 写成 `failed`，带上 `finalize_error`，然后返回当前行，不把异常再抛回调度器。

进程退出时 `drain_background_tasks()` 最多等 `CALLBACK_FINALIZE_SHUTDOWN_TIMEOUT_SECONDS`（默认 15 秒）。没跑完的只 warning。

HTTP 入口仍按 Webhook 第 9 节调用 `schedule_finalize()`。`finalize_scheduled` 表示任务已经挂上，不表示 `finalize_status` 已经是 `done`。维护任务补跑挂起回调时调用 `run_finalize_async()`，把这一次等完。那条路径已经写在 Webhook 第 9 节，这里把函数补上。

## 现在

`POST /callbacks/models/{vendor}` 在请求里 `await InvocationFinalizer.run_finalize()`。`finalize_scheduled` 要等 `finalize_status == done` 才是 true。没有 `schedule_finalize()`，没有信号量，也没有退出时的 drain。

`run_finalize()` 在 `force=true` 时已经会认领 `running`。成功写成 `done` 和失败写成 `failed` 都要求行仍是 `running`。OpenCreator 这两次更新都只按 `invocation_id`。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/invocation_finalizer.py`。对照 OpenCreator 同名文件的 `schedule_finalize()`、`drain_background_tasks()`、`run_finalize_async()`。认领集合对照 `invocation_state_machine.py` 的 `finalize_claim_statuses()`。收尾仍调用现在的完成函数，把结果、用量和节点聚合留在原处。
2. `novelcomic-consumer/app/config.py`。补上 `callback_finalize_concurrency=50` 和 `callback_finalize_shutdown_timeout_seconds=15`。
3. `novelcomic-consumer/app/main.py` 的 lifespan 退出。对照 OpenCreator `core/register.py` 里 yield 之后的 `drain_background_tasks()`。回调路由本身按 Webhook 第 9 节改，这一节只保证它调到的函数存在。

# 6. 提交超时记成不确定，不新造 result_id

做完要达到：模型提交包在 `asyncio.wait_for(..., WEBHOOK_SUBMIT_TIMEOUT_SECONDS)` 里，默认 30 秒。`asyncio.TimeoutError`，以及 `httpx.TimeoutException` 引起的提交错误，都走 `mark_submit_uncertain`：`status` 保持 `running`，`submit_status=uncertain`，错误可恢复，清掉 `submit_claim_token`。不回滚扣费，不新造 `result_id`，这次调用仍用计划里的那个 id。

创建调用之前再查一次 `execution_claim_is_current`。claim 已经不是自己的，就停，不创建调用。

## 现在

超时只认 `OpenCreatorAISubmitError` 的原因是 `TimeoutError`，或错误文本里带 timeout。没有 `wait_for` 包住整段提交。`mark_submit_uncertain` 不清除 `submit_claim_token`。执行 claim 在 `submit_planned_node()` 开头查一次，创建调用前不再查。

## 改哪些文件

1. `novelcomic-consumer/app/tasks/flow_resume.py` 的提交路径。对照 OpenCreator `tasks/flow_resume.py` 的 `_submit_plan()`：`wait_for`、超时进 `mark_submit_uncertain`、创建调用前再查 execution claim。
2. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的 `mark_submit_uncertain()`。对照 OpenCreator 同名方法里 `$unset submit_claim_token`。
3. `novelcomic-consumer/app/config.py`。补上 `webhook_submit_timeout_seconds=30`。
