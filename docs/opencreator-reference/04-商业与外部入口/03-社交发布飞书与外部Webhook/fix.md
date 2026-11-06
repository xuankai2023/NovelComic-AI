# 社交发布、飞书与外部 Webhook：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-publisher`、`opencreator-consumer`、`opencreator-ai`。NovelComic 看 `novelcomic-publisher`、`novelcomic-consumer`、`novelcomic-ai`。

不在这一份：全站成功信封。社交这几口成功时继续 `{ code: 200, msg: "ok", data }`。不要改成 OpenCreator `responseBase` 的 `{ code: 0, msg: "Success", traceId }`。失败的 HTTP 状态和业务码按下面第 1 节。用户集合仍是 `users`，邮箱字段仍是 `user_email`。充值积分仍走现有 `UnifiedCreditsService.add_topup_credits()`，`source=feishu_bot` 已经写成 `event_type=feishu_topup`，幂等锁不要另做一套。B2B 九条信号、弹窗和飞书认领已经写在增长篇第 8 节，这一份不改 `b2b_signal`。模型调用认领、厂商失败通知、Callback DLQ 文案已经写在 AI 网关那一篇，这一份不改 `model-call-notifier.ts` 和 `alert-service.ts`。定制订单怎么落库写在支付那一篇，这里只改发出去的 Lark 卡片。Clerk、Stripe、厂商 Webhook、AI 打给 Consumer 的回调留在原来的入口，不要挂进 `social_auth` 或 `feishu`。Frontend 现码没有社交授权页，OpenCreator 也没有，不要新做页面。Agent 不发帖。`get_lark_token()`、`feishu_read_table_row()`、`notify_message_format_bt_gtp()` 没有生产调用方，里面的应用密钥不要抄过来。`get_model_display_name_from_model()` 只做模型显示名，不发飞书，不要从 `utils/feishu.py` 搬过来。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。

- Redis 前缀已经是 `opencreator:social_auth:{tiktok|youtube|x}:`、`opencreator:access_token:...`、`opencreator:refresh_token:...`，后面拼 `user_id`
- 平台名是 `tiktok`、`youtube`、`x`。授权参数里 YouTube 有 `access_type=offline` 和 `prompt=consent`。X 的 PKCE `code_challenge`、`code_verifier` 都是固定字符串 `challenge`，方法是 `plain`
- `GET /api/v1/social_auth/webhooks/*` 和 `/api/v1/feishu/*` 已在认证白名单。授权、换票、发帖仍要登录用户。社交路由上的 `get_api_key` 不验密钥，NovelComic 没挂，结果一样，不要为了挂上它改 `routers.py`
- 发帖 body 已有 `post_items`。每一项有 `integration`、`text`、`description`、`video_url`，以及可选 `result_id`。路由不用 `result_id`
- state TTL 5 分钟，access 约 23 小时，refresh 约 364 天。对不上的 state 不删。多个 `post_items` 用 `asyncio.gather`，一个失败整次失败。发帖不调用 `refresh_token()`
- `GET /api/v1/social_auth/webhooks/{integration}` 只回 `data` 为 `ok`。不验平台签名，不改 token，也不改发帖状态
- 飞书解密是 SHA256 密钥、AES-256-CBC、前 16 字节 IV、PKCS7。去重键 `feishu:event:dedup:{event_id}`，`SET NX`，TTL 8 小时。token 校验失败发生在占坑之前
- 入站只处理 `im.message.receive_v1`。`sender_type == app`、非 `text`、没有 `mentions` 都跳过。对不上命令不回格式说明。`send_format_error_message()` 在 OpenCreator 里写了，这条路径没有调用，不要接上
- 飞书回执和 AI `FeishuWebhookClient` 都是 HTTP 200 且 JSON `code == 0` 才当成功。没配 webhook 或 `enabled === false` 不发。签名是 `Base64(HMAC-SHA256(key=timestamp + "\n" + secret, message=""))`。正文超过 8000 字截成前 7980 字再加换行和 `...[truncated]`。`atAll` 在文案里还没有 `<at user_id="all">` 时，前面加一行 `<at user_id="all">所有人</at>`
- 三个屏蔽词已经在：`Insufficient credits`、`"error_code":3003`、`"notify_code":3003`。`feishu_warring_notify()` 不走这道屏蔽

