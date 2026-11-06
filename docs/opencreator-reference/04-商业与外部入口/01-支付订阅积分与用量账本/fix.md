# 支付、订阅、积分与用量账本：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-consumer`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-consumer`。

不在这一份：全站响应信封。NovelComic 支付接口现在是 `{ code: 200, msg: "ok" }`，OpenCreator 是 `{ code: 0, msg: "Success", traceId }`。这一份不改信封，只改 HTTP 状态、业务码和 `data`。用户集合名也不改。登录已经用 `users`，OpenCreator 的充值字段在 `user`。积分仍写在现有用户文档的 `credits` 上。Stripe 商品展示名、定价页文案、GTM、Rewardful、Kolect 不改变入账结果，这里不动。Developer API 和飞书加积分入口不在这篇。`/api/v1/usage/history` 和 `/api/v1/usage/income` 现码还挂着，入账查询和 V2 是同一套。当前前端不打 V1，这一份不单补这两口。`customer.subscription.deleted` 里 `_should_delay_deletion_event()` 现码直接返回 false，不会睡 30 秒，不要补这段延迟。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。差的是类放在哪个文件。

- `POST /api/v1/payments/webhook` 在登录白名单里，不读用户 JWT
- 买积分 Checkout 的 Stripe `mode` 是 `payment`。创建会话的函数返回前不加可花积分
- `checkout.session.completed` 在 `mode=payment` 且钱还没结算时直接返回。`payment_type=custom_workflow` 不加充值积分。`mode=subscription` 的完成事件不加订阅积分
- 订阅可花积分只从 `invoice.paid` 和 `invoice.payment_succeeded` 进。`billing_reason` 只认 `subscription_create`、`subscription_cycle`、`subscription_update`。本地状态不是 `active` 不发
- 充值换算：用户等级 `3` 每美元 500，其余 400。`credits = payment_amount_cents * credits_per_dollar // 100`。幂等键是 `order_id`。锁是 `opencreator:credits:idempotency:{order_id}`，SET NX，TTL 7 天。Mongo 成功前失败放开锁。Mongo 成功后删缓存失败，锁继续留着
- Redis 三池前缀是 `opencreator:credit_balance_check:{user_id}`、`opencreator:subscription_user_credits:{user_id}`、`opencreator:gift_credits:{user_id}`。`save_subscription_credits()` 和停用只删订阅这一把
- 预扣 Lua 顺序是订阅、充值、赠送。`cost <= 0` 不写 pending，也不写 `usage_v2`。pending 是 `opencreator:pending_deduction:{deduction_id}`，TTL 86400。成功路径写 `usage_v2`，同一 `deduction_id` 已经是 `deducted` 不再扣 Mongo。`do_deduct()` 不在成功路径上
- `safe_create_record()` 失败只记日志，不把已经改过的余额扣回去
- `emit_credits_deducted()` 在账本写完之后发。它不是账本
- `SubscriptionSucceedProcessor.process()` 只做邀请奖励和支付成功信号。Webhook 分发走 `process_event()`。不要对调，也不要让 `process()` 去发订阅积分
- 四个支付类型字面量是 `subscription_checkout`、`subscription_plan`、`billing_portal`、`credits_checkout`
- 买积分是 `POST /api/v1/payments/checkout`。账单门户是 `GET /api/v1/payments/billing_session`。赠送积分路由是 `GET /api/v1/gift_credits` 和 `PATCH /api/v1/gift_credits/notify`
- 三张历史的路径是 `GET /api/v2/usage/history`、`GET /api/v2/usage/income`、`GET /api/v2/payments/history`。入账过滤是当前用户且 `direction=in`

# 1. 支付参数放进 localStorage

做完要达到：`openPaymentWindow()` 把支付参数写进 `localStorage`，新窗口能读到。指针键是 `pending_payment_request`。正文键是 `pending_payment_request:{requestId}`。信封是 `{ __v: 1, data }`。超过 `4096` 字节不写入。同时写状态 `pending`：`payment_redirect_status:{requestId}`、`payment_redirect_status`、`payment_redirect_status_owner`。

窗口特征带 `popup=yes`，并带居中的 `left`、`top`。打不开时删掉刚写的 request 和状态，返回 false。

`consumePaymentRequest()` 认 `__v === 1`。指针值以 `{` 开头的旧整包也要能读。`__v` 不是 1 则返回 null。

## 现在

参数在 `sessionStorage`，键是 `novelcomic:payment-request`。新窗口读不到 opener 的 sessionStorage，`/payment-redirect` 会停在找不到支付请求。没有状态键，没有 4096 字节上限，没有旧整包兼容。

## 改哪些文件

1. `novelcomic-frontend/src/utils/payment-window.ts`。对照 OpenCreator 同名文件。
2. `novelcomic-frontend/src/routes/payment-redirect.tsx` 里读取和清理支付参数的调用，改成上一文件的 localStorage 接口。

# 2. `/payment-redirect` 按现码决定要不要创建会话

做完要达到：商业化开关现码恒为 true，函数是 `isCommercializationEnabled()`。关掉时停住，文案按 OpenCreator，并清掉这次支付状态。不要用构建环境把缺省值写成 false。

没有 `request_id` 时仍按指针和旧包去 `consumePaymentRequest()`。consume 失败才停。

