# Developer API 与 CLI：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-consumer`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-consumer`。

不在这一份：全站成功信封。账户页创建、列出、吊销 Key，以及 `GET /api/v1/task/api_client/list`，仍走现在的 `{ code: 200, msg: "ok", data }`。不要改成 OpenCreator 的 `{ code: 0, msg: "Success", traceId }`。Open API 和 CLI 的成功体是另一套，写在下面各节里。画布 `POST /api/v2/flow/runs`、`workflow:v2` 事件键、v2 状态名 `completed` / `killed` 不动。用户集合和积分三池入账不动。402 只读现有 `UserCreditsSnapshot.total_credits`。这条 Open API 没有模型列表，也没有开发者 webhook，不要加。`workflow-run-tester.tsx` 在 OpenCreator 里没有被任何路由引用，不要给它挂生产入口。

# 已经对齐，不要重写

这些路径对过现码，调用方能观察到的结果已经相同。差的是 Developer 入口还没接上去。

- 业务 JWT 用 Clerk PEM、RS256 验签，`AuthUser.user_id` 取 `sub`
- `FlowService.enqueue_flow_task()` 已把 `reply_channel_id` 写进 payload 的 `ws_id`，并返回 `trace_id`。NovelComic 的签名多一个必填 `redis_client`，没有 `persist_flow_task`、`send_initial_pong`。Developer 入队按这个现有签名调用，不要改画布入队
- `FlowService.save_workflow_project()` 和按 `flow_id + user_id` 读取项目已经可用
- `/developer/apikeys` 已用 `Protected` 包住，进入后 `openApiKeysThenEnterProjects()`，再替换导航到 `/projects`
- 模板实体已有 `template_id`、`share_id`、`name`、`desc`、`models`、`covers`、`videos`、`status`
- 分享已能按 `share_id` 读到文档。公开分享接口的白名单和邮箱校验保持不动
- 积分快照已有充值、订阅、赠送和 `total_credits`
- Consumer 已经会发 `start_flow`、`node_status`、`finish_flow`、`flow_killed`。画布回调继续把它们收成 v2 状态。Developer run 的状态名按下面第 7 节，不要改画布那套
- 四个集合名和 `ensure_developer_indexes()` 已经在 `app/database/mongo.py`，主进程启动时已经调用。索引名、唯一约束、幂等 TTL `expireAfterSeconds=0`、以及先丢掉旧索引 `developer_api_client_api_key_hash_status`，都和 OpenCreator 一致。不要重写这套索引。项目详情写在 `flow_projects` 上，不要另开 `flow_details`

# 1. Key 文档和 hash 查询

做完要达到：集合 `developer_api_client`。一条 Key 有 `client_id`、`name`、`owner_user_id`、`api_key`、`api_key_hash`、`key_suffix`、`allowed_flow_ids`、`status`、`rate_limit_per_minute`，以及 `created_at`、`updated_at`、`time_zone`。`time_zone` 缺省 `UTC`。时间用 UTC。`status` 只有 `active` 和 `revoked`。`allowed_flow_ids` 缺省空列表。`rate_limit_per_minute` 可以空。

`api_key_hash` 是 SHA-256 的 hex。`get_by_key_hash()` 的条件同时带 `status=active`。吊销后的同一条 hash 读不到。`list_by_owner()` 只列 active，最多 100 条。`revoke()` 按 `client_id + owner_user_id` 更新，把 `status` 写成 `revoked`，并写 `updated_at`。改不到返回 false。

这一节不挂 HTTP，也不改索引。

## 现在

