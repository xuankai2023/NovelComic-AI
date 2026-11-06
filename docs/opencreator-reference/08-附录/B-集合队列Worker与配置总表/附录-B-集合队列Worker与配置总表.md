# 附录 B：集合、队列、Worker 与配置总表

本附录按“事实存储、运行时存储、异步通道、执行者、配置”分组。集合名相同通常表示跨仓共享事实，不表示每仓都拥有写权限。

## 1. MongoDB 集合

### Publisher / Consumer 共享主库

- 用户与权益
  - `user`：用户与余额基础事实。
  - `subscription_info`、`subscription_user_credits`、`gift_credits`。
  - `usage`、`usage_v2`、`credits_inout_record`。
  - `order`、`payments`、`payments_v2`、`stripe_invoice_order_claim`、`subscription_checkout_intent`、`webhook_event`。
- Workflow 定义与运行
  - `flow`、`flow_details`、`flow_version`、`share_flow`。
  - `flow_task`：用户可见任务/快照入口。
  - `flow_run_state`、`flow_node_state`：Consumer state-machine 状态。
  - `node_task`、`results`。
  - `workflow_command`：Publisher durable command dispatch。
  - `flow_command_inbox`：Consumer 命令幂等、租约与重投。
  - `flow_event_outbox`：Consumer 事件可靠发布。
  - `model_invocation`、`pending_model_callback`：模型调用与早到 callback。
- 产品资产与扩展
  - `asset_library_items`、`agent_skills`、`node_blocks`、`app_flow`。
  - `miniapp_task`、`miniapp_results`。
  - `custom_workflow_order`。
  - `model_config`、`model_sort_config`。
  - `media_face_verifications`、`user_preferences`。
- Developer / CLI / 增长
  - `developer_api_client`、`developer_workflow_run`、`developer_idempotency`、`developer_event_dlq`。
  - `invite_codes`、`invite_records`、`invite_credit_records`。
  - `b2b_signal_events`、`b2b_signal_notifications`、`b2b_signal_user_actions`。
- 运维
  - `alert_notify`。

定义与索引：[`Publisher database/mongo.py`](../../../../../opencreate/opencreator-publisher/database/mongo.py)、[`Consumer database/mongo.py`](../../../../../opencreate/opencreator-consumer/database/mongo.py)。

### opencreator-admin

- `templates`、`template_categories`、`template_stats_total`。
- `credits_topup_record`。
- `agent_hooks`、`agent_roles`、`agent_prompt_suggestions`。

Publisher 与 Agent 都会读取其中部分集合。源码：[`Publisher database/mongo.py`](../../../../../opencreate/opencreator-publisher/database/mongo.py)、[`Agent database/mongo.py`](../../../../../opencreate/opencreator-agent/creato/database/mongo.py)。

### opencreator-ai

- `ai_task`：统一 AI task。
- `ai_task_attempt`：provider 尝试。
- `ai_provider_event`：厂商事件。
- `ai_callback_delivery`：回调交付与重试。
- `provider_reason_mapping`、`provider_reason_unknown`：错误原因治理。
- `media_face_verifications`：按配置可指向共享真人检测集合。

定义：[`collections.ts`](../../../../../opencreate/opencreator-ai/packages/db/src/collections.ts)。

### opencreator_agent

- `agent_sessions`：会话元数据。
- `agent_messages`：原始消息。
- `agent_chat_messages`：前端展示投影。
- `agent_events`：append-only 运行事件。
- `agent_tool_traces`：工具 trace，30 天 TTL。
- `agent_message_feedback`。
- `memories`：长期记忆/vector store。
- `avatar_vectors`、`situation_vectors`。

兼容集合仍在主库：`agent_sessions`、`agent_session_messages`。共享读取还包括 `flow*`、`results`、`agent_skills`、`share_flow` 与积分集合。

定义与索引：[`Agent database/mongo.py`](../../../../../opencreate/opencreator-agent/creato/database/mongo.py)。