`subscription_checkout` 先 `GET /api/v2/user/info`。`subscription_billing_state` 缺失就停，不创建第二条结账。`checkout_eligible === false` 时按 `reason` 停住。`reason === "payment_requires_resolution"` 用待处理付款文案，其余用已有订阅或支付进行中。

打哪一口：

```text
api_version === "v2" 且有 price_id
  → POST /api/v2/payments/subscription/checkout
  → PUT  /api/v2/payments/subscription/plan
否则
  → POST /api/v1/payments/subscription/checkout
  → PUT  /api/v1/payments/subscription/plan
```

买积分仍是 `POST /api/v1/payments/checkout`。账单门户仍是 `GET /api/v1/payments/billing_session?return_url=`。

年付，或月付且 `amount > 210`，先选支付方式。阈值常量是 `CHINA_PAYMENT_THRESHOLD_USD = 210`。选择结果写 `payment_method: "stripe"` 或 `"china"`。`subscription_plan` 只有 `require_payment_method_selection === true` 才进这个选择。

改套餐返回 `requires_action` 和 `client_secret` 时，把 secret 写到 `localStorage.stripe_3ds_client_secret`，成功地址写到 `stripe_3ds_success_url`，停在页上。不跳 Stripe，也不回成功页。

有 `url` 就 `setPaymentStatus("redirected", request_id)`，然后 `location.href = url`。改套餐没有 `url`、也不需要 3DS，把 `successUrl` 里的 `{CHECKOUT_SESSION_ID}` 换成 `plan_updated` 再跳走。其它情况没有 `url` 才停在失败。

业务码 `4001` 给出管理账单，改走 `billing_portal`。`4003` 和 `4004` 给出重试这一次。

## 现在

商业化看 `VITE_COMMERCIALIZATION_ENABLED !== "false"`。没有 `request_id` 直接停，不读指针。`subscription_billing_state` 缺失仍会创建结账。订阅和改套餐只打 V2。没有 210 美元的支付方式选择，不写 `china`。3DS 只抛错，不写 `stripe_3ds_client_secret`。改套餐没有 `url` 时一律当成没拿到 Stripe 链接。没有 4001 / 4003 / 4004 的恢复按钮。

## 改哪些文件

1. `novelcomic-frontend/src/routes/payment-redirect.tsx`。对照 OpenCreator 同名文件，以及 `src/features/billing/constants/storage-keys.ts` 里恒为 true 的开关。
2. `novelcomic-frontend/src/api/modules/payments.ts`。对照 OpenCreator `src/api/modules/payments.ts`。补上 V1 结账和改套餐，条件就是上面的 `api_version` 加 `price_id`。
3. `novelcomic-frontend/src/features/billing/utils/subscription-checkout.ts` 现在没有。打开窗口前的拦截文案对照 OpenCreator 同名文件。redirect 页自己的文案仍以 `payment-redirect.tsx` 为准。

# 3. 回站页只广播 session_id

做完要达到：`/credits/result` 在商业化关闭时不渲染结果组件。打开时，`PaymentResult` 用 `BroadcastChannel`，名字是 `PaymentChannel`。query 里有 `session_id` 时，大约 100 毫秒后 `postMessage(sessionId)`，载荷是裸字符串，然后 `window.close()`。没有 `session_id` 不广播、不关页。这一页不写积分。

`reloadBalance()` 未登录返回 0，不请求。已登录读 `GET /api/v2/user/info`，把三个数字相加后返回：

```text
Number(credits || 0)
+ Number(subscription_credits.credits_balance || 0)
+ Number(gift_credits.amount || 0)
```

前端不再看订阅 `status`，也不再看赠送是否过期。过期过滤在服务端快照里做，见第 13 节。

原窗口不监听 `PaymentChannel`。支付是否跳走，看 `localStorage` 的 `payment_redirect_status`。工作流真正开跑之前先 `reloadBalance()`。返回值 `<= 0` 就停，不创建这次运行。跑完再拉一次。升级或购买弹窗成功后也会再拉。

## 现在

频道名是 `novelcomic:payment-result`。立刻广播对象 `{ type: "payment_completed", session_id }`，`session_id` 可以是 null，约 600 毫秒后关页。`reloadBalance()` 会在前端再滤一遍 `status === "active"` 和 `expires_at`。工作流只在 `onFinishFlow` 时刷新余额。开跑前不读余额，余额是 0 也会继续跑。

## 改哪些文件

