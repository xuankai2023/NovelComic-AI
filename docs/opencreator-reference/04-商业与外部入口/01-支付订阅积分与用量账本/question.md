# 支付、订阅、积分与用量账本 question

## 核心概念

- 这一组讲的是什么？
  - 只讲用户付钱、积分入账、余额展示，以及模型执行前的扣费边界。
  - 它不讲 Developer API 怎么用 `sk_` 创建 run。
  - 它也不讲飞书机器人怎么加积分。飞书加的是同一套充值池，入口不在这篇。

- 为什么要先背一句话？
  - 点击只换到 Stripe 的 `url`。
  - 积分等验签 Webhook 写入三池。
  - 模型花钱先在 Redis 预扣，成功后才写 `usage_v2`。

- 五件事怎么分？
  - 结账：创建 Checkout Session，返回 `url`。
  - 入账：验签后的 Webhook 改订单、订阅和积分。
  - 余额：`GET /api/v2/user/info` 读三池快照。
  - 预扣：Consumer 在 Redis 里占住本次模型费用。
  - 用量：模型成功后写入 `usage_v2`。

- 最短链路是什么？
  - 点击时同步打开 `/payment-redirect`。
  - Publisher 创建 Stripe Checkout Session。
  - 浏览器跳到 Stripe。
  - Stripe 发送验签 Webhook。
  - 发放充值积分或订阅积分，写收支，删 Redis 余额缓存。
  - 前端再读用户信息。
  - 模型执行前 Redis 预扣，成功后才写 usage。

## 结账和回站

- 为什么不能在异步回调里 `window.open`？
  - Safari 会拦截。
  - `openPaymentWindow()` 必须在点击的同步栈里打开 `/payment-redirect`，参数放进 sessionStorage。
  - checkout 请求发生在新页面里。

- 买积分和开订阅打哪两口？
  - 买积分：`POST /api/v1/payments/checkout`，Stripe mode 是 `payment`。
  - 新订阅：`POST /api/v2/payments/subscription/checkout`。
  - 改套餐：`PUT /api/v2/payments/subscription/plan`。

- checkout 成功返回什么？
  - `url`、`id`、`mode`、`status`。
  - `url` 只用于跳转。本地积分不变，只是多了一张未完成订单。

- 改套餐返回 `client_secret` 表示积分到了吗？
  - 不表示。
  - 这是 3DS。本地状态可以是 `3ds_processing`、`payment_failed` 或 `processing`。
  - 可花的订阅积分要等发票付清。

- 回站页做什么？
  - `/credits/result` 展示完成，并用 `BroadcastChannel` 把 `session_id` 告诉原窗口。
  - `GET /checkout/{session_id}/status` 和 `GET /invoice` 只读，不加积分。
  - 余额来自之后的 `GET /api/v2/user/info`。

- 为什么不能凭 `v1` / `v2` 判断积分在哪张表？
  - V1 仍保留同名结账和改套餐。
  - 积分按充值池、订阅池、赠送池分，不按 URL 版本分。

## 入账

- Webhook 为什么在登录白名单里？
  - Stripe 没有用户 JWT。
  - 白名单只跳过 JWT，不跳过 `Stripe-Signature`。
  - `STRIPE_WEBHOOK_SECRET` 为空或签名不对，返回 400，积分不变。

- 同一事件怎么去重？
  - 按 `provider + event_id` 落库。
  - 已经成功处理过的事件直接跳过。

- 一次性买积分什么时候加？
  - `checkout.session.completed` 或 `async_payment_succeeded`，并且 payment 已结算。
  - 未结算先返回。
  - 定制工作流订单提前返回，不进充值积分。

- 充值怎么换算，幂等键是什么？
  - 等级 `3`：每美元 500。
  - 其他用户：每美元 400。
  - 美分换算：`credits = cents * credits_per_dollar / 100`。
  - 幂等键是 `order_id`，锁是 `opencreator:credits:idempotency:{order_id}`。

- 幂等锁什么时候放开？
  - Mongo 写入成功前失败，放开锁。
  - Mongo 成功后删缓存失败，锁继续留着，避免再加一次。

- 订阅积分什么时候发？
  - `invoice.paid` 或 `invoice.payment_succeeded`。
  - 订阅状态必须是 `active`。
  - 月付发这一期。年付启动按月续发，每一期仍走 `save_subscription_credits()`。
  - 删除订阅走停用，这笔积分不再进入总额。

- 支付失败事件发积分吗？
  - 不发。
  - `invoice.payment_failed` 和 `invoice.payment_action_required` 只记下失败或待操作。

## 三池、历史和模型扣费

- 总额怎么加？
  - `total = topup + active subscription + unexpired gift`。
  - 充值积分在 `user.credits`。
  - 订阅积分要 `status=active` 且未过期。
  - 赠送积分要 `expire_timestamp` 还没到。

