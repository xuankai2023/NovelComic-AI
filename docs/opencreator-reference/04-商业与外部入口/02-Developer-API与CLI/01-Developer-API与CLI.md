# OpenCreator 是怎么做 Developer API 与 CLI 的

机制拆解见 [00-Developer-API与CLI技术点.md](./00-Developer-API与CLI技术点.md)。按依赖落文件见 [02.文件编写顺序.md](./02.文件编写顺序.md)。这篇按一次请求走进来的顺序写。

## 一、先说结论

外部程序和命令行走两条凭据链，执行仍进 Publisher 已有的 workflow DAG：

```text
CLI
  → device/code
  → 浏览器 Clerk 批准
  → device/token 换 ak_
  → /cli/info 或 /cli/logout

Developer API
  → 账户页用 Clerk JWT 创建 sk_
  → Open API 用 sk_ 认 owner
  → 准备 workflow
  → POST run 写 queued 并入队
  → GET 轮询，直到终态、选择或取消
```

模型调用发生在 Consumer 执行 DAG 之后，由 `opencreator-ai` 处理那一次模型任务。`ak_` 和 `sk_` 停在 Publisher。

四段要分开记：

- CLI 批准：浏览器里的 Clerk Session 决定这台设备能否拿到 `ak_`。
- CLI 调用：`ak_` 读账户快照，logout 时吊销自己。
- Developer Key：`sk_` 代表某个 owner，用来调 Open API。
- Developer run：`POST .../runs` 返回 `202` 和 `task_id` 后，结果靠 REST 轮询读 run 文档。

---

## 二、前端必须有的文件

下面按用户碰得到的页面排。CLI 停在批准页。Key 和任务列表在账户弹层里。试跑器是内部页面，直接打 Open API。落文件时改按 [02.文件编写顺序.md](./02.文件编写顺序.md)，那里 Key 存储在批准页前面。

1. `src/routes/cli.authorize.tsx`：匹配 `/cli/authorize`。
2. `src/features/cli-auth/fragment.ts`：在 React 起来前抓住 hash 里的 `user_code`。
3. `src/features/cli-auth/device-authorization-page.tsx`：未登录开登录弹窗，已登录再查看并批准。
4. `src/features/cli-auth/api.ts`：只调批准相关的两个 HTTP。
5. `src/features/cli-auth/contract.ts`：校验批准响应形状。
6. `src/routes/developer.apikeys.tsx`：`/developer/apikeys` 转到项目页，并打开 Key 面板。
7. `src/features/billing/components/upgrade/cards/api_keys.tsx`：创建、列出、吊销 Key。
8. `src/api/modules/developer.ts`：封装 Key 和任务列表请求。
9. `src/features/billing/components/upgrade/cards/api_tasks.tsx`：按 owner 看 Developer run 列表。
10. `src/components/developer/workflow-run-tester.tsx`：用 `sk_` 试参数、开跑、轮询、选择、取消。

### `src/routes/cli.authorize.tsx`

OpenCreator 源码：[cli.authorize.tsx](../../../../../opencreate/opencreator-frontend/src/routes/cli.authorize.tsx)

```text
/cli/authorize
```

`beforeLoad` 调 `captureCliAuthorizationFragment()`，页面组件是 `CliDeviceAuthorizationPage`。路由层只接住 `user_code`。

### `src/features/cli-auth/fragment.ts`

OpenCreator 源码：[fragment.ts](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/fragment.ts)

从 URL hash 读取 `user_code`，写入当前 tab 的 `sessionStorage`，再用 `history.replaceState` 清掉整个 fragment。页面状态机在 [state.ts](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/state.ts)。

### `src/features/cli-auth/device-authorization-page.tsx`

OpenCreator 源码：[device-authorization-page.tsx](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/device-authorization-page.tsx)

页面行为：