### opencreator-cut

- `cut_project`。
- `cut_render_tasks`。

由 Agent 的视频编辑能力绑定。源码：[`Agent database/mongo.py`](../../../../../opencreate/opencreator-agent/creato/database/mongo.py)。

## 2. Redis Stream 与关键 key

### Workflow 命令与执行

- Stream `run_flow`
  - Publisher XADD；Consumer Funboost/XREADGROUP。
  - consumer group：`opencreator_group`。
- Stream/queue `flow_resume`
  - callback、节点完成或恢复逻辑推动 DAG 再调度。
- Stream/queue `flow_maintenance`
  - 重投 inbox、恢复 running flow、重放 outbox、终态对账、扣费对账。
- 其他 Consumer queue
  - `HANDLE_CONSUME_QUEUE_NAME`：usage。
  - `handle_flow_step_marker_consume`。
  - `ALERT_NOTIFY_TASK_QUEUE` 或 `handle_alert_notify_task_consume`。
- 维护锁
  - `opencreator:flow_maintenance_scheduler:{command}`。
- Funboost heartbeat
  - `funboost_hearbeat_queue__str:{queue_name}`。

源码：[`Consumer tasks/setup.py`](../../../../../opencreate/opencreator-consumer/tasks/setup.py)、[`Publisher tasks/flow.py`](../../../../../opencreate/opencreator-publisher/tasks/flow.py)。

### Publisher Workflow Event Store

- Stream `opencreator:wf:{flow_task_id}:events`：可恢复事件。
- Hash `opencreator:wf:{flow_task_id}:event_ids`：`event_id → cursor` 去重。
- Key `opencreator:wf:{flow_task_id}:generation:{connection_id}`：同 connection 代次。
- Pub/Sub `opencreator:workflow:v2:event-notifications`：唤醒本地 WS loop；事实仍在 Stream。
- Key 前缀 `opencreator:devapi:mq_retry`：Developer API MQ 持久化失败短期重试。

源码：[`workflow_event_store.py`](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)、[`database/mq.py`](../../../../../opencreate/opencreator-publisher/database/mq.py)。

### Consumer 蓝绿状态

- `opencreator:consumer:intake:{instance}`。
- `opencreator:consumer:inflight:{instance}`。
- `opencreator:consumer:heartbeat:{instance}`。

源码：[`deploy-consumer-bluegreen-prod.sh`](../../../../../opencreate/opencreator-consumer/deploy/deploy-consumer-bluegreen-prod.sh)、[`main.py`](../../../../../opencreate/opencreator-consumer/main.py)。

### Agent run / SSE / 蓝绿

- Stream `agent:run:{run_id}:events`：SSE replay/live。
- Hash `agent:run:{run_id}:meta`。
- Key `agent:session:{session_id}:active_run`。
- Key `agent:req:{user_id}:{session_id}:{client_request_id}`：创建幂等。
- Key `agent:req_cancel:{...}`、`agent:run:{run_id}:cancel_requested`。
- Lock `agent:session:{session_id}:run_lock`。
- Key `agent:run:{run_id}:checkpoint`。
- Key `agent:instance:{instance_id}:heartbeat`。
- Set `agent:active_runs`。
- Stream `agent:wf:events:{ws_id}`：Agent workflow bridge 跨实例缓冲。
- Session cache 使用 ctx/meta 前缀；Mongo 是最终会话事实。

源码：[`agent_redis_run_store.py`](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)、[`server.py`](../../../../../opencreate/opencreator-agent/creato/api/server.py)、[`session/manager.py`](../../../../../opencreate/opencreator-agent/creato/session/manager.py)。

### AI Redis / BullMQ

- `REDIS_KEY_PREFIX`：AI 运行时 key 总前缀，默认 `opencreator-ai`。
- `REDIS_BULLMQ_PREFIX`：BullMQ 数据结构前缀，默认 `opencreator-ai:bullmq`。
- 主要用途：task 幂等、task lock、provider polling lock、rate limit、worker ready heartbeat、BullMQ job/list/set/stream。

