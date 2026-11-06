# 社交发布、飞书与外部 Webhook：这里面有哪些技术点

先把这块拆开。画布跑完不会自动发到 TikTok。飞书群机器人也不是用户的社交账号。这篇只讲 Publisher 里的社交授权发帖、飞书入站运营命令，以及各仓打到飞书或 Lark 群的出站通知。

先背一句话：

```text
社交授权和发帖留在 Publisher，token 只进 Redis；
飞书入站先回 200，再在本进程后台改等级或加积分；
出站通知各自打自己的机器人 URL，HTTP 200 之后还要看 JSON code == 0。
```

Clerk 建会话、Stripe 入账、厂商 Webhook、AI 回调 Consumer，只在最后一节标出验签和 ACK，避免和这三条链混用。Stripe 看 [支付订阅积分与用量账本](../01-支付订阅积分与用量账本/00-支付订阅积分与用量账本技术点.md)。厂商和 Consumer 回调看 [AI提交轮询Webhook产物与回调](../../03-AI网关/03-AI提交轮询Webhook产物与回调/01-AI提交轮询Webhook产物与回调.md)。

社交最短链路是：

```text
已登录用户
  → GET /api/v1/social_auth/generate_auth_url/{integration}
  → Publisher 生成 state，按 user_id 写入 Redis（5 分钟）
  → 浏览器去平台授权
  → 平台把 code + state 带回 redirect_uri
  → 前端再带 Clerk JWT 调 GET /callback/{integration}
  → 对上 state 后删掉，换 access_token / refresh_token
  → token 按 user_id 写入 Redis
  → POST /post_video 按平台并发调用 Poster
```

飞书入站最短链路是：

```text
飞书 POST /api/v1/feishu/event
  → 有 encrypt 就先解密
  → url_verification 直接回 challenge
  → HTTP 200
  → BackgroundTasks 里验 token、按 event_id 去重
  → im.message.receive_v1
  → 改等级或加积分
  → 群机器人回执
```

所以社交换票、飞书入站命令、飞书出站通知，是三件事。模型结果回到画布，走的是 AI 网关和 workflow 事件，不经过这三条。

这篇的边界固定：

- Frontend 现码没有社交授权页，也没有发帖页。导航里的飞书链接是文档站，不走 OAuth。
- 社交 token 只放在 Publisher 的 Redis。浏览器只在换票那一次请求里带 Clerk JWT。
- 飞书入站改的是等级和充值积分。出站只发通知。两条都不创建平台授权。
- 管理后台自己的飞书登录在 `opencreator-admin-next`，不进 Publisher 的 `/feishu/event`。

---

## 1. 授权 URL 绑的是当前登录用户

OpenCreator 对照：

- [social_auth.py](../../../../../opencreate/opencreator-publisher/controller/v1/social_auth.py)

`generate_auth_url`、`callback`、`post_video` 都要 `get_authenticated_user`。路由上还挂了 `get_api_key`，它只读取 `Authorization`，并且 `auto_error=False`，不会单独挡人。真正挡未登录请求的是认证中间件。平台名只有三个：

```text
tiktok
youtube
x
```

服务端自己生成 `state = os.urandom(16).hex()`，调用方只传 `redirect_uri`。`state` 写在：

```text
opencreator:social_auth:{integration}:{user_id}
```

TTL 是 5 分钟。同一个用户、同一个平台，后一次授权会盖掉前一次 state。

`redirect_uri` 是平台把浏览器带回的地址，现码由调用方传入，Publisher 不把它做成固定配置。换票时必须再带同一个 `redirect_uri`，否则平台对不上这次 code。

---

## 2. 平台跳转和 Publisher 换票不是同一次请求

TikTok、Google、X 把 `code` 和 `state` 送到 `redirect_uri`。Publisher 的 `/callback/{integration}` 不在认证白名单里，仍然要 Clerk JWT。

所以现码的换票是：

```text
平台浏览器跳转
  → 前端页面拿到 code、state
  → 前端用当前用户的 JWT 调 Publisher callback
  → 用 JWT.sub 拼 Redis key，比对 state
```

对不上就返回失败，不换 token，也不删 Redis。对上之后先删 state，再向平台换 token。换票若在删除之后失败，这次 state 已经没了，用户要重新走授权。

Frontend 现码没有调用 `generate_auth_url`、`callback` 或 `post_video`。这条 API 在 Publisher 里是通的，产品页面还没接上。

---

## 3. token 按用户和平台分开存

换票成功后写入两把 Redis key：

```text
opencreator:access_token:{integration}:{user_id}     约 23 小时
opencreator:refresh_token:{integration}:{user_id}    约 364 天
```

OpenCreator 对照：[redis_keys.py](../../../../../opencreate/opencreator-publisher/social/provider/__base/redis_keys.py)。

这是缓存寿命。平台那边的授权被用户取消、或 refresh token 已失效时，Redis 里仍可能有值。Poster 发帖时只读 access token，读不到就直接失败。

三个 Provider 都实现了 `refresh_token()`，发帖路径没有调用它。access token 过期后，现码不会自动刷新，要用户重新授权。

