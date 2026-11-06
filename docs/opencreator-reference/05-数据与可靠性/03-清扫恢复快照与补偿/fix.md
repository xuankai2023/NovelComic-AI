# 清扫、恢复、快照与补偿：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-consumer`、`opencreator-publisher`。NovelComic 看同名的 `novelcomic-*`。

不在这一份：Inbox 重投的哈希和 `redelivery_payload`、`run_flow` 这一次结束就 XACK，已经写在队列第 1 节。`flow_resume` 入队、`recover_running_flows()` 只匹配当前 `flow_resume_queue`、cancel 收成 `stopped`、`claim_finishing` / `complete_finishing` 的认领，已经写在队列第 2 节。Outbox 扁平字段和 v2 队列声明已经写在队列第 3 节。`run_finalize_async()` 的认领和按 `invocation_id` 写 `done` / `failed`，已经写在队列第 5 节。`replay_pending_callbacks()` 的 `parse_callback`，以及 `consumer-callback` 的重试窗和 DLQ，已经写在 AI Webhook。浏览器去重、`resume_ready.status`、刷新时把节点画回去，已经写在可恢复 WebSocket。`queue_usage_once()` 和回滚认领已经写在积分账本第 16 节。正常执行时 `llm_model_ready` 的顺序已经写在亮灯第 3 节。

# 已经对齐，不要重写

这些路径对过现码，认领和扫描结果已经相同。差的是类放在哪个文件、日志文案、funboost 还是自己的 Stream 循环。

