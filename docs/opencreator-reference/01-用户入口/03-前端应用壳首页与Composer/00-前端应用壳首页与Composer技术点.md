# 前端应用壳、首页与 Composer：这里面有哪些技术点

先把这块拆开。它不是“用户在首页输入一句话就直接跑模型”，也不是“首页把节点塞进画布”。这篇只讲用户从首页进入产品、用 Composer 准备首轮 Agent 输入、创建空 flow project，再把输入交给画布侧消费的链路。

最短链路是：

```text
/
  → HomeShell / HomeLayout
  → Home
  → HomeHeroComposerV4
  → 登录检查
  → 附件先上传到 COS
  → 语义槽位附件可选写入个人素材库
  → POST /api/v2/flow/project 创建空 flow project
  → sessionStorage 写 home-agent-handoff
  → 跳转 /canvas/{flowId}
  → 画布加载 flow project
  → AssistantProvider 消费 handoff
  → sendMessage(source: "home_handoff")
```

所以首页可见、附件可用、flow 已创建、Agent 收到首轮消息，是四件事。不要把它们压成“首页发送后直接开始生成”。

OpenCreator 参考：

- 首页路由：[routes/index.tsx](../../../../../opencreate/opencreator-frontend/src/routes/index.tsx)
- 应用壳：[routes/-components.tsx](../../../../../opencreate/opencreator-frontend/src/routes/-components.tsx)
- 首页容器：[home-page/index.tsx](../../../../../opencreate/opencreator-frontend/src/components/home/home-page/index.tsx)
- Composer：[home-hero-composer-v4.tsx](../../../../../opencreate/opencreator-frontend/src/components/home/home-page/items/home-hero-composer-v4.tsx)
- 上传 API：[aws.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/aws.ts)
- 素材库 API：[assets.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/assets.ts)
- 创建 flow：[use-create-new-flow.ts](../../../../../opencreate/opencreator-frontend/src/features/canvas-workflow/hooks/flow/use-create-new-flow.ts)
- handoff：[home-agent-handoff.ts](../../../../../opencreate/opencreator-frontend/src/lib/home-agent-handoff.ts)
- 画布消费：[assistant-provider.tsx](../../../../../opencreate/opencreator-frontend/src/features/agent-chat/runtime/assistant-provider.tsx)
- 后端 COS：[controller/v2/cos.py](../../../../../opencreate/opencreator-publisher/controller/v2/cos.py)
- 后端素材库：[controller/v3/assets.py](../../../../../opencreate/opencreator-publisher/controller/v3/assets.py)
- 后端 flow project：[workflow_project.py](../../../../../opencreate/opencreator-publisher/controller/v2/workflow_project.py)

---

## 1. 首页壳只负责进入产品，不负责执行

现网首页是：

```text
/
```

`/home` 只是旧地址兼容，不是第二套首页。

`routes/index.tsx` 只做：

```text
createFileRoute("/")
  → <HomeShell>
      <Home />
    </HomeShell>
```

`HomeShell` 在 `routes/-components.tsx` 里，只把首页交给 `HomeLayout`。这个壳不读取项目、不上传附件、不创建 flow、不发 Agent 消息。

这和画布页不一样。画布页是受保护路由，要包 `Protected` / `RequireAuth`；首页可以先展示，点击发送或上传时再触发登录检查。

---

## 2. Composer 收集的是首轮 Agent 输入

首页核心容器是 `Home`，Composer UI 是 `HomeHeroComposerV4`。

`Home` 持有业务状态：

- `composerText`
- `composerRichTextHtml`
- `composerAttachments`
- `homeHookPayload`
- `homeSlotAttachments`
- `hasUploadingSlots`
- `createLoading`
- `selectedAgentModelId`

`HomeHeroComposerV4` 负责把 UI 事件抛给 `Home`：

- 文本输入
- 富文本 mention
- 普通文件附件
- 角色 / 产品 / 品牌视觉槽位
- 控制图 `control_reference`
- Hook / Skill 选择
- Agent 模型选择

这些数据只是首轮 Agent message 的输入上下文。Composer 不创建 flow，不直接调用 Agent，也不直接改画布节点。

---

## 3. 首页草稿不是持久化草稿

首页普通文本草稿在：

[home-composer-draft.ts](../../../../../opencreate/opencreator-frontend/src/lib/home-composer-draft.ts)

形状只有：

```text
text
richTextHtml
```

它是模块内存变量，不写 `localStorage`，不写 IndexedDB。刷新页面后草稿丢失是预期行为。

不要和第 02 章的画布 IndexedDB 草稿混淆。画布草稿是项目编辑状态恢复；首页草稿只是当前首页输入体验。

---

## 4. 附件必须先变成远端 URL

首页不能把浏览器 `File` 直接交给 Agent。普通附件先走 COS：

```text
postUploadFile(file)
  → maybeCompressUploadImage(file)
  → POST /api/v2/cos/presign
  → PUT presigned_url
  → remoteUrl = cdn_url
```

后端对应：

```text
controller/v2/cos.py
  → POST /presign
  → build_cos_object_key()
  → a_generate_cos_presigned_put_url()
  → get_cos_cdn_url()
```

前端附件状态必须区分：

- `isUploading`：上传中，不能发送。
- `hasError`：上传失败，不能发送。
- `remoteUrl`：可交给 Agent 的远端地址。
- `librarySaveFailed`：入库失败，但附件本身仍可发送。

