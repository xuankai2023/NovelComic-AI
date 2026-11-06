# 画布登录门禁与项目加载：按节补

对照 [画布登录门禁与项目加载差距.md](../../../adr/画布登录门禁与项目加载差距.md) 第 1 到第 6 节。按文末顺序做。每一节只改自己列出的文件。

# 1. 项目加载读本地草稿

做完要达到：断网前改过、PATCH 还没成功的图，重新进入 `/canvas/{flowId}` 仍能看到。`sync_status` 已是 `synced` 的项目以 `GET /api/v2/flow/project/{flowId}` 为准。

## 现在

`novelcomic-frontend/src/features/canvas-workflow/hooks/flow/use-workflow-project.ts` 的顺序是：

```text
getCachedWorkflowProject(flowId)
  → 有内存缓存就 isWorkflowReady = true
  → fetchFlowView(flowId)
  → 成功：setCachedWorkflowProject，state.workflow = 接口结果
  → 失败：state.workflow = null，isWorkflowReady = false
```

这个缓存是 `src/lib/flow-project-cache.ts` 里的模块级 `Map`。hook 不引用 `src/lib/local-db.ts`。

IndexedDB 里已经有同一 `flow_id` 的记录。字段在 `LocalWorkflow`：`nodes`、`edges`、`local_updated_at`（毫秒）、`server_updated_at`（字符串）、`sync_status`（`synced` | `pending` | `failed`）。写入函数是 `saveWorkflowLocally`、`markWorkflowSynced`、`markWorkflowFailed`、`updateLocalServerTimestamp`。

接口失败时 hook 把 `workflow` 写成 `null`。`canvasEditorContent.tsx` 看到 `error` 就只渲染失败文案，已有草稿不会进画布。

画布 store 不在这个 hook 里写。`CanvasEditorBody` 把 hook 返回的 `isWorkflowReady` 和 `workflow` 交给 `useHydrateLoadedFlow`。`isWorkflowReady` 为 true 且 `workflow` 有值时，`hydrateLoadedFlow` 用 `persist: false` 写入 nodes / edges。所以这次只要把选中的图放进 hook 的 state。`isLoading` 为 true 时页面停在 `Loading workflow...`，store 不会进图。有可显示的本地草稿时，`isLoading` 必须是 false。

`AgentCanvasLayout` 读 `workflow.details.project_name`。本地记录没有 `details`。请求回来之前若要用本地图，state 里的 `workflow.details` 必须存在。

