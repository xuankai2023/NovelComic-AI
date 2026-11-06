# 从登录到画布亮灯 question

## 核心概念

- “从登录到画布亮灯”讲的是什么？
  - 讲的是用户登录后，打开画布、点击 Run、后端执行 DAG、事件回到浏览器、前端节点变色的完整链路。
  - 它不是单一接口，也不是登录成功后自动跑模型。

- 这条链可以拆成哪几个阶段？
  - Clerk session 建立身份。
  - 前端读取 flow project 并渲染 nodes / edges。
  - 用户点击 Run，Publisher 接收执行命令并返回 `202 Accepted`。
  - Dispatcher 把命令投递到 Redis Stream。
  - Consumer 认领命令并推进 DAG。
  - 模型节点需要时调用 opencreator-ai。
  - Consumer 把事件写 outbox，Publisher 写 Event Store。
  - WebSocket replay / live 推给前端，handler 更新节点状态。

- 为什么“有 session”“有 nodes / edges”“有 `flow_task_id`”“节点亮灯”不能混在一起？
  - 有 session 只表示用户已登录。
  - 有 nodes / edges 只表示画布项目已加载。
  - 有 `flow_task_id` 只表示运行命令已被受理。
  - 节点亮灯必须等 workflow event 回到前端并被 handler 成功消费。

## 登录与项目加载

- 登录阶段做了什么？
  - Clerk 建立浏览器 session。
  - 前端后续请求可通过 `getToken({ template: "__opencreator_jwt" })` 获取业务 JWT。
  - Publisher 验 JWT 后从 `sub` 得到当前用户。
  - 登录阶段不读取项目、不创建 run、不连接本次 run 的 WebSocket。

- 打开 `/canvas/{flowId}` 做了什么？
  - 先过 `RequireAuth`。
  - 登录后请求 `GET /api/v2/flow/project/{flowId}`。
  - 后端按 `flow_id + user_id` 读取项目。
  - 前端把 nodes / edges 写入画布 store。

- 为什么打开画布不是开始执行？
  - 打开画布读取的是项目定义。
  - 历史结果补拉只是读取已有 node result。
  - 真正执行必须等用户点击 Run 并创建 workflow run。

- `all_batch_fetch` 在这条链里是什么角色？
  - 它读取历史节点结果。
  - 它不会触发模型，也不表示节点正在运行。
  - 返回空数组通常只是没有历史结果。

## Run 命令

- 点击 Run 后调用哪个接口？
  - 调用 `POST /api/v2/flow/runs`。
  - 请求里包含 `client_request_id`、`flow_id`、`flow_task`、`start_ids`、`end_ids` 等。
  - 成功返回 `202 Accepted`。

- `202 Accepted` 表示什么？
  - 表示 Publisher 已经受理命令。
  - 它不表示 DAG 已经跑完。
  - 它不表示节点已经生成结果。
  - 前端拿到 `flow_task_id` 后还要订阅事件。

- 为什么需要 command journal？
  - 网络超时或 5xx 重试时，前端要复用同一个 `client_request_id` / `command_id`。
  - 服务端才能识别同一道命令并做幂等 replay。
  - 否则一次点击可能创建多个 run。

- `flow_task_id`、`flow_run_id`、`trace_id` 分别是什么？
  - `flow_task_id` 是本次逻辑执行实例，WebSocket 按它订阅。
  - `flow_run_id` 是本轮 run 的状态记录。
  - `trace_id` 用于贯穿 Publisher、Consumer、AI 的链路追踪。

## Publisher 与 Dispatcher

- Publisher 收到 Run 命令后会直接跑 DAG 吗？
  - 不会。
  - Publisher 负责验用户、校验命令、写 `flow_task` 和 `workflow_command`。
  - 真正 DAG 执行在 Consumer。

- Dispatcher 做什么？
  - 扫描可派发的 workflow command。
  - 调用 `FlowService.enqueue_flow_task()`。
  - 把命令发布到 Redis Stream `run_flow`。

- 为什么要用 Redis Stream 解耦？
  - HTTP 入口只负责受理命令。
  - 执行可以异步、可重试、可恢复。
  - Consumer 可以独立扩缩容和认领命令。

