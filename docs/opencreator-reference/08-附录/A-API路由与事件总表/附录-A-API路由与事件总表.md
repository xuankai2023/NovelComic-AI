# 附录 A：API 路由与事件总表

状态口径：**主链**是当前画布/Agent 核心链；**兼容**是仍挂载的旧协议；**旁路**是启用但不经过主链；**未启用**是 410、默认开关关闭或仅有实现无启用证据。以下只列启用入口族和影响系统边界的核心口，不逐枚举同族 CRUD。

## 1. opencreator-frontend

Frontend 不提供服务端路由，是五仓的浏览器调用入口。

- HTTP｜主链
  - `/api/v2/auth/*`：验证码/密码登录，换 Clerk session。
  - `/api/v2/user/*`：用户、偏好、邀请。
  - `/api/v2/flow/project*`：项目 CRUD。
  - `/api/v2/flow/runs*`：start、continue、cancel、active、snapshot。
  - `/api/v3/result/*`、`/api/v3/assets/*`：结果和素材。
  - 源码：[`src/api/modules`](../../../../../opencreate/opencreator-frontend/src/api/modules)、[`useWorkflowRunner.ts`](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts)。
- WebSocket｜主链
  - `WS /api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。
  - 协议：`auth → authenticated → attach_flow(last_event_cursor) → replay → resume_ready`。
  - 源码：[`workflow-resumable-websocket.ts`](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)、[`useWebSocketFlow.ts`](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWebSocketFlow.ts)。
- SSE｜主链
  - `POST /v1/agent/runs` 后订阅 `GET /v1/agent/runs/{run_id}/events`，用 `Last-Event-ID` 恢复。
  - 源码：[`agent-chat.api.ts`](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/api/agent-chat.api.ts)、[`agent-chat-stream.ts`](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/stream/agent-chat-stream.ts)。
- HTTP｜兼容
  - v1 kill、result、base64 upload、payment、node blocks、miniapp、custom workflow。
  - 源码：[`flow.ts`](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts)、[`node.ts`](../../../../../opencreate/opencreator-frontend/src/api/modules/node.ts)。
- HTTP｜旁路
  - CLI 授权页、Developer API tester、模板/模型、分享、AppFlow、Agent catalog/skills。
- SSE｜未启用
  - 旧 `POST /v1/agent/chat` 已由 Agent 返回 410；前端应只走 run/event 两段式。

## 2. opencreator-publisher

总挂载：`/api/v1`、`/api/v2`、`/api/v3`、`/api/internal`、`/api/developer/v1`。源码：[`controller/routers.py`](../../../../../opencreate/opencreator-publisher/controller/routers.py)、[`core/register.py`](../../../../../opencreate/opencreator-publisher/core/register.py)。

- HTTP｜主链
  - v2 auth/user：登录与业务用户。
  - `POST/GET/PATCH/DELETE /api/v2/flow/project*`：项目。
  - `POST /api/v2/flow/runs`：创建 run，202 表示命令受理。
  - `POST /api/v2/flow/runs/{id}/continue|cancel`。
  - `GET /api/v2/flow/runs|active|{id}`：恢复对账。
  - v3 result/assets/media-face-verifications：结果、素材、真人检测。
  - 源码：[`flow_runs.py`](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)、[`workflow_project.py`](../../../../../opencreate/opencreator-publisher/controller/v2/workflow_project.py)。
- WebSocket｜主链
  - `/api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。
  - HTTP 鉴权中间件不代替 WS 内的 auth/attach；事件来自 Redis Event Store。
  - 源码：[`flow_runs.py`](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)、[`workflow_event_store.py`](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)。
- HTTP｜兼容
  - v1 flow WebSocket/kill/history、v1 result/upload/payment/user/share。
  - v2/v3 同名资源并存：share、result、flow details 等。
  - 源码：[`flow.py`](../../../../../opencreate/opencreator-publisher/controller/v1/flow.py)、[`routers.py`](../../../../../opencreate/opencreator-publisher/controller/routers.py)。
