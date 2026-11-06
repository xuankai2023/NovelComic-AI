# OpenCreator 是怎么做工作流命令、DAG 与 HITL 的

## 一、先说结论

OpenCreator 的工作流执行分两条通道：

```text
命令通道：浏览器 → Publisher → Redis Stream → Consumer
事件通道：Consumer → outbox → RabbitMQ → Publisher Event Store → WebSocket → 浏览器
```

HITL 夹在 Consumer DAG 中间：某个节点有多候选结果时，节点进入 `select`，事件通道把选择态推回前端；用户选完以后，前端再走命令通道发 `continue`，Consumer 把 SELECT 节点切回 SUCCESS，然后继续跑后继。

一条完整 run 是：

```text
runAll()
  → command journal
  → POST /api/v2/flow/runs
  → flow_task + workflow_command
  → run_flow Redis Stream
  → Consumer inbox
  → init run / nodes
  → ready_nodes
  → model invocation
  → node aggregation
  → success / failed / select
  → outbox
  → RabbitMQ
  → Event Store
  → WebSocket replay
```

读代码时抓住一个边界：Publisher 第一次接 HTTP 时只承诺“命令收下了”，不承诺“结果生成了”。

---

## 二、前端：发命令，不判 DAG

前端运行域主要在这几份文件：

1. [workflow-command-journal.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-command-journal.ts)
2. [flow.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts)
3. [useWorkflowRunner.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts)
4. [useWebSocketFlow.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWebSocketFlow.ts)
5. [workflow-resumable-websocket.ts](../../../../../opencreate/opencreator-frontend/src/lib/workflow-resumable-websocket.ts)
6. [workflow-runtime-provider.tsx](../../../../../opencreate/opencreator-frontend/src/components/canvas/workflow-runtime-provider.tsx)

### 1. command journal 先定身份

用户点击 Run，`useWorkflowRunner` 不应该直接裸调接口。它先拿命令身份：

```text
getOrCreateWorkflowCommand(operationKey, request, "wf")
```

这一步让同一次点击在网络超时后仍然复用同一个 `command_id`。后端才能返回 replay，而不是开第二个 run。

`continue` 和 `cancel` 也一样要走 command journal。HITL 选择不是“普通保存”，它也是一道命令。

### 2. flow.ts 只封装传输

[flow.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts) 里运行函数分五类：

```text
postCreateWorkflowRun()
postContinueWorkflowRun()
postCancelWorkflowRun()
getWorkflowRun()
getActiveWorkflowRuns()
```

这些函数只负责 URL、body、JWT 和返回体。不要在 API 层判断节点是否 ready，也不要在 API 层把 `202` 当 success。

### 3. useWorkflowRunner 串命令和事件

[useWorkflowRunner.ts](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts) 做这些事：

```text
runAll()
  → 从画布 store 取 nodes / edges
  → 组装 flow_task
  → command journal 生成 command_id
  → postCreateWorkflowRun()
  → 保存 flow_task_id / flow_run_id
  → startWebSocketForFlow()
```

HITL 时：

```text
continueFromSelection()
  → 组装 user_selection
  → command journal 生成 continue command_id
  → postContinueWorkflowRun()
```

Stop 时：

```text
stopWorkflow()
  → command journal 生成 cancel command_id
  → postCancelWorkflowRun()
```

刷新恢复时：

```text
getActiveWorkflowRuns(flowId)
  → 找到 active flow_task_id
  → 读取 sessionStorage cursor
  → 重新 attach WebSocket
```

### 4. WebSocket 是事件读口

`useWebSocketFlow` 和 `workflow-resumable-websocket.ts` 负责：

```text
WS /api/v2/flow/runs/{flow_task_id}/events/{connection_id}
  → auth
  → attach_flow(last_event_cursor)
  → replay
  → live events
```

前端收到事件后再调用 handler：

- `node_status=running`：节点转圈。
- `node_status=success`：写结果、点亮。
- `node_status=select`：显示候选，等待选择。
- `finish_flow`：结束 run。
- `flow_killed`：停止 run。

事件里带 `event_id` 和 `event_cursor`。`event_id` 做副作用去重，`event_cursor` 做 replay 位置。

---

## 三、Publisher：收命令，写事实，派发

Publisher 相关文件：

1. [schemas/workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/schemas/workflow_runs_v2.py)
2. [controller/v2/flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)
3. [services/workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)
4. [services/flow.py](../../../../../opencreate/opencreator-publisher/services/flow.py)
5. [tasks/flow.py](../../../../../opencreate/opencreator-publisher/tasks/flow.py)
6. [controller/routers.py](../../../../../opencreate/opencreator-publisher/controller/routers.py)

### 1. schema 先锁字段

`CreateWorkflowRunRequest` 至少要固定：

| 字段 | 用途 |
| --- | --- |
| `client_request_id` | 前端操作身份 |
| `command_id` | 幂等命令身份 |
| `flow_id` | 所属画布项目 |
| `flow_task` | 本次执行的 nodes / edges |
| `start_ids` / `end_ids` | 子图范围 |