- Clerk 未加载：停在 loading。
- 没有 `user_code`：等用户输入。
- 已加载但未登录：打开全局登录弹窗。
- 已登录：`getToken()` 取 session token，再 inspect。
- 用户点批准或拒绝：带 `authorization_id`、`decision_nonce`、`decision` 提交。
- 终态是 `approved`、`denied`、`expired`、`consumed` 时清掉本地 `user_code`。

它还给页面加上 `noindex` 和 `no-referrer`。

### `src/features/cli-auth/api.ts`

OpenCreator 源码：[api.ts](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/api.ts)

```text
GET  /api/v1/cli/device/authorization?user_code=...
POST /api/v1/cli/device/authorization
```

两个请求都带 `Authorization: Bearer <session token>`。`device/code`、`device/token`、`/cli/info`、`/cli/logout` 由 CLI 进程调用。

### `src/features/cli-auth/contract.ts`

OpenCreator 源码：[contract.ts](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/contract.ts)

批准响应必须能解析出 `authorization_id`、`status`、`client`、`scopes`、`expires_at`、`decision_nonce`。scope id 固定认 `opencreator:user:read`。形状不对就抛契约错误，不把半截对象送进页面状态。

### `src/routes/developer.apikeys.tsx`

OpenCreator 源码：[developer.apikeys.tsx](../../../../../opencreate/opencreator-frontend/src/routes/developer.apikeys.tsx)

`/developer/apikeys` 外包 `Protected`。进入后打开升级弹层的 `api_keys`，并替换导航到 `/projects`。创建、列表、吊销都在弹层卡片里。

### `src/features/billing/components/upgrade/cards/api_keys.tsx`

OpenCreator 源码：[api_keys.tsx](../../../../../opencreate/opencreator-frontend/src/features/billing/components/upgrade/cards/api_keys.tsx)

账户弹层里的 Key 卡片。它通过 `DeveloperApi()` 创建、列出和删除 Key。创建成功后的明文要在这一次展示里给用户复制。

### `src/api/modules/developer.ts`

OpenCreator 源码：[developer.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/developer.ts)

这些请求走登录用户的业务 JWT：

- `GET /api/v3/developer/api-client`
- `POST /api/v3/developer/api-client`
- `DELETE /api/v3/developer/api-client/{clientId}`
- `GET /api/v1/task/api_client/list`

任务列表可以带 `flow_id`、`api_client_id`、`status`、`page_number`、`page_size`。

### `src/features/billing/components/upgrade/cards/api_tasks.tsx`

OpenCreator 源码：[api_tasks.tsx](../../../../../opencreate/opencreator-frontend/src/features/billing/components/upgrade/cards/api_tasks.tsx)

同一个账户弹层里的任务页。它调用 `getApiTasks()`，按 owner 分页展示 Developer run。外部程序轮询仍走 `GET /workflow-runs/{task_id}`。

### `src/components/developer/workflow-run-tester.tsx`

OpenCreator 源码：[workflow-run-tester.tsx](../../../../../opencreate/opencreator-frontend/src/components/developer/workflow-run-tester.tsx)

内部试跑器。调用方自己填 base URL 和 `sk_`，可选 `Authorization: Bearer` 或 `X-API-Key`。它按顺序打：

- 读 parameters
- `POST /workflows/{flowId}/runs`
- `GET /workflow-runs/{taskId}`
- 读 selection、提交 selection
- 读 results
- cancel

它用来核对 Open API 合同。外部 SDK 直接请求 Publisher，页面本身不保存 run 的权威状态。

---

## 三、Publisher 必须有的文件

按请求走进 Publisher 的顺序背。Key 文档和 `sk_` 鉴权在前，Open API 和 run 在中，CLI 换证在后。