- 八类命令都进 `handle_maintenance()`。`replay_failed_outbox_events` 和 `replay_due_outbox_events` 是同一个函数。未知 command 只打 warning，不写库
- 调度间隔：Inbox 重投 `FLOW_COMMAND_INBOX_SWEEP_INTERVAL_SECONDS` 默认 10 秒，running 恢复 `FLOW_RECOVER_RUNNING_INTERVAL_SECONDS` 默认 300 秒，其余 `FLOW_MAINTENANCE_INTERVAL_SECONDS` 默认 60 秒。循环每 10 秒醒一次。锁键 `opencreator:flow_maintenance_scheduler:{command}`，`SET NX`，过期 `max(interval - 1, 1)`。没拿到锁也把这轮的 `last_run` 拨过去。`FLOW_MAINTENANCE_SCHEDULER_ENABLED=false` 时不起循环。`flow_maintenance` 这条流处理完就确认，包含抛错。消费组保持 `novelcomic_consumer_group`
- `redeliver_due_workflow_commands()` 用当初的 `redelivery_payload` 再推进 `run_flow`，不新造 `command_id`。缺 payload 或 lease token 时 `mark_redelivery_failed()`。条数默认 `FLOW_COMMAND_INBOX_REDELIVERY_LIMIT`（50）。payload 里有哪些字段，按队列第 1 节
- `mark_timed_out_invocations()` 的查询和错误对象已经相同：`execution_mode=webhook`，`status` 是 `submitting` 或 `running`，`updated_at` 早于 `WEBHOOK_CALLBACK_TIMEOUT_SECONDS`（1800 秒）。`vendor=opencreator_ai` 的错误带来源 `oc-ai-worker`、阶段 `callback_timeout` 和 `OC_AI_WORKER_TIMEOUT_ERROR_CODE`。其他厂商是 `webhook callback timeout`。`complete(status=timeout)` 落库时把 `result` 收成空对象，写在第 5 节
- `recover_orphaned_planned_nodes()`：活跃、`running`、有 `execution_plans`、`execution_plan_token`、`execution_claim_token`、`started_at`，并且 `started_at` 不晚于 `FLOW_RUNNING_NODE_ORPHAN_SECONDS`（300 秒）。`expected_result_ids` 里还有没落成 invocation 的 `result_id` 才 CAS。CAS 把状态收成 `queued`，清掉 `execution_claim_token` 和 `execution_claimed_at`，`execution_plans` 和 `expected_result_ids` 留着。CAS 失败的节点不进返回列表。没有 `execution_plans` 的节点不进这条重排
- `recover_running_flows()` 仍跳过 v2 且 `start_initialized` 不是真的 run。已初始化的 v2 先跑孤儿重排。`pending_resume`、刚重排成功、`ready_nodes()` 且 `mark_pending_resume(true)` 没有返回 false、`all_terminal()` 这四种才返回 `run_id`。这个方法自己不调用 `handle_resume`。查询里多匹配空的 `flow_resume_queue`，以及维护循环里直接 `await handle_resume()`，已经写在队列第 2 节
- `recover_stuck_finalize()` 的截止就是代码里的 60 秒：`finalize_status` 是 `pending` 或 `failed` 且 `updated_at` 早于 60 秒，或 `finalize_status=running` 且 `finalize_started_at` 早于 60 秒。`running` 那一支 `force=true`。条数是 `PENDING_DEDUCTION_RECONCILE_LIMIT`（100）。不要把 60 秒改成 300 秒。OpenCreator 的 `PENDING_DEDUCTION_RECONCILE_AFTER_SECONDS` 没有人读，不要加这条配置
- `reconcile_pending_deductions()` 的查询已经相同：终态是 `success` / `failed` / `timeout`，成功看 `usage_status` / `result_write_status` / `model_status_event_status`，失败和超时看 `rollback_status` / `result_write_status` / `model_status_event_status`。`usage_v2` 里 `deduction_status=deducted` 时先 `mark_usage_confirmed_by_deduction_id()`。条数默认 100
- `replay_due_outbox_events()` 把 limit 交给 `replay_due_events()`，默认 `FLOW_EVENT_OUTBOX_REPLAY_LIMIT`（100），仍用原来的 `event_id`
- snapshot 四次读：`flow_task`、按 `updated_at` 最新的 `flow_run_state`、按 `node_id` 排序的 `flow_node_state`、`status=sent` 里按 `created_at` 最后一条 outbox。两个头都没有就返回空。返回体 `protocol_version=2`，带 `flow_task_id`、`flow_run_id`、`status`、`last_event_id` 和这三份原文。没有 Mongo 事务。`ObjectId` 和日期收成字符串
- `GET /api/internal/workflow/{flow_task_id}/snapshot`。没配 `INTERNAL_API_KEY` 是 503，缺头、Base64 解不开、`compare_digest` 失败是 401。找不到是 404，`detail` 是 `workflow snapshot not found`。头是 `base64(INTERNAL_API_KEY)`，没有 `Bearer`
- Publisher 先蓝后绿，超时 5 秒。空地址丢掉，重复地址只留一次。404 试下一个。不是对象、`flow_task_id` 不一致、`protocol_version` 不是 2，记 `last_error` 再试下一个。都失败抛 `WorkflowSnapshotUnavailable`。先拿到合格 JSON 的那一侧就返回
- Agent `ensure_resume_available()` 在 `last_event_id` 早于流里最早一条时抛 `ResumeWindowExpiredError`，带 `run_id`、`last_event_id`、`earliest_event_id`。`0-0` 和空 id 直接返回。`normalize_request_workflow_snapshot()` 仍只校验请求里的 `schema_version`、`snapshot_hash`、`captured_at_utc_ms`、`nodes` / `edges` 和 `flow_id`。这两处都不调用 `FlowRecoveryService`，也不请求内部 snapshot
- AI 手工重投的 job id 仍是 `callback-replay-{aiTaskId}-{timestamp}`，队列名 `consumer-callback`，job 名 `deliver`，`attempts=5`，body 是 `ai_task_id` 和 `enqueued_at`。脚本不写节点状态。没有参数时保持报错。不要把 OpenCreator 脚本里的默认 `task_` 列表抄过来

# 1. 终态补偿只认 `success` / `failed` / `stopped`

做完要达到：`reconcile_terminal_flow_events()` 只查