`enabled === false` 时 hook 只用 `initialWorkflow`。分享页 `canvas.view.$flowId.tsx` 走这条。这条不读 IndexedDB，不发 GET。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/features/canvas-workflow/hooks/flow/workflow-project-local-draft.ts`。纯函数，不发请求，不写 IndexedDB。
2. 改 `use-workflow-project.ts`。请求前读本地，请求后调用上面的函数决定留哪一份，选定服务端时写回本地库。
3. 新建 `workflow-project-local-draft.test.ts`，用 vitest 覆盖判定表。

不改 `canvasEditorContent.tsx`、`useReactFlow.tsx`、`sync-manager.ts`、`flow-project-cache.ts`、Publisher。

OpenCreator 对照：

- `opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-one-flow.ts` 的 `flowFetcher`
- `opencreator-frontend/src/features/canvas-workflow/hooks/flow/workflow-project-local-draft.ts`

OpenCreator 在 `flowFetcher` 里并行取接口和 `getLocalWorkflow`，等两边都到了再写 store。它用 `local.server_updated_at === 项目更新时间` 判断草稿是否还基于当前服务端版本，状态必须是 `pending` 或 `failed`，并且 `nodes.length > 0`。留本地时它会 `syncManager.saveAndSync`。

NovelComic 这次按差距清单，不照搬那条相等判断，也不在加载时调用 `saveAndSync`。

## 时间怎么比

项目的服务端更新时间：

```text
serverUpdatedAt = workflow.updated_at || workflow.details?.updated_at || ''
serverUpdatedAtMs = Date.parse(serverUpdatedAt)
```

`Date.parse` 得到 `NaN` 时，视为没有可比的服务端时间。

`local_updated_at` 已经是毫秒，直接和 `serverUpdatedAtMs` 比。只用严格大于：

```text
local.local_updated_at > serverUpdatedAtMs
```

相等不算本地更新更晚，用接口结果。

`sync_status === 'synced'` 时直接用接口，不再比时间。`updateLocalServerTimestamp` 会把 `local_updated_at` 写成 `Date.now()`，已同步记录的本地时间几乎总是晚于服务端字符串。不先看状态的话，已同步项目会被误判成留本地。

请求发出前还没有接口里的更新时间，不能做这步比较。请求前只看本地状态，用来先把图放出来。比较放在接口返回之后，并且再读一次 IndexedDB。

## 纯函数

`workflow-project-local-draft.ts` 导出这些函数。

`getWorkflowProjectServerUpdatedAt(workflow)`：返回 `updated_at || details.updated_at || ''`。

`isUnsyncedLocalDraft(local)`：本地记录存在，且 `sync_status` 是 `pending` 或 `failed`。`synced`、`undefined` 都不是。

`shouldKeepLocalDraft(local, workflow)`：

| 条件 | 结果 |
| --- | --- |
| 没有本地记录 | 用接口 |
| `sync_status === 'synced'` | 用接口 |
| `pending` 或 `failed`，服务端时间解析失败 | 留本地 |
| `pending` 或 `failed`，且 `local_updated_at` 更大 | 留本地 |
| `pending` 或 `failed`，且服务端时间更大或相等 | 用接口 |

本地 `nodes` 可以为空。用户把节点删光也是一次还没同步的修改，要能看到空图。不要照 OpenCreator 因 `nodes.length === 0` 丢掉草稿。

`mergeWorkflowProjectWithLocalDraft(workflow, local)`：留本地时返回 `{ ...workflow, nodes: local.nodes, edges: local.edges }`。项目名、`flow_id`、`allow_reshare` 仍用接口上的。用接口时原样返回 `workflow`。

`workflowFromLocalDraft(flowId, local, cached)`：请求还没回来时，给 hook state 用。

- `cached` 有值：`{ ...cached, nodes: local.nodes, edges: local.edges }`。
- `cached` 没有：补一份最小 `WorkflowProject`。`flow_id` 用路由上的 id。`details` 至少包含 `project_name: ''`、`created_at: null`、`updated_at: null`、`time_zone: null`、`snapshot: null`、`app_mode_config: null`。`allow_reshare: true`。`created_at`、`updated_at`、`time_zone`、`last_view_time` 用 `null`，其中顶层 `updated_at` 可以放 `local.server_updated_at`，空字符串则用 `null`。`nodes` / `edges` 用本地的。

标题栏是 `workflow.details.project_name || workflow.flow_id`，空项目名会落到 `flow_id`，不会读到 `undefined.project_name`。

## hook 顺序

`useWorkflowProject` 在 `enabled === true` 的 effect 里按这个顺序做。`flowId` 变化或卸载时 abort，并忽略已经过期的 `setState`。

1. `const local = await getLocalWorkflow(flowId)`。
2. 本地是未同步草稿：`setState` 为 `error: null`、`isLoading: false`、`isWorkflowReady: true`、`workflow: workflowFromLocalDraft(...)`。内存缓存只作为 `workflowFromLocalDraft` 的第三参数，用来补 `details`。这一步不调用 `setCachedWorkflowProject`。
3. 本地没有未同步草稿：`isLoading: true`，`isWorkflowReady: false`，`workflow: null`。不要把 `getCachedWorkflowProject` 放进 state。内存缓存的规则在第 5 节。
4. `fetchFlowView(flowId, controller.signal)`。
5. 成功后立刻再 `getLocalWorkflow(flowId)`。用这一次的记录做判定，不用第 1 步的快照。等待期间用户又改了图，IndexedDB 里会有更新的 `local_updated_at`。
6. `shouldKeepLocalDraft` 为真：`mergeWorkflowProjectWithLocalDraft`，然后 `setCachedWorkflowProject`，state 使用合并后的项目，`isWorkflowReady: true`，`error: null`。不调用 `updateLocalServerTimestamp`，否则草稿会被标成 `synced`，下次进来被接口盖掉。不调用 `syncManager.saveAndSync`。加载只负责把图放出来；补传仍走编辑器现有的保存。
7. 判定为用接口：state 和内存缓存都换成接口结果。`server.nodes.length > 0` 或 `server.edges.length > 0` 时调用 `updateLocalServerTimestamp(flowId, serverUpdatedAt, nodes, edges)`。两边都空则不写 IndexedDB，避免一次空响应清掉已有本地记录。`nodes` / `edges` 传给 `updateLocalServerTimestamp` 时断言成它要的 `Node[]` / `Edge[]`。
8. 请求失败：调用 `clearCachedWorkflowProject(flowId)`，见第 5 节。不写 IndexedDB。若第 2 步已经放了未同步草稿，保持那份 `workflow`，`isWorkflowReady` 保持 true，`error` 保持 null，页面继续画这张图。若没有未同步草稿，`workflow: null`，`isWorkflowReady: false`，`error` 为该错误。全屏分类页在第 4 节。

`enabled === false` 的分支保持现在的实现。

## 和内存缓存的边界

未同步草稿可以在请求回来之前显示。内存里的 `Map` 不能。没有未同步草稿时保持加载，等 `fetchFlowView` 返回再换图。失败清掉这个 `flowId` 的缓存。选定结果之后才 `setCachedWorkflowProject`。请求前的本地占位不写入这个 `Map`。

## 自测

`workflow-project-local-draft.test.ts` 用纯对象，不挂 IndexedDB。至少覆盖：

- `pending`，`local_updated_at` 大于服务端时间：留本地 nodes / edges，项目名仍是接口上的。
- `failed`，同样更晚：留本地。
- `synced`，即使 `local_updated_at` 更大：用接口 nodes。
- `pending`，服务端时间更大：用接口。
- `pending`，两边时间相等：用接口。
- `pending`，服务端 `updated_at` 为空、`details.updated_at` 也空：留本地。
- 顶层 `updated_at` 为空、`details.updated_at` 有值：用详情里的时间做比较。
- `pending` 且 `nodes` 为空：仍留本地。
- `workflowFromLocalDraft` 在没有内存缓存时带上 `details`，`details.project_name` 是字符串。

跑：

```text
cd novelcomic-frontend && npx vitest run src/features/canvas-workflow/hooks/flow/workflow-project-local-draft.test.ts
```

手测两条：

1. 打开自己的 `/canvas/{flowId}`，改一个节点位置或文案，在 PATCH 完成前断网，刷新或重新进入同一路由。画布上是断网前那一版。恢复网络后，若服务端 `updated_at` 仍更早，刷新仍是这一版。
2. 同一项目已 `synced`，用另一处把服务端改新，再打开。画布是接口结果，IndexedDB 被 `updateLocalServerTimestamp` 写成 `synced`。

# 2. 旧图兼容留空函数

做完要达到：加载进 store 之前经过一个迁移函数。函数原样返回节点。仓库里没有旧类型样本，不写映射表。`Flow.tsx` 连线时不改历史节点。

## 现在

OpenCreator 的 `use-one-flow.ts` 在 `beforeFlowDataFormat` 里丢掉 `syncVideoAudio`、`imageAnnotationNode`、`videoAnnotationNode`，把 `describeImage` 改成 `textGenerator`，并把 `videoLipSync` 上的 `Runway Gen4 turbo`、`Fal Pixverse Lipsync` 改成 `fal-ai/pixverse/lipsync`。常量在 `opencreator-frontend/src/constants/nodeTypes.ts`。

NovelComic 的 `use-workflow-project.ts` 把接口或本地草稿的 nodes 原样放进 state。`useHydrateLoadedFlow` 再写入 store。`flow.store.ts` 的 `getSimplifiedWorkflowNode` 只在比较撤销栈时删掉临时字段，不改 `type`，不改模型名。

NovelComic 仓库里没有这些旧类型或旧模型名的图数据。不要把 OpenCreator 那张表抄过来。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/features/canvas-workflow/hooks/flow/migrate-loaded-workflow.ts`。
2. 改 `use-workflow-project.ts`。凡是即将放进 state、随后会被 hydrate 的 `workflow.nodes`，先过这个函数。本地占位、合并后的本地图、接口结果都走这一处。
3. 新建 `migrate-loaded-workflow.test.ts`。

