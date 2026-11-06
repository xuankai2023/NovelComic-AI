# 工作流命令、DAG 与 HITL：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-consumer`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-consumer`。

不在这一段：登录换 JWT、画布项目加载、运行态写进 flow store、全局 Run 取当前图、空输入检查、`llm_model_ready` 三条事件的发布顺序、`stopped` 收成 idle、重连时更换 `connectionId`。这些在「从登录到画布亮灯」那一份。WebSocket 的 cursor、replay、`4409` 归下一组「可恢复 WebSocket」。Agent 工具 interrupt 不是这里的 `select`。余额、升级弹窗、埋点、Sentry 不进这一份。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是 id 用 uuid 还是 nanoid、类怎么拆、日志文案。

- `workflow:v2:pending_commands` 在 `sessionStorage`。`POST /api/v2/flow/runs`、continue、cancel 都返回 `202`。相同 `command_id` 加相同 payload 回放原 run。相同 id 换 payload 是冲突。环在 Publisher 入口拒绝
- `create_run()`、`continue_run()`、`cancel_run()` 都把 `flow_task` 和 `workflow_command` 放进同一事务，提交之后才派发。派发进 Redis Stream `run_flow`，消息带 `protocol_version=2` 和 `wire_command_id`
- continue 只接受公开状态 `waiting_for_selection`，CAS 成 `running` 再派发。cancel 把公开状态写成 `cancel_requested` 再派发
- Consumer 先 `claim_command`。start、continue、cancel 都会进 `run_flow`。重复 start 在 `start_initialized` 之后不再初始化。cancel 走 `request_cancel` 和 `_stop_flow_for_kill`，发布 `flow_killed`
- `ready_nodes` 只等 active 前驱的 `success`。`start_ids` / `end_ids` 有值时，active 子图按可达范围算。`select` 不是整图终态，Consumer run 仍是 `running`
- `node_status=select` 到 Publisher 后，公开 `flow_task.status` 变成 `waiting_for_selection`。多候选、有后继、且不是本次 `end_ids` 里的节点，聚合判定是 `select`。全失败是 `failed`，后继 `stopped`。没齐是 `waiting`

# 1. 每个模型结果先落成按类型分组的 outputs

做完要达到：一个模型节点按选中的模型和次数生成多条计划。每条计划有自己的 `result_id`。这些 `result_id`、`execution_plans`、`result_placeholders` 先写入节点，再逐条提交。callback 成功后，结果写进该节点的 `outputs.{type}.outputs`。同一 `result_id` 再来一次，替换这一条，不追加。元素里有 `result_id`、`model`、`output`、`path`、`type`。

聚合仍用现有的 `NodeAggregationDecision`。`select` 或 `success` 的 `node_status` 事件带上这份 `outputs`。聚合发布时先发 `finish_running_llm_models`，再发 `node_status`。浏览器现在不单独处理 `finish_running_llm_models`，补上发布即可，前端不用新加分支。

同一 run 里状态为 `submitting` 或 `running` 的模型调用达到 5 个时，这个节点写成 `queued`，并标记还要 resume，这次不提交。一条计划提交失败，记成这条 result 失败。全部计划都提交失败时，节点写成 `failed`，后继写成 `stopped`。节点类型没有对应模型配置时，同样失败并停后继，不提交一个 `default` 模型。

输入节点仍先 `running` 再 `success`。成功后它的 `outputs` 是 `{text|image|video|audio: {node_id, outputs}}`。值来自该节点自己的 `inputText`、`imageBase64`、`inputVideo`、`inputAudio`，`is_public` 为 true。

## 现在

`ModelInvocationPlanner.plan_node` 只取 `selectedModels[0]`，只生成一个 `result_id`。`set_expected_result` 把 `expected_result_ids` 写成这个单元素数组。`submit_planned_node` 用这一个 `result_id` 提交一次。

`complete_from_callback` 把 callback 正文写在 invocation 的 `result` 上。节点的 `outputs` 一直是 `{}`。`node_status=select` 事件里的 `outputs` 因此是空的。提交抛错时，节点已经在 `claim_planned_execution` 里写成 `running`，之后停在那里。没有同时运行上限。

输入节点在 `flow_resume.py` 里把 `outputs` 写成 `{node_data, inputs}`。

`llm_model_ready` 和 `llm_model_status` 的发布顺序在亮灯那一份第 3 节。这一节只补计划内容和结果落库。占位事件仍从这里写出的 `result_placeholders` 取。