集合名和索引已经在。没有 Key 的 schema 和 dao，插不进文档，也按 hash 读不回 owner。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/schemas/developer_api_client.py`。对照 OpenCreator `schemas/developer_api_client.py`。
2. 新增 `novelcomic-publisher/app/dao/developer_api_client.py`。对照 OpenCreator `dao/developer_api_client.py`。集合用现有的 `developer_api_client` 句柄。

# 2. `sk_` 鉴权和主中间件白名单

做完要达到：`X-API-Key` 优先，否则读 `Authorization`。有 `Bearer ` 前缀就去掉再取 key，没有前缀就用整段。缺 key 是 401，`detail` 是 `Missing API key`。不以 `sk_` 开头是 401，`detail` 是 `Invalid API key`。hash 查不到，或 `hmac.compare_digest` 对不上，同样是 `Invalid API key`。

`rate_limit_per_minute` 有值才计数。键是 `opencreator:developer_rate:{client_id}`。`INCR`，第一次 `EXPIRE 60`。计数大于限额是 429，`detail` 是 `Rate limit exceeded`。空限额不写这把键。

`/api/developer/v1/*` 放进主中间件 `WHITE_LIST`，不验业务 JWT。带 Clerk JWT、不带 `sk_`，到路由依赖时仍是 401。`ak_` 打这条前缀也是 401。

CLI 的三组路径等第 8 节再放行。这一节不要先把 `device/code` 放进白名单。

## 现在

主中间件只认业务 JWT 和内部服务密钥。白名单里没有 `/api/developer/v1/*`。没有 `get_authenticated_api_client()`。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/developer_api/middleware/api_key_auth.py`。对照 OpenCreator `developer_api/middleware/api_key_auth.py`。
2. `novelcomic-publisher/app/middleware/auth_middleware.py`。只把 `/api/developer/v1/*` 加进 `WHITE_LIST`。现有白名单、内部密钥和可恢复 WebSocket 放行保持不动。

# 3. 挂上 `/api/developer/v1`

做完要达到：同一份 router，前缀 `/api/developer/v1`，下面挂 templates、workflows、workflow_runs。主进程 `include_router`。独立进程再挂同一份，lifespan 里检查 Redis、Mongo，调用已经存在的 `ensure_developer_indexes()`，并启动现有 MQ consumer。主进程上这次调用保持不动，不要把索引定义再写一份。独立进程有 `GET /health` 和 `GET /readyz`，都返回 `{"status":"ok"}`，`readyz` 的 HTTP 是 200。

成功时 Open API 直接返回各节的响应模型，不套 `{ code, msg, data }`。主进程上，`/api/developer/v1` 的校验错误是 422，`{ "detail": <errors> }`。`HTTPException` 原样用自己的状态码和 `detail`。未捕获异常仍走现在的 `{ code: 500, msg: "Internal server error", data: null }`。独立进程不挂主进程这套异常包装，保持 FastAPI 默认错误体。

`202` 的路径在第 6、7 节。这一节可以先挂上空路由。

## 现在

主进程没有 `developer_router`。没有独立的 Developer API 进程。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/developer_api/routers/__init__.py`。对照 OpenCreator `developer_api/routers/__init__.py`。
2. `novelcomic-publisher/app/core/register.py`。只补 `include_router(developer_router)`。`ensure_developer_indexes()` 已经在 `register_init()` 里，不要再写一遍。
3. 新增 `novelcomic-publisher/app/developer_api/app.py`。对照 OpenCreator `developer_api/app.py`。索引调用现有函数。
4. `novelcomic-publisher/app/common/exception/handler.py`。只给路径 `/api/developer/v1` 补校验错误和 `HTTPException` 的 `{ "detail": ... }`。未捕获异常保持现有 500 信封。CLI 的未捕获异常在第 8 节另写。

# 4. 账户页创建、列出、吊销 Key

做完要达到：三条都要登录用户。

```text
POST   /api/v3/developer/api-client
GET    /api/v3/developer/api-client
DELETE /api/v3/developer/api-client/{client_id}
```

创建 body 是 `name`，长度 1 到 64，以及可选的 `rate_limit_per_minute`，`ge=1`。明文是 `sk_` 加上 `secrets.token_urlsafe(24)`。库里同时写明文和 hash。`key_suffix` 是明文最后 4 位。`owner_user_id` 是当前用户。`allowed_flow_ids` 写成空列表。成功 `data` 含 `client_id`、`name`、`owner_user_id`、`api_key`、`key_suffix`、`status`、`rate_limit_per_minute`、`created_at`、`updated_at`。

列表只返回该用户的 active Key，并且带上库存的 `api_key`。吊销成功是现有成功信封，没有业务 `data`。找不到，或不是这个 owner，HTTP 404，`msg` 是 `API client not found`。

前端 `/developer/apikeys` 的路由和跳转保持现在这样。弹层换成 Key / 任务两个页。`userLevel < 3`，或 `localStorage.__previewApiProGate === "true"`，面板上锁，不请求列表。`userLevel` 的算法对照 OpenCreator `useCreditsProvider.tsx`：没有当前用户订阅快照时是 0；有订阅取第一条 `subscription_metadata.level`；否则用 `system_level`。创建按钮还要求 `userLevel > 1`，不够就不发 POST。创建成功后的明文只在当次弹层里给复制。列表展示用 `sk_...` 加 `key_suffix`。客户端再滤掉 `status === "revoked"`。

任务页调用 `GET /api/v1/task/api_client/list`，查询参数是 `flow_id`、`api_client_id`、`status`、`page_number`、`page_size`。缺省页码 1、每页 10。只列当前 owner。记录字段对照 OpenCreator `ApiWorkflowTaskListItem`。状态用第 7 节的对外状态，`selection_submitting` 和 `selection_submitted` 在 `auto_select_mode` 下显示成 `running`。

## 现在

`ApiKeysModal` 只有标题和关闭。升级弹层类型只有 `api_keys`，没有任务页。前端没有 `system_level`，也没有这三个接口。Publisher 没有 v3 Key 路由，也没有 `/api/v1/task/api_client/list`。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/controller/v3/developer_api_client.py`。对照 OpenCreator `controller/v3/developer_api_client.py`。成功和 404 用 NovelComic 现有信封，字段和 HTTP 状态按上面写。
2. `novelcomic-publisher/app/controller/routers.py`。挂到 `/api/v3/developer/api-client`。任务列表挂到 `/api/v1/task/api_client`，处理函数在第 7 节的 run 服务就绪后接上；这一节先把路由位置留好。
3. `novelcomic-frontend/src/api/modules/developer.ts`，以及类型。对照 OpenCreator `src/api/modules/developer.ts`、`src/api/types/developer.ts`。
4. `novelcomic-frontend/src/features/billing/components/upgrade/api-keys-modal.tsx`。对照 OpenCreator `cards/api_panel.tsx`、`cards/api_keys.tsx`、`cards/api_tasks.tsx`，以及 `hooks/use-api-pro-gate.ts`。
5. `novelcomic-frontend/src/features/billing/runtime/upgrade-modal.store.ts`。弹层类型补上 `api_tasks`。`/developer/apikeys` 仍打开 `api_keys`。
6. 用户信息或订阅快照要把 `userLevel` 算出来。对照 OpenCreator `useCreditsProvider.tsx` 里 `userLevel` 那段。不要另做一套等级。

# 5. 模板和 workflow

做完要达到：下面这些都先过第 2 节的 `sk_`。成功体不套站点信封。

```text
GET   /api/developer/v1/templates?keyword=...
POST  /api/developer/v1/workflows
POST  /api/developer/v1/workflows/from-template
GET   /api/developer/v1/workflows/{flow_id}
PATCH /api/developer/v1/workflows/{flow_id}
GET   /api/developer/v1/workflows/{flow_id}/parameters
```

`keyword` 必填。列表只查 `status=published`，第 1 页，每页 10 条。关键字按 `name.en`、`name.zh`、`desc.en`、`desc.zh` 做不区分大小写的正则。不过滤 owner。响应只有 `records`，每条是 `template_id`、`name`、`desc`、`models`、`covers`、`videos`。

`POST /workflows` 是 201。body 只有 `name`，`extra` 禁止，去掉空白后不能空。序列化后不超过 2MB。给 owner 存一张节点和边都为空的 flow project。响应是 `flow_id`、`flow_name`、`created_at`。

从模板复制是 201，响应只有 `flow_id`。`template_id` 去掉空白后不能空。模板不存在是 404，`detail` 是 `Template not found`。没有 `share_id` 是 404，`Template share_id not found`。分享图不存在是 404，`Template share flow not found`。分享图要能读出 `flow.nodes`、`flow.edges` 和 `project_name`，这是 OpenCreator `ShareFlowDao.get_flow_data_by_share_id()` 的返回。公开分享接口不要改。

复制顺序：先用名字 `{project_name}_Copy` 给 owner 存空项目，空白名字用 `Untitled_Copy`。再把分享图的节点 id、边 id 全部换成新的。节点 id 是 `{node_type}-{毫秒时间戳}-{6位nanoid}`。边 id 是 `{source_type}-{target_type}-{毫秒时间戳}-{6位nanoid}`。节点 id 空、重复，或边的 source/target 对不上，是 400。然后把新图写回这个 `flow_id`。

读取、更新、读参数都先过 `allowed_flow_ids`。列表非空且不含这个 `flow_id`，是 403，`detail` 是 `API client is not allowed to access this workflow`。再按 `owner_user_id` 查项目，没有是 404，`Workflow not found`。同一 owner、allowlist 为空时，另一把 active Key 可以读到。另一位用户的 Key 是 404。

`GET` 工作流返回 `flow_id`、`flow_name`、`nodes`、`edges`。`PATCH` 至少要有 `name`、`nodes`、`edges` 之一，序列化后不超过 2MB。只改节点或边时，缺的那一项用库里的补齐，走现有的 `update_workflow_project_without_response()`。它抛 `ValueError` 时是 400，`detail` 是 `str(exc)`。改名字单独走现有的 `update_workflow_project_details_without_response()`，写在 `flow_projects` 的详情上。更新条数为 0 是 404，`Workflow not found`。响应是 `flow_id`、`updated_fields`、`updated_at`。

参数从可执行节点来。`assembleNow` 不算可执行。入参只认这四类：

```text
textInput   field_key=inputText    field_title=Text   input_type=text
imageInput  field_key=imageBase64  field_title=Image  input_type=image
audioInput  field_key=inputAudio   field_title=Audio  input_type=audio
videoInput  field_key=inputVideo   field_title=Video  input_type=video
```

标题按 `data.inputHint`、`data.label`、`data.description`、节点 type、节点 id 的顺序取第一个非空字符串。缺省值为空时 `required` 为 true。输出是没有出边的可执行节点，`is_default` 为 true。

## 现在

没有这些路由。模板只有实体，没有按关键字分页的查询。分享查询不会把 `flow` 和 `project_name` 交给复制函数。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/developer_api/services/templates.py` 和 `routers/templates.py`。对照 OpenCreator 同名文件，以及 `dao/template.py` 的 `get_template_page()` 里 published 和 keyword 条件。
2. 新增 `novelcomic-publisher/app/developer_api/services/workflows.py`、`schemas/workflows.py`、`routers/workflows.py`。对照 OpenCreator 同名文件。
3. 分享读取补一个只给复制用的函数。对照 OpenCreator `dao/share.py` 的 `get_flow_data_by_share_id()`。不要改 `GET /api/v3/share/*/info`。
4. 新增 `novelcomic-publisher/app/developer_api/services/workflow_parameters.py`。对照 OpenCreator 同名文件。参数路由在第 6 节的 run router 上。

# 6. 开跑：512KB、幂等、202

做完要达到：

```text
POST /api/developer/v1/workflows/{flow_id}/runs
```

HTTP 202。响应模型是 run，不套站点信封。`inputs` 和 `input_overrides` 不能同时出现。出现的那一份用 `json.dumps(..., ensure_ascii=False, separators=(",", ":"))` 算 UTF-8，超过 512KB 失败。`idempotency_key` 可选，长度 1 到 128。`auto_select` 缺省写成 true。

`task_id` 是 `TASK_` 加 8 位，字符集 `A-Z0-9`。通道是 `api:{task_id}`。

顺序固定：

```text
allowed_flow_ids
  → 有 idempotency_key 就预占
  → owner start lock
  → 按 owner 读 flow project
  → 简单 inputs 收成 overrides，再校验字段和 start_ids / end_ids
  → total_credits >= 1
  → insert developer_workflow_run，status=queued
  → enqueue_flow_task(reply_channel_id=api:{task_id}, flow_task_id=task_id, user_id=owner)
  → 把返回的 trace_id 写回 run
