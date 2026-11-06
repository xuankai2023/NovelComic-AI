# OpenCreator 是怎么做社交发布、飞书与外部 Webhook 的

如果要看机制拆解，读 [00-社交发布飞书与外部Webhook技术点.md](./00-社交发布飞书与外部Webhook技术点.md)。如果要按 NovelComic 的实现顺序落文件，读 [02.文件编写顺序.md](./02.文件编写顺序.md)。

## 一、先说结论

OpenCreator 把用户发视频、飞书运营命令、运维通知、以及其它平台打进来的 HTTP，分成多条入口。它们可以都叫 webhook，应答规则并不共用。

```text
社交
  登录用户要授权 URL
    → Redis 记下 state
    → 平台跳回 redirect_uri
    → 同一用户带 JWT 换 token
    → Redis 记下 access / refresh
    → post_video 并发发到各平台

飞书入站
  POST /feishu/event
    → 解密或明文
    → challenge 立即返回
    → 200 之后后台处理命令

飞书出站
  命令回执、B2B 卡片、Lark 订单、AI 告警、Consumer 异常
    → 各自的机器人 URL
    → HTTP 200 且 JSON code == 0
```

必须分清五件事：

- 社交 OAuth：Clerk 用户和平台 token 的对应关系，存在 Publisher Redis。
- 社交发帖：拿已有 access token 调 TikTok、YouTube、X。现码没有发布任务表。
- 飞书入站：运营在群里 @ 机器人，改等级或加积分。HTTP 200 先于业务完成。
- 飞书出站：系统主动发通知。`sent` 不再发，`failed` 还可以再认领。
- 其它外部 Webhook：Clerk、Stripe、厂商、AI→Consumer 留在原入口。本组只核对验签没有串。

Frontend 现码不调用社交 API。Agent 现码也不代用户发帖。

---

## 二、社交发布必须有的文件

按一次授权再发帖的依赖来背。

1. `social/provider/__base/redis_keys.py`：state、access token、refresh token 的 key。
2. `social/provider/base_provider.py`：授权 URL、换票、刷新三个抽象方法。
3. `social/provider/tiktok_provider.py`、`youtube_provider.py`、`x_provider.py`：三个平台的 OAuth。
4. `schemas/request_schemas/socialmedia_publish/social_post_request.py`：发帖 body。
5. `controller/v1/social_auth.py`：授权、回调换票、发帖、平台 webhook 空入口。
6. `social/poster/base_poster.py` 和三个 Poster：真正把视频发出去。
7. `controller/routers.py`：挂到 `/api/v1/social_auth`。
8. `middleware/auth_middleware.py`：只把 `webhooks/*` 放进白名单。

### `social/provider/__base/redis_keys.py`

OpenCreator 源码：[redis_keys.py](../../../../../opencreate/opencreator-publisher/social/provider/__base/redis_keys.py)

三个平台各三把前缀：

```text
opencreator:social_auth:{tiktok|youtube|x}:
opencreator:access_token:{tiktok|youtube|x}:
opencreator:refresh_token:{tiktok|youtube|x}:
```

后面拼 `user_id`。state、access、refresh 不能混用同一把 key。

### `social/provider/base_provider.py`

OpenCreator 源码：[base_provider.py](../../../../../opencreate/opencreator-publisher/social/provider/base_provider.py)

每个平台要实现：

```text
gen_auth_url(redirect_uri, state)
get_token(code, redirect_uri)
refresh_token(refresh_token)
```

`build_url()` 只负责把参数编码进查询串。

### 三个 Provider

OpenCreator 源码：

- [tiktok_provider.py](../../../../../opencreate/opencreator-publisher/social/provider/tiktok_provider.py)
- [youtube_provider.py](../../../../../opencreate/opencreator-publisher/social/provider/youtube_provider.py)
- [x_provider.py](../../../../../opencreate/opencreator-publisher/social/provider/x_provider.py)

TikTok 授权地址是 `https://www.tiktok.com/v2/auth/authorize/`，scope 含 `video.publish` 和 `video.upload`。换票打 `https://open.tiktokapis.com/v2/oauth/token/`。

YouTube 走 Google OAuth。scope 是 `youtube.upload` 和 `userinfo.profile`。为了拿到 refresh token，授权参数带 `access_type=offline` 和 `prompt=consent`。

X 走 `https://x.com/i/oauth2/authorize`，scope 含 `tweet.write`、`media.write`、`offline.access`。换票用 client id/secret 做 Basic。PKCE 的 challenge 和 verifier 现码都是固定字符串 `challenge`。

### `controller/v1/social_auth.py`

OpenCreator 源码：[social_auth.py](../../../../../opencreate/opencreator-publisher/controller/v1/social_auth.py)

四个入口：

```text
GET  /generate_auth_url/{integration}   要登录
GET  /callback/{integration}            要登录
POST /post_video                        要登录
GET  /webhooks/{integration}            白名单，只回 ok
```

授权时：

```text
state = os.urandom(16).hex()
SET ex 300  social_auth key = state
返回 auth_url
```

换票时：

