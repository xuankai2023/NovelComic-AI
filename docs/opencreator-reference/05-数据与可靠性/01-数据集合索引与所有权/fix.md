# 数据集合、索引与所有权：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-publisher`、`opencreator-consumer`、`opencreator-ai`、`opencreator-agent`。NovelComic 看 `novelcomic-publisher`、`novelcomic-consumer`、`novelcomic-ai`、`novelcomic-agent`。前端三把钥匙已经同名，这一份不改前端。

不在这一份：全站响应信封。用户集合仍是 `users`，项目仍是 `flow_projects`，执行结果仍是 `node_results`，订单仍是 `orders`，支付事件仍是 `webhook_events`，用量仍是 `usage_v2`。不要改成 `user`、`flow`、`flow_details`、`results`、`order`、`webhook_event`。支付篇已经写明没有 `payments` 和 `payments_v2`。B2B 动作集合仍是 `b2b_signal_actions`。Publisher 和 Consumer 上的索引名、键序、`unique` 已经一致，不要为了改成 `b2b_signal_user_actions` 再搬一次。邀请码仍写在 `users.invite_code` 上，部分唯一留着，不另开 `invite_codes`。Developer API 不是独立进程，`ensure_developer_indexes()` 只在 Publisher `register_init()` 里调用一次，不要新做 `developer_api/app.py`。

Redis Event Store 的 key 不改。可恢复 WebSocket 那一份已经写了不要动 `workflow:v2:events:{flow_task_id}`、`workflow:v2:event-cursors:{flow_task_id}` 和通知 channel。Stream 字段名仍是 `event`。不要改成 `opencreator:wf:{{flow_task_id}}:events`，也不要把字段改成 `payload`。可恢复 WebSocket 第 3 节给 `is_cursor_available` 补的「不得晚于最新一条」留着。

AI 建单默认集合 `ai_tasks`，以及 `TaskRepository.ensureIndexes()` 那套 sparse，已经写在 AI 任务契约第 4 节。厂商事件写入和 `provider_events` 已经写在 Webhook 第 4 节。这一份不改建单文档，也不改 webhook 协议。Consumer 连接失败或四条必需索引失败时，退出码保持 `1`。不要改成 OpenCreator 不带参数的 `sys.exit()`，那个退出码是 `0`。

# 已经对齐，不要重写

这些路径对过现码，启动后能观察到的索引和终态 TTL 已经相同。差的是类放在哪个文件、单字段索引用字符串还是二元组。

- Publisher `register_init()` 在 `test_mongo()` 成功之后、结果消费者和 `workflow_command_dispatcher_forever()` 之前，按 OpenCreator 的顺序调用全部 `ensure_*_indexes()`。Mongo 连不上时服务不起
- `flow_task_user_client_request_unique`、`workflow_command_user_command_unique`、`workflow_command_wire_unique` 都在。`client_request_id` 和 `wire_command_id` 是 `$type: "string"` 的部分唯一。`workflow_command_terminal_ttl` 是 `expires_at` 加 `expireAfterSeconds=0`
- 非 `completed` / `expired` / `failed` 的 `subscription_checkout_intent` 先 `$unset expires_at`，再挂 TTL。`developer_idempotency` 也是 `expires_at` 加 `expireAfterSeconds=0`，并会丢掉旧的非唯一 `developer_api_client_api_key_hash_status`
- `credits_inout_record` 三条索引名、键序、`unique`、partial 在 Publisher 和 Consumer 上一致
- Consumer `_CollectionProxy` 按当前 event loop 取集合。四条失败退出的名字是 `flow_event_outbox_event_id_unique`、`flow_event_outbox_sent_ttl`、`flow_command_inbox_command_id_unique`、`flow_command_inbox_terminal_ttl`。`flow_run_state.run_id` 唯一失败只 warning。`pending_model_callback` 的 `(vendor, external_task_id)` 不是唯一
- Inbox `mark_completed()` 才写 `expires_at`。`mark_failed()` 清掉它。Outbox 到 `sent` 才写 `expires_at`。命令派发失败把 `workflow_command.expires_at` 清掉
- AI 的 API 和 worker 连上 Mongo 之后都调用 `ensureMongoIndexes()`。`ai_task_id` 唯一，`idempotency_key` 在字段存在时唯一，`(ai_task_id, attempt)`、`(provider, provider_request_id, event_id)`、`(ai_task_id, attempt)` 回调投递都唯一。人脸集合在 AI 侧只有 `media.url`、`face_providers.byteplus.asset_id` 和两者的复合键，没有用户维度唯一键
- Agent `_safe_create_index()` 只吞 `OperationFailure` 85 和 86。自己的 `(session_id, message_id)`、`(session_id, event_id)`、`(session_id, turn, user_id)` 唯一。`agent_tool_traces.completed_at` 的 `expireAfterSeconds` 是 `2592000`
- 前端 `sessionStorage` 的 `workflow:v2:pending_commands`、`workflow:v2:cursor:{flowTaskId}`，以及 `localStorage` 的 `workflow:v2:side_effect_claims`，写失败仍让当前请求或副作用继续。副作用 claim 最多约 24 小时、最多 5000 条