X 的授权 URL 里 PKCE 现码写成固定值：

```text
code_challenge = "challenge"
code_challenge_method = "plain"
code_verifier = "challenge"
```

这是占位，不能当成已经按用户生成的 PKCE。

---

## 4. 三个平台的发帖方式不一样

`POST /post_video` 的 body 是 `post_items`。每一项有 `integration`、`text`、`description`、`video_url`，schema 里还有可选 `result_id`。路由处理时没有用 `result_id` 做权限或订阅校验。

OpenCreator 对照：

- [social_post_request.py](../../../../../opencreate/opencreator-publisher/schemas/request_schemas/socialmedia_publish/social_post_request.py)
- [tiktok_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/tiktok_poster.py)
- [youtube_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/youtube_poster.py)
- [x_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/x_poster.py)

| 平台 | 视频怎么上去 | 现码默认可见性 |
| --- | --- | --- |
| TikTok | 平台按 URL 拉取，`PULL_FROM_URL` | `SELF_ONLY` |
| YouTube | Publisher 先下载到临时文件，再 resumable upload | `private` |
| X | Publisher 下载后分段上传，再发带 `media_ids` 的帖 | 发出即公开帖 |

TikTok 不把视频字节拉进 Publisher。YouTube 和 X 会。一次请求里的多个 `post_items` 用 `asyncio.gather` 在本进程并发发完，全部成功才返回成功。没有社交发布 outbox，也没有按视频或平台生成的幂等键。超时后客户端重试，可能在平台侧重复发帖。

---

## 5. 社交平台 Webhook 入口只回 ok

```text
GET /api/v1/social_auth/webhooks/{integration}
```

这条在认证白名单里，不要求 Clerk JWT。处理函数只打日志并返回 `ok`，不验平台签名，也不更新 token 或发帖状态。

白名单只放开了 `webhooks/*`。`generate_auth_url`、`callback`、`post_video` 仍走登录用户。

---

## 6. 飞书入站先在约 3 秒内应答

OpenCreator 对照：[feishu.py](../../../../../opencreate/opencreator-publisher/controller/v1/feishu.py)。

路由是 `POST /api/v1/feishu/event`，挂在 `/feishu` 下，整段 `/v1/feishu/*` 都在认证白名单里。它不验 Clerk JWT。

请求体如果带 `encrypt`，先用 `FEISHU_ENCRYPT_KEY` 解密：

```text
key = SHA256(encrypt_key)
AES-256-CBC
前 16 字节是 IV
PKCS7
```

解密失败返回 `code: 1`，不进后台任务。

`type == url_verification` 时立刻返回：

```text
{"challenge": challenge}
```

其余事件解析成 `FeishuEventCallback` 后，放进 FastAPI `BackgroundTasks`，HTTP 层马上返回：

```text
{"code": 0, "msg": "success"}
```

这个 200 只表示 Publisher 收下了请求。后台加积分、改等级还没做完。任务在当前进程里跑，进程退出时，还没执行的后台任务会丢。这里没有队列，也没有 outbox。

---

## 7. 飞书事件靠 token 和 event_id

后台处理在 [feishu_event_service.py](../../../../../opencreate/opencreator-publisher/services/feishu/feishu_event_service.py)。

`header.token` 要等于 `FEISHU_VERIFICATION_TOKEN`。这个配置为空时，现码会跳过校验并打警告。加密和 token 是两道不同的检查，不能互相代替。

去重 key：

```text
feishu:event:dedup:{event_id}
```

用 Redis `SET NX`，TTL 8 小时，覆盖飞书大约 7.1 小时的重试窗口。key 在业务成功之前就占上。同一 `event_id` 再来会直接跳过。占坑之后处理失败，飞书重试也不会再跑一遍。未识别的 `event_type` 同样会先占坑，再只记日志。

token 校验失败发生在占坑之前，同一次事件仍可重试。现码只处理 `im.message.receive_v1`。

消息过滤：

- `sender_type == app`：机器人自己的消息，跳过，避免回环。
- 非 `text`：跳过。
- 没有 `mentions`：跳过。
- 文本对不上命令：跳过，不回格式说明。`send_format_error_message()` 写了，这条路径没有调用它。

---

## 8. 入站只有两条运营命令

解析在 [feishu_message_parser.py](../../../../../opencreate/opencreator-publisher/services/feishu/feishu_message_parser.py)。邮箱可以是明文，也可以是飞书点出来的 Markdown 链接，只取方括号里看得见的地址。

先匹配改等级：

```text
email=用户邮箱 plan=pro|creator|starter
```

等级映射是：

```text
starter → system_level 1
creator → system_level 2
pro     → system_level 3
```

对上之后按邮箱找用户，调用 `UserService.update_user_system_level()`。这条命令没有单独的业务幂等键，重复执行靠前面的 `event_id` 去重。

没对上再匹配加积分。命令文本里的备注字段是 `remake`：

```text
email=用户邮箱 credits=数量 remake=备注
```

