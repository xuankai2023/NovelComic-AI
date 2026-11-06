# Developer API 与 CLI：这里面有哪些技术点

这组只讲两条外部入口：CLI 如何用浏览器批准换短期凭据，Developer API 如何用 `sk_` 管理 workflow 并创建 run。运行时谁调谁看 [01-Developer-API与CLI.md](./01-Developer-API与CLI.md)，落文件顺序看 [02.文件编写顺序.md](./02.文件编写顺序.md)。

先背一句话：

```text
CLI 换出的 ak_ 只读账户；
sk_ 代表 owner，用来创建 workflow 并入队；
执行仍走原来的 DAG，外部靠 REST 轮询 api:{task_id}。
```

边界固定：

- 画布登录、项目读取和可恢复 WebSocket 看 [画布登录门禁与项目加载](../../01-用户入口/02-画布登录门禁与项目加载/01-画布登录门禁与项目加载.md)。
- Consumer 仍执行同一套 DAG。`opencreator-ai` 只处理运行中产生的模型任务。
- Clerk Session JWT、`ak_`、`sk_` 各验各的，客户端按入口带凭据。

最短链路是：

```text
CLI
  → POST /api/v1/cli/device/code
  → 浏览器 /cli/authorize 由 Clerk 用户批准
  → CLI 轮询 POST /api/v1/cli/device/token
  → ak_
  → GET /api/v1/cli/info 或 POST /api/v1/cli/logout

外部程序
  → 账户页用 Clerk JWT 创建 sk_
  → Authorization 或 X-API-Key
  → hash 查 owner，并按 client 限流
  → 准备 workflow
  → POST /workflows/{flow_id}/runs
  → 202 + task_id
  → GET 轮询；需要时提交 selection 或 cancel
```

---

## 1. 三类凭据各管一段

| 凭据 | 形状 | 谁签发 | 能做什么 |
| --- | --- | --- | --- |
| Clerk Session JWT | 浏览器 session token | Clerk | 画布、账户页、CLI 批准页 |
| CLI API Key | `ak_` | Clerk API Keys，经 device flow 换出 | 读账户和积分，logout 时吊销自己 |
| Developer API Key | `sk_` | Publisher `developer_api_client` | 工作流资源、创建 run、轮询、选择、取消 |

CLI 的 scope 固定是 `opencreator:user:read`。Open API 前缀是 `/api/developer/v1`，只认 `sk_`。

---

## 2. 跳过 Clerk 之后，各自还有第二道验签

OpenCreator 源码：[auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py)、[api_key_auth.py](../../../../../opencreate/opencreator-publisher/developer_api/middleware/api_key_auth.py)。

`/api/developer/v1/*` 在主中间件白名单里，请求改由 `get_authenticated_api_client()` 处理：

```text
X-API-Key 优先，否则读 Authorization: Bearer
  → 必须以 sk_ 开头
  → SHA-256 查 status=active
  → hmac.compare_digest 再比一次 hash
  → 可选的每分钟限流，超限 429
```

缺 key、前缀不对、hash 不中、已吊销，都是 `401`。

CLI 按路径拆开：

| 路径 | 主中间件 | 路由再验 |
| --- | --- | --- |
| `POST /api/v1/cli/device/code` | 公开 | `CLI_AUTH_ENABLED`，按 IP 限流 |
| `POST /api/v1/cli/device/token` | 公开 | 同上，再按 device code 换证 |
| `GET/POST /api/v1/cli/device/authorization` | 把验签留给路由 | Clerk Session 的 issuer、audience、`azp`；POST 再验 `Origin` |
| `GET /api/v1/cli/info`、`POST /api/v1/cli/logout` | `Bearer ak_` 不走旧 JWT 解码 | `get_cli_principal()` 向 Clerk 验 key、scope、claims、过期时间 |

`CLI_AUTH_ENABLED` 关闭时，这些入口由 `require_cli_auth_enabled()` 返回 `404`。

---

## 3. CLI 的状态在 Redis，批准页只见 `user_code`

OpenCreator 源码：[cli.py](../../../../../opencreate/opencreator-publisher/controller/v1/cli.py)、[cli_device_auth.py](../../../../../opencreate/opencreator-publisher/services/cli_device_auth.py)。

`device/code` 返回 `device_code`、`user_code`、`verification_uri`、`verification_uri_complete`、`expires_in`、`interval`。浏览器只从 hash 取 `user_code`，随即清掉 fragment。`device_code` 和后来的 `ak_` 留在 CLI 进程。

批准依赖一次性 `decision_nonce`。`approve` 还要求本地账户已经初始化，否则 `409`。nonce 不对是 `403`，重复决定是 `409`。

token 轮询过快会加大 interval，并返回 `slow_down`。其余设备流错误是 `authorization_pending`、`access_denied`、`expired_token`、`temporarily_unavailable`。`grant_type` 必须是 `urn:ietf:params:oauth:grant-type:device_code`。

批准后的 Redis 状态会经过 `issuing`，成功后是 `issued`。响应里的 `access_token` 以 `ak_` 开头，并带 `expires_in`、`scope`、`api_key_id`。claims 固定有 `credential_kind=opencreator_cli`、`credential_version=1`、`authorization_id`。scope 必须正好是 `["opencreator:user:read"]`，而且 key 必须有过期时间。logout 吊销这把 Clerk key，成功是 `204`。