# 1. 换票先删 state，失败走 500 和 1007

做完要达到：平台名大小写敏感，只认小写的 `tiktok`、`youtube`、`x`。未知平台走失败，不写 Redis。

`state = os.urandom(16).hex()`。先向平台要授权 URL，再 `SETEX` 5 分钟。state 对不上时失败，Redis 里的 state 留着。对上之后先 `DELETE` state，再 `get_token()`。换票抛错时 state 已经没了，这次异常不要收成 502，交给现有未捕获异常。

未知平台、state 对不上、空 `post_items`、发帖抛错，这四类都是 HTTP 500。缺 query 仍是现在的 422，不要收成 500。未知平台和 state 对不上，业务码 `1007`，文案 `Unknown Server Error`。`post_items` 为空，业务码 `1001`，文案 `No post items provided`。发帖抛错，业务码 `1007`，文案是异常字符串。发帖成功的 `data` 是 null，`msg` 仍是 `Videos posted successfully`。

换票 HTTP：TikTok、YouTube 用同步 `requests.post`，不设 timeout。TikTok 不调用 `raise_for_status`。YouTube 调用 `raise_for_status`。YouTube 的 `get_token()` 要读到 `expires_in`，没有这个键就抛 `KeyError`，不要用 `.get` 把缺字段当成换票成功。X 用 httpx，timeout `600`，Basic 用 client id 和 secret。失败把响应正文记进日志再抛出。`refresh_token()` 仍不接入发帖和换票。

## 现在

未知平台和 state 对不上是 HTTP 400、业务码 `1000`。路径里的平台名会先 `lower()`。换票成功之后才删 state。token 缺字段时 HTTP 502，state 还在。发帖成功的 `data` 是 `true`。TikTok、YouTube、X 的换票都是 httpx，timeout 20 秒，并且先 `raise_for_status`。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v1/social_auth.py`。对照 OpenCreator `controller/v1/social_auth.py`。成功信封保持上面写的 `{ code: 200, msg: "ok", data }`。
2. `novelcomic-publisher/app/social/provider/tiktok_provider.py`、`youtube_provider.py`、`x_provider.py`。只改换票 HTTP。授权 URL、scope、PKCE 占位已经对齐，不要重写。

# 2. TikTok 先查 creator info，YouTube 和 X 按现码上传

做完要达到：三个 Poster 都只读 access token。没有 token 抛 `Access token not found in Redis`。路由已经把 `text` 传进来，空字符串保持空字符串。缺这个参数时，TikTok 和 YouTube 标题用 `Untitled`，X 正文用 `Check out this video!`。

TikTok 先 `POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/`，timeout 10 秒，`raise_for_status`。HTTP 失败就不再发视频。响应体里的 `privacy_level_options` 不用，后面仍然写 `SELF_ONLY`。然后再 `POST https://open.tiktokapis.com/v2/post/publish/video/init/`，body 用 JSON 字符串，timeout 10 秒。`source=PULL_FROM_URL`。`disable_duet=false`，`disable_comment=true`，`disable_stitch=false`，`video_cover_timestamp_ms=1000`。空 `video_url` 仍交给 TikTok，不要在本地先拒绝。

YouTube 先 `POST https://www.googleapis.com/upload/youtube/v3/videos`，查询参数 `uploadType=resumable`、`part=snippet,status`。body 带 `tags: []`、`categoryId: "22"`、`privacyStatus: "private"`。不要加 `X-Upload-Content-Length`。初始化的 HTTP 状态必须是 200，否则抛 `Failed to initialize upload: {body}`。`Location` 为空抛 `No upload URL returned from YouTube`。然后用 `a_download_tmp_file()` 下到临时文件，再 PUT 字节。PUT 只认 200 和 201。上传客户端 timeout 60 秒。空 `video_url` 抛 `video_url is required`。