不改 `Flow.tsx`、`flow.store.ts`。

## 函数

```text
migrateLoadedWorkflowNodes(nodes) => nodes
```

入参和返回是同一份节点数组的浅拷贝，`type` 和 `data` 不动。以后有旧图样本时，只改这个函数，仍然在写入 store 之前调用。

测试：传入带 `type` 和 `data.selectedModels` 的节点，返回值与入参深度相等，且不是同一个数组引用。

# 3. 分享页拉历史结果

做完要达到：别人打开分享链接能看到分享者的历史产出。编辑页仍用当前用户的批量接口。节点 id 含 `Input-` 的不进这批请求。结果请求结束前画布保持加载，不先画出空结果。

## 现在

路由画布是 `canvasEditorContent.tsx`，不是 `Canvas.tsx`。`Canvas.tsx` 里的 `NodeResultsProvider` 当前这两条路由没用到。`resolveInitialNodeResultsLoad` 已经滤掉 `Input-`，但分享页不经过它。

`canvasEditorContent.tsx` 在 `readonly`、没有 workflow、或节点列表为空时 `setResults({})` 并 return，不调用 `batchFetchAllNodeResults`。`canvas.view.$flowId.tsx` 把分享页以 `readonly` 传进去。编辑页会把全部节点 id 打进 `POST /api/v3/result/all_batch_fetch`，而且 `results` 初始是 `{}`，`AgentCanvasLayout` 立刻渲染。