```

预占键是 `api_client_id + flow_id + idempotency_key`，窗口 48 小时，`expires_at` 上建 TTL 索引，`expireAfterSeconds=0`。已经占住且 run 能读到，直接返回那条 run，HTTP 仍是 202。占住但 5 次、每次间隔 0.1 秒仍读不到，是 409，`detail` 是 `Idempotent request is already in progress, retry shortly`。run 还没插入就失败，把这次预占删掉。已经插入之后不要删。

start lock 键是 `opencreator:devapi:start_run_lock:{owner_user_id}`。`SET NX`，TTL 2 秒。最多等 1 秒，每 0.05 秒试一次。拿不到是 429，`Too many concurrent start requests, retry shortly`，并放开还没落库的预占。释放用 Lua，只删自己的 token。

owner 用户不存在是 404，`Owner user not found`。积分不足是 402，`Insufficient credits`。这两种都不写 queued 文档。简单 inputs 的节点不在四类入参里，是 400，`Inputs are not allowed for node '{node_id}'`。override 字段不对，是 400，`Unsupported input override fields for node '{node_id}': ...`。`start_ids` 或 `end_ids` 里有未知或不可执行节点，是 400，`Unknown or non-executable start_ids: {ids}`，`end_ids` 同样这句，多个 id 用逗号加空格拼。

入队抛错时，把已经写下的 run 更新成 `failed`，`error_message` 是异常字符串，然后把异常继续抛出去。调用方这次不是 202。

入队调用 NovelComic 现有的 `enqueue_flow_task()`，把 `redis_client` 传进去。`flow_run_type` 是 `start`。不要为了对齐去改画布入队的参数表。

OpenCreator 在 `flow_run_type=start` 时还会把 `user_id`、`flow_task_id`、`flow_id`、`nodes`、`edges`、`start_ids`、`end_ids` 写进现有集合 `flow_task`，`status` 用模型缺省的 `running`。查询键是 `flow_task_id + user_id`。选择和结果读的是这份文档，不是 flow project。NovelComic 现有入队不写它。Developer 的 start 要单独插入这份文档，不要带 `protocol_version`、`client_request_id`，也不要调用 OpenCreator 的 `emit_b2b_signal_event`，也不要走 `POST /api/v2/flow/runs`。v2 查询按 `protocol_version` 过滤，这份文档不会被当成 v2 run。`continue` 时这份文档必须已经在，不在就入队失败，异常是 `Flow task not found`。

run 文档字段对照 OpenCreator `DeveloperWorkflowRun`。对外 `serialize_run()` 的字段是 `task_id`、`flow_id`、`status`、`run_id`（库里的 `flow_run_id`）、`trace_id`、`start_ids`、`end_ids`、`input_overrides`（库里的 `requested_inputs`）、`node_statuses`、`current_selection`、`error_message`、`created_at`、`updated_at`、`started_at`、`finished_at`。

下面这些索引已经在 `ensure_developer_indexes()` 里，这一节不要再建：

- `developer_workflow_run.task_id` 唯一
- `channel_id`
- `(api_client_id, status, updated_at desc)`
- `(owner_user_id, created_at desc)`
- `(owner_user_id, status, updated_at desc)`
- 幂等三字段唯一，名字 `developer_idempotency_unique`，`expires_at` 的 TTL 也已经是 `expireAfterSeconds=0`

## 现在

集合名和上面的索引已经在。画布 run 走 `/api/v2/flow/runs`，通道不是 `api:{task_id}`。没有 run 的 schema、dao，也没有 512KB 和字段互斥。没有 `has_sufficient_credits()` 这个函数名；三池合计已经在 `total_credits` 上。`enqueue_flow_task()` 不写 `flow_task` 文档。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/schemas/developer_workflow_run.py`。对照 OpenCreator 同名文件。
2. 新增 `novelcomic-publisher/app/developer_api/schemas/workflow_runs.py`。对照 OpenCreator 同名文件。
3. 新增 `novelcomic-publisher/app/dao/developer_workflow_run.py` 和 `dao/developer_idempotency.py`。对照 OpenCreator 同名文件。
4. 新增 `novelcomic-publisher/app/developer_api/services/workflow_runs.py` 的 `start_run()`。对照 OpenCreator 同名文件从 `_ensure_flow_access` 到入队返回的那一段。积分用现有 `get_user_credits_snapshot().total_credits`，阈值为 1。`flow_task` 的写入对照 OpenCreator `FlowDao.create_flow_task()`，集合用现有的 `flow_task`。
5. 新增 `novelcomic-publisher/app/developer_api/routers/workflow_runs.py` 的 `POST /workflows/{flow_id}/runs`，`status_code=202`。参数 GET 也挂在这份 router 上。索引不要动。

