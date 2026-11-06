# 首页与 Composer：按节补

对照 [首页与Composer差距.md](../../../adr/首页与Composer差距.md) 第 1 到第 8 节。按文末顺序做。每一节只改自己列出的文件。

OpenCreator 看 `opencreator-frontend`。NovelComic 看 `novelcomic-frontend`。

空 flow、COS 直传、语义槽位入库、`sessionStorage` 的保存和按 `flowId` 删除，这一段不要重写。handoff 的 key 继续用 `novelcomic:home-agent-handoff`。

下面这些已经对齐，不要动：

- `src/routes/index.tsx`、`src/routes/-components.tsx` 的 `HomeShell`、`src/layouts/home-layout.tsx`
- `src/lib/home-composer-draft.ts`
- `src/api/modules/aws.ts`、`src/api/modules/assets.ts` 的 `createLibraryAsset`
- `src/features/canvas-workflow/hooks/flow/use-create-new-flow.ts`
- `src/lib/home-agent-handoff.ts` 的保存、按 `flowId` 读取、`createdAt` 确认删除、坏 JSON 清理

首页发送仍然是：创建空 flow，写 handoff，跳 `/canvas/{flowId}`。画布 `AssistantProvider` 按 `flowId` 调用现有 `runAll()`。Composer 不创建 flow，首页不直接执行 Agent。

不搬这些首页模块。它们不在这一段的发送链上：

- `home-recent-projects.tsx`
- `home-proven-skills-row.tsx`
- `home-workflow-skills-row.tsx`
- `home-agent-skills-row.tsx`
- `home-hero-proof.tsx`

`saveHomeAgentComposerAttachments` 是素材面板交给画布线程输入框的另一把 key。首页发送不写它，这一段不加。

# 1. 输入框换成 mention

做完要达到：输入框里能留下 Hook、Skill 和附件 mention。刷新首页后草稿还在当前页面生命周期里。发送时 handoff 同时有纯文本 `text` 和 `richTextHtml`。

## 现在

`home-hero-composer-v4.tsx` 渲染 `textarea`。`handleTextChange` 把 `event.target.value` 交给 `onChange`。选中 Hook 时，`emitRichTextHtml` 拼一段 HTML：

```text
<span data-type="mention" data-id="..." data-mention-source="hook">@标签</span>
```

没有附件 mention，也没有独立输入组件。`@tiptap/react` 不在 `novelcomic-frontend/package.json` 里。

OpenCreator 的输入是 `items/composer/mention-input/home-composer-mention-input.tsx`。它用 TipTap。对外句柄是：

```text
insertMention(mention)
insertMentions(mentions)
removeMentions(matcher)
syncHookMention(mention | null)
```

纯文本用 `editor.getText({ blockSeparator: '\n' })` 回传 `onChange`。HTML 回传 `onRichTextHtmlChange`。粘贴和拖入文件时调用 `onAttachFiles`。附件被删掉或标成 `hasError` 时，按 `source: 'attachment'` 和 id 清掉对应 mention。

发送前 OpenCreator 的 `buildHomeHandoffRichTextHtml` 把编辑器里的 `data-home-mention="true"` 收成画布能读的 `data-type="mention"`。Hook mention 保留 `data-mention-source="hook"`。附件 mention 的 `data-id` 用 `类型-序号-url`，`data-mention-type` 在 pdf、markdown 上写成 `file`，image、audio、video 保持原类型。

## 改哪些文件

1. 给 `novelcomic-frontend` 加上 OpenCreator mention 输入已经在用的 TipTap 依赖：`@tiptap/react`、`@tiptap/starter-kit`、`@tiptap/extension-placeholder`。版本对齐 `opencreator-frontend/package.json`。
2. 新建 `novelcomic-frontend/src/components/home/home-page/items/composer/mention-input/`，从 OpenCreator 同目录搬入输入、mention 节点和类型。路径保持 `mention-input/`。
3. `home-hero-composer-v4.tsx` 用这个输入替换 `textarea`。
4. `home-page/index.tsx` 在写入 handoff 前调用和 OpenCreator 相同职责的 `buildHomeHandoffRichTextHtml`。

不改 `home-composer-draft.ts` 的三个函数。草稿仍然只有 `text` 和 `richTextHtml`，仍然只活在模块内存里。