```text
protocol_version = 2
status ∈ success / failed / stopped
terminal_event_outbox_recorded ≠ true
按 updated_at 升序
条数默认 FLOW_TERMINAL_EVENT_RECONCILE_LIMIT（100）
```

缺 `run_id` 或 `flow_task_id` 的行跳过。`stopped` 发 `flow_killed`。`success` 和 `failed` 发 `finish_flow`，事件上的 `status` 就是库里的这个值。`event_id` 仍是 `stable_event_id(event_name, run_id)`。发布之后 `mark_terminal_event_outbox_recorded(run_id, event_id)`。不补 `node_status`。

`flow_run_state.status` 由 finish 写成上面这三个字。活跃节点里有 `failed` 或 `stopped` 时，`complete_finishing` 的 status 是 `failed`，事件是 `finish_flow`。否则是 `success`，事件仍是 `finish_flow`。只有 run 自己的 status 是 `stopped` 才发 `flow_killed`。`flow_killed` 上不带 `status`。

`complete_finishing` 成功之后、发布 `finish_flow` 之前，把这次 run 的节点输出写进 `flow_task.result`：

```text
跳过 is_active 为 false 的节点
每个 node_id → 该节点 outputs，再用该节点自己的 selected_outputs 覆盖同名键
result.status = fail     活跃节点里有 failed 或 stopped
result.status = success  否则
```

更新条件是 `user_id` 加 `flow_task_id`。`protocol_version` 为 2 时这一笔不写 `flow_task.status`。不是 2 时，同一笔把 `flow_task.status` 写成上面的 `fail` 或 `success`。v2 的公开状态仍由队列第 4 节从事件收。终态扫描只补事件，不补这份 `result`。

发送用队列第 3 节改过的 `publish()`。队列第 2 节已经负责 `claim_finishing`、`complete_finishing` 的认领，以及正常发布成功后立刻写 `terminal_event_outbox_recorded`。这一节不改认领。改写下的 status 字、上面这份 `flow_task.result`，以及扫描按这三个字补还没写上标记的行。

`completed` 和 `killed` 不进这张查询。公开的 `flow_task.status` 仍由 Publisher 从事件收成 `completed` / `failed` / `killed`，那是队列第 4 节。

## 现在

查询的 `status` 是 `completed`、`failed`、`killed`、`stopped`、`success`。`killed` 和 `stopped` 都发 `flow_killed`。其余发 `finish_flow`，payload 里的 `status` 是库里的原字，所以 `completed` 会原样发出去。

`_resume_once()` 在 `all_terminal()` 之后调用 `mark_completed()`，只要当时还是 `running` 就写成 `completed`。活跃节点已经 `failed` 也会收成 `completed`，再补一条 `finish_flow`。这一段不写 `flow_task.result`。cancel 收成 `killed` 的路径在队列第 2 节改成 `stopped`。

`novelcomic-consumer/tests/test_flow_recovery_service.py` 把这张 status 列表和 `completed` / `killed` 锁死了。改完后断言改成只认 `success` / `failed` / `stopped`。

## 改哪些文件

1. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `reconcile_terminal_flow_events()`。对照 OpenCreator 同名方法的查询、`stopped` → `FlowKilledEvent`、另外两种 → `FinishFlowEvent(status=库里的 status)`。
2. `novelcomic-consumer/app/tasks/flow_resume.py` 里结束 run 的那一段。对照 OpenCreator `tasks/flow_resume.py` 的 `_finish_flow()`：`final_status` 在有 `failed` 或 `stopped` 的活跃节点时是 `failed`，否则是 `success`，再交给 `complete_finishing`。不要再调用现在的 `mark_completed()` 把 run 收成 `completed`。`complete_finishing` 成功后对照同函数里的 `export_all_nodes_outputs()` 和 `flow_task` 更新。导出只取活跃节点的 `outputs`，再用该节点 `selected_outputs` 覆盖。不要把 `FlowVariableStateService` 的输入路由整段搬过来。

# 2. 卡住的 Finalizer 走 `run_finalize_async`，一条失败不打断这一轮