# 1. 人脸复合索引不要单独起名

做完要达到：Publisher 和 AI 都会在 `media_face_verifications` 上建 `(media.url, face_providers.byteplus.asset_id)`。两边都不传 `name`。Mongo 自己生成的索引名相同，后启动的一侧可以再执行一次。

其余人脸索引保持现状。Publisher 仍有 `(user_id, media.id)` 唯一、`media.content_hash`、`(user_id, created_at)`、`(user_id, media.url)`。AI 仍不建用户维度唯一键。库名仍看 `MEDIA_FACE_VERIFICATION_DB_NAME`，没配就用 AI 默认库。

## 现在

Publisher 给这条复合键起了名字 `media_face_verifications_url_byteplus_asset`。AI 的 `ensureMongoIndexes()` 不传名字。默认配置下两仓写同一张表。后启动的一侧接到 85，AI 的 `Promise.all` 会整段失败，Publisher 启动也会失败。

## 改哪些文件

1. `novelcomic-publisher/app/database/mongo.py` 的 `ensure_media_face_verifications_indexes()`。对照 OpenCreator `database/mongo.py` 里最后一条 `create_index`，去掉 `name`。
2. `novelcomic-ai/packages/db/src/mongo.ts` 的人脸三条保持不传 `name`。不要为了避开 85 再给 AI 加名字。

# 2. `ensureMongoIndexes` 补上 reason mapping 五条

做完要达到：`ensureMongoIndexes()` 同一次 `Promise.all` 里带上这五条。API 和 worker 谁先启动都能建，重复调用得到同一套键。

```text
provider_reason_mapping.id                         唯一
provider_reason_mapping (enabled, priority 降序)
provider_reason_mapping (error_code, enabled)
provider_reason_unknown.fingerprint                唯一
provider_reason_unknown (status, created_at 降序)
```

这五条都不传自定义 `name`。`resolveReason()` 和回调文案不在这一节。

## 现在

`COLLECTIONS` 里有 `provider_reason_mapping` 和 `provider_reason_unknown`，`createMongoContext()` 也拿到了句柄。`ensureMongoIndexes()` 没有给它们建索引。`fingerprint` 重复可以插进第二行。

## 改哪些文件

1. `novelcomic-ai/packages/db/src/mongo.ts` 的 `ensureMongoIndexes()`。对照 OpenCreator `packages/db/src/mongo.ts` 里展开的 `createReasonMappingIndexes()`。
2. 索引函数可以放在新的 `novelcomic-ai/packages/db/src/reason-mapping-repository.ts`，只搬 `createReasonMappingIndexes()` 这一个函数。对照 OpenCreator 同名文件里这一个函数。不要把 `ReasonMappingStore` 的解析写进来。

# 3. 邀请奖励的扫描索引换成带 status 的那条

