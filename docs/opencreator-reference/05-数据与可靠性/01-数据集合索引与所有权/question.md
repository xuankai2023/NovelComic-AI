# 数据集合、索引与所有权 question

## 核心概念

- “数据集合、索引与所有权”讲的是什么？
  - 讲的是一次点击之后，事实落在哪张表、谁负责把状态改过去、哪一种身份被唯一索引保住。
  - 它不是工作流怎么跑，也不是清扫怎么补。队列投递和补偿窗口在相邻两组。

- 先背哪三句话？
  - 共享库不等于共享所有权。
  - 唯一索引保住逻辑身份。
  - TTL 只删终态，不宣布完成。

- 一次点击在库里按什么顺序落？
  - 浏览器 `sessionStorage` 先记下 `command_id`。这里还不是 Mongo。
  - Publisher 同一事务写入 `flow_task` 和 `workflow_command`。
  - 派发之后 Consumer 先写 `flow_command_inbox`，再写 `flow_run_state`、`flow_node_state`、`model_invocation`。
  - AI 写 `ai_task`、attempt、provider event、callback delivery。
  - 收尾写 `results`、`usage_v2`，再写 `flow_event_outbox`。
  - Publisher 把事件放进 Redis Event Store，并更新 `flow_task.last_event_cursor`。
  - 浏览器再记 cursor 和副作用 claim。

- 为什么“句柄能看见”和“这仓可以改”不能混？
  - 声明了集合句柄，只说明这个进程能连上这张表。
  - 谁负责状态迁移，要看写入那一侧的服务。
  - Publisher 能读 `flow_run_state`，节点从 `idle` 走到 `running` / `select` / `success` 仍由 Consumer 写。

## 五仓所有权

- 五仓各管哪一块？
  - Publisher 拥有用户、项目、`flow_task`、`workflow_command`、支付、Developer API、素材。
  - Consumer 拥有 `flow_run_state`、`flow_node_state`、`model_invocation`、Inbox、Outbox。
  - AI 拥有 `ai_task`、attempt、provider event、callback delivery。
  - Agent 拥有 session、message、event、tool trace、记忆。
  - Frontend 只留这一次浏览器里的命令 journal、cursor、副作用 claim。

- Agent 读得到 `flow_task` 和 `results`，能不能改 DAG？
  - 不能。
  - 读得到是共享库上的句柄。
  - 工作流执行状态机的 Owner 仍是 Consumer。

- `results` 和 `usage_v2` 谁写？
  - Publisher 可以读。
  - 执行结果和用量确认的写入在 Consumer。
  - `results` 的唯一键是 `(run_id, result_id)`，`usage_v2` 的唯一键是 `deduction_id`。

## 启动建索引

- 索引在什么时候建？
  - 在进程启动时建，不在业务请求里临时补。
  - Publisher `register_init()` 在 `test_mongo()` 成功之后、后台任务之前调用各 `ensure_*_indexes()`。
  - Consumer `test_mongo()` 在 `list_collection_names()` 之后调用 `init_consumer_v1_indexes()`。
  - AI 的 API 和 worker 连上 Mongo 之后都调用 `ensureMongoIndexes()`。
  - Agent 在 `ensure_indexes()` 里建自己的索引，并尝试共享集合。

- 为什么 AI 不能只在 API 里建索引？
  - worker 可能单独先启动。
  - 只在 API 里建，worker 先起来时会缺唯一键。
  - 同一套键要能重复创建。

- Consumer 哪四条索引失败必须退出？
  - `flow_event_outbox_event_id_unique`
  - `flow_event_outbox_sent_ttl`
  - `flow_command_inbox_command_id_unique`
  - `flow_command_inbox_terminal_ttl`
  - 其余索引失败只打 warning。`flow_run_state.run_id` 唯一索引创建失败，按现码不会挡住本次启动。

## 唯一索引

