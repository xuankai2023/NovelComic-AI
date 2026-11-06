# 工作流命令、DAG 与 HITL

## 职责

- Publisher 接收 `start / continue / cancel` 命令，校验 DAG，持久化幂等命令并派发到 Redis Stream。
- Consumer 持久化 run、节点和调用状态，计算 ready 节点，提交模型调用并推进 DAG。
- 工作流 HITL 是“多候选结果等待用户选择”：节点进入 `select`，前端提交选择后发 `continue`。
- **现网**：画布主链使用 v2 REST 命令；事件回程仍走 RabbitMQ、Publisher Event Store 和 WebSocket。

## 入口

- Publisher v2 API：[`flow_runs.py`](../../../../../opencreate/opencreator-publisher/controller/v2/flow_runs.py)
- Publisher 命令服务：[`workflow_runs_v2.py`](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)
- Consumer 命令入口：[`flow.py`](../../../../../opencreate/opencreator-consumer/tasks/flow.py)
- DAG 恢复执行：[`flow_resume.py`](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py)
- 前端运行域：[`useWorkflowRunner.ts`](../../../../../opencreate/opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts)

## 主链

```text
POST /api/v2/flow/runs
  → 校验 nodes / edges 为 DAG
  → flow_task + workflow_command 同事务写入
  → command dispatcher
  → Redis Stream run_flow
  → Consumer durable inbox claim
  → 初始化 flow_run_state / flow_node_state
  → ready_nodes
  → 输入节点直接成功；模型节点生成并持久化 execution plans
  → invocation callback 聚合
  → success / failed / select
  → 推进后继或结束
```

选择续跑：

```text
节点有多个成功候选且存在后继
  → node status=select
  → Consumer durable run 仍为 running
  → Publisher 收到 select 事件后把公开 flow_task 标成 waiting_for_selection
  → 前端选择输出
  → POST /runs/{flowTaskId}/continue
  → selected_outputs 全量覆盖
  → SELECT → SUCCESS
  → 重新入 flow_resume
```

## 关键状态/消息

- 命令：`pending`、`dispatching`、`dispatched`；身份是 `command_id`，相同 ID 携带不同 payload 返回冲突。
- Publisher 对外 `flow_task`：`pending`、`running`、`waiting_for_selection`、`cancel_requested`、`completed`、`failed`、`killed`。
- Consumer `flow_run_state` 在 SELECT 期间仍保持 `running`；SELECT 不是整图终态。
- 节点：`idle`、`ready/queued`、`running`、`success`、`failed`、`stopped`、`select`。
- `start_ids / end_ids` 限定本次执行子图；完整 predecessor/successor 仍被保存。
- 模型执行前先持久化 `execution_plans`、稳定 `result_id`，再 claim 执行权。
- 典型事件：`start_flow`、`node_status`、`start_running_llm_models`、`llm_model_ready`、`llm_model_status`、`finish_running_llm_models`、`finish_flow`、`flow_killed`。

## 关键源码链接

- DAG 校验与命令事务：
  [`workflow_runs_v2.py`](../../../../../opencreate/opencreator-publisher/services/workflow_runs_v2.py)
- 前端 v2 请求：
  [`flow.ts`](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts)
- Consumer inbox 与命令状态机：
  [`flow.py`](../../../../../opencreate/opencreator-consumer/tasks/flow.py)
- ready 节点推进与模型提交：
  [`flow_resume.py`](../../../../../opencreate/opencreator-consumer/tasks/flow_resume.py)
- 节点状态与选择恢复：
  [`flow_node_state_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/flow_node_state_service.py)
- 多结果转 `select` 的判定：
  [`node_aggregation_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/node_aggregation_service.py)
- 终态判定：
  [`flow_completion_service.py`](../../../../../opencreate/opencreator-consumer/services/workflow/flow_completion_service.py)

## 跨仓边界

- Publisher 拥有用户入口、命令幂等和公开 run 状态；Consumer 拥有 DAG 执行事实。
- Consumer 不直接控制浏览器；它只发布事件。
- `opencreator-ai` 只执行模型任务与回调，不决定 DAG 后继是否 ready。
- 工作流 `select` 与 Agent 对话中的 `hitl` 卡片是两套状态机；Agent 可以投影工作流选择卡，但不能把二者当作同一记录。

## 遗留/未启用

- **兼容**：Consumer 仍接受 protocol v1/v2；v1 没有 v2 的稳定 `command_id`、inbox 与 Stream 状态屏障。
- **兼容**：前端仍保留 v1 kill API，现网 v2 run 应通过 `/runs/{id}/cancel`。
- **旁路**：恢复任务和维护 sweeper 可重新投递孤儿命令/节点；它们是故障恢复，不是正常用户入口。
- Publisher 只受理公开 `flow_task=waiting_for_selection` 的 continue；Consumer 侧要求 durable run 仍为 `running`，且至少恢复一个 SELECT 节点，否则图不推进。
- Agent prompt 中关于“高影响操作先确认”是运行策略，不是 Publisher DAG API 强制执行的事实。