1. `schemas/developer_api_client.py`：Key 文档字段。
2. `dao/developer_api_client.py`：按 hash 查 active Key，按 owner 列和吊销。
3. `controller/v3/developer_api_client.py`：账户页创建、列出、吊销。
4. `controller/routers.py`：把 Key 路由挂到 `/api/v3/developer/api-client`，把 CLI 挂到 `/api/v1/cli`。
5. `developer_api/middleware/api_key_auth.py`：Open API 认 `sk_`。
6. `middleware/auth_middleware.py`：主中间件给 Developer API 和 CLI 留出各自的入口。
7. `developer_api/routers/__init__.py`：装配 `/api/developer/v1`。
8. `core/register.py`：主进程挂上 `developer_router`。
9. `developer_api/app.py`：独立进程挂同一份路由。
10. `developer_api/services/templates.py`：按 keyword 列模板。
11. `developer_api/services/workflows.py`：创建、复制、读取、更新 workflow。
12. `developer_api/schemas/workflow_runs.py`：定死 run 请求体积和互斥字段。
13. `schemas/developer_workflow_run.py`：run 文档和对外状态。
14. `developer_api/services/workflow_runs.py`：开跑、投影、轮询、选择、取消。
15. `database/mq.py`：`api:` 通道的回传写回 run 文档。
16. `controller/v1/developer_task.py`：账户页的 run 列表。
17. `schemas/cli_auth.py`：device flow 的请求和错误码。
18. `services/cli_device_auth.py`：Redis 里的批准状态机。
19. `services/clerk_api_keys.py`：向 Clerk 创建、校验、吊销 `ak_`。
20. `dependencies/cli_auth.py`：批准页验 Clerk Session，调用端验 `ak_`。
21. `controller/v1/cli.py`：code、authorization、token、info、logout。
22. `common/exception/handler.py`：CLI 路径使用自己的错误体。

### `schemas/developer_api_client.py`

OpenCreator 源码：[developer_api_client.py](../../../../../opencreate/opencreator-publisher/schemas/developer_api_client.py)

一条 Key 至少有 `client_id`、`name`、`owner_user_id`、`api_key`、`api_key_hash`、`key_suffix`、`allowed_flow_ids`、`status`、`rate_limit_per_minute`。`status` 只有 `active` 和 `revoked`。

### `dao/developer_api_client.py`

OpenCreator 源码：[developer_api_client.py](../../../../../opencreate/opencreator-publisher/dao/developer_api_client.py)

`get_by_key_hash()` 同时要求 `status=active`。`list_by_owner()` 只列 active。`revoke()` 按 `client_id + owner_user_id` 更新，避免吊销别人的 Key。

### `controller/v3/developer_api_client.py`

OpenCreator 源码：[developer_api_client.py](../../../../../opencreate/opencreator-publisher/controller/v3/developer_api_client.py)

三个接口都依赖 `get_authenticated_user`。创建时 `secrets.token_urlsafe(24)` 拼出 `sk_`，hash 用 SHA-256，`key_suffix` 取最后 4 位。owner 固定是当前 JWT 用户。

### `developer_api/middleware/api_key_auth.py`

OpenCreator 源码：[api_key_auth.py](../../../../../opencreate/opencreator-publisher/developer_api/middleware/api_key_auth.py)

`X-API-Key` 优先于 `Authorization`。查到文档后仍用 `hmac.compare_digest` 比较 hash。限流 key 是：

```text
opencreator:developer_rate:{client_id}
```

第一次计数时设置 60 秒过期。

### `middleware/auth_middleware.py`

OpenCreator 源码：[auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py)

三组 CLI 路径分开处理：

- `PUBLIC_CLI_PATHS`：`device/code`、`device/token`
- `CLI_SESSION_JWT_ENDPOINTS`：批准页的 GET 和 POST，主中间件返回未认证，把验签留给路由依赖
- `CLI_API_KEY_PATHS`：`/cli/info`、`/cli/logout`，只有 `Bearer ak_` 才跳过旧 JWT 解码

`/api/developer/v1/*` 在 `WHITE_LIST` 里。Clerk 放行后，由 `get_authenticated_api_client()` 认 `sk_`。

### `developer_api/routers/__init__.py`

OpenCreator 源码：[__init__.py](../../../../../opencreate/opencreator-publisher/developer_api/routers/__init__.py)

把 templates、workflows、workflow_runs 挂到：

```text
{FASTAPI_API_PREFIX}/developer/v1
```