X 先整段下载，再 initialize、按 2MB append、finalize，最后 `POST https://api.twitter.com/2/tweets`，body 带 `media.media_ids`。上传和发帖的 httpx 客户端用默认超时。`media_type=video/mp4`，`media_category=tweet_video`。initialize 没给出 media id 时，仍用取到的值继续 append，不要先抛 `No media id`。

下载按 OpenCreator `utils/download_utils.py` 的 `a_download_tmp_file()`：aiohttp 按 1024 字节写入临时文件，用完删除。失败包成 `RuntimeError`，文案以 `Failed to download file from {url}:` 开头。

## 现在

TikTok 不查 creator info，发帖 timeout 是 30 秒，空 `video_url` 在本地拒绝。YouTube 先把视频下进内存，初始化时带了 `X-Upload-Content-Length`，snippet 没有 `tags`，2xx 都当成功，timeout 120 秒。X 的上传 timeout 是 120 秒，发帖 timeout 是 30 秒，没有 media id 会先抛错。空标题会被换成默认文案。没有 `a_download_tmp_file()`。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/utils/download_utils.py` 的 `a_download_tmp_file()`。对照 OpenCreator `utils/download_utils.py` 这一个函数。
2. `novelcomic-publisher/app/social/poster/tiktok_poster.py`、`youtube_poster.py`、`x_poster.py`。对照 OpenCreator 同名文件。Redis 继续用请求上已经传入的客户端，不要改回全局 `redis_client`。

# 3. 飞书入站 3 秒内的应答

做完要达到：`POST /api/v1/feishu/event` 整段处理放在 try 里。非法 JSON、body 不是对象，都回 HTTP 200，`{"code": 1, "msg": <异常字符串>}`。

body 里有非空 `encrypt` 才解密。解密失败回 HTTP 200，`msg` 是 `decrypt failed or FEISHU_ENCRYPT_KEY not set`。解密结果是字符串时再 `json.loads` 一次。结果仍不是对象，同样走这句解密失败。事件模型对不上，也是 HTTP 200 的 `{"code": 1, "msg": <异常字符串>}`，不要写成 `invalid payload`。这种失败不进后台任务。

`type == url_verification` 且 body 里有 `challenge` 这个键时，立刻回 `{"challenge": <原值>}`。空字符串也回。其余事件放进 `BackgroundTasks`，HTTP 回 `{"code": 0, "msg": "success"}`。后台任务自己的异常只记日志，不再改这次 HTTP。

## 现在

非法 JSON 会在进处理函数之前失败，不是 `code: 1`。解密失败的 `msg` 是 `decrypt failed`。解密结果不是对象时，在解密函数里直接变成失败，字符串不会再解析一次。`challenge` 为空字符串时不会走 URL 校验。模型校验失败的 `msg` 是 `invalid payload`。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v1/feishu.py`。对照 OpenCreator `controller/v1/feishu.py`。
2. `novelcomic-publisher/app/services/feishu/feishu_decrypt.py`。算法保持。解密后的 JSON 字符串要能交回控制器，不要在这里收成 `None`。

# 4. 两条命令的解析、去重和回执

做完要达到：后台先看 `header.token`。这个字段为空时跳过校验。配置 `FEISHU_VERIFICATION_TOKEN` 为空时跳过校验并打警告。校验失败不占坑，也不回群。

`header` 和 `event` 都在，才 `SET NX`。只有 header、没有 event 时不占坑。占上之后，未识别的 `event_type` 只记日志。

Redis 和 Mongo 继续用现在传入的连接，不要改成 OpenCreator 的全局客户端。

