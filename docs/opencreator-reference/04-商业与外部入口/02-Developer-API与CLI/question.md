# Developer API 与 CLI question

## 核心概念

- 这一组讲的是什么？
  - 只讲 CLI 如何用浏览器批准换 `ak_`，以及 Developer API 如何用 `sk_` 管理 workflow 并创建 run。
  - 它不讲画布登录和可恢复 WebSocket。
  - 它也不讲 Consumer 怎么执行 DAG，也不讲 `opencreator-ai` 怎么处理模型任务。

- 为什么要先背一句话？
  - `ak_` 只读账户。
  - `sk_` 代表 owner，用来创建 workflow 并入队。
  - 执行仍走原来的 DAG，外部靠 REST 轮询 `api:{task_id}`。

- 四段怎么分？
  - CLI 批准：Clerk Session 决定设备能否拿到 `ak_`。
  - CLI 调用：`ak_` 读账户快照，logout 吊销自己。
  - Developer Key：`sk_` 认 owner，调 `/api/developer/v1`。
  - Developer run：`202` 之后用 GET 读 run 文档。

- 最短链路是什么？
  - CLI：`device/code` → 浏览器批准 → `device/token` 换 `ak_` → `/cli/info` 或 logout。
  - 外部程序：账户页创建 `sk_` → 准备 workflow → `POST .../runs` 得 `202` → GET 轮询，需要时提交 selection 或 cancel。

## 凭据

- 三类凭据分别谁签发？
  - Clerk Session JWT：Clerk，给画布、账户页、批准页。
  - `ak_`：Clerk API Keys，经 device flow 换出。
  - `sk_`：Publisher 的 `developer_api_client`。

- 跳过 Clerk 之后谁来挡 Developer API？
  - `get_authenticated_api_client()`。
  - `X-API-Key` 优先，否则读 `Authorization: Bearer`。
  - 必须以 `sk_` 开头，SHA-256 查 `status=active`，再用 `hmac.compare_digest` 比 hash。
  - 缺 key、前缀不对、已吊销都是 `401`。带 Clerk JWT、不带 `sk_` 同样拒绝。

- CLI 四类路径怎么验？
  - `device/code` 和 `device/token` 公开，但 `CLI_AUTH_ENABLED` 关闭时是 `404`。
  - 批准页 GET/POST 由路由验 Clerk Session；POST 再验 `Origin`。
  - `/cli/info` 和 `/cli/logout` 只接受 `Bearer ak_`，再验 scope、claims 和过期时间。

- `ak_` 的 scope 是什么？
  - 必须正好是 `["opencreator:user:read"]`。
  - claims 要有 `credential_kind=opencreator_cli`、`credential_version=1`、`authorization_id`。
  - key 必须有过期时间。不对是 `403`。
  - 它不能创建 workflow run。

## CLI

- 批准页为什么只见 `user_code`？
  - `device_code` 和后来的 `ak_` 留在 CLI 进程。
  - 浏览器从 hash 取 `user_code`，写入 sessionStorage 后清掉 fragment。

- 批准怎么防重放？
  - 一次性 `decision_nonce`。不对是 `403`。
  - 已经决定过是 `409`。
  - `approve` 还要求 allowlist 和本地账户已初始化，否则 `409`。

- token 轮询会返回哪些错误？
  - 过快：`slow_down`，并加大 interval。
  - 还没决定：`authorization_pending`。
  - 拒绝：`access_denied`。
  - 另外还有 `expired_token`、`temporarily_unavailable`。
  - `grant_type` 必须是 `urn:ietf:params:oauth:grant-type:device_code`。

- Redis 状态怎么走？
  - `pending` → `approved` 或 `denied`。
  - 换证时进入 `issuing`，成功后是 `issued`。

- logout 成功是什么？
  - `204`，没有 body。
  - 吊销的是这把 Clerk key。之后再调 `/cli/info` 失败。

- CLI 错误体为什么和别的接口不一样？
  - `/api/v1/cli/` 返回 `{ "detail": ... }`，并禁止缓存。
  - 其它 Publisher 接口仍走 `responseBase`。

## Developer Key 和 run

- `sk_` 明文存在哪？
  - 创建响应带回明文。
  - 文档同时保存 `api_key` 和 `api_key_hash`。
  - 列表目前也会把库存明文返回给 owner。
  - 鉴权只认 hash，并且要求 `status=active`。

- 两把 Key 的隔离维度是什么？
  - workflow 按 `owner_user_id`。同一 owner、`allowed_flow_ids` 为空时，另一把 Key 可以读。
  - allowlist 非空且不包含该 flow 是 `403`。另一位用户是 `404`。
  - run 查询再按 `api_client_id`。别的 Key 读同一个 `task_id` 是 `404`。