```text
GET Redis state
比对 query state
不相等 → 失败，保留 Redis
相等 → DELETE state
provider.get_token(code, redirect_uri)
SET ex 23h   access token
SET ex 364d  refresh token
```

发帖时对 `post_items` 做 `asyncio.gather`。未知平台或任一 Poster 抛错，整次请求失败。没有把部分平台的成功单独记下来。

路由装配在 [routers.py](../../../../../opencreate/opencreator-publisher/controller/routers.py)，前缀 `/social_auth`，再挂到 v1。这一层的 `get_api_key` 不验密钥。白名单在 [auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py) 只包含 `v1/social_auth/webhooks/*`。

### Poster

OpenCreator 源码：

- [tiktok_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/tiktok_poster.py)
- [youtube_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/youtube_poster.py)
- [x_poster.py](../../../../../opencreate/opencreator-publisher/social/poster/x_poster.py)

三者都从 Redis 读当前用户的 access token，没有则抛错。

TikTok 先查 creator info，再 `post/publish/video/init`，`source=PULL_FROM_URL`，`privacy_level=SELF_ONLY`。

YouTube 用 resumable upload。先 POST 拿 `Location`，再把 `a_download_tmp_file()` 下载的字节 PUT 上去。默认 `privacyStatus=private`。

X 先 initialize / append / finalize 上传视频，分段 2MB，再 `POST https://api.twitter.com/2/tweets`，body 里带 `media_ids`。

---

## 三、飞书入站必须有的文件

1. `schemas/feishu.py`：事件、消息、两条命令的形状。
2. `services/feishu/feishu_decrypt.py`：加密 body 解密。
3. `controller/v1/feishu.py`：HTTP 入口，先应答。
4. `services/feishu/feishu_message_parser.py`：从文本里抽出命令。
5. `services/feishu/feishu_event_service.py`：验 token、去重、执行命令。
6. `services/feishu/feishu_bot_service.py`：把结果发回群。
7. `controller/routers.py` 与认证白名单：`/v1/feishu/*` 不走 Clerk。

### `schemas/feishu.py`

OpenCreator 源码：[feishu.py](../../../../../opencreate/opencreator-publisher/schemas/feishu.py)

`FeishuEventCallback` 同时容纳 URL 校验字段和事件字段：`challenge`、`type`、`header`、`event`。消息事件拆成 sender、message、mentions。命令模型是 `UpdatePlanCommand` 和 `AddCreditsCommand`。

### `controller/v1/feishu.py`

OpenCreator 源码：[feishu.py](../../../../../opencreate/opencreator-publisher/controller/v1/feishu.py)

```text
request.json()
  → body 含 encrypt 则 decrypt_feishu_payload()
  → url_verification 返回 {"challenge"}
  → FeishuEventCallback(**payload)
  → background_tasks.add_task(handle_event_callback)
  → {"code": 0, "msg": "success"}
```

解密失败或 JSON 异常返回 `code: 1`。飞书要求大约 3 秒内应答，所以业务不放在返回之前。

### `feishu_event_service.py`

OpenCreator 源码：[feishu_event_service.py](../../../../../opencreate/opencreator-publisher/services/feishu/feishu_event_service.py)

```text
验 header.token
  → SET NX feishu:event:dedup:{event_id}  EX 8h
  → 已存在则跳过
  → im.message.receive_v1
  → 丢掉机器人自己的消息、非文本、没有 @
  → parse_update_plan_message()
  → 否则 parse_add_credits_message()
```

改等级调用 `UserService.update_user_system_level()`。加积分调用 `UnifiedCreditsService.add_topup_credits()`，幂等键 `feishu_{message_id}`。统一积分服务会写 `credits_inout_record`，`event_type=feishu_topup`。事件服务随后再写 admin 的 `CreditsTopupRecord`。后一条失败时，积分和 `event_id` 占坑都已经发生。

### `feishu_message_parser.py` 与 `feishu_bot_service.py`

解析器认这两种文本：

```text
email=... plan=pro|creator|starter
email=... credits=数字 remake=备注
```

`plan` 映射到 `system_level` 的 `3 / 2 / 1`。邮箱若是 `[name](mailto:...)`，只用方括号内的显示文本。

回执客户端把文本 POST 到 `FEISHU_BOT_WEBHOOK`。不附加 timestamp/sign。`status_code == 200` 且 `code == 0` 才当成功。

---

## 四、飞书出站必须有的文件

这些文件不读取社交 token，也不处理飞书入站事件。

1. `opencreator-ai/packages/runtime/src/feishu-webhook-client.ts`：通用文本机器人，可选签名。
2. `model-call-notifier.ts`、`feishu-notifier.ts`：模型调用和未知 reason。
3. `apps/worker/src/main.ts`：把告警 client 和模型调用 client 装进 worker。
4. `opencreator-consumer/utils/feishu.py`：Consumer 运行时告警。
5. `services/b2b_signal/feishu_client.py` 与 `service.py`：升单卡片。Publisher、Consumer 各一份。
6. `utils/lark_notify.py`：定制工作流订单付完后的 Lark 卡片。

### AI `FeishuWebhookClient`