前端 `batchFetchAllNodeResults` 已经能在 body 里带 `share_id`。Publisher `app/controller/v3/result.py` 的 `batch_fetch_latest_results` 把 `body.user_id` 改成 JWT 的 `sub`，查询条件只用这个 `user_id`。`share_id` 被丢掉。访客因此只能查到自己的空结果。`tests/test_user_resource_scope.py` 要求：没有合法分享时，body 里的 `user_id` 不能读到别人的结果。

OpenCreator 对照：`useNodeResultsProvider.tsx` 在工作流就绪后调用 `batchFetchAllNodeResults`，带上 `shareId`。`services/result.py` 的 `_resolve_share_owner` 校验分享后再用分享者的 `user_id` 查询。`canvasEditorContent.tsx` 在 `hasInitialLoadCompleted` 之前保持加载遮罩。

## 改哪些文件

1. `novelcomic-publisher/app/controller/v3/result.py`：有 `share_id` 时改查询用的 user id。
2. `novelcomic-frontend/src/components/canvas-editor-content/canvasEditorContent.tsx`：编辑页和分享页都拉结果，滤掉 `Input-`，结果结束再渲染画布。
3. `novelcomic-frontend/src/routes/canvas.view.$flowId.tsx`：把 `shareId` 传进 `CanvasEditorContent`。
4. Publisher 测试补分享身份。前端给节点过滤一个纯函数测试。

不改 `Flow.tsx`。不把结果请求接到当前未使用的 `NodeResultsProvider`。PATCH 结果仍只按 JWT 用户，不跟 `share_id`。

## 分享身份