- 模板列表公开吗？
  - 不公开。要先过 `sk_`。
  - 列表本身只按 keyword 取一页，不过滤 owner。

- `202` 表示什么？
  - run 文档已写成 `queued`，并且 `enqueue_flow_task()` 返回成功。
  - 通道是 `api:{task_id}`。
  - 节点结果还没生成。

- 开跑前哪些情况不会留下 queued 文档？
  - `inputs` 和 `input_overrides` 同时出现，或 payload 超过 512KB，请求在进服务前失败。
  - 积分不足 1 点是 `402`。
  - 幂等 key 已占但 run 还不可读是 `409`。
  - start lock 失败是 `429`。
  - 入队抛错时，已经插入的 run 会被改成 `failed`。

- 外部怎么看见节点？
  - Consumer 仍执行原来的 DAG。
  - MQ 看到 `api:` 前缀就 `handle_reply_event()`，把状态写回 run 文档。
  - 调用方 `GET /workflow-runs/{task_id}`。
  - 不连画布 WebSocket。

- 自动选择和取消怎么表现？
  - `auto_select` 缺省为真。选择提交过程对外仍是 `running`。
  - 为假时对外是 `waiting_for_selection`，再 `POST selection`。
  - `POST cancel` 返回 `202`，当时状态是 `cancel_requested`。`cancelled` 等终态事件。已终态再取消是 `409`。

- 30 分钟没事件会怎样？
  - `queued`、`running`、`selection_submitting` 超过 30 分钟没有新事件时，下一次 GET 把 run 写成 `failed`。

- 两个进程入口差在哪？
  - 主进程和独立 `developer_api/app.py` 挂同一份路由。
  - 成功时的路径、`202` 和 run 文档一致。
  - 主进程还有 `responseBase`；独立进程保持 FastAPI 默认错误体。CLI 在主进程上另外返回 `{ "detail": ... }`。

## NovelComic 迁移

- 编写顺序为什么把 Key 放在批准页前面？
  - Open API 的鉴权、workflow 和 run 都不依赖 CLI。
  - CLI 还要 Redis、Clerk Session 和 Clerk API Keys。
  - 试跑器用来对合同，放在轮询通了之后。

- 本章最小验收是什么？
  - 未登录不能创建或吊销 Key。吊销后的 `sk_` 是 `401`。
  - 不带 `sk_`，或只带 Clerk JWT，调 workflow 被拒绝。
  - `sk_` 能从模板复制出只属于 owner 的 workflow。
  - 互斥字段或超过 512KB 的请求进不了服务。积分不足是 `402`，不写 queued。
  - 积分足够返回 `202`。MQ 回传后 GET 能看到 `running` 和终态。另一把 Key 是 `404`。
  - 自动选择对外仍是 `running`；关闭后能提交 selection。
  - 取消先是 `cancel_requested`，终态后才是 `cancelled`。
  - `CLI_AUTH_ENABLED` 关闭时 `device/code` 是 `404`。批准后能换 `ak_` 并读 `/cli/info`。
  - `ak_` 不能打 Open API，`sk_` 不能打 `/cli/info`。logout 的 `204` 之后旧 `ak_` 失效。

## 面试短答

- 一句话讲两条入口？
  - CLI 换只读的 `ak_`，Developer API 用 `sk_` 入队，结果都靠 REST 读 run 文档。

- 一句话讲 `202`？
  - 文档已写并且入队调用成功，节点结果还要等 GET。

- 一句话讲为什么不连 WebSocket？
  - 外部没有画布连接。`api:{task_id}` 把回程写进 run 文档。

- 一句话讲三类凭据？
  - Clerk JWT、`ak_`、`sk_` 各验各的，没有统一交换协议。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 还没有 CLI device flow，也没有 `sk_` Open API。
  - 没有 `api_key_hash`、`/api/developer/v1`、`device/code`、`CLI_AUTH_ENABLED`。
  - 前端没有批准页和 Key 面板。

- 画布入队能不能当成 Developer run？
  - 不能。
  - `FlowService.enqueue_flow_task()` 已经在画布执行链里。
  - 那条通道不是 `api:{task_id}`，也没有 `developer_workflow_run`。

- 什么时候才算本章完整验收？
  - Key 能创建、按 hash 认出 owner，吊销后 `401`。
  - `sk_` 能复制 workflow、入队、轮询、选择和取消。
  - 另一把 Key 读同一个 `task_id` 是 `404`。
  - CLI 能从批准换到 `ak_`，并且 `ak_` 与 `sk_` 不能混用。
