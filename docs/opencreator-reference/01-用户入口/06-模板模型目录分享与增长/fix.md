# 模板、模型目录、分享与增长：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-consumer`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-consumer`。

不在这一段：登录换 JWT、Clerk `unsafe_metadata.inviteCode`、`user.created` 绑定邀请、注册奖和付费奖写入可花余额、`user/info` 的 `invite_link_path`。这些在登录清单。首页 Composer 的 Agent 三档下拉、Hook 技能条和个人 Skill CRUD 也不在这一段。模型能不能真执行看 AI registry，不看这一段的目录。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是 import、日志和类怎么拆。

- `GET /api/v1/models/*` 在 JWT 白名单里。`config_name=all` 读库里的全部节点类型。未知 `group` 是 HTTP 400
- 下拉分组是 `atom`、`text_to_image`、`image_to_image`、`text_to_video`、`image_to_video`、`all_round_video`。同组先按厂牌顺序，再按 `sort_in_brand`，再按 `released_at` 从早到晚。没配厂牌的排在最后
- 内部 upsert、delete 写 Mongo 后刷新 `model_config:{config_name}` 和 `model_config:__all__`。刷新失败只打日志，不回滚 Mongo。只改排序字段不刷新这份 Redis，也不改 `pricing`
- `CloudModelDataSync` 挂在应用壳和只读壳
- 创建分享要登录，只能分享自己的 `flow_id`。空白名单是公开。`allow_reshare` 默认 `true`。创建时写下当时的 nodes、edges、项目名，之后改原项目不改旧链接
- `GET` 分享 info 不要求 JWT。`POST` V3 visit 要求登录
- 模板卡片有 `origin_flow_id` 和 `share_id` 时，链接是 `/canvas/view/{origin_flow_id}?shareid={share_id}&source=template`
- Use 成功后 `parent_flow_id` 是来源 `flow_id`，跳到 `/canvas/{newFlowId}?from_template=1`
- `GET /api/v3/agent-catalog/*` 在白名单里。hooks、roles 只出 `status=published`。hooks 用 `hook_type` 区分 `director_seeds` 和 `viral_hooks`
- 邀请规则的数字已经是注册 200、上限 10 人、付费 1000、窗口 7 天。入账进可花余额仍归登录清单，这一段不要重写 `add_topup_credits`
- `/?invite=` 会进本地，30 天后过期。过期再读会清空

# 1. 模板市场三口要能匿名读已发布记录

做完要达到：未登录打开模板列表、分类和单条详情，只看到 `status=published`。草稿不出现。列表按运行量、拉新付费和最新模板穿插。近 7 天运行量增长至少 5 的卡片带 `is_trending`。

## 现在

Publisher 只有 `app/schemas/template.py`。没有 DAO、Service、Controller，也没有响应体。`routers.py` 不挂 `/api/v1/templates`。`WHITE_LIST` 没有 `/api/v1/templates/*`。

前端 `fetchTemplatesPage()`、`fetchTemplateCategories()`、`fetchTemplateById()` 已经在打这三口，而且不带 JWT。中间件先返回 401，到不了 404。首页分类轨和 `/skills` 模板列表因此是失败，不是空列表。

OpenCreator 三口公开。查询带 `status=published`，投影去掉 `embedding`。`sort_by` 接到 DAO 但不用。固定顺序是：

1. `run_count = 最新 stats_total + stats_boost.run_count`，全量降序
2. `acquired_paid_total_amount` 前 10 放到最前
3. 其余按 `updated_at` 取最多 10 条最新
4. 剩下的按 `run_count`，每 3 条插 1 条最新
5. 插不完的最新追加到末尾，再按页切片

`is_trending` 在分页之后算。最新日 `run_count` 减去不超过 7 天前那条，差至少 5 才是 `true`。不足两条、日期解析失败、找不到 7 天前记录，都是 `false`。分类计数缓存 60 秒。一级、二级按 `(template_id, category)` 去重。详情不存在是 not found。

## 改哪些文件