- WebSocket｜兼容
  - `WS /api/v1/flow/flow_task/{ws_id}`，使用实例内连接表与实例级 reply queue；不是 v2 可恢复协议。
- HTTP｜旁路
  - `/api/v3/webhooks/clerk`、`/api/v1/payments/webhook`、`/api/v1/feishu/event`。
  - `/api/v1/node_blocks/*`、`/api/v3/app-flow/*`、`/api/v1/custom_workflow/*`。
  - `/api/v3/agent-catalog/hooks|roles|prompt-suggestions`、`/api/v3/agent-skills/*`。
  - `/api/v2/b2b-signal/actions/*`；支付与 v1 flow task 还会写 B2B signal，周期任务负责条件飞书。
  - `/api/v1/cli/*`、`/api/v3/developer/api-client/*`、`/api/developer/v1/*`。
  - `/api/internal/*`、`/health`、`/health2`、`/health/consumer`、`/readyz`。
- HTTP｜未启用
  - CLI 路由挂载但 `CLI_AUTH_ENABLED=False` 时拒绝；是否启用按环境配置判断。
  - `/api/v1/miniapp/*` 路由和任务记录存在，但主进程未注册 consumer，执行器仍是 TODO。
- HTTP｜遗留外部目录
  - `/api/v1/flow_template/whole/list` 从 Business Center 拉旧整图模板。
- SSE
  - Publisher 没有 Agent SSE；不要把画布 WS 写成 SSE。

## 3. opencreator-consumer

- HTTP｜主链内部入口
  - `POST /callbacks/models/{vendor}`：AI/provider callback，验签后推进 invocation 与 DAG。
  - 源码：[`main.py`](../../../../../opencreate/opencreator-consumer/main.py)、[`model_invocation_service.py`](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)。
- HTTP｜旁路
  - `GET /api/internal/workflow/{flow_task_id}/snapshot`：内部快照。
  - `/health`、`/readyz`。
  - `POST /ops/consumer/drain|active`、`GET /ops/consumer/status`：蓝绿控制面。
- 非 HTTP｜主链
  - Redis Stream/Funboost：`run_flow`、`flow_resume`、`flow_maintenance`、usage、step marker、alert。
  - RabbitMQ：把 outbox 事件发到 payload 指定 reply queue 或稳定 v2 queue。
  - 源码：[`tasks/setup.py`](../../../../../opencreate/opencreator-consumer/tasks/setup.py)、[`flow_event_publish_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)。
- WebSocket / SSE
  - 无对浏览器入口；Consumer 不持有浏览器连接。
- 非 HTTP｜兼容
  - legacy model id mapper、v1 result queue/event 语义仍保留。
- 非 HTTP｜未启用
  - 注册代码中的 SQS sender 关闭被注释；不能写成当前主传输。

## 4. opencreator-ai

- HTTP｜主链
  - `POST /v1/tasks`：创建 AI task。
  - `GET /v1/tasks/{ai_task_id}`：查询 task。
  - `POST /v1/provider-webhooks/{provider}`：厂商回调。
  - 源码：[`tasks.ts`](../../../../../opencreate/opencreator-ai/apps/api/src/routes/tasks.ts)、[`provider-webhooks.ts`](../../../../../opencreate/opencreator-ai/apps/api/src/routes/provider-webhooks.ts)。
- HTTP｜旁路
  - `POST /v1/media-face-verifications/enqueue`。
  - `/health`、`/readyz`。
  - Bull Board 仅在安全配置开关启用时作为运维入口。
  - 源码：[`media-face-verifications.ts`](../../../../../opencreate/opencreator-ai/apps/api/src/routes/media-face-verifications.ts)、[`bull-board.ts`](../../../../../opencreate/opencreator-ai/apps/api/src/plugins/bull-board.ts)。
- 非 HTTP｜主链
  - BullMQ：provider execution、artifact processing、consumer callback、media face verification；callback 失败可进 DLQ。
  - 源码：[`queues.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/queues.ts)、[`workers.ts`](../../../../../opencreate/opencreator-ai/packages/queues/src/workers.ts)。
