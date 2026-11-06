# 社交发布、飞书与外部 Webhook question

## 核心概念

- 这一组讲的是什么？
  - 只讲 Publisher 里的社交授权发帖、飞书入站运营命令，以及各仓打到飞书或 Lark 群的出站通知。
  - 它不讲 Stripe 怎么入账。
  - 它也不讲厂商 Webhook 怎么收成 `ProviderResult`，也不讲 AI 怎么 HMAC 投递给 Consumer。

- 为什么要先背一句话？
  - 社交 token 只进 Publisher 的 Redis。
  - 飞书入站先回 200，再在本进程后台改等级或加积分。
  - 出站各自打自己的机器人 URL，HTTP 200 之后还要看 `code == 0`。

- 五件事怎么分？
  - 社交 OAuth：把平台 token 绑到当前 Clerk 用户。
  - 社交发帖：用已有 access token 调 TikTok、YouTube、X。
  - 飞书入站：群里 @ 机器人，改等级或加充值积分。
  - 飞书出站：系统主动发通知。
  - 其它外部 Webhook：Clerk、Stripe、厂商、AI→Consumer，留在原入口。

- 最短链路是什么？
  - 社交：登录用户要授权 URL → Redis 记 5 分钟 state → 平台带回 code → 同一用户带 JWT 换票 → `POST /post_video`。
  - 飞书：`POST /feishu/event` → 解密或明文 → challenge 立即返回 → 200 之后后台执行命令。

## 社交授权和发帖

- 授权 URL 绑的是谁？
  - 当前登录用户。
  - 服务端生成 `state`，调用方只传 `redirect_uri`。
  - key 是 `opencreator:social_auth:{integration}:{user_id}`，TTL 5 分钟。
  - 同一用户、同一平台，后一次授权盖掉前一次 state。

- 平台跳转为什么还不等于换票？
  - 平台把 code 送到 `redirect_uri`。
  - Publisher 的 `/callback/{integration}` 仍要 Clerk JWT。
  - 前端拿 code、state，再用当前用户的 JWT 调 callback。
  - 换票必须带同一个 `redirect_uri`。

- state 对不上怎么办？
  - 返回失败，不换 token，也不删 Redis。
  - 对上之后先删 state，再向平台换 token。
  - 删除之后换票失败，这次 state 已经没了，要重新授权。

- token 存在哪，能活多久？
  - access token 约 23 小时，refresh token 约 364 天。
  - 这是 Redis 缓存寿命，不代表平台授权仍有效。
  - 发帖只读 access token。`refresh_token()` 没有接进发帖路径。

- 三个平台怎么发？
  - TikTok：`PULL_FROM_URL`，`privacy_level=SELF_ONLY`。视频字节不进 Publisher。
  - YouTube：先下载临时文件，再 resumable upload，默认 `private`。
  - X：2MB 分段上传，再发带 `media_ids` 的帖，发出即公开。

- 一次请求发多个平台会怎样？
  - `asyncio.gather` 在本进程并发。
  - 全部成功才返回成功。
  - 没有 outbox，也没有按视频生成的幂等键。超时重试可能在平台侧重复发帖。
  - `result_id` 在 schema 里，路由不用它做权限校验。

- 社交 Webhook 入口做什么？
  - `GET /webhooks/{integration}` 在白名单里，不要求 JWT。
  - 只打日志并返回 `ok`。
  - 不验平台签名，也不更新 token。
  - `callback` 和 `post_video` 不能放进这条白名单。

- X 的 PKCE 现在是什么？
  - `code_challenge` 和 `code_verifier` 都是固定字符串 `challenge`，方法是 `plain`。
  - 这是占位，不是按用户生成的 PKCE。

## 飞书入站

- 为什么要先回 200？
  - 飞书要求大约 3 秒内应答。
  - `url_verification` 立刻回 `challenge`。
  - 其它事件放进 `BackgroundTasks`，HTTP 回 `{"code": 0, "msg": "success"}`。
  - 这个 200 不是加分完成。进程退出时，还没跑的后台任务会丢。

- 加密和 token 是同一道检查吗？
  - 不是。
  - 有 `encrypt` 时先用 `FEISHU_ENCRYPT_KEY` 做 AES-256-CBC。解密失败返回 `code: 1`，不进后台。
  - 后台再比 `header.token` 和 `FEISHU_VERIFICATION_TOKEN`。配置为空会跳过并打警告。

- `event_id` 怎么去重？
  - `SET NX feishu:event:dedup:{event_id}`，TTL 8 小时。
  - 占坑在业务成功之前。
  - 同一事件再来直接跳过。占坑后处理失败，飞书重试也不会再跑。
  - token 校验失败发生在占坑之前，还可以重试。

- 哪些消息会被丢掉？
  - 只处理 `im.message.receive_v1`。
  - 机器人自己的消息、非文本、没有 @，都跳过。
  - 文本对不上命令只记日志。格式错误函数写了，这条路径没有调用。

- 两条命令是什么？
  - `email=... plan=pro|creator|starter`，映射到 `system_level` 的 `3 / 2 / 1`。
  - `email=... credits=数量 remake=备注`。积分大于 0，备注不能空，单次默认不超过 1,000,000。
  - 邮箱若是 Markdown 链接，只用方括号里的显示文本。

