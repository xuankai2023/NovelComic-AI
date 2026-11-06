# 安全租户与内部鉴权 question

## 核心概念

- “安全租户与内部鉴权”讲的是什么？
  - 讲的是请求离开浏览器之后，哪把钥匙过哪道门，资源按谁的 `user_id` 查。
  - 登录怎么换成 Session，在登录与 JWT 那组。画布页面前端门禁在画布登录门禁那组。
  - `sk_` / `ak_` 留在 Developer API 那组。这里只在白名单之后给它们留路由依赖。

- 先背哪四句话？
  - `sub` 是用户。
  - `Base64(INTERNAL_API_KEY)` 是服务。
  - `auth_key` 是模型任务。
  - HMAC 是回调。
  - 查库条件里还要再写一次 `user_id`。

- 钥匙按门怎么分？
  - `__opencreator_jwt`：浏览器打 Publisher 普通 API、事件 WebSocket 首包、Agent 用户 API。
  - `INTERNAL_API_KEY`：Publisher `{prefix}/internal/*`，Consumer `/api/internal/*`。
  - `auth_key`：Consumer 调 AI `/v1/*`，头名就是 `auth_key`。
  - `CONSUMER_WEBHOOK_SECRET`：AI 回调 Consumer，头是 `x-oc-timestamp` 和 `x-oc-signature`。
  - 厂商 webhook secret：外部模型厂商打 `/v1/provider-webhooks/{provider}`。
  - `client_context.user_id` 写在任务体里，给日志和回传。租户判断仍看上面的钥匙和查询条件。

- 为什么“JWT 验过”“HTTP 202”“回调 200”“队列 ACK”不能当成资源权限？
  - JWT 验过只表示这把 token 的 `sub` 是谁。
  - HTTP `2xx` / `202` 只表示这次 HTTP。
  - RabbitMQ ACK、Redis ACK 只表示队列里的这条消息。
  - WebSocket `resume_ready` 只表示恢复走到了这一事件。
  - AI 回调 `200` 只表示这次回调 body。
  - 厂商 webhook `accepted` 只表示这次厂商通知。
  - 用户能不能读这张图、这条 run、这个 session，看查询里的 `user_id` 或 `owner_user_id`。

## 用户 JWT

- Publisher 普通 HTTP 怎么得到用户？
  - 路径不在白名单。
  - 去掉 `Bearer`。
  - `jwt.decode(token, CLERK_PEM_PUBLIC_KEY, algorithms=["RS256"])`。
  - `payload.sub` 写入 `request.user = AuthUser(user_id=sub)`。
  - `sub` 为空是非法 token。过期是过期 token。
  - 浏览器这条只钉 RS256 和 `sub`。`iss` / `aud` / `azp` 留给 CLI 审批路由自己的依赖。

- `get_authenticated_user` 还会再验一次签吗？
  - 不会。
  - 它返回 `request.user`。
  - 白名单路由若仍依赖它，拿到 `user_id=""`。

- 查询条件怎么钉用户？
  - 项目编辑读取是 `find_one({ flow_id, user_id })`。
  - run 的创建、继续、取消、查询把 `user_id=user.user_id` 传进服务，库条件是 `user_id + flow_task_id` 或 `user_id + command_id`。
  - 结果接口先写 `request.user_id = user.user_id`，再进 `ResultService`。
  - 请求体里的 `user_id` 进不了这些查询。
  - 分享读取是另一条函数，只按 `flow_id`。编辑画布走带 `user_id` 的那条。

- 用户 A 拿自己的 JWT 读用户 B 的资源，应该看到什么？
  - 结果与不存在相同。
  - 不要返回一份“存在但无权限”的区分，除非那条路由明确用 `403` 表达资源归属，例如 Agent 的 session / run。

## WebSocket 首包

- 为什么 upgrade 本身不验 JWT？
  - 中间件看到可恢复事件 WebSocket，返回 `PUBLIC_USER`。
  - 真正验签发生在 `websocket.accept()` 之后的第一条 JSON。

- 首包顺序是什么？
  - 15 秒内等第一条 JSON。
  - `event_type` 必须是 `auth`。
  - token 可以来自 `token` / `userToken` / `user_token`，可去掉 `Bearer` 前缀。
  - `JwtService.get_user_id_with_backoff()` 取 `sub`。
  - `get_run_summary(user_id, flow_task_id)`。
  - 发出 `event_type=authenticated`。
  - 下一条必须是 `attach_flow`。

- 失败时关哪个码？
  - 第一条不是 auth，或 token 空、验签失败：`4401`。
  - `get_run_summary` 把“run 不存在”和“run 属于别人”都收成 `WorkflowRunNotFound`：`4404`。
  - 下一条不是 `attach_flow`：`4400`。
  - 前端把状态标成 `connected`，发生在收到 `resume_ready` 时。