做完要达到：`invite_credit_records` 上，邀请人这条索引是 `(inviter_user_id, status, reward_type)`，名字 `invite_credit_records_inviter_status_reward`。不是唯一索引。

`(invitee_user_id, reward_type)` 唯一，以及 `invite_relations` 上的 `invitee_user_id` 唯一和 `(inviter_user_id, created_at)`，保持不动。`users.invite_code` 的部分唯一保持不动。

## 现在

邀请人这条是 `(inviter_user_id, reward_type, created_at)`，名字 `invite_credit_records_inviter_reward_created`。没有 `status`。

## 改哪些文件

1. `novelcomic-publisher/app/database/mongo.py` 的 `ensure_invite_indexes()`。对照 OpenCreator `ensure_invite_indexes()` 里 `invite_credit_records` 的第二条。删掉 `invite_credit_records_inviter_reward_created`。不要把邀请码从 `users` 搬到新集合。

# 4. 推荐位索引建到 admin 库，hook 索引由 Agent 建

做完要达到：Publisher 用同一个 Mongo client 再连数据库 `opencreator-admin`。`ensure_agent_catalog_indexes()` 在这个库的 `agent_prompt_suggestions` 上建：

```text
prompt_key 唯一
  名字 agent_prompt_suggestions_prompt_key_unique
(placement, status, sort_order, updated_at)
  名字 agent_prompt_suggestions_placement_status_sort
```

Agent 启动时在同一个 `opencreator-admin` 的 `agent_hooks` 上建 `(hook_id, status)`，名字 `hook_id_status_idx`。撞上 85 或 86 只 warning。

主库 `agent_catalog` 上现有的 `agent_catalog_hook_id_unique`、`agent_catalog_role_id_unique`、`agent_catalog_kind_status_sort` 先留着。增长篇还在用 `agent_catalog` 查询。这一份不改 `agent_catalog.py`，也不把现有目录文档搬进 admin 库。

## 现在

Publisher 没有 admin 库。`ensure_agent_catalog_indexes()` 只建在主库 `agent_catalog` 上，没有 `prompt_key` 唯一。Agent 不建 `hook_id_status_idx`。

## 改哪些文件

1. `novelcomic-publisher/app/database/mongo.py` 的 `ensure_agent_catalog_indexes()`。对照 OpenCreator 同名函数。admin 库名是字面量 `opencreator-admin`。现有三条 `agent_catalog` 索引留在函数里，不要删。
2. `novelcomic-agent/src/novelcomic_agent/database/mongo.py` 的 `ensure_indexes()`。对照 OpenCreator `creato/database/mongo.py` 里 `agent_hooks_col` 那一条。admin 库同样是 `opencreator-admin`。

# 5. Agent 会话进独立库，memories 补向量过滤

做完要达到：Agent 启动先连三个库，再 `list_collection_names()`。任一个失败，进程 `sys.exit(1)`，后面的 `ensure_indexes()` 不跑。

```text
主库    配置里的 mongodb_database，和 Publisher 同一个库，默认 novelcomic
agent 库  配置项单独给出，默认 opencreator_agent
cut 库   字面量 opencreator-cut
```

会话事实在 agent 库：`agent_sessions`、`agent_messages`、`agent_chat_messages`、`agent_events`、`agent_tool_traces`、`agent_message_feedback`、`memories`。`cut_project`、`cut_render_tasks` 在 cut 库。

主库上继续建现在已经有的共享索引，集合名仍是 NovelComic 现库：`flow_projects` 上的 `flow_id_idx`，`flow_version` 上的 `flow_created_idx`，`flow_task` 上的 `flow_task_user_idx`，`node_results` 上的 `workflow_user_node_created_idx`，以及订阅积分、赠送积分的那两条。不要另开 `flow`、`flow_details`、`results`。

主库还要多建 OpenCreator 的遗留两条。它们和 agent 库里的同名索引不是同一张表：

