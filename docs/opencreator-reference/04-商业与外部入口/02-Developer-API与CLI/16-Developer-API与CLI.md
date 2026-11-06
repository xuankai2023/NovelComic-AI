# OpenCreator Developer API 与 CLI

## 职责

Developer API 让外部程序用 `sk_` API Key 管理模板副本、工作流和运行；CLI 用 device authorization 让用户在浏览器批准命令行设备并换取凭据。两者复用 Publisher 的账户和工作流执行能力，但都不是画布 Clerk JWT + WebSocket 协议。

## 入口

- CLI 发起：`POST /api/v1/cli/device/code`；轮询换证：`POST /api/v1/cli/device/token`。
- 浏览器批准：`GET/POST /api/v1/cli/device/authorization`，需要 Clerk 用户身份。
- CLI 自查/退出：`GET /api/v1/cli/info`、`POST /api/v1/cli/logout`。
- Developer Key：账户页通过 `/api/v3/developer/api-client` 创建、列出和吊销。
- Open API：`/api/developer/v1/templates`、`/workflows`、`/workflows/{id}/parameters`、`POST /workflows/{id}/runs`、`GET /workflow-runs/{task_id}`，以及 results、selection、cancel。

## 主链

```text
CLI
  → device/code 得 user_code + device_code
  → 浏览器打开授权页
  → Clerk 用户 approve/deny
  → CLI 轮询 device/token
  → 得短期受限凭据
  → /cli/info 或 logout

外部 SDK
  → Authorization 携带 sk_
  → API Key hash 查 owner_user_id + 限流
  → 创建/复制工作流
  → POST run：校验体积、余额并写 queued
  → enqueue 到同一 run_flow 执行链
  → 202 返回 task_id
  → GET 轮询直至终态；需要时提交 selection 或 cancel
```

Developer run 的通道是 `api:{task_id}`，没有画布的 `connection_id`、cursor、replay 或 `resume_ready`。

## 关键状态/消息

- device flow 至少有待批准、批准、拒绝、过期及临时不可用语义；token 端按 interval 轮询，并返回 `authorization_pending` 等设备流错误。
- CLI 凭据带 scope、过期时间和 key ID；logout 吊销服务端 key。
- Developer run 初始 `queued`，随后可见 `running`、选择等待/提交和终态；自动选点时内部选择状态对外可遮罩为 `running`。
- `POST .../runs` 的 `202` 表示运行文档已写并成功尝试入队，不表示结果已产生。
- Developer API 请求中 `inputs` 与 `input_overrides` 互斥，body 上限 512KB。
- `sk_` 明文只在创建响应出现一次，服务端保存 hash。

## 关键源码链接

- [Frontend CLI 授权调用](../../../../../opencreate/opencreator-frontend/src/features/cli-auth/api.ts)
- [Frontend Developer Key 调用](../../../../../opencreate/opencreator-frontend/src/api/modules/developer.ts)
- [Developer 工作流试跑器](../../../../../opencreate/opencreator-frontend/src/components/developer/workflow-run-tester.tsx)
- [CLI Device Flow 路由](../../../../../opencreate/opencreator-publisher/controller/v1/cli.py)
- [CLI Device Flow 服务](../../../../../opencreate/opencreator-publisher/services/cli_device_auth.py)
- [Developer Key 管理](../../../../../opencreate/opencreator-publisher/controller/v3/developer_api_client.py)
- [Developer API 路由装配](../../../../../opencreate/opencreator-publisher/developer_api/routers/__init__.py)
- [Developer run 路由](../../../../../opencreate/opencreator-publisher/developer_api/routers/workflow_runs.py)
- [Developer run 服务](../../../../../opencreate/opencreator-publisher/developer_api/services/workflow_runs.py)
- [API Key 鉴权与限流](../../../../../opencreate/opencreator-publisher/developer_api/middleware/api_key_auth.py)
- [CLI 认证合同](../../../../../opencreate/opencreator-publisher/docs/cli/auth-v1.md)

## 跨仓边界

- Frontend 只承载 CLI 浏览器批准页、Key 管理页和内部试跑 UI。
- Publisher 负责设备流、Key 鉴权、外部工作流资源、轮询投影和命令入队。
- Consumer 仍执行同一 DAG；不会因为入口是 Developer API 而变成另一套引擎。
- opencreator-ai 仍只处理运行过程中产生的模型任务，不识别 `sk_`。
- 外部 SDK 不连接画布 WebSocket；结果读取、HITL 和取消都走 Developer API。

## 遗留/未启用

- Developer router 可挂在 Publisher 主进程，也有独立 app；两者异常包装存在差异，成功模型一致。
- 主认证中间件对白名单路径放行后，Developer API 必须依赖自己的 `sk_` 鉴权；不能把“跳过 Clerk”误写成公开接口。
- CLI 当前 scope 偏读取/账户快照用途；不能默认等同于 Developer Key 的完整工作流权限。
- CLI、Developer Key 和 Clerk JWT 是三类凭据，尚无统一 token 交换协议，客户端必须按入口选择。
