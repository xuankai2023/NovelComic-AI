# 画布登录门禁与项目加载 question

## 核心概念

- 为什么打开画布不是直接跑模型？
  - 打开画布只是进入编辑页面，先做登录门禁，再读取 flow project。
  - flow project 里是 nodes、edges、项目名、分享配置等项目定义。
  - 模型执行要等用户点击 Run 后，创建 workflow run。
  - 所以“画布可见”和“模型运行”不是一件事。

- flow project 是什么？
  - flow project 是用户正在编辑的一张图。
  - 它包含 `flow_id`、`nodes`、`edges`、`details.project_name`、`allow_reshare`、`parent_flow_id`、时间字段等。
  - 它表示项目定义，不表示一次执行。

- workflow run / flow task 是什么？
  - workflow run 是用户点击 Run 后创建的一次执行实例。
  - 后端会返回 `flow_task_id`、`flow_run_id`、`trace_id`、`status`。
  - WebSocket 连接依赖 `flow_task_id`，不是依赖 `flow_id`。

- node result 是什么？
  - node result 是节点已有的结果快照。
  - 打开画布后可以通过 `all_batch_fetch` 批量补拉。
  - 它不代表节点正在运行，也不会触发模型执行。

- `flow_id`、`flow_task_id`、`flow_run_id` 有什么区别？
  - `flow_id` 是项目定义 id，用来读取画布 nodes / edges。
  - `flow_task_id` 是一次执行任务 id，用来连接事件 WebSocket、取消任务、查询任务。
  - `flow_run_id` 是逻辑运行实例 id，用来标识一次 run。
  - 三个字段不能混用。

- 为什么说画布可见、历史结果可见、运行中亮灯是三件事？
  - 画布可见依赖 flow project 加载成功。
  - 历史结果可见依赖 `POST /api/v3/result/all_batch_fetch` 返回节点结果。
  - 运行中亮灯依赖 workflow run 的状态和 WebSocket 事件。
  - 三条链路的数据来源不同。

## 登录门禁

- 为什么 `/canvas/{flowId}` 要先过 `RequireAuth`？
  - 编辑画布是用户自己的项目编辑页。
  - 未登录时不应该渲染画布子树。
  - `RequireAuth` 根据 Clerk 的 `isLoaded` / `isSignedIn` 决定显示 loading、打开登录弹窗或渲染 children。

- `RequireAuth` 是不是安全边界？
  - 不是。
  - `RequireAuth` 只是在前端控制页面是否渲染。
  - 用户可以绕过前端直接请求接口，所以 Publisher 仍然必须验 Bearer JWT。

- 已经有前端门禁了，为什么后端还要验 JWT？
  - 前端门禁只能改善体验，不能保证接口安全。
  - 后端要用 Clerk PEM 公钥验 `__opencreator_jwt`。
  - 验签后取 JWT 的 `sub` 作为当前 `user_id`。
  - 读取项目、结果、创建 run 都要按这个 `user_id` 做权限过滤。

- `Protected` 和 `RequireAuth` 是什么关系？
  - `Protected` 是路由层包装组件。
  - 它本身不写认证逻辑，只返回 `<RequireAuth>{children}</RequireAuth>`。
  - 真正读 Clerk 状态的是 `RequireAuth`。

- Clerk 还没加载时为什么不能直接弹登录框？
  - `isLoaded = false` 时还不知道当前用户到底有没有登录。
  - 这时应该显示 loading。
  - 等 Clerk 加载完成后，再根据 `isSignedIn` 判断是否弹登录框。

- 未登录访问 `/canvas/xxx` 应该发生什么？
  - 路由匹配到 `/canvas/$flowId`。
  - `Protected` 进入 `RequireAuth`。
  - `RequireAuth` 发现 `isLoaded && !isSignedIn`。
  - 打开全局登录弹窗。
  - 返回 `null`，不渲染 `CanvasEditorContent`。

- 登录成功后为什么要回到原画布页？
  - 用户的意图是编辑当前 `flowId`。
  - 登录只是补齐身份态，不应该丢失原页面上下文。
  - 全局登录弹窗完成后，原路由继续渲染，项目加载链路继续往下走。

## 编辑页和分享页

- 编辑画布和分享画布为什么不是同一套权限？
  - 编辑页 `/canvas/{flowId}` 默认是登录后编辑自己的项目。
  - 分享页 `/canvas/view/{flowId}?shareid=...` 依赖 `shareid` 和服务端分享配置。
  - 分享页可能公开，也可能服务端返回 `need_auth` 要求登录。
  - 分享页还可能按非 owner 进入 readonly。