做完要达到：`recover_stuck_finalize()` 对查出来的每一条 `await InvocationFinalizer.run_finalize_async(invocation_id, force=...)`。`force` 只在这一行的 `finalize_status` 已经是 `running` 时为真。60 秒的查询条件不变。

`run_finalize_async()` 收尾抛错时写成 `failed` 并返回当前行，不把异常再抛给扫描。这一轮剩下的 invocation 继续。函数本体的认领、信号量和按 `invocation_id` 更新，按队列第 5 节。`replay_pending_callbacks()` 改为调用它，已经写在 Webhook 第 9 节，这里不改解析。

## 现在

扫描调用 `InvocationFinalizer.run_finalize()`。收尾抛错会从 `run_finalize()` 再抛出来。`recover_stuck_finalize()` 没有按行接住，后面的 invocation 这一轮不会再进。维护任务接住这次异常后仍确认这条 `flow_maintenance` 消息，要等下一个 60 秒间隔才再扫。

`run_finalize()` 把 `done` 和 `failed` 都限制在行仍是 `running`。这点和队列第 5 节是同一处，这里只把调用换到 `run_finalize_async()`。

## 改哪些文件

1. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `recover_stuck_finalize()`。对照 OpenCreator 同名方法里对 `InvocationFinalizer.run_finalize_async()` 的调用和 `force`。
2. `novelcomic-consumer/app/services/invocation/invocation_finalizer.py` 的 `run_finalize_async()`。队列第 5 节已经要求这个函数存在，并且失败不向外抛。这一节只保证扫描调到它。

# 3. 扣费补偿先确认，再补结果和 `llm_model_status`

做完要达到：`reconcile_pending_deductions()` 的查询和「已 `deducted` 就先 `mark_usage_confirmed_by_deduction_id()`」保持现在这样。然后一律 `finalize_terminal_invocation()`。这个函数补齐侧写：

```text
success
  result_write_status 还不是 done
    → 写下节点结果，再把 result_write_status 写成 done
  usage_status 已是 confirmed
    → 不再入队用量
  还没 confirmed
    → queue_usage_once()
      账本第 16 节，不在补偿栈里同步写完账
  model_status_event_status 还不是 sent
    → 发 llm_model_status，status=success
    → 再把 model_status_event_status 写成 sent

failed / timeout
  rollback_deduction_once()
    认领规则在账本第 16 节
  result_write_status 还不是 done
    → 写下失败结果，再标 done
  model_status_event_status 还不是 sent
    → 发 llm_model_status，status=failed
    → 再标 sent
  timeout 的模型事件也是 failed，不另造一种 status
```

失败结果从 invocation 上还在的 `result` 摊开，再补 `status=failed`、`error`、`error_msg`、`error_code`，以及 OpenCreator `_attach_public_error_fields()`、`_attach_failure_debug_metadata()` 放进去的字段。超时扫描先把这份 `result` 收成 `{}` 的问题在第 5 节。

`llm_model_status` 的 `event_id` 是：

```text
stable_event_id("llm_model_status", run_id, node_id, result_id, status)
```

发出去的顶层字段按队列第 3 节。然后才做节点聚合。节点已经是终态，不能在没发这条模型事件时把 `model_status_event_status` 写成 `sent`。

`usage_v2` 已经 `deducted` 的成功调用，补偿只把 invocation 标成 confirmed，再补结果和事件。不再扣一次。

## 现在

确认用量之后，`finalize_terminal_invocation()` 在 `usage_status` 还不是 `confirmed` 时直接 `await UsageTask.handle_consume()`。失败路径把 `rollback_status` 写成 `done`，没有 OpenCreator 那次 `rollback_status=running` 的认领。

节点聚合只发 `node_status`。没有 `llm_model_status`。节点 status 已经是 `success`、`failed`、`stopped` 或 `select` 时，同一次更新把 `result_write_status` 和 `model_status_event_status` 都写成完成。模型事件没进 Outbox，下一轮扫描也不再补。

