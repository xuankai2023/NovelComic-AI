# 画布编辑、节点预览与 Remotion：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend` 和 `opencreator-remotion`。NovelComic 看 `novelcomic-frontend` 和 `novelcomic-remotion`。

不在这一段：登录、首页 Composer 发送、workflow run 协议、对话面板、Creator Shell、教程卡、只读页 MenuBar 和底栏。Preview 交回 Composer 继续用现有的 `addRemoteAttachment`、`appendText`、`sendWithAttachment`。

# 已经对齐，不要重写

这些文件对过现码，行为已经相同。差的是 import 路径、尾逗号或类型写法。

- `src/lib/handleRules.ts`
- `src/lib/connectionLimits.ts`
- `src/lib/cycleDetection.ts`
- `src/lib/flow-persistence.ts`
- `src/lib/local-db.ts`
- `src/lib/sync-manager.ts`
- `src/constants/pinConfigs.ts`：只差 `PinConfig` 的 import 路径
- `src/constants/nodeTags.ts` 的桶：text、image、video、audio，外加 `cut`
- 1.5 秒自动保存。未 ready 或只读不增加 `persistRevision`
- Cmd/Ctrl+S 等待 800ms。离开页面调用 `saveAndSync`，并允许空写
- 封面继续走 `PATCH /api/v2/flow/project/details`，不并进 `saveAndSync`
- 撤销比较字段和 OpenCreator `getSimplifiedWorkflowNode` 相同：去掉 `selected`、`measured`、`dragging`，data 只留 `inputText`、`inputHint` 和便签字段。入栈 debounce 1 秒，默认 20 步，`VITE_MAX_UNDO_STEPS` 可改
- `FlowUndoRedoHotkeys` 已经挂在 `canvasEditorContent.tsx`。写回时 `persist: false`，再 `markFlowDirty`
- Preview 分桶、空态、`motionTrajectory` 不进桶、`__cut__` 按 CDN 地址对齐、排队和失败不进桶
- 标注附件是 `control_reference`，`controlSource` 是 `preview_product_control`，上传 `skipPreprocess: true`。原结果不改
- 轨迹提交时新建或更新 `imageInput`，`controlInputKind` 是 `motionTrajectory`。边放在附件 `onSend`
- 文本保存走 `PATCH /api/v3/result`，再更新 session
- `changeRemotionNodeData` 仍是空函数。`setRemotionNodeId` 会写 `localStorage['OP_REMOTION_NODE_ID']`
- AutoEditor 的 `/api/render2` body 是 `{ design, options }`。任务 id 是 `video.id`。进度状态是 `PENDING`、`PROCESSING`、`COMPLETED`、`ERROR`
- `novelcomic-remotion` 里已经有 `UndoableState`、默认 30fps、736×414、`FEATURE_SAVE_BUTTON`、`remotion-editor-starter-state-v3`，以及 `init_data` / `payload_change` / `close_window` 的消息函数

# 1. 画布节点换成 OpenCreator 的自定义节点

做完要达到：画布上每种节点都是 OpenCreator 现在那套节点，能改输入、模型和标签。`assembleNow` 不再是唯一的专用节点。

## 现在

`Flow.tsx` 的 `nodeTypes` 除了 `assembleNow`，其余类型都渲染 `CanvasWorkflowNode`。它只显示标题、类型名和 pin。

`src/lib/node-defaults.ts` 只有 `assembleNow` 的 `assembleAssets: []` 和 `assemblePayload: ''`。`use-create-node.tsx` 不生成 `modelConfigs`，也不给节点名做去重。

OpenCreator 的注册表在 `custom_nodes/nodeTypes.tsx` 和 `canvasNodeTypes.ts`。`node-defaults.ts` 的 `buildNodeDefaults` 给各类节点写默认模型。`buildDefaultModelConfigs` 再写成 `modelConfigs`。新建时 `generateUniqueNodeLabel` 避开已有标题。创建 `assembleNow` 时打 `Video_Editor` / `Create_Assemble`。

## 改哪些文件