1. `novelcomic-frontend/src/components/checkout/PaymentResult.tsx`。对照 OpenCreator 同名文件。
2. `novelcomic-frontend/src/routes/credits.result.tsx`。对照 OpenCreator 同名文件。
3. `novelcomic-frontend/src/features/billing/runtime/useCreditsProvider.tsx` 的 `reloadBalance()`。对照 OpenCreator 同名函数。
4. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts`。对照 OpenCreator 同名文件里开跑前 `reloadBalance()` 且 `balance <= 0` 就返回的分支。支付状态监听对照 `src/features/billing/hooks/upgrade/use-payment-status.ts`。

# 4. 三张历史的 query 和发票

做完要达到：三张列表的 query 名是 `page_number`、`page_size`。支付历史读 `records`。用量和入账同样读分页里的 `records`，并带 `total_pages`。

发票：有 `session_id` 打 `GET /api/v1/payments/invoice?session_id=`。否则按现码打 `GET /api/v1/payments/invoice?&subscription_id=`，查询名是 `subscription_id`，前面那个 `&` 保留。打开返回里的 `hosted_invoice_url`。

Checkout 状态仍是 `GET /api/v1/payments/checkout/{session_id}/status`，调用不加积分。

订阅模板是 `GET /api/v1/payments/subscription/template`。价目配置是 `GET /api/v1/payments/subscription/stripe_plan_config`。这两口公开，不创建会话。

## 现在

前端 query 名是 `page`。支付历史读 `items`。发票打 `invoice_id`。列表上没有发票按钮。`subscription.ts` 没有模板和 `stripe_plan_config`。

## 改哪些文件

1. `novelcomic-frontend/src/api/modules/credits.ts`。对照 OpenCreator 同名文件的 history、income、invoice、checkout status。
2. `novelcomic-frontend/src/api/modules/subscription.ts`。对照 OpenCreator 同名文件的 template、`stripe_plan_config`、V1 结账和改套餐。
3. `novelcomic-frontend/src/features/billing/components/upgrade/list/payments.tsx`、`useage.tsx`、`income.tsx`。对照 OpenCreator 同目录三个文件的分页字段和发票按钮。服务端字段形状在第 14 节。

# 5. V1 支付路由按现码补齐

做完要达到：`/api/v1/payments` 上有这些路由。结账和改套餐要登录。模板和 `stripe_plan_config` 在登录白名单。

```text
POST /webhook
POST /checkout
GET  /checkout/{session_id}/status
GET  /invoice
GET  /history
POST /subscription/checkout
PUT  /subscription/plan
GET  /subscription/template
GET  /subscription/stripe_plan_config
GET  /portal_session
GET  /billing_session
```

`GET /checkout/{session_id}/status` 和 `GET /invoice` 只读 Stripe，不加积分。`GET /history` 和 V2 历史读的是同一套已支付记录，见第 14 节。

V1 订阅结账和 V2 进同一个 `create_subscription_checkout_session()`。V1 改套餐和 V2 进同一个 `a_update_subscription_plan()`。不能因为 URL 上有 `v1` 就把积分写进另一张表。

## 现在

V1 只有 `POST /webhook` 和 `POST /checkout`。模板、发票、回站状态、账单门户、V1 订阅结账和 V1 改套餐都不存在。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v1/payments.py`。对照 OpenCreator `controller/v1/payments.py`。
2. `novelcomic-publisher/app/controller/routers.py`。白名单补上 `/api/v1/payments/subscription/template` 和 `/api/v1/payments/subscription/stripe_plan_config`。Webhook 白名单保持不动。

# 6. 买积分会话按现码创建

做完要达到：Stripe Idempotency-Key 是 `oc_checkout_` 加上 `sha256("{user_id}:{request_id}")`。已有 Customer 按邮箱复用，写 `customer`。没有才写 `customer_email`。`allow_promotion_codes` 为 true。

`payment_method_types` 是 `card`、`link`、`cashapp`、`klarna`、`alipay`、`wechat_pay`。`payment_method_options.wechat_pay.client` 是 `web`。`invoice_creation.enabled` 为 true。

metadata 有 `checkout_type=credits`、`user_id`、`checkout_request_id`。预创了订单才有 `checkout_order_id`。

本地订单在返回前写成 `type=one_time`、`pay_mode=payment`、`pay_status=unpaid`、`pay_result=processing`。金额是美元乘 100，货币 `usd`。函数返回前不改 `credits`。

成功时 `data` 带 Stripe Session 里前端要跳转的 `url`，以及 `id`、`mode`、`status`。创建结果是空时 HTTP 204。失败用业务码 `4000`。Stripe 结果还不能确认时用 `4004`。

## 现在

Idempotency-Key 前缀是 `nc_checkout_`。总是传 `customer_email`，不复用 Customer。不传 `payment_method_types`，也不传 `allow_promotion_codes`。`data` 被收成 `{ id, url, mode, status, order_id }`。密钥空是另一套 400 文案。

## 改哪些文件

1. `novelcomic-publisher/app/services/payments.py` 的买积分会话。对照 OpenCreator `services/payments.py` 里 `CreateCheckoutRequestParam` 那一支，以及后面给单笔支付补 `payment_method_types` 的分支。
2. `novelcomic-publisher/app/controller/v1/payments.py` 的 `POST /checkout`。空结果返回 204。失败码对照 `common/response/code_payment.py` 的 `4000` 和 `4004`。

# 7. 订阅结账：冲突、支付方式、积分 metadata

做完要达到：创建订阅会话先拿 Redis 锁 `opencreator:subscription-checkout:{user_id}`。拿不到返回业务码 `4001`，`data.reason` 是 `checkout_lock_unavailable`。同一 `request_id` 换了套餐、创建中、已结束、别人的进行中 checkout、本地阻塞订阅、Stripe 上未取消的订阅、Stripe 上仍 open 的订阅 Session，都走 `4001`，`data.reason` 用 OpenCreator `services/payments.py` 里现有的 reason 字符串。不要收成一条没有 `reason` 的 1009。