`tests/test_flow_recovery_service.py` 的扣费补偿断言 Outbox 里只有一条 `node_status`。改完后同一条成功调用还要有 `llm_model_status`，`event_id` 用上面的稳定 id，`usage_v2` 仍只有原来的 `deducted` 行。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的 `finalize_terminal_invocation()`。对照 OpenCreator 同名方法里 `_write_node_result()`、`_queue_usage_once()`、`_publish_model_status_event()`、`_rollback_deduction_once()` 的顺序和两个 status 的写入条件。
2. `novelcomic-consumer/app/services/workflow/flow_recovery_service.py` 的 `reconcile_pending_deductions()`。查询和先确认再 `finalize_terminal_invocation()` 保持不变。用量入队和回滚认领不要在这个文件里重写，分别用账本第 16 节的 `queue_usage_once()` 和 `rollback_deduction_once()`。

# 4. snapshot 的 replay 起点取在 fetch 之前

做完要达到：`cursor_is_available` 为假时，先 `latest_cursor()`，再 `WorkflowSnapshotClient.fetch()`。fetch 失败仍发 `resume_error`，`code=RESUME_WINDOW_EXPIRED`，然后 `close 4409`。成功后，后面 replay 的 `after_cursor` 用 fetch 之前记下的那个 cursor。

`flow_snapshot` 仍在 replay 之前。run 已经终态时，仍把 replay 上沿补到最新，再发 `resume_ready`。cursor 还在时仍不拉 snapshot。蓝绿、鉴权、四次读取都保持上面已经对齐的行为。

fetch 期间新写进 Event Store 的事件要落在这段 replay 里。它们来不及出现在 Consumer 那份 snapshot 中。

## 现在

`novelcomic-publisher/app/controller/v2/flow_runs.py` 在 `fetch()` 成功之后才 `latest_cursor()`，并把这个新 cursor 当成 replay 起点。fetch 期间写入的事件早于这个起点，snapshot 里也没有它们。连接上的 `resume_ready` 仍会发出，这批事件不再送给浏览器。

可恢复 WebSocket 那份把「取到 snapshot 再从最新 cursor replay」写成已经对齐。现码的先后和 OpenCreator 不同。这一节只改这个先后。event 去重、`resume_ready.status`、刷新画节点仍按那一份，不要在这里重做。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v2/flow_runs.py` 里 cursor 不可用的分支。对照 OpenCreator `controller/v2/flow_runs.py`：`snapshot_cursor = latest_cursor()` 在 `WorkflowSnapshotClient.fetch()` 之前，成功后 `cursor = snapshot_cursor`。

# 5. 超时收尾留下原来的 `result`

做完要达到：`mark_timed_out_invocations()` 的查询和错误对象保持上面已经对齐的那条。`complete(status=timeout)` 只 `$set` `status=timeout`、`error`、`updated_at`、`finished_at`。不写 `result`，不写 `callback_status`，不写 `callback_error`。然后 `finalize_terminal_invocation()`。

失败结果按第 3 节，从库里原来的 `result` 摊开。模型事件的 `status` 仍是 `failed`。扫描不传 `dedupe_key`。成功收尾仍走现在的 `complete_from_callback()`，那是队列第 5 节，这里不改。

## 现在

`complete()` 在同一次 `$set` 里写 `result: result or {}`。超时扫描不传 `result`，调用上已有的结果被收成 `{}`。同一次还写上 `callback_status=timeout` 和 `callback_error`。第 3 节再拼失败结果时，摊开的是这份空对象。

`tests/test_flow_recovery_service.py` 的 `test_webhook_timeout_uses_oc_ai_error_only_for_opencreator_ai` 只锁错误对象和 `result_id`。改完后，超时前已经写上的 `result` 还在，并且没有 `callback_status`。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的 `complete()`。`timeout` / `failed` 对照 OpenCreator `_complete_failure()` 的 `$set`。查询和错误对象留在 `flow_recovery_service.py` 的 `mark_timed_out_invocations()`，不要改。