`ContinueWorkflowRunRequest` 固定用户选择，`CancelWorkflowRunRequest` 固定取消原因和命令身份。

响应体固定：

```text
flow_task_id
flow_run_id
trace_id
status
idempotent_replay
```

### 2. controller 不跑图

[flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py) 的 HTTP 入口：

```text
POST /runs
POST /runs/{flow_task_id}/continue
POST /runs/{flow_task_id}/cancel
GET /runs
GET /runs/{flow_task_id}
```

controller 的职责只有：

```text
parse request
  → get_authenticated_user
  → 调 WorkflowRunV2Service
  → 成功统一返回 202
```

它不读 Redis Stream，不调用模型，不决定节点后继。

### 3. create_run 写两行事实

[workflow_runs_v2.py](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py) 的 start 顺序：

```text
command_id = req.command_id or req.client_request_id
  → _resolve_command_replay()
  → _validated_graph()
  → 生成 flow_task_id / flow_run_id / trace_id
  → insert flow_task
  → insert workflow_command
  → dispatch_command()
```

`flow_task` 给前端查询和公开状态用。`workflow_command` 给幂等、派发、恢复用。两行一起写，避免“前端有 task 但 dispatcher 找不到 command”。

### 4. continue 和 cancel 也是命令

`continue_run()` 不是直接改 Consumer 节点。它先在 Publisher 做 CAS：

```text
flow_task.status 必须是 waiting_for_selection
  → insert workflow_command
  → flow_task.status = running
  → dispatch
```

`cancel_run()`：

```text
insert workflow_command
  → flow_task.status = cancel_requested
  → dispatch
```

真正 SELECT → SUCCESS、真正 kill 节点，都在 Consumer。

### 5. dispatch 发布到 Redis Stream

`dispatch_command()` claim 住 `workflow_command` 后调用：

```text
FlowService.enqueue_flow_task()
  → FlowTask.run_flow.publish()
```

Publisher 的 [tasks/flow.py](../../../../../opencreate/opencreator-publisher/tasks/flow.py) 是 producer。队列名是 `run_flow`，broker 是 Redis Stream。Consumer 仓同名 `tasks/flow.py` 才执行。

---

## 四、Consumer：跑 DAG，处理 HITL

Consumer 相关文件：

1. [tasks/flow.py](../../../../../opencreate/opencreator-consumer/tasks/flow.py)
2. [flow_command_inbox_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_command_inbox_service.py)
3. [flow_run_state_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_run_state_service.py)
4. [flow_node_state_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_node_state_service.py)
5. [flow_resume.py](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py)
6. [model_invocation_planner.py](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_planner.py)
7. [model_invocation_service.py](../../../../../opencreate/opencreator-consumer/services/invocation/model_invocation_service.py)
8. [node_aggregation_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/node_aggregation_service.py)
9. [flow_completion_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_completion_service.py)

### 1. run_flow 先 claim inbox

Consumer `FlowTask.run_flow()` 收到 Stream 消息：

```text
校验 protocol_version=2
  → command_id 必须存在
  → FlowCommandInboxService.claim_command()
```

claim 不到就返回。这样 Redis Stream 重投不会重复初始化 run，也不会重复 cancel。

### 2. start 初始化 durable run

start 命令执行：

```text
init_flow_run()
  → init_nodes()
  → seed_user_selection_outputs()
  → publish start_flow
  → FlowResumeTask.handle_resume(reason="start")
  → mark_start_initialized()
```

`start_initialized` 是恢复边界。命令 claim 到，不代表节点表已经铺完。

### 3. FlowResumeTask 找 ready 节点

`FlowResumeTask.handle_resume()`：

```text
拿 run lock
  → run 必须是 running
  → ready_nodes()
  → 按批处理节点
  → finish_if_all_terminal()
```

输入节点可以本地完成。模型节点走 invocation 计划和 provider submit。

### 4. 模型节点先计划再提交

模型节点处理顺序：

```text
加载已有 execution_plans
  → 没有则 ModelInvocationPlanner.plan_node()
  → 写 expected_result_ids / execution_plans
  → mark node running
  → publish node_status=running
  → ModelInvocationService submit
```

计划先落库，是为了 callback、恢复、重试都能认同一批 `result_id`。

### 5. callback 后聚合节点

provider 回调更新 invocation 后，进入：

[node_aggregation_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/node_aggregation_service.py)

聚合结果：

```text
waiting：还有结果没回来
failed：没有成功结果
select：多候选 + 有后继 + 不是 end_node
success：可以继续后继
```

`select` 时，Consumer run 仍是 running。Publisher 公开 `flow_task` 会被回程事件推到 `waiting_for_selection`。

### 6. continue 把选择写回节点

continue 命令在 Consumer 里执行：