- 分享页的 `need_auth` 是什么意思？
  - 它表示这条分享需要登录后才能看。
  - 前端先请求分享信息，看到 `need_auth = true` 后再打开登录弹窗。
  - 它不是编辑页的固定门禁。

- 为什么带 `shareid` 的编辑路由要重定向到分享页？
  - 编辑页和分享页权限模型不同。
  - `shareid` 表示按分享权限查看，不应该混在编辑页里处理。
  - 重定向到 `/canvas/view/{flowId}` 可以避免逻辑串线。

- 分享页为什么不默认挂 `WorkflowRuntimeProvider`？
  - 分享页多数场景是只读查看。
  - 可编辑运行态包含 Run、Stop、节点状态变更和 WebSocket 事件处理。
  - 非 owner 或只读分享不应该拥有同一套编辑运行能力。

## 项目读取

- 打开编辑画布时请求哪个接口？
  - 请求 `GET /api/v2/flow/project/{flowId}`。
  - 这是读取 flow project，不是创建 run。
  - 请求必须带 `Authorization: Bearer <__opencreator_jwt>`。

- 后端怎么知道当前用户是谁？
  - Publisher 的认证中间件读取 `Authorization`。
  - 用 Clerk PEM 公钥验 JWT。
  - 从 payload 的 `sub` 取当前用户 id。
  - `get_authenticated_user()` 再把这个用户交给 controller。

- 为什么读取项目时不能只按 `flow_id` 查？
  - 只按 `flow_id` 查会有越权风险。
  - 后端必须按 `flow_id + user_id` 查询。
  - 这样即使用户猜到别人的 `flow_id`，也不能读出项目。

- 如果 `flow_id` 不存在和 `flow_id` 不属于当前用户，应该怎么处理？
  - 都不能返回别人的项目信息。
  - 可以按 not found 或无权限处理。
  - 关键是不泄露“这个项目是否属于别人”的细节。

- `GET /api/v2/flow/project/{flowId}` 返回哪些关键字段？
  - `flow_id`：项目 id。
  - `nodes`：React Flow 节点。
  - `edges`：React Flow 边。
  - `details.project_name`：项目标题。
  - `details.snapshot`：截图信息，可为空。
  - `details.app_mode_config`：App 模式配置，可为空。
  - `allow_reshare`：是否允许再分享。
  - `parent_flow_id`：父项目或模板来源。
  - `created_at`、`updated_at`、`last_view_time`：时间信息。

- 为什么项目响应里不要塞运行状态？
  - 项目响应表示画布定义。
  - 运行状态属于 workflow run。
  - 历史产物属于 node result。
  - 混在一起会导致刷新、恢复、权限和缓存都变复杂。

- `last_view_time` 有什么用？
  - 它记录最近查看时间。
  - 打开项目时后端可以更新它。
  - 它属于项目元信息，不参与执行。

## 画布 store 初始化

- `CanvasEditorContent` 负责什么？
  - 它是编辑画布加载入口。
  - 负责挂 `ReactFlowProvider`、`CanvasProvider`、`NodeResultsProvider` 等上下文。
  - 调用项目加载 hook。
  - 等项目和初始结果准备好后渲染 `AgentCanvasLayout`。

- `useOneFlow` / `useWorkflowProject` 负责什么？
  - 清理上一个 workflow 的状态。
  - 等登录态准备好后读取服务端项目。
  - 读取本地 IndexedDB 草稿。
  - 必要时用本地 pending / failed 草稿覆盖服务端数据。
  - 格式化节点并兼容旧数据。
  - 把 nodes / edges 写入画布 store。
  - 设置项目名、选中的 workflow id 和 ready 状态。

- 为什么进入新画布前要清理旧 store？
  - 防止上一个项目的 nodes、edges、结果、socket 映射或运行态残留。
  - 否则可能出现打开 A 项目还能看到 B 项目节点或状态的问题。

- 为什么要等 `isLoaded && isSignedIn` 后才读取项目？
  - 项目接口需要业务 JWT。
  - Clerk 没加载完时不能稳定获取 token。
  - 未登录时也不应该发受保护请求。

- 为什么要合并 IndexedDB 本地草稿？
  - 自动保存失败、离线编辑或刷新时，用户本地可能有比服务端更新的改动。
  - 本地草稿能帮助恢复未同步的 nodes / edges。
  - 但必须严格判断版本，不能无脑覆盖服务端。