- 前端什么时候发这两帧？
  - `onopen` 里连续发送 `auth` 和 `attach_flow`，不等回包。
  - 服务端按到达顺序处理。
  - 没取到 token 就关闭。取 token 或发送失败关 `4003`，reason `auth_token_error`。

## 白名单

- 白名单跳过的是哪一层？
  - 跳过统一 Clerk JWT。
  - 命中后返回 `PUBLIC_USER`，`user_id=""`。
  - webhook 走自己的签名，Developer API 走自己的 `sk_`。
  - 名单只决定统一 JWT 跑不跑。

- 现码还跳过哪些业务路径？
  - 健康检查、文档、登录和 Clerk webhook。
  - `{prefix}/v1/flow/*`。
  - `{prefix}/v1/s3/*`、`v1/cos/*`、`v2/s3/*`、`v2/cos/*`。
  - `{prefix}/v1/models/*`、`v1/templates/*`。
  - `{prefix}/v1/feishu/*`。
  - `{prefix}/developer/v1/*`。
  - 分享 info、部分支付和社交 webhook。
  - `v1/result/fetch` 已从名单里拿掉。
  - `v2` 的 flow project 和 flow runs 留在 JWT 后面。

## 内部密钥

- 服务之间的钥匙长什么样？
  - 把 `INTERNAL_API_KEY` 做 Base64，放进 `Authorization`。
  - 没有 `Bearer` 前缀。
  - Base64 只改编码。密钥仍靠 TLS、网络边界和 secret 保管。

- Publisher 被调用和 Consumer 被调用有什么差别？
  - Publisher 路径是 `{FASTAPI_API_PREFIX}/internal/*`。OpenCreator 现码用 `==`，Base64 无 `validate=True`。通过后是 `PUBLIC_USER`，`user_id=""`。
  - Consumer 路径是 `/api/internal/workflow/{flow_task_id}/snapshot`。用 `secrets.compare_digest`，`b64decode(..., validate=True)`。通过后不造用户。
  - 密钥未配置：Publisher 比对失败；Consumer 返回 `503`，`internal API is not configured`。
  - 无密钥、解码失败、比对失败：`401`。
  - 用户 JWT 打在 snapshot 上得到 `401`。

- NovelComic 补 Publisher `/internal` 时用哪套比较？
  - 用 `compare_digest` 和 `validate=True`。
  - 密钥未配置为 `503`。
  - 通过后中间件给出服务身份。资源主人来自请求体里的 `user_id`。
  - 浏览器路由继续用 `sub` 覆盖请求体。

- 快照为什么可以不带 `user_id`？
  - Consumer 按 `flow_task_id` 取快照。
  - 事件 WebSocket 先 `get_run_summary(user_id, flow_task_id)`，确认归属之后，Publisher 才拿内部密钥去拉。
  - 客户端按 blue、green 依次试，超时 5 秒，`404` 换下一台。
  - 返回对象要对上 `flow_task_id`，且 `protocol_version == 2`。

- 同一把密钥还有哪条兼容路径？
  - `{prefix}/v3/media-face-verifications/ingest`。
  - `{prefix}/v3/media-face-verifications/status`。
  - 密钥对上之后，用户是 `system:admin`。

## AI 的 auth_key

- `/v1/tasks` 认哪把钥匙？
  - URL 以 `/v1/` 开头，且不是 `/v1/provider-webhooks/`。
  - 头 `auth_key` 与 `config.security.authKey` 全等，否则 `401`。
  - `AUTH_KEY` 在配置里必填。
  - `Authorization: Bearer <用户 JWT>` 不能代替这把头。

- Consumer 什么时候才把请求发出去？
  - 提交前要有提交 URL、`callback_url`，以及 `OC_AUTH_KEY` 或 `OPENCREATOR_AI_AUTH_KEY`。
  - 缺密钥在本地抛错，请求发不出去。
  - 发出去时头名是 `auth_key`。
  - 连接阶段失败会短退避重试。body 已经交给服务端的失败不重试。

## 回调 HMAC

- 签名怎么算？
  - `rawBody = JSON.stringify(publicPayload)`。
  - `timestamp` 是 ISO 时间。
  - `HMAC-SHA256(secret, timestamp + "." + rawBody)`，输出 hex。
  - 头是 `x-oc-timestamp`、`x-oc-signature`、`x-oc-idempotency-key`。
  - idempotency key 是 `{uuid}:{timestamp}`，每次投递新造。