- 为什么快照和扣费不是同一个数据源？
  - 查询快照以 Mongo 为准。
  - 消费扣费以 Redis 为准。
  - 写入先改 Mongo，再删对应 Redis key，下一次扣费回填。

- 三张历史分别是什么？
  - `GET /api/v2/usage/history` 读 `usage_v2`。
  - `GET /api/v2/usage/income` 读入账方向的 `credits_inout_record`。
  - `GET /api/v2/payments/history` 读支付记录。
  - 一笔充值进后两张，不进用量历史。

- 记账失败为什么不回滚余额？
  - `safe_create_record()` 失败只记日志。
  - 已完成的余额变更不撤回。
  - 对不上时补录，不把积分扣回去。

- 预扣做了什么？
  - `reserve_deduction_for_route()` 先算价，再套订阅折扣。
  - `cost <= 0` 不占坑，也不写 usage。
  - Lua 先扣订阅，再扣充值，最后扣赠送。
  - 够了才写 `opencreator:pending_deduction:{deduction_id}`。
  - 这一步只改 Redis。

- 成功和失败之后呢？
  - 成功：`handle_consume()` 写 `usage_v2`，扣 Mongo，写收支，删 pending，状态收成 `deducted`。
  - 同一 `deduction_id` 已是 `deducted` 不再扣第二次。
  - 失败：`rollback_deduct()` 把 Redis 加回，不写 usage。

## NovelComic 迁移

- 编写顺序为什么不从付款成功页开始？
  - 先定三池、订单和收支。
  - 再做只返回 URL 的 checkout。
  - 再做验签和幂等入账。
  - 再让用户信息返回快照和三张历史。
  - 最后才把模型执行接到预扣和 `usage_v2`。

- 同名文件为什么不能当迁移起点？
  - `SubscriptionSucceedProcessor.process()` 原来只做邀请和支付成功信号。
  - `emit_credits_deducted()` 原来只发一条扣费事件。
  - 入账职责要接到 `process_event()` 和 `handle_consume()`，不要留成两条旁路。

- 本章最小验收是什么？
  - 未登录不能结账。登录后买积分和订阅都能返回 `url`，不付款则积分不变。
  - 密钥为空或签名错误时 Webhook 400，积分不变。
  - 已结算买积分只按 `order_id` 加一次，并写 `recharge`。
  - 发票付清后订阅积分增加；同一发票重放不加；只改套餐不加。
  - 回站页能显示完成。用户信息随后看到新三池。
  - 这笔钱在入账和支付历史里，不在用量历史里。
  - 余额不足预扣失败。足够时 Redis 减少并写 pending，当时还没有 `usage_v2`。
  - 成功后 usage 出现且同一 `deduction_id` 不重复扣。失败后 Redis 加回，没有 usage。
  - 过期赠送不进总额。年付同一期只发一次。

## 面试短答

- 一句话讲这条链？
  - 点击换 Stripe URL，验签 Webhook 入三池，模型先预扣 Redis，成功后才写 `usage_v2`。

- 一句话讲完成页？
  - 它只广播 `session_id`。到账看用户信息里的三池快照。

- 一句话讲预扣和 usage 的差别？
  - 预扣占的是 Redis。`usage_v2` 是模型成功之后的消费事实。

- 一句话讲 `callback_failed` 为什么不在这篇？
  - 那是 AI 通知 Consumer 失败。这篇的失败是支付没结算，或者模型失败后把预扣加回。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 结账、验签、三池、三张历史、Redis 预扣和 `usage_v2` 确认已经在代码里。
  - 参考笔记里“还没有这条支付账本”已经过时。
  - V1 支付文件仍只有买积分 checkout 和 Webhook。回站 status、发票、订阅模板、账单门户不在这个文件里。
  - 微信、支付宝、`3ds_processing`、`invoice.payment_action_required` 还没有对应实现。

- Webhook 现在走 `process()` 还是 `process_event()`？
  - 分发调用 `process_event()`，发票付清后发订阅积分。
  - `process()` 仍只做邀请奖励和支付成功信号。
  - 两套方法不能当成同一条入账。

- 模型扣费还是只发一条事件吗？
  - 不是。
  - 预扣 Lua 按订阅、充值、赠送扣 Redis，并写 `opencreator:pending_deduction`。
  - `handle_consume()` 写 `usage_v2`，同一 `deduction_id` 已确认就返回。
  - `emit_credits_deducted()` 在确认之后仍会发事件，它是旁路信号。

- 什么时候才算本章完整验收？
  - 不付款只有 URL，没有积分。
  - 错误签名不加分。同一订单、同一发票都不加第二次。
  - 回站完成之后，用户信息、入账历史、支付历史对得上，用量历史里没有这笔入账。
  - 模型成功写 usage，失败回滚 Redis。
  - 过期赠送和年付同一期也要单独过一遍。