- 本地草稿什么时候可以覆盖服务端项目？
  - 本地记录存在。
  - 本地状态是 `pending` 或 `failed`。
  - 本地曾经同步过服务端版本。
  - 本地记录的 `server_updated_at` 等于服务端 `updated_at`。
  - 本地 `nodes` 不为空。

- 为什么不能无脑用本地草稿覆盖服务端？
  - 旧草稿可能已经过期。
  - 用户可能在另一端更新了项目。
  - 新建空项目也可能被错误套上旧草稿。
  - 版本判断是为了避免数据回退。

- `isWorkflowReady` 表示什么？
  - 表示当前项目数据已经写入画布 store，可以开始渲染编辑画布。
  - 它不表示模型执行完成。
  - 它也不表示历史结果已经全部补拉完成。

## 画布样式

- 为什么项目加载成功后页面还是可能不像画布？
  - nodes / edges 只是数据。
  - React Flow 基础 CSS、容器高度、背景、控制层、节点层级、Toolbar/Panel 样式都要接上。
  - 少了这些，页面可能只有裸 HTML 或布局错乱。

- 为什么必须引入 `@xyflow/react/dist/style.css`？
  - React Flow 的节点、边、背景、选择层和控制层依赖基础样式。
  - 不引入时节点和连线可能显示异常。
  - 这不是可选美化，而是画布基础能力。

- `Canvas.tsx`、`Flow.tsx`、`flow-utils.ts` 分别做什么？
  - `Canvas.tsx` 负责画布根容器和布局层级。
  - `Flow.tsx` 负责渲染 ReactFlow、注册 class 和基础样式。
  - `flow-utils.ts` 负责统一计算画布背景、尺寸、预览态和性能态样式。

- 为什么样式入口不应该写在项目加载 hook 里？
  - 项目加载 hook 只负责数据。
  - 样式属于画布渲染层。
  - 把样式和数据请求混在一起，会让职责不清晰。

- `preview-mode` 和 `canvas-performance-mode` 有什么用？
  - 它们是预览态和大图性能优化的样式入口。
  - 后续只读预览、缩放、性能降级都可能依赖这些 class。
  - 迁移时保留入口可以避免后面返工。

## 历史结果补拉

- 打开画布后为什么还要请求 `all_batch_fetch`？
  - flow project 只包含项目定义。
  - 节点已有产物放在结果服务里。
  - 需要批量补拉，才能让节点显示历史结果。

- `POST /api/v3/result/all_batch_fetch` 是做什么的？
  - 批量读取当前项目里多个节点的最新结果。
  - 请求体带 `workflow_id` 和 `node_ids`。
  - 分享场景可以带 `share_id`。

- `all_batch_fetch` 会不会触发模型执行？
  - 不会。
  - 它只是读已有结果快照。
  - 模型执行只能由 workflow run 链路触发。

- `all_batch_fetch` 返回空数组是不是错误？
  - 不是。
  - 没有历史结果时返回空数组是正常情况。
  - 不能把空结果当成节点运行失败。

- 为什么结果接口也要按当前用户过滤？
  - 节点结果属于用户项目数据。
  - 后端不能相信前端传的 `workflow_id` 就直接返回。
  - 需要把 JWT 验签后的 `user_id` 写入请求上下文，再按用户查询。

- 为什么结果接口用 `workflow_id` 而项目接口用 `flow_id`？
  - 这里的 `workflow_id` 实际上指当前项目 id。
  - 它和 `flow_id` 在这条链路里语义接近。
  - 但不要把它和 `flow_task_id` 或 `flow_run_id` 混淆。

## Run 和 WebSocket

- 点击 Run 时调用哪个接口？
  - 调用 `POST /api/v2/flow/runs`。
  - 这是创建 workflow run。
  - 成功时返回 `202 Accepted`。

- 为什么创建 run 返回 `202` 而不是 `200`？
  - `202 Accepted` 表示服务端接受了执行命令。
  - 执行是异步的，节点还没有完成。
  - 后续状态要通过查询和 WebSocket 事件推进。

- `CreateWorkflowRunRequest` 里为什么需要 `client_request_id`？
  - 它用于前端命令幂等。
  - 网络重试时可以避免重复创建同一条运行命令。
  - 后端可以根据它判断是否幂等重放。