`payment_method == "china"` 且 `subscription_key` 是 `starter`、`creator`、`pro` 时，Stripe `mode` 改成 `payment`。关掉 `invoice_creation`。metadata 写 `is_subscription_purchase=true`、`payment_method=china`，以及 `subscription_credits`、`level`、`price_id`。年付在写入前把 `subscription_credits` 乘 12。`payment_method_types` 是 `card`、`wechat_pay`、`alipay`，微信 `client=web`。入账不走发票，走第 11 节的一次性订阅履约。

其余订阅仍是 `mode=subscription`。`card` 只开 card。`alipay` 只开 alipay。其它开 `card`、`link`、`cashapp`、`klarna`、`alipay`。`subscription_data.metadata` 必须带上模板里的 `subscription_credits` 和 `level`。缺了这个字段，后面的发票会因为积分为 0 失败。

`FIRST_TIME_STARTER_MONTHLY_PROMOTION_CODE_ID` 有值，且这次是 `starter` 月付，并且这个用户没有任何订阅历史时，Session 写 `discounts.promotion_code`，并去掉 `allow_promotion_codes`。没有这段配置时不送优惠。

V2 成功 `data` 是 `{ url, mode, id, status }`。

## 现在

只查本地 `orders` 里 `pay_mode=subscription` 且 `pay_result=processing`，以及 `subscription_user_credits.status=active`。冲突是 HTTP 409、业务码 1009，没有 `reason`。不拿 Redis 锁，不查 Stripe。

`payment_method` 只写进本地订单。Stripe 永远是 `mode=subscription`，metadata 没有 `subscription_credits`。年付发票进来后 `a_reward_monthly_credits()` 读到 0，抛 `Subscription credits are missing`，Webhook 500，积分不加。

## 改哪些文件

1. `novelcomic-publisher/app/services/payments.py` 的 `create_subscription_checkout_session()`。对照 OpenCreator `services/payments.py` 从订阅参数分支到 `is_one_time_subscription`、`subscription_metadata`、`payment_method_types` 的整段。
2. `novelcomic-publisher/app/controller/v2/payments.py` 的结账返回体。对照 OpenCreator `controller/v2/payments.py`，`data` 不要多包一个调用方没读的形状。
3. 套餐上的 `subscription_credits` 从模板读。模板接口在第 5 节。对照 OpenCreator `a_get_pricing_items_from_subscription_template()`。

# 8. 改套餐按现有订阅改，不要再开一条结账

做完要达到：`PUT /api/v1/payments/subscription/plan` 和 `PUT /api/v2/payments/subscription/plan` 调用 `a_update_subscription_plan()`。成功时按 OpenCreator `controller/v2/payments.py` 拆返回：

- 没有结果：成功，`data` 空
- `checkout_session_data`：`data` 就是这份 checkout
- `is_one_time_upgrade`：`data` 是新的 Checkout Session
- `requires_action`：`data` 带 `url: null`、`requires_action: true`、`client_secret`
- 其余成功结果原样放进 `data`

本地状态和错误按 OpenCreator `services/subscription.py` 的现码：

- 要 3DS：本地 `3ds_processing`，返回 `client_secret`。这时不加可花积分
- 扣款结果还没确认：本地 `processing`，业务码 `4003`
- 卡被拒：本地 `payment_failed`，业务码 `4002`
- 同套餐无变更：成功且 `data` 空
- 取消或降级延迟到期末：成功，`data` 带 `deferred_action`。Stripe 订阅 metadata 写下降级目标价和降级后的订阅 metadata。删除事件再按第 10 节重建新订阅

这些状态都不等于新套餐积分已经可花。积分仍等后面的发票，或等第 11 节的一次性履约。

## 现在

`update_subscription_plan()` 再调一次 `create_subscription_checkout_session(allow_existing_subscription=True)`。永远返回一条新的 `{ id, url, mode, status, order_id }`。没有 `requires_action`，没有 `3ds_processing`、`processing`、`payment_failed`。不校验是不是同一套餐，Stripe 上可以并存第二条订阅。

## 改哪些文件

1. `novelcomic-publisher/app/services/subscription_management.py`，或把改套餐收到与 OpenCreator 相同职责的订阅服务里。对照 `services/subscription.py` 的 `a_update_subscription_plan()`。
2. `novelcomic-publisher/app/controller/v2/payments.py` 和补上之后的 V1 `PUT /subscription/plan`。对照 OpenCreator 两个 controller 里对 `checkout_session_data`、`is_one_time_upgrade`、`requires_action` 的拆分。
3. `novelcomic-publisher/app/services/payments.py` 里现在的 `update_subscription_plan()` 不要再转发成一条新的订阅 Checkout。

# 9. Webhook 先验签，落库后先回 200

做完要达到：验签在 `get_stripe_webhook_event()`。密钥为空，HTTP 400，detail 是 `Invalid webhook type`。payload 坏，detail 是 `Invalid payload`。签名坏，detail 是 `Invalid signature`。

OpenCreator 的 controller 在 `except` 里调用了不存在的 `responseBase.error`。这是现码缺陷。NovelComic 不要抄这个 AttributeError。签名失败就返回上面的 400，积分不变。