- Consumer 怎么验？
  - `POST /callbacks/models/{vendor}`。
  - 配了 `CONSUMER_WEBHOOK_SECRET` 或 `OPENCREATOR_AI_CALLBACK_SECRET` 时，用 `hmac.compare_digest` 比对。
  - 缺头或比对失败：`401` / `invalid_signature`。
  - OpenCreator 的比对函数不看时间窗。
  - NovelComic 保留时间窗：`x-oc-timestamp` 超出容忍秒数仍是 `401`。
  - 密钥未配置时，两边都放行并继续解析。验收把这个分支记成“未验签放行”。

- 签名对上说明什么？
  - body 和这把 secret 匹配。
  - 结果归哪条 flow，回到 Consumer 上的 invocation。
  - 它不代替 run 的 `user_id` 查询。

## 厂商 webhook

- 为什么厂商入口不进 `auth_key`？
  - 路径是 `/v1/provider-webhooks/{provider}`。
  - hook 看到这个前缀直接返回。
  - 无 `auth_key` 的厂商 POST 仍能进这条路由。

- 谁真的验了签？
  - `provider === "tencent"`：`verifyTencentWebhookSignature` 失败返回 `403`。
  - MiniMax 的 `challenge` 在进业务归一化之前以 `200` 回显。
  - OpenCreator 的统一解析开头是 `void headers`，写入事件时 `signature_verified` 固定为 `true`。
  - NovelComic 让这个字段跟实际验签走：腾讯验过写 `true`，其余厂商保持未验。
  - `event_id` 去重发生在验签记录之后，去重只挡重复通知。

## Agent

- Agent 怎么得到用户？
  - 无 `Authorization`，且配置了 `public_chat_user_id`：使用该固定用户，`token=""`。请求里的 public user 与配置不同则 `403`。
  - 无 `Authorization`，且未配置：`401`。
  - 有 `Bearer`：`jwt.decode`，算法 RS256，取 `sub`。过期或非法 token 是 `401`。
  - 这里同样只钉 RS256 和 `sub`。

- 验过签之后还对什么？
  - session 文档和 run meta 的 `user_id` 必须等于认证用户，否则 `403`。
  - meta 缺失是 `404`。
  - 对不上的 active run 不交给当前用户。
  - `WorkflowDAO.get_workflow(flow_id, user_id)` 按 `flow_id + user_id` 查 flow。flow 文档对上之后，`flow_details` 再按 `flow_id` 取。
  - 工具上下文里 `user_id` 或 `flow_id` 缺一个，就返回错误文本，不查库。

- 本机口和公开口怎么分？
  - `GET /preview/active_runs`、`POST /preview/drain` 只放行 `127.0.0.1`、`::1`、`localhost`，其它来源 `404`。
  - 公开 `/health` 不带 active run 数。

## 对外抓取