- `flow_task` 里放什么？
  - 放当前要执行的图。
  - 通常包含 nodes、edges 和运行所需配置。
  - 它是这次运行的快照，不等同于服务端项目永久定义。

- 为什么 WebSocket 不是打开画布就连接？
  - 打开画布时还没有 `flow_task_id`。
  - WebSocket 是某次 run 的事件通道。
  - 必须先创建 run，再用返回的 `flow_task_id` 建连。

- WebSocket 连接地址是什么？
  - `WS /api/v2/flow/runs/{flow_task_id}/events/{connection_id}`。
  - `flow_task_id` 来自创建 run 的响应。
  - `connection_id` 是每次物理连接生成的 id。

- WebSocket 第一条消息为什么必须是 auth？
  - 事件流也有权限边界。
  - 服务端需要先验 JWT，确认当前用户有权监听这个 run。
  - 第一条不是 auth 时应该返回错误并关闭连接。

- WebSocket 认证消息长什么样？
  - 形状是：

```json
{
  "event_type": "auth",
  "protocol_version": 2,
  "token": "<__opencreator_jwt>"
}
```

- 认证后为什么还要 attach？
  - auth 只证明当前连接是谁。
  - attach 才说明要订阅哪个 `flow_task_id`，以及从哪个 cursor 开始补事件。
  - 这样同一套连接协议可以支持恢复。

- attach 消息里 `last_event_cursor` 是什么？
  - 它表示客户端已经处理到哪个事件。
  - 初次连接可以是 `null`。
  - 断线重连时带上本地保存的 cursor，服务端从 cursor 后继续 replay。

- 常见 run 事件有哪些？
  - `resume_ready`：恢复准备完成。
  - `resume_error`：恢复失败。
  - `flow_snapshot`：运行快照。
  - `start_flow`：开始运行。
  - `node_status`：节点状态变化。
  - `workflow_error`：工作流错误。
  - `flow_killed`：运行被停止。
  - `pong`：心跳响应。

## 刷新恢复和取消

- 刷新页面后 run 为什么可能还在跑？
  - run 在后端执行。
  - 刷新只会断开浏览器里的物理 WebSocket。
  - 它不会自动取消后端任务。

- 刷新后怎么恢复运行状态？
  - 重新进入 `/canvas/{flowId}`。
  - 重新读取 flow project。
  - 调 `GET /api/v2/flow/runs?flow_id=...&status=active` 查询 active run。
  - 用保存的 `last_event_cursor` 重新 attach WebSocket。
  - 服务端 replay 断线期间的事件。

- 关闭 WebSocket 等不等于停止任务？
  - 不等于。
  - WebSocket 只是事件通道。
  - 停止任务必须调用 cancel 接口。

- 停止运行调用哪个接口？
  - 调用 `POST /api/v2/flow/runs/{flow_task_id}/cancel`。
  - 请求体里带 `command_id`。
  - 成功后返回 `202 Accepted` 和 run 响应。

- 为什么要把 run 和物理 WebSocket 解耦？
  - 网络断开、页面刷新、浏览器休眠都可能让 WebSocket 断掉。
  - 但用户不一定想取消任务。
  - run 独立存在，连接只负责订阅事件，系统才能恢复。

- active run 查询有什么用？
  - 用于刷新后发现当前项目还有哪些运行中的任务。
  - 前端可以根据 active run 恢复运行态。
  - 再通过 WebSocket cursor 补齐事件。

## 安全边界

- 画布加载链路里哪些接口必须带 JWT？
  - `GET /api/v2/flow/project/{flowId}`。
  - `POST /api/v3/result/all_batch_fetch`。
  - `POST /api/v2/flow/runs`。
  - `POST /api/v2/flow/runs/{flow_task_id}/continue`。
  - `POST /api/v2/flow/runs/{flow_task_id}/cancel`。
  - `GET /api/v2/flow/runs` 和 `GET /api/v2/flow/runs/{flow_task_id}`。
  - WebSocket 首包 auth 也要带 JWT。

- 为什么不能让前端传 `user_id`？
  - 前端传的 `user_id` 可以被伪造。
  - 后端应该只信 JWT 验签后的 `sub`。
  - 项目、结果、run 都按这个 `user_id` 做权限判断。

- 如果 WebSocket token 过期怎么办？
  - 服务端认证失败，返回错误并关闭连接。
  - 前端应该重新获取 Clerk JWT，再重新连接。
  - 不能在未认证状态下继续接收事件。

