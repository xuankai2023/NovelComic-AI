# OpenCreator 是怎么做前端应用壳、首页与 Composer 的

## 一、先说结论

OpenCreator 的首页不是“输入 prompt 后直接调用模型”。首页负责准备首轮 Agent 输入和创建画布容器，真正的 Agent 消息发送发生在跳转到画布之后。

完整链路是：

```text
用户进入 /
  → routes/index.tsx
  → HomeShell / HomeLayout
  → Home
  → HomeHeroComposerV4
  → 用户输入文本、mention、附件、槽位、Hook/Skill、模型
  → 附件先上传到 COS，拿到 remoteUrl
  → 语义槽位附件可选写入个人素材库
  → 点击发送时校验登录、上传状态和输入有效性
  → POST /api/v2/flow/project 创建空 flow project
  → saveHomeAgentHandoff()
  → navigate /canvas/{flowId}
  → 画布按第 02 章加载 flow project
  → AssistantProvider 读取当前 flowId 的 handoff
  → sendMessage(source: "home_handoff")
  → accepted 后 acknowledgeHomeAgentHandoff()
```

所以必须区分五件事：

- 应用壳：`/` 只渲染首页壳和首页内容。
- Composer 输入：收集用户首轮意图和上下文。
- 附件准备：浏览器 `File` 必须先变成远端 URL。
- flow 创建：首页只创建空项目容器。
- Agent 首轮消息：画布侧消费 handoff 后发送。

---

## 二、前端必须有的文件

按用户从首页进入到画布消费的顺序背。第 9 步只是创建空 flow，第 14 步之后才是 Agent 收到首页首轮输入。

1. `src/routes/index.tsx`：匹配 `/`，用 `HomeShell` 包住 `Home`。
2. `src/routes/-components.tsx`：提供 `HomeShell`、`Protected` 和 WebSocket preconnect 工具。
3. `src/layouts/home-layout.tsx`：首页视觉外壳。
4. `src/lib/home-composer-draft.ts`：首页文本和富文本内存草稿。
5. `src/components/home/home-page/index.tsx`：首页状态、上传、发送和跳转收口。
6. `src/components/home/home-page/items/home-hero-composer-v4.tsx`：Composer UI。
7. `src/api/modules/aws.ts`：COS 预签名上传客户端。
8. `src/api/modules/assets.ts`：个人素材库客户端。
9. `src/api/modules/flow.ts`：`POST /api/v2/flow/project`。
10. `src/features/canvas-workflow/hooks/flow/use-create-new-flow.ts`：创建 flow hook。
11. `src/lib/home-agent-handoff.ts`：首页到画布的 `sessionStorage` 交接。
12. `src/routes/canvas.$flowId.tsx`：跳转后的画布路由。
13. `src/components/canvas-editor-content/canvasEditorContent.tsx`：画布项目加载入口。
14. `src/features/agent-chat/runtime/assistant-provider.tsx`：消费 handoff，发送首轮 Agent message。

### `src/routes/index.tsx`

OpenCreator 源码：[index.tsx](../../../../../opencreate/opencreator-frontend/src/routes/index.tsx)

负责首页路由：

```text
/
```

主要动作：

- `createFileRoute('/')` 注册根路由。
- 渲染 `IndexRoute`。
- `IndexRoute` 返回 `<HomeShell><Home /></HomeShell>`。

这层不读取登录态，不上传文件，不创建 flow。

### `src/routes/-components.tsx`

OpenCreator 源码：[-components.tsx](../../../../../opencreate/opencreator-frontend/src/routes/-components.tsx)

通用路由组件：

- `SuspenseRoute()`：统一 Suspense fallback。
- `HomeShell()`：返回 `<HomeLayout>{children}</HomeLayout>`。
- `Protected()`：返回 `<RequireAuth>{children}</RequireAuth>`。
- `getWsPreconnectOrigin()`：把 WebSocket 地址转成 HTTP origin。

首页用 `HomeShell`；画布编辑页才用 `Protected`。不要把首页写成必须登录后才能看到。

### `src/layouts/home-layout.tsx`

OpenCreator 源码：[home-layout.tsx](../../../../../opencreate/opencreator-frontend/src/layouts/home-layout.tsx)

它只负责首页视觉外壳。业务发送逻辑不应该散在 layout 里。