## 输入行为

`Home` 继续持有 `composerText` 和 `composerRichTextHtml`，继续调用现在的 `setHomeComposerDraft`。

mention 的 `source` 用这五个值：`attachment`、`product`、`avatar`、`brand`、`hook`。

槽位和标签的对应：

| 附件 | mention source |
| --- | --- |
| `tag` 或 `tags` 含 `character`，或 `assetSlotKind === 'character'` | `avatar` |
| `tag` 或 `tags` 含 `product`，或 `assetSlotKind === 'product'` | `product` |
| `tag` 或 `tags` 含 `style_reference`，或 `assetSlotKind === 'brand_visual'` | `brand` |
| 其他附件 | `attachment` |
| 当前选中的 Hook / Skill | `hook` |

上传完成后，用附件 id、文件名和 mention 类型插入一条 mention。上传失败或用户删除附件时去掉它。

Skill-only 仍然用零宽文本 `\u200b` 当 `text`。`richTextHtml` 只保留 skill mention，形状跟 OpenCreator 的 `buildHomeComposerSkillMentionRichTextHtml`：

```text
<p><span data-type="mention" data-id="技能id" data-mention-type="file" data-mention-source="hook">@名称</span></p>
```

`data-id` 用目录里的 `hook_id` 或个人 skill 的 `skill_id`。不要再用 `story-opening` 这种写死 id。

# 2. 槽位、素材库、产品控制和附件类型

做完要达到：三个槽位能从个人素材库回填，也能上传新文件。产品控制台把标注图交回 Composer。上传过程中首页知道槽位还在传。附件类型分成 image、audio、video、pdf、markdown。认不出的文件不进队列。

内容类型条是另一件事。OpenCreator 的条是 `cinema`、`feed`、`commercial`、`free`，用来改占位文案、默认比例、默认技能分类，并写进 Hook 的 `channel_id`。它不按文件类型拆。

## 现在

`home-hero-composer-v4.tsx` 的槽位是三个按钮加一个隐藏 `input`。`accept` 来自 `slotConfigs`，只有图片和视频。点按钮就 `click()` 这个 `input`。`onSlotUploadingChange` 在 props 里，组件参数没有接它，内部也不调用。

`Home.handleAttachFiles` 在带 `tag` 时自己把 `hasUploadingSlots` 设成 true，整批结束后设回 false。素材库回填和产品控制不会走这条，因为组件没把这两种选择交出来。

同文件里的内容类型是 `story`、`panel`、`character`，只改本地 `selectedContentType`，不进发送。工具条上的「产品控制」「15s」「16:9」「设置」没有打开控制台，也没有把时长和比例写进 Hook。

`getComposerAttachmentType` 在 `home-page/index.tsx`：图片、视频以外都返回 `file`。OpenCreator 的同名函数在 `features/agent-chat/shared/composer-attachment-type.ts`，返回 `image | audio | video | pdf | markdown | null`。pdf 看 MIME 或文件名后缀 `.pdf`。markdown 看 `text/markdown`、`.md`、`.markdown`。返回 `null` 的文件被丢掉，不进队列。

