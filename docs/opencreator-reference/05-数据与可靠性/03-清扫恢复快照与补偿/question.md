# 清扫、恢复、快照与补偿 question

## 核心概念

- “清扫、恢复、快照与补偿”讲的是什么？
  - 讲的是进程死掉、回调晚到、事件没写进 Outbox 之后，系统怎么把已经认领的工作再推回可继续的状态。
  - 它讲谁来扫、扫到了补哪一步、快照和 cursor 各回答什么。
  - 队列那组已经说明 lease 和 ACK。这里不重写认领规则。

- 先背哪三句话？
  - `claimed` 还不是 `start_initialized`。
  - cursor 补的是漏掉的事件。
  - snapshot 读的是当前状态。

- 恢复分成哪三件事？
  - 维护扫描：Consumer 周期把过期命令、卡住的节点、缺的终态事件、到期 Outbox 再推进去。
  - 执行快照：Publisher 在 cursor 失效时，向 Consumer 要当前 run / node 视图。
  - 浏览器重连：带着 `last_event_cursor` attach，等到 `resume_ready`。
  - AI 可以重投 callback。Agent 有自己的事件窗和请求级画布快照。它们都不执行 Consumer 的 DAG 清扫。

- 为什么补偿不能从 Run 重新开始？
  - 队列那组的每一跳都可能停在中间。
  - 补偿要接回停下的那一跳，沿用原来的 `command_id`、`result_id` 或 `event_id`。
  - 扫描成功只说明补偿动作发出去了。事件要进 Event Store，浏览器要 replay 或吃下 snapshot，用户才看得到。

## 停在哪一跳

- Publisher 派发失败谁来补？
  - `flow_task.dispatch_state = pending_retry` 之后，由 `workflow_command_dispatcher_forever` 每 2 秒用同一把 `command_id` 再 dispatch。
  - 这一跳不进 `flow_maintenance`。

- Inbox 已 claim、run 还没 `start_initialized` 谁来补？
  - `redeliver_due_workflow_commands` 用当初的 `redelivery_payload` 推回 `run_flow`，`command_id` 不变。
  - start 锁还在且库里没有 run：抛错，Inbox 标 failed，等下一轮。
  - 库里有半截 run：继续 `init_nodes`，不新建 `run_id`。
  - `recover_running_flows` 看到未 `start_initialized` 会跳过。这两条扫描不能对调。

- 计划已写入、invocation 还没插齐谁来补？
  - 只处理已经 `start_initialized` 的 v2。
  - `recover_orphaned_planned_nodes` 把过期 RUNNING 节点 CAS 回队列，`expected_result_ids` 不变。
  - 然后 `handle_resume(reason=recover)`。resume 复用 `execution_plans`，不再 `plan_node`。

- 终态 run 缺事件谁来补？
  - `reconcile_terminal_flow_events` 用 `stable_event_id("finish_flow"|"flow_killed", run_id)` 再 publish。
  - 发布后 `mark_terminal_event_outbox_recorded`。
  - 它不补 `node_status`，也不补每一次 invocation。

- 浏览器断线谁来补？
  - cursor 还在：`attach_flow(last_event_cursor)` 之后 replay，不拉 snapshot，再发 `resume_ready`。
  - cursor 已经过期：Publisher 用内部密钥向 Consumer 要 snapshot。成功则先发 `flow_snapshot`，再从 latest replay。失败则 `resume_error`，`code=RESUME_WINDOW_EXPIRED`，`close 4409`。
  - 断开连接不会 cancel。

## 八类维护命令

- `handle_maintenance()` 收哪八类？
  - `redeliver_due_workflow_commands`：过期 Inbox 按原 payload 推回 `run_flow`。
  - `mark_timed_out_invocations`：webhook 调用超时标 `timeout`。
  - `recover_running_flows`：把仍在 running、且可以恢复的 run 再送进 resume。
  - `reconcile_terminal_flow_events`：终态 run 缺 Outbox 事件时补 `finish_flow` / `flow_killed`。
  - `replay_pending_callbacks`：重放还停在 `pending` 的模型回调。
  - `recover_stuck_finalize`：把卡住的 Finalizer 再 claim。
  - `reconcile_pending_deductions`：成功补确认、失败补回滚。
  - `replay_due_outbox_events`：再发布到期 Outbox。
  - `replay_failed_outbox_events` 走同一条 `replay_due_outbox_events()`。未知 command 只打 warning。