# 7. `api:` 回写、轮询、选择、取消、结果

做完要达到：MQ 消息头 `ws_id` 以 `api:` 开头时，走 `handle_reply_event(channel_id, event)`。没有画布 socket 时，只要 run 更新成功就 ack。对不上 run，reject 且不重新入队，不写 DLQ。可恢复的落库错误 nack 并重新入队。重试键是 `opencreator:devapi:mq_retry:{message_id或body摘要}`，TTL 3600。计数到 3 仍失败就写入 `developer_event_dlq`，记下 `channel_id`、`event_type`、摘要、错误和 `retry_count`，然后 ack。`api:` 通道上的坏 JSON reject 且不重新入队，不要走画布 watchdog。

交给 `handle_reply_event()` 的事件，`event_type`、`node_id`、`status`、`run_id`、`error_msg`、`options`、`ws_id` 在顶层。`ws_id` 就是这次的 `api:{task_id}`。NovelComic 现在把 `node_id` 和 `status` 放在嵌套的 `payload` 里，`start_flow` 的 body 也没有 `ws_id`。只在 `api:` 这一支把这些字段提到顶层，并写进消息头 `ws_id`。画布 v2 回调继续读嵌套 `payload`。

`start_flow` 把 run 写成 `running`，并在 `started_at` 为空时写上。节点事件写入 `node_statuses.{node_id}`。

