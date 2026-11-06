# 25：小程序、节点块、AppFlow 与定制业务

## 总边界

这四块都是 Publisher 的产品扩展面，但语义不同：

- 小程序：用 `miniapp_id + params` 创建独立任务并查询结果。
- 节点块：把一组可复用节点保存成用户积木。
- AppFlow：给已有 workflow 增加 App 展示元数据和可见节点。
- 定制业务：购买人工/定制工作流服务并查询订单。

它们都不能自动等同于 v2 Workflow run 主链。

## 小程序

### 已挂载入口，执行链未启用

- `POST /api/v1/miniapp/create_task`
- `GET /api/v1/miniapp/get_task/{task_id}`
- `GET /api/v1/miniapp/get_list/{miniapp_id}`
- `GET /api/v1/miniapp/get_list`

创建口验证用户，把 `miniapp_id`、参数和 `user_id` 交给 `MiniAppService`；查询口按用户隔离任务和成功结果。持久化集合是 `miniapp_task`、`miniapp_results`，队列名来自 `MINIAPP_QUEUE_NAME`。

当前只能确认“创建任务记录、发布队列消息、查询任务”的接口存在：

- Publisher 主进程没有注册 Miniapp consumer；
- `tasks/miniapp.py` 的执行逻辑仍是 TODO，即使单独启动也只会把任务从 running 改成 completed，不产生业务结果；
- 因此不能把 Miniapp 写成端到端可用能力。

源码：[`miniapp.py`](../../../../../opencreate/opencreator-publisher/controller/v1/miniapp.py)、[`services/miniapp.py`](../../../../../opencreate/opencreator-publisher/services/miniapp.py)、[`database/mongo.py`](../../../../../opencreate/opencreator-publisher/database/mongo.py)、[`core/config.py`](../../../../../opencreate/opencreator-publisher/core/config.py)。

### 边界

- 它是 v1 独立任务接口，不使用 `POST /api/v2/flow/runs`。
- 查询靠 HTTP 分页/轮询，不是 v2 可恢复 WebSocket。
- 不应把 `miniapp_task` 状态与 `flow_task`、Agent run 状态混用。
- 路由已挂载不等于执行 worker 已启用；现状应归类为“接口占位/未完成链路”。

## 节点块

### 启用入口

- `POST /api/v1/node_blocks`
- `PATCH /api/v1/node_blocks`
- `DELETE /api/v1/node_blocks?id=...`
- `GET /api/v1/node_blocks/page`

前端积木面板读取分页列表，工具栏可把当前节点组合保存为块；Publisher 存入 `node_blocks`，并可按 `flow_id` 过滤。

源码：[`node_blocks.py`](../../../../../opencreate/opencreator-publisher/controller/v1/node_blocks.py)、[`node_blocks_service.py`](../../../../../opencreate/opencreator-publisher/services/node_blocks/node_blocks_service.py)、[`blocks-list.tsx`](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/template/blocks-list.tsx)、[`node-tool-bar.tsx`](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/components/panels/node-tool-bar.tsx)。

### 安全注意

- 列表与新增显式取得认证用户；更新、删除 controller 未显式接收用户，所有权校验必须由 service/DAO 兜住，审计时不能只看路由依赖。
- 节点块是编辑资产，不是执行状态；实例化进画布后仍需保存 project，再由 run 主链执行。

## AppFlow

### 启用入口

- `POST /api/v3/app-flow`
- `GET /api/v3/app-flow/{flow_id}`
- `PATCH /api/v3/app-flow/{flow_id}`

AppFlow 绑定现有 `flow_id`，保存 `title`、`description`、`demo_image_urls`、`visible_nodes` 等展示配置；更新时可用 `sync_workflow` 控制与 workflow 同步。集合是 `app_flow`。

前端打开画布时会并行尝试读取 AppFlow；不存在返回 `data=null`，不能把“没有 AppFlow”当成“workflow 不存在”。

源码：[`app_flow.py`](../../../../../opencreate/opencreator-publisher/controller/v3/app_flow.py)、[`services/app_flow.py`](../../../../../opencreate/opencreator-publisher/services/app_flow.py)、[`use-one-flow.ts`](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-one-flow.ts)、[`database/mongo.py`](../../../../../opencreate/opencreator-publisher/database/mongo.py)。

### 边界

- `flow`/`flow_details` 是工作流事实，`app_flow` 是 App 展示投影。
- `visible_nodes` 是可见范围，不是 DAG 调度白名单。
- AppFlow CRUD 同步结束，不进入 Redis `run_flow`；实际运行仍应走 workflow run 接口。

## 定制业务

### 启用入口

- `POST /api/v1/custom_workflow/checkout`
- `GET /api/v1/custom_workflow/orders`
- `GET /api/v1/custom_workflow/orders/{order_id}`

用户发起 Stripe checkout 后得到 URL 和订单 ID；订单写入 `custom_workflow_order`，后续按用户分页或查详情。

源码：[`custom_workflow.py`](../../../../../opencreate/opencreator-publisher/controller/v1/custom_workflow.py)、[`services/custom_workflow.py`](../../../../../opencreate/opencreator-publisher/services/custom_workflow.py)、[`payments.tsx`](../../../../../opencreate/opencreator-frontend/src/components/custom_workflow/payments.tsx)、[`database/mongo.py`](../../../../../opencreate/opencreator-publisher/database/mongo.py)。

### 边界

- checkout URL 返回不等于支付完成；支付事实仍以 Stripe webhook/订单状态为准。
- 定制订单不等于 `flow_task`，不能复用节点状态或 workflow 终态。
- schema 保留旧 `service_type` 转换，属于读写兼容，不代表旧产品路径仍是主入口。

## 四者如何与主链相遇

```text
节点块
  → 展开为画布 nodes / edges
  → 保存 flow

AppFlow
  → 为 flow 增加 App 展示配置

小程序
  → 当前仅有任务接口与未接通执行器

定制业务
  → 独立订单生命周期

真正 DAG 执行
  → POST /api/v2/flow/runs
  → Redis Stream
  → Consumer
  → RabbitMQ
  → Publisher Event Store
  → WebSocket
```

## 实现或迁移时检查

- 每种对象都用自己的 ID、集合、状态枚举和幂等规则。
- 所有用户资产在 service/DAO 层校验 owner，不能只依赖前端隐藏入口。
- HTTP 200/202 的结束语义分开：CRUD 完成、checkout 创建、任务受理、DAG 完成都不是一回事。
- 若要把小程序或 AppFlow 接入 v2 主链，应新增显式适配层，不要直接把其集合伪装成 `flow_task`。
