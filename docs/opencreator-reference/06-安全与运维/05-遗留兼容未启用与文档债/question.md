# 遗留兼容未启用与文档债 question

## 核心概念

- “遗留兼容未启用与文档债”讲的是什么？
  - 讲的是五仓里已经存在的入口该贴哪张标签。
  - 画布主链仍是 v2 project、v2 run 和可恢复 WebSocket。
  - 它不新增一条执行链。文件在，先看有没有注册；注册了，再看函数第一行；README 单独对现码。

- 五张标签各满足什么？
  - 主链：当前产品在调用，状态和恢复语义是完整的。
  - 兼容：旧客户端、旧数据或滚动发布还用得到，路由或函数仍会执行。
  - 旁路：在运行，服务对象在画布 v2 run 之外。
  - 未启用：文件或路由在仓里，运行时被 410、注释、默认关闭的开关挡住。
  - 文档债：注释、README 或旧文档和现码对不上。

- 为什么“标了 `deprecated`”“返回 410”“README 写了”不能混在一起？
  - `deprecated` 只说明作者标过旧。函数仍可能被调用。
  - 能写成未启用的，是处理函数返回 410、注册行被注释或没进注册表、开关默认关闭并且运行时读取这个开关。
  - README 写了路由，路由表仍以 `controller/` 或 `src/routes` 为准。

## Publisher

- 主链落在哪？
  - `controller/v2/flow_runs.py` 和 `services/workflow_event_store.py`。

- 哪些入口仍是兼容？
  - `WS /api/v1/flow/flow_task/{ws_id}`：`accept` 后写入 `ws_global_map`。
  - `flow_result.{PUBLISHER_DEPLOY_ID}` 和 `flow_result.workflow.v2.{APP_ENV}`：两个名字都声明。
  - payments 旧保存方法标了 `deprecated`，函数还在。
  - `{prefix}/v1/flow/*` 命中白名单后跳过 Clerk JWT，返回 `PUBLIC_USER`。
  - `get_api_key` 返回 `Authorization` 头原文。有值就返回这串字符串，没有值且 `auto_error=False` 就返回 `None`。
  - `PATCH /api/v1/result` 和 `PATCH /api/v3/flow/project/details` 的参数列表里没有 `get_authenticated_user`。`POST /api/v1/result/fetch` 会取当前用户。

- 哪些入口是旁路？
  - Developer API、internal、Stripe / Clerk / 飞书 webhook、`/health`、`/readyz` 各走自己的鉴权。
  - `main_developer.py` 再调一次 `start_mq_consumer()`，和主进程监听同一条 `flow_result.{PUBLISHER_DEPLOY_ID}`。主进程已经 `include_router(developer_router)`。

- 哪些入口是未启用？
  - CLI：`CLI_AUTH_ENABLED = False`。`cli_auth.py` 返回 404，`detail` 为 `CLI authentication is disabled`。allowlist 非空且用户不在名单里时再返回 403。
  - SQS：`register.py` 里 `subscribe_receive_message` 和 `close` 是注释。启动调用的是 RabbitMQ 的 `start_mq_consumer()` 和 `start_workflow_v2_mq_consumer()`。
  - `AccessMiddleware`：类在 `access_log.py`。`register_middleware` 挂的是 gzip、CORS、认证、认证错误、时区和 trace，没有 `add_middleware(AccessMiddleware)`。
  - Miniapp：`mini_app_run_task` 写成 `running`，中间是 TODO，再写成 `completed`。

- Publisher 的文档债在哪？
  - `docs/README.md` 和 `docs/API文档.md` 仍列出 v1 history、kill、WebSocket。
  - 路由以 `controller/` 为准。

## Consumer

- 主链和兼容怎么分？
  - 主链是 `tasks/setup.py`、`tasks/flow_resume.py`，以及 `reconcile_terminal_flow_events`。终态补 outbox 只查 `protocol_version == 2`，状态在 success、failed、stopped，并且 `terminal_event_outbox_recorded != true`。
  - `recover_running_flows` 是兼容。条件是 `status = running`，并且 `protocol_version != 2`，或 `protocol_version = 2` 且 `start_initialized`。
  - legacy model id 是兼容。`to_opencreator_model_id` 以 `opencreator/` 开头则原样返回，否则查 `LEGACY_TO_OPENCREATOR_MODEL_ID`。
  - 回调 HMAC 是兼容。`consumer_webhook_secret` 为空时验签函数返回 `True`。有值才核对 `x-oc-timestamp` 和 `x-oc-signature`，用 HMAC-SHA256 和 `compare_digest`。