仓库里没有 `AssetLibraryPickerModal`、`ProductControlModal`、`ComposerToolbar`、`ComposerContentTypeBar`。`getAssetsList` 已经能 `POST /api/v3/assets/fetch?category=`，body 可以带 `source_kind` 和 `library_kind`。Publisher 测试 `test_asset_library_fetch_uploaded_filters_current_user_and_kind` 覆盖了按当前用户和 `library_kind` 过滤。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/features/agent-chat/shared/composer-attachment-type.ts`。行为对齐 OpenCreator 的 `getComposerAttachmentType`、`toComposerAttachmentMentionType`。
2. 新建这些目录，从 OpenCreator 同名文件搬行为，再接到下面的回调：
   - `src/components/home/home-page/items/composer/composer-toolbar.tsx`
   - `src/components/home/home-page/items/composer/composer-content-type-bar.tsx`
   - `src/components/home/home-page/items/composer/composer-slot-card.tsx`
   - `src/components/home/home-page/items/composer/product-control/`
   - `src/features/assets/components/AssetLibraryPickerModal.tsx`
3. 改 `home-hero-composer-v4.tsx`：挂上这三个槽位、两个弹窗、内容类型条和工具条。
4. 改 `home-page/index.tsx` 的 `getComposerAttachmentType` 调用点，以及 `handleAttachFiles` 对 `null` 类型的丢弃。

上传仍走现有 `postUploadFile`。入库仍走现有 `createLibraryAsset`。列表走现有 `getAssetsList`。不要新写一套上传或素材库协议。

角色槽位打开头像或角色素材选择。产品和品牌视觉槽位打开 `AssetLibraryPickerModal`，`library_kind` 分别是 `product`、`brand_visual`。选中项调用已经存在的 `onAddRemoteAttachments`。本地上传仍调用 `onAttachFiles(files, tag)`。

`tag` 映射保持现在的入库规则：

```text
character → character
product → product
style_reference → brand_visual
```

`control_reference` 不入库。

## 槽位状态

Composer 内部用三个槽位状态：avatar、product、brand。每个槽位有预览、远端 URL、上传中、失败、横竖图。

远端 URL 已经就绪、并且不在上传、没有失败时，收成 `onSlotAttachmentsChange` 的数组。字段至少包括 `type`、`url`、`tag`、`tags`、`assetSlotKind`、`previewUrl`、`fileName`、`isLandscape`。

任一槽位 `isUploading` 时调用 `onSlotUploadingChange(true)`，否则 `false`。这个调用放在 Composer 里。`Home.handleAttachFiles` 里那句按 `tag` 直接改 `hasUploadingSlots` 删掉，避免和 Composer 的上报叠成两次。

产品控制：未登录先走第 6 节的登录框。登录后打开 `ProductControlModal`。提交时把画布导出的 data URL 转成 png `File`，调用：

```text
onAttachFiles([file], 'control_reference', 'home_product_control', {
  controlWorkbenchSessionId,
})
```

`controlWorkbenchSessionId` 在打开控制台时生成。标注张数留在控制台自己的状态里；首页这条提交不把 `controlAnnotationCount` 写进附件。OpenCreator 首页提交同样只传 `controlWorkbenchSessionId`。`controlAnnotationCount` 仍留在附件类型上，给画布预览那条链用，这一段不从首页填它。

## 内容类型和工具条

内容类型 id 用 `cinema | feed | commercial | free`。切换时：

| id | 默认比例 | 未手选技能时的分类 |
| --- | --- | --- |
| cinema | 16:9 | directors |
| feed | 9:16 | hooks |
| commercial | 9:16 | hooks |
| free | 16:9 | directors |

工具条的时长是 `15 | 30 | 60`，比例是 `16:9 | 9:16 | 1:1`。当前值进入第 5 节的 Hook payload：`channel_id` 用内容类型 id，`duration` 用时长数字，`aspect_ratio` 用比例字符串。

NovelComic 没有 `ComposerSettingsModal`。这一段不要新做模型、BGM、字幕设置页。Hook 里这几个字段用空值：`main_image_model`、`shot_image_model`、`shot_video_model` 用 `''`，`bg_audio` 和 `on_caption` 用 `false`。

## 附件类型

`ChatAttachmentType` 收成 `image | audio | video | pdf | markdown`。首页 `ComposerExternalAttachment.type` 用这个联合。`file` 不再作为附件类型。

`handleAttachFiles` 对 `getComposerAttachmentType` 返回 `null` 的文件直接跳过，不造一条 `hasError` 附件。

mention 类型继续把 pdf、markdown 写成 `file`，和 OpenCreator 的 `toComposerAttachmentMentionType` 一样。

# 3. handoff 附件字段

做完要达到：从素材库或产品控制台选出的附件，到画布后仍能看出来源。缺这些字段的旧 handoff 仍能按 `text` 和 `url` 发送。

## 现在

NovelComic 有两份 `ComposerExternalAttachment`。

`home-hero-composer-v4.tsx` 那份只有 `id`、`type`、`url`、`previewUrl`、`fileName`、`tag`、`tags`。`home-agent-handoff.ts` 和 `home-page/index.tsx` 用的是这一份。`readyAttachments` 也只拷贝这些字段。

`features/agent-chat/runtime/composer-commands-context.ts` 那份类型更宽，已经有 `controlSource`、`controlAnnotationCount`、`previewSessionId`、来源节点字段，但首页发送不读它。它也没有素材库选择来源、控制台会话、横竖图。

OpenCreator 只有一份，定义在 `composer-commands-context.ts`。首页 `readyAttachments` 拷贝这些字段：

```text
type
url
tag
tags
assetSlotKind
assetPickerSessionId
assetPickerSurface
assetPickerSource
assetPickerActionLocation
assetSelectionSource
assetChannelId
controlSource
controlWorkbenchSessionId
previewUrl
fileName
isLandscape
```

画布 `assistant-provider.tsx` 再把它们写成蛇形，交给首轮输入：

```text
asset_slot_kind
asset_picker_session_id
asset_picker_surface
asset_picker_source
asset_picker_action_location
asset_selection_source
asset_channel_id
control_source
control_annotation_count
preview_session_id
control_workbench_session_id
source_node_tag
source_node_id
source_result_id
source_output_index
```

没有 `url` 的附件在这一步滤掉。

## 改哪些文件

1. 扩展 `novelcomic-frontend/src/features/agent-chat/runtime/composer-commands-context.ts` 的 `ComposerExternalAttachment`，补上上面首页会写的字段。`type` 改成第 2 节的五类。
2. `home-hero-composer-v4.tsx` 删掉自己的 `ComposerExternalAttachment`，改为引用这一份。
3. `home-agent-handoff.ts` 的附件类型改成引用这一份。payload 的其余字段不动。
4. `home-page/index.tsx` 的 `readyAttachments` 按 OpenCreator 那张字段表拷贝。素材库回填时把选择来源一并放进 `HomeComposerAttachment`，发送时不要丢掉。
5. `assistant-provider.tsx` 把附件映射成上面的蛇形字段后再放进 `runAll` 的 `attachments`。`url` 为空的条目去掉。

`runAll` 的函数签名不要改。`input_values` 里继续有 `text`、`attachments`、`agent_model_id`、`hook`、`rich_text_html`、`analytics_context`。

旧 handoff 只有 `type` 和 `url` 时，映射结果里多出来的键是 `undefined`。`runAll` 仍用原来的 `text` 和这条 `url` 发送。

`home-agent-handoff.test.ts` 加一条：附件上的 `assetSlotKind`、`assetSelectionSource`、`controlSource`、`controlWorkbenchSessionId`、`isLandscape` 保存后再按同一 `flowId` 读回来。

# 4. 首页模型下拉改成 Agent 三档

做完要达到：首页下拉只有 `claude`、`kimi_k3`、`deepseek_v4_flash`。免费用户选不了 `claude` 和 `kimi_k3`。刷新后选择还在。handoff 的 `agentModelId` 只可能是这三档之一。

## 现在

`home-page/index.tsx` 用 `useEnrichedModelsData()`。那是节点云模型目录。默认 id 是 `novelcomic-default`。`agentModelAccess` 只有 `loading | allowed`。`useEffect` 发现当前 id 不在目录里就改成第一项，不写 `localStorage`。

OpenCreator 的目录在 `features/agent-chat/constants/agent-models.ts`：

```text
VISIBLE_AGENT_MODEL_IDS = claude | kimi_k3 | deepseek_v4_flash
DEFAULT = deepseek_v4_flash
PREMIUM = claude | kimi_k3
```

`shared/agent-model-selection.ts` 的权限是 `loading | free | paid`。`normalizeAgentModelId`：权限还不是 `paid` 时一律返回 `deepseek_v4_flash`；是 `paid` 时，id 不在三档里也返回默认。选择写入 `localStorage`，key 是 `opencreator.agent.selectedModel`。

`useAgentModelSelection` 用订阅快照算权限。OpenCreator 的 `userLevel > 0` 来自 `subscription_metadata.level`。NovelComic 的 `UserInfo` 没有这个字段，也没有 `useUserLevel`。现成的付费信号是 `subscription_credits.status === 'active'`，`useCreditsProvider` 已经在读它。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/features/agent-chat/constants/agent-models.ts`。三档 id、默认值、付费集合和两个判断函数，按 OpenCreator 写。
2. 新建 `novelcomic-frontend/src/features/agent-chat/shared/agent-model-selection.ts`。导出 `resolveAgentModelAccess`、`normalizeAgentModelId`、`isAgentModelLocked`、`readStoredAgentModelId`、`persistAgentModelId`。
3. 新建 `novelcomic-frontend/src/features/agent-chat/runtime/use-agent-model-selection.ts`。
4. `home-page/index.tsx` 改用这个 hook。删掉 `useEnrichedModelsData` 和 `novelcomic-default`。
5. 下拉只渲染这三档。`isAgentModelLocked` 为真的项不可选。`access === 'loading'` 时下拉禁用，`setSelectedAgentModelId` 直接返回。