### `core/register.py` 和 `developer_api/app.py`

主进程在 `register_router()` 里 `include_router(developer_router)`。独立 app 也 include 同一份路由，lifespan 里检查 Redis、Mongo、developer 索引，并启动 MQ consumer。独立 app 另有 `/health` 和 `/readyz`。

### `developer_api/services/workflows.py`

OpenCreator 源码：[workflows.py](../../../../../opencreate/opencreator-publisher/developer_api/services/workflows.py)

- `create_workflow()`：给 owner 存一张空的 flow project。
- `create_workflow_from_template()`：模板要有 `share_id`，分享图里的节点和边全部换成新 id。
- `get_workflow()` / `update_workflow()`：先过 `allowed_flow_ids`，再按 `owner_user_id` 读取。

### `developer_api/schemas/workflow_runs.py`

OpenCreator 源码：[workflow_runs.py](../../../../../opencreate/opencreator-publisher/developer_api/schemas/workflow_runs.py)

`StartWorkflowRunRequest` 规定 `inputs` 与 `input_overrides` 不能同时出现，序列化后的 payload 超过 512KB 直接校验失败。`SubmitSelectionRequest.user_selection` 同样是 512KB。

### `developer_api/services/workflow_runs.py`

OpenCreator 源码：[workflow_runs.py](../../../../../opencreate/opencreator-publisher/developer_api/services/workflow_runs.py)

`start_run()` 生成 `TASK_` 前缀的 `task_id`，通道固定：

```text
api:{task_id}
```

入队调用是 `FlowService.enqueue_flow_task()`，`reply_channel_id` 用这条通道，`user_id` 用 Key 的 owner。积分不足返回 `402`。

`handle_reply_event()` 按 `channel_id` 找回 run。`start_flow` 把状态写成 `running`。选择事件在 `auto_select_mode` 下进入 `selection_submitting`，序列化给客户端时显示为 `running`。

`get_run_for_client()` 要求 `task_id` 属于当前 `api_client_id`，否则 `404`。

### `database/mq.py`

OpenCreator 源码：[mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py)

`_is_developer_channel()` 判断 `ws_id` 是否以 `api:` 开头。developer 回传先落 run 文档。没有对应的画布 socket 时，只要 run 已更新，消息就 ack。落库的可恢复错误会 nack 重试，超过次数写入 `dao/developer_event_dlq.py`。

### `schemas/cli_auth.py` 和 `services/cli_device_auth.py`

OpenCreator 源码：[cli_auth.py](../../../../../opencreate/opencreator-publisher/schemas/cli_auth.py)、[cli_device_auth.py](../../../../../opencreate/opencreator-publisher/services/cli_device_auth.py)

device code 存在 Redis hash 里，状态从 `pending` 走到 `approved` 或 `denied`，换证时再进入 `issuing`，完成后是 `issued`。token 请求的 `grant_type` 必须是：

```text
urn:ietf:params:oauth:grant-type:device_code
```

轮询过快返回 `slow_down` 和新的 `interval`。批准后由 `ClerkApiKeyService.create_cli_api_key()` 发 key，scope 只有 `opencreator:user:read`，claims 里有 `credential_kind=opencreator_cli`、`credential_version=1`、`authorization_id`。

### `dependencies/cli_auth.py` 和 `controller/v1/cli.py`

OpenCreator 源码：[cli_auth.py](../../../../../opencreate/opencreator-publisher/dependencies/cli_auth.py)、[cli.py](../../../../../opencreate/opencreator-publisher/controller/v1/cli.py)

`get_cli_approval_user()` 用 Clerk PEM 验 session token，要求 `sub` 以 `user_` 开头、`sid` 以 `sess_` 开头，并且 `azp` 在允许列表。`POST` 决定前，`get_cli_approval_decision_user()` 再检查 `Origin`。

`get_cli_principal()` 只接受 `ak_`。scope 必须正好是 `["opencreator:user:read"]`，key 必须有过期时间，claims 必须带 CLI 标记。`/cli/info` 读 `UserAccountSnapshotService.get_cli_snapshot()`。`/cli/logout` 吊销 Clerk key。

