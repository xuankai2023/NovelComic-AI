# 工作流命令、DAG 与 HITL question

## 核心概念

- 这一组从哪里开始讲？
  - 从用户点击 Run 之后开始。
  - 打开画布、读取项目、补历史结果已经在上一组解决。
  - 这里讲命令幂等、Publisher 入站、Consumer 跑图、选择续跑、事件回程。

- 为什么要先背三句话？
  - Publisher 收命令，不跑图。
  - Consumer 跑 DAG，不握 WebSocket。
  - Publisher 再收事件，不替 Consumer 判 DAG。
  - 把这三层压成一个 `run_status`，入口重试、节点选择、断线恢复会互相打架。

- 这条链最短怎么走？
  - command journal 给这次操作一个稳定 `command_id`。
  - Publisher 校验 DAG，同事务写 `flow_task + workflow_command`。
  - dispatch 到 Redis Stream `run_flow`。
  - Consumer inbox claim，初始化 run / nodes。
  - `FlowResumeTask` 找 ready 节点。
  - 模型节点先写计划再提交 AI。
  - callback 聚合成 success / failed / select。
  - 事件经 outbox、RabbitMQ、Event Store 回到前端。

- `202`、`running`、`select`、`success` 为什么不能当成一件事？
  - `202` 发生在 Publisher 入口。
  - `running` 发生在 Consumer 开始处理节点。
  - `select` 发生在多候选结果等待用户选择。
  - `success` 发生在节点聚合完成、可以推进后继。

## 三层事实

- Publisher 命令事实负责什么？
  - 负责 `flow_task`、`workflow_command`、幂等和公开状态。
  - 它不是 DAG 执行真相。

- Consumer 执行事实负责什么？
  - 负责 durable run、durable node、ready 节点和模型调用。
  - 它不是浏览器连接表。

- Publisher 事件事实负责什么？
  - 负责 `event_id` 去重、cursor 和 replay。
  - 它不重新计算节点状态。

- 为什么 NovelComic 不能只写一个 `run_status`？
  - 入口重试要看命令是否同一道。
  - 节点选择要看 durable node 的 `select`。
  - 断线恢复要看 Event Store cursor。
  - 一个字段会被三层同时抢。

## command_id

- 前端为什么不每次点击都直接生成新 run？
  - 超时、网络失败或 5xx 时会重试。
  - 如果每次换 id，就会创建多个 run。
  - command journal 先在 `sessionStorage` 找 pending command。

- `getOrCreateWorkflowCommand()` 做什么？
  - 同一 `operationKey` 未完成时，复用第一次的 `command_id` 和 payload。
  - `202` 后 complete。
  - 确定性 `400 / 401 / 403 / 404 / 409 / 422` 才 abandon。

- 相同 `command_id` 到 Publisher 后怎么处理？
  - payload hash 相同：回放原来的 `flow_task_id`，`idempotent_replay=true`。
  - payload hash 不同：返回 `409`。

- `command_id` 和 `wire_command_id` 有什么区别？
  - 前端认 `command_id`，防止用户重复提交。
  - Consumer inbox 认 `wire_command_id`，防止执行仓重复承认副作用。
  - 前者防入口重复，后者防执行重复。

- continue 和 cancel 要不要走 command journal？
  - 要。
  - HITL 选择不是普通保存，它也是一道命令。
  - Stop 也是一道命令，不是关 socket。

## 202 与入口校验

- `POST /api/v2/flow/runs` 的顺序是什么？
  - parse `CreateWorkflowRunRequest`。
  - `get_authenticated_user`。
  - `WorkflowRunV2Service.create_run()`。
  - `_accepted_response()` 返回 `202`。

- `create_run()` 关键做什么？
  - 校验 command replay。
  - 校验 nodes / edges 是 DAG。
  - 生成 `flow_task_id` / `flow_run_id` / `trace_id`。
  - 同事务 insert `flow_task + workflow_command`。
  - `dispatch_command()`。

- 为什么入口要拒绝环？
  - Publisher 会用 `create_graph()` 和 `nx.is_directed_acyclic_graph()` 校验。
  - 有环的图不能进入执行系统。
  - 但入口不决定每个节点何时执行。

- 为什么 `202` 后页面不能直接标 success？
  - 它只说明入口交差。
  - 前端只能拿着 `flow_task_id` 去挂事件流。

## DAG 与 ready_nodes

- DAG 校验和 DAG 推进分别在哪？
  - 校验在 Publisher 入口。
  - 推进在 Consumer 的 `FlowResumeTask`。