## Consumer 与 AI

- Consumer 收到 `run_flow` 后先做什么？
  - 先用 `FlowCommandInboxService.claim_command()` 认领命令。
  - 认领失败说明命令已被处理，当前消息直接返回。
  - 认领成功才初始化 run 和节点。

- Consumer 如何开始跑 DAG？
  - 初始化 `flow_run_state`。
  - 初始化 `flow_node_state`。
  - 发布 `start_flow` 事件。
  - 调用 `FlowResumeTask.handle_resume()` 找 ready 节点。

- 模型节点什么时候进入 AI？
  - 只有 DAG 中需要模型的节点才会提交 opencreator-ai。
  - 登录、打开画布、创建 run 都不会直接调用模型。
  - AI 返回或回调后，Consumer 再把结果转成 workflow event。

- 为什么不能把模型调用直接写在 Publisher run 接口里？
  - Publisher 是命令入口和事件回程入口，不是执行器。
  - 模型调用需要 DAG 状态、节点状态、恢复、重试和回调聚合。
  - 这些事实应由 Consumer 管理。

## 事件回程

- Consumer 如何把执行结果发回浏览器？
  - 先生成稳定 `event_id`。
  - 写 Mongo outbox。
  - 发布到 RabbitMQ v2 reply queue。
  - Publisher 消费后写入 Workflow Event Store。
  - WebSocket 从 Event Store replay / live 读取。

- 为什么 Publisher 要先写 Event Store 再 ACK RabbitMQ？
  - ACK 后消息就被认为处理完成。
  - 如果还没写入 Event Store 就 ACK，浏览器断线时可能永远补不到事件。
  - 先落地再 ACK 才能保证可恢复。

- WebSocket 当前不在线会不会丢事件？
  - 不应该丢。
  - 事件事实已经在 Event Store。
  - 浏览器重连后按 cursor 补读。

## 前端亮灯

- WebSocket 收到事件后，谁让节点变色？
  - `useWebSocketFlow` 按事件类型分发。
  - `useWorkflowRunner`、`useNodeStatusManager` 和 `workflow-runtime-provider` 把事件写入画布状态。
  - 真正改变 `node.data.status` 的是前端 handler。

- 哪些事件会影响节点状态？
  - `start_flow` 表示运行开始。
  - `node_status=running` 表示节点运行中。
  - `llm_model_ready` 可写入模型占位结果。
  - `node_status=success` 表示节点成功并可点亮。
  - `node_status=select` 表示进入 HITL 选择。
  - `workflow_error`、`flow_killed` 表示失败或停止。

- 为什么只拿到 `202` 不能让节点直接 success？
  - `202` 只是入口命令事实。
  - 节点是否成功是 Consumer 执行事实。
  - 浏览器必须等事件回程事实。

## 刷新与恢复

- 刷新页面会停止 run 吗？
  - 不会。
  - 刷新只断开浏览器的物理 WebSocket。
  - 后端 run 可能继续执行。

- 刷新后怎么恢复亮灯状态？
  - 重新读取 flow project。
  - 查询 active runs。
  - 读取本地保存的 event cursor。
  - 重新 attach WebSocket。
  - Event Store replay 断线期间事件。

- 关闭 WebSocket 等于 cancel 吗？
  - 不等于。
  - WebSocket 是事件订阅通道。
  - 停止执行必须调用 `POST /api/v2/flow/runs/{flow_task_id}/cancel`。

## NovelComic 迁移

- NovelComic 当前如果只有 run 接口返回 `202`，还缺什么？
  - command journal 和服务端命令幂等。
  - Publisher `workflow_command` 和 dispatcher。
  - Consumer inbox、durable run、durable node 和 DAG resume。
  - AI provider 提交和 callback 聚合。
  - Consumer outbox、RabbitMQ reply、Publisher Event Store。
  - 可恢复 WebSocket 和前端 handler。

- 为什么不能并行保留两套 run 协议？
  - 前端会不知道哪个状态是真实运行态。
  - 事件恢复、取消、HITL 和结果写入会分裂。
  - 迁移应就地升级到 OpenCreator 的命令、事件和恢复协议。