- 唯一索引挡住的是什么？
  - 挡住“这是不是同一条事实”被插成两行。
  - `workflow_command` 的 `(user_id, command_id)` 挡住同一用户的同一道命令。
  - `flow_command_inbox.command_id` 挡住 Consumer 把同一道命令再初始化一次。
  - `flow_event_outbox.event_id` 挡住同一条逻辑事件再插一行。
  - `ai_task.ai_task_id` 挡住同一个 AI 任务两行。

- `partialFilterExpression` 是什么意思？
  - 字段还没写成指定类型时，不参与这条唯一约束。
  - `client_request_id`、`wire_command_id`、`deduction_id`、`idempotency_key` 都是字段已是字符串才唯一。
  - 空文档可以先落库，真正的身份出现后才占唯一槽。

- 同一 `command_id`、不同 `user_id` 能不能各有一行？
  - 可以。
  - 命令唯一键是 `(user_id, command_id)`，不是全局 `command_id`。
  - `wire_command_id` 才是派发线上单独的唯一身份。

- `pending_model_callback` 为什么没有唯一约束？
  - 现码只建 `(vendor, external_task_id)` 普通索引。
  - 并发早到的回调可以留下多行。
  - 多行怎么收，留给清扫那一组，索引本身不保证只有一行。

## 扫描索引与 TTL

- 扫描索引保证任务已经完成了吗？
  - 不保证。
  - `(status, next_attempt_at, updated_at)` 只让派发和恢复能按状态、时间找到该处理的那一批。
  - 扫描窗口、lease 和补偿规则在清扫那一组。

- TTL 什么时候才删行？
  - `expireAfterSeconds=0` 表示文档上的 `expires_at` 到点就删。
  - 业务代码必须先把终态行的 `expires_at` 写上。
  - Inbox 的 `mark_completed()` 才写 `expires_at`。`mark_failed()` 会清掉它，失败行留着等重试。
  - Outbox 要到 `sent` 才写 `expires_at`。

- 为什么订阅结账要先 `$unset expires_at`？
  - 非 `completed` / `expired` / `failed` 的行如果留着旧的过期字段，TTL 会把活着的支付认领删掉。
  - `ensure_subscription_checkout_intent_indexes()` 先清掉这些行的 `expires_at`，再挂 TTL。

- Agent 的 tool trace TTL 为什么不是 `expires_at`？
  - `agent_tool_traces` 挂在 `completed_at` 上，`expireAfterSeconds=2592000`，大约 30 天。
  - 这是从完成时间起算的固定保留。
  - 和 `workflow_command` 那种“写了 `expires_at` 才删”不是同一套写法。

## 租户与浏览器钥匙

- 为什么只拿 `flow_task_id` 不能证明这行属于当前用户？
  - 资源 ID 能定位一行。
  - 公开读接口要把 `user_id` 放进查询，或放进查完后的校验。
  - 索引里有 `user_id`，调用方仍要自己带上。

- 浏览器里的三把钥匙分别是什么？
  - `sessionStorage` `workflow:v2:pending_commands`：同一次点击复用 `command_id`。
  - `sessionStorage` `workflow:v2:cursor:{flowTaskId}`：重连时从哪个位置 replay。
  - `localStorage` `workflow:v2:side_effect_claims`：积分、统计这类本地副作用只做一次。

- 清掉浏览器存储，服务端的命令还在吗？
  - Mongo 里已经收下的命令还在。
  - 浏览器丢了 journal，下一次点击会生成新的 `command_id`，服务端会把它当成新命令。
  - 唯一索引保的是“同一个 `command_id` 不会开第二行”，保不住“刷新后还记得旧 id”。
  - 存储写失败要吞掉，当前这次请求仍发出。不要在存储失败时假装服务端已经幂等。

## 共享索引与 Event Store

- Publisher 和 Consumer 都会建的索引，要对齐什么？
  - 索引名、键序、`unique`、`partialFilterExpression` 都要一致。
  - 共享的是 `credits_inout_record` 和三张 B2B 集合。
  - 后启动的一侧如果规格不同，会接到 Mongo 85 或 86。