## 改哪些文件

1. `novelcomic-consumer/app/services/invocation/model_invocation_planner.py`，对照 OpenCreator `services/invocation/model_invocation_planner.py` 的 `plan_node`。一条计划对应一个 `result_id`。先 `set_expected_results`，再返回这批计划。已有 `execution_plans` 时复用，不再生成第二批 id。
2. `novelcomic-consumer/app/services/workflow/flow_node_state_service.py` 增加 `set_expected_results`、`upsert_output_item`、`upsert_output_items`，对照 OpenCreator 同名方法。`outputs.{type}.outputs` 按 `result_id` 替换。
3. `novelcomic-consumer/app/services/invocation/model_invocation_service.py` 的 `complete_from_callback`。成功结果先写入节点 outputs，再调用现有 `aggregate_invocation`。提交失败走现有聚合的失败尾部。
4. `novelcomic-consumer/app/tasks/flow_resume.py` 的模型分支按计划逐条提交。达到 5 个在途调用时写成 `queued`。输入节点成功时写出上面的 outputs 形状。`_publish_node_started` 的三条事件仍按亮灯那一份改，不要在这一节重排。

OpenCreator 对照：

- `opencreator-consumer/services/invocation/model_invocation_planner.py` 的 `plan_node`
- `opencreator-consumer/services/workflow/flow_node_state_service.py` 的 `set_expected_results`、`upsert_output_item`
- `opencreator-consumer/services/invocation/invocation_result_writer.py` 的 `write_node_result`
- `opencreator-consumer/tasks/flow_resume.py` 里复用已有计划、逐条 `_submit_plan`、在途上限，以及输入节点 `set_outputs`
- `opencreator-consumer/services/workflow/node_aggregation_service.py` 的 `_publish_node_events`

# 2. 后继按边读取 selected_outputs

做完要达到：`init_nodes` 保存完整 `predecessors`、`successors`，以及 `predecessor_edges`、`successor_edges`。边上保留 `source`、`target`、`sourceHandle`、`targetHandle`。

`user_selection` 的形状是按输出类型分组：

```text
{
  text|image|video|audio|...: [
    { node_id, outputs: [{ model, output, path, type? }] }
  ]
}
```

解析后写到节点的 `selected_outputs`，形状是 `{类型: {node_id, outputs}}`。某条 output 带了 `output_format` 时，用它作为 `output`。`seed_user_selection_outputs` 只写非 active 节点，不改 status。`apply_user_selection_for_continue` 按 `node_id` 全量覆盖 `selected_outputs`，不往旧数组后面追加。

后继取输入时，同一个前驱上只要有 `selected_outputs`，整份优先于 `outputs`。用 `targetHandle` 对上类型。`targetHandle` 是 `text` 时再试 `splitText`。非标准 handle 再退回 `sourceHandle`。取到的每条 output 带上 `metadata.source_node_id`。输入节点前驱的条目 `is_public` 为 true。这份输入写在当前节点的 `inputs` 上，和 `outputs` 分开。

## 现在

`init_nodes` 只存前驱和后继的 id。`_selection_by_node` 把对象的 key 当成 `node_id`，或从数组元素里取 `node_id`，然后把整段对象写进 `selected_outputs`。continue 时还会把同一份写到 run 文档的 `selected_outputs`。

`_collect_inputs` 先读前驱的 `outputs`。前驱已经有 outputs 时，不再读选择。key 是前驱 id，不是 `text` / `image` 这种类型。没有 `predecessor_edges`，边的 handle 到不了后继。

`novelcomic-consumer/tests/test_workflow_dag_execution.py` 现在断言 run 文档上的 `selected_outputs`。改完后，后继读的是节点上的 `selected_outputs`。这些断言跟着改。

## 改哪些文件

1. `novelcomic-consumer/app/services/workflow/flow_node_state_service.py` 的 `init_nodes`、`seed_user_selection_outputs`、`apply_user_selection_for_continue`。解析对照 OpenCreator `_parse_user_selection_per_node`。选择只写节点，不作为后继输入的来源写到 run 上。
2. 新增 `novelcomic-consumer/app/services/workflow/flow_variable_state_service.py`，对照 OpenCreator `prepare_inputs_from_predecessors`。
3. `novelcomic-consumer/app/tasks/flow_resume.py` 的 `_collect_inputs` 改成调用上面这个方法。`ready_nodes` 的判定已经对齐，这一节不改。

