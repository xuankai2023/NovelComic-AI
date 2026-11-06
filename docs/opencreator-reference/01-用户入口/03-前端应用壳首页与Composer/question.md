# 前端应用壳首页与 Composer question

## 核心概念

- 首页 Composer 是不是直接跑模型？
  - 不是。
  - 首页只准备首轮 Agent 输入。
  - 首页会先创建空 flow project，再把输入写入 handoff。
  - 真正发送首轮 Agent message 发生在跳转到 `/canvas/{flowId}` 后。

- 为什么首页要先创建空 flow？
  - 因为首轮 Agent message 需要归属到一个具体画布项目。
  - 空 flow 是画布容器。
  - 没有 `flowId`，画布侧无法按当前项目消费 handoff。

- 首页创建 flow 是不是 workflow run？
  - 不是。
  - `POST /api/v2/flow/project` 创建的是项目定义。
  - workflow run 是后续执行实例，属于运行态。
  - 首页发送阶段不应该直接请求 `/api/v2/flow/runs`。

- handoff 是什么？
  - handoff 是首页和画布之间的前端会话交接。
  - 它存放在 `sessionStorage`。
  - 它不是 HTTP 接口，也不是服务端队列。
  - 它只应该被相同 `flowId` 的画布消费。

- 为什么不用 URL query 传 prompt 和附件？
  - 文本、富文本、Hook、附件元数据可能很长。
  - URL 暴露敏感输入，也不适合放复杂结构。
  - `sessionStorage` 更适合当前浏览器会话内的一次性交接。

## 首页壳

- `/` 首页路由负责什么？
  - 只负责渲染首页壳和首页内容。
  - 它不读取项目。
  - 它不创建 flow。
  - 它不发 Agent 消息。

- `HomeShell` 和 `Protected` 有什么区别？
  - `HomeShell` 包首页布局。
  - `Protected` 包受保护页面。
  - 首页可以先展示，点击发送或上传时再要求登录。
  - 画布编辑页必须先过登录门禁。

- `/home` 要不要再写一套首页？
  - 不要。
  - 如果保留旧地址，应该重定向到 `/`。
  - 首页逻辑只能有一套，避免状态和发送链路分叉。

## Composer 输入

- Composer 收集哪些输入？
  - 普通文本。
  - 富文本 mention HTML。
  - 普通附件。
  - 角色 / 产品 / 品牌视觉等语义槽位附件。
  - 控制图引用。
  - Hook / Skill。
  - Agent 模型选择。

- Composer 组件能不能直接创建 flow？
  - 不能。
  - Composer UI 只负责展示和抛事件。
  - 创建 flow、上传、入库和跳转都应该收口在 `Home`。

- 首页草稿为什么只放内存？
  - 首页草稿只是输入体验。
  - 刷新后丢失可以接受。
  - 持久化草稿属于画布编辑场景，不属于首页 Composer。

- Skill-only 场景为什么要用零宽文本？
  - 用户可能只点了 Skill 或 Hook，没有输入普通文本。
  - 但 Agent 仍需要收到一次首轮消息。
  - 用零宽文本可以让消息成立，同时富文本里保留 Skill mention。

## 附件上传

- 为什么不能把浏览器 `File` 放进 handoff？
  - `File` 只存在当前浏览器内存。
  - 画布侧和后端需要稳定可访问的远端 URL。
  - 所以附件必须先上传到 COS，再把 CDN URL 放进 handoff。

- COS 上传顺序是什么？
  - `maybeCompressUploadImage(file)`。
  - `POST /api/v2/cos/presign`。
  - `PUT presigned_url`。
  - 使用返回的 `cdn_url` 作为 `remoteUrl`。

- 上传中能不能点击发送？
  - 不能。
  - 上传中附件还没有稳定远端 URL。
  - 发送后 Agent 会缺附件上下文。

- 上传失败的附件能不能静默丢掉后继续发送？
  - 不能。
  - 用户文本或 mention 可能引用了这个附件。
  - 静默丢掉会导致 Agent 收到不完整上下文。
  - 应该提示用户移除或重试失败附件。

- presign 过期或上传返回 403 怎么办？
  - 前端可以重新请求 presign。
  - 然后用新的 `presigned_url` 重试上传。
  - 当前测试已覆盖 403 后刷新 presign 的行为。

## 素材库入库

- 哪些附件要写个人素材库？
  - 明确属于语义槽位的图片或视频。
  - `character` 写入角色素材。
  - `product` 写入产品素材。
  - `style_reference` 写入品牌视觉素材。

- 普通附件要不要自动入库？
  - 不要。
  - 普通附件只是本次 Agent 输入。
  - 只有用户明确选择语义槽位时，才进入个人素材库。

- 入库失败能不能阻止发送？
  - 不应该阻止。
  - 入库是资产管理旁路。
  - 只要附件上传成功并有 `remoteUrl`，就仍可作为 Agent 输入。
  - 页面应该提示入库失败，并允许单独重试。

- 素材库接口为什么必须鉴权？
  - 素材归属当前用户。
  - 后端必须用 JWT 验签后的 `user_id` 作为 owner。
  - 不能让前端传 user_id。

## 创建 flow

- 首页点击发送请求哪个接口创建画布？
  - `POST /api/v2/flow/project`。
  - 请求必须带 `Authorization: Bearer <__opencreator_jwt>`。
  - 首页默认创建空 `nodes` 和空 `edges`。

- 创建 flow 成功后前端做什么？
  - 拿到 `flow_id`。
  - 写入本地 flow project cache 或 fresh marker。
  - 保存 home-agent-handoff。
  - 清首页草稿。
  - 跳转 `/canvas/{flowId}`。