OpenCreator 源码：[feishu-webhook-client.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-webhook-client.ts)

`enabled === false` 或没有 `webhookUrl` 时直接返回。文本最长约 8000 字，超出截断。有 `secret` 时 body 增加：

```text
timestamp
sign = Base64(HMAC-SHA256(key=timestamp + "\n" + secret, message=""))
msg_type = text
```

HTTP 非 2xx，或 JSON `code` 不是 0，都当发送失败。

[model-call-notifier.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/model-call-notifier.ts) 发之前先认领 `ai_task_id`。认领失败说明这次任务已经通知过。[feishu-notifier.ts](../../../../../opencreate/opencreator-ai/packages/runtime/src/feishu-notifier.ts) 把未匹配的 provider reason 发到另一条 URL。worker 里告警用的是第三份 client，配置在 `config.alert.feishu`。

### Consumer 告警

OpenCreator 源码：[feishu.py](../../../../../opencreate/opencreator-consumer/utils/feishu.py)

`feishu_notify()` 先看文案是否含余额不足关键字，含有则不发。其余先发 interactive card，失败再发 text。`feishu_warring_notify()` 给出厂调用失败用，消息前加「警告」。

Webhook 取 `FEISHU_NOTIFY_BOT_WEBHOOK_URL`，空则退回 `FEISHU_NOTIFY_BOT_WEBHOOK`。

### B2B 卡片

OpenCreator 源码：

- [feishu_client.py](../../../../../opencreate/opencreator-publisher/services/b2b_signal/feishu_client.py)
- [service.py](../../../../../opencreate/opencreator-publisher/services/b2b_signal/service.py)

`build_feishu_interactive_card()` 把信号优先级、邮箱、活跃、付款、剩余积分、PostHog 链接放进卡片。发送前用 notification id `user_id:signal.key` 认领。`sent` 和 `sending` 不会再发。`failed` 允许下次重新认领。发出后把状态写成 `sent` 或 `failed`，并留下飞书响应。

立即发送和延迟发送是两种系统动作。延迟动作到期时，若这段时间用户已经自己完成订阅升级，就不再发卡片。

Consumer 的 `services/b2b_signal/` 是同一套结构，不要再做第三种卡片格式。

### 定制订单 Lark

OpenCreator 源码：[lark_notify.py](../../../../../opencreate/opencreator-publisher/utils/lark_notify.py)

[custom_workflow.py](../../../../../opencreate/opencreator-publisher/services/custom_workflow.py) 在订单 `pay_result=completed` 写库之后调用 `send_custom_workflow_order_notification()`。目标是 Larksuite 机器人。通知异常被吃掉，只留错误日志。

---

## 五、其它外部 Webhook 留在原入口

本组文件清单不包含 Clerk、Stripe、厂商 Webhook 和 Consumer 回调的实现。对照表在 [00 的第 10 节](./00-社交发布飞书与外部Webhook技术点.md)。这里只记住三份源码的归属：

- Clerk 会话：[clerk_webhook.py](../../../../../opencreate/opencreator-publisher/controller/v3/clerk_webhook.py)，验 Svix，`session.created` 只记录，`revoked_count` 为 0。
- Clerk 建用户：[user.py](../../../../../opencreate/opencreator-publisher/controller/v1/user.py) 的 `POST /create`，属于登录链路。
- Stripe 与 AI 回调分别留在支付篇和 [AI提交轮询Webhook产物与回调](../../03-AI网关/03-AI提交轮询Webhook产物与回调/01-AI提交轮询Webhook产物与回调.md)。

飞书 `sign` 验不了 Consumer 的 `x-oc-signature`。

---

## 六、跨仓边界

- Publisher 拥有社交 state、平台 token 和发帖动作。
- Frontend 只应在做完产品页之后，用 Clerk JWT 调这几个接口，不保存 access token。
- Agent 不绕过 Publisher 发帖。
- 飞书入站改的是用户等级和充值积分，不创建社交授权。
- AI、Consumer、B2B、Lark 订单通知可以同时存在，URL 和认领键都要分开。
- 外部 HTTP 2xx 只确认这一跳。飞书还要 `code == 0`。Consumer 2xx 之后，画布亮灯仍走 workflow 事件。

---

## 七、和 NovelComic 对照

NovelComic 当前还没有社交发帖页，也没有飞书入站命令。Clerk 登录、Redis、按邮箱查用户、统一加积分如果还没接上，发帖和飞书命令都不要先写。

迁移时不要从群机器人回执或告警文案开始。顺序应该是：

1. 先有 Clerk JWT 和 Redis。
2. 再落社交 state、换票和三个 Poster。
3. 再落飞书解密、challenge、去重、改等级和加积分。
4. 再接 AI、Consumer、B2B、Lark 出站，每条用自己的 URL。
5. Clerk、Stripe、厂商回调留在各自已经有的入口，不搬进飞书事件服务。

如果只有飞书回执，用户还不能发视频。如果 `post_video` 返回成功，也还没有发布任务表或失败补偿。文件顺序见 [02.文件编写顺序.md](./02.文件编写顺序.md)。