1. 新增 `novelcomic-publisher/app/schemas/response_schemas/template/__init__.py`，对照 OpenCreator `schemas/response_schemas/template/__init__.py`。响应带 `run_count`、`is_trending`、`category_counts`、`recommend_count`。
2. 新增 `novelcomic-publisher/app/dao/template.py`，对照 OpenCreator `dao/template.py` 的 `get_template_page()`、`get_template_by_id()`、分类计数和 trending。
3. 新增 `novelcomic-publisher/app/services/template/template_service.py`。分类计数缓存 60 秒。
4. 新增 `novelcomic-publisher/app/controller/v1/template.py`。三口都不取 `get_authenticated_user`。
5. `novelcomic-publisher/app/controller/routers.py` 挂 `/api/v1/templates`。
6. `novelcomic-publisher/app/middleware/auth_middleware.py` 把 `/api/v1/templates/*` 放进白名单。

集合继续用 NovelComic 已经在用的库。不要为了集合名再开一套。

# 2. `/skills` 和首页轨用这三口

做完要达到：`/skills` 缺省是 Agent 页。`?tab=workflow` 才是模板市场，滚到底自动加载，搜索停 300 毫秒再请求。首页是一条可切换分类的模板轨，第一页 10 条。导航进首页就预取分类。

## 现在

`routes/skills.tsx` 缺省 `tab=workflow`。OpenCreator 缺省是 `agent`，只有 `tab=workflow` 才进模板。NovelComic 的 `AgentSkillsPage` 只有 Workflow 和「个人技能资产」，没有 `directors` / `hooks` / `mine`。个人 Skill CRUD 仍不在这一段。这里要补的是缺省页签，以及 workflow 列表本身。

`template_list.tsx` 的 `pageSize` 是 20，但是「加载更多」按钮。搜索每个字都打 `/page`。OpenCreator 的 workflow 网格同样 20 条，距底 360 像素自动加载，搜索 debounce 300 毫秒。点卡片先开预览。NovelComic 卡片是直接跳转，预览是旁边的按钮。

首页 `home-page/index.tsx` 挂的是 `CategoryTemplateRow`：最多 3 个一级分类，每轨第 1 页 5 条。「查看全部」带 `?category=`，`/skills` 和 `TemplateList` 都不读这个参数。OpenCreator 首页挂的是 `home-workflow-skills-row.tsx`，一条轨，第 1 页 10 条，能切一级和二级。`category-template-row.tsx` 在 OpenCreator 里没有挂到首页。首页 Composer 那一节明确不搬这条轨，所以补在这一段。

`api/queries/templates.ts` 只有 12 小时 `staleTime`，没有 24 小时 `gcTime`。无限列表不走这份缓存。没有 `navbar.tsx`。`home-layout.tsx` 不预取分类。

`lib/template-i18n.ts` 的回退是当前语言、`zh`、`en`。OpenCreator 是当前语言、再 `en`。没有 `getTemplateType()`。

`/miniapp/` 改站内路径已经在 `lib/template-links.ts`。OpenCreator 未登录点 miniapp 会先开登录。NovelComic 直接进站内路径。

## 改哪些文件

1. `novelcomic-frontend/src/api/modules/templates.ts`：三口走不带业务 JWT 的公开请求。`/{template_id}` 的 404 返回 `null`，不要抛成页面错误。
2. `novelcomic-frontend/src/api/queries/templates.ts`：`staleTime` 12 小时，`gcTime` 24 小时。首页轨 query 是第 1 页 10 条。
3. `novelcomic-frontend/src/routes/skills.tsx`：缺省 `tab=agent`。`tab=workflow` 才渲染模板市场。读 `l1`、`l2`。
4. `novelcomic-frontend/src/features/agent-skills/components/AgentSkillsPage.tsx`：workflow 页签用无限滚动和 300 毫秒搜索。点卡片先开预览。`is_trending` 显示热门。
5. `novelcomic-frontend/src/components/home/home-page/index.tsx`：换成和 OpenCreator `home-workflow-skills-row.tsx` 一样的一条可切换分类轨。不要再挂最多 3 条、每条 5 个的 `CategoryTemplateRow`。
6. `novelcomic-frontend/src/lib/template-i18n.ts`：名称和描述按当前语言，缺了再用 `en`。补 `getTemplateType()`。
7. 首页导航预取 `categories`，再预取第一个一级分类的首页轨。预取失败不影响进画布。