- 85 和 86 是什么？
  - `85` IndexOptionsConflict：键相同，名字或选项不同。
  - `86` IndexKeySpecsConflict：同一个名字，键规格不同。
  - Agent 的 `_safe_create_index()` 只吞这两种，打 warning 后继续启动。
  - 其他错误继续抛，进程起不来。
  - warning 只说明进程还能起来，不能代替部署时去对索引规格。

- `media_face_verifications` 为什么可以跨仓写？
  - 这张表是受控共享，回写的是检测结果。
  - Publisher 持有用户维度唯一键 `(user_id, media.id)`。
  - AI 侧只建媒体 URL 和 BytePlus asset ID。
  - 用户项目、`flow_task`、运行态不能照这个例子互相改。

- Event Store 在不在这些 Mongo 集合里？
  - 不在。
  - 工作流 replay 的事件正文在 Publisher Redis：`opencreator:wf:{flow_task_id}:events` 和 `opencreator:wf:{flow_task_id}:event_ids`。
  - `event_id → cursor` 是 Redis Hash，事件流是 Redis Stream。
  - Consumer 的 `flow_event_outbox` 是发出去之前的账，不是浏览器 replay 的游标表。

## NovelComic 迁移

- 搬这组时最小要交付什么？
  - 每个集合有明确 Owner。共享库可以连，状态迁移只留在 Owner。
  - Publisher 启动调用 `ensure_workflow_v2_indexes()`。
  - Consumer 四条 v2 索引失败就退出。
  - AI 的 `ai_task_id`、attempt、provider event 三元组唯一，API 和 worker 都能建。
  - Agent 对共享集合的 85/86 可以警告，但要留得出索引差异。
  - `expires_at` TTL 只挂在终态行上。
  - 浏览器三把钥匙分开存，并且不当成 Mongo。

- 什么不算这组做完？
  - 只在文档里列出集合名。
  - 只在第一次请求时临时 `create_index`。
  - 另一个仓的 `update` 仍会改运行态。

## 面试短答

- 一句话讲这组？
  - OpenCreator 五仓可以连同一套 Mongo，状态机不共享：Publisher 写入口事实，Consumer 写执行事实，AI 写厂商任务，Agent 写会话，浏览器只留三把本地钥匙；逻辑身份靠启动时的唯一索引，TTL 只删已经写了 `expires_at` 的终态行。

- 一句话讲为什么句柄不等于 Owner？
  - 句柄只表示这个进程能读到集合，节点状态从 `idle` 走到 `success` 的写入仍在 Consumer。

- 一句话讲为什么 TTL 不是完成信号？
  - TTL 只在终态行写了 `expires_at` 之后到期删除，失败行会清掉这个字段继续留着重试。

- 一句话讲 NovelComic 迁移重点？
  - 先把 Owner 和启动索引写进代码，再谈功能；该挡住启动的四条索引必须失败退出。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - Publisher `register_init()` 在 `test_mongo()` 之后、后台任务之前建完全部 `ensure_*_indexes()`，包含 `ensure_workflow_v2_indexes()`。
  - `flow_task` 有 `(user_id, client_request_id)` 部分唯一，`workflow_command` 有 `(user_id, command_id)` 和 `wire_command_id` 部分唯一，并有派发扫描索引和 `expires_at` TTL。
  - `create_run()` 把 `flow_task` 和 `workflow_command` 放进同一事务；事务失败时两行都不留。
  - Consumer 用 `_CollectionProxy` 连同一主库，四条 v2 索引失败会 `sys.exit(1)`，`flow_run_state.run_id` 失败只 warning。
  - `pending_model_callback` 的 `(vendor, external_task_id)` 不是唯一索引。
  - AI API 和 worker 都会 `ensureMongoIndexes()`。`ai_task_id`、存在的 `idempotency_key`、`(ai_task_id, attempt)`、provider event 三元组、callback delivery 都唯一。
  - Agent 自己的 `(session_id, message_id)`、`(session_id, event_id)`、`(session_id, turn, user_id)` 唯一；tool trace TTL 在 `completed_at` 上，30 天。85/86 只 warning。
  - 前端三把钥匙已经分开：`workflow:v2:pending_commands`、`workflow:v2:cursor:{flowTaskId}`、`workflow:v2:side_effect_claims`。存储写失败仍让当前请求或副作用继续。