1. 从 OpenCreator `src/features/canvas-workflow/components/custom_nodes/` 按现码搬入节点、输入节点、便签、分组和节点层。目录保持 `custom_nodes/`。
2. `novelcomic-frontend/src/lib/node-defaults.ts` 对齐 `buildNodeDefaults`、`buildDefaultModelConfigs`、`getExistingModelConfigs`。
3. `use-create-node.tsx` 走这套默认值，并给标题去重。
4. `Flow.tsx` 的 `nodeTypes` 改成 OpenCreator 的注册表。删掉通用 `CanvasWorkflowNode`。

节点上的 Run 只调用现有运行入口。这一段不改 workflow run 和 WebSocket。

# 2. 拖拽、连线、辅助线、快捷菜单和分组

做完要达到：拖动过程中不自动保存，松手才入撤销栈。成环才提示。松手没接上线时能弹出快捷节点菜单。选中节点能分组和解组。

## 现在

`Flow.tsx` 的 `onNodesChange` 对每一次变更都 `saveNodesToHistory`，并且 `forcePersist: true`。拖拽中的位移、框选也会记脏。

`onConnect` 在超限或不兼容时显示「连接不符合节点规则，已阻止。」成环显示「连接会形成循环，已阻止。」

OpenCreator `Flow.tsx`：

- 拖拽中的 `position` 且 `dragging === true` 时，`persist: false`，并 `skipBoundaryCheck: true`。不入撤销栈。
- 松手、新增、尺寸变化才 debounce 1 秒后 `saveNodesToHistory`。
- `isValidConnection` 只拒绝自环和不兼容 pin。
- `onConnect` 里超限直接 return，没有 toast。成环调用 `failureToast(t('cycleDetected'))`。
- 框选时边不能被选中。只有直接点到边，`edgeClickedRef` 才允许 `select`。
- 拖节点时画辅助线，文件是 `panels/HelperLines.tsx`。
- 连线松手但没接上时，`onConnectEnd` 打开 `quick-node-menu.tsx`。按 `N` 或双击空白打开 `quick-template-menu.tsx`。这两处加边不再跑环检测和连接数。
- `flow.store.ts` 有 `groupNodes`、`ungroupNodes`、`checkGroupBoundaries`。拖进分组会改 `parentId`。工具条在 `select-node-toolbar.tsx`。分组节点是 `groupNode/GroupNode.tsx`。
- 边用 `customEdge`。选中边的 `zIndex` 抬高。
- `isActiveKeyMap` 为 false 时，撤销、保存、复制和 React Flow 删除键都不响应。文本输入和 Mention 聚焦时 `toggleActiveKeyMap(false)`，失焦再打开。

性能模式阈值已经对齐：节点超过 40、边超过 60，或图片 / 视频 / 音频节点超过 12。这一段不要改 `canvas-performance.ts` 的三个数字。

## 改哪些文件

1. `Flow.tsx`：拖拽保存、连线提示、边选中、辅助线、两个快捷菜单、`isActiveKeyMap`。
2. `flow.store.ts`：补 `groupNodes`、`ungroupNodes`、`checkGroupBoundaries`、`toggleActiveKeyMap`。拖拽中跳过分组边界检查。
3. 新建并接上 `HelperLines.tsx`、`quick-node-menu.tsx`、`quick-template-menu.tsx`、`select-node-toolbar.tsx`、`custom_edges/customEdge.tsx`、`groupNode/GroupNode.tsx`。
4. 文本输入和 Mention 聚焦时关掉快捷键。对照 OpenCreator 的 `TextInput.tsx`、`textInputNode.tsx`、`MentionInput/index.tsx`。

# 3. 复制和粘贴

做完要达到：复制的是当时的节点和内部边。粘贴后 mention 指向新节点 id。粘贴文件先上传，再把远程地址写进输入节点。

## 现在

`use-hotkey-copy-node.tsx` 只记住选中节点的 id。粘贴时再按当前图去 `duplicateNodes`。文件用 `URL.createObjectURL` 写进 `imageBase64`、`inputVideo` 或 `inputAudio`。任意文本都会建成 `textInput`。

`use-duplicate-nodes.ts` 把 `@旧标题` 换成 `@新标题`。偏移是 `{ x: 48, y: 48 }`。不改 `parentId`。