- 哪些是旁路，哪些是未启用？
  - 模型回调、internal snapshot、ops、维护调度挂在 Consumer 进程上，服务对象在画布页面之外。
  - 缩略图未启用。`get_thumbnail_s3_object_key` 记录 `disabled, return None` 后返回 `None`，随后缩略图字段也是 `None`。
  - SQS sender 未启用。`close()` 是注释。仓内没有业务调用 `a_send_message`。`register_init` 启动的是 `register_task`，关闭的是 Redis 和 RabbitMQ。

- Consumer 的文档债在哪？
  - `RUN_NODE_QUEUE_NAME` 和 SQS URL 仍在 `config.py` 里声明。启动路径不读它们。
  - `MIDDLEWARE_ACCESS` 为真时，Consumer 会挂自己的 `AccessMiddleware`。Publisher 那份同名类没有挂上。

## AI

- 哪些开关默认是关的？
  - `boolFromString` 默认 `"false"`。只有布尔 `true` 或字符串 `"true"` 才开。
  - `ENABLE_BULL_BOARD`、`CONFIG_LOADER_ENABLED`、`ALERT_FEISHU_ENABLED`、`MODEL_CALL_FEISHU_ENABLED` 都走这个解析。
  - Bull Board 在 `enableBullBoard` 为假时返回，`/admin/queues` 不会挂上。

- 模型注册和 webhook 怎么贴标签？
  - Midjourney V8.1 / V8.2 经 Youchuan 进入列表，是主链。
  - Youchuan 视频两个类的 import 和列表项都是注释，是未启用。
  - `assertTaskStatusCanAdvance` 有定义。worker 和 repository 的写路径没有 import 它，是未启用。
  - `provider === "tencent"` 时调用 `verifyTencentWebhookSignature`，失败返回 403，是主链。
  - 其余 provider webhook 用收到的 body 继续归一化，这段函数里没有它们的验签调用，是兼容。
  - 产物存储：COS 五项齐全时返回 `cos`，否则返回 `pass_through`。未传入 uploader 时用 `passThroughUploader`。
  - 新旧环境变量名用 `firstNonEmptyEnv` 接队列并发和 S3 / artifact 字段，是兼容。
  - `/health`、`/readyz`、媒体真人检测、live 脚本在进程里，不进画布 run，是旁路。

- AI README 对得上现码吗？
  - 对得上。它写的是 API、worker、`POST /v1/tasks` 和 pass-through 存储。

## Agent

- 两个 410 为什么不是同一张标签？
  - `POST /v1/agent/chat` 和 `POST /api/v1/agent/chat/stop` 先鉴权，再返回 410，`code` 为 `USE_AGENT_RUNS`，并指向 runs 和 cancel。`raise` 后面的旧实现留在文件里，执行停在 `raise`。这是未启用。
  - SSE 恢复窗口过期是另一处 410，`code` 为 `RESUME_WINDOW_EXPIRED`。这是主链，表示这条 runs 事件流的窗口已经过期。

- 还有哪些未启用？
  - `_connect_mcp` 会被调用，函数体第一行是 `return`。一次 run 的工具列表里没有动态 MCP 工具。
  - mem0：`MemoryConfig.enabled` 默认 `False`。`cfg.memory.enabled` 为真才 import `Mem0Memory`。
  - `ContinueWorkflowTool` 的类定义还在。`profile.py` 里 `_continue_workflow` 整段注释，主 profile 的工具列表没有这个工具。
  - `disabled: true` 的前端模型被 guard 拒绝暴露。

- select 和 confirm 为什么标签不同？
  - `RunSnapshot` 的字段是 `flow_task_id`、`ws_id`、`nodes`、`edges`、`session_id`、`flow_id`，没有 `user_id`。
  - `POST /v1/agent/workflow/select` 鉴权后按 `flow_task_id` 取快照，是兼容。
  - `POST /v1/agent/generation/confirm` 比对 `pending.user_id`。不一致返回 403，是主链。
  - 旧 `agent_sessions` 集合和 `fallback_model` 仍是兼容。

## Frontend

- 哪些路径还在执行，哪些没有路由文件？
  - `PUT /api/v1/flow/kill/task/{id}`、`POST /api/v1/result/batch_fetch`、v1 payments / subscription 与 v2 checkout 并存，是兼容。删除前先查调用点。
  - `/home`、`/templates`、`/template` 重定向到 `/`。`/workflows` 重定向到 `/projects`。`/developer/apikeys` 打开 `api_keys` 弹层，再 `replace` 到 `/projects`。这些是兼容。
  - `/pricing-test`、`/sign-up`、`/verify`、`/remotion` 出现在 `APP_ROUTE_PREFIXES`。`src/routes` 没有这四个文件，是未启用。
  - `/credits` 的路由文件在。`isCommercializationEnabled()` 返回 `true`，页面走商业化已开启的分支，是旁路。