- 当前实现能不能算本章主交付完成？
  - 可以算本章主交付完成。
  - 因为 Owner 句柄、启动建索引、逻辑身份唯一键、四条 fail-fast、终态 TTL 和三把浏览器钥匙都已经在启动路径上。
  - 这不等于和 OpenCreator 的集合名、Redis key 逐字相同。

- 当前测试覆盖了哪些本章风险？
  - Publisher 索引可重复创建，同一 `(user_id, command_id)` 第二次插入失败。
  - 启动时会清掉非终态结账认领的 `expires_at`，索引失败时不启动 dispatcher。
  - `create_run()` 事务中途失败时两张表都没有这把命令。
  - Consumer 必需索引失败进程退出，`run_id` 唯一索引失败只 warning，早到回调可以留下两行。
  - AI 重复 `ai_task_id` 和重复 `idempotency_key` 会失败；人脸集合没有用户维度唯一键。
  - Agent 共享集合 85/86 打 warning，其他索引错误让启动失败。
  - 前端清掉 journal 会生成新的 `command_id`，三把钥匙不会写进彼此的存储。

- 和 OpenCreator 现码相比，还要单独记住哪些差别？
  - 项目在 `flow_projects`，用户在 `users`，执行结果在 `node_results`，目录在 `agent_catalog`。职责对齐，集合名按 NovelComic 现库。
  - Event Store 在线路径是 Redis：`workflow:v2:events:{flow_task_id}` 和 `workflow:v2:event-cursors:{flow_task_id}`。没有 Redis client 时还会 upsert Mongo `workflow_events`。浏览器 replay 仍以 Redis 为准。
  - Developer API 不是独立进程，`ensure_developer_indexes()` 只在 Publisher 启动里调用一次。
  - Agent 还没有 OpenCreator 那层 `memories` Atlas / Vector Search 索引检查。现在只有 `payload.user_id` 普通索引。

- 当前安全边界是什么？
  - 公开读仍然要带 `user_id`。索引里有用户字段，不能代替查询条件。
  - `media_face_verifications` 的用户唯一键在 Publisher；AI 只按 URL 和 BytePlus asset ID 定位。
  - 清掉浏览器存储不会删除 Mongo 里已经收下的命令。

- 如果重复点击插出了第二行，当前应该怎么排查？
  - 先看启动日志里对应唯一索引是否真的建成，而不是第一次请求时临时建。
  - 再看第二次插入用的是不是同一个 `user_id + command_id`，还是浏览器丢了 journal 后生成了新 id。
  - 再看 `wire_command_id` 当时是不是字符串。还不是字符串时，不占用那条部分唯一索引。
  - Consumer 侧看 `flow_command_inbox.command_id` 是否在四条必需索引里，失败时进程应已经退出。

- 什么时候才算本章完整验收？
  - Publisher 启动后能看到 `workflow_command_user_command_unique` 和 `workflow_command_wire_unique`。
  - 同一用户、同一 `command_id` 第二次插入失败；不同 `user_id` 可以各有一行。
  - 四条 v2 索引创建失败时 Consumer 退出；`flow_run_state.run_id` 失败只 warning。
  - AI API 和 worker 单独启动都能建成 `ai_task` 唯一索引。
  - 非终态 checkout intent 的 `expires_at` 在挂 TTL 前被清掉。
  - 前端三把钥匙使用三个不同的存储键，清掉浏览器存储不会删 Mongo 命令。