### `src/lib/home-composer-draft.ts`

OpenCreator 源码：[home-composer-draft.ts](../../../../../opencreate/opencreator-frontend/src/lib/home-composer-draft.ts)

首页草稿只有模块内存：

```text
getHomeComposerDraft()
setHomeComposerDraft()
clearHomeComposerDraft()
```

字段：

```text
text
richTextHtml
```

刷新页面后不会恢复。不要写成和画布本地草稿一样的持久化策略。

### `src/components/home/home-page/index.tsx`

OpenCreator 源码：[home-page/index.tsx](../../../../../opencreate/opencreator-frontend/src/components/home/home-page/index.tsx)

这是首页业务状态收口。它读：

- `useUser()`：知道当前是否登录。
- `useAuthModalStore()`：未登录时打开登录弹窗。
- `useCreateNewFlow()`：创建空 flow。
- `useAwsApi()`：上传附件。
- `useAssetsApi()`：素材库入库。
- `useAgentModelSelection()`：模型选择。

关键状态：

- `composerText`
- `composerRichTextHtml`
- `composerAttachments`
- `homeHookPayload`
- `homeSlotAttachments`
- `hasUploadingSlots`
- `createLoading`
- `selectedAgentModelId`

它负责完整发送链路：

```text
输入变化
  → 更新内存草稿
附件选择
  → 上传 COS
语义槽位附件
  → 可选入库
点击发送
  → 校验登录和上传状态
  → 创建 flow
  → 写 handoff
  → 清草稿
  → 跳转画布
```

### `src/components/home/home-page/items/home-hero-composer-v4.tsx`

OpenCreator 源码：[home-hero-composer-v4.tsx](../../../../../opencreate/opencreator-frontend/src/components/home/home-page/items/home-hero-composer-v4.tsx)

这是 UI 组合层。它自己不创建 flow，也不直接写 handoff。它通过 props 把事件交给 `Home`：

- `onChange`
- `onRichTextHtmlChange`
- `onSend`
- `onAttachFiles`
- `onAddRemoteAttachments`
- `onRemoveAttachment`
- `onRetryLibrarySave`
- `onHookPayloadChange`
- `onSlotAttachmentsChange`
- `onSlotUploadingChange`
- `onAgentModelSelect`

内部组合：

- `HomeComposerMentionInput`
- `ComposerSlotCard`
- `ComposerToolbar`
- `ComposerContentTypeBar`
- `ProductControlModal`
- `AssetLibraryPickerModal`

Composer 里出现的 mention、槽位、控制图、Hook/Skill，都只是输入结构，不是已经运行的工作流。

### `src/api/modules/aws.ts`

OpenCreator 源码：[aws.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/aws.ts)

普通附件上传：

```text
postUploadFile(file)
  → maybeCompressUploadImage(file)
  → getPresignedUrl(uploadFile.name, uploadFile.type)
  → POST /api/v2/cos/presign
  → uploadToS3Reliable(presigned_url)
  → normalizeCdnResourceUrl(cdn_url)
```

返回值是 CDN URL。后续 handoff 附件使用这个 URL，不携带浏览器 `File`。

### `src/api/modules/assets.ts`

OpenCreator 源码：[assets.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/assets.ts)

个人素材库接口：

```text
createLibraryAsset()
  → POST /api/v3/assets/library
```

只有角色、产品、品牌视觉这类语义槽位附件才应该走入库。普通文件上传只作为本次 Agent 输入。

### `src/api/modules/flow.ts`

OpenCreator 源码：[flow.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/flow.ts)

首页创建项目用：

```text
postSaveFlow()
  → POST /api/v2/flow/project
```

同一份 `flow.ts` 还封装项目读取、更新、workflow run 创建/继续/取消和 active run 查询。但首页发送只需要 `postSaveFlow()`。

### `src/features/canvas-workflow/hooks/flow/use-create-new-flow.ts`

OpenCreator 源码：[use-create-new-flow.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-create-new-flow.ts)

`handleCreateNewFlow()` 默认保存：

```text
project_name: "Untitled"
nodes: []
edges: []
```

成功后做这些：

- 把 flow detail 写入 React Query cache。
- `markFreshFlow(savedFlowId)`。
- `markFreshAgentSession(savedFlowId)`。
- 回调 `onSuccess(savedFlowId, res)`。
- 异步刷新项目列表和最近项目。

