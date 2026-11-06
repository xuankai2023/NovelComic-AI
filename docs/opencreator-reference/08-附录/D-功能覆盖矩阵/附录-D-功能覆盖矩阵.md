# 附录 D：功能覆盖矩阵

## 使用方式

本附录按“五仓现码入口 → 对应正文”反查覆盖，不把目录存在误写成现网启用。标记含义：

- `[主]`：该篇解释主链、状态或边界；
- `[辅]`：该篇提供相邻上下文；
- `[遗]`：兼容、停用、仅脚本或仍保留的旧路径。

## 一、Frontend：页面路由与浏览器运行时

- [主] 身份入口：`/sign-in`、`/auth-complete`、`/oauth-popup-start`、
  `/oauth-popup-complete`、`/sso-callback` → [01](../../01-用户入口/01-登录与JWT/01-登录与JWT.md)；
  Clerk 门禁与画布项目读取 → [02](../../01-用户入口/02-画布登录门禁与项目加载/02-画布登录门禁与项目加载.md)。
- [主] 首页与创作入口：`/`、`/$lang/$`、首页 Composer →
  [05](../../01-用户入口/03-前端应用壳首页与Composer/05-前端应用壳首页与Composer.md)。
- [主] 画布：`/canvas/`、`/canvas/$flowId`、`/canvas/view/$flowId` →
  [02](../../01-用户入口/02-画布登录门禁与项目加载/02-画布登录门禁与项目加载.md)、[06](../../01-用户入口/04-画布编辑节点预览与Remotion/06-画布编辑节点预览与Remotion.md)；
  一次 Run 的端到端回程 → [04](../../02-执行与实时回程/01-从登录到画布亮灯/04-从登录到画布亮灯.md)、
  [07](../../02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)。
- [主] 项目与工作流列表：`/projects`、`/custom-workflow` →
  [05](../../01-用户入口/03-前端应用壳首页与Composer/05-前端应用壳首页与Composer.md)、[07](../../02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)、
  [25](../../07-独立业务面/01-小程序节点块AppFlow与定制业务/25-小程序节点块AppFlow与定制业务.md)。
- [主] Agent：画布/首页 Agent 聊天运行时、SSE、恢复 →
  [08](../../02-执行与实时回程/04-Agent会话SSE与运行循环/08-Agent会话SSE与运行循环.md)；`/skills`、工具、MCP 与 skill →
  [09](../../02-执行与实时回程/05-Agent工具Skills与MCP/09-Agent工具Skills与MCP.md)。
- [主] 素材：`/assets`、上传、素材库、缩略图与媒体处理 →
  [10](../../01-用户入口/05-素材存储人脸与图像处理/10-素材存储人脸与图像处理.md)；
  画布预览与 Remotion → [06](../../01-用户入口/04-画布编辑节点预览与Remotion/06-画布编辑节点预览与Remotion.md)。
- [主] 发现与传播：首页推荐、`/skills?tab=workflow`、只读分享画布 →
  [11](../../01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)。
- [主] 付费：`/credits`、`/credits/result`、`/payment-redirect`、
  `/website-pricing-checkout` → [15](../../04-商业与外部入口/01-支付订阅积分与用量账本/15-支付订阅积分与用量账本.md)。
- [主] 开发者入口：`/developer/apikeys`、`/cli/authorize` →
  [16](../../04-商业与外部入口/02-Developer-API与CLI/16-Developer-API与CLI.md)。
- [辅] 内容生产与兼容页：`/content-production`、`/translation-notice` 及仍存在但
  非主链的前端入口 → [25](../../07-独立业务面/01-小程序节点块AppFlow与定制业务/25-小程序节点块AppFlow与定制业务.md)、
  [26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)。
- [遗] `/home`、`/templates`、`/template` 重定向到 `/`，`/workflows` 重定向到
  `/projects`；无对应产品页面的 `/pricing-test`、`/sign-up`、`/verify`、`/remotion`
  也归入 [26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)。

## 二、Publisher：HTTP、WebSocket 与接入服务