`source=template` 写入注册 metadata 仍归登录清单。

# 3. 节点下拉读目录，失败时退回本地模型表

做完要达到：画布节点上的下拉按节点类型取一组模型，选中的是 `model_id`。公开 list 和 dropdown-order 用同一份 Mongo。接口失败或顺序解析失败时，下拉仍是本地完整目录，不是只剩一条内置模型。人停在页面上，大约 5 分钟会再拉一次。

## 现在

`app/dao/model_config.py` 读集合 `model_configs`。OpenCreator 读 `model_config`。`app/services/model_config.py` 的 `list_all()` 会把内置 `kie-image-v1` 合并进公开列表。Mongo 为空时 list 仍有这一条，dropdown-order 的 6 组仍是空的。这条内置不进 Redis。删不掉库里不存在的记录，list 还会再补回来。

内部 upsert 的 `pricing` 可以省略。OpenCreator 缺 `pricing` 是 422。

前端 `constants/cloudModelData.ts` 的本地表只有 `{ id: 'kie-image-v1', label: 'KIE Image' }`。请求失败或远程为空时，`useEnrichedModelsData()` 就停在这一条。OpenCreator 的列表转换结果是空对象时退回本地 `cloudModelData`，节点下拉真正用的是按节点类型分好的本地目录，云端只覆盖同 id 的展示名和价格。顺序转换失败返回 `null`，该类保持本地原序。没有 `brand` 的模型不参加云端顺序。

`useCloudModelDataQuery.ts` 的 5 分钟只判断模块缓存。没有定时刷新，也没有回到窗口再拉。OpenCreator 的 list 和 dropdown-order 都是 5 分钟刷新。

`ModelSeletion.tsx` 没有任何画布节点引用。画布上没有模型下拉。首页 Composer 现在读的是这份扁平 `group=all`，那一处改成 Agent 三档，归首页清单，这一段不要再改首页下拉。

## 改哪些文件

1. `novelcomic-publisher/app/dao/model_config.py`：公开读写的集合名改成 `model_config`。
2. `novelcomic-publisher/app/services/model_config.py`：公开 list 和内部 list 都不要合并内置 `kie-image-v1`。库里没有就是空。dropdown-order 继续只读 Mongo。
3. `novelcomic-publisher/app/schemas/request_schemas/model_config_request.py`：`pricing` 必填。
4. `novelcomic-frontend/src/constants/cloudModelData.ts`、`src/constants/modelDropdownOrder.ts`：对照 OpenCreator 同名文件。空列表退回本地目录。顺序解析失败是 `null`。
5. `novelcomic-frontend/src/hooks/useCloudModelDataQuery.ts`、`src/hooks/useModelDropdownOrderQuery.ts`：5 分钟刷新。`useEnrichedModelsData()` 先按节点类型取本地目录，再用对应 group 重排。
6. `novelcomic-frontend/src/features/canvas-workflow/components/custom_nodes/components/ModelSeletion.tsx`：对照 OpenCreator 同名文件，挂到会选模型的节点上。选中值是 `model_id`。不在列表里的已选 id 仍显示出来。这个组件不发 AI 请求。

# 4. 分享 info 在有白名单时仍返回快照，V2 visit 不验白名单

做完要达到：作者分享自己的项目，链接是 `/canvas/view/{flow_id}?shareid={12位share_id}`。公开 info 不登录也能拿到创建时的 nodes 和 edges。`need_auth` 只表示白名单非空。`flow_is_me` 在 info 上固定 `false`。V3 visit 要登录，邮箱精确匹配、区分大小写。V2 visit 只给画布内克隆用，不验白名单。

## 现在