配置与实现：[`load-config.ts`](../../../../../opencreate/opencreator-ai/packages/config/src/load-config.ts)、[`heartbeat.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/heartbeat.ts)。

## 3. RabbitMQ 与 BullMQ

### RabbitMQ

- Publisher/Consumer legacy 实例队列
  - `flow_result.{PUBLISHER_DEPLOY_ID}`：每个 Publisher 实例独占。
  - Consumer 按命令 payload 的 `reply_queue` 回传。
- Workflow v2 稳定队列
  - 默认 `flow_result.workflow.v2.{APP_ENV}`，可由 `FLOW_V2_RESULT_QUEUE_NAME` 覆盖。
  - DLQ：同名加 `.dlq`。
  - 参数：single-active-consumer，失败 dead-letter。
- Consumer 默认结果队列
  - `FLOW_TASK_RESULT_QUEUE`，用于未指定动态 reply queue 的路径。

源码：[`Publisher database/mq.py`](../../../../../opencreate/opencreator-publisher/database/mq.py)、[`Consumer flow_event_publish_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)。

### BullMQ

- `provider-execution`：调用 provider 或进入轮询。
- `artifact-processing`：使用 `PassThroughArtifactStore` 整理并持久化已归一结果；COS/S3
  上传可能更早发生在 provider normalize 使用的配置 uploader 中。
- `consumer-callback`：回调 Consumer。
- `consumer-callback-dlq`：callback 超过重试窗口。
- `media-face-verification`：真人检测轮询。

源码：[`queue-names.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/queue-names.ts)、[`queues.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/queues.ts)。

## 4. Worker / 后台任务

### Publisher

- RabbitMQ legacy receiver workers：数量由 `MQ_RECEIVER_NUM_WORKERS` 控制。
- Workflow v2 receiver workers：稳定队列，按 flow identity 路由并先持久化再 ACK。
- workflow command dispatcher：扫描 `workflow_command`，租约后写 `run_flow`。
- WebSocket event loop：按 cursor 从 Event Store replay/read live。
- Stripe durable retry、gift credits 过期监听等业务后台任务。

入口：[`core/register.py`](../../../../../opencreate/opencreator-publisher/core/register.py)、[`database/mq.py`](../../../../../opencreate/opencreator-publisher/database/mq.py)、[`workflow_runs_v2.py`](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)。

### Consumer

- `FlowTask.run_flow`：命令 inbox 与 run 初始化。
- `FlowResumeTask.handle_resume`：DAG 推进、模型节点提交、聚合。
- `FlowMaintenanceTask.handle_maintenance`：恢复与对账。
- `UsageTask.handle_consume`：扣费/usage。
- `FlowStepMarkerTask`、`AlertNotifyTask`。
- callback finalize 后台任务、outbox publisher/replay。

装配：[`tasks/setup.py`](../../../../../opencreate/opencreator-consumer/tasks/setup.py)。

### AI

- provider worker。
- artifact worker（当前 pass-through 整理，不承担 COS/S3 上传）。
- callback worker。
- media face verification worker。
- QueueEvents 监听 completed/failed/stalled/progress；worker ready heartbeat。