- 加积分的幂等键是什么？
  - `feishu_{message_id}`，`source=feishu_bot`。
  - 收支记录是 `event_type=feishu_topup`。
  - 然后再写 admin 的 `credits_topup_record`，`topup_source=feishu`。
  - 后一条失败不能回滚已经加上的积分，因为 `event_id` 已经占坑。
  - 不同 `event_id`、相同 `message_id` 时，积分幂等键仍能挡住重复入账。

- 回执怎么算成功？
  - POST 到 `FEISHU_BOT_WEBHOOK`。
  - 这份回执不加 timestamp 和 sign。
  - HTTP 200 且 JSON `code == 0` 才算成功。

## 出站和其它 Webhook

- 出站为什么不能共用一个机器人？
  - 入站回执、B2B 卡片、Lark 订单、AI 模型通知、未知 reason、告警、Consumer 异常，各有 URL。
  - 认领键也分开。模型通知认领 `ai_task_id`。B2B 认领 `user_id:signal.key`。

- AI 飞书签名怎么算？
  - 配了 `secret` 才加 `timestamp` 和 `sign`。
  - HMAC-SHA256，key 是 `timestamp + "\n" + secret`，签名内容是空字符串，结果 Base64。
  - 非 2xx 或 `code != 0` 都当失败。

- B2B 什么时候会重发？
  - `sent` 和 `sending` 不再发。
  - `failed` 允许下次评估重新认领。
  - `feishu_conditional` 到期时，用户已经自己升级就不再发。

- Consumer 告警会挡住什么？
  - 文案里含 `Insufficient credits`、`error_code 3003`、`notify_code 3003` 的消息直接不发。
  - 其余先发卡片，失败再退回文本。

- 定制订单通知失败会改订单吗？
  - 不会。
  - 订单已经是 `completed` 之后才发 Lark。
  - 通知异常只记日志。

- 飞书 `sign` 能验哪些入口？
  - 只能验配了这个 secret 的飞书机器人。
  - 验不了 Clerk 的 Svix、Stripe 签名，也验不了 Consumer 的 `x-oc-signature`。
  - 拿飞书加密 body 去打 Clerk 或支付 webhook，会被各自的验签拒绝。

## NovelComic 迁移

- 编写顺序为什么不从告警文案开始？
  - 先有 Clerk JWT 和 Redis。
  - 再落社交 state、换票和三个 Poster。
  - 再落飞书解密、challenge、去重、改等级和加积分。
  - 出站按 URL 分开接。
  - Clerk、Stripe、厂商回调留在已经有的入口。

- 本章最小验收是什么？
  - 未登录不能要授权 URL、换票或发帖。
  - 登录后 Redis 有 5 分钟 state。state 不一致不换票；一致后写入 access 和 refresh，并删掉 state。
  - 没有 access token 时发帖失败。TikTok、YouTube、X 的上传方式和可见性符合上表。任一平台失败则整次失败。
  - 社交 webhook 未登录返回 ok，且不改 token。
  - 飞书能回 challenge；解密失败是 `code: 1`；普通事件先 200，命令在后台执行。
  - 未 @、非文本、机器人自己的消息不改用户。
  - `plan` 能改对等级。加积分以 `feishu_{message_id}` 入账，同一 `event_id` 不重复。
  - 至少一条出站满足 HTTP 200 且 `code == 0`。飞书 body 打到 Clerk 或 Stripe 会被原验签拒绝。
  - 画布节点仍只来自 workflow 事件。

## 面试短答

- 一句话讲这三条链？
  - 社交 token 在 Redis，飞书命令先 200 再改账户，出站通知按机器人 URL 分开。

- 一句话讲发帖成功？
  - 只表示这次 Poster 调用返回了。没有发布任务表，超时重试可能重复发。

- 一句话讲飞书 200？
  - Publisher 收下了请求。等级和积分要看后台有没有占住 `event_id` 并执行完。

- 一句话讲画布为什么不看这些回调？
  - 节点状态来自 workflow 事件。社交发帖和飞书回执都不推进 DAG。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - Publisher 已有授权、换票、三个 Poster 和飞书入站。
  - 前端源码不调用这些社交接口，也没有发帖页。
  - 出站客户端已经拆在 AI、Consumer、B2B 和 Lark 订单上。

- 换票顺序和参考笔记一样吗？
  - 不一样。
  - 现码先 `get_token()`。access 和 refresh 都有，才删 state。
  - 缺 token 时 state 还在，接口返回 502。
  - 参考笔记是对上 state 后先删，再换票。

- 飞书改等级走哪个函数？
  - 现码直接更新 `users.system_level`。
  - 不是参考笔记里的 `UserService.update_user_system_level()`。
  - 加积分仍走 `add_topup_credits()`，幂等键是 `feishu_{message_id}`。

- B2B 认领键一样吗？
  - 现码是 `user_id:action_id`。
  - 参考笔记写的是 `user_id:signal.key`。
  - `sent` 和 `sending` 不再发，这一点已经接上。

- 什么时候才算本章完整验收？
  - 未登录打不了授权、换票和发帖；社交 webhook 仍只回 ok。
  - 三个平台能按各自方式发帖，没有 token 就失败。
  - 飞书 challenge、解密失败、去重、改等级、加积分和回执都能对上。
  - 至少一条出站看 `code == 0`。Clerk、Stripe、厂商回调没有被挂进飞书或社交路由。
  - 前端如果还没接产品页，API 通了也不算用户能发视频。