存储 key 用 `novelcomic.agent.selectedModel`。不要写 OpenCreator 那个 key。

权限：

| 条件 | access |
| --- | --- |
| Clerk 还没加载完 | `loading` |
| 未登录 | `free` |
| 已登录，当前用户的积分信息还没回到这个 userId | `loading` |
| `subscription_credits.status === 'active'` | `paid` |
| 其他已登录 | `free` |

不要在这一段加订阅 level 接口。节点模型目录 `useEnrichedModelsData` 留给画布节点，首页不要再读它。

`handleSend` 和 `handleUseSkillDirect` 写入 handoff 的 `agentModelId` 先过 `normalizeAgentModelId`。免费用户即使本地存了 `claude`，写出去的也是 `deepseek_v4_flash`。

给 `agent-model-selection.ts` 加 vitest：未付费时任意 id 变成默认；付费时三档原样返回，其他字符串变成默认；锁定判断只命中两个付费 id。

# 5. Hook 和 Skill 改成目录数据

做完要达到：技能条来自 viral hooks、director seeds 和个人 skills。列表可以是空的。选中项写成 OpenCreator 的 `ChatHookConfigPayload`。点「立即使用」仍创建空 flow 并写同一套 handoff。

## 现在

`hookOptions` 写死两条：`story-opening`、`comic-paneling`。类型是 `{ id, label, kind: 'hook' | 'skill' }`。`buildSkillOnlyRichTextHtml` 用 `hook.id` 和 `hook.label`。