- WebSocket / SSE
  - 无。
- HTTP｜未启用
  - 动态配置、飞书告警/通知、Bull Board 均需显式开关；provider 还需对应密钥。

## 5. opencreator-agent

- HTTP｜主链
  - `GET /v1/agent/models`。
  - `POST /v1/agent/runs`。
  - `POST /v1/agent/runs/cancel-by-request`。
  - `GET /v1/agent/sessions/{session_id}/active-run`。
  - `POST /v1/agent/runs/{run_id}/cancel`。
  - `POST /v1/agent/generation/confirm`、`POST /v1/agent/workflow/select`：HITL 恢复。
  - `GET /v1/agent/sessions`、`GET .../messages`、反馈 PUT/DELETE。
  - 源码：[`server.py`](../../../../../opencreate/opencreator-agent/creato/api/server.py)。
- SSE｜主链
  - `GET /v1/agent/runs/{run_id}/events`。
  - Redis Stream 回放与阻塞读取；过期 cursor 返回 HTTP 410 `RESUME_WINDOW_EXPIRED`；空闲时发 heartbeat comment。
  - 源码：[`server.py`](../../../../../opencreate/opencreator-agent/creato/api/server.py)、[`agent_redis_run_store.py`](../../../../../opencreate/opencreator-agent/creato/services/agent_redis_run_store.py)。
- HTTP｜旁路
  - `/health`、`GET /preview/active_runs`、`POST /preview/drain`。
- SSE｜兼容/未启用
  - `POST /v1/agent/chat` 与旧 stop 路径返回 410 `USE_AGENT_RUNS`。
- WebSocket
  - Agent 没有浏览器 Workflow WebSocket；其 workflow tool 会调用 Publisher/Consumer 主链。

## 6. 核心事件

### Workflow v2｜主链

- `start_flow`：run 开始。
- `node_status`：节点 `running/success/failed/select/...`。
- `start_running_llm_models`：一个模型节点开始提交一批 invocation。
- `llm_model_ready`：模型结果可选/可用。
- `llm_model_status`：模型执行状态。
- `finish_running_llm_models`：一个模型节点的 invocation 聚合结束。
- `finish_flow`：正常终态。
- `flow_killed`：取消终态。
- `workflow_error`：失败终态或 Publisher 归一化错误。

`flow_status`、`start_node`、`finish_node`、`node_time_out`、`exit_event_queue`
仍存在于类型或兼容代码中，但当前 Consumer 主发布链不依赖它们。

Consumer 先写 `flow_event_outbox`，经 RabbitMQ 到 Publisher；Publisher 先写 Event Store，再 ACK。源码：[`flow_event_publish_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)、[`mq.py`](../../../../../opencreate/opencreator-publisher/database/mq.py)。

### Workflow WS 控制事件｜主链

- Client → Server：`auth`、`attach_flow`、`ping`。
- Server → Client：`authenticated`、历史事件、`resume_ready`、`pong`、协议错误。
- cursor 是 Redis Stream ID；`event_id` 用于逻辑去重。

### Agent SSE｜主链

- 生命周期：`agent.started`、`run.completed`、`run.failed`、`run.cancelled`。
- 消息：`chat.message.created`、`chat.message.delta`、`chat.message.completed`、`chat.part.upsert`。
- 工具：`tool.started`、`tool.completed`、`tool.failed`。
- 状态/HITL：`session.state.updated`、`hitl.request`。
- Workflow bridge：`workflow.node_status`、`workflow.node_failed` 等。

事件常量：[`events.py`](../../../../../opencreate/opencreator-agent/creato/core/events.py)。

### 外部事件｜旁路

- Stripe：checkout、invoice、subscription、refund 等 webhook 事件。
- Clerk：session/user 生命周期。
- 飞书：`im.message.receive_v1`。
- Provider：各厂商 webhook，经 AI 归一化后 callback Consumer。