OpenCreator：

- 剪贴板里是 `{ nodes, edges }` 快照。
- mention 替换的是 `{{text|image|audio|video:旧节点id}}` 和 `{{type:旧节点id:pinType}}`，换成新节点 id。标题用 `generateUniqueCopiedNodeLabel`。
- 默认偏移 `{ x: 100, y: 100 }`。分组子节点的 `parentId` 改到新分组。
- 复制选择排除 `stickyNodesNode`，也排除带 `parentId` 的子节点。
- 粘贴文件走 `use-media-upload.ts`，`postUploadFile(..., { skipPreprocess: true })`。图片最终地址再用 `getImageKitImageUrl`。文本里只认图片、视频、音频 URL，认不出的文本不建节点。

超限边仍然丢掉。`checkEdgeLimit` 两边已经相同，不要改 `connectionLimits.ts`。

## 改哪些文件

1. `use-duplicate-nodes.ts`：快照复制、mention id、偏移、`parentId`。
2. `use-hotkey-copy-node.tsx`：剪贴板快照、只粘贴媒体 URL、文件先上传。
3. 新建 `hooks/flow/use-media-upload.ts`，对齐 OpenCreator 同名文件。

# 4. Preview 媒体地址、剧本和未读

做完要达到：大图用原文件，缩略图用转码地址。剧本按章节渲染。本次新出的结果在轨道上算未读，并在用户还没手动切桶时自动跳到新桶。

## 现在

`build-preview-items.ts` 的分桶和 `__cut__` 对齐已经在。输入图片的 `mediaUrl` 和 `previewUrl` 都是 `normalizeCdnResourceUrl`。视频没有封面时，`previewUrl` 直接用视频地址。生成结果的视频封面缺失时同样退回视频地址。

OpenCreator 输入图：

- 全屏 `mediaUrl` 用 `getImageKitFileUrl`，避开实时 webp。
- 缩略图 `previewUrl` 用 `getImageKitImageUrl`。
- 输入视频用 `getImageKitVideoUrl`。封面用 `getImageKitPosterUrl`，没有封面时用 `getVideoThumbnailUrl`。

生成结果的视频封面缺失时，同样用 `getVideoThumbnailUrl(mediaUrl)`。

文本结果现在是一个始终可编辑的 `textarea`。OpenCreator 的剧本在 `script-markdown.ts` 和 `preview-markdown-renderer.tsx`。能认出「剧本信息 / 角色设定 / 剧本 / 场景环境」和英文同名标题时，按场景、对白、动作、节拍渲染。认不出才当普通文本。

`use-preview-session-unread.ts` 现在没有。OpenCreator 把本次打开后新出现、且不在首次历史基线里的 item 标成未读。用户没手动切过桶时，按 `PREVIEW_TAG_ORDER` 自动切过去，节流 2 秒。正在看的 gallery 当前条，或 grid 当前桶的全部条目，算已读。

## 改哪些文件

1. `build-preview-items.ts` 的图片和视频地址，改成上面的 ImageKit / 缩略图函数。分桶、失败过滤、`__cut__` 不要重写。
2. 新建 `script-markdown.ts`、`preview-markdown-renderer.tsx`，接到 `preview-stage.tsx` 的文本结果。
3. 新建 `use-preview-session-unread.ts`，接到 `canvas-preview-view.tsx` 和 `preview-rail.tsx`。

# 5. Preview 工具条、视频标注帧和轨迹裁剪

做完要达到：引用、Vary、重跑、改提示词和 OpenCreator 的提交方式一致。给视频标注时用当前帧当底图。轨迹图章能裁剪。

## 现在

`preview-tool-dock.tsx` 有三个动作。

- 「引用」对所有有 `mediaUrl` 的结果都 `addRemoteAttachment`，`tag` 是 `control_reference`。
- 「Vary」把用户输入 `appendText`，附件 `tag` 是 `scene_reference`，然后 `focus`。不发送。
- 「下载」是一个带 `download` 的链接。

文本编辑在舞台里直接展示，不经过工具条的编辑 / 保存 / 取消。

标注画布盖在当前的 `<video>` 上。没有截当前帧。

