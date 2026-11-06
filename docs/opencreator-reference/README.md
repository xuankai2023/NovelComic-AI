# OpenCreator 核心五仓现码参考

这组文档盘点 `opencreator-frontend`、`opencreator-publisher`、
`opencreator-consumer`、`opencreator-ai`、`opencreator-agent` 的当前实现。它是现码参考，
不是 NovelComic 的实现方案；目录存在、脚本存在和现网主链会被明确区分。涉及剪辑、
运营目录或共享数据边界时，会引用 `opencreator-remotion`、`opencreator-admin`、
`opencreator-cut` 等邻接实现，但不把它们计入核心五仓。

文件夹从上到下就是书写顺序。每一段做完再进下一段。文件名上的 01–26 是原来的正文编号，用来和附录互查，不表示该先写哪一篇。

快速通读只看正文 01、04、07、12、14、15、19、22、23、26。查接口、集合或模型时直接看 `08-附录`。

容易被主链图省略、但本目录仍覆盖的启用能力包括：Agent Catalog/个人 Skill、B2B
升单信号与周期飞书、Developer API、CLI、社交发布、素材人脸旁路、节点块、AppFlow
和定制订单。Miniapp 路由虽已挂载，但执行 consumer 未注册，因此归入未完成链路。

## 01 用户入口

先理解登录、项目、应用壳、画布、素材和公开发现面。

- [01 登录与 JWT](./01-用户入口/01-登录与JWT/01-登录与JWT.md)
- [02 画布登录门禁与项目加载](./01-用户入口/02-画布登录门禁与项目加载/02-画布登录门禁与项目加载.md)
- [05 前端应用壳、首页与 Composer](./01-用户入口/03-前端应用壳首页与Composer/05-前端应用壳首页与Composer.md)
- [06 画布编辑、节点预览与 Remotion](./01-用户入口/04-画布编辑节点预览与Remotion/06-画布编辑节点预览与Remotion.md)
- [10 素材、存储、人脸与图像处理](./01-用户入口/05-素材存储人脸与图像处理/10-素材存储人脸与图像处理.md)
- [11 模板、模型目录、分享与增长](./01-用户入口/06-模板模型目录分享与增长/11-模板模型目录分享与增长.md)

## 02 执行与实时回程

再跟一次 workflow run、可恢复 WebSocket，以及独立的 Agent SSE 链。

- [04 从登录到画布亮灯](./02-执行与实时回程/01-从登录到画布亮灯/04-从登录到画布亮灯.md)
- [07 工作流命令、DAG 与 HITL](./02-执行与实时回程/02-工作流命令DAG与HITL/07-工作流命令DAG与HITL.md)
- [03 可恢复 WebSocket](./02-执行与实时回程/03-可恢复WebSocket/03-可恢复WebSocket.md)
- [08 Agent 会话、SSE 与运行循环](./02-执行与实时回程/04-Agent会话SSE与运行循环/08-Agent会话SSE与运行循环.md)
- [09 Agent 工具、Skills 与 MCP](./02-执行与实时回程/05-Agent工具Skills与MCP/09-Agent工具Skills与MCP.md)

## 03 AI 网关

从任务契约进入模型注册、robin fallback、provider 完成和 Consumer callback。

- [12 AI 任务契约与状态机](./03-AI网关/01-AI任务契约与状态机/12-AI任务契约与状态机.md)
- [13 AI 模型注册、Provider 与 Robin](./03-AI网关/02-AI模型注册Provider与Robin/13-AI模型注册Provider与Robin.md)
- [14 AI 提交、轮询、Webhook、产物与回调](./03-AI网关/03-AI提交轮询Webhook产物与回调/14-AI提交轮询Webhook产物与回调.md)

## 04 商业与外部入口

区分用户计费、Developer API/CLI 和第三方平台回调。

- [15 支付、订阅、积分与用量账本](./04-商业与外部入口/01-支付订阅积分与用量账本/15-支付订阅积分与用量账本.md)
- [16 Developer API 与 CLI](./04-商业与外部入口/02-Developer-API与CLI/16-Developer-API与CLI.md)
- [17 社交发布、飞书与外部 Webhook](./04-商业与外部入口/03-社交发布飞书与外部Webhook/17-社交发布飞书与外部Webhook.md)

## 05 数据与可靠性

连接集合所有权、队列/outbox/锁，以及清扫恢复。

- [18 数据集合、索引与所有权](./05-数据与可靠性/01-数据集合索引与所有权/18-数据集合索引与所有权.md)
- [19 队列、Outbox、并发锁与幂等](./05-数据与可靠性/02-队列Outbox并发锁与幂等/19-队列Outbox并发锁与幂等.md)
- [20 清扫、恢复、快照与补偿](./05-数据与可靠性/03-清扫恢复快照与补偿/20-清扫恢复快照与补偿.md)

## 06 安全与运维

检查可观测性、租户边界、部署排空、测试治理和遗留债。

- [21 观测、告警、健康与 SLO](./06-安全与运维/01-观测告警健康与SLO/21-观测告警健康与SLO.md)
- [22 安全、租户与内部鉴权](./06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)
- [23 配置、部署、蓝绿与排空](./06-安全与运维/03-配置部署蓝绿与排空/23-配置部署蓝绿与排空.md)
- [24 测试脚本与架构治理](./06-安全与运维/04-测试脚本与架构治理/24-测试脚本与架构治理.md)
- [26 遗留、兼容、未启用与文档债](./06-安全与运维/05-遗留兼容未启用与文档债/26-遗留兼容未启用与文档债.md)

## 07 独立业务面

小程序、节点块、AppFlow 与定制业务单独写，不插进画布主链。

- [25 小程序、节点块、AppFlow 与定制业务](./07-独立业务面/01-小程序节点块AppFlow与定制业务/25-小程序节点块AppFlow与定制业务.md)

## 08 附录

查表，不插进上面的书写顺序。

- [附录 A：API 路由与事件总表](./08-附录/A-API路由与事件总表/附录-A-API路由与事件总表.md)
  - HTTP、WebSocket、SSE 与跨仓事件快速定位。
- [附录 B：集合、队列、Worker 与配置总表](./08-附录/B-集合队列Worker与配置总表/附录-B-集合队列Worker与配置总表.md)
  - 持久状态、消息通道、执行进程与配置归属。
- [附录 C：Provider 与模型注册清单](./08-附录/C-Provider与模型注册清单/附录-C-Provider与模型注册清单.md)
  - `CORE_MODELS` 的全部 model id、aliases、robin provider 与 result mode。
- [附录 D：功能覆盖矩阵](./08-附录/D-功能覆盖矩阵/附录-D-功能覆盖矩阵.md)
  - 五仓前端/API/WS/SSE/队列/worker/服务/遗留项到正文的反查入口。

## 阅读边界

```text
Clerk session
  ≠ Publisher 已读到本地业务用户
画布项目已加载
  ≠ workflow run 已创建
POST /api/v2/flow/runs 返回 202
  ≠ 节点或模型已完成
WebSocket onopen
  ≠ cursor replay 已完成
脚本或 provider adapter 存在
  ≠ 模型已进入 CORE_MODELS
```

- 画布运行事件走 Publisher 可恢复 WebSocket；Agent 对话走 Agent SSE。
- 模型展示目录与 AI core registry 不是同一份数据。
- Consumer 负责 DAG 与账务协调，AI 负责 provider 调用与结果归一化。
- 旧 v1、注释代码、仅导出模型和 live/probe 脚本不自动等于现网能力。
