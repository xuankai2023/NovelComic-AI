# 工作流命令、DAG 与 HITL：这里面有哪些技术点

这一组只讲点击 Run 之后的执行链。打开画布、读取项目、补历史结果，已经在上一组解决；这里从 `POST /api/v2/flow/runs` 开始，到节点亮灯、选择续跑、最终事件回到浏览器为止。

先背一句话：

```text
Publisher 收命令，不跑图；
Consumer 跑 DAG，不握 WebSocket；
Publisher 再收事件，不替 Consumer 判 DAG。
```

最短链路：

```text
Run 按钮
  → command journal 给这次操作一个稳定 command_id
  → Publisher v2 /runs 校验 DAG
  → 同事务写 flow_task + workflow_command
  → dispatch 到 Redis Stream run_flow
  → Consumer inbox claim
  → init flow_run_state / flow_node_state
  → FlowResumeTask 找 ready_nodes
  → 模型节点提交 opencreator-ai
  → callback 聚合 invocation
  → node success / failed / select
  → Consumer outbox
  → RabbitMQ v2 reply
  → Publisher Event Store
  → WebSocket replay 给前端
```

`202`、`running`、`select`、`success` 分别发生在不同层。不要把它们压成一个“后端开始跑了”。

---

## 1. 这条链有三层事实

OpenCreator 把一次运行拆成三层事实。

| 层 | 文件证据 | 这层负责 | 不是 |
| --- | --- | --- | --- |
| Publisher 命令事实 | [services/workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py) | `flow_task`、`workflow_command`、幂等、公开状态 | 不是 DAG 执行真相 |
| Consumer 执行事实 | [tasks/flow.py](../../../../../opencreate/opencreator-consumer/tasks/flow.py)、[flow_resume.py](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py) | durable run、durable node、ready 节点、模型调用 | 不是浏览器连接表 |
| Publisher 事件事实 | [workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py) | `event_id` 去重、cursor、replay | 不是重新计算节点状态 |

写 NovelComic 时要先把这三层分开。只写一个 `run_status` 字段会很快混乱：入口重试、节点选择、断线恢复、结果重投都会抢同一个状态。

---

## 2. command_id 解决“是不是同一道命令”

前端不是每次点击都直接生成新 run。OpenCreator 先经过：

[workflow-command-journal.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-command-journal.ts)

```text
getOrCreateWorkflowCommand()
  → sessionStorage 里找 pending command
  → payload 未变则复用 command_id
  → 202 后 complete
  → 确定性 4xx 后 abandon
```

这把 `command_id` 在 Publisher 落到 `workflow_command`。相同用户、相同 `command_id`：

- payload hash 相同：回放原来的 `flow_task_id`。
- payload hash 不同：`409`。

Publisher 入队时还会生成 `wire_command_id`。前端认 `command_id`，Consumer inbox 认 `wire_command_id`。这不是多此一举：前者防用户重复提交，后者防执行仓重复承认副作用。

---

## 3. 202 只说明入口交差

`POST /api/v2/flow/runs` 进：

[controller/v2/flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)

顺序是：

```text
parse CreateWorkflowRunRequest
  → get_authenticated_user
  → WorkflowRunV2Service.create_run()
  → _accepted_response()
```

`create_run()` 的关键不是“开始跑模型”，而是把请求变成可恢复命令：

```text
校验 command replay
  → 校验 nodes / edges 是 DAG
  → 生成 flow_task_id / flow_run_id / trace_id
  → 同事务 insert flow_task + workflow_command
  → dispatch_command()
```

所以 `202` 后页面不能直接标 success。它只能拿着 `flow_task_id` 去挂事件流。

---

## 4. DAG 校验发生在入口，DAG 推进发生在 Consumer

Publisher 入口会拒绝环：

```text
FlowService.filter_non_executable_nodes_with_edges()
  → create_graph()
  → nx.is_directed_acyclic_graph()
```

但入口不决定每个节点何时执行。Consumer 初始化节点时保存完整图关系：

[flow_node_state_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_node_state_service.py)

每个 `flow_node_state` 至少要有：

- `predecessors`
- `successors`
- `predecessor_edges`
- `successor_edges`
- `is_active`
- `status`
- `selected_outputs`
- `expected_result_ids`
- `execution_plans`

`start_ids / end_ids` 只限定本次执行子图。完整前后继仍要保存，否则子图运行时下游拿不到非 active 前驱的选择结果。

---

## 5. ready_nodes 是 DAG 的推进点

真正推进在：

[flow_resume.py](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py)

核心循环：

```text
handle_resume(run_id)
  → 拿 run lock
  → flow_run_state 必须是 running
  → FlowNodeStateService.ready_nodes(run_id)
  → 处理 ready 节点
  → finish_if_all_terminal()
```

ready 的含义不是“所有前驱都存在”，而是：

- 节点本身还没终态。
- 节点属于本次 active 子图。
- active 前驱已完成。
- 非 active 前驱的产物已经通过 `user_selection` 注入。