- 创建 flow 失败怎么办？
  - 恢复 `createLoading`。
  - 展示错误。
  - 不写 handoff。
  - 不跳转画布。

## handoff

- handoff payload 必须有哪些字段？
  - `flowId`。
  - `text`。
  - `attachments`。
  - `agentModelId`。
  - `hook`。
  - `richTextHtml`。
  - `analyticsContext`。
  - `createdAt`。

- 为什么读取 handoff 时要校验 `flowId`？
  - 防止用户打开另一个画布时误消费上一张图的首页输入。
  - handoff 只属于创建它时对应的 flow。

- 为什么 acknowledge 要同时校验 `flowId` 和 `createdAt`？
  - 避免旧异步流程删除新的 handoff。
  - 同一个 `flowId` 可能连续创建多次 handoff。
  - `createdAt` 可以区分不同批次。

- JSON 解析失败怎么办？
  - 删除坏数据。
  - 返回空 handoff。
  - 不能让坏数据导致画布持续报错。

- handoff 失败后为什么不能立即删除？
  - 首轮 Agent 输入不能静默丢失。
  - 只有运行入口 accepted 后才 acknowledge。
  - 未开始的状态可以按次数上限重试。

## 画布侧消费

- 谁消费首页 handoff？
  - `AssistantProvider`。
  - 它在画布侧拿当前 `flowId` 调 `peekHomeAgentHandoff(flowId)`。

- 消费后调用什么？
  - 调用运行入口，例如 `runAll(flowId, inputValues)`。
  - `inputValues.source` 应该是 `home_handoff`。
  - 附件、Hook、模型、富文本和分析上下文都要传过去。

- 运行中为什么不能重复消费 handoff？
  - 同一个画布同时只能有一个明确的首轮发送语义。
  - 运行中重复消费可能导致重复创建 run 或重复发消息。

- 消费成功后做什么？
  - acknowledge handoff。
  - 从 `sessionStorage` 删除这一批输入。

- 消费失败后做什么？
  - 不 acknowledge。
  - 记录错误。
  - 保留 handoff，避免首轮输入丢失。

## NovelComic 当前实现自查

- 只看本章，NovelComic 当前做到了什么？
  - 首页 `/`、`HomeShell`、`HomeLayout` 已存在。
  - `Home` 已收口文本、富文本、附件、Hook/Skill、模型、上传、入库和发送。
  - COS presign 和直传客户端已存在。
  - 个人素材库入库客户端和 publisher 接口已存在。
  - 空 flow 创建客户端和 publisher 接口已存在。
  - `home-agent-handoff` 已有保存、读取、确认删除和重试逻辑。
  - 画布侧 `AssistantProvider` 已能消费 handoff 并调用 `runAll()`。

- 当前能不能算主链路完成？
  - 可以算主链路完成。
  - 因为“首页输入 -> 上传 -> 创建空 flow -> handoff -> 跳转画布 -> 画布侧首轮 Agent 输入”已经具备。
  - 但它还不是 OpenCreator 完整版 Composer。

- 当前缺哪些本章完整版能力？
  - 完整 `HomeComposerMentionInput`。
  - 完整 `ProductControlModal`。
  - 完整 `AssetLibraryPickerModal`。
  - 完整 `ComposerToolbar` 和 `ComposerContentTypeBar` 行为。
  - 完整附件类型：`image`、`audio`、`video`、`pdf`、`markdown`。
  - 完整附件元数据：素材选择来源、控制图来源、控制标注数、预览会话、来源节点、横竖图等。
  - Composer 内部对 `onSlotUploadingChange` 的完整驱动。

- 当前测试覆盖了哪些？
  - COS presign、鉴权缺失、直传成功和 403 刷新 presign。
  - 素材库入库请求、鉴权缺失和更新事件。
  - flow 创建、项目读取、workflow run 创建和查询类 API。
  - home-agent-handoff 的保存、读取、确认删除、坏 JSON 清理和重试判断。
  - AssistantProvider 消费 handoff、运行中不消费、失败不 acknowledge。
  - Publisher flow project 和 assets library 的真实 HTTP 路由行为。

- 当前还缺什么测试？
  - 浏览器级完整点击 E2E。
  - 真实素材库选择器交互测试。
  - 产品控制 Modal 的控制图元数据测试。
  - 完整 mention 输入和富文本 mention 测试。
  - 多附件类型上传和 handoff 字段完整性测试。

- 怎么判断本章主链路验收通过？
  - 未登录点击发送会打开登录弹窗。
  - 登录后选择附件会先上传，上传中不能发送。
  - 上传失败附件不能静默丢掉。
  - 角色 / 产品 / 品牌视觉槽位附件会尝试入库。
  - 入库失败不阻断发送。
  - 点击发送会创建空 flow。
  - 创建成功后写 handoff 并跳转 `/canvas/{flowId}`。
  - 画布侧只消费相同 `flowId` 的 handoff。
  - 首轮输入被传给运行入口，accepted 后 handoff 被删除。

- 怎么判断本章完整版验收通过？
  - 主链路验收全部通过。
  - mention 输入、Hook/Skill、模型选择、内容类型栏都按 OpenCreator 行为工作。
  - 素材库选择器能选择远端素材并回填附件。
  - 产品控制 Modal 能生成控制引用并携带完整 metadata。
  - 所有文档要求的附件类型和 handoff 元数据都能保留。
  - 自动化测试覆盖 API、handoff、Provider、核心 UI 交互和关键失败路径。