OpenCreator 对照：

- `opencreator-consumer/services/workflow/flow_node_state_service.py` 的 `init_nodes`、`_parse_user_selection_per_node`、`seed_user_selection_outputs`、`apply_user_selection_for_continue`
- `opencreator-consumer/services/workflow/flow_variable_state_service.py` 的 `prepare_inputs_from_predecessors`
- `opencreator-consumer/services/workflow/flow_graph_scope.py` 的 `edge_payload`

# 3. 勾选候选后再发 continue

做完要达到：模型节点进入 `select` 后，用户按 `result_id` 勾选该节点历史结果里 `success` 的 output。勾选写进 `userSelection`，key 是节点输出类型，`splitText` 用 `text`。同一节点同一类型只留一份 outputs，后一次勾选覆盖前一次。

点继续后，`POST /runs/{flow_task_id}/continue` 的 body 带：

- `flow_run_id`
- 当前画布图做出的 `flow_task`
- `start_ids`：这次 run 记下的节点数组里，该节点的下一个 id；没有下一个就是 `[]`
- `user_selection`：先按这张图滤掉图外节点和空 outputs，再经 `transformUserSelection`

`transformUserSelection` 对输入节点改写 outputs：`imageInput` 用 `imageBase64`，`audioInput` 用 `inputAudio`，`videoInput` 用 `inputVideo`，`textInput` 用 `inputText` 转成的 markdown。其它节点原样传递。

`operationKey` 是 `continue:{flowTaskId}:{flowRunId}`。没有任何 SELECT 节点被改成 SUCCESS 时，Consumer 不 resume。同一 `command_id` 已经把该节点写成 SUCCESS 时，重投仍然 resume。后继由现有 `ready_nodes` 算出来。

OpenCreator 的 continue 请求体会带上这个 `start_ids`，Publisher 把它记到公开任务上。Consumer 的 continue 分支不按它重算 `is_active`。这一节前端把字段带上。Publisher 和 Consumer 不要为了这个字段改子图。

## 现在

`continueWorkflow` 发送 `{ [nodeId]: nodeResults[nodeId][0] }`。`agent-canvas-layout.tsx` 的 Continue 用该节点结果数组的第一项，没有按 `result_id` 勾选。`operationKey` 是 `continue:{flowTaskId}:{nodeId}`。请求不带 `start_ids`。图来自进入页面时的 `workflow`。亮灯那一份第 2 节只改了 `runAll` 的图来源。

`outputsFromEvent` 只在 `outputs` 是数组时收下。OpenCreator 的 `node_status` 把 `node_outputs` 放在事件顶层，形状是按类型分组的对象。快照路径里的 `snapshotNodeOutputs` 已经会把这种对象摊平。实时的 `select` 事件还没有走这套摊平，勾选列表拿不到候选。

Consumer 在节点仍是 `select`、但这次 CAS 没写上时，直接处理下一个节点，不把「同一 `command_id` 已经写成 SUCCESS」算进 `already_applied_select_to_success`。重投时 `restored` 和 `already_applied` 都是 0，continue 被丢掉，后继不跑。

历史结果里的占位和按 `result_id` 替换，仍按亮灯那一份第 3 节。这一节只从那份成功结果里做勾选。

## 改哪些文件

1. 新增 `novelcomic-frontend/src/components/headBar/lib/transformUserSelection.ts`，对照 OpenCreator `transformUserSelection` 和 `sanitizeUserSelectionForFlow`。
2. 新增一份 `userSelection` 状态，对照 OpenCreator `generated-result.store.ts` 里的 `userSelection`，以及 `src/lib/userSelectionHelpers.ts` 的 `updateUserSelection`。勾选发生在能读到该节点历史结果的结果卡片上，对照 `BaseResultCard.tsx` 里按 `result_id` 写入的那一段。
3. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `continueWorkflow` 和 `outputsFromEvent`。`outputsFromEvent` 对按类型分组的对象使用现有 `snapshotNodeOutputs` 的摊平。`operationKey` 改成 OpenCreator 那一把。图从 flow store 取，和亮灯第 2 节的 `runAll` 同一份。
4. `novelcomic-frontend/src/components/canvas/agent-canvas-layout.tsx` 的 Continue。没有勾选时不发 continue。
5. `novelcomic-consumer/app/services/workflow/flow_node_state_service.py` 的 `apply_user_selection_for_continue`。CAS 没写上时再读节点。状态已是 `success` 且 `continue_command_id` 等于这次命令，计入 `already_applied_select_to_success`。`novelcomic-consumer/app/tasks/flow.py` 的 continue 分支已经会在 `already_applied > 0` 时 resume，这一处保持。