验签通过后先把事件写入 Mongo。键是 `event_provider + event_id`，`event_provider` 是 `stripe`。已经 `succeeded` 的直接返回，HTTP 仍是 200。然后 `asyncio.create_task()` 异步处理。这次 HTTP 在任务跑完之前就已经 200。处理器失败把事件标成 `failed`，写 `next_retry_at`，不把这一次响应改成 500。内部按现码重试 `failed` 和卡住的 `processing`。

没有处理器的事件状态是 `missing`，不要写成 `succeeded`。写成成功之后，同一 `event_id` 再投也不会进后来补上的处理器。

`customer.subscription.deleted` 不要因为现码里有一段 `sleep(30)` 的死分支就去延迟。`_should_delay_deletion_event()` 返回 false。

## 现在

验签失败是 HTTP 400，文案是 `STRIPE_WEBHOOK_SECRET is not configured`、`Stripe webhook signature is invalid` 这一套，detail 和 OpenCreator 不一致。处理器跑完才 200。处理器抛错是 HTTP 500，业务码 1007。未登记事件被标成成功。失败事件再投时会再插一条处理中记录，唯一索引没建起来时可能履约两次。

## 改哪些文件

1. `novelcomic-publisher/app/utils/stripe_utils.py`。对照 OpenCreator `utils/stripe_utils.py` 的 `get_stripe_webhook_event()`。400 的三条 detail 用现码原文。
2. `novelcomic-publisher/app/controller/v1/payments.py` 的 webhook。验签失败返回 400。验签通过后不要等处理器结束再给 Stripe 200。
3. `novelcomic-publisher/app/services/webhook/stripe_webhook_process_service.py`。对照 OpenCreator `services/webhook/stripe_webhook_process_service.py` 和 `webhook_process_service_support.py` 的落库、认领、`missing`、`create_task`。
4. `novelcomic-publisher/app/services/webhook/webhook_process_service_support.py`。`provider + event_id` 唯一索引要在启动时建上。已成功跳过。失败和过期的 processing 才能再认领。

# 10. 缺的 Stripe 事件按现码补处理器

做完要达到：分发表和 OpenCreator 一致。

| 事件 | 行为 |
| --- | --- |
| `checkout.session.completed` | 现有完成处理器 |
| `checkout.session.async_payment_succeeded` | 同一个完成处理器。先按 Stripe 当前 Session 再看是否已结算 |
| `checkout.session.async_payment_failed` | 未结算则订单 `pay_result=failed`。订阅类 intent 标失败。不加积分 |
| `checkout.session.expired` | intent 标 `expired`，订单 `pay_result=expired`。不加积分 |
| `invoice.paid` | 现有订阅成功处理器 |
| `invoice.payment_succeeded` | 同一个成功处理器 |
| `invoice.payment_failed` | 改本地订阅状态，不加积分 |
| `invoice.payment_action_required` | 本地标 `3ds_processing`，不加积分。已有可花积分先留着 |
| `customer.subscription.deleted` | 停用订阅积分。本地是 `upgrading`、`3ds_processing`、`processing`、`pending_confirmation` 时不停用。metadata 里有降级目标时，用 `oc_downgrade_` 加价目哈希做 Idempotency-Key，再创建一条新 Stripe 订阅 |
| `customer.subscription.paused` | 本地 `paused`，并停用订阅积分 |
| `customer.subscription.updated` | 只同步本地投影，不加积分 |
| `customer.subscription.pending_update_expired` | 清掉 pending 套餐字段，不加积分 |
| `charge.refunded` | 订单写退款标记。不扣、不停用可花积分 |

`invoice.payment_failed` 在 OpenCreator 里会把本地状态写成 `past_due`、`unpaid`、`incomplete` 或 `payment_failed`。Stripe 仍显示 active 时也可以写成 `payment_failed`。这个状态会挡住下一次新订阅结账。

过期和异步支付失败要把 `pay_result=processing` 挪走。留在 processing 上，下一次订阅结账会一直 409。

## 现在

分发只有完成、异步成功、两张发票付清、删除、以及一个只打日志的 `invoice.payment_failed`。暂停后积分仍是 active。Session 过期或异步失败后，订单一直 `processing`。退款不写订单。

## 改哪些文件

1. `novelcomic-publisher/app/services/webhook/stripe_webhook_process_service.py` 的事件表。对照 OpenCreator 同名文件的 `get_event_type_processor_mapping()`。
2. 按 OpenCreator `services/webhook/processors/stripe/` 补这些文件：`CheckoutSessionAsyncPaymentFailedProcessor.py`、`CheckoutSessionExpiredProcessor.py`、`InvoicePaymentActionRequiredProcessor.py`、`SubscriptionPausedProcessor.py`、`SubscriptionUpdatedProcessor.py`、`ChargeRefundedProcessor.py`。
3. `novelcomic-publisher/app/services/webhook/processors/stripe/InvoicePaymentFailedProcessor.py` 不要再只打日志。对照 OpenCreator 同名文件。
4. `novelcomic-publisher/app/services/webhook/processors/stripe/SubscriptionDeletedProcessor.py`。对照 OpenCreator 同名文件里停用前的 3DS 和升级保护。

# 11. 买积分入账和一次性订阅入账