这就是为什么 HITL、单节点重跑、选中子图运行不能只靠前端过滤 nodes。

---

## 6. 模型节点先写计划，再提交 provider

模型节点执行前先生成稳定计划：

```text
ModelInvocationPlanner.plan_node()
  → result_id
  → invocation_id
  → execution_plans
  → expected_result_ids
```

这些会写回 node state，再提交 opencreator-ai。这样进程死在提交前、提交后、回调前，都能按同一批 `result_id` 恢复。

如果 NovelComic 直接“调用模型后再补记录”，会有两个问题：

- 超时重试会产生第二批结果身份。
- callback 回来时找不到应该聚合到哪个节点计划。

---

## 7. callback 不等于节点完成

模型 callback 更新 invocation 后，要经过：

[node_aggregation_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/node_aggregation_service.py)

聚合判断：

```text
还有 result 没回来
  → waiting

全部失败
  → failed

成功结果超过一个，并且节点还有后继，并且不是本次 end_node
  → select

否则
  → success
```

`select` 是本组文档的 HITL。它不是异常，也不是整图完成。

---

## 8. 工作流 HITL 是 node select，不是 Agent HITL

工作流 HITL：

```text
node status = select
flow_task.status = waiting_for_selection
用户选择输出
POST /runs/{flow_task_id}/continue
selected_outputs 覆盖
SELECT → SUCCESS
resume 后继节点
```

Agent HITL：

```text
工具调用 interrupt
用户补回复
替换 tool result
Agent loop 继续
```

两者都“等人”，但不是一张表，也不是同一个 resume 入口。NovelComic 搬工作流选择时，要走 `continue_run()` 和 `apply_user_selection_for_continue()`，不要套 Agent 卡片状态。

---

## 9. continue 是命令，也要幂等

Publisher 只允许公开状态为 `waiting_for_selection` 的 run 被 continue：

[services/workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)

```text
continue_run()
  → 写 workflow_command
  → CAS flow_task waiting_for_selection → running
  → dispatch
```

Consumer 收到 continue：

```text
apply_user_selection_for_continue()
  → 按 node_id 重组 user_selection
  → 全量覆盖 selected_outputs
  → 当前 SELECT 节点切 SUCCESS
  → handle_resume(reason="continue")
```

这一步的关键是“覆盖”。用户改选后，下游必须看到最新选择，不是把新的选择 append 到旧选择后面。

---

## 10. cancel 是命令，不是断开连接

Stop 走：

```text
POST /api/v2/flow/runs/{flow_task_id}/cancel
```

断开 WebSocket、刷新页面、关闭 tab 都不代表停止执行。Consumer run 仍然可能继续跑，直到 cancel command 被 Consumer claim 并执行 kill tail。

所以前端要把“连接状态”和“运行状态”分开：

- WebSocket 断了：重连并 replay。
- 用户点 Stop：发 cancel 命令。

---

## 11. 事件回程先落事实，再推连接

Consumer 不直接推浏览器。事件链路是：

```text
FlowEventPublishService.publish()
  → flow_event_outbox
  → RabbitMQ v2 reply queue
  → Publisher workflow_v2_mq_callback()
  → WorkflowEventStore.append_event()
  → ACK Rabbit
  → WebSocket event loop replay
```

证据：

- [flow_event_publish_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)
- [database/mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py)
- [workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)

ACK 必须在 `append_event()` 成功之后。WebSocket 当前不在线，也不能丢事件。

---

## 12. 四把 ID 不要互换

| ID | 位置 | 用途 |
| --- | --- | --- |
| `command_id` | 前端 journal / Publisher `workflow_command` | 同一道 start / continue / cancel |
| `wire_command_id` | Publisher 派发给 Consumer | Consumer inbox 副作用身份 |
| `event_id` | Consumer outbox / Publisher Event Store | 同一条事件去重 |
| `event_cursor` | Publisher Redis Stream | replay 位置 |
| `connection_id` | WebSocket URL | 当前物理连接世代 |

常见错法：

- 用 `event_id` 当 cursor。
- 重连时换 cursor。
- 超时重试时换 `command_id`。
- 用 WebSocket 是否在线判断 run 是否还在跑。

---

## 动手前要有的东西

这组要接在“从登录到画布亮灯”之前的基础上：

1. `/canvas/{flowId}` 能读出自己的 nodes / edges。
2. 前端能拿 `__opencreator_jwt`。
3. Publisher 能验 JWT 并拿到 `user_id`。
4. Redis Stream、RabbitMQ、Mongo、Redis Event Store 都可用。
5. opencreator-ai 的 `/v1/tasks` 和 callback 通路可用。

做完这组后，验收目标不是“接口返回 202”，而是：

```text
Run → running 事件 → 模型结果 → node success / select
  → select 后 continue → 后继继续
  → finish_flow
  → 刷新可按 cursor 补事件
```