选择事件：`event_type` 是 `selection_required`、`node_selection_required`、`node_select`，或顶层 `status == "select"`，或 `selection_required is True`。`auto_select_mode` 为真时内部写成 `selection_submitting`，对外序列化成 `running`，并立刻继续入队，`flow_run_type=continue`。自动提交的 payload 键从 `node_id` 第一个 `-` 前面那段取：这段是 `scriptSplit` 时键是 `splitText`，并先用 `_build_script_split_outputs()` 展开 options；否则键就是这一段。`continue` 的 `start_ids` 是边里 `source` 等于这条选择节点的那些 `target`，没有下游再用 flow task 上的 `start_ids`。自动提交失败则改成 `waiting_for_selection`，`error_message` 是 `Auto selection failed: {exc}`。`auto_select_mode` 为假时对外就是 `waiting_for_selection`。`selection_id` 缺省是 `sha1("{task_id}:{node_id}:{run_id}")` 的前 24 位 hex。

终态表按 OpenCreator 现码，不要加画布的 `completed` / `killed`：

```text
flow_complete / flow_completed / finish_flow / end_flow
  → success；event.success 显式为 false 时才是 failed
flow_failed / flow_error → failed
flow_cancelled / flow_canceled → cancelled
flow_status 为 success / failed / cancelled 时用这个值
```

`finish_flow` 在 `success` 缺省时写成 `success`。`flow_killed` 不在这张表里，不要自行收成 `cancelled`。终态写下 `finished_at`，并清掉当前选择。

查询按 `api_client_id`。别的 Key，包括同一 owner 的另一把 Key，得到 404，`Workflow run not found`。`queued`、`running`、`selection_submitting` 以 `last_event_at` 为准，没有则用 `created_at`，超过 1800 秒，这次 GET 把 run 写成 `failed`，`error_message` 是 `Run timed out (no events received)`。这个更新不写 `finished_at`。

```text
GET  /workflow-runs/{task_id}
GET  /workflow-runs/{task_id}/results
GET  /workflow-runs/{task_id}/selection
POST /workflow-runs/{task_id}/selection
POST /workflow-runs/{task_id}/cancel
```

前三个响应带：

```text
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Expires: 0
```

`POST selection` 和 `POST cancel` 是 202，不带这组头。没有当前选择时，GET selection 是 404，`No pending selection for this run`。提交时 run 不是 `waiting_for_selection`，是 409，`Workflow run is not waiting for selection`。`selection_id` 对不上，是 409，`Selection id does not match current pending selection`。同一条已经提交过，再提交一次返回当前 run。提交锁拿不到，是 409，`Selection request is already being submitted`。`user_selection` 同样 512KB。继续入队用 `flow_run_type=continue`，带上 `user_selection`。

取消只允许 `queued`、`running`、`waiting_for_selection`、`selection_submitting`、`selection_submitted`。其它状态是 409，`Cannot cancel run in '{status}' state`。先写 Redis `opencreator:flow_task:kill:{task_id}`，值 `1`，TTL 600 秒，再把 run 写成 `cancel_requested`。HTTP 仍是 202。`cancelled` 只来自上面的终态事件。

`GET` run 和任务列表把 `selection_submitting`、`selection_submitted` 在 `auto_select_mode` 下显示成 `running`。`GET` results 用库里的原始 `status`，不套这层显示。没有 `flow_run_id` 时 results 的 `outputs` 为空，`total_credits_used` 为 0。有 `flow_run_id` 时，节点和边从第 6 节写下的 `flow_task` 读，不从 flow project 读。按 `run_id` 取该次运行的结果，页码 1、每页 999。`credits_used` 取 `metadata.deduction.deduction_cost`，缺省 0。`total_credits_used` 把所有可执行节点的这笔加总。`outputs` 只放终端节点。每条的 `output_type` 走 `_resolve_output_type(node.type)`。`image`、`video`、`audio` 的地址换成 CDN，对照 OpenCreator `_apply_cdn_to_node_result_json()` 和 `_resolve_output_content()`。文本保持原文。画布 `POST /api/v3/result/all_batch_fetch` 只取每个节点最新一条，且不按 `run_id` 过滤，不要拿它当 results。

账户页列表走第 4 节的 JWT 路由，过滤条件是 owner，再叠加可选的 `flow_id`、`api_client_id`、`status`。查询 `status=running` 时，库条件是 `running`、`selection_submitting`、`selection_submitted` 三条。其它状态按原字面量。排序是 `created_at` 降序。