- 调度间隔为什么不一样？
  - Inbox 重投默认 10 秒一轮，配置是 `FLOW_COMMAND_INBOX_SWEEP_INTERVAL_SECONDS`。
  - running 恢复默认 300 秒一轮，配置是 `FLOW_RECOVER_RUNNING_INTERVAL_SECONDS`。
  - 其余默认 60 秒一轮，配置是 `FLOW_MAINTENANCE_INTERVAL_SECONDS`。
  - 循环本身每 10 秒醒一次，没到间隔就跳过。
  - 每种 command 还要先拿到 `opencreator:flow_maintenance_scheduler:{command}`。没拿到锁，这一轮不 push。
  - `FLOW_MAINTENANCE_SCHEDULER_ENABLED` 为假时，循环不起。lease 和唯一索引仍在。

- 为什么有维护任务也不表示所有窗口共用一个 RTO？
  - 命令重投、节点孤儿、webhook 超时、Finalizer 卡住用的是不同秒数。
  - webhook 默认 1800 秒。孤儿计划默认 300 秒。Finalizer 卡住在代码里写成 60 秒，不是 300 秒那条配置。

## 每一类补什么

- Inbox 重投会新造 `command_id` 吗？
  - 不会。
  - `claim_due_redelivery()` 取出 `redelivery_payload` 和 `redelivery_lease_token`，再 `aio_push`。
  - 缺 payload 或 lease token 时 `mark_redelivery_failed()`。
  - 推回去之后，Inbox 仍按同一身份和 `payload_hash` 决定认不认。

- `recover_running_flows()` 为什么要看 `start_initialized`？
  - 查询只收 `status=running`，并且 v2 必须已经 `start_initialized=true`。非 v2 仍可进入这条扫描。
  - 循环里再跳过一次：`protocol_version==2` 且 `start_initialized` 仍为假，直接打日志返回。
  - 命令可以已经 `claimed`，节点表还没铺完。这种 run 不能当成可 resume 的 running。

- 孤儿计划怎么避免提交两次？
  - 节点要是活跃的 `RUNNING`，并且已经有 `execution_plans`、`execution_plan_token`、`execution_claim_token`、`started_at`。
  - `started_at` 早于 `FLOW_RUNNING_NODE_ORPHAN_SECONDS`。
  - `expected_result_ids` 里还有没落成 invocation 的 `result_id`。
  - `requeue_orphaned_execution()` 让旧 claim token 失效，计划里的 `result_id` 仍留着。
  - invocation 的唯一键挡住恢复和迟到的旧 worker 各提交一次。
  - 没有 `execution_plans` 的旧节点不进这条重排。

- 终态补偿补的是哪一条事件？
  - 只处理 v2 的终态 run，并且 `terminal_event_outbox_recorded` 不是 true。
  - `stopped` 补 `flow_killed`，`success` / `failed` 补 `finish_flow`。
  - 同一 run、同一事件名，补多少次都是同一个 `event_id`。
  - 这是状态和 Outbox 不在一个事务时的窗口。节点过程事件如果没进 Outbox，这条扫描不会逐条重造。

- 回调 2xx 之后还要扫什么？
  - 早到回调已经 `accepted` 且 `matched=false`，行停在 `pending_model_callback.status=pending`。
  - `replay_pending_callbacks()` 默认最多 100 条，`parse_callback` 之后走 `handle_callback_fast()`。需要收尾就 `run_finalize_async()`。成功标 `replayed`，异常标 `failed`。
  - `(vendor, external_task_id)` 不是唯一索引。并发早到可以有多行，重放按行处理。
  - `recover_stuck_finalize()` 再推 `pending` / `failed` 超过 60 秒，或 `running` 的 `finalize_started_at` 超过 60 秒。`running` 这一支 `force=true`。
  - HTTP 已经 2xx，只要 `finalize_status` 还不是 `done`，这条扫描仍会再推一次。