仓库里已经有，但 Composer 没引用：

- `features/viral-hooks/queries.ts` 的 `getViralHooksCached`
- `features/director-seeds/queries.ts` 的 `getDirectorSeedsCached`
- `api/modules/agent-skills.ts` 的 `listPersonalAgentSkills`

`AgentCatalogHook` 的主键是 `hook_id`，标题在 `title.zh` / `title.en`。个人 skill 的主键是 `skill_id`，名称是 `title`。

OpenCreator 的 `HookMarquee` 分三类：`directors`、`hooks`、`mine`。`directors` 读 director seeds，`hooks` 读 viral hooks，`mine` 在已登录且面板打开时读个人 skills。选中后首页拼出的 payload 在 `chat-hook-context.ts`：

```text
hook_id
channel_id
duration
aspect_ratio
main_image_model
shot_image_model
shot_video_model
bg_audio
on_caption
hook_name
hook_category
hook_pick_surface
hook_position_index
```

`channel_id` 是内容类型。`duration`、`aspect_ratio` 来自工具条。后五个模型开关按第 2 节留空。`hook_category` 是 `directors | hooks | mine`。

## 改哪些文件

1. 新建 `novelcomic-frontend/src/features/agent-chat/runtime/chat-hook-context.ts`。只放 `ChatHookConfigPayload`、`chatHookAnalyticsPayload`、`toChatHookRequestPayload`。不搬 React context，首页的选中状态仍放在 `Home`。
2. 新建 `items/composer/hook-marquee.tsx` 和 `items/composer/skill-types.ts`。数据源用上面三个已有函数，不要再写 `hookOptions`。
3. `home-hero-composer-v4.tsx` 用 `HookMarquee` 替换那两颗写死按钮。
4. `home-page/index.tsx` 的 `homeHookPayload` 改成 `ChatHookConfigPayload | null`。`handleUseSkillDirect` 的入参改成同一份 payload。

`mine` 未登录时先开登录框，不发个人 skills 请求。三类请求失败或返回空数组时，技能条是空的。不要回退到 `story-opening` 和 `comic-paneling`。

从目录项拼 payload：