文本从 `message.content` 做 `json.loads`，再取 `text`，再收成 `FeishuMessageEvent`。这一段抛错，回群 `处理消息异常: {异常}`。外层文案是：

```text
❌ 操作失败
────────────────────
错误: 处理消息异常: {异常}
```

分隔线是 20 个 `─`。

先匹配改等级，再匹配加积分。改等级正则是 `email=(.+?)\s+plan=(\w+)`，忽略大小写。加积分正则是 `email=(.+?)\s+credits=(\d+)\s+remake=(.+)`，忽略大小写，点号匹配换行。备注可以含空格。字段名是 `remake`，`remark=` 对不上这条命令。积分要大于 0，备注去掉空白后不能空。`plan` 转成小写，只认 `pro`、`creator`、`starter`。积分不是正数、备注为空、等级不在这三个里面，都当没对上命令，不回群。

邮箱不转小写。明文要匹配 `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`，对不上就当没对上命令。飞书 Markdown `[显示文本](mailto:...)` 只用方括号里的显示文本，显示文本不用再过这道邮箱正则。按 `users.user_email` 精确等于这个字符串查找。找不到时，内文是 `用户不存在: {email}`，外面仍套上面的失败回执。改等级抛错时，内文是 `修改用户等级失败: {异常}`。

等级映射是字符串：`starter` 写 `"1"`，`creator` 写 `"2"`，`pro` 写 `"3"`。`updated_at` 用本地 `datetime.now()`。成功回执：

```text
✅ 用户等级修改成功
────────────────────
用户邮箱: {email}
新等级: {Pro|Creator|Starter} (level={1|2|3})
```

回执打 `FEISHU_BOT_WEBHOOK`。timeout 10 秒。不带 timestamp 和 sign。没配地址回 false，不回滚已经改过的等级。

## 现在

空 token 在配了校验 token 时会被拒绝。没有 event 也会先占坑。命令用 `key=非空白` 切分，备注不能含空格，`remark` 和 `remake` 都认，邮箱会转小写。查找还会做不区分大小写的正则。`system_level` 写成整数。回执是 `{email} 已调整为 {plan}，system_level={level}` 和 `未找到用户：{email}`。消息解析失败不回群。

## 改哪些文件

1. `novelcomic-publisher/app/services/feishu/feishu_message_parser.py`。对照 OpenCreator `services/feishu/feishu_message_parser.py`。
2. `novelcomic-publisher/app/services/feishu/feishu_event_service.py` 里验 token、占坑、过滤消息、改等级。对照 OpenCreator 同名文件的这些步骤。
3. `novelcomic-publisher/app/services/feishu/feishu_bot_service.py`。对照 OpenCreator 同名文件的文本回执。成功、失败都走这里。

# 5. 飞书加积分和充值记录

做完要达到：上限是 `FEISHU_MAX_CREDITS_PER_OPERATION`，没配或是 0 时按 `1000000`。超过上限时，内文是 `单次加积分不能超过 {上限}`，数字带千分位，外面套第 4 节的失败回执，然后返回。这一步发生在查用户之前。

入账调用现有 `add_topup_credits()`，`source=feishu_bot`，幂等键 `feishu_{message_id}`。幂等键已经占过时，函数自己返回，积分不加第二次。返回之后仍然写充值记录，并仍发成功回执。入账、写记录、发成功回执这三步里任何异常，内文都是 `添加积分失败: {异常}`，外面套失败回执，成功回执不再发。

记录 `insert_one` 到现有库的 `credits_topup_record`。不要新开 `opencreator-admin`。文档字段：

```text
topupSource = feishu
topupSourceValue = 命令里的邮箱
remark = 备注
amount = 积分的字符串
user_id
userEmail = 命令里的邮箱
operatorName = 飞书机器人
operatorId = feishu_bot
status = active
createdAt = datetime.now()
updatedAt = datetime.now()
```

每次插入一条，不要按幂等键 upsert。积分已经加上的不扣回。`event_id` 占坑也不放开。