装配：[`apps/worker/src/main.ts`](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts)、[`workers.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/workers.ts)。

### Agent

- 每个 run 的 asyncio task / executor loop。
- Redis SSE event append/read。
- checkpoint writer、instance heartbeat、orphan active-run scan/接管。
- workflow tool 消费 Publisher WS 事件并桥接到 Agent SSE。
- SessionManager 把原始消息、投影、trace 写 Mongo 并刷新 Redis cache。

入口：[`server.py`](../../../../../opencreate/opencreator-agent/creato/api/server.py)、[`core/loop.py`](../../../../../opencreate/opencreator-agent/creato/core/loop.py)。

### Frontend

- 无服务端 worker。
- 浏览器侧后台职责：React Query、自动保存/sync manager、command journal、WS 重连、SSE reconnect、cursor 与副作用 claim。

入口：[`sync-manager.ts`](../../../../../opencreate/opencreator-frontend/src/lib/sync-manager.ts)、[`workflow-resumable-websocket.ts`](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)。

## 5. 配置分组

### Frontend

- API/传输：Server URL、WebSocket URL、Agent base URL。
- 身份：Clerk publishable key。
- UI/嵌入：iframe origin、静态资源/CDN。
- 观测：PostHog、Sentry。
- 规则：只放公开构建配置，秘密留服务端。

### Publisher

- 服务：API prefix、Uvicorn、中间件、`APP_ENV`。
- 数据：Mongo、Redis、RabbitMQ。
- 队列：run/node/usage/miniapp、result queue、receiver workers。
- 身份：JWT、Clerk、CLI device auth、internal API key。
- 外部：Stripe、对象存储、邮件、社交 OAuth、PostHog/Sentry。
- Workflow v2：deploy id、stable reply queue、Event Store TTL/maxlen、dispatch interval/lease/retention、WS timeout。
- AI：AI base URL/auth、真人检测、provider/asset 配置。

源码：[`core/config.py`](../../../../../opencreate/opencreator-publisher/core/config.py)。

### Consumer

- 服务/数据：FastAPI、中间件、Mongo、Redis、RabbitMQ。
- 队列：run/resume/maintenance/usage/marker/alert。
- 并发：flow、resume、callback finalize、provider submit、maintenance。
- 恢复：各类 lease、sweep、retry、retention、orphan timeout、readyz backlog 阈值。
- AI：submit URL/auth、callback secret/base URL、provider credentials。
- 计费/存储/观测：usage QPS、S3、Stripe map、Sentry/PostHog、飞书。

源码：[`core/config.py`](../../../../../opencreate/opencreator-consumer/core/config.py)。

### AI

- 服务：env、host/port、日志。
- 数据/队列：Mongo、Redis、BullMQ prefix、TTL、locks、rate limit、worker concurrency。
- provider：各厂商 base URL、key、webhook secret、轮询超时。
- callback：attempts、retry window、delay、request timeout、DLQ retention。
- 产物：pass-through/S3/COS、bucket/CDN/ImageKit。
- 安全：auth key、Consumer HMAC secret、admin token、Bull Board。
- 可选：config loader、飞书告警/模型通知、reason mapping loader。

源码：[`load-config.ts`](../../../../../opencreate/opencreator-ai/packages/config/src/load-config.ts)。

### Agent

- API/channel：server 开关、host/port、Clerk、editor base。
- 模型：默认/回退模型、provider keys/base URL、token/context/tool iteration。
- 工具：Web、MCP、workspace 限制。
- 数据/传输：Mongo 主库/Agent 库、Redis、RabbitMQ、workflow run queue。
- 产品：memory、COS、billing、模板/vector/cut。
- 观测：Sentry、PostHog。
- 蓝绿：固定 deploy/instance identity、run checkpoint、health/drain 与 ALB slot。

源码：[`schema.py`](../../../../../opencreate/opencreator-agent/creato/config/schema.py)、[`main-deploy.yml`](../../../../../opencreate/opencreator-agent/.github/workflows/main-deploy.yml)。

## 6. 最小一致性检查

- 五仓是否指向预期 Mongo DB、Redis DB、Rabbit vhost 与环境名。
- Publisher/Consumer 的 `run_flow`、v2 reply queue、HMAC/auth 配置是否成对。
- AI callback URL/secret 与 Consumer callback 验签是否成对。
- Agent workflow queue、Publisher base URL、JWT/Clerk 配置是否成对。
- 队列 worker 并发与 provider/数据库限额是否匹配。
- TTL 是否覆盖最长 run、断线恢复、callback retry 与蓝绿排空窗口。
- 共享集合的索引创建者、写 owner、兼容读和清理责任是否明确。