`POST /api/v3/share` 返回 201 和整份对象。`share_id` 是 `uuid4().hex`，32 位。`share_type` 默认 `workflow`，还可以选 OpenCreator 面板写不出来的类型。白名单会 `strip`、转小写、去重，最多 100 个。

`GET /api/v3/share/{share_id}/info` 在白名单非空时把 `snapshot` 设成 `null`。OpenCreator 的 `GET /api/v3/share/info?share_id=` 仍返回 `flow.nodes` 和 `flow.edges`，只把 `need_auth` 设为 `true`。`flow_is_me` 固定 `false`。老数据没有白名单时 `allow_reshare=true`，`share_type=null`。

`POST /api/v3/share/{share_id}/visit` 先把邮箱转小写再比。不在名单里是 HTTP 403。OpenCreator 是 `POST /api/v3/share/visit`，邮箱原样精确匹配。不在名单里是业务码 5001。

`POST /api/v2/share/visit` 复用了上面的 `visit_share()`，所以也会验白名单。OpenCreator 的 `visit_share_flow()` 不验白名单，只回 `flow`、`project_name`、`flow_is_me`。

创建者邮箱在 OpenCreator 里按原样补进白名单。NovelComic 先转小写。`Visitor@X.com` 写进名单、账号是 `visitor@x.com` 时，OpenCreator 进不去，NovelComic 能进。

## 改哪些文件

1. `novelcomic-publisher/app/schemas/request_schemas/share/create_share_request.py`：`share_type` 只接受 `app_only`、`app_and_workflow`、`collaborative`，可以空。白名单保持请求里的大小写。空或 `null` 表示公开。
2. `novelcomic-publisher/app/services/share.py`：`generate_share_id()` 改成 12 位。info 在 `need_auth` 时仍返回快照。V3 visit 区分大小写。另留一个不验白名单的 V2 visit。
3. `novelcomic-publisher/app/controller/v3/share.py`：路径改成 `POST ""`、`POST /visit`、`GET /info`。创建成功的 `data` 是 `share_id` 字符串。info 带 `flow`、`project_name`、`flow_is_me=false`、`allow_reshare`、`need_auth`、`share_type`。
4. `novelcomic-publisher/app/controller/v2/share.py`：`POST /visit` 走不验白名单的那条。
5. `novelcomic-publisher/app/middleware/auth_middleware.py`：公开的是 `GET /api/v3/share/info`，不是现在的 `GET /api/v3/share/*/info`。
6. `novelcomic-frontend/src/api/modules/flow.ts`、`src/api/modules/share.ts`、`src/features/canvas-workflow/hooks/flow/use-flow-share.tsx`：创建、info、V3 visit、V2 visit 的路径和字段跟上面一致。info 用公开客户端，不带业务 JWT。

别人的项目仍然不能分享。源项目后来改节点，旧 `share_id` 仍返回创建时的图。

# 5. 只读页停在登录墙，复制和克隆都清掉运行态

做完要达到：公开链接不登录能看见只读快照。有白名单时只读页停在登录按钮，不画出节点。登录后刷新，visit 通过之前仍然不画。缺 `shareid` 回首页。`/canvas/?shareid=` 已登录后，自己的图去编辑页，别人的图去只读页。Use、只读页 Copy、画布内克隆都清掉 `status` 和 `generated_data`，并把 `describeImage` 改成 `textGenerator`。克隆把节点追加进当前图，不新建项目。

## 现在

`components/share/share.tsx` 只打 info，不打 visit。没有 `shareid` 停在「Missing shareid.」，不回首页。已登录靠 `owner_user_id` 分流。OpenCreator 已登录直接 V3 visit，用 `flow_is_me` 决定去编辑页还是只读页。不在白名单就停在落地页。