成功回执不带操作者行：

```text
✅ 积分添加成功
────────────────────
用户邮箱: {email}
添加积分: {credits:,}
备注: {remark}
```

## 现在

上限直接用配置，配成 0 会拒绝所有正数积分。超限文案带邮箱，没有千分位。充值记录是 snake_case，`amount` 是整数，按 `idempotency_key` upsert。插入失败被吃掉，后面仍发成功回执。成功文案是 `{email} 已增加 {credits} 积分，备注：{remark}`。

## 改哪些文件

1. `novelcomic-publisher/app/services/feishu/feishu_event_service.py` 的加积分分支。对照 OpenCreator `_process_add_credits_command()`。`add_topup_credits()` 的签名保持 NovelComic 现有的，不要改统一积分服务。
2. 回执文案仍走第 4 节的 `feishu_bot_service.py`。

# 6. 定制订单的 Lark 卡片

做完要达到：只有这次把订单从可结算状态改成已支付，才发通知。已经支付过的订单被再次返回时，不再发卡片。通知抛错只记日志，订单保持完成。

地址用现有 `LARK_CUSTOM_ORDER_WEBHOOK_URL`。没配就跳过。不要把 OpenCreator 源码里的 hook id 写进仓库。配了之后用 aiohttp 默认超时，不要再用 5 秒。成功只看 HTTP 200。响应 JSON 里的 `code` 不参与判断。

卡片是 interactive，header 模板 `green`。标题：`workflow_enterprise` 用 `💰 新内容生产交付订单`，其余用 `💰 新定制工作流订单`。第一块 markdown 是 `<at id=all></at>`，然后是订单 ID。服务类型和金额并排，底色 `grey`。金额是 `order.amount / 100`，格式是 `$` 加 `{金额:.0f}`。服务名：

```text
image_simple = 图片工作流 - 简单场景 (1-8张)
image_batch = 图片工作流 - 批量场景 (8-20张)
video_8s = 视频工作流 - 8秒以内
video_30s = 视频工作流 - 30秒以内
video_60s = 视频工作流 - 60秒左右
workflow_enterprise = 内容生产交付方案
```

对不上就用原始 `service_type`。只读 `service_type`。邮箱空时写 `N/A`。付款时间是发送当时的 UTC+8，格式 `%Y-%m-%d %H:%M:%S`，不读 `paid_at`。

## 现在

成功还要求 JSON `code` 是 0 或缺失，超时是 5 秒。标题没有 `💰`，@所有人 不是 `<at id=all></at>`。邮箱空时是 `-`。付款时间优先用 `paid_at` 或 `updated_at`。服务类型还会读 `custom_workflow_service_type`。金额先收成整数再除。`settle_paid_order()` 对已经支付的订单仍返回文档，Checkout 完成处理会再发一张卡片。

## 改哪些文件

1. `novelcomic-publisher/app/utils/lark_notify.py`。对照 OpenCreator `utils/lark_notify.py` 的卡片和成功判断。
2. `novelcomic-publisher/app/services/webhook/processors/stripe/CheckoutSessionCompletedProcessor.py` 里调用通知的那一处。只有这次结算把订单改成已支付才调用。订单字段和入账仍按支付那一篇，不要在这里重写履约。

# 7. Consumer 运行时告警的卡片

做完要达到：webhook 先读 `FEISHU_NOTIFY_BOT_WEBHOOK_URL`，空再读 `FEISHU_NOTIFY_BOT_WEBHOOK`。两把都空时仍去 POST，失败只记日志，不要在发之前直接返回。`feishu_notify()` 命中三个屏蔽词就返回。其余先发 interactive card，失败再发 text。两步都失败时只记日志，不把异常抛给调用方。`feishu_warring_notify()` 在原文前加 `警告: `，不看屏蔽词，失败同样只记日志。HTTP 成功后，JSON 里没有 `code`，或 `code` 为 0，都当发送成功。`code` 有值且不是 0，当失败，卡片失败就退回文本。