## 现在

`app/database/mq.py` 只有画布 v2 回调，不看 `api:`。Consumer 发布的 RabbitMQ 消息没有 `ws_id` 头，`node_id` 和 `status` 在嵌套 `payload` 里。没有 run 轮询、选择、取消和结果接口。画布取消写的是 v2 run 上的 `cancel_requested`，不是这把 Redis kill 键。

## 改哪些文件

1. `novelcomic-publisher/app/database/mq.py`。在现有 v2 回调旁边加 `api:` 分支。对照 OpenCreator `database/mq.py` 的 `_is_developer_channel()`、重试和 `developer_event_dlq`。v2 的 cursor 和状态映射保持不动。
2. 新增 `novelcomic-publisher/app/dao/developer_event_dlq.py` 和 schema。对照 OpenCreator 同名文件。索引已经在 `ensure_developer_indexes()` 里，不要再建。
3. `novelcomic-publisher/app/developer_api/services/workflow_runs.py` 的回写、查询、选择、取消、结果。对照 OpenCreator 同名文件从 `handle_reply_event()` 到 `get_results()`。
4. `novelcomic-publisher/app/developer_api/routers/workflow_runs.py`。对照 OpenCreator 同名文件的五条路由和 `no-store`。
5. `novelcomic-consumer/app/database/mq.py` 的 `MessagePublisher.publish()`，以及 `app/tasks/flow.py`、`app/tasks/flow_resume.py` 里组 `api:` 事件的地方。对照 OpenCreator `opencreator-consumer/database/mq.py` 的 `publish_message()`。消息头 `ws_id` 用这次 run 的 `reply_channel_id`。`api:` 事件的 `node_id`、`status`、`run_id`、`ws_id` 在 body 顶层。画布 v2 消息体保持现在的嵌套。
6. `novelcomic-publisher/app/services/flow.py`。补 `kill_flow_task()`，只写上面那把 Redis 键。对照 OpenCreator `services/flow.py` 的同名函数。不要改 v2 `cancel_run()`。
7. `novelcomic-consumer/app/tasks/flow.py` 和 `app/tasks/flow_resume.py`。在现有 `cancel_requested` 判断旁边，认 `opencreator:flow_task:kill:{flow_task_id}`。对照 OpenCreator `tasks/tools/flow_kill_checker.py`。认到之后仍走现在的 `_stop_flow_for_kill()`，它发出的 `flow_killed` 不要改名。
8. 新增 `novelcomic-publisher/app/controller/v1/developer_task.py`。对照 OpenCreator `controller/v1/developer_task.py`。挂到第 4 节留好的前缀上。成功信封用 `{ code: 200, msg: "ok", data }`。

# 8. CLI 设备流和 `ak_`

做完要达到：`CLI_AUTH_ENABLED` 缺省 false。关闭时，`device/code`、`device/token`、批准页、`/cli/info`、`/cli/logout` 都是 404，`detail` 是 `CLI authentication is disabled`。

配置缺省对照 OpenCreator `core/config.py`：

```text
CLI_AUTH_DEVICE_CODE_TTL_SECONDS = 600
CLI_AUTH_POLL_INTERVAL_SECONDS = 5
CLI_AUTH_POLL_SLOW_DOWN_SECONDS = 5
CLI_AUTH_ISSUING_LEASE_SECONDS = 30
CLI_AUTH_API_KEY_TTL_SECONDS = 7776000
CLI_AUTH_CODE_RATE_LIMIT_PER_MINUTE = 20
CLI_AUTH_LOOKUP_RATE_LIMIT_PER_MINUTE = 30
CLI_AUTH_TOKEN_RATE_LIMIT_PER_MINUTE = 60
CLI_AUTH_VERIFY_IP_RATE_LIMIT_PER_MINUTE = 60
CLI_AUTH_VERIFY_TOKEN_RATE_LIMIT_PER_MINUTE = 20
CLI_AUTH_TRUSTED_PROXY_HOPS = 0
CLI_AUTH_CLERK_CLOCK_SKEW_SECONDS = 5
CLI_AUTH_CLERK_BAPI_URL = https://api.clerk.com/v1
CLI_AUTH_CLERK_VERSION = 2026-05-12
CLI_AUTH_CLIENT_NAME = OpenCreator CLI
```

`POST /api/v1/cli/device/code` 公开。限流身份是客户端 IP。`CLI_AUTH_TRUSTED_PROXY_HOPS` 缺省 0，这时忽略 `X-Forwarded-For`，用 `request.client.host`，没有则 `unknown`。键是 `opencreator:cli:rate:code:{sha256(ip)}`，窗口 60 秒，限额 20。超过是 429，`Too many CLI authorization requests`，带头 `Retry-After`。`user_code` 形如 `XXXX-XXXX`，字母表 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`。`device_code` 是 `secrets.token_urlsafe(32)`。Redis 只存 SHA-256。三把键是 `opencreator:cli:device:{hash}`、`opencreator:cli:user_code:{hash}`、`opencreator:cli:authorization:{hash}`，TTL 是 600 加 60 秒。状态从 `pending` 开始。`device_name` 空则 `Unknown device`，`platform` 空则 `unknown`。`authorization_id` 是 `cli_auth_` 加 device hash 的前 32 位。连续 10 次分配撞键，是 503，`CLI authentication is temporarily unavailable`。对外不要返回内部那句 `Could not allocate a unique device code`。

响应有 `device_code`、`user_code`、`verification_uri`、`verification_uri_complete`、`expires_in`、`interval`。完整地址是 `{verification_uri}#{urlencode(user_code)}`。`verification_uri` 未配置，或不是允许的 http(s) 地址，是 503，`CLI authentication is not configured`。响应头 `Cache-Control: no-store` 和 `Pragma: no-cache`。