```text
hook_id = AgentCatalogHook.hook_id，或个人 skill 的 skill_id
hook_name = 当前语言的 title，个人 skill 用 title
hook_category = directors | hooks | mine
channel_id = 当前内容类型
duration = 工具条时长，缺省 15
aspect_ratio = 工具条比例，缺省用该内容类型的默认比例
main_image_model = ''
shot_image_model = ''
shot_video_model = ''
bg_audio = false
on_caption = false
hook_pick_surface = recommended | all
hook_position_index = 卡片下标
```

封面「立即使用」走现在的 `onUseSkillDirect`。登录、创建中这两道检查留在 `Home.handleUseSkillDirect`。handoff 的 `text` 仍是给 Agent 的技能使用文案，`attachments` 仍是空数组，`richTextHtml` 用第 1 节的 skill mention。`hook` 用上面这份 payload。

`assistant-provider.test.tsx` 里的假 hook 改成带 `hook_id` 的对象。`runAll` 断言里的 `hook` 跟着改。

# 6. 未登录不把文件放进队列

做完要达到：没登录时点附件、槽位、素材库、产品控制，只打开登录框。列表里不出现上传失败项。登录成功后打开刚才要开的选择器。

## 现在

OpenCreator 在两处看登录。点附件时，已登录才 `fileInput.click()`；未登录把「打开文件选择」放进登录成功回调。`handleAttachFiles` 和 `handleAddRemoteAttachments` 再用 `isSignedInRef` 看一次，未登录就开门禁并 return，不 `setComposerAttachments`。槽位、素材库、产品控制走同一个 `runAfterAuth`。

NovelComic 的 `handleAttachFiles` 不看 `isSignedIn`。预签名要 JWT，未登录会进 `catch`，附件被标成 `hasError`。发送本身会开门禁，上传不会。`handleFileInputChange` 和槽位 `input` 一点击就读文件。

## 改哪些文件

1. `home-page/index.tsx` 的 `handleAttachFiles`、`handleAddRemoteAttachments`。
2. `home-hero-composer-v4.tsx` 里打开文件选择、槽位、素材库、产品控制的点击。

`Home` 用 ref 保存当前 `isSignedIn`，避免回调闭包是旧值。

未登录点附件：`useAuthModalStore.open`，成功后再打开文件选择。不要在未登录时把 `File` 推进 `composerAttachments`。

未登录的调用如果已经进了 `handleAttachFiles`，函数直接 return。不上传，不把条目标成 `hasError`。

槽位、素材库、产品控制同样：登录成功后打开对应弹窗或文件选择。登录框取消则什么都不加。

发送未登录仍走现在的 `openAuthModal`，成功后重试 `handleSend`。这条不要改成「只打开选择器」。

# 7. handoff 失败保持可重试

做完要达到：首轮 `runAll` 因网络或还没就绪失败时，这次停留会再试。750ms 一次，同一条 handoff 最多 2 次。只有发送被接受才 acknowledge。模型 id 先按第 4 节归一。

## 现在

OpenCreator 的消费条件是：

```text
agentModelAccess !== 'loading'
!chat.isRunning
!isLoadingMessages
peek 到当前 flowId
attempts < 2
```

`sendMessage` 返回 `not_started` 时，`shouldRetryHomeAgentHandoff` 为真，等 750ms 再调自己。返回 `accepted` 才在 `onAccepted` 里 acknowledge。返回 `rejected` 不重试。

NovelComic 的 `assistant-provider.tsx` 只判断 `!isRunning`。`runAll` 成功就把 status 设成 `accepted` 并 acknowledge。`catch` 把 status 设成 `rejected`。`shouldRetryHomeAgentHandoff` 只对 `not_started` 返回 true，所以这次抛错不会再进 750ms。handoff 还在 `sessionStorage` 里，要刷新才可能再发。

NovelComic 的 `runAll` 没有 `not_started` 返回值。没发出去就是抛错。这里把抛错当成 OpenCreator 的 `not_started`，而不是 `rejected`。

画布侧没有单独的「消息历史加载中」开关。不要为了照抄 `isLoadingMessages` 去加一套会话历史。

## 改哪些文件

1. `assistant-provider.tsx`
2. `assistant-provider.test.tsx`

消费前增加：`useAgentModelSelection()` 的 `access === 'loading'` 时 return，不 peek。`isRunning` 时保持现在的直接 return。

读到 handoff 后：

```text
agentModelId = normalizeAgentModelId(pending.agentModelId, access)
```