`canvas.view.$flowId.tsx` 没有 `shareid` 时是错误页。`need_auth` 且没有 snapshot 才停在登录。登录后会 V3 visit，在名单里就画出图。`share_type=collaborative` 且已登录时，只读路由可以改。节点不改成 `status=idle`，也不清空 `generated_data`。OpenCreator 只读页无条件 `setIsReadonly(true)`。`need_auth` 就停住，登录后 reload 仍先看 info，通过 visit 之前不渲染图。节点写成 `status=idle`、`generated_data={}`，`describeImage` 改成 `textGenerator`。`share_type` 空时按 `app_and_workflow`。

`/canvas/$flowId` 不读 `shareid`。OpenCreator 发现 `?shareid=` 会立刻换到只读页。

`use-copy-template.ts` 的 `buildTemplateSaveData()` 用快照项目名，不加 `_copy`。`sanitizeTemplateNode()` 是删掉 `status` 和 `generated_data`，不是写成 idle，也不改节点类型。OpenCreator 的预览 Use 和只读 Copy 项目名是 `{名称}_copy`，数据来自 info 或当前 store。只读顶栏 Copy 前会再打一次 V3 visit，失败仍用页上已有节点。

`provider/useConfig.tsx` 的 `cloneTemplateToFlow()` 走 V2 visit。没有任何页面调用 `useConfig()`。OpenCreator 的空画布模板弹窗、模板工具和 Creator Skills 都把 `share_url` 交进来，换新 id 后追加到当前画布，不调用 `postSaveFlow`。

画布里已经有 `ShareDialog`。首页最近项目和项目列表没有分享入口。`allow_reshare=false` 时 OpenCreator 不显示分享。NovelComic 顶栏一直显示。分享面板默认类型是 `workflow`，能选出四种。OpenCreator 面板写死 `app_and_workflow`。

## 改哪些文件

1. `novelcomic-frontend/src/components/share/share.tsx`、`src/routes/canvas.index.tsx`：对照 OpenCreator `components/share/share.tsx`。缺 `shareid` 回首页。已登录先 visit。
2. `novelcomic-frontend/src/routes/canvas.view.$flowId.tsx`：缺 `shareid` 回首页。`need_auth` 停在登录，不画图。节点按 OpenCreator `formatNodes()` 清运行态。页面保持只读。
3. `novelcomic-frontend/src/routes/canvas.$flowId.tsx`：带 `shareid` 时换到 `/canvas/view/{flowId}`，保留查询参数。
4. `novelcomic-frontend/src/components/home/template/items/template_preview_modal.tsx`、`workflow_preview_panel.tsx`：预览和 Use 读公开 info。未登录先记 `use-template-preview`，登录后再复制。项目名加 `_copy`。
5. `novelcomic-frontend/src/features/canvas-workflow/hooks/flow/use-copy-template.ts`：只读页 Copy 复制当前已加载的图，项目名加 `_copy`。清运行态的规则和只读页相同。
6. `novelcomic-frontend/src/provider/useConfig.tsx`：`cloneTemplateToFlow(share_url)` 走 V2 visit，换新 id，追加进当前画布，不 `postSaveFlow`。
7. 三个调用点对照 OpenCreator：`template_modal.tsx`、`template_tools.tsx`、`creator-skills-panel.tsx`。
8. `novelcomic-frontend/src/components/share/share-panel.tsx`：类型固定 `app_and_workflow`。`allow_reshare=false` 时不显示分享。首页最近项目和项目列表能打开同一块面板。

`GET /api/v3/app-flow/{flow_id}` 没有记录时继续返回 `data=null`。`app_only` 和 `app_and_workflow` 在已登录的编辑路由上补读它。没有 App 记录时，workflow 快照仍然能开。

# 6. Share & Earn 能打开，外链指向现在的地址

做完要达到：导航和画布聊天都能打开 Share & Earn。邀请页复制 `origin + invite_link_path`，并能翻被邀请人和积分明细。社媒打开 Discord。未付费点 Affiliate 打开订阅；已付费打开飞书表单。Affiliate 登录打开 Rewardful。

## 现在

`share-earn-modal.tsx` 只在测试里出现。导航和画布没有入口。弹窗是一页，没有邀请、社媒、现金三个页签，也不拉明细。