文本头三行是 49 个 `-`、居中的 `OC-Consumer`、再一行同样的分隔线。JSON 对象的键用中文标签，形如 `创建时间(created_at)`。标签覆盖 `created_at`、`updated_at`、`notify_id`、`notify_type`、`notify_code`、`notify_title`、`notify_body`、`service`、`env`、`instance_id`、`render_service`、`trace_id`、`request_method`、`request_path`、`request_url`、`query_params`、`client_host`、`client_port`、`user_agent`、`referer`、`http_status_code`、`http_detail`、`request_validation_errors`、`exception_class`、`traceback`。没有标签的键保持原样。`None` 印成 `None`。嵌套对象压成紧凑 JSON。换行写成 `\n`。

卡片标题是 `OC-Consumer`。schema `2.0`。先一行 markdown `**信息内容**`，`element_id` 是 `oc_consumer_alert_intro`。下一行是正文，`element_id` 是 `oc_consumer_alert_content`。副标题用 `notify_title`，没有则用 `notify_type`，再没有则是 `运行时异常告警`。`notify_type` 是 `RequestValidationError`、`HTTPException`、`BaseCustomException` 时 header 模板是 `orange`，其中 `HTTPException` 且 `notify_body` 以 `404:` 开头也是 `orange`。其余是 `red`。

`is_at` 为真时，文本末尾追加这三个 mention：`78424275`、`9352fc2g`、`b77ccg7f`，写法是 `<at user_id='...'>@名字</at>`，名字按 OpenCreator 现码是 zhihai、xiaoman、Xiaoyi。卡片正文末尾另用 `<at id=78424275></at> <at id=9352fc2g></at> <at id=b77ccg7f></at>`。

告警队列和 `ACTIVATE_FEISHU_NOTIFY` 不在这一份。不要为了飞书新开 Redis Stream 消费者。

## 现在

只读 `FEISHU_CONSUMER_WEBHOOK_URL`，空地址直接返回。标题是 `NovelComic-Consumer`。JSON 键没有中文标签。卡片只有一块正文，`element_id` 是 `consumer_alert_content`。`is_at` 使用 `<at user_id="all">`。卡片和文本都失败时异常会抛出去。

## 改哪些文件

1. `novelcomic-consumer/app/utils/feishu.py` 的 `feishu_notify()`、`feishu_warring_notify()` 和卡片、文本格式化。对照 OpenCreator `utils/feishu.py` 的这几段。
2. `novelcomic-consumer/app/config.py`。webhook 增加 `FEISHU_NOTIFY_BOT_WEBHOOK_URL`，空则用 `FEISHU_NOTIFY_BOT_WEBHOOK`。

# 8. 未匹配 reason 的飞书文案

做完要达到：`notifyUnknownProviderReason()` 只在 reason 映射的 webhook 地址有值时发送。标题第一行是 `[OpenCreator AI] 未匹配的错误 reason，请补充 mapping`。后面按有值才出现的顺序是 `error_code`、`provider`、`model_id`、`ai_task_id`、`fingerprint`、`hit_count`、`sanitized_message`。`provider_message` 截前 500 字。这个 client 不带 secret。timeout 是 `10000`。发送失败由调用方记下，这一份不改调用方。

## 现在

标题是 `[NovelComic AI] 未匹配的错误 reason，请补充 mapping`。client 会带上 `REASON_MAPPING_FEISHU_SECRET`，timeout 用配置里的 `REASON_MAPPING_FEISHU_TIMEOUT_MS`。

## 改哪些文件

1. `novelcomic-ai/packages/runtime/src/feishu-notifier.ts` 的 `notifyUnknownProviderReason()`。对照 OpenCreator `feishu-notifier.ts`。`AlertFeishuNotifier` 和 Callback DLQ 文案留在 AI 网关那一篇，不要在这里改掉。
