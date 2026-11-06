# 17：社交发布、飞书与外部 Webhook

## 职责

- `opencreator-frontend` 只提供登录态、请求封装和社区外链；现码未见社交 OAuth/发布页面接入。
- `opencreator-publisher` 是 TikTok、YouTube、X 的 OAuth 与视频发布入口，也是飞书事件回调入口。
- `opencreator-consumer` 接模型回调并推进工作流；飞书主要用于告警，不负责社交账号授权。
- `opencreator-ai` 接厂商 webhook、回调 Consumer，并通过飞书机器人发模型调用/异常通知。
- `opencreator-agent` 负责 Agent/SSE；现码不在社交发布或飞书事件主链上。

## 入口

- 社交：Publisher `GET /generate_auth_url/{integration}`、`GET /callback/{integration}`、`POST /post_video`。
- 飞书入站：Publisher `POST /v1/feishu/event`，先处理 challenge/解密，再把业务处理放入 `BackgroundTasks`。
- 模型厂商入站：AI `/v1/provider-webhooks/*`；AI 出站回调是任务中保存的 `webhook_url`。
- 飞书出站：AI 的 `FeishuWebhookClient` 直接 POST 群机器人 URL。

## 主链

```text
用户 JWT
  → Publisher 生成 OAuth state，按 user_id 写 Redis（5 分钟）
  → 平台 callback 带 code + state
  → 校验并删除 state，交换 access_token / refresh_token
  → token 按 user_id 写 Redis
  → POST /post_video 并发调用各平台 Poster
```

```text
厂商 webhook → AI 验证/归一化 → BullMQ 后续处理
  → AI 用 consumerWebhookSecret 生成 HMAC
  → Consumer callback 快写/暂存 → Finalizer 推进工作流
```

飞书事件要求约 3 秒内应答，因此 Publisher 的 HTTP 200 仅表示已接收并安排后台任务；它不是业务处理完成 ACK。AI 回调只有 Consumer 返回 2xx 才算本次 HTTP 投递 ACK，失败会记录 delivery 并按队列策略重试。RabbitMQ ACK、Redis Stream ACK 不属于这条 HTTP webhook ACK。

## 关键状态/消息

- 凭证必须分开：用户 Clerk JWT；社交平台 OAuth `state`、`access_token`、`refresh_token`；飞书事件 `encrypt`/`FEISHU_ENCRYPT_KEY`；飞书机器人 URL 与签名 secret；AI API `auth_key`；AI→Consumer 的 `x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key`。
- 社交 token TTL：access token 约 23 小时，refresh token 约 364 天；这是缓存寿命，不代表平台授权必然仍有效。
- AI callback delivery 保存 attempt、HTTP 状态和响应摘要；`response.ok` 后才把 AI task 更新为最终成功/失败。
- 飞书机器人返回 HTTP 2xx 仍要检查 JSON `code == 0`；否则按拒绝处理。
- AI provider webhook 路由绕过 `auth_key`，安全性应由厂商回调校验承担，不能把“公开可达”解释成“无需验证”。

## 关键源码链接

- [Publisher 社交 OAuth 与发布](../../../../../opencreate/opencreator-publisher/controller/v1/social_auth.py)
- [TikTok Poster](../../../../../opencreate/opencreator-publisher/social/poster/tiktok_poster.py)
- [飞书事件入口](../../../../../opencreate/opencreator-publisher/controller/v1/feishu.py)
- [Consumer 模型回调处理](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)
- [AI 厂商 webhook 服务](../../../../../opencreate/opencreator-ai/packages/runtime/src/provider-webhook-service.ts)
- [AI 回调 Consumer](../../../../../opencreate/opencreator-ai/packages/runtime/src/consumer-callback.ts)
- [AI 飞书机器人客户端](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)
- [Frontend HTTP JWT 注入](../../../../../opencreate/opencreator-frontend/src/lib/useHttp.tsx)
- [Agent SSE 服务](../../../../../opencreate/opencreator-agent/creato/api/server.py)

## 跨仓边界

- Publisher 拥有用户社交授权与发帖动作；AI 的飞书是运维通知，不是用户社交发布。
- AI 只把规范化模型结果回调 Consumer；Consumer 才拥有 DAG、节点、计费收敛。
- Frontend 不应持久化社交 access/refresh token；Agent 也不应绕过 Publisher 直接代用户发帖。
- 外部 HTTP 2xx 只确认这一跳，不能代替 Consumer Finalizer、Outbox、RabbitMQ 或浏览器消费完成。

## 遗留/未启用

- Frontend 现码未见调用 Publisher 社交授权/发帖 API，能力可能尚未接入产品 UI。
- Publisher 的 `/social_auth/webhooks/{integration}` 现码仅返回 `ok`，不是完整平台事件处理器。
- `post_video` 用进程内 `asyncio.gather`，未见社交发布 outbox、稳定幂等键或持久化补偿；超时后重试可能产生重复发布。
- Publisher 飞书事件使用进程内 `BackgroundTasks`，先 ACK 后处理存在进程退出丢任务窗口。
- Agent 未接入此链；不要把 Agent 的外部工具调用能力写成已支持社交发布。