三个地址是 `https://discord.com`、`https://www.feishu.cn`、`https://www.rewardful.com`。OpenCreator 是：

- Discord：`https://discord.gg/rRKngTWjt6`
- Affiliate 申请：`https://ocnww54ffp6t.feishu.cn/share/base/form/shrcnZWPfUeouBP9Z0V7IWJvczc`
- Affiliate 登录：`https://opencreator.getrewardful.com/login`

复制用的是本地拼出来的 `/?invite={inviteCode}`。OpenCreator 复制 `origin + invite_summary.invite_link_path`。`invite_link_path` 由登录清单补进 `user/info`。这一段只消费它。

明细接口现在是 `GET /api/v2/user/invitees` 和 `GET /api/v2/user/invite-credits`。OpenCreator 是 `GET /api/v2/user/invite/invitees` 和 `GET /api/v2/user/invite/credits`，每页 10 条。被邀请人有邮箱和注册时间。积分记录的 `reward_type` 是 `signup_reward`、`payment_reward`，金额字段是 `credits_amount`，只列已经入账的。

埋点是 `window` 上的 `novelcomic:share-earn`。OpenCreator 走 PostHog：`share_earn_entry_impression`、`entry_click`、`modal_open`、`growth_intent_click`。

邀请码现在是 `NC` 加 `sha1(user_id)` 前 8 位，入站再转大写。`InviteCodeTracker` 只在挂载时读一次 URL，路由后再出现 `?invite=` 不会重写。OpenCreator 的码是 8 位，大小写原样，搜索参数一变就重写本地值。

## 改哪些文件

1. `novelcomic-publisher/app/services/invite.py`、`app/dao/invite.py`：邀请码改成和 OpenCreator 一样的 8 位，查找精确匹配。摘要里的链接路径是 `/?invite={code}`。两份明细改到 `/api/v2/user/invite/invitees` 和 `/api/v2/user/invite/credits`。
2. `novelcomic-publisher/app/controller/v2/user.py`：分页字段能被下面的弹窗读到。不要在这一节把积分写入可花余额。
3. `novelcomic-frontend/src/lib/invite-code.ts`、`src/components/InviteCodeTracker.tsx`：搜索参数变化就写入。只 `trim`，不转大写。30 天过期保持不变。
4. `novelcomic-frontend/src/components/home/navbar/items/share-earn-modal.tsx`、`share-earn-analytics.ts`：三个页签、两条明细分页、上面的三个外链。埋点走现有 PostHog。
5. 首页导航和画布聊天面板挂上这个弹窗。对照 OpenCreator `openclaw-entry.tsx` 和 `chat-panel.tsx` 的打开方式。

注册 body 带 `invite_code`、写入 Clerk、`user.created` 里调用入账，仍按登录清单。

# 7. Agent 公开目录按 sort_order 升序，并带上推荐位

做完要达到：未登录能读到已发布 hooks 和 roles。同一批数据的顺序是 `sort_order` 升序。hooks 能按标题搜索，能按 `placement` 取推荐位，`exclude_ids` 最多 100 个。roles 一次返回该分类下的全部已发布项。`prompt-suggestions` 能按推荐位返回。

## 现在

`app/services/agent_catalog.py` 的 `_paginate()` 按 `(sort_order, published_at)` 降序。OpenCreator 是 `sort_order` 升序，再按 `updated_at` 降序。有 `placement` 时先按该推荐位的顺序。

`controller/v3/agent_catalog.py` 的 hooks 只有 `hook_type`、`page_number`、`page_size`、`exclude_ids`。没有 `q`、`placement`、`limit`，`exclude_ids` 也没有 100 个上限。roles 是分页，没有 `category`。没有 `GET /api/v3/agent-catalog/prompt-suggestions`。

OpenCreator hooks 的查询名是 `page`、`page_size`。`limit` 会盖过 `page_size`。`q` 搜标题、描述、标签、场景。roles 不分页，`category` 是 `creative_film`、`socia_feed`、`commercial_ad`。