轨迹画布能放图章，也能抠图。没有裁剪框。

OpenCreator `preview-tool-dock.tsx` 和 `preview-stage.tsx`：

| 动作 | 行为 |
| --- | --- |
| 引用，文本 | `appendText(textContent)`，再聚焦 |
| 引用，媒体 | `addRemoteAttachment`，`tag` 是 `scene_reference` |
| Vary | `sendWithAttachment`。文本是 `` `Vary: ${prompt}` ``。媒体附件的 `tag` 仍是 `scene_reference`。文本结果改用 `quotedContext` |
| 重跑 | 只对来源是 `result`、且不是文本的条目。选中该节点，`status` 写成 `queued`，调用 `setSingleNodeRunningID(\`${nodeId}<<UUID>>${nanoid()}\`)`，再派发 `oc:canvas-view-mode-change`，`viewMode` 为 `canvas` |
| 提示词 | 打开该结果的 prompt。提交时写回节点 prompt，然后走和重跑相同的排队信号 |
| 文本 | 工具条进入编辑。保存仍是 `PATCH /api/v3/result`。取消恢复原文 |
| 复制 | 文本结果写入剪贴板 |
| 下载 | `buildForcedDownloadUrl` 后再触发浏览器下载 |

视频进入标注时先暂停，用 `captureCurrentVideoFrame`。截不到再走 `buildCloudflareFrameUrl`。底图用这一帧，不用正在播放的画面。

轨迹图章在 `preview-motion-path-domain.ts` 里有裁剪框：`createInitialCropRect`、`applyCropResize`、`applyCropMove`、`mapStampCropToImagePixels`。最小边 20。确认后按裁剪区域出图。抠图留在裁剪之后。

## 改哪些文件

1. `preview-tool-dock.tsx` 和 `preview-stage.tsx`：按上表接引用、Vary、重跑、提示词、文本编辑、复制、下载。
2. `preview-annotation-compose.ts`：补 `captureCurrentVideoFrame` 和 `buildCloudflareFrameUrl`。标注模式用这一帧当背景。
3. `preview-motion-path-domain.ts` 和 `preview-motion-path-canvas.tsx`：补裁剪。现有抠图保留。

重跑和改提示词发出的节点状态、`setSingleNodeRunningID` 形状、以及切回画布的事件，和 OpenCreator `preview-stage.tsx` 保持一致。真正入队仍走现有运行入口，这一段不新写一套 run 协议。

# 6. 组装节点按用户选择收集素材

做完要达到：组装节点只收视频和音频 pin。生成结果用用户在结果里选中的那一条。Imports 里能删素材。只有 Imports 里的「开始编辑」打开全屏编辑器。

## 现在

`assembleNowNode.tsx` 的 pin 来自 `pinConfigs`。生成节点取 `historyResults` 或 `getNodeResults` 的最新一条。Imports 把素材列成文本。Auto Edit 和 Imports 旁边都有一个「Open Editor」。标题不能改。

OpenCreator 同文件：

- 左侧 pin 只有 `video` 和 `audio`。
- 输入节点仍读 `inputText`、`imageBase64`、`inputVideo`、`inputAudio`。视频时长读 `videoDuration`，封面读 `inputVideoPoster`。
- 生成节点不读最新历史。它读 `userSelection[sourceHandle]`，再按 `node_id` 取出用户选中的 outputs。视频封面用 `getVideoThumbnailUrl`。
- 双击标题改 `inputHint`，并 `setNodes`。
- Imports 用 `DragArea`。删除带 `resultId` 的素材时，从 `userSelection` 里去掉该 output。没有 `resultId` 时删掉来自该节点的边。
- 「开始编辑」只在 Imports、且素材数量大于 0 时出现。点击 `setRemotionNodeId(id)`。`OP_REMOTION_NODE_ID` 已由 `setRemotionNodeId` 写入，不要再写第二套 key。
- 默认 tab 仍是 `auto_edit`。

## 改哪些文件

1. `assembleNowNode.tsx`：pin、`userSelection`、标题、删除、开始编辑的位置。
2. 从 OpenCreator 搬入 `src/components/assemble/drag-area`。
3. 素材比较继续用字段相等，不要改回 `JSON.stringify`。