积分必须大于 0，备注不能空。单次上限是 `FEISHU_MAX_CREDITS_PER_OPERATION`，没配时按 1,000,000。入账走 `UnifiedCreditsService.add_topup_credits()`，`source=feishu_bot`，幂等键是 `feishu_{message_id}`。这一步自己会写收支记录，`event_type=feishu_topup`。成功后事件服务再写一条 admin 用的 `credits_topup_record`，`topup_source=feishu`。

两笔记账都在统一积分入账之后。后一条写失败时，积分已经加上，`event_id` 也已经占坑。付款入账仍走支付那一篇，只是三池和幂等锁是同一套。

成功或失败都由 [feishu_bot_service.py](../../../../../opencreate/opencreator-publisher/services/feishu/feishu_bot_service.py) 用 `FEISHU_BOT_WEBHOOK` 回群。这个回执不带签名字段。HTTP 200 之后还要看 JSON `code == 0`。

---

## 9. 出站飞书是多条机器人，互不相通

| 谁发 | 什么时候 | 消息 | 成功标准 |
| --- | --- | --- | --- |
| Publisher `FeishuBotService` | 入站命令做完 | 文本回执 | HTTP 200 且 `code == 0` |
| Publisher / Consumer `B2B` 客户端 | 升单信号命中 | interactive card | 同上，并写下 notification 状态 |
| Publisher `lark_notify` | 定制工作流订单付完 | Lark interactive card | 发送失败只记日志，订单仍是 completed |
| AI `FeishuWebhookClient` | 模型调用通知、告警、未知 reason | text，可带签名 | HTTP 200 且 `code == 0` |
| Consumer `feishu_notify` | 运行时异常 | 先卡片，失败再退回文本 | 余额不足类文案直接不发 |

AI 侧签名在 [feishu-webhook-client.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)。配了 `secret` 才加 `timestamp` 和 `sign`：

```text
HMAC-SHA256
key = timestamp + "\n" + secret
签名内容为空字符串
结果 Base64
```

模型调用通知先 `claimModelCallNotification(ai_task_id)`，认领不到就不发。未知 reason 和告警是另外的 webhook URL，在 worker 启动时各自建一个 client。

B2B 卡片按 `user_id:signal.key` 认领。`sent` 和还在 `sending` 的记录不会再发。状态是 `failed` 时，下次评估可以重新认领再发。`feishu_immediate` 当时就发。`feishu_conditional` 先落一条到期动作，到期且用户还没自己升级，才发一次。Publisher 和 Consumer 各有一份同构客户端，打的是同一个机器人 URL。

定制订单通知打的是 `open.larksuite.com` 的 Lark 机器人，和飞书国内机器人 URL 不是同一个配置。订单已经写成 `completed` 之后才发，通知失败不把订单改回未完成。

Consumer 告警会挡住包含 `Insufficient credits`、`error_code 3003`、`notify_code 3003` 的消息。

---

## 10. 其它外部 Webhook 只核对入口，不在这里重写

这些请求不读社交 token，也不用飞书 `event_id`。验签材料不能互换。

| 入口 | 凭什么收下 | 200 表示什么 | 写在哪一篇 |
| --- | --- | --- | --- |
| `POST /api/v3/webhooks/clerk` | Svix 头 + `CLERK_WEBHOOK_SECRET` 验原始 body | 签过的 `session.created` 已记录。现码不再踢掉其它 session，`revoked_count` 为 0 | [登录与JWT](../../01-用户入口/01-登录与JWT/01-登录与JWT.md) |
| `POST /api/v1/user/create` | 登录白名单里的 `user.created` | 开始建用户、绑邀请、发欢迎积分 | 同上 |
| `POST /api/v1/payments/webhook` | Stripe 签名 | 事件已验签。积分是否到账看处理器 | 支付那一篇 |
| `AI /v1/provider-webhooks/*` | 厂商自己的回调校验，不走 AI `auth_key` | 厂商事件已进入归一化 | AI 网关那一篇 |
| AI → Consumer `webhook_url` | `x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key` | Consumer 收下了这一跳 HTTP。画布节点还要等 workflow 事件 | AI 网关那一篇 |

飞书机器人的 `sign` 是 `timestamp + "\n" + secret` 的 HMAC。它验不了 Consumer 那一跳，也验不了 Clerk 或 Stripe。RabbitMQ ACK、Redis Stream ACK 同样不是这几次 HTTP 应答。

---

## 动手前要有的东西

### 社交发布

- Clerk JWT 能验出 `user_id`
- Redis
- TikTok、YouTube、X 的 client id / secret
- 调用方能提供与授权时一致的 `redirect_uri`

### 飞书入站

- `FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_BOT_WEBHOOK`
- 按邮箱查用户、改 `system_level`
- `UnifiedCreditsService.add_topup_credits()` 和充值记录

### 出站通知

- 各机器人 URL 分开配置
- AI 任务上有模型调用通知的认领字段
- B2B 信号和 notification 集合
- 定制订单在通知前已经完成

登录看 [登录与JWT](../../01-用户入口/01-登录与JWT/01-登录与JWT.md)。外部程序用 `sk_` 跑工作流看 [Developer API 与 CLI](../02-Developer-API与CLI/16-Developer-API与CLI.md)，那条入口不发社交帖，也不收飞书事件。