- 扣费补偿看哪几个标志？
  - invocation 已经是 `success`、`failed` 或 `timeout`，但 `usage_status`、`rollback_status`、`result_write_status`、`model_status_event_status` 还有空缺。
  - `usage_v2` 里已经 `deduction_status=deducted` 的，先 `mark_usage_confirmed_by_deduction_id()`，再 `finalize_terminal_invocation()`。
  - 账本已经扣过，和 invocation 上写成 confirmed，是两步。补偿把它们再对齐，不因为账本已经扣过就再扣一次。

- 到期 Outbox 再发布时换 `event_id` 吗？
  - 不换。
  - claim 的是 `pending`、到期的 `failed`、到期的 `publishing`。
  - `sent` 只表示 broker 投递这一步做过了。Publisher 还要 `append_event()` 成功才 ACK。
  - 补偿把消息再送上 RabbitMQ，不代替 Event Store，也不代替浏览器 replay。

## snapshot 与浏览器

- snapshot 是事务快照吗？
  - 不是。
  - `get_snapshot()` 分四次查：`flow_task`、按 `updated_at` 最新的 `flow_run_state`、按 `node_id` 排序的 `flow_node_state`、最后一条 `status=sent` 的 Outbox。
  - 没有 Mongo snapshot transaction。读的过程中节点状态可以变。
  - `flow_task` 和 `flow_run` 都没有时返回空。有一个就组装 `protocol_version=2` 的视图。
  - `status` 优先用 run，否则用 task。`last_event_id` 来自最后一条 sent 事件。

- 内部路由怎么鉴权？
  - `GET /api/internal/workflow/{flow_task_id}/snapshot`。
  - `Authorization` 是 `Base64(INTERNAL_API_KEY)`，没有 `Bearer` 前缀。
  - 用 `compare_digest` 比对解码后的密钥。没配密钥返回 503，缺头或密钥不对返回 401，找不到快照返回 404。

- Publisher 为什么先问 blue 再问 green？
  - `CONSUMER_BLUE_URL` 超时 5 秒。404 再问 `CONSUMER_GREEN_URL`。
  - 其他 HTTP 错误或校验失败记 `last_error`，也试下一个。
  - 两个都没有则抛 `WorkflowSnapshotUnavailable`。
  - 拿到 JSON 之后还要 `flow_task_id` 与请求一致，并且 `protocol_version=2`。
  - 没有多数派，也没有版本号仲裁。先返回合格快照的那一侧就被采用。

- cursor 失效之后 WebSocket 发什么？
  - `cursor_is_available()` 为假时才拉 snapshot。
  - 失败发送 `resume_error`，`code=RESUME_WINDOW_EXPIRED`，然后 `close(4409)`。
  - 成功把 cursor 换成 `latest_cursor`，先发 `event_type=flow_snapshot`。这条 `event_id` 是 `snapshot-` 加内容哈希前 24 位，不是 Outbox 里的 `wfe_`。
  - 再 replay。终态 run 还会把 replay 上沿补到最新，避免 `resume_ready` 用连接开始时的旧状态盖住已经结束的 run。
  - 最后才发 `resume_ready`。

- 前端什么时候算恢复完成？
  - cursor 在 `sessionStorage` 的 `workflow:v2:cursor:{flowTaskId}`。
  - 普通事件记下 `event_cursor`。`flow_snapshot` 用来认识当前状态。
  - 收到 `resume_ready` 才把这次恢复当成完成，然后接实时事件。
  - 收到 `resume_error` 就停止把这次连接当成已经接上。
  - 关掉页面、断掉 WebSocket，都不会发 cancel。

## AI 与 Agent

- AI 重投 callback 等于节点已经成功吗？
  - 不等于。
  - 自动路径在 BullMQ `consumer-callback`，失败可以进 `consumer-callback-dlq`。
  - 手工脚本把指定 `ai_task_id` 再放进队列，job id 形如 `callback-replay-{aiTaskId}-{timestamp}`。每次运行都是新 job。
  - 脚本跑完只表示任务回到 AI 队列。节点是否 success，要看 Consumer Finalizer 和后面的 Outbox。

- Agent 的画布快照和 Consumer snapshot 是一份吗？
  - 不是。
  - `normalize_request_workflow_snapshot()` 校验请求里带来的画布：`schema_version` 为 1 或 2、有 `snapshot_hash`、有 `captured_at_utc_ms`、`flow_id` 对得上、nodes / edges 是对象列表。
  - 这是给工具看的当前画布。它没有 `flow_run_state`，也不调用 Consumer 的内部快照接口。
  - Agent run 自己的 `ensure_resume_available()` 失败抛 `ResumeWindowExpiredError`。那是 Agent 事件窗，不是画布 cursor。