- run 不属于当前用户时 WebSocket 应该怎样？
  - 认证可以通过，但 attach 或 run 校验应该失败。
  - 服务端返回类似 `RUN_NOT_FOUND`，并关闭连接。
  - 不能暴露别人的 run 事件。

## NovelComic 迁移

- NovelComic 迁移第 2 章前需要先有什么？
  - Clerk Session 能激活。
  - 前端能通过 `getToken({ template: "__opencreator_jwt" })` 取业务 JWT。
  - Publisher 能验 JWT，并把当前用户放到 `request.user`。
  - API client 能给受保护接口带 Authorization。

- 为什么不能从 WebSocket 开始迁移？
  - WebSocket 依赖已创建的 workflow run。
  - workflow run 又依赖项目数据、当前用户和运行态。
  - 如果项目都还没稳定加载，先做 WebSocket 只会让问题更难排。

- 推荐的迁移顺序是什么？
  - 先做 `RequireAuth` 和 `/canvas/$flowId`。
  - 再做项目读取 API 和后端 `workflow_project.py`。
  - 再做 `CanvasEditorContent` 和 `useWorkflowProject`，把 nodes / edges 写入 store。
  - 再接 React Flow 样式和完整画布组件。
  - 再接历史结果补拉。
  - 再接 `WorkflowRuntimeProvider`、run REST 接口和可恢复 WebSocket。
  - 最后接分享页。

- 怎么判断项目加载阶段完成了？
  - 未登录访问画布会弹登录框。
  - 登录后访问别人的 `flowId` 看不到项目。
  - 登录后访问自己的 `flowId` 能看到 nodes / edges。
  - 刷新后仍能恢复同一张图。
  - 画布基础样式、节点、边、背景和 Toolbar 正常。

- 怎么判断历史结果阶段完成了？
  - 有历史结果的节点刷新后能回填产物。
  - 没历史结果的节点返回空数组，不报错。
  - 结果查询按当前用户过滤，不能读取别人项目的结果。

- 怎么判断运行态阶段完成了？
  - 点击 Run 返回 `202`、`flow_task_id`、`flow_run_id`。
  - 前端进入 active run。
  - WebSocket 首包认证，认证成功后 attach。
  - 节点状态能被事件推进。
  - Stop 能取消 active run。
  - 刷新后能查询 active run，并按 cursor 补事件。

- 如果画布打开后 `all_batch_fetch` 返回空，应该排查什么？
  - 先确认这是不是正常的无历史结果。
  - 再确认 `workflow_id` 和 `node_ids` 是否正确。
  - 再确认 JWT 是否有效，后端是否按当前用户查询。
  - 不要直接当成模型执行失败。

- 如果 `/canvas/{flowId}` 一直弹登录框，可能是什么问题？
  - Clerk 还没加载完成。
  - Clerk Session 没有激活。
  - 全局登录弹窗登录后没有正确回到当前页面。
  - Provider 层级错误，`RequireAuth` 拿不到 Clerk 上下文。

- 如果项目接口 401，可能是什么问题？
  - 前端没有带 `Authorization`。
  - `getToken({ template: "__opencreator_jwt" })` 没拿到 token。
  - Clerk JWT Template 名字不对。
  - 后端 PEM public key 和前端 Clerk 应用不属于同一套配置。

- 如果项目接口 404，但 JWT 正常，可能是什么问题？
  - `flow_id` 不存在。
  - 项目不属于当前用户。
  - 后端查询条件没有正确保存或匹配 `user_id`。
  - 项目数据还没从 OpenCreator 迁过来。

- 如果节点和边数据返回了，但页面空白，可能是什么问题？
  - 画布 store 没有正确 `setNodes()` / `setEdges()`。
  - `isWorkflowReady` 没有置为 true。
  - React Flow 容器没有高度。
  - 没有引入 `@xyflow/react/dist/style.css`。
  - 节点类型组件没有注册或样式缺失。

- 如果刷新后丢失本地编辑，可能是什么问题？
  - IndexedDB 草稿没有保存。
  - `useWorkflowProject` 没有读取本地草稿。
  - 本地草稿状态不是 `pending` 或 `failed`。
  - 本地 `server_updated_at` 和服务端 `updated_at` 不匹配，所以没有覆盖。

- 如果刷新后运行状态丢失，可能是什么问题？
  - 没有查询 active runs。
  - 没有保存或传递 `last_event_cursor`。
  - WebSocket 重连后没有发送 attach。
  - 后端没有事件存储或 cursor replay。

## 面试短答