OpenCreator 对照：

- `opencreator-frontend/src/components/headBar/lib/transformUserSelection.ts`
- `opencreator-frontend/src/lib/userSelectionHelpers.ts`
- `opencreator-frontend/src/features/canvas-workflow/components/custom_result/base/card/BaseResultCard.tsx` 里写入 `userSelection` 的那段
- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 里监听 `taskRetryCount` 发出的 continue，以及 `findNextNode`
- `opencreator-consumer/services/workflow/flow_node_state_service.py` 的 `apply_user_selection_for_continue`
- `opencreator-consumer/tasks/flow.py` 里 `flow_run_type == "continue"` 的那一支

# 4. 单节点和选中节点带这次子图

做完要达到：单节点跑提交的图是目标节点加上它的全部前驱，节点按拓扑序排列。`run_mode` 是 `single_node`。`start_ids` 和 `end_ids` 都是 `[目标节点]`。`intent_node_ids` 也是这一个 id。`user_selection` 带上前驱里已经成功的输出；前驱是输入节点时，用该节点自己的输入值。目标节点是 active，前驱不是。前驱不挡住 ready。目标节点的输入来自这些前驱的 `selected_outputs`。

选中节点跑提交的图只有被选中的可执行节点，以及它们彼此之间的边。`run_mode` 是 `selected_nodes`。`intent_node_ids` 是这些节点 id。`start_ids` 和 `end_ids` 不传，这张子图全部 active。`user_selection` 同样经过 `transformUserSelection`。

`operationKey` 是 `create:{flowId}:{runMode}:{intentScope}`。单节点和选中节点的 scope 是排序后的 intent id，用逗号连接。空输入检查和亮灯第 2 节的全局 Run 同一套，命中时不发创建请求。

## 现在

`runAll` 固定 `run_mode: "global"`，不传 `start_ids`、`end_ids`、`user_selection`。`operationKey` 是 `create:{flowId}:global`。前端没有单节点跑，也没有选中节点跑。

Consumer 的 `active_node_ids` 和 `seed_user_selection_outputs` 已经能处理子图。缺的是请求里的范围和选择。这一节不改 ready 判定。

## 改哪些文件

1. `novelcomic-frontend/src/lib/generateFlow.tsx`。亮灯第 2 节会新增 `generateFlowGraph`。这一节在同一文件补 `generateAncestorFlow` 和 `generateSelectedNodesFlow`，对照 OpenCreator `src/lib/generateFlow.tsx`。
2. `novelcomic-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 增加单节点和选中节点的创建。body 字段对照 OpenCreator `startWorkflowTransport`。全局 Run 的 key 仍按亮灯第 2 节改成 `create:{flowId}:global:all`。
3. 单节点入口对照 OpenCreator `use-single-node-run.ts`：先把输入前驱和已成功前驱写进 `userSelection`，再发创建。选中节点入口对照 `sendSelectedNodesFlowData`。画布上挂到现有节点操作，不新做一套节点外观。

余额和埋点不进这三个文件的本次 diff。

OpenCreator 对照：

- `opencreator-frontend/src/lib/generateFlow.tsx` 的 `generateAncestorFlow`、`generateSelectedNodesFlow`
- `opencreator-frontend/src/components/headBar/hooks/useWorkflowRunner.ts` 的 `startWorkflowTransport`、`sendSingleNodeRunFlowData`、`sendSelectedNodesFlowData`
- `opencreator-frontend/src/features/canvas-workflow/hooks/flowAction/use-single-node-run.ts`
- `opencreator-frontend/src/lib/nodeRunHelpers.ts` 的 `handleInputNodeSelection`

# 补齐顺序

先把模型结果写成按类型分组的 `outputs`，让 `select` 事件里能看到候选。

然后改边和 `selected_outputs`，让后继读到选择，而不是前驱的全部 outputs。

然后接勾选和 continue。最后补单节点和选中节点的子图请求。

不要改 `create_run` 的幂等和 `202`。不要改 continue 的 CAS 条件。不要改 `ready_nodes` 的判定。不要在这一段改 WebSocket 重连。