`batch_fetch_latest_results` 先把 `body.user_id` 设成当前 JWT 用户。没有 `share_id` 时，查询保持现在这样。

有 `share_id` 时：

1. 用 `ShareDao.get_by_share_id` 或 `ShareService` 已有的读取。分享不存在，返回现在的 `ShareNotFoundError`：HTTP 404，业务码 `1040`。
2. `email_whitelist` 非空时，用当前用户邮箱做现在的白名单判断。不在名单里返回 `ShareEmailNotAllowedError`：HTTP 403，业务码 `1041`。公开分享跳过这步。
3. 查询 `node_results` 的 `user_id` 改成分享文档的 `owner_user_id`。`workflow_id` 仍用 body 里的，并要求它等于分享文档的 `flow_id`。对不上就按没有结果返回空 map，不要去读另一张图。
4. body 里自带的 `user_id` 仍然不能决定查谁。

现有「user_a 带 user_b 的 body、不带 share_id、得到空列表」测试保持通过。另加：合法分享下 user_a 能读到 owner 的最新结果；失效 `share_id` 是 404 / `1040`；白名单外是 403 / `1041`。

## 前端何时画

`CanvasEditorContent` 增加可选 `shareId`。

节点 id 用 `!nodeId.includes('Input-')` 过滤，和 `resolveInitialNodeResultsLoad` 同一条规则。滤完为空：不发请求，`results` 为 `{}`，可以直接画布。

编辑页不传 `shareId`，调用 `batchFetchAllNodeResults(flowId, filteredIds)`。分享页传入 `shareId`，第三个参数带上。

`readonly` 不再把结果清掉就 return。请求未结束时继续渲染现在的加载节点（`aria-busy`），不渲染 `AgentCanvasLayout`。请求成功后把结果放进 state，再渲染画布。请求失败后也渲染画布，并保留现在的 `Node results load failed`。不要一直转圈。

`canvas.view.$flowId.tsx` 把路由上的 `shareId` 传给 `CanvasEditorContent`。编辑路由 `canvas.$flowId.tsx` 不传。

# 4. 打开失败的全屏页

做完要达到：项目不存在、无权访问、分享失效、坏快照各自是全屏页，并有回到首页。不再只显示一行 `error.message`。业务码保持现状，不改成 `5000` / `5001`。

## 现在

`src/api/client.ts` 的 `ApiError` 带 `code`（响应体业务码）和 `status`（HTTP 状态）。

项目 GET 失败：`workflow_project.py` 的 `_not_found` 是 HTTP 404、业务码 `1010`、文案 `Flow project not found`。别人的项目和真不存在都是这一对，因为查询条件是 `flow_id + user_id`。接口没有单独的无权码。

分享失败在 `exception_share.py`：

| 情况 | HTTP | 业务码 |
| --- | --- | --- |
| 分享不存在 `ShareNotFoundError` | 404 | `1040` |
| 邮箱不在白名单 `ShareEmailNotAllowedError` | 403 | `1041` |
| 分享的源项目不存在 `ShareSourceNotFoundError` | 404 | `1042` |

`canvasEditorContent.tsx` 失败时渲染 `Workflow load failed: {error.message}`。`canvas.view.$flowId.tsx` 渲染 `Share load failed: {error.message}`。快照缺失时是 `Shared workflow snapshot is unavailable.`。

白名单分享在登录前 `snapshot` 为空，页面是现在的 `Login required`。那不是失败页，这次不要换成错误页。