这就是首页能跳进一张新画布的前提。

### `src/lib/home-agent-handoff.ts`

OpenCreator 源码：[home-agent-handoff.ts](../../../../../opencreate/opencreator-frontend/src/lib/home-agent-handoff.ts)

首轮输入 handoff 的 key：

```text
opencreator:home-agent-handoff
```

payload：

```text
flowId
text
attachments
agentModelId
hook
richTextHtml
analyticsContext
createdAt
```

核心函数：

- `saveHomeAgentHandoff()`：写入并补 `createdAt`。
- `peekHomeAgentHandoff(flowId)`：只在 `payload.flowId === flowId` 时返回。
- `acknowledgeHomeAgentHandoff(flowId, createdAt)`：确认消费并删除。
- `consumeHomeAgentHandoff(flowId)`：读取后立即确认删除。
- `shouldRetryHomeAgentHandoff(status, attempts, maxAttempts = 2)`：控制重试。

首页首轮消息 handoff 和首页附件 handoff 是两个 key，不要混用。

### `src/features/agent-chat/runtime/assistant-provider.tsx`

OpenCreator 源码：[assistant-provider.tsx](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/assistant-provider.tsx)

画布侧消费首页 handoff：

```text
peekHomeAgentHandoff(flowId)
  → normalizeAgentModelId()
  → setSelectedAgentModelId()
  → pendingFilesRef.current = attachments
  → pendingHookConfigRef.current = hook
  → pendingRichTextHtmlRef.current = richTextHtml
  → sendMessage({ text }, { source: "home_handoff" })
  → accepted 后 acknowledgeHomeAgentHandoff(flowId, createdAt)
```

它会避开这些状态：

- Agent 模型权限仍在 loading。
- 当前 chat 正在运行。
- 消息历史还在加载。
- 同一 handoff 已经在尝试发送。
- 同一 handoff 已经尝试 2 次。

---

## 三、Publisher 必须有的文件

首页链路至少经过这些后端文件。

1. `controller/routers.py`：挂载 flow、cos、assets 路由。
2. `controller/v2/cos.py`：生成 COS 预签名上传地址。
3. `controller/v3/assets.py`：创建个人素材库记录。
4. `controller/v2/workflow_project.py`：创建空 flow project。
5. `services/flow.py`：保存 flow project。
6. `services/assets.py`：保存个人素材库条目。
7. `utils/cos.py`：生成 object key、预签名地址和 CDN URL。

### `controller/routers.py`

OpenCreator 源码：[routers.py](../../../../../opencreate/opencreator-publisher/controller/routers.py)

相关挂载：

```text
v2 /flow  → workflow_project_router
v2 /cos   → cos_router_v2
v3 /assets → assets_router_v3
```

所以前端看到的是：

- `/api/v2/flow/project`
- `/api/v2/cos/presign`
- `/api/v3/assets/library`

### `controller/v2/cos.py`

OpenCreator 源码：[cos.py](../../../../../opencreate/opencreator-publisher/controller/v2/cos.py)

接口：

```text
POST /api/v2/cos/presign
```

返回：

- `presigned_url`
- `object_key`
- `cdn_url`
- `expires_in`

前端随后直接 PUT 到 `presigned_url`。

### `controller/v3/assets.py`

OpenCreator 源码：[assets.py](../../../../../opencreate/opencreator-publisher/controller/v3/assets.py)

接口：

```text
POST /api/v3/assets/library
```

服务端通过 `get_authenticated_user()` 取得用户，再调用 `AssetsService.create_uploaded_asset()`。因此素材库归属以后端当前用户为准，不信任前端自传用户。

### `controller/v2/workflow_project.py`

OpenCreator 源码：[workflow_project.py](../../../../../opencreate/opencreator-publisher/controller/v2/workflow_project.py)

首页创建空项目用：

```text
POST /api/v2/flow/project
  → get_authenticated_user()
  → FlowService.save_workflow_project(req, user_id)
```

返回 `WorkflowProjectResponse`，其中最关键的是 `flow_id`。

---

## 四、运行时链路

### 1. 打开首页

```text
用户进入 /
  → routes/index.tsx
  → HomeShell
  → HomeLayout
  → Home
```