# 7. 节点内预览改成 Remotion Player

做完要达到：节点里用 `@remotion/player` 按素材时长播放，能排序、改比例和倍速。Download 仍走 `/api/render2`，完成后按附件方式下载 mp4。

## 现在

`AutoEditor/index.tsx` 自己拼一个 736×414、150 帧、30fps 的 payload，直接调用 `startRender`。`AutoEditor/player/index.tsx` 用 `setInterval` 每秒换一张图或一个视频。没有时间线排序，没有比例，没有倍速。

`useRemotionRender.ts` 的 payload 形状已经是 `{ design: inputProps, options: { fps, size, format: 'mp4' } }`。轮询 2 秒，10 分钟超时。页面隐藏时仍会请求。

OpenCreator：

- `AutoEditor/provider.tsx` 保存排序后的视频、比例 `16:9 | 1:1 | 9:16`、倍速。
- `player/index.tsx` 用 `@remotion/player` 的 `Player`，先读每个视频和音频的时长，再用 `preloadVideo` / `preloadAudio`。
- `timeline/VideoSort.tsx` 能改顺序。拖时间线时 `onDisabledDrag(false)`，节点暂时不可拖。
- `controls/index.tsx` 播放、暂停、比例、倍速。Download 先 `getRenderData()`。没有图片和视频，或 `durationInFrames <= 0`，直接提示并返回。成功后文件名 `OpenCreator-${Date.now()}.mp4`，走 `buildForcedDownloadUrl`。
- 进度轮询在 `document.visibilityState !== 'visible'` 时跳过。

`/api/render2` 的提交和查询不要改成 `/api/render`。

## 改哪些文件

1. 从 OpenCreator 搬入 `AutoEditor/provider.tsx`、`player/VideoComposition.tsx`、`player/composition.tsx`、`timeline/VideoSort.tsx`、`controls/index.tsx`、`controls/time-bar.tsx`。
2. `AutoEditor/index.tsx` 和 `player/index.tsx` 改成这套播放器。删掉 `setInterval` 轮播。
3. `useRemotionRender.ts` 在页面隐藏时暂停轮询。payload 形状保持不变。

# 8. iframe 出站消息和父页面滚轮

做完要达到：父页面发出的 `init_data` 和 OpenCreator 一样带 `source: "remotion-editor"`。编辑器打开时，父页面不跟着 Ctrl/Meta + 滚轮缩放。

## 现在

`iframe_editor.tsx` 在 `onLoad` 里立刻 `postMessage`。`source` 是 `opencreator-frontend`。字段已经是 `project_name`、`assets`、`assemblePayload`。入站会核对 origin 和 `source === 'remotion-editor'`，并处理 `close_window`、`payload_change`、`posthug`。相同 `assemblePayload` 不重复写。

OpenCreator 同文件把出站也包成 `source: "remotion-editor"`。`postMessage` 外包 100ms。`onLoad` 后再等 300ms 才 `pushInitData`。打开期间 `wheel` 且 `ctrlKey` 时 `preventDefault`。`posthug` 额外带当前用户邮箱。

`changeRemotionNodeData` 保持空函数。iframe 的 `src` 仍只写 origin，不要填 `REMOTION_BASE_URL`。

## 改哪些文件

只改 `src/components/remotion/iframe_editor.tsx`。

# 9. Remotion 编辑器换成完整时间线，并保留消息桥

做完要达到：iframe 里是 OpenCreator 现在这套时间线编辑器。它仍能接收 `init_data`，改动后发 `payload_change`，关闭时发 `close_window`。导出仍是 `POST /api/render` 和 `POST /api/progress`。

## 现在

`novelcomic-remotion/src/editor/editor.tsx` 是一页清单。它列出 assets，每个 item 一个删除按钮，外加 Undo 和 Export。没有播放器、时间线、检查器、字幕、分割和吸附。

`context-provider.tsx` 能收 `init_data`，用 `assemblePayload` 或入边素材恢复 `UndoableState`，再 `postMessage`。监听不核对 `event.origin`，也不核对入站 `source`。`getFrontendTargetOrigin()` 缺环境变量时是 `*`。