- Frontend 的文档债在哪？
  - 根 README 写 Next.js 和 `src/app`。路由在 `src/routes`，构建读 `VITE_*`。
  - `package.json` 有 `test:*`。`ci.yml` 没有调用。

## 删除和横切

- 删除一条兼容入口按什么顺序？
  - 先写下标签、调用方和删除条件。
  - 再给 v1 flow、旧 Agent chat、legacy model id 加上调用量。
  - 然后停止写入旧格式，改读路径，去掉 fallback，最后删路由或集合。
  - 未启用能力留着显式开关，在不含密钥的 config dump 里写出开或关。
  - 跨仓删除用同一份 revision manifest 跑过生产方和消费方。
  - `deprecated` 方法在调用方还在时保持原函数。

- 这一组和另外三章怎么分？
  - 五仓 commit 没有写进同一份 manifest，归测试脚本那一章。
  - Publisher、Consumer、Agent 的排空各看本进程的一个数，归蓝绿那一章。
  - JWT、内部密钥、`auth_key`、HMAC、厂商 webhook 分属不同的门，归安全鉴权那一章。

## 面试短答

- 一句话讲遗留兼容未启用与文档债？
  - 文件在先看有没有注册，注册了再看函数第一行。410、注释掉的注册和默认关闭的开关才是未启用。`deprecated` 和 README 写过，都不等于运行时进不去。

- 一句话讲为什么 chat 的 410 和 SSE 的 410 不是一回事？
  - chat 的 `USE_AGENT_RUNS` 把旧入口挡掉。SSE 的 `RESUME_WINDOW_EXPIRED` 是当前 runs 事件流的窗口过期，主链仍要处理。

- 一句话讲为什么空 webhook secret 仍算兼容？
  - 密钥为空时验签函数返回 `True`，回调继续进 finalize。配了密钥才核对时间戳和签名。

- 一句话讲为什么 Miniapp 写成 `completed` 仍是未启用？
  - 状态会改完，中间的执行体仍是 TODO。完成状态不是这条任务已经跑过。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - Publisher 的 `WHITE_LIST` 没有 `/api/v1/flow/*`。这条路径不返回 `PUBLIC_USER`，继续验 JWT。`note_v1_flow_path` 只给 `/api/v1/flow` 计数，不改变鉴权结果。
  - Publisher 启动路径里没有 `subscribe_receive_message`，也没有 `main_developer.py`。结果消费者是主进程那一个。仓库里没有 `CLI_AUTH_ENABLED` 和 `AccessMiddleware`。
  - Consumer 密钥为空时 `_verify_callback_signature` 返回 `True`。有密钥才核对 `x-oc-timestamp`、`x-oc-signature` 和 HMAC。终态补 outbox 的查询带 `protocol_version == 2`。`recover_running_flows` 仍包含 `protocol_version != 2`。缩略图函数和 `a_send_message` 不在启动源码里。
  - legacy model id 仍会映射并计数。未知 id 抛出缺映射，不以 `opencreator/` 前缀原样返回。
  - AI 四个布尔开关未设置时为关。Bull Board 不注册路由。V8.1 / V8.2 在注册表里。两个 Youchuan 视频类保持注释。腾讯 webhook 走 `verifyTencentWebhookSignature`。COS 五项不全时存储是 `pass_through`。
  - `assertTaskStatusCanAdvance` 在 callback 投递成功后、写终态之前被调用。worker 入口文件没有 import 它。
  - `POST /v1/agent/chat` 和 `POST /api/v1/agent/chat/stop` 直接返回 410，`code` 为 `USE_AGENT_RUNS`。函数里没有鉴权，也没有 `raise` 后面的旧实现。`_connect_mcp` 第一行 `return`。`ContinueWorkflowTool` 整段注释。`memory_enabled` 为真才连接 mem0。
  - `RunSnapshot` 没有 `user_id`。`workflow/select` 按 `flow_task_id` 取快照。`generation/confirm` 比对 `pending.user_id`，不一致返回 403。SSE 窗口过期的 `code` 是 `RESUME_WINDOW_EXPIRED`。
  - Frontend 的 `/home`、`/templates`、`/template` 重定向到 `/`，`/workflows` 重定向到 `/projects`，`/developer/apikeys` 打开 API keys 弹层后再进 `/projects`。四个未挂载前缀没有对应的 `src/routes` 文件。根 README 的目录树和 `src/routes` 一致，并写明构建读 `VITE_*`。`package.json` 没有 `test:*`，CI 跑 `pnpm test`。
  - 支付页在 `VITE_COMMERCIALIZATION_ENABLED` 为 `'false'` 时显示未开启。其它值走支付结果。v1 checkout 仍有调用。