`GET /api/v1/cli/device/authorization?user_code=` 验 Clerk Session，不走主中间件的旧 JWT 解码。Session 用 PEM、RS256，必须有 `exp`、`iat`、`iss`、`nbf`、`sid`、`sub`。`sub` 以 `user_` 开头，`sid` 以 `sess_` 开头，`azp` 在允许列表里。issuer、audience 配置、`azp` 列表或 PEM 缺失，是 503，`Authentication service is unavailable`。Session 不对是 401，`Invalid Clerk session`。和请求上已有用户冲突是 401，`Conflicting Clerk session`。这条 GET 再按 `{user_id}:{ip}` 限流，键是 `opencreator:cli:rate:authorization:{sha256}`，60 秒 30 次，超过同样是上面的 429。`user_code` 规范化后不是 8 位，或找不到，是 404，`Device authorization not found`。

对外 `status`：`expires_at` 已过是 `expired`；内部 `issued` 显示 `consumed`；内部 `issuing` 显示 `approved`；其余用内部状态（`pending`、`approved`、`denied`）。每次 GET 都新发一个 `decision_nonce`（`token_urlsafe(32)`），把它的 hash 和当前 `user_id` 写进这条授权。返回 `authorization_id`、`status`、`client`、`scopes`、`expires_at`、`decision_nonce`。scope 只有一条，id 是 `opencreator:user:read`，描述是 `Read your OpenCreator account and credit balance`。

`POST` 同一路径再验 `Origin`，必须在 `CLI_AUTH_APPROVAL_ALLOWED_ORIGINS` 里。不在是 403，`Approval origin is not allowed`。body 是 `authorization_id`、`decision_nonce`、`decision=approve|deny`。`approve` 时，allowlist 非空且用户不在里面，是 403，`CLI authentication is not enabled for this user`。allowlist 空表示不限制。本地用户文档不存在是 409，`OpenCreator account is not initialized`。nonce 不对是 403，`Invalid decision nonce`。已经决定过是 409，`Device authorization is already decided`。

`POST /api/v1/cli/device/token` 先按 IP 限流，键是 `opencreator:cli:rate:token:{sha256(ip)}`，60 秒 60 次，超过同样是上面的 429。`grant_type` 必须是 `urn:ietf:params:oauth:grant-type:device_code`。对不上是校验错误 422，`detail` 来自 `unsupported device grant type`，不是下面的 OAuth 错误体。轮询快于当前 interval，是 400，body 是 `{ "error": "slow_down", "error_description", "interval" }`，interval 增加 5，上限 60。还没决定是 `authorization_pending`。拒绝是 `access_denied`。过期是 `expired_token`。这四个都是 400。`temporarily_unavailable` 是 503。这些错误体不是 `{ "detail": ... }`。换证经过 `issuing`，成功后是 `issued`。成功 200：`access_token` 以 `ak_` 开头，`token_type=Bearer`，`expires_in`、`scope=opencreator:user:read`、`api_key_id`。Clerk 创建 claims 固定是 `credential_kind=opencreator_cli`、`credential_version=1`、`authorization_id`。过期秒数是 `CLI_AUTH_API_KEY_TTL_SECONDS`。token 响应头同样 `no-store`。

`GET /api/v1/cli/info` 和 `POST /api/v1/cli/logout` 只接受 `Bearer ak_`。形状不对、Clerk 验不过、已吊销、已过期，是 401，`Invalid CLI API key`。`subject` 不以 `user_` 开头、scope 不是正好 `["opencreator:user:read"]`、claims 缺上面三项、没有过期时间，是 403，detail 分别是 `CLI API key must belong to a user`、`CLI API key has invalid scopes`、`CLI API key has invalid claims`、`CLI API key must expire`。验 key 还有 IP 和 token 两把限流，键是 `opencreator:cli:verify_rate:ip:{sha256}` 和 `opencreator:cli:verify_rate:token:{sha256}`，超过是 429，`Too many authentication attempts`。

`/cli/info` 返回 `schema_version=1`，用户含 `id`、`primary_email`、`display_name`、`system_level`，积分是 `topup`、`subscription`、`gift`、`total` 四个十进制字符串，去掉末尾 0。凭据类型是 `clerk_api_key`。用户不存在是 404，`User not found`。`/cli/logout` 吊销这把 Clerk key，成功 204，没有 body。Key 已经无效也回 204。Clerk 不可用是 503，`Authentication service is unavailable`。

`/api/v1/cli/` 的校验错误、`HTTPException` 和未捕获异常都是 `{ "detail": ... }`。未捕获是 500，`detail` 是 `Internal server error`，并带 `Cache-Control: no-store`、`Pragma: no-cache`。其它 Publisher 接口保持现有信封。`sk_` 打 `/cli/info` 是 401。`ak_` 打 Open API 是 401。

主中间件：

```text
device/code、device/token
  → 公开
GET/POST device/authorization
  → 主中间件不验 JWT，交给上面的 Session 依赖
/cli/info、/cli/logout
  → 只有 Bearer ak_ 才跳过旧 JWT 解码
```