`flags.ts` 只打开了动作栏上的几个开关。OpenCreator `flags.ts` 还打开时间线缩放、胶片条、波形、音量、淡入淡出、字幕、分割、吸附和裁剪。

`app/api/render/route.ts` 会校验 payload 并调用 `submitLambdaRender`。`lambda-render.ts` 的 `inputProps` 没有 `fontInfos`。OpenCreator 的 `app/api/render/route.ts` 用 `collectFontInfoFromItems` 放进 `inputProps`，`downloadBehavior.fileName` 来自 `getEditorExportFileName`，`timeoutInMilliseconds` 是 120000。函数名仍由磁盘 10240MB、内存 3009MB、超时 240 秒经 `speculateFunctionName` 算出。codec 固定 `h264`。composition 名 `Main`，site 名 `remotion-editor-starter`。

`POST /api/progress` 在 NovelComic 里已经会把成片拷到存储。拷贝失败时保留 Lambda 原地址。这一段保持这个回退。

OpenCreator 的 `opencreator-remotion` 没有 `message` 监听。NovelComic 已经有的 `messages.ts` 要留着，接到完整编辑器上，不要删掉后再按 OpenCreator 缺监听的状态交回去。

初始化顺序继续是：语言切换用的 sessionStorage，然后 URL `#state=`，然后 `localStorage['remotion-editor-starter-state-v3']`。`FEATURE_SAVE_BUTTON` 为 false 时，没有语言切换快照就不读 URL 和 localStorage。`initialized` 之前不渲染编辑器。

收到 `init_data` 后：

- 有合法 `assemblePayload` 时恢复这份时间线。
- 没有时，用父页面的 `assets` 生成 assets、items、tracks。
- 工程变化发 `payload_change`，`source` 为 `remotion-editor`。
- 关闭发 `close_window`。
- `targetOrigin` 用父页面 origin。缺配置时不要用 `*`。
- 入站 origin 必须等于 iframe 自己的 origin，`source` 必须是 `remotion-editor`。

## 改哪些文件

1. 以 OpenCreator `opencreator-remotion/src/editor/` 和 `app/[locale]/page.tsx` 为底，换掉现在的清单页。保留 `messages.ts` 里的 `createUndoableStateFromInitData`、`createPayloadChangeMessage`、`createCloseWindowMessage`。
2. `context-provider.tsx` 用 OpenCreator 的撤销、素材和播放状态，并把上面的消息监听接进去。
3. `app/api/render/route.ts` 补 `fontInfos` 和下载文件名。磁盘、内存、超时、codec、composition、site 保持现在的数字。
4. 不要在 `opencreator-remotion` 或 `novelcomic-remotion` 里加 `/api/render2`。

# 验收

按这个顺序看。前一条没过，先不要改后面的文件。

1. 画布上的文本、图片、视频、音频和生成节点能改自己的输入。只读画布这些操作不生效。
2. 拖动过程中不发 PATCH。松手后约 1.5 秒保存。刷新后撤销栈清空。
3. `text` 接不上 `image`。`image` 能接 `subject` 和 `style`。成环有提示。超限没有提示，线也不出现。
4. 复制后的 mention 指向新节点 id。粘贴图片进的是上传后的地址。
5. Preview 按 nodeTag 显示最新成功结果。剧本按章节显示。新结果在轨道上未读。
6. 引用媒体的 `tag` 是 `scene_reference`。标注仍是 `control_reference`，`controlSource` 是 `preview_product_control`。
7. Vary 发送的文本以 `Vary: ` 开头，并带上素材。重跑把该节点标成 `queued` 并切回画布。
8. 轨迹图章能裁剪。发送前没有边。
9. 组装节点的生成素材来自 `userSelection`。Imports 的「开始编辑」打开 iframe。
10. 节点内播放器按素材时长播放。Download 仍轮询 `video.id`。
11. `payload_change` 写回 `assemblePayload`。`close_window` 关掉全屏，不清空这个字符串。
12. 独立编辑器 `POST /api/render` 返回 `renderId` 和 `bucketName`。它不查询 `/api/render2`。