```text
agent_sessions (user_id, updated_at)           名字 user_updated_idx
agent_session_messages (session_key, seq)      名字 session_seq_idx
```

`memories` 先建 `(payload.user_id)`，名字 `payload_user_idx`。然后检查搜索索引 `memories_vector_index` 是否带过滤路径 `payload.user_id`。索引不存在只 warning。定义里已经有这个路径就返回。没有则 `update_search_index`。列表形态的 fields 追加 `{type: filter, path}`。对象形态按路径补到叶子 `{type: token}`。任何异常只 warning，进程继续。85 和 86 的规则不变。

`avatar_vectors`、`situation_vectors` 在 OpenCreator 的 `init_mongo()` 里有句柄，`ensure_indexes()` 没有给它们 `create_index`。这一份不给它们加索引。

主库里已经写下的 `agent_sessions` 不会被这段启动代码搬走。

## 现在

Agent 只有 `mongodb_database` 一个库，默认 `novelcomic`。会话、`memories`、`cut_project` 都在这个库里。启动不先列出 agent 库和 cut 库。没有 `agent_session_messages` 那条遗留索引。`memories` 只有 `payload_user_idx`，没有 `memories_vector_index` 的过滤字段检查。

## 改哪些文件

1. `novelcomic-agent/src/novelcomic_agent/config.py`。增加 agent 库名，默认 `opencreator_agent`。主库默认仍是 `novelcomic`。
2. `novelcomic-agent/src/novelcomic_agent/database/mongo.py`。对照 OpenCreator `creato/database/mongo.py` 的 `init_mongo()`、`test_mongo()`、`_ensure_search_index_filter()`、`_search_index_has_path()`、`_add_search_filter_path()`，以及 `ensure_indexes()` 里遗留两条和 `agent_hooks` 那条。共享集合的集合名按上面写的现库。
3. `novelcomic-agent/src/novelcomic_agent/dependencies.py` 的 `start()`。先做三个库的连通检查，再 `ensure_indexes()`。对照 OpenCreator `creato/api/server.py` 的 lifespan：`test_mongo()` 在 `ensure_indexes()` 前面。

# 6. replay 正文不落 Mongo `workflow_events`

做完要达到：工作流 replay 的正文只在 Publisher Redis。`append_event()`、`replay()`、`read_live()` 都走 Redis Stream 和 event id 哈希。没有 Redis client 时，不要 `upsert` `workflow_events`，也不要按 `created_at` 从这张表读。

调用方已经传入 Redis client 的路径保持现在的 key 和字段名。`0-0` 在 Stream 被裁掉或过期时的判断留在可恢复 WebSocket 那一份。这一节不改 key，不改 Lua 里的字段名 `event`。

Stream 近似封顶 `MAXLEN ~` 用 `workflow_event_stream_maxlen`，改成 `5000`。这和 OpenCreator `WORKFLOW_EVENT_STREAM_MAXLEN` 相同。TTL 仍是 24 小时。通知 Stream 和事件 Stream 共用这一个上限。

## 现在

`redis_client is None` 时，`append_event()` 对 `workflow_events` 做 `update_one` upsert，`replay()` 和 `read_live()` 按 `flow_task_id` 从这张表读。`latest_cursor()` 在没有 Redis 时直接返回 `0-0`。`is_cursor_available()` 在没有 Redis 时直接返回 true。`workflow_event_stream_maxlen` 是 `10000`。

## 改哪些文件

1. `novelcomic-publisher/app/services/workflow_event_store.py`。对照 OpenCreator `services/workflow_event_store.py` 时，只删 Mongo `workflow_events` 这条后备。key、`_APPEND_EVENT_SCRIPT` 的字段名、通知 channel 保持 NovelComic 现码。可恢复 WebSocket 第 3 节要求的最新 cursor 上界，如果已经补上，不要退回去。
2. `novelcomic-publisher/app/config.py` 的 `workflow_event_stream_maxlen`。对照 OpenCreator `core/config.py` 的 `WORKFLOW_EVENT_STREAM_MAXLEN`。