## 面试短答

- 一句话讲从登录到画布亮灯？
  - 用户登录后前端带业务 JWT 读取 flow project，点击 Run 后 Publisher 只受理命令并返回 `202`，Consumer 通过 Redis Stream 认领命令、推进 DAG、调用 AI，并把事件经 RabbitMQ 写入 Publisher Event Store，最后 WebSocket 按 cursor 推回前端，由 handler 更新节点状态。

- 一句话讲为什么 `202` 不等于亮灯？
  - `202` 只表示命令被 Publisher 接收，节点亮灯必须等 Consumer 执行事件写入 Event Store 并被前端 handler 成功处理。

- 一句话讲为什么浏览器断线不丢事件？
  - Consumer 事件先落 Publisher Event Store，WebSocket 只是可恢复读口，重连时用 cursor replay 缺失事件。

- 一句话讲 NovelComic 迁移重点？
  - 不要只做 HTTP 返回和 socket 连接，要补齐命令幂等、执行队列、Consumer DAG、事件存储、cursor 恢复和前端状态 handler。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 登录后能读取自己的 flow project，并把 nodes / edges 写入画布 store。
  - 前端已有 `workflow-command-journal.ts`，Run 会生成稳定 `command_id`。
  - `POST /api/v2/flow/runs` 能返回 `202`、`flow_task_id`、`flow_run_id`、`trace_id`。
  - Publisher 已有 `workflow_command`、dispatcher 和 Redis Stream `run_flow`。
  - Consumer 能 claim start 命令、初始化 run / nodes，并推进基础输入节点。
  - 模型节点能提交 AI task，事件能经 outbox / RabbitMQ 进入 Event Store。
  - 前端已有 v2 WebSocket：auth、attach、按 cursor 存本地。

- 当前实现能不能算本章主链路打通？
  - 可以算主骨架打通。
  - 因为命令入口、执行队列、基础 DAG 推进、事件回程和前端 handler 都已经存在。
  - 这不等于完整 OpenCreator 亮灯：HITL、cancel 真正杀尾、模型 callback 聚合和刷新恢复细节还要继续补。

- 当前测试覆盖了哪些本章风险？
  - 覆盖了前端 flow API 带 JWT 创建、继续、取消和查询 active run。
  - 覆盖了 command journal 复用同一命令身份。
  - 覆盖了 Publisher 创建 run 返回 `202`。
  - 覆盖了 Consumer inbox claim 和 start 初始化。
  - 还没有完整覆盖“刷新后 cursor replay 让节点重新亮灯”的端到端验收。

- 为什么说当前还不是完整画布亮灯？
  - Consumer 目前只实现 start，不处理 continue / cancel 命令。
  - 模型节点提交后，callback 聚合和后继推进还不完整。
  - `continue` / `cancel` 接口更多是写本地 run 状态和事件，没有完整 dispatch 到 Consumer。
  - WebSocket 已有协议骨架，但心跳、generation、cursor 过期和 snapshot 恢复还需要继续对齐。

- 当前安全边界是什么？
  - 创建 run、查询 run、WebSocket 首帧 auth 都要带业务 JWT。
  - Publisher 按 `user_id + flow_task_id` 查 run 归属。
  - JWT 合法但 run 不属于当前用户时，不能订阅事件。

- 如果点击 Run 后节点不亮，当前应该怎么排查？
  - 先看 `POST /api/v2/flow/runs` 是否返回 `202` 和 `flow_task_id`。
  - 再看 dispatcher 是否把 command 发到 `run_flow`。
  - 再看 Consumer 是否 claim 成功并发布 `start_flow` / `node_status`。
  - 再看 Publisher 是否先写 Event Store 再 ACK。
  - 最后看前端是否收到事件，并且 handler 成功后才推进 cursor。

- 什么时候才算本章完整验收？
  - 登录后能打开自己的画布。
  - 点击 Run 返回 `202`，前端进入 active run。
  - 输入节点能变成 `running` / `success`。
  - 模型节点能提交 AI 并最终回事件。
  - 刷新后能查到 active run，并用 cursor 补事件。
  - 关闭 WebSocket 不会自动取消任务。
