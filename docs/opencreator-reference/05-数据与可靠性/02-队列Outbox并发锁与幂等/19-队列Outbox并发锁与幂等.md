# 19：队列、Outbox、并发锁与幂等

## 职责

- `opencreator-frontend` 为一次用户意图生成稳定 `command_id`，并按 `event_id` 抑制本地重复副作用。
- `opencreator-publisher` 持久化命令、派发 Redis Stream，并消费 RabbitMQ 结果写 Event Store。
- `opencreator-consumer` 用 durable Inbox、CAS/lease 推进 DAG，并用 Outbox 至少一次发布结果。
- `opencreator-ai` 用 BullMQ 拆分 provider、artifact、callback worker，并用数据库唯一键吸收重复任务/事件。
- `opencreator-agent` 有独立 Agent run/SSE 与 workflow publisher，不是画布 Consumer Outbox 的参与者。

## 入口

- 前端 `POST /api/v2/flow/runs` 携带 journal 中稳定的命令 ID。
- Publisher dispatcher 把命令写入 Redis Stream `run_flow`。
- Consumer `claim_command` 先占 Inbox，再执行；维护任务可把过期命令重新入队。
- Consumer Outbox 发布到 RabbitMQ v2 reply queue；Publisher 消费并在持久化事件后 ACK。
- AI `/v1/tasks` 入队 BullMQ，worker 分阶段处理并通过签名 HTTP callback 回 Consumer。

## 主链

```text
Frontend command_id
  → Publisher workflow_command
  → Redis Stream
  → Consumer Inbox(command_id + payload_hash + lease)
  → run/node/invocation CAS
  → Outbox(event_id + publish lease)
  → RabbitMQ
  → Publisher Event Store(event_id)
  → RabbitMQ ACK
  → WebSocket cursor → Frontend handler
```

并发控制不是一把全局锁：Inbox 用命令 lease，节点/Finalizer 用条件更新，Outbox 用 publish lease，维护调度另有 Redis 锁，Frontend 跨 tab 副作用优先用 Web Locks。

## 关键状态/消息

- Inbox：`processing → completed/failed`；相同 `command_id` 但 identity/payload hash 不同是 conflict，不是重试。
- Outbox：`pending/failed/lease-expired publishing → publishing → sent`；发送成功但未标 `sent` 会重投，靠稳定 `event_id` 去重。
- ACK 分层：Redis Stream ACK 只确认命令 transport；RabbitMQ ACK 必须在 Publisher Event Store 落盘后；AI callback 2xx 只确认 Consumer 接收；WebSocket cursor 只确认客户端已处理到哪。
- 幂等分层：命令 `command_id`、AI task `idempotency_key`、provider event 三元组、工作流 `event_id`、浏览器 `event_id + scope`。
- 凭证分层：用户 JWT 不能替代 AI `auth_key`；AI callback HMAC 不能替代 broker ACL；队列 ACK 不是鉴权。

## 关键源码链接

- [Frontend 命令 journal](../../../../../opencreate/opencreator-frontend/src/lib/workflow-command-journal.ts)
- [Frontend 副作用 claim](../../../../../opencreate/opencreator-frontend/src/lib/workflow-side-effect-claim.ts)
- [Publisher 命令与运行服务](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)
- [Publisher RabbitMQ 接入](../../../../../opencreate/opencreator-publisher/database/mq.py)
- [Consumer Inbox](../../../../../opencreate/opencreator-consumer/services/workflow/flow_command_inbox_service.py)
- [Consumer Outbox](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)
- [Consumer 队列入口](../../../../../opencreate/opencreator-consumer/tasks/flow.py)
- [AI 队列/Worker 装配](../../../../../opencreate/opencreator-ai/apps/worker/src/main.ts)
- [AI 数据库唯一索引](../../../../../opencreate/opencreator-ai/packages/db/src/mongo.ts)
- [Agent workflow publisher](../../../../../opencreate/opencreator-agent/creato/workflow/task_publisher.py)

## 跨仓边界

- Publisher 负责用户命令受理和结果入站；Consumer 负责业务执行与 Outbox；两者之间没有跨 Mongo/RabbitMQ 的大事务。
- AI 的 BullMQ job 完成不代表 Consumer 节点完成；必须经过签名 callback 与 Finalizer。
- Frontend 的 journal 只能稳定重试意图，不能替代服务端唯一索引。
- Agent 有自己的运行恢复与 SSE 语义，不能复用画布 WebSocket cursor 作为 Agent ACK。

## 遗留/未启用

- Consumer 类名写着 transactional outbox，但状态写入与 Outbox 插入未使用同一 Mongo session；仍存在 state→outbox 窗口。
- 语义是至少一次，不是 exactly-once；所有外部副作用仍需业务幂等。
- Frontend 在不支持 Web Locks 时仅用 localStorage best-effort claim，跨 tab 不是严格原子。
- AI callback 每次投递生成新的 `x-oc-idempotency-key`；真正业务去重还应依赖 `ai_task_id`/provider identity，不能只依赖该 header。
- Agent 不接入 Consumer Inbox/Outbox 主链；两套可靠性模型目前并存。