前端 `director-seeds` 和 `viral-hooks` 已经按 `hook_type` 过滤。分页参数和返回字段要跟着后端改。角色库继续只调 roles。

## 改哪些文件

1. `novelcomic-publisher/app/dao/agent_catalog.py`、`app/services/agent_catalog.py`、`app/controller/v3/agent_catalog.py`：对照 OpenCreator 同名文件。只查 `published`。`exclude_ids` 超过 100 个按 OpenCreator 拒绝。
2. `novelcomic-frontend/src/api/modules/agent-catalog-pagination.ts`、`src/api/modules/agent-catalog.ts`。
3. `novelcomic-frontend/src/features/director-seeds/api.ts`、`queries.ts`：`hook_type=director_seeds`。
4. `novelcomic-frontend/src/features/viral-hooks/api.ts`、`queries.ts`：`hook_type=viral_hooks`。
5. `novelcomic-frontend/src/components/home/home-page/items/composer/avatar-picker/avatar-library-queries.ts`：继续调 roles。

选中一条 hook 或 role，只把文案和封面交给后面的 Agent 输入。这一步不运行 Agent。

# 8. B2B 按九条组合信号弹订阅窗，发失败不挡支付和 run

做完要达到：登录、商业化开关打开、当前没有升级弹窗时，每 60 秒拉一次待展示动作。拿到的是一条订阅弹窗，打开后立刻标记 shown。同一 `action_id` 这次页面生命周期只处理一次。接口失败不挡住别的升级入口。支付成功、任务开始、扣费会写出事件。事件写失败只打日志，订单和 run 仍然成功。

## 现在

规则只有一条：事件里同时有 `flow_task_started` 或 `credits_deducted`，以及 `payment_succeeded`，就建 `b2b_upgrade_consultation`。标题是「团队创作加速包」，CTA 是 `https://www.feishu.cn`，7 天过期。没有企业邮箱、复购、首单 49 美元、活跃 7 天或 9 天、积分消耗速度。

接口是 `GET /api/v2/b2b-signal/pending`，返回数组；`POST /api/v2/b2b-signal/shown`，body 带 `action_id`。找不到是 404。OpenCreator 是 `GET /api/v2/b2b-signal/actions/pending-upgrade-popup`，返回一条或空；`POST /api/v2/b2b-signal/actions/{action_id}/shown`，找不到仍是 200，`updated` 为 `false`。

`B2BUpgradeSignalSync` 一登录就拉，弹出自己的咨询卡。没有商业化开关，没有 60 秒轮询。OpenCreator 的 `checkB2BUpgradePopupAction()` 打开订阅弹窗，`triggerSource` 是 `b2b_signal_{composite_signal_key}`。

Consumer `tasks/flow.py` 写了 `emit_flow_task_started()`，`run_flow` 没有调用它。`tasks/usage.py` 会写 `credits_deducted`，但 consumer 的 `emit_event()` 只插入事件，不评估、不建动作。Publisher `dao/flow.py` 没有 `create_flow_task`，也不会发 `flow_task_started`。

OpenCreator 会发事件的位置：

- Publisher `dao/flow.py` 的 `create_flow_task()`：`flow_task_started`
- Consumer `tasks/flow.py` 的 `run_flow` 开始：再发一次 `flow_task_started`
- Consumer `tasks/usage.py` 扣费成功：`credits_deducted`
- Checkout 一次性支付，以及订阅成功：`payment_succeeded`

组合信号按这个顺序，前一条成立就用前一条：

| key | 条件 | 弹窗 | 飞书 |
| --- | --- | --- | --- |
| `active_7_repurchase_first_order_49` | 活跃至少 7 天，复购，首单至少 49 美元 | 无 | 立刻 |
| `active_9_repurchase` | 活跃至少 9 天，复购 | 无 | 立刻 |
| `repurchase_first_order_49` | 复购，首单至少 49 美元 | 无 | 立刻 |
| `active_7_first_order_49` | 活跃至少 7 天，首单至少 49 美元 | 有 | 7 天后，已经自行升订阅则跳过 |
| `repurchase_enterprise_email` | 复购，企业邮箱 | 无 | 立刻 |
| `first_order_49_enterprise_email` | 首单至少 49 美元，企业邮箱 | 无 | 立刻 |
| `active_7_repurchase` | 活跃至少 7 天，复购 | 有 | 立刻 |
| `repurchase_credit_high_speed` | 复购，最近积分包 7 天内消耗至少 80% | 有 | 7 天后 |
| `repurchase_credit_mid_speed` | 复购，最近积分包 8 到 30 天内消耗至少 80% | 有 | 立刻 |