CLI 错误体是 `{ "detail": ... }`，并带 `Cache-Control: no-store`。同进程里的其它接口仍走 `responseBase`。

---

## 4. `sk_` 明文会进库，鉴权只认 hash

OpenCreator 源码：[developer_api_client.py](../../../../../opencreate/opencreator-publisher/controller/v3/developer_api_client.py)。

账户页这三条都要 Clerk 用户：

```text
POST   /api/v3/developer/api-client
GET    /api/v3/developer/api-client
DELETE /api/v3/developer/api-client/{client_id}
```

创建时生成 `sk_`，响应带回明文，文档里同时保存 `api_key` 和 `api_key_hash`。列表目前也会把库存的 `api_key` 返回给 owner。吊销把 `status` 写成 `revoked`，hash 查询要求 `active`，所以吊销后的 key 不能再进 Open API。

Key 上决定权限的是：

- `owner_user_id`：workflow 和 run 都记在这个用户下
- `allowed_flow_ids`：空列表表示该 owner 的 flow 都可访问；非空则 flow 必须在列表里，否则 `403`
- `rate_limit_per_minute`：空则不限；有值才用 Redis 计数

同一 owner 的两把 active Key 可以读到对方创建的 workflow。换一个 owner，按 `owner_user_id` 查不到。

---

## 5. 模板列表公开，workflow 归 owner

```text
GET  /api/developer/v1/templates?keyword=...
POST /api/developer/v1/workflows
POST /api/developer/v1/workflows/from-template
GET  /api/developer/v1/workflows/{flow_id}
PATCH /api/developer/v1/workflows/{flow_id}
GET  /api/developer/v1/workflows/{flow_id}/parameters
```

`GET /templates` 要先通过 `sk_` 鉴权，列表本身只按 keyword 取一页，不过滤 owner。

`POST /workflows` 给 owner 存一张空的 flow project。从模板复制时，用模板的 `share_id` 读分享图，再重写节点 id 和边 id。读取、更新、读参数都先过 `allowed_flow_ids`，再按 owner 查项目，没有就是 `404`。

---

## 6. `202` 表示 run 已入队

OpenCreator 源码：[workflow_runs.py](../../../../../opencreate/opencreator-publisher/developer_api/routers/workflow_runs.py)、[workflow_runs.py](../../../../../opencreate/opencreator-publisher/developer_api/services/workflow_runs.py)。

```text
POST /api/developer/v1/workflows/{flow_id}/runs
```

请求里 `inputs` 和 `input_overrides` 只能出现一个，出现的那份序列化后不超过 512KB。`user_selection` 单独也是 512KB。`idempotency_key` 可选，窗口 48 小时。`auto_select` 缺省是 `true`。

服务端先占幂等、拿 owner 级 start lock、校验节点，再查积分。不足 1 点是 `402`，这时还没有 queued 文档。幂等 key 已占但 run 还读不到是 `409`。start lock 失败是 `429`。

通过后写入 `developer_workflow_run`，`status=queued`，`channel_id=api:{task_id}`，再 `FlowService.enqueue_flow_task()`。入队异常会把这条 run 写成 `failed`。`202` 的含义是文档已写，并且入队调用返回成功。节点结果要等后面的 GET。

---

## 7. 回程写进 run 文档，调用方只轮询

OpenCreator 源码：[mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py)。

MQ 的 `ws_id` 以 `api:` 开头时，走 `handle_reply_event()`。`start_flow` 把 run 写成 `running`。落库失败会重试，仍失败则进入 developer event DLQ 后 ack。

`auto_select_mode` 为真时，选择事件在内部进入 `selection_submitting`，序列化成 `running`。为假时，对外状态是 `waiting_for_selection`，调用方再 `POST /workflow-runs/{task_id}/selection`。

`POST .../cancel` 先 `kill_flow_task`，再把状态写成 `cancel_requested`，HTTP 仍是 `202`。`cancelled` 要等后续终态事件。已经终态的 run 再取消是 `409`。

`GET /workflow-runs/{task_id}` 若发现 `queued`、`running` 或 `selection_submitting` 超过 30 分钟没有新事件，会把这条 run 写成 `failed`，错误信息是超时未收到事件。查询按 `api_client_id` 隔离，别的 Key 得到 `404`。查询、结果、选择响应带 `no-store`。结果里的图片、视频、音频地址会换成 CDN。

账户页另有一条 Clerk JWT 列表，给 Key 管理弹层用：

```text
GET /api/v1/task/api_client/list
```

---

## 8. 同一份路由有两个进程入口

[register.py](../../../../../opencreate/opencreator-publisher/core/register.py) 把 `developer_router` 挂进 Publisher 主进程，外面还有 Clerk 中间件和 `responseBase` 异常包装。[app.py](../../../../../opencreate/opencreator-publisher/developer_api/app.py) 用同一份路由起独立进程，自带 `/health`、`/readyz`、索引和 MQ consumer，异常体保持 FastAPI 默认形状。

成功时的路径、`202` 和 run 文档一致。主进程上的 CLI 路径另外切回 `{ "detail": ... }`。