把这个 id 写回选择状态，再传给 `runAll` 的 `agent_model_id`。

`try` 成功：status 为 `accepted`，acknowledge，结束。

`catch`：status 保持 `not_started`，不 acknowledge。清空这一轮放进 ref 的附件、hook、富文本。`shouldRetryHomeAgentHandoff('not_started', attempts)` 为真且 effect 没取消时，把进行中的 attempt 标记清掉，`setTimeout` 750ms 后再调用发送函数。

attempts 已经到 2：停。不要把 status 写成 `rejected` 来表达「次数用完」。`shouldRetryHomeAgentHandoff` 的实现不用改，`not_started && attempts < 2` 已经是这个边界。

测试改这三处：

- `runAll` 抛错后 `acknowledge` 不被调用，并且 `shouldRetryHomeAgentHandoff` 收到的 status 是 `not_started`。
- `access === 'loading'` 时不 peek。
- 传入 `claude` 且 access 是 `free` 时，`runAll` 的 `agent_model_id` 是 `deepseek_v4_flash`。

# 8. 发送前补分析事件

做完要达到：点发送会先出现 `agent_composer_send_click`，空 flow 创建成功后再出现 `Create_New_Flow`。选技能和点「立即使用」各有自己的事件。创建失败不上 `Create_New_Flow`。

## 现在

`home-page/index.tsx` 把 `{ source, actionLocation, hasHook, attachmentCount }` 放进 handoff 的 `analyticsContext`。首页没有 `postHogCapture`。`src/lib/posthog-capture.ts` 已经能发事件。

OpenCreator 在 `handleCreateNewFlow` 之前发 `agent_composer_send_click`。创建成功的 `onSuccess` 里、`navigate` 之后发 `Create_New_Flow`。属性是：

```text
source: 'Home Hero Composer'
email: 当前用户主邮箱，没有则 ''
```

发送点击的属性用现在 handoff 里已经有的计数，名字改成 OpenCreator 的蛇形：

```text
source: 'home_composer'
action_location: 'home_hero_composer'
trigger: 'send_button'
submit_surface: 'composer_input'
is_signed_in: 1
has_text
text_length
has_files
file_count
has_hook
```

`has_hook` 和 hook 的 id、名称用 `chatHookAnalyticsPayload`。有控制图时补 `has_control_reference` 和 `control_reference_count`，从 `readyHandoffAttachments` 里 `tag === 'control_reference'` 或 `controlSource` 有值的条目数出来。

`analyticsContext` 继续放进 handoff。画布 `runAll` 已经把它放到 `analytics_context`。不要为了补事件把它从 payload 里拿掉。

「立即使用」发 `agent_skill_use_now_click`，属性里带 `skill_id`（即 `hook_id`）、`hook_category`、`trigger: 'use_now_button'`。这个事件在创建 flow 之前发。

选中一条技能时发一次选择事件，事件名 `agent_skill_pick`，属性用 `hook_id`、`hook_category`、`hook_pick_surface`、`hook_position_index`。

## 改哪些文件

1. `home-page/index.tsx` 的 `handleSend`、`handleUseSkillDirect`。
2. `home-hero-composer-v4.tsx` 或 `hook-marquee.tsx` 的选中回调。

`postHogCapture` 用现有的 `src/lib/posthog-capture.ts`。创建 flow 的 `onFailure` 和 `onError` 不发 `Create_New_Flow`。

# 补齐顺序

1. 第 1 节：mention 输入，以及发送前的 `richTextHtml` 转换。
2. 第 2 节：附件五类、槽位上报、素材库、产品控制、内容类型和工具条。
3. 第 6 节：未登录的附件和槽位先开门禁。它改的是第 2 节刚挂上的点击，所以紧跟在后面。
4. 第 4 节：Agent 三档和 `localStorage`。
5. 第 5 节：Hook / Skill 目录和 payload。时长、比例、内容类型要已经在第 2 节里。
6. 第 3 节：扩 handoff 附件字段，画布按蛇形交出去。
7. 第 7 节：失败保持 `not_started`。模型 id 用第 4 节的归一。
8. 第 8 节：发送、选中、立即使用的分析事件。

空 flow 的 `project_name: "Untitled"`、`nodes: []`、`edges: []` 不要改。`AssistantProvider` 继续只消费当前 `flowId`。