- 抓取前拒绝哪些地址？
  - scheme 只接受 `http` / `https`。
  - `getaddrinfo` 之后，命中 `0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`::1`、`fc00::/7`、`fe80::/10` 就拒绝。
  - `validate_url_target` 在解析失败时拒绝。

- 重定向之后再验什么？
  - `validate_resolved_url` 看最终地址。
  - 主机名解析失败时，这个函数返回通过。
  - web 抓取和远程图片都是先校验、再连接、重定向后再校验。
  - 两次解析之间，代码没有把第一次的 IP 钉进同一次 socket。
  - `contains_internal_url` 扫命令字符串里的 URL。

## 面试短答

- 一句话讲安全租户与内部鉴权？
  - 浏览器 JWT 的 `sub` 写进 flow、run、result 和 Agent 资源查询；服务之间用 Base64 内部密钥；Consumer 调 AI 用头 `auth_key`；AI 回调用 `timestamp + "." + rawBody` 的 HMAC；厂商 webhook 走自己的入口。token 验过之后，查询里还要再带一次 `user_id`。

- 一句话讲为什么别人的 `flow_id` 读不到？
  - 编辑和 run 的查询条件同时有资源 ID 和认证得到的 `user_id`，请求体里的 `user_id` 覆盖不了 `sub`。

- 一句话讲 WebSocket 为什么先 accept 再验签？
  - upgrade 只放行连接，第一条必须是带 JWT 的 `auth`，`get_run_summary(user_id, flow_task_id)` 通过之后才 `authenticated`，下一条才允许 `attach_flow`。

- 一句话讲四把钥匙为什么不能互换？
  - 用户 JWT 打在 snapshot 或 `/v1/tasks` 上是 `401`；`auth_key` 不证明浏览器用户；HMAC 对上只说明回调 body 和 secret 匹配；内部密钥通过后的资源主人来自服务声明的 `user_id`。

- 一句话讲厂商 `accepted`？
  - 它表示这次通知进了厂商入口。腾讯签名错误是 `403`。其余厂商若没有单独验签，`signature_verified` 保持未验，`event_id` 去重只挡重复通知。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 未登录的业务 HTTP 发不出去。登录后 `request.user.user_id` 等于 JWT `sub`。
  - 用户 A 的 JWT 读取用户 B 的 flow、run、结果，结果与不存在相同。请求体里的 `user_id` 改变不了查询。
  - 可恢复事件 WebSocket 的 upgrade 放行。首包不是 auth 为 `4401`，run 属于别人为 `4404`，下一条不是 `attach_flow` 为 `4400`。
  - snapshot 无密钥或密钥错误为 `401`，密钥未配置为 `503`。用户 JWT 打在 snapshot 上为 `401`。比对用 `compare_digest`，Base64 使用 `validate=True`。
  - Publisher `/internal` 在密钥通过后，资源主人来自请求体里的 `user_id`。`/api/internal/model-config/*` 不再靠白名单跳过。
  - AI `/v1/tasks` 缺 `auth_key` 或用用户 JWT 代替，都是 `401`。对的 `auth_key` 能创建任务，`client_context.user_id` 留在 body。
  - `/v1/provider-webhooks/tencent` 不要求 `auth_key`。签名错误为 `403`。验过才把 `signature_verified` 写成 `true`，其余厂商保持未验。
  - 回调签名串是 `timestamp + "." + rawBody`。改一个字节为 `401`。时间窗外的 `x-oc-timestamp` 仍为 `401`。密钥未配置记成未验签放行。
  - Agent 非法 JWT、过期 JWT、未配置公钥都是 `401`。`user_id` 来自 `sub`，不把 `X-User-Id` 或 Bearer 字符串当成用户。别人的 session 或 run 为 `403`。未配置公共 chat 时，无 Bearer 为 `401`。
  - Agent 查 flow 的条件含认证 `user_id`。
  - `127.0.0.1`、`169.254.169.254`、内网网段在抓取前被拒绝。重定向落到内网时，第二次校验拒绝。

- 当前实现能不能算本章主链路打通？
  - 可以算四道门和资源查询打通。
  - 因为用户 `sub`、内部密钥、`auth_key`、回调 HMAC、厂商入口、Agent 归属和抓取前校验都已经分开。
  - 这不等于登录发码、画布页面前禁、DAG、cursor 和厂商 payload 字段也在本章里。那些看对应那组。

- 当前测试覆盖了哪些本章风险？
  - `scripts/accept-security-tenant-internal-auth.py` 按编写顺序的 10 条验收核对 JWT 进查询、WebSocket 关闭码、snapshot 密钥、Publisher 内部主人、回调时间窗和 Agent `sub`。
  - AI 验收覆盖缺 `auth_key` 的 `401`，以及腾讯签名错误的 `403`。
  - 前端验收覆盖没取到 token 就不发业务 HTTP。
  - Agent 网络测试覆盖内网、元数据地址和重定向后的第二次拒绝。

- 当前和 OpenCreator 现码故意留下的差别是什么？
  - Publisher `/internal` 用 `compare_digest` 和 `validate=True`。OpenCreator Publisher 现码是 `==`，且 Base64 无 `validate=True`。
  - 回调 HMAC 保留时间窗。OpenCreator 的比对函数不看时间窗。
  - 密钥为空时回调仍放行，单独记成未验签放行。
  - `signature_verified` 只在腾讯真的验过时为 `true`。OpenCreator 对非腾讯路径固定写 `true`。
  - `validate_resolved_url` 在主机名解析失败时返回通过。两次解析之间没有把第一次的 IP 钉进这次连接。

- 如果用户说能读到别人的画布，当前应该怎么排查？
  - 先看这条路由是编辑读取还是分享读取。分享读取本来只按 `flow_id`。
  - 再看查询条件里有没有认证得到的 `user_id`，有没有改用请求体里的 `user_id`。
  - WebSocket 再看是不是先 `get_run_summary(user_id, flow_task_id)`，别人的 run 应关 `4404`。
  - Agent 再看 `user_id` 是不是 `sub`。`X-User-Id` 指定别人时应 `403`，不能把这个头当成主体。

- 什么时候才算本章验收？
  - 用户 A 的 JWT 读不到用户 B 的 flow、run、结果。
  - snapshot 只认内部密钥，`/v1/tasks` 只认 `auth_key`，回调只认 HMAC。
  - 腾讯签名错误是 `403`。Agent 别人的 session / run 是 `403`。
  - 内网和元数据地址在连接前被拒绝，重定向到内网被第二次拒绝。
  - 登录发码、画布页面前禁、DAG、cursor 和厂商 payload 字段分别看对应那组。