## 现在

没有这些路由、Redis 状态和 Clerk API Key 调用。`CLI_AUTH_ENABLED` 不存在。异常处理把未捕获异常收成 `{ code: 500, msg, data }`。

## 改哪些文件

1. `novelcomic-publisher/app/config.py`。补上上面的 CLI 配置，缺省值按 OpenCreator `core/config.py`。
2. 新增 `novelcomic-publisher/app/schemas/cli_auth.py`。对照 OpenCreator `schemas/cli_auth.py`。
3. 新增 `novelcomic-publisher/app/services/cli_device_auth.py`。对照 OpenCreator `services/cli_device_auth.py`。
4. 新增 `novelcomic-publisher/app/services/clerk_api_keys.py`。对照 OpenCreator `services/clerk_api_keys.py` 的创建、校验、读取和吊销。
5. 新增 `novelcomic-publisher/app/dependencies/cli_auth.py`。对照 OpenCreator `dependencies/cli_auth.py`。
6. 新增 `novelcomic-publisher/app/controller/v1/cli.py`。对照 OpenCreator `controller/v1/cli.py`。
7. `novelcomic-publisher/app/controller/routers.py`。挂到 `/api/v1/cli`。
8. `novelcomic-publisher/app/middleware/auth_middleware.py`。补 `PUBLIC_CLI_PATHS`、`CLI_SESSION_JWT_ENDPOINTS`、`CLI_API_KEY_PATHS`。对照 OpenCreator `middleware/auth_middleware.py` 这三组。第 2 节已经放行的 Developer 白名单保持不动。
9. `novelcomic-publisher/app/common/exception/handler.py`。对照 OpenCreator `common/exception/handler.py` 的 `_is_cli_request()`。只改 `/api/v1/cli/`。
10. 新增账户快照。对照 OpenCreator `services/user_account_snapshot.py` 的 `get_cli_snapshot()`。积分数字用现有三池快照。

# 9. 浏览器批准页

做完要达到：路由 `/cli/authorize`，注册进 `novelcomic-frontend/src/routes/router.tsx` 的 `routeTree`。不要用 `Protected` 包住。`isCliAuthorizationPath()` 匹配 `/cli/authorize`、结尾多一个 `/`，以及可选前缀 `/en/`、`/zh/`。`src/main.tsx` 在 `createRoot().render()` 之前调用 `captureCliAuthorizationFragment()`。路由 `beforeLoad` 再调一次。hash 里的 `user_code` 写成 `XXXX-XXXX` 后，存进当前 tab 的 `sessionStorage`，键是 `opencreator:cli-auth:user-code:v1`，再用 `history.replaceState` 清掉整个 fragment。`device_code` 和 `ak_` 不进这个页面。

页面加 `meta robots=noindex,nofollow,noarchive` 和 `referrer=no-referrer`。Clerk 未加载停在 loading。没有合法 `user_code` 就等用户输入。未登录打开现有登录弹窗。已登录用 session token 调：

```text
GET  /api/v1/cli/device/authorization?user_code=...
POST /api/v1/cli/device/authorization
```

两个请求都带 `Authorization: Bearer <session token>`。POST body 是 `authorization_id`、`decision_nonce`、`decision`。响应必须有 `authorization_id`、`status`、`client`、`scopes`、`expires_at`、`decision_nonce`，且 scope 正好一条 `opencreator:user:read`。形状不对就停在契约错误。终态 `approved`、`denied`、`expired`、`consumed` 清掉本地 `user_code`。

`device/code`、`device/token`、`/cli/info`、`/cli/logout` 不由这个前端调用。

## 现在

没有 `/cli/authorize`，也没有 `features/cli-auth`。`main.tsx` 在渲染前不读 hash。路由是手写 `routeTree`，`/developer/apikeys` 包在 `Protected` 里。批准页不要套这个。

## 改哪些文件

1. 新增 `novelcomic-frontend/src/features/cli-auth/` 下的 `fragment.ts`、`state.ts`、`api.ts`、`contract.ts`、`types.ts`、`device-authorization-page.tsx`、`index.ts`。对照 OpenCreator 同名文件。
2. 新增 `novelcomic-frontend/src/routes/cli.authorize.tsx`。对照 OpenCreator `src/routes/cli.authorize.tsx`。登录弹窗用 NovelComic 现有的那个。
3. `novelcomic-frontend/src/main.tsx`。在 `createRoot().render()` 之前调用 `captureCliAuthorizationFragment()`。
4. `novelcomic-frontend/src/routes/router.tsx`。把这条路由加进 `routeTree`，不要包 `Protected`。

# 10. 内部试跑器

做完要达到：组件行为对照 OpenCreator `workflow-run-tester.tsx`。调用方自己填 base URL 和 key，可选 `Authorization: Bearer` 或 `X-API-Key`。按钮顺序是 parameters、start、get run、get selection、submit selection、results、cancel。自动轮询遇到对外状态 `waiting_for_selection` 就暂停，并再请求一次 selection。它不把 run 写进站点状态。

OpenCreator 现码没有路由引用这个组件。NovelComic 也不要挂生产路由。

## 现在

没有这个组件。

## 改哪些文件

1. 新增 `novelcomic-frontend/src/components/developer/workflow-run-tester.tsx`。对照 OpenCreator 同名文件。不要在 `router.tsx` 里注册它。