做完要达到：普通充值仍走订单幂等，规则保持已经对齐的那一节。订单付清后的终态字段按 OpenCreator：`pay_result=completed`，`pay_status` 是 `paid` 或 `no_payment_required`。已处理过的订单不要再次加分。履约认领失败把 `fulfillment_status` 写成 `failed`，同一事件可以再试。认领成功之后重复投递不加第二次。

`is_subscription_purchase=true` 走 `process_one_time_subscription_order()`。发的是订阅积分，幂等键按 OpenCreator 现码的一次性订单键，不走每美元 400/500 的充值换算。年付的 12 倍积分在创建会话时已经乘进 metadata。这一支要合并旧订阅剩余积分，并取消旧的 Stripe 周期订阅。

`mode=subscription` 的 checkout 完成只更新订单，不加积分。

付清后调用 `create_payments_from_order_v2()`，按 `order_id` 往 `payments_v2` 插一条。同一 `order_id` 已有记录就返回那条，不插第二次。支付历史读的就是这张表，见第 14 节。只改查询、不写这张表，历史是空的。

`payment_type=custom_workflow` 进定制工作流自己的订单表，`pay_result=completed`，然后发飞书。不写充值积分，也不拿普通积分订单去履约。创建入口是 `POST /api/v1/custom_workflow/checkout`。

## 现在

付清订单写成 `pay_result=succeeded`。没有 `payments_v2`。一次性订阅函数在，但创建会话不写 `is_subscription_purchase`，正常支付进不了这一支。就算进来，也不取消旧 Stripe 订阅，也不合并剩余积分。定制工作流会把同一张 `orders` 标成已付，没有单独的订单集合，也没有创建这张 Checkout 的接口。

## 改哪些文件

1. `novelcomic-publisher/app/services/webhook/processors/stripe/CheckoutSessionCompletedProcessor.py`。对照 OpenCreator 同名文件的未结算返回、`custom_workflow`、履约认领、充值、一次性订阅。
2. `novelcomic-publisher/app/services/order.py` 里 `_process_completed_order_for_payment_v2()` 和 `process_one_time_subscription_order()`。对照 OpenCreator 的订单服务同名职责。
3. 订单终态名要和支付历史的 `paid` 过滤对得上，见第 14 节。`create_payments_from_order_v2()` 对照 OpenCreator `services/payments.py`。
4. 定制工作流订单对照 OpenCreator `services/custom_workflow.py` 和 `controller/v1/custom_workflow.py`。不要写进充值履约。

# 12. 订阅发票、年付按月、删除停用

做完要达到：发票付清仍要求 `status=active` 才发。`incomplete` 可以先抬成 `active` 再发，这和现码一致的话保持。月付写 `credit_grant_id=stripe_invoice:{invoice_id}:cycle:1`，先停用旧的订阅积分池。

年付不要在 Webhook 里把第 1 个月直接发掉。现码把任务交到 `RenewYearlySubscriptionPerMonthCreditsPublisher`，载荷里有 `cycle_number: 1`、`max_cycle_number: 12`、`credit_schedule_id`。每一期仍走 `save_subscription_credits()`，并删 `opencreator:subscription_user_credits:{user_id}`。同一期的闸门是 `stripe_invoice:{settlement_id}:cycle:{n}` 已经存在就跳过。

订阅积分文档要带 `start_timestamp` 和 `end_timestamp`。`end_timestamp` 用订阅本身的结束时间。`credits_balance` 按字符串存。没有 `end_timestamp` 时，第 13 节的 `end_timestamp > now` 会把这笔排除出总额。

删除订阅时，保护状态不停用积分，见第 10 节。其余调用 `a_deactivate_subscription_credits()`。停用后这笔不再进入总额。

结算锁现码是 `opencreator:subscription-credit-settlement:{user_id}`。拿不到锁按 OpenCreator 的锁失败处理，不要让整次 Webhook 变成给 Stripe 的 500。

## 现在

年付在 Webhook 里同步发第 1 个月，并插入 `yearly_subscription_credit_schedules`。`a_reward_yearly_cycle()` 没有生产调度，第 2 到第 12 期不会自己到账。创建会话又没写 `subscription_credits`，第 1 期也会因为积分为 0 失败。删除没有 3DS 和升级保护，也不会按降级 metadata 重建订阅。订阅积分没有 `end_timestamp`，`credits_balance` 是整数。

## 改哪些文件

1. `novelcomic-publisher/app/services/webhook/processors/stripe/SubscriptionSucceedProcessor.py` 的 `process_event()`。对照 OpenCreator 同名文件。`process()` 保持邀请旁路。
2. `novelcomic-publisher/app/services/subscription_credits_reward.py`。对照 OpenCreator 同名文件的月付直接发、年付改为投递按月任务。
3. OpenCreator 的按月消费者在 `tasks/consumers/` 里续发年付积分。NovelComic 按这个任务补消费者，不要只留一个测试才调用的 `a_reward_yearly_cycle()`。
4. `novelcomic-publisher/app/services/subscription_management.py` 的停用。对照 OpenCreator `a_process_subscription_deleted()` 和 `a_deactivate_subscription_credits()`。

# 13. 用户信息里的三池按现码过滤