- 当前实现能不能算本章主链路打通？
  - 可以算标签已经能对上现码。
  - 因为白名单、空密钥验签、410、MCP 早退、模型注册表和前端重定向都能指出停住的那一行。
  - 这不等于旧入口已经删掉。v1 flow 仍在计数，legacy model id 仍会映射，旧 chat 仍返回 410。

- 当前和 OpenCreator 现码有哪些口径不同？
  - OpenCreator 的 `{prefix}/v1/flow/*` 命中白名单后跳过 JWT。NovelComic 这条路径继续验 JWT。
  - OpenCreator 的 chat 先鉴权再 410，`raise` 后面留着旧实现。NovelComic 是直接返回 410 的短函数，stop 也一样。
  - OpenCreator 的 `to_opencreator_model_id` 对 `opencreator/` 前缀原样返回。NovelComic 只认映射表，未命中就抛缺映射。
  - OpenCreator 的 `assertTaskStatusCanAdvance` 没有被 worker 调用。NovelComic 的 callback 投递路径会调用它，worker 入口仍不 import。
  - OpenCreator Frontend README 写的是 Next.js 和 `src/app`，`test:*` 不进 CI。NovelComic README 已改成 `src/routes` 和 `VITE_*`，CI 调用 `pnpm test`。
  - OpenCreator 的 `isCommercializationEnabled()` 固定返回 `true`。NovelComic 在环境变量为 `'false'` 时关掉支付页。
  - Publisher README 仍写 `/readyz` 检查 Mongo、Redis、RabbitMQ，失败返回 503。现码看的是维护文件和 `active_ws`。
  - AI README 仍写当前只做本地 smoke 队列、不接真实厂商。注册表、腾讯验签和 callback 已经在代码里。

- 当前测试覆盖了哪些本章风险？
  - Publisher 覆盖 v1 flow 只计数、启动源码不含 SQS 订阅、不存在 `main_developer.py`。
  - Consumer 覆盖空密钥验签通过、终态查询带 `protocol_version == 2`、启动源码不含缩略图和 `a_send_message`。
  - Agent 覆盖 chat 与 stop 的 410、`_connect_mcp` 在注册工具前返回、mem0 开关、select 快照不含 `user_id`、confirm 比对所有者。
  - AI 覆盖四个开关默认关、Bull Board 不注册、Youchuan 视频保持注释、worker 入口不 import 状态机函数。
  - Frontend 覆盖三条重定向、四个前缀没有路由文件、README 目录与 `src/routes` 一致、没有 `test:*`。

- 为什么说当前还有文档债？
  - Publisher README 的 `/readyz` 语义和 `app/controller/health.py` 不一致。
  - AI README 的 smoke-only 描述和已经注册的模型、webhook 不一致。
  - 这两份 README 还不能划掉。Frontend 根 README 的目录树已经和 `src/routes` 对齐，这一行可以划掉。

- 如果一条旧入口还在被打到，当前应该怎么看？
  - 先看它有没有注册。NovelComic 的 `/api/v1/flow/*` 没有进白名单，计数增加的同时仍走 JWT。
  - 再看函数第一行。chat 停在 410。`_connect_mcp` 停在 `return`。空 webhook secret 停在 `return True`。
  - 最后对 README。Publisher 和 AI 的根 README 还不能当成路由和探活的依据。

- 什么时候才算本章完整验收？
  - 任选一条入口，能在五张标签里找到一类，并指出停住的那一行。
  - `/api/v1/flow/flow_task/{ws_id}` 打到 NovelComic 时走 JWT 失败，而不是 `PUBLIC_USER`。
  - 空密钥回调验签通过。配上密钥后，错误签名进不了 finalize。终态恢复查询带 `protocol_version == 2`。
  - 四个 AI 开关未设置时 Bull Board 不存在。注册表里能找到 V8.1 / V8.2，找不到两个被注释的 Youchuan 视频类。
  - `POST /v1/agent/chat` 返回 410 和 `USE_AGENT_RUNS`。一次 run 的工具列表里没有动态 MCP 工具。
  - 浏览器能打开的路径都能在 `src/routes` 找到文件。README 和探活、模型注册对不上的行还留在文档债里。