- 每个 `flow_node_state` 至少要有什么？
  - `predecessors`、`successors`。
  - `predecessor_edges`、`successor_edges`。
  - `is_active`、`status`。
  - `selected_outputs`、`expected_result_ids`、`execution_plans`。

- `start_ids / end_ids` 是什么意思？
  - 它们只限定本次执行子图。
  - 完整前后继仍要保存。
  - 否则子图运行时，下游拿不到非 active 前驱的选择结果。

- ready 节点的含义是什么？
  - 节点本身还没终态。
  - 节点属于本次 active 子图。
  - active 前驱已完成。
  - 非 active 前驱的产物已经通过 `user_selection` 注入。

- 为什么 HITL、单节点重跑、选中子图不能只靠前端过滤 nodes？
  - 前端过滤只决定这次提交哪些节点。
  - 真正谁能跑，要由 Consumer 按 durable 前后继计算 ready。
  - 否则 continue 后后继不会真正推进。

## 模型计划与聚合

- 模型节点为什么先写计划再提交 provider？
  - `ModelInvocationPlanner.plan_node()` 会生成稳定 `result_id`、`invocation_id`、`execution_plans`、`expected_result_ids`。
  - 这些先写回 node state，再提交 opencreator-ai。
  - 进程死在提交前、提交后、回调前，都能按同一批 `result_id` 恢复。

- 如果 NovelComic 直接“调用模型后再补记录”会怎样？
  - 超时重试会产生第二批结果身份。
  - callback 回来时找不到应该聚合到哪个节点计划。

- callback 等于节点完成吗？
  - 不等于。
  - 还要经过 `NodeAggregationService`。
  - 还有 result 没回来就是 waiting。
  - 全部失败才是 failed。
  - 成功结果超过一个、节点还有后继、并且不是本次 end_node，才是 select。
  - 否则才是 success。

## 工作流 HITL

- 工作流 HITL 是什么？
  - 节点有多候选结果时进入 `select`。
  - `flow_task.status` 变成 `waiting_for_selection`。
  - 用户选择后走 `POST /runs/{flow_task_id}/continue`。
  - `selected_outputs` 全量覆盖，SELECT 切 SUCCESS，再 resume 后继。

- 它和 Agent HITL 有什么区别？
  - 工作流 HITL 是 node select，走 `continue_run()`。
  - Agent HITL 是工具 interrupt，走 session metadata 的 `pending_hitl`。
  - 两者都等人，但不是一张表，也不是同一个 resume 入口。

- continue 为什么也要幂等？
  - 用户可能重复点确认。
  - Publisher 只允许公开状态为 `waiting_for_selection` 的 run 被 continue。
  - 它先写 `workflow_command`，再 CAS `waiting_for_selection → running`，再 dispatch。

- 为什么选择必须“覆盖”而不是 append？
  - 用户改选后，下游必须看到最新选择。
  - append 会让后继读到旧候选和新候选混在一起。

- Consumer 收到 continue 后做什么？
  - `apply_user_selection_for_continue()`。
  - 按 `node_id` 重组 `user_selection`。
  - 全量覆盖 `selected_outputs`。
  - 当前 SELECT 节点切 SUCCESS。
  - `handle_resume(reason="continue")`。

- `select` 时 Consumer run 是不是已经结束？
  - 不是。
  - Consumer durable run 仍是 `running`。
  - SELECT 不是整图终态。
  - 只是 Publisher 公开状态被回程事件推成 `waiting_for_selection`。

## cancel

- Stop 走哪条接口？
  - `POST /api/v2/flow/runs/{flow_task_id}/cancel`。

- 断开 WebSocket、刷新页面、关闭 tab 会不会停止执行？
  - 不会。
  - Consumer run 仍然可能继续跑。
  - 直到 cancel command 被 Consumer claim 并执行 kill tail。

- 前端要把哪两件事分开？
  - WebSocket 断了：重连并 replay。
  - 用户点 Stop：发 cancel 命令。

## 事件回程与四把 ID

- 事件回程最短链路是什么？
  - `FlowEventPublishService.publish()`。
  - `flow_event_outbox`。
  - RabbitMQ v2 reply queue。
  - Publisher `workflow_v2_mq_callback()`。
  - `WorkflowEventStore.append_event()`。
  - ACK Rabbit。
  - WebSocket event loop replay。

- 为什么 ACK 必须在 `append_event()` 成功之后？
  - ACK 后消息就被认为处理完成。
  - 还没写入 Event Store 就 ACK，断线后可能永远补不到。