### `common/exception/handler.py`

OpenCreator 源码：[handler.py](../../../../../opencreate/opencreator-publisher/common/exception/handler.py)

路径以 `/api/v1/cli/` 开头时，校验错误、HTTP 错误和未捕获异常都返回 `{ "detail": ... }`，并禁止缓存。其它 Publisher 接口仍走 `responseBase`。

---

## 四、运行时链路

### 1. CLI 申请设备码

```text
CLI
  → POST /api/v1/cli/device/code
  → require_cli_auth_enabled()
  → CliDeviceAuthService.create_device_authorization()
  → Redis 写入 pending
  → 返回 user_code、device_code、verification_uri、interval
```

`CLI_AUTH_ENABLED` 关闭时，这条接口是 `404`。

### 2. 浏览器批准

```text
用户打开 /cli/authorize#user_code=...
  → fragment 取走 user_code 并清掉 hash
  → Require 登录
  → GET /api/v1/cli/device/authorization?user_code=...
  → 验 Clerk Session
  → 返回 authorization_id、scopes、decision_nonce
  → POST 同一路径，body.decision = approve | deny
```

`approve` 时先看用户是否在 CLI allowlist，再确认本地账户已初始化。nonce 不对是 `403`。已经决定过是 `409`。

### 3. CLI 换证和退出

```text
CLI 按 interval 轮询
  → POST /api/v1/cli/device/token
  → pending：authorization_pending
  → denied：access_denied
  → approved：向 Clerk 创建 ak_
  → 200 返回 access_token、expires_in、scope、api_key_id

之后
  → GET /api/v1/cli/info
  → POST /api/v1/cli/logout
```

`/cli/info` 返回用户、积分和凭据元数据。logout 成功没有 body。

### 4. 账户页发 Developer Key

```text
已登录用户
  → POST /api/v3/developer/api-client
  → 生成 sk_
  → 写入 hash 和明文
  → 响应带回 api_key
```

之后的 Open API 不再带这个用户的 Clerk JWT。

### 5. 外部程序准备 workflow

```text
sk_
  → GET /api/developer/v1/templates?keyword=...
  → POST /api/developer/v1/workflows/from-template
  → 新 flow_id 归 owner_user_id
  → GET /api/developer/v1/workflows/{flow_id}/parameters
```

也可以 `POST /workflows` 直接建空图，再用 `PATCH` 更新。

### 6. 创建 run

```text
POST /api/developer/v1/workflows/{flow_id}/runs
  → 校验 inputs / input_overrides / 512KB
  → 幂等预占
  → 查 owner 的 flow project
  → has_sufficient_credits(required_amount=1)
  → insert developer_workflow_run，status=queued
  → enqueue_flow_task(reply_channel_id=api:{task_id})
  → 202 { task_id, status: queued, trace_id }
```

### 7. 轮询、选择、取消

```text
Consumer 执行 DAG
  → MQ 回传到 api:{task_id}
  → handle_reply_event() 更新 run
  → 外部 GET /workflow-runs/{task_id}
  → 需要人工选择时 GET/POST selection
  → 停止时 POST cancel
  → 终态后 GET results
```

`auto_select` 缺省为真时，选择提交过程对外仍是 `running`。`POST .../cancel` 的 `202` 里状态是 `cancel_requested`，`cancelled` 等终态事件写回。`GET` 若发现 `queued`、`running` 或 `selection_submitting` 超过 30 分钟没有事件，会把 run 写成 `failed`。

---

## 五、和 NovelComic 对照

NovelComic 还没有 CLI device flow，也没有 `sk_` Open API。登录、flow project 和 `enqueue_flow_task()` 先就位，再按 [02.文件编写顺序.md](./02.文件编写顺序.md) 从 Key 存储写到 CLI 批准页。

`202` 只说明 run 已入队。节点状态以 `GET /workflow-runs/{task_id}` 读到的 run 文档为准。