做完要达到：`GET /api/v2/user/info` 的 `credits` 是充值积分展示值，`str(round(topup))`，不是三池总额。`subscription_credits` 只有 `{ credits_balance }`，没有有效订阅就是 null。`gift_credits` 是 `{ amount, receive_timestampe, expire_timestamp }`，没有未过期赠送就是 null。字段名 `receive_timestampe` 保持 OpenCreator 现码的拼写。

有效订阅的条件是 `status=active` 且 `end_timestamp > now`。读的时候把 `end_timestamp <= now` 的 active 改成 `canceled`。赠送只返回 `expire_timestamp > now`。没有“永不过期”也算进总额。

`subscription_billing_state` 来自订阅文档，不只看订单。字段有 `checkout_eligible`、`status`、`subscription_info_id`、`reason`。reason 按状态：

```text
active / trialing / paused → existing_subscription
past_due / unpaid / payment_failed → payment_requires_resolution
incomplete → payment_in_progress
upgrading / processing / pending_confirmation → subscription_change_in_progress
3ds_processing → authentication_required
```

没有阻塞订阅时 `checkout_eligible` 为 true，其余三个字段是 null。

`/info` 里还要有现码已经返回的 `system_level`、`has_3ds_subscriptions`、`subscription` 列表。没有这些字段时，前端的等级和改套餐对不上。

## 现在

`credits` 是数字。多了 `total_credits`。`subscription_credits` 把整份文档返回，没有 active 时还会回落成任意一条，canceled 也会出现。订阅不看 `end_timestamp`。赠送用 `expires_at`，空值算有效。`subscription_billing_state` 只查 `orders` 和 active 订阅积分，reason 只有 `payment_requires_resolution`、`active_subscription`、`checkout_in_progress`。没有 `system_level` 和 `has_3ds_subscriptions`。

## 改哪些文件

1. `novelcomic-publisher/app/services/unified_credits/unified_credits_service.py` 的 `get_user_credits_snapshot()`。对照 OpenCreator 同名方法和 `dao/subscription_user_credits.py` 的 `a_get_one_user_active_credits()`。过期 active 要改成 canceled。
2. `novelcomic-publisher/app/services/unified_credits/schemas.py`。快照字段改成上面三个展示形状。`expires_at is None` 不要再算进总额。
3. `novelcomic-publisher/app/controller/v2/user.py`。对照 OpenCreator `controller/v2/user.py` 的序列化。`credits` 用展示字符串。
4. `subscription_billing_state` 对照 OpenCreator `services/subscription.py` 的 `a_get_subscription_billing_state()`。

# 14. 用量、入账、支付历史按现码分页

做完要达到：三口都只查当前 `user_id`。query 名是 `page_number`、`page_size`，默认 1 和 10。`data` 里是 `records`、`total_records`、`total_pages`、`page_number`、`page_size`。

用量读 `usage_v2`，按 `created_at` 降序。返回给列表的字段按 OpenCreator `services/usage.py`：`user_id`、`model_name`、`cost`、`created_at`、`updated_at`、`time_zone`。`model_name` 用展示名，没有再用模型 id。

入账读 `credits_inout_record`，`direction=in`。映射成 `income_type`（等于 `event_type`）、`amount`、`reason`、`metadata` 和时间。不把 `balance_before`、`idempotency_key` 整份文档返回给这口。

支付历史读 `payments_v2`，过滤 `payment_status=paid`。未支付和失败订单不出现。时间按请求时区转换。V1 `GET /history` 和 V2 用同一套。

收支幂等键的拼法保持 OpenCreator `services/credits_inout_record.py`：充值是 `{event_type}:{order_id}`。订阅发放和过期的键对照现码，不要改成按取消行 id 拼接。

## 现在