OpenCreator 明确阻止上传失败附件发送，因为文本里的 mention 可能还引用这个文件。静默丢掉附件会让后端只收到一个无法解析的引用。

---

## 5. 素材库入库是附件上传之外的旁路

普通附件上传成功后就可以作为 Agent 输入。只有明确带语义槽位的图片或视频，才尝试写入个人素材库：

```text
character → character
product → product
style_reference → brand_visual
```

前端接口：

```text
createLibraryAsset()
  → POST /api/v3/assets/library
```

后端入口：

```text
controller/v3/assets.py
  → create_library_asset()
  → get_authenticated_user()
  → AssetsService.create_uploaded_asset()
```

入库失败不阻止发送。OpenCreator 会提示“附件仍可发送，但未保存到资产库；可点击附件重试”。这说明入库是资产管理旁路，不是 Agent 输入的必要条件。

---

## 6. 发送前要先判定输入是否真的可发

首页发送不是只看文本是否为空。OpenCreator 的发送条件同时看：

- 是否已登录；未登录先打开登录弹窗，登录后重试发送。
- 是否正在创建 flow。
- 是否有普通附件正在上传。
- 是否有槽位附件正在上传。
- 是否有上传失败的附件。
- Agent 模型权限是否还在 loading。
- 是否完全没有文本、Hook 和可发送附件。

Skill-only 场景是例外：用户只点了 Skill / Hook，没有普通文本时，OpenCreator 会用零宽文本作为 `outboundText`，让 Agent 仍能收到一次有效首轮消息；富文本里会构造 Skill mention。

这一步还没有创建 workflow run。

---

## 7. 首页发送先创建空 flow project

首页发送成功前必须先拿到画布容器：

```text
handleCreateNewFlow()
  → postSaveFlow()
  → POST /api/v2/flow/project
```

默认保存：

```text
project_name: "Untitled"
nodes: []
edges: []
```

后端入口：

```text
controller/v2/workflow_project.py
  → POST /project
  → get_authenticated_user()
  → FlowService.save_workflow_project()
```

创建成功后得到 `flowId`。这一步表示“有了一张空画布”，不表示模型开始执行，也不表示已经生成节点。

---

## 8. 首页到画布靠 sessionStorage handoff

拿到 `flowId` 后，首页写入：

```text
opencreator:home-agent-handoff
```

handoff 最小内容：

- `flowId`
- `text`
- `attachments`
- `agentModelId`
- `hook`
- `richTextHtml`
- `analyticsContext`
- `createdAt`

然后跳转：

```text
/canvas/{flowId}
```

`sessionStorage` handoff 是当前浏览器会话里的临时交接，不是后端任务队列。它不跨设备，不跨浏览器，也不保证服务端可靠投递。

---

## 9. handoff 消费必须防串流

画布侧在 `AssistantProvider` 里消费：

```text
peekHomeAgentHandoff(flowId)
  → 校验 payload.flowId
  → normalizeAgentModelId()
  → pendingFilesRef.current = attachments
  → pendingHookConfigRef.current = hook
  → pendingRichTextHtmlRef.current = richTextHtml
  → sendMessage(source: "home_handoff")
  → accepted 后 acknowledgeHomeAgentHandoff(flowId, createdAt)
```

关键点：

- 只消费当前 `flowId` 的 handoff。
- 删除时同时校验 `flowId` 和 `createdAt`。
- 同一 handoff 最多尝试 2 次。
- Agent 正在运行、模型权限 loading、消息历史未加载完时先不发。

这样可以避免首页创建 A 项目，但另一个画布 B 把 handoff 消费掉。

---

## 10. 不要混淆四类对象

| 名字 | 含义 |
| --- | --- |
| 首页 Composer 输入 | 文本、富文本 mention、附件、槽位、Hook/Skill、模型选择 |
| flow project | 画布项目容器，首页只创建空 `nodes` / `edges` |
| home-agent-handoff | 浏览器内临时交接数据，交给画布 Agent 消费 |
| workflow run | 画布里用户点击 Run 后创建的执行实例，不属于首页发送 |

首页链路结束于“画布 Agent 收到首轮消息”。第 02 章的画布项目读取、历史结果补拉、workflow run 和可恢复 WebSocket，是进入画布之后的另一条链。

---

## 动手前要有的东西

### 前端

- TanStack Router 根路由 `/`
- `HomeShell` / `HomeLayout`
- `Home` 首页容器
- `HomeHeroComposerV4`
- 登录弹窗 store
- `useAwsApi`
- `useAssetsApi`
- `useCreateNewFlow`
- `home-composer-draft`
- `home-agent-handoff`
- Agent 模型选择状态
- 画布侧 `AssistantProvider`

### 后端

- JWT 认证链路
- `POST /api/v2/cos/presign`
- COS / CDN 配置
- `POST /api/v3/assets/library`
- `POST /api/v2/flow/project`
- Agent 会话接口

首页 Composer 依赖登录与 JWT，先看 [01-登录与JWT](../01-登录与JWT/01-登录与JWT.md)。进入画布后的项目读取和运行态恢复，继续看 [02-画布登录门禁与项目加载](../02-画布登录门禁与项目加载/01-画布登录门禁与项目加载.md)。