- [主] `/api/v2/auth/*`、Clerk webhook、HTTP JWT middleware →
  [01](../../01-用户入口/01-登录与JWT/01-登录与JWT.md)、[22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。
- [主] `/api/v2|v3/flow/project*`、`/api/v2|v3/result*`、项目所有权 →
  [02](../../01-用户入口/02-画布登录门禁与项目加载/02-画布登录门禁与项目加载.md)、[18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)。
- [主] `/api/v2/flow/runs` 的 start/continue/cancel/query →
  [07](../../02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)；命令到画布亮灯全链 →
  [04](../../02-执行与实时回程/01-从登录到画布亮灯/04-从登录到画布亮灯.md)。
- [主] `/api/v2/flow/runs/{flow_task_id}/events/{connection_id}` WebSocket、
  Event Store、cursor/replay → [03](../../02-执行与实时回程/03-可恢复WebSocket/03-可恢复WebSocket.md)。
- [主] `/api/v1/templates*`、`/api/v1/models*`、`/api/v2|v3/share*` →
  [11](../../01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)。
- [主] `/api/v3/agent-catalog/hooks|roles|prompt-suggestions` 与个人 skills →
  [09](../../02-执行与实时回程/05-Agent工具Skills与MCP/09-Agent工具Skills与MCP.md)、[11](../../01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)。
- [主] `/api/v2/b2b-signal/actions/*`、支付/任务 B2B 信号及周期飞书 →
  [11](../../01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)、[17](../../04-商业与外部入口/03-社交发布飞书与外部Webhook/17-社交发布飞书与外部Webhook.md)。
- [主] `/api/v1|v2/payments*`、`/usage*`、`/gift_credits*` →
  [15](../../04-商业与外部入口/01-支付订阅积分与用量账本/15-支付订阅积分与用量账本.md)。
- [主] Developer API app、API client、`/api/v1/cli/device/*` →
  [16](../../04-商业与外部入口/02-Developer-API与CLI/16-Developer-API与CLI.md)。
- [主] social auth/post、`/feishu/event`、Stripe/Clerk 等外部 webhook →
  [17](../../04-商业与外部入口/03-社交发布飞书与外部Webhook/17-社交发布飞书与外部Webhook.md)。
- [主] S3/COS presign/upload、assets、image segmentation、media face verification →
  [10](../../01-用户入口/05-素材存储人脸与图像处理/10-素材存储人脸与图像处理.md)、
  [14](../../03-AI网关/03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)。
- [主] Mongo collection/index/ownership、internal user/workflow/model-config →
  [18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)、[22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。
- [主] app-flow、node-blocks、custom-workflow；[遗] Miniapp 路由已挂但执行 consumer
  未注册、任务实现仍为 TODO →
  [25](../../07-独立业务面/01-小程序节点块AppFlow与定制业务/25-小程序节点块AppFlow与定制业务.md)。
- [遗] `/api/v1/flow/flow_task/{ws_id}`、旧 v1 flow/result/share/upload 等 →
  [26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)。
- [遗] `/api/v1/flow_template/whole/list` 仍从 Business Center 拉旧整图模板 →
  [11](../../01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)、[26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)。

## 三、Agent：SSE、会话、工具与工作流桥

- [主] `POST /v1/agent/runs` 创建 run、`GET .../events` 提供
  `text/event-stream`，以及 session/messages/feedback、取消与重连 →
  [08](../../02-执行与实时回程/04-Agent会话SSE与运行循环/08-Agent会话SSE与运行循环.md)。
- [遗] `POST /v1/agent/chat` 与旧 stop 入口返回 410，不再提供 SSE →
  [26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)。
- [主] tool registry、OpenCreator workflow tools、generation confirm、workflow select、
  MCP 与 subagent → [09](../../02-执行与实时回程/05-Agent工具Skills与MCP/09-Agent工具Skills与MCP.md)。
- [辅] Agent 调 Publisher/Consumer 的 workflow bridge 与 HITL →
  [07](../../02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)、[22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。
- [主] Agent session/run/message 的 Redis、Mongo 与共享集合 →
  [18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)。
- [主] `/health`、`/preview/active_runs`、`/preview/drain` →
  [21](../../06-安全与运维/01-观测告警健康与SLO/21-观测告警健康与SLO.md)、[23](../../06-安全与运维/03-配置部署蓝绿与排空/23-配置部署蓝绿与排空.md)。

## 四、Consumer：命令、DAG、队列与账务

- [主] `run_flow` Redis Stream、durable inbox、start/continue/cancel claim、
  DAG ready-node 推进、select/HITL → [07](../../02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)。
- [主] 文本、图像、视频、音频、音乐、克隆、运动控制等节点执行入口，
  调用 `opencreator-ai /v1/tasks` → [12](../../03-AI网关/01-AI任务契约与状态机/12-AI任务契约与状态机.md)、
  [13](../../03-AI网关/02-AI模型注册Provider与Robin/13-AI模型注册Provider与Robin.md)。
- [主] invocation、execution plan、AI callback 聚合、node/run 终态 →
  [12](../../03-AI网关/01-AI任务契约与状态机/12-AI任务契约与状态机.md)、[14](../../03-AI网关/03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)。
- [主] workflow event outbox → RabbitMQ v2 reply queue → Publisher Event Store →
  [04](../../02-执行与实时回程/01-从登录到画布亮灯/04-从登录到画布亮灯.md)、[19](../../05-数据与可靠性/02-队列Outbox并发锁与幂等/19-队列Outbox并发锁与幂等.md)。
- [主] invocation 预扣、confirm/rollback、usage_v2 与积分 →
  [15](../../04-商业与外部入口/01-支付订阅积分与用量账本/15-支付订阅积分与用量账本.md)。
- [主] flow resume、maintenance、snapshot、stale lease/lock 清扫与补偿 →
  [20](../../05-数据与可靠性/03-清扫恢复快照与补偿/20-清扫恢复快照与补偿.md)。
- [主] Funboost consumer、drainable consumer、watchdog、maintenance scheduler →
  [19](../../05-数据与可靠性/02-队列Outbox并发锁与幂等/19-队列Outbox并发锁与幂等.md)、[23](../../06-安全与运维/03-配置部署蓝绿与排空/23-配置部署蓝绿与排空.md)。
- [辅] Mongo 状态集合、唯一键和索引 → [18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)；
  callback/internal key 边界 → [22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。

## 五、AI：API、BullMQ Worker、核心注册与厂商回程

- [主] Fastify `POST /v1/tasks`、`GET /v1/tasks/:ai_task_id` 与 task contract →
  [12](../../03-AI网关/01-AI任务契约与状态机/12-AI任务契约与状态机.md)。
- [主] `CORE_MODELS`、alias、options schema、robin fallback、23 provider →
  [13](../../03-AI网关/02-AI模型注册Provider与Robin/13-AI模型注册Provider与Robin.md)、
  [附录 C](../C-Provider与模型注册清单/附录-C-Provider与模型注册清单.md)。
- [主] `POST /v1/provider-webhooks/:provider`、polling、归一化、usage、产物上传与
  Consumer callback → [14](../../03-AI网关/03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)。
- [主] BullMQ `provider-execution`、`artifact-processing`、`consumer-callback`、
  `media-face-verification` 四类 worker → [14](../../03-AI网关/03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)、
  [19](../../05-数据与可靠性/02-队列Outbox并发锁与幂等/19-队列Outbox并发锁与幂等.md)。
- [主] Mongo task/attempt/provider-event/callback-delivery，Redis queue、幂等键与索引 →
  [18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)、[19](../../05-数据与可靠性/02-队列Outbox并发锁与幂等/19-队列Outbox并发锁与幂等.md)。
- [主] `/health`、`/readyz`、Bull Board、worker heartbeat、告警与原因映射 →
  [21](../../06-安全与运维/01-观测告警健康与SLO/21-观测告警健康与SLO.md)。
- [主] config loader、reason mapping loader、SIGTERM 关闭和队列 drain →
  [23](../../06-安全与运维/03-配置部署蓝绿与排空/23-配置部署蓝绿与排空.md)。
- [遗] live/probe 脚本已有而 `CORE_MODELS` 未注册的模型、注释掉的 Youchuan Video、
  只 export 未注册的 Midjourney V8 → [24](../../06-安全与运维/04-测试脚本与架构治理/24-测试脚本与架构治理.md)、
  [26](../../06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)、[附录 C](../C-Provider与模型注册清单/附录-C-Provider与模型注册清单.md)。

## 六、跨仓契约、测试与运维

- [主] API/WS/SSE 与事件名总览 → [附录 A](../A-API路由与事件总表/附录-A-API路由与事件总表.md)。
- [主] collection、队列、worker、配置键总览 →
  [附录 B](../B-集合队列Worker与配置总表/附录-B-集合队列Worker与配置总表.md)。
- [主] 仓内 unit/integration/live 脚本、跨仓契约门禁和文档债 →
  [24](../../06-安全与运维/04-测试脚本与架构治理/24-测试脚本与架构治理.md)。
- [主] tracing/log/metrics、健康检查、SLO 缺口和飞书告警 →
  [21](../../06-安全与运维/01-观测告警健康与SLO/21-观测告警健康与SLO.md)。
- [主] env/config、容器、蓝绿、排空、关闭顺序与恢复边界 →
  [23](../../06-安全与运维/03-配置部署蓝绿与排空/23-配置部署蓝绿与排空.md)。
- [主] 用户 JWT、Developer API key、internal key、provider `auth_key`、资源所有权 →
  [22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。
- [辅] 邻接实现 `opencreator-remotion`、`opencreator-admin`、`opencreator-cut` 只在
  剪辑导出、运营目录和共享集合边界被引用 →
  [06](../../01-用户入口/04-画布编辑节点预览与Remotion/06-画布编辑节点预览与Remotion.md)、
  [18](../../05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)。

## 七、01–26 反向覆盖检查

- [x] 01 登录/JWT：Frontend 身份入口、Publisher auth/JWT。
- [x] 02 画布门禁/项目：画布路由、flow project/result。
- [x] 03 可恢复 WebSocket：Publisher v2 run event socket。
- [x] 04 端到端亮灯：Frontend → Publisher → Consumer → AI → 回程。
- [x] 05 应用壳/首页/Composer：首页、语言壳和创作入口。
- [x] 06 画布/节点/预览/Remotion：编辑器与预览运行时。
- [x] 07 工作流/DAG/HITL：run 命令、Consumer 状态推进。
- [x] 08 Agent/SSE：run/chat SSE、session、cancel、reattach。
- [x] 09 Agent tools/skills/MCP：工具调用与外部能力。
- [x] 10 素材/对象存储/媒体：assets、S3/COS、媒体处理。
- [x] 11 模板/模型目录/分享：公开发现与增长入口。
- [x] 12 AI task contract/state：Consumer 与 AI 的任务边界。
- [x] 13 registry/provider/robin：核心模型注册与 fallback。
- [x] 14 polling/webhook/artifact/callback：AI 完成与回调链。
- [x] 15 支付/积分/usage：Stripe 与 invocation billing。
- [x] 16 Developer API/CLI：两类机器入口和凭证。
- [x] 17 社交/飞书/webhook：外部平台进出站。
- [x] 18 collection/index/ownership：五仓持久状态。
- [x] 19 queue/outbox/lock/idempotency：Redis、RabbitMQ、BullMQ。
- [x] 20 sweep/recovery/snapshot/compensation：恢复和清扫。
- [x] 21 observability/health/SLO：日志、指标、告警和健康。
- [x] 22 security/tenant/internal auth：身份与资源边界。
- [x] 23 config/deploy/drain：启动、发布和优雅退出。
- [x] 24 tests/governance：测试层级与跨仓门禁。
- [x] 25 miniapp/node-block/AppFlow/custom：定制业务面，其中 Miniapp 明确标为执行链未启用。
- [x] 26 legacy/compatibility/unwired/debt：旧链和未注册能力。