未登录也可以看到首页。登录门禁在上传、发送、画布进入等动作里才触发。

### 2. 编辑 Composer

```text
Home
  → HomeHeroComposerV4
  → HomeComposerMentionInput
  → ComposerToolbar
  → SlotCard / ProductControlModal / AssetLibraryPickerModal
```

用户可以输入文本、富文本 mention、选择模型、选择 Hook/Skill、上传文件、选角色/产品/品牌视觉素材，或生成控制图。

文本变化会写入内存草稿。附件和槽位附件由 `Home` 统一管理。

### 3. 上传普通附件

```text
onAttachFiles(files)
  → postUploadFile(file)
  → POST /api/v2/cos/presign
  → PUT presigned_url
  → attachment.remoteUrl = cdn_url
```

上传中设置 `isUploading`，失败设置 `hasError`。`hasError` 会阻止发送，因为用户输入的 mention 可能还指向这个附件。

### 4. 语义槽位附件入库

如果附件属于角色、产品、品牌视觉槽位：

```text
createLibraryAsset()
  → POST /api/v3/assets/library
```

入库成功后素材库列表缓存需要失效刷新。入库失败只标记 `librarySaveFailed` 并提示，已上传附件仍可发送。

### 5. 点击发送

`handleSend()` 先整理：

```text
submittedAgentModelId
isSkillOnly
outboundText
composerAssetSummary
readyHandoffAttachments
```

然后校验：

- 未登录：打开登录弹窗，登录后回调 `handleSend()`。
- `createLoading`：停止。
- 附件或槽位仍在上传：停止。
- 存在 `hasError` 附件：提示并停止。
- 模型权限 loading 或输入为空：按钮本身禁用。

Skill-only 时，OpenCreator 用零宽文本作为 `outboundText`，并构造 Skill mention 的富文本。

### 6. 创建空 flow

```text
handleCreateNewFlow()
  → postSaveFlow()
  → POST /api/v2/flow/project
```

成功后得到 `savedFlowId`。这一步只是创建项目容器。

失败语义：

- `onFailure(errorText)`：展示后端返回文案，恢复 `createLoading`。
- `onError()`：展示创建失败 toast，恢复 `createLoading`。

### 7. 写 handoff 并跳转

创建成功后：

```text
saveHomeAgentHandoff({
  flowId: savedFlowId,
  text: outboundText,
  attachments: readyHandoffAttachments,
  agentModelId: submittedAgentModelId,
  hook: homeHookPayload,
  richTextHtml,
  analyticsContext
})

clearHomeComposerDraft()
navigate("/canvas/{savedFlowId}")
```

这一步仍然没有直接调用 Agent。它只是把 Agent 首轮输入放到当前浏览器会话里，等画布侧取。

### 8. 画布加载项目

跳转后进入第 02 章链路：

```text
/canvas/{flowId}
  → RequireAuth
  → CanvasEditorContent
  → useOneFlow / useWorkflowProject
  → GET /api/v2/flow/project/{flowId}
```

画布项目加载出来后，Agent Provider 才有当前 `flowId` 上下文。

### 9. AssistantProvider 消费 handoff

```text
AssistantProvider
  → peekHomeAgentHandoff(flowId)
  → pendingFilesRef.current = attachments
  → pendingHookConfigRef.current = hook
  → pendingRichTextHtmlRef.current = richTextHtml
  → sendMessage({ text }, { source: "home_handoff" })
```

如果 `sendMessage` 返回 `accepted`，就确认删除 handoff。若是 `not_started` 且还有重试次数，等待后再试一次。

---

## 五、和 NovelComic 对照

NovelComic 迁移时不要从“首页生成节点”开始。OpenCreator 的边界是：

1. `/` 首页壳先稳定。
2. Composer 先完整收集输入。
3. 附件先上传并拿到远端 URL。
4. 语义槽位附件再可选入库。
5. 点击发送先创建空 flow project。
6. 首页只写 handoff 和跳转。
7. 画布侧按 `flowId` 消费 handoff，发首轮 Agent message。

如果只做到了 `/canvas/{flowId}` 跳转，还不能说首页 Composer 链路完成。必须验证 Agent 侧确实消费了当前 `flowId` 的 handoff，并在 accepted 后删除。