- 四把 ID 分别干什么？
  - `command_id`：同一道 start / continue / cancel。
  - `wire_command_id`：Consumer inbox 副作用身份。
  - `event_id`：同一条事件去重。
  - `event_cursor`：replay 位置。
  - `connection_id`：当前物理连接世代。

- 常见错法有哪些？
  - 用 `event_id` 当 cursor。
  - 重连时换 cursor。
  - 超时重试时换 `command_id`。
  - 用 WebSocket 是否在线判断 run 是否还在跑。

## NovelComic 迁移

- 最小可交付要覆盖什么？
  - `command_id` 可重试。
  - `flow_task + workflow_command` 同事务。
  - Redis Stream 把入口和执行解耦。
  - Consumer inbox 副作用只承认一次。
  - durable DAG：run state、node state、ready nodes。
  - 模型调用计划：`execution_plans / expected_result_ids`。
  - HITL：`select → continue → selected_outputs → resume`。
  - 事件回程：outbox、RabbitMQ、Event Store、cursor。
  - 前端恢复：active run + cursor replay。

- 只做到 202 会怎样？
  - 用户会看到“点了没反应”。

- 只做到 WebSocket 会怎样？
  - 刷新会丢事件。

- 只做到 select UI 会怎样？
  - continue 后后继不会真正跑。

## 面试短答

- 一句话讲工作流命令、DAG 与 HITL？
  - Publisher 只收 start / continue / cancel 并做命令幂等，Consumer 按 durable DAG 计算 ready 节点并聚合模型结果；多候选时节点进入 select，用户选择后再发 continue，事件经 Event Store 回到浏览器。

- 一句话讲为什么 Publisher 不跑图？
  - 入口只保证命令可恢复、图是 DAG、公开状态可查询；每个节点何时执行必须由 Consumer 根据 durable 前后继和选择结果计算。

- 一句话讲工作流 HITL？
  - 它是节点多候选等待用户选择，不是 Agent 工具 interrupt；选择必须覆盖写回 durable node，再 resume 后继。

- 一句话讲四把 ID？
  - `command_id` 管同一道用户命令，`wire_command_id` 管执行仓认领，`event_id` 管事件去重，`event_cursor` 管从哪条继续读。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 前端 command journal 和 create / continue / cancel API 已经存在。
  - Publisher `create_run()` 能写命令事实并 dispatch `run_flow`。
  - Consumer 能 claim start、初始化 run / nodes，并用 `FlowResumeTask` 推进基础输入节点。
  - 模型节点能先写 expected result，再提交 AI task。

- 当前实现能不能算本章主链路打通？
  - start 主骨架可以算打通。
  - HITL、continue、真正 cancel 还没有按 OpenCreator 三层事实做完。

- 当前测试覆盖了哪些本章风险？
  - 覆盖了创建 run 的命令入口和 inbox claim。
  - 覆盖了 start 初始化。
  - 还没有完整覆盖 select → continue → resume 后继。
  - 还没有完整覆盖 cancel command 被 Consumer kill tail。

- 为什么说当前还不是完整 DAG / HITL？
  - Consumer 明确只实现 start，continue / cancel 会直接拒绝。
  - Publisher continue / cancel 主要改本地 run 状态和写事件，没有完整 CAS + dispatch。
  - 没有独立的 `NodeAggregationService`，也没有完整 `select` 判定。
  - 模型 callback 后如何把节点收成 success / failed / select，还需要继续补。

- 当前安全边界是什么？
  - start / continue / cancel / 查询都要带业务 JWT。
  - Publisher 按当前 `user_id` 读取 run。
  - 命令幂等按用户 + `command_id` 判断，不能只信前端传来的状态。

- 如果节点停在 running，当前应该怎么排查？
  - 先确认是输入节点还是模型节点。
  - 输入节点看 Consumer 是否写出 outputs 并发布 `node_status=success`。
  - 模型节点看是否已经 submit AI，以及 callback / 聚合有没有回来。
  - 不要把 `202` 或 WebSocket 已连接当成节点完成。

- 什么时候才算本章完整验收？
  - Run 后能看到 running 事件和节点结果。
  - 多候选节点能进入 select，公开状态变成 `waiting_for_selection`。
  - continue 后 `selected_outputs` 覆盖写回，后继由 resume 算出来。
  - cancel 能真正停止 Consumer run。
  - 刷新可按 cursor 补事件。