query 名是 `page`，默认 `page_size` 20。`data` 是 `{ items, total, page, page_size }`。用量和入账返回整份文档。支付历史读 `orders`，不过滤已支付，processing 和 failed 也会出现。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v2/usage.py`。对照 OpenCreator `controller/v2/usage.py`。
2. `novelcomic-publisher/app/services/usage.py` 如果还没有，按 OpenCreator `services/usage.py` 的历史映射补上。
3. `novelcomic-publisher/app/controller/v2/payments.py` 的 `GET /history`，以及第 5 节的 V1 history。对照 OpenCreator `PaymentsService.get_payments_history_page_v2()`，集合是 `payments_v2`，条件是 `payment_status=paid`。
4. `novelcomic-publisher/app/services/credits_inout_record.py` 的入账分页映射。对照 OpenCreator 同名文件的 `get_income_history_page()`。

# 15. 赠送积分过期后按现码续发

做完要达到：赠送文档用 `expire_timestamp`，不是可空的 `expires_at`。`GET /api/v1/gift_credits` 只返回未过期记录。过期则 `data` 为 null，这一口不改 Mongo。`amount` 按现码序列化。`PATCH /notify` 把 `notify_status` 写成 `notified`，并改 Redis 里同一份 JSON。

默认积分 `DEFAULT_GIFT_CREDITS_AMOUNT` 是 `"500"`。默认有效秒数 `GIFT_CREDITS_EXPIRE_SECONDS` 是 `86400 * 7`。Redis 赠送 key 的 TTL 取剩余寿命和 7 天里较短的那个。key 过期后走 `renew_gift_credits`：未过期不续发；已过期先写 `gift_expire`，幂等键是 `gift_expire:{gift_credit_id}:{expire_timestamp}`，再写一笔 `official_gift`。

充值池 Redis 的 TTL 是 `CREDIT_BALANCE_CHECK_REDIS_TTL`，现码 `60 * 60 * 12`。刷新阈值是这个 TTL 的四分之一。订阅池 Redis 仍是 7 天。不要把充值 key 也写成 7 天。

Consumer 回填赠送池时只读未过期文档。过期后 Lua 不能再扣到这份余额。

## 现在

默认 TTL 是 30 天。`expires_at` 为空算未过期。GET 会在读的时候把过期记录改成 `amount=0`、`status=expired` 并写 `gift_expire`。没有 Redis 过期后续发。赠送 key 和充值 key 都固定 7 天。过期后预扣仍可能按 Redis 里的旧金额扣赠送池。充值 key 也不会在 12 小时后失效。

## 改哪些文件

1. `novelcomic-publisher/app/services/gift_credits.py` 和 `app/controller/v1/gift_credits.py`。对照 OpenCreator `services/gift_credits/gift_credits_service.py` 和 `controller/v1/gift_credits.py`。
2. 续发监听对照 OpenCreator `services/gift_credits/gift_credits_expiration_handler.py`、`tasks/consumers/renew_gift_credits_consumer.py`。
3. `novelcomic-consumer/app/services/billing/credit_balance_check_service_v2.py` 的赠送回填。对照 OpenCreator 同名文件的 `init_gift_credits()`。TTL 跟剩余寿命走。

# 16. 模型预扣的错误码、回滚一次、usage 入队

做完要达到：余额不够抛 `InsufficientCredits`，业务码 `3003`，文案 `Insufficient credits`。调用方能按这个码停住，而不是当成未知异常。

折扣不读订阅积分文档上的 `model_discount`。`SubscriptionCheckService.get_model_off_by_user()` 用价目表里该 `price_id` 的 `models_off[model_name]`，没有就按 `1.0`。没有 Stripe 订阅、但 `system_level` 大于 0 时，用等级对应且 `status=on`、`interval=yearly` 的那条计划。先按折扣 `1.0` 算一次，再按这个折扣算一次。两次里有一次 `cost <= 0` 就不预扣。

`pricing.per == "perToken"` 且提交时还没有 usage：提交阶段不占坑。模型成功后 `apply_success_billing()` 用结果里的 usage 再算 cost，然后才 `reserve`。已经有 deduction，或结果里的 `cost` 已经大于 0，不再算第二次。

失败回滚先认领 `rollback_status`。已经是 `done` 的不再加回。一次失败只把当时扣掉的订阅、充值、赠送加回 Redis，并删 pending。

模型成功后 `queue_usage_once()` 把消费放进 usage 任务，不在回调栈里同步写完账。`usage_status` 从排队到确认。`handle_consume()` 的顺序保持：写 `usage_v2`，认领 `pending` 或 `failed`，扣 Mongo 三池，写 `usage` / `usage_deduct` / `out`，删 pending，`deduction_status=deducted`。

Mongo 里 `user.credits` 和订阅 `credits_balance` 都是字符串。扣减用 `$toInt` 再 `$max` 下限 0，然后 `$toString` 写回。不要用整数 `$inc`。账本上的扣减金额用扣之前和扣之后的差额，扣到 0 时可以小于本次 cost。充值加分同样先 `$toInt` 再 `$toString`。

`emit_credits_deducted()` 仍在确认之后。不要用它代替 `usage_v2`。

## 现在

余额不够是 `InsufficientCreditsError`，消息 `insufficient credits`，没有 3003。折扣读的是订阅积分文档上的 `model_discount`，价目表的 `models_off` 不参与。按 token 计费在提交时就算，成功后没有 `apply_success_billing()`。失败回滚不写 `rollback_status`，收尾再次看到未完成会把三池再加回去。usage 在回调里同步写。`user.credits` 用整数 `$inc`。账本金额记的是 cost，不是余额实际减少的差额。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/invocation_billing_service.py`。对照 OpenCreator `services/invocation/invocation_billing_service.py` 的 `reserve_deduction_for_route()`、`apply_success_billing()`、`rollback_deduction_metadata()`、`queue_usage_once()`。
2. 折扣对照 OpenCreator `services/billing/subscription_check_service.py` 的 `get_model_off_by_user()`。
3. `novelcomic-consumer/app/services/billing/credit_balance_check_service_v2.py` 的 `rollback_deduct()`。加回量仍是当初三池各自扣掉的数。充值 key 的 TTL 改成 12 小时，见第 15 节。
4. `novelcomic-consumer/app/tasks/usage.py` 的 `handle_consume()`。对照 OpenCreator `tasks/usage.py`。同一 `deduction_id` 已 `deducted` 的提前返回保持不动。扣减管道用 `$toInt`、`$max`、`$toString`。
5. 业务码 `3003` 对照 OpenCreator `common/response/code_flow.py` 的 `INSUFFICIENT_CREDITS`。
6. 充值加分的 `$toString` 对照 OpenCreator `dao/user.py` 的 `add_user_credit()`。NovelComic 写在 `unified_credits_service.py` 的加分路径上，集合仍是 `users`。