OpenCreator 的 `resolveErrorType` 把 `5000` 收成找不到、`5001` 收成白名单。NovelComic 没有这两个码。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/components/canvas-editor-content/canvas-load-error-page.tsx`。全屏页和分类函数放这里。
2. `canvasEditorContent.tsx` 用这个页替换一行失败文案。
3. `canvas.view.$flowId.tsx` 同样替换分享失败和坏快照。
4. 新建 `canvas-load-error-page.test.ts`，只测分类函数。

不改 Publisher 的 `1010`。首页路由是 `/`。

## 分类

`resolveCanvasLoadError(error)` 只看 `ApiError` 的 `status` 和 `code`：

| 条件 | 页面 |
| --- | --- |
| `status === 404` 且 `code === 1010` | 项目不存在。别人的项目也进这一页 |
| `status === 403` 且 `code === 1041` | 无权访问 |
| `status === 404` 且 `code === 1040` | 分享已失效 |
| `status === 404` 且 `code === 1042` | 分享对应的项目不存在，文案可以和项目不存在同一页 |
| 其他错误 | 通用全屏页，标题用打开失败，正文可以用 `error.message` |

另有一个不来自 `ApiError` 的页面：分享响应成功但 `share.snapshot` 缺失，或 `shareSnapshotToWorkflowProject` 返回 null。标题是快照不可用。

每一页是占满视口的区块，包含标题、一句说明、按钮「回到首页」。按钮 `navigate({ to: '/', replace: true })`。

`Missing shareid` 也用通用全屏页，不再用一行 alert。`shouldHoldReadonlyShareForLogin` 为真时仍显示登录提示，不显示失败页。

未同步本地草稿已经显示时，第 1 节要求 `error` 保持 null。那种刷新不进入本页。

# 5. 内存缓存等请求，GET 写 last_view_time

做完要达到：同一页面再次打开画布时，不先闪出 `Map` 里的旧图。请求失败后这个 `flowId` 的缓存被清掉，换账号再进不会先看到上一份图。`GET /api/v2/flow/project/{flowId}` 成功后写入 `last_view_time`。项目不存在时不写。

## 现在

`flow-project-cache.ts` 是模块级 `Map`，没有删除函数，没有 TTL。第 1 节改完后，没有未同步草稿时 hook 不再用这份缓存当作首屏。成功结果仍 `setCachedWorkflowProject`。

`FlowService.get_workflow_project` 只读。创建项目时 `last_view_time` 是 `None`。`update_workflow_project` 的 `$set` 不包含这个字段，节点 PATCH 不会碰它。

OpenCreator 在 `controller/v2/workflow_project.py` 的 GET 里，项目存在才调用 `FlowService.update_workflow_project_last_view_time`，并且只 `$set` `last_view_time`。普通打开的 `staleTime` 为 0，没有种子缓存就等请求。

## 改哪些文件

1. `novelcomic-frontend/src/lib/flow-project-cache.ts`：导出 `clearCachedWorkflowProject(flowId)`，删掉这个 key，并派发现在的 `FLOW_PROJECT_CACHE_UPDATED_EVENT`。
2. `use-workflow-project.ts`：失败分支调用它。成功分支才 `setCachedWorkflowProject`。首屏不读缓存进 state，第 1 节已经写了。
3. `novelcomic-publisher/app/dao/flow.py`：新增只更新 `last_view_time` 的方法，条件仍是 `flow_id + user_id`。
4. `novelcomic-publisher/app/services/flow.py`：`update_workflow_project_last_view_time` 用 `datetime.now(UTC)`，返回这个时间。
5. `app/controller/v2/workflow_project.py` 的 `get_workflow_project`：项目读到之后更新 `last_view_time`，把返回体里的字段换成这次的时间，再 `_dump_project`。`project is None` 时直接 `_not_found()`，不更新。

不改列表排序。这次只保证打开成功会写下这个时间。不给内存 `Map` 加 TTL。

## 响应

更新成功后，响应 `data.last_view_time` 是刚写入的时间，不是库里的旧值，也不是 `null`。节点 PATCH 和详情 PATCH 的更新文档里仍然不要带 `last_view_time`。

Publisher 测试：GET 自己的项目后文档里的 `last_view_time` 从 `None` 变成时间；响应里带上同一时间。GET 不存在或别人的 `flow_id` 返回 404 / `1010`，对应文档的 `last_view_time` 不变。

# 6. 复制模板恢复 5 分钟过期

做完要达到：未登录时点复制，待执行记录 5 分钟后失效。复制成功才删掉记录。复制失败留下记录，下次重新登录还可以再试一次。不走 `auth-recovery`。

## 现在

`use-copy-template.ts` 的 key 是 `sessionStorage` 的 `novelcomic:use-template-preview`。值是 `{ shareId, source? }`，没有时间。`savePendingTemplateCopy` 在未登录时写入并打开登录框。

`useResumePendingTemplateCopy` 挂在 `ClientProviders.tsx`。`isSignedIn` 后立刻把 `resumedRef` 设成 true，再调用 `copyTemplateByShareId`。失败后这次页面生命周期不会再进 effect。`clearPendingTemplateCopy` 只在 `handleCreateNewFlow` 返回了 `flowId` 时调用。

OpenCreator 把恢复动作放进 `localStorage` 的 `auth_recovery_action`，信封是 `{ action, ts }`，超过 5 分钟就删掉并返回 null。模板复制成功才清除。NovelComic 登录清单写过：复制模板用自己的存储，不放进 `auth-recovery`。这次仍用原来的 key，只给它加过期。

NovelComic 按 `shareId` 调 `fetchShareInfo` 再创建项目，没有「等模板列表到齐」这一步。不要加。

## 改哪些文件

只改 `use-copy-template.ts` 和 `use-copy-template.test.ts`。

## 记录

写入：

```text
{ shareId, source?, savedAt }
```

`savedAt` 是 `Date.now()`。`TEMPLATE_COPY_TTL_MS = 5 * 60 * 1000`。

`readPendingTemplateCopy`：

- 没有记录，返回 null。
- JSON 坏了、没有 `shareId`、没有数字 `savedAt`：删掉 key，返回 null。
- `Date.now() - savedAt > TEMPLATE_COPY_TTL_MS`：删掉 key，返回 null。
- 否则返回 `{ shareId, source, savedAt }`。

旧的、没有 `savedAt` 的记录视为过期，读到就删。

## 何时再试

`useResumePendingTemplateCopy` 去掉「一进 effect 就把 resumedRef 设成 true」。

用本次记录的 `shareId + savedAt` 做尝试键：

1. `isLoaded` 为 false：什么都不做。
2. `isSignedIn` 为 false：清掉尝试键，以便下一次登录能再试。不删除 storage。
3. `isSignedIn` 为 true：读记录。没有记录就返回。尝试键和当前记录相同，说明这次登录已经试过，返回。
4. 先写下尝试键，再 `copyTemplateByShareId`。返回了新的 `flowId` 才 `clearPendingTemplateCopy`。抛错或返回空字符串：留下 storage。用户保持登录时不要自动连着重试。退出再登录后，第 2 步清掉尝试键，记录还在且未过期，就可以再试一次。

`copyTemplateFromShare` 里现有的「成功才 clear」保持不变。未登录只 `savePendingTemplateCopy`，不要 clear。

## 自测

在 `use-copy-template.test.ts` 里：

- 写入后立刻读到，带 `savedAt`。
- 把 `savedAt` 改成 5 分钟再加 1 毫秒之前，读到 null，并且 key 已删除。
- 没有 `savedAt` 的旧 JSON，读到 null，并且 key 已删除。
- 成功路径的 clear 仍然让下一次 read 为 null。失败不调用 clear 时，read 仍返回原 `shareId`。

# 顺序

1. 第 1 节：`use-workflow-project.ts` 读 IndexedDB，和接口时间比较。
2. 第 3 节和第 4 节：分享页拉历史结果，打开失败做全屏页。
3. 第 5 节：不用内存缓存当首屏，失败清缓存，GET 成功写 `last_view_time`。
4. 第 6 节：模板待复制加 5 分钟，失败可在下次登录再试，成功才删。
5. 第 2 节：迁移函数留空。有旧图样本再写映射。

WebSocket、continue、cancel 不写进这一份。