## NovelComic 迁移

- 搬这组时最小要交付什么？
  - 八类维护命令都进 `handle_maintenance()`，未知命令不执行副作用。
  - 调度按 command 分开间隔，并且可以用开关整个关掉。
  - Inbox 重投使用当初的 `redelivery_payload`，不新造 `command_id`。
  - v2 且没有 `start_initialized` 的 running run 会被跳过。
  - 带 `execution_plans` 的过期 RUNNING 节点按原 `result_id` CAS 回队列。
  - 终态补偿只补 `finish_flow` / `flow_killed`，`event_id` 稳定。
  - pending callback、卡住的 Finalizer、未完成的扣费确认各有一条扫描。
  - snapshot 由 Consumer 生成，Publisher 用内部密钥去拉，并校验 `flow_task_id` 和 `protocol_version`。
  - cursor 失效时，要么 `flow_snapshot` 再 replay，要么 `resume_error` 加 4409。
  - 前端以 `resume_ready` 作为恢复完成。断线不触发 cancel。
  - AI replay 脚本和 Agent 画布快照留在各自入口，不写进 `FlowRecoveryService`。

- 什么不算这组做完？
  - 只做定时任务。
  - 只在刷新时重新 POST `/runs`。
  - 只把最后一次 WebSocket 消息留在内存里。

## 面试短答

- 一句话讲这组？
  - Consumer 用八类维护命令把停在半截的命令、计划和事件接回原来的身份；cursor 还在就 replay，cursor 不在就拿当前 snapshot 或明确 4409，前端等到 `resume_ready` 才算恢复完成。

- 一句话讲为什么 claimed 不能直接 resume？
  - Inbox 认领只说明命令被接住了，`start_initialized` 才说明 run 和节点已经铺完，未初始化的 v2 running 要留给命令重投。

- 一句话讲 snapshot 和 cursor 的差别？
  - cursor 补的是 Event Store 里漏掉的事件，snapshot 是四次读取拼出的当前 run / node 视图，不是事件日志。

- 一句话讲 NovelComic 迁移重点？
  - 补偿接回原来的 `command_id`、`result_id`、`event_id`。不要在刷新时再开一条 run，也不要让断线去 cancel。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - `handle_maintenance()` 收齐八类命令。`replay_failed_outbox_events` 和 `replay_due_outbox_events` 走同一条重放。未知命令只 warning。
  - 调度每 10 秒看一轮。Inbox 重投 10 秒，running 恢复 300 秒，其余 60 秒。每种 command 用 `opencreator:flow_maintenance_scheduler:{command}`。开关关掉后不再 push。
  - 维护队列是 `flow_maintenance`，消费组是 `novelcomic_consumer_group`。一条扫描失败会 ACK，同一条 Stream 消息不再重跑，下一轮靠调度再推。
  - Inbox 重投使用原来的 `redelivery_payload`。推送失败 `mark_redelivery_failed()`，不新造 `command_id`。
  - v2 且没有 `start_initialized` 的 running 会被跳过。孤儿计划 CAS 回队列后仍用原来的 `result_id`，没有计划的节点不进重排。
  - 终态补偿用稳定 `event_id` 补 `finish_flow` 或 `flow_killed`，不补 `node_status`。
  - pending callback 走原来的 fast-path 和 Finalizer。卡住的 `running` finalize 超过 60 秒会 `force=true`。扣费补偿先确认已经 deducted 的 usage，再写同一条结果。
  - 到期 Outbox 重放保持原来的 `event_id`。
  - Consumer `get_snapshot()` 四次读取，内部路由用 `Base64(INTERNAL_API_KEY)`，没有 Bearer。没配密钥 503，密钥不对 401，没有快照 404。
  - Publisher 先问 blue，404 再问 green，超时 5 秒，并校验 `flow_task_id` 和 `protocol_version=2`。
  - cursor 不可用时拉 snapshot。失败发 `RESUME_WINDOW_EXPIRED` 并 `close 4409`。成功先发 `flow_snapshot`，`event_id` 是 `snapshot-` 加哈希前 24 位，再 replay，最后 `resume_ready`。
  - 前端把 cursor 放在 `workflow:v2:cursor:{flowTaskId}`。`flow_snapshot` 先补画面，`resume_ready` 才算恢复完成。断线不发 cancel。
  - AI 有 `replay-consumer-callbacks.ts`，每次 job id 带新时间戳。Agent 的请求级画布快照只校验 `schema_version`、hash、时间和 nodes / edges，不读 `flow_run_state`。