拉 pending 时重算。信号已经不成立就标 `skipped`，不弹。

## 改哪些文件

1. `novelcomic-publisher/app/services/b2b_signal/rules.py`、`service.py`、`feishu_client.py`、`instrumentation.py`：对照 OpenCreator 同名文件。弹窗和飞书按上表。
2. `novelcomic-publisher/app/controller/v2/b2b_signal.py`：两口改成 OpenCreator 的路径。都按当前 `user_id` 查。
3. `novelcomic-publisher/app/dao/flow.py`：v1 `create_flow_task` 发 `flow_task_started`。没有这条 v1 创建时，不要为了发事件新开一套建任务。
4. `novelcomic-publisher` 里已经在处理支付成功的 Checkout 和 `SubscriptionSucceedProcessor.py`：成功后发 `payment_succeeded`。发失败只打日志。
5. `novelcomic-consumer/app/tasks/flow.py`：`run_flow` 开始时发 `flow_task_started`。v2 run 不经过 Publisher 的 `create_flow_task`，这一次要单独接。
6. `novelcomic-consumer/app/tasks/usage.py`、`app/services/b2b_signal/service.py`：扣费发 `credits_deducted`，并发起和 Publisher 相同的评估。写失败只打日志，不让扣费失败。
7. `novelcomic-frontend/src/api/modules/b2b-signal.ts`、`src/features/billing/runtime/useUpgrade.tsx`：对照 OpenCreator。`B2BUpgradeSignalSync` 不再弹咨询卡。

`shown` 只改 action，不改订单，也不取消 run。

# 验收

按这个顺序看。前一条没过，先不要改后面的文件。

1. 未登录打开 `GET /api/v1/templates/page` 和 `/categories/list`，只有 published。草稿不出现。近 7 天运行量增长至少 5 的记录 `is_trending` 为 true。
2. `/skills` 缺省是 Agent。`?tab=workflow` 滚到底会继续加载。首页是一条 10 条的分类轨，和导航预取用的是同一套分类。
3. 卡片有 `origin_flow_id` 和 `share_id` 时进入只读页。点 Use 得到新的 `flow_id`，项目名以 `_copy` 结尾，节点上的运行状态被清掉。
4. `GET /api/v1/models/list?config_name=all` 和 `dropdown-order?group=all` 都能匿名读。空库两口都空，不出现内置 `kie-image-v1`。节点下拉按这个顺序显示。接口失败时仍是本地目录。
5. 作者只能分享自己的项目。`share_id` 是 12 位。旧链接看到的是创建时的图。
6. 无白名单可以不登录看 info，并且 info 里有 nodes 和 edges。有白名单时只读页停在登录。visit 邮箱大小写不一致会被拒绝。`POST /api/v2/share/visit` 不看白名单。
7. `/canvas/?shareid=` 把 owner 送到编辑页，把其他人送到只读页。缺 `shareid` 的只读地址回首页。
8. 编辑画布里的模板入口把快照节点追加进当前图，不新建项目。
9. Share & Earn 能复制 `origin + /?invite={code}`。Discord 和 Affiliate 打开这一节写明的地址。邀请积分进可花余额仍用登录清单验收。
10. 未登录能读 published hooks 和 roles，顺序是 `sort_order` 升序。`exclude_ids` 第 101 个不会被静默吃掉。
11. B2B pending 只返回当前用户的一条订阅弹窗。shown 之后同一 action 不再弹出。发事件抛错时，支付和任务仍然成功。