- 一句话讲画布登录门禁与项目加载？
  - `/canvas/{flowId}` 先过 `RequireAuth`，未登录弹全局登录框；登录后前端带 `__opencreator_jwt` 请求 Publisher，后端按 JWT 的 `sub` 和 `flow_id` 读取 flow project；前端把 nodes / edges 写入画布 store，再补拉历史 node result；只有点击 Run 后才创建 workflow run 并连接可恢复 WebSocket。

- 一句话讲为什么 WebSocket 不属于项目加载？
  - 项目加载读取的是图定义和历史结果，WebSocket 订阅的是某一次 run 的实时事件，没有 `flow_task_id` 时根本没有可连接的运行实例。

- 一句话讲安全边界？
  - 前端 `RequireAuth` 是体验层，真正安全边界是 Publisher 验 Bearer JWT，并且所有项目、结果和 run 查询都按验签后的 `user_id` 过滤。

- 一句话讲刷新恢复？
  - 刷新只断开物理 WebSocket，不取消后端 run；页面恢复时重新查 active run，再用 cursor attach WebSocket 回放断线期间的事件。

- 一句话讲 NovelComic 迁移顺序？
  - 先保证登录与 JWT，再接 `/canvas/$flowId` 门禁和项目读取，再落画布 store 与样式，再补历史结果，最后接 run、WebSocket 恢复和分享页。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 已经有 `/canvas/$flowId` 编辑路由。
  - 路由层用 `Protected` 包住画布入口。
  - `Protected` 进入 `RequireAuth`，未登录不渲染画布内容。
  - 登录后通过 `fetchFlowView(flowId)` 请求 Publisher 的项目接口。
  - Publisher 通过 JWT 得到当前 `user_id`，并按 `flow_id + user_id` 读取项目。
  - 画布入口拿到项目后渲染 `AgentCanvasLayout`，并可补拉历史节点结果。

- 当前实现能不能算本章主链路打通？
  - 可以算主链路打通。
  - 因为登录门禁、项目读取、用户隔离、画布入口和历史结果补拉入口都已经存在。
  - 但这不等于 OpenCreator 完整编辑画布能力全部迁完。

- 当前测试覆盖了哪些本章风险？
  - 覆盖了 `RequireAuth` 的三种状态。
  - 覆盖了 `/canvas/$flowId` 路由会包 `Protected`，并传递 `flowId`。
  - 覆盖了前端 flow API 带 Authorization 请求项目和 run 接口。
  - 覆盖了 Publisher 创建 flow project。
  - 覆盖了 Publisher 读取项目时的用户隔离。

- 为什么说当前还不是完整 OpenCreator 编辑画布？
  - `useWorkflowProject` 还没有完整实现 IndexedDB 本地草稿合并。
  - 还没有完整的旧节点类型、旧模型名和历史项目兼容逻辑。
  - React Flow 编辑器能力是轻量骨架，不是完整 OpenCreator 画布。
  - 可恢复 WebSocket、cursor replay 和 active run 恢复还需要继续补。
  - 分享页权限模型也不属于当前主骨架。

- 当前读取 flow project 的安全边界是什么？
  - 安全边界在 Publisher。
  - 前端 `RequireAuth` 只控制页面体验。
  - Publisher 读取 `Authorization: Bearer <__opencreator_jwt>`。
  - 验签后用 JWT `sub` 得到 `user_id`。
  - 查询必须同时使用 `flow_id` 和 `user_id`。

- 如果登录后项目接口返回 404，当前应该怎么理解？
  - 可能是 `flow_id` 不存在。
  - 也可能是这个项目不属于当前用户。
  - 这两种情况都不应该泄露别人项目细节。

- 当前项目读取返回里的 `user_id` 应该怎么处理？
  - 数据库查询按 `user_id` 做权限过滤。
  - 返回给前端时不应该依赖前端展示或信任 `user_id`。
  - 测试只需要确认不会泄露真实 owner 或造成越权。

- 什么时候才算本章完整验收？
  - 未登录访问 `/canvas/{flowId}` 会打开登录弹窗。
  - 登录用户只能读取自己的项目。
  - 项目 nodes / edges 能稳定进入画布状态。
  - 刷新页面不会残留上一个项目的状态。
  - 历史 node result 能补拉，空结果不当作运行失败。
  - 点击 Run 才创建 workflow run。
  - WebSocket 只绑定具体 `flow_task_id`，刷新后能按 cursor 恢复事件。