- 当前实现能不能算本章主交付完成？
  - 可以算本章主交付完成。
  - 因为八类扫描、稳定身份重放、内部快照、cursor 失效后的 4409，以及前端 `resume_ready` 都在。
  - 这不等于四次读取被包进同一个 Mongo 事务。snapshot 仍是读的过程中可能变化的视图。

- 当前测试覆盖了哪些本章风险？
  - 重投保持 `command_id`，第二次 start 不新建 run。重投失败不另造命令 id。
  - webhook 超时只对 `opencreator_ai` 使用 OC AI 错误码。
  - 孤儿重排保留 `result_id`，CAS 失败或没有计划的节点不进恢复列表。
  - 未 `start_initialized` 的 v2 被跳过，可恢复的 run 会返回。
  - 终态补偿要求 `protocol_version=2`，重复补写仍是同一个 `event_id`，不产生 `node_status`。
  - pending callback 走 Finalizer，失败把行标成 `failed`。running finalize 超过 60 秒会 force。
  - 扣费补偿先确认 usage，再写同一条结果。Outbox 重放保持原 `event_id`。
  - snapshot 客户端在 blue 404 时改问 green，两个都失败则不可用。内部路由对错误密钥返回 401，找不到返回 404。
  - WebSocket 在 cursor 过期时返回 `RESUME_WINDOW_EXPIRED` 和 4409。已有 cursor 不拉 snapshot。`flow_snapshot` 之后仍要等 `resume_ready`。

- 和 OpenCreator 现码相比，还要单独记住哪些差别？
  - 维护消费组叫 `novelcomic_consumer_group`。调度锁前缀仍是 `opencreator:flow_maintenance_scheduler:`。
  - 终态扫描的 status 包含 `completed`、`failed`、`killed`、`stopped`、`success`。`killed` 和 `stopped` 补 `flow_killed`，其余补 `finish_flow`。
  - `recover_running_flows()` 除了当前 `flow_resume_queue`，也会看队列字段缺失或为空的 running run。v2 未初始化的跳过条件仍在。
  - 一条维护消息失败后直接 ACK，`max_retry_times=0`。下一轮由调度再推，不靠同一条 Stream 消息重试。

- 如果刷新后节点没有接上，当前应该怎么排查？
  - 先看 attach 带的 `last_event_cursor` 是否还在 Event Store。还在就应 replay，不应先拉 snapshot。
  - cursor 不在时，看 blue / green 的内部快照是否 404、401 或 503。两个都失败才会 4409。
  - 收到 `flow_snapshot` 之后，还要等 `resume_ready`。只有快照帧时，恢复还没完成。
  - 看服务端 run 是否仍在跑。关掉页面不会 cancel。

- 如果运行中的节点停住了，当前应该怎么排查？
  - 先看 `start_initialized`。还是假时，走 Inbox 重投，不要等 `recover_running_flows`。
  - 已经初始化且计划写过、invocation 不齐时，看孤儿秒数是否已过，以及 CAS 是否保住原来的 `result_id`。
  - callback 已 `accepted` 但 `finalize_status` 不是 `done` 时，看 60 秒卡住扫描和 pending callback 重放。
  - run 已经终态但画面没有结束事件时，看 `terminal_event_outbox_recorded` 和那条稳定的 `finish_flow` / `flow_killed`。

- 什么时候才算本章完整验收？
  - 未 `start_initialized` 的 v2 running 不会被恢复扫描推进。
  - 终态缺事件时补出稳定的 `finish_flow` 或 `flow_killed`。
  - callback 2xx 但 Finalizer 卡住时能再跑。
  - cursor 还在就 replay。
  - cursor 不在就拿到 snapshot，或明确的 4409。
  - `resume_ready` 之后前端才当恢复完成。
  - 关掉 WebSocket 不会把 run 取消。