```text
apply_user_selection_for_continue()
  → 按 node_id 重组 user_selection
  → selected_outputs 全量覆盖
  → SELECT 节点切 SUCCESS
  → FlowResumeTask.handle_resume(reason="continue")
```

这一步不能只写前端 store。选择结果必须落到 durable node，后继节点才能从前驱读到正确输出。

### 7. cancel 跑 kill tail

cancel 命令：

```text
request_cancel()
  → _stop_flow_for_kill()
  → stop nodes
  → publish flow_killed
```

WebSocket 断开不会触发这条链。

---

## 五、事件回程：先持久化，再推浏览器

事件回程文件：

1. [flow_event_publish_service.py](../../../../../opencreate/opencreator-consumer/services/workflow/flow_event_publish_service.py)
2. [opencreator-consumer/database/mq.py](../../../../../opencreate/opencreator-consumer/database/mq.py)
3. [opencreator-publisher/database/mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py)
4. [workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py)

### 1. Consumer outbox

Consumer 发事件时先生成稳定 `event_id`：

```text
FlowEventPublishService.stable_event_id(...)
  → flow_event_outbox claim
  → RabbitMQ v2 reply queue
```

事件至少包括：

- `start_flow`
- `node_status`
- `start_running_llm_models`
- `llm_model_ready`
- `llm_model_status`
- `finish_running_llm_models`
- `finish_flow`
- `flow_killed`
- `workflow_error`

### 2. Publisher 先写 Event Store 再 ACK

[database/mq.py](../../../../../opencreate/opencreator-publisher/database/mq.py) 的 `workflow_v2_mq_callback()`：

```text
decode event
  → 校验 protocol_version=2
  → 对齐 flow_task_id / event_id / command_id
  → WorkflowEventStore.append_event()
  → 更新 flow_task.status / last_event_cursor
  → message.ack()
  → 通知 WebSocket event loop
```

节点 `select` 事件在这里把公开状态推成 `waiting_for_selection`。`finish_flow` 在这里推成 terminal。

### 3. Event Store 是 replay 真相

[workflow_event_store.py](../../../../../opencreate/opencreator-publisher/services/workflow_event_store.py) 做：

```text
HSET event_id → cursor
XADD event stream
PUBLISH 唤醒
replay(after_cursor)
cursor_is_available()
```

Pub/Sub 只负责叫醒在线 socket。断线重连读的是 Stream，不是 Pub/Sub。

---

## 六、WebSocket 怎么接回事件

后端 WebSocket 仍在：

[controller/v2/flow_runs.py](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)

连接顺序：

```text
WS /runs/{flow_task_id}/events/{connection_id}
  → auth
  → JwtService.get_user_id_with_backoff()
  → get_run_summary(user_id, flow_task_id)
  → attach_flow(last_event_cursor)
  → cursor 可用则 replay
  → resume_ready
  → live event loop
```

cursor 不可用时：

```text
尝试 workflow snapshot
  → 成功：先发 flow_snapshot，再从 latest 接
  → 失败：resume_error / 4409
```

前端每次物理重连都换 `connection_id`，但保留 `last_event_cursor`。这就是“连接可换，位置不可乱”。

---

## 七、一条 HITL 选择怎么走

把 HITL 单独串一次：

```text
模型节点有多候选输出
  → NodeAggregationService 判定 select
  → FlowNodeStateService 把节点状态写 select
  → FlowEventPublishService 发 node_status=select
  → Publisher Event Store append
  → flow_task.status = waiting_for_selection
  → WebSocket 推给前端
  → 前端显示候选
  → 用户选择
  → postContinueWorkflowRun()
  → Publisher continue_run() CAS waiting_for_selection → running
  → Redis Stream continue command
  → Consumer apply_user_selection_for_continue()
  → SELECT → SUCCESS
  → FlowResumeTask 继续后继节点
```

验收时只看前端 UI 会误判。必须确认：

- Publisher 公开状态变过 `waiting_for_selection`。
- Consumer node state 有 `selected_outputs`。
- SELECT 节点被恢复为 SUCCESS。
- 后继节点不是前端硬触发，而是 resume 算出来的 ready node。

---

## 八、和 NovelComic 对照

NovelComic 搬这组时，不要做成“一个 `/run` 接口 + 一个 socket”。最小可交付也要覆盖：

1. 命令身份：`command_id` 可重试。
2. Publisher 命令事实：`flow_task + workflow_command` 同事务。
3. Redis Stream：入口和执行解耦。
4. Consumer inbox：副作用只承认一次。
5. durable DAG：run state、node state、ready nodes。
6. 模型调用计划：`execution_plans / expected_result_ids`。
7. HITL：`select → continue → selected_outputs → resume`。
8. 事件回程：outbox、RabbitMQ、Event Store、cursor。
9. 前端恢复：active run + cursor replay。

只做到 202，用户会看到“点了没反应”。只做到 WebSocket，刷新会丢事件。只做到 select UI，continue 后后继不会真正跑。
