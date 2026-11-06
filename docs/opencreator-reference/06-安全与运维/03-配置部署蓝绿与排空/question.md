# 配置部署蓝绿与排空 question

## 核心概念

- “配置部署蓝绿与排空”讲的是什么？
  - 讲的是五仓怎么装配置，以及 Publisher、Consumer、Agent 怎么把流量从旧实例挪到新实例，再等旧实例上的一个数到 0 或到超时后停旧进程。
  - Frontend 在构建期把公开配置打进静态包，整包换上。
  - AI 在启动时校验配置。仓库里没有 AI 蓝绿脚本。

- 三套切流的共同顺序是什么？
  - 新实例先就绪。
  - 入口再改过去。
  - 脚本轮询旧实例上的一个数。
  - 这个数到 0，或等到这轮脚本的上限，就停旧进程。

- 为什么“`active_ws=0`”“`inflight_count=0`”“`count=0`”不能混在一起？
  - Publisher 的 `active_ws=0` 只表示本进程 v1 `ws_global_map` 空了。
  - Consumer 的 `inflight_count=0` 只表示 `opencreator:consumer:inflight:{id}` 的 `SCARD` 是 0。
  - Agent 的 `count=0` 只表示本进程 `_running_run_tasks` 空了。
  - 这三个数到 0，说明脚本在看的那一项空了。任务做完、回滚成功、存储恢复，要另看队列、事件库和各自的备份。

## 配置与 slot

- 配置按什么边界装？
  - Frontend：Vite 构建期注入 `VITE_*`。切流时要对齐的是公开地址、Clerk、PostHog。
  - Publisher：没设 `APP_ENV` 读 `.env.local`，设了读 `.env.{APP_ENV}`。`APP_ENV` 拼稳定 v2 结果队列，`PUBLISHER_DEPLOY_ID` 拼实例队列。
  - Consumer：同一套环境文件规则。`RUN_FLOW_QUEUE_NAME`、`FLOW_RESUME_QUEUE_NAME`、`FLOW_MAINTENANCE_QUEUE_NAME` 两边用同一套。
  - AI：启动时 `safeParse`，失败就抛。Bull Board、飞书、`CONFIG_LOADER_ENABLED` 默认关，字符串 `true` 才开。
  - Agent：分组配置。`workflow.deploy_id` 固定成 slot，两边各订一条结果队列。

- slot 名解决什么？
  - systemd 把颜色写进环境变量，盖过代码里的随机默认值。
  - Publisher 是 `PUBLISHER_DEPLOY_ID=blue|green`。
  - Consumer 是 `CONSUMER_INSTANCE_ID=blue|green`。
  - Agent 是 `CREATO_WORKFLOW__DEPLOY_ID=agent-prod-blue|agent-prod-green`。
  - 两边实例的队列名、Redis、Mongo、`APP_ENV` 指向同一套资源。slot 名区分本机进程和结果队列。

- `PUBLISHER_DEPLOY_ID` 没设时队列名会怎样？
  - 每次启动生成 `pub-{8位hex}`。
  - 单元文件钉成颜色名之后，重启仍用 `flow_result.blue` 或 `flow_result.green`。

## Publisher 队列与切流

- Publisher 有哪两条结果队列？
  - 实例队列是 `flow_result.{PUBLISHER_DEPLOY_ID}`。
  - 稳定 v2 队列没覆盖时是 `flow_result.workflow.v2.{APP_ENV}`。
  - v2 队列带 `x-single-active-consumer`。事件写入 Redis Event Store 之后，后一台 Publisher 上的 WebSocket 按 cursor 再读。
  - 实例队列按消息里的 `reply_queue` 回到当时那台进程。

- 停掉旧 Publisher 之后，v2 事件还在吗？
  - 还在稳定队列和 Event Store 里。
  - `active_ws` 不参加这条恢复。

- `/readyz` 在生产切流时返回什么？
  - 存在 `/tmp/publisher_maintenance` 时返回 503，body 是 `{"status":"draining","active_ws"}`。
  - 没有维护文件时返回 200，body 是 `{"status":"ok","active_ws"}`。
  - 生产脚本用 `curl -fs`，要的是 HTTP 成功。它不创建维护文件，所以旧端口在后台轮询时仍是 200。
  - 维护文件让 `/readyz` 变成 503，那是 `deploy-dev.sh`。

- `active_ws` 数的是哪张表？
  - `active_ws = len(ws_global_map)`，写入在 v1 `controller/v1/flow.py`。
  - v2 事件连接在 `controller/v2/flow_runs.py` 的 `_connections`。
  - `active_ws` 只数 v1 那张表。

- Publisher 生产切流按什么顺序走？
  - 读 `/opt/opencreator/active_publisher`。
  - 重启另一色，最多 80 秒 `curl -fs /readyz`。
  - 备份 Nginx，改 upstream。`nginx -t` 失败则拷回。
  - 状态文件写成新颜色。
  - `nohup` 每 10 秒读旧端口 `active_ws`。
  - `0`、读不到数字、或满 3600 秒，`systemctl stop` 旧单元。

- standby `/readyz` 失败时流量在哪？
  - 脚本退出。
  - Nginx 和状态文件仍是旧颜色。

- 切流成功时旧进程还在吗？
  - 还在。
  - 成功通知在切流时已经发出。
  - 后台排空失败时，满 3600 秒仍会 `systemctl stop`。
  - reload 之后的新 HTTP 和新 WebSocket 进新进程。旧进程上已有的 v1 socket 留在 `ws_global_map`，直到断开或进程被停。
  - v2 重连到新进程，事件从 Event Store 按 cursor 补。

## Consumer 领取闸与切流

- 领取闸装在哪条队列上？
  - 只改 `run_flow`，换上 `DrainableRedisStreamConsumer`。
  - `flow_resume`、`flow_maintenance` 保持原来的普通消费者，直到进程停。

- intake 有哪三个状态？
  - `ACTIVE`：`XREADGROUP >`。
  - `DRAINING`：跳过 `XREADGROUP`。`SCARD inflight` 为 0 时写成 `STOPPED`。
  - `STOPPED`：sleep 5，继续循环，不退出进程。这样 `Restart=always` 不会把进程拉起来再抢消息。

- 启动时见到旧状态怎么办？
  - 键不存在或其它值，改成 `ACTIVE`。
  - 已是 `DRAINING`，保持。
  - 已是 `STOPPED`，改回 `ACTIVE`。

- 三把 Redis 键是什么？
  - `opencreator:consumer:intake:{CONSUMER_INSTANCE_ID}`。
  - `opencreator:consumer:inflight:{CONSUMER_INSTANCE_ID}`。
  - `opencreator:consumer:heartbeat:{CONSUMER_INSTANCE_ID}`，每圈 `SETEX 30`。

- 三个运维口做什么？
  - `POST /ops/consumer/drain` 把 intake 写成 `DRAINING`。
  - `POST /ops/consumer/active` 把 intake 写成 `ACTIVE`。
  - `GET /ops/consumer/status` 返回 `intake_state`、`inflight_count`、`submitted_webhook_invocation_count`、`last_heartbeat`、`flow_engine`。
  - `/readyz` 读到 `DRAINING` 或 `STOPPED` 返回 503。
  - `/ops/consumer/*` 由脚本打在 `127.0.0.1`。路由本身没有来源判断，不要挂进对用户开放的入口。

- `inflight_count=0` 在 OpenCreator 现码里表示什么？
  - 业务路径里只有 `SCARD`。`run_flow` 入站和出站都没有 `SADD` / `SREM`。
  - `0` 表示这把 set 当前是空的。
  - Stream PEL、inbox、outbox、待回调要另查。停进程之后的 `DEL` 是删键。

- Consumer 生产切流按什么顺序走？
  - 启动 standby。
  - `GET /health`，再 `POST /ops/consumer/active`，再 `GET /readyz`，上限 120 秒。
  - Nginx 从对外 `8000` 改到 `9000` 或 `9001`。
  - `127.0.0.1:8000/health` 的 `instance_id` 必须是新颜色。
  - `POST` 旧端口 `/ops/consumer/drain`。
  - `inflight_count` 为 0，或满 1800 秒，`systemctl stop`。
  - `redis-cli` 把 intake 写成 `STOPPED`，并 `DEL` inflight、heartbeat。
  - `/opt/opencreator/active_consumer` 在旧进程停掉之后写成新颜色。

- `instance_id` 对不上时会怎样？
  - 脚本退出。
  - 旧实例仍是 `ACTIVE`。

- `verify_bluegreen_drain.py` 和生产脚本是什么关系？
  - 它的通过条件是 `inflight_count` 和 `submitted_webhook_invocation_count` 同时为 0。
  - 它不替换生产脚本。生产脚本只等 `inflight_count`。

- 两边什么时候读同一条 `run_flow`？
  - 旧实例进入 `DRAINING` 之前，都用 consumer group `opencreator_group` 读 `>`。

## Agent 心跳、排水与 ALB

- Agent 本机口有哪些？
  - `GET /health` 返回 `{"status":"ok"}`。
  - `GET /preview/active_runs` 和 `POST /preview/drain` 只接受 `127.0.0.1`、`::1`、`localhost`，其它来源 404。
  - drain 把 `shutting_down` 设为 true，返回 `len(_running_run_tasks)`。
  - `POST /v1/agent/runs` 在 `shutting_down` 时返回 503 `INSTANCE_SHUTTING_DOWN`。
  - drain 之后 `/health` 仍是 `ok`。

- `count` 和 `agent:active_runs` 各看什么？
  - `/preview/active_runs` 的 `count` 来自本进程 `_running_run_tasks`。部署脚本等的是这个数。
  - Redis 的 `agent:active_runs` 给孤儿扫描用。
  - 两件事各看各的时钟。

- 心跳和扫描怎么接上？
  - 实例 id 是 `{pid}_{8 位 hex}`。
  - `agent:instance:{id}:heartbeat` 的 TTL 是 10 秒，约每 3 秒刷新。
  - `shutting_down` 为 true 后心跳循环退出。
  - 启动后先睡 15 秒，之后每 10 秒扫描。
  - 本进程已有这个 run，跳过。状态不是 `running` / `queued`，移出集合。owner 心跳还在，跳过。
  - 没有 checkpoint，标中断。有 checkpoint，调用 `_resume_agent_run`。
  - 心跳停止约 10 秒后，另一进程能扫到这条 run。

- 进程退出时还等多久？
  - 最多再等 90 秒，然后 cancel 剩余 run。
  - 非终态 checkpoint 保留。

- ALB 发布按什么顺序走？
  - 恰好一个 healthy，旧槽是当前槽，另一色是目标。
  - 两边都 healthy，认槽失败，不注册。
  - 组为空，目标是 blue。
  - `deploy-code` 做 `git reset --hard origin/main` 和 `uv sync`，不重启。
  - `restart` 目标槽，最多 600 秒等 `/health`。
  - register 之后约 240 秒内要 healthy。还没 deregister 时，旧槽仍接流量。
  - deregister 旧槽之后再 `POST /preview/drain`。
  - drain 默认等 900 秒。超时退出码 2，步骤 `continue-on-error`，workflow 继续，旧槽重启到新代码。
  - `force_drain_skip` 跳过 drain，仍重启旧槽。
  - 外部 `/health` 失败记 warning。

## Frontend 与 AI

- Frontend 发布启动第二套进程吗？
  - 不启动。
  - `deploy-cos.yml` 用 secret 还原 `.env.production`，再整包上传。
  - 同一次推送会取消还在跑的上传。上传完成就是新包。
  - `vite.config.ts` 把 `VITE_SERVER_URL`、`VITE_WEBSOCKET_URL`、`VITE_CLERK_PUBLISHABLE_KEY`、`VITE_STRIPE_PK`、`VITE_POSTHOG_KEY` 打进包。这些是公开值。

- AI 缺配置时会怎样？
  - Mongo、Redis、`authKey`、callback secret 缺失，进程起不来，错误是 `Invalid opencreator-ai config`。
  - 飞书 webhook 为空时不发通知。
  - 模型任务还在 BullMQ、callback 和 Consumer 的 resume 上，不在 Publisher 的 `active_ws` 里。

## 超时、失败与回滚

- 这轮脚本的上限是多少？
  - Publisher standby `/readyz`：80 秒。到点脚本失败，流量还在旧实例。
  - Publisher 后台等 `active_ws`：3600 秒。到点强停旧实例。
  - Consumer standby 就绪：120 秒。到点脚本失败。
  - Consumer 等 `inflight_count`：1800 秒。到点强停，并删 inflight 键。
  - Agent 等 `/health`：600 秒。到点本机脚本失败。
  - Agent 等 ALB healthy：约 240 秒。到点 workflow 失败。还没 deregister 时，旧槽仍接流量。
  - Agent 等 `count`：900 秒。到点退出码 2，发布继续。
  - Agent 进程退出时再等：90 秒。到点 cancel 剩余 run，非终态 checkpoint 保留。

- 仓库里有没有把这些数写成 RTO？
  - 没有。
  - 也没有五仓共用的 revision 清单。
  - Mongo、Redis、RabbitMQ、对象存储的备份和恢复演练不在这三份脚本里。

- 回滚沿哪一层做？
  - Publisher / Consumer 把 Nginx 和状态文件指回上一色。
  - Agent 把上一槽重新 register。

## 面试短答

- 一句话讲配置部署蓝绿与排空？
  - 五仓分开装配置。Publisher、Consumer、Agent 都是新实例先就绪、入口再切过去，然后分别等 `active_ws`、`inflight_count`、本进程 `count` 到 0 或到超时再停旧进程。Frontend 整包替换，AI 只在启动时校验配置。

- 一句话讲为什么数到 0 不等于任务做完？
  - 这三个数只说明脚本正在看的那张表或那把 set 空了。PEL、Event Store、checkpoint 和存储备份要另查。

- 一句话讲为什么 Publisher 旧 `/readyz` 在排空时仍是 200？
  - 生产脚本不创建 `/tmp/publisher_maintenance`，它只读 JSON 里的 `active_ws`。维护文件把 `/readyz` 打成 503 是开发脚本的事。

- 一句话讲 Consumer drain 停了什么？
  - `POST /ops/consumer/drain` 只让这份进程跳过 `run_flow` 的 `XREADGROUP`。`flow_resume` 和 `flow_maintenance` 在进程退出前仍可拉。

- 一句话讲 Agent drain 超时后发布还成功吗？
  - 成功。退出码 2 被 `continue-on-error` 吃掉，旧槽仍重启到新代码，非终态 checkpoint 留在 Redis，给另一槽扫描。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - Publisher 按 `APP_ENV` 选环境文件。未设 `PUBLISHER_DEPLOY_ID` 时生成 `pub-{8位hex}`，环境变量盖过文件。实例队列是 `flow_result.{id}`，稳定 v2 队列是 `flow_result.workflow.v2.{env}`，也可用 `FLOW_V2_RESULT_QUEUE_NAME` 覆盖。
  - Publisher `/readyz` 在有 `/tmp/publisher_maintenance` 时返回 503 `draining`，否则 200。生产脚本不创建这份文件。
  - Publisher 脚本先等 standby `/readyz`，再改 Nginx。冒烟失败会把 upstream 指回旧端口，状态文件还没改。成功后先写 `/opt/opencreator/active_publisher`，再后台等 `active_ws`。
  - Consumer 有 `CONSUMER_INSTANCE_ID`。只有 `run_flow` 走 `DrainableRedisStreamConsumer`。处理开始 `SADD`，结束 `SREM`。`flow_resume`、`flow_maintenance` 仍是普通消费者。
  - Consumer 脚本先 `active` 再 `/readyz`，切流后核对对外 `/health` 的 `instance_id`，再 drain。`inflight_count=0` 或 1800 秒后停旧进程，并删除 inflight、heartbeat。状态文件在旧进程停掉之后写。
  - Agent 有心跳、`agent:active_runs`、15 秒后每 10 秒扫描、本机 `/preview/drain`。新 run 在 `shutting_down` 时返回 503 `INSTANCE_SHUTTING_DOWN`，`/health` 仍是 `ok`。
  - Agent `deploy.sh release` 按“恰好一个 healthy 才认槽、新槽 healthy 后再摘旧槽、drain 超时退出码 2 仍继续”发布。`force_drain_skip` 跳过 drain，仍重启旧槽。
  - Frontend 只把公开 `VITE_*` 打进包，COS 上传同分支后一次取消前一次。
  - AI 缺 `MONGODB_URI`、`REDIS_URL`、`AUTH_KEY`、`CONSUMER_WEBHOOK_SECRET` 时进程不起。飞书和 Bull Board 只有字符串 `true` 才开。

- 当前实现能不能算本章主链路打通？
  - 可以算三套切流骨架打通。
  - 因为 slot 身份、两条 Publisher 队列、Consumer 领取闸、Agent 本机排水和 ALB 认槽都已经在仓库里。
  - 这不等于发布演练已经完成：仓库里没有 blue/green 的 systemd 单元，也没有五仓 revision 和存储恢复演练。

- 当前和 OpenCreator 现码有哪些已经对齐、哪些口径不同？
  - 已对齐的是切流顺序、状态文件时机、三个等待上限，以及生产 Publisher 脚本不创建维护文件。
  - NovelComic 的 `active_ws` 数的是 v2 `_workflow_sockets`，仓库里没有 v1 `ws_global_map`。
  - NovelComic 的 inflight 在 `run_flow` 入站 `SADD`、出站 `SREM`。`0` 表示当前没有正在处理的 `run_flow` 消息。OpenCreator 现码只有 `SCARD`，`0` 只表示 set 为空。
  - Consumer group 名是 `novelcomic_consumer_group`。
  - 稳定 v2 队列声明为 durable。Publisher 代码里没有给它加上 `x-single-active-consumer`。同一个 `event_id` 仍先 `append_event` 再 ACK。
  - Publisher / Consumer 脚本在记下成功之前会跑 `release_smoke`。冒烟失败会把 Nginx 指回去。
  - `verify_bluegreen_drain.py` 默认不跑。只有 `RUN_VERIFY_BLUEGREEN_DRAIN=1` 才同时等 webhook 计数。这一步失败时 Nginx 会指回旧色，但旧实例此时可能已经是 `DRAINING`。
  - Agent 配了 `EXTERNAL_HEALTH_URL` 时，外部 `/health` 失败会让 release 退出。OpenCreator 这一步记的是 warning。

- 当前测试覆盖了哪些本章风险？
  - Publisher 覆盖环境文件与 deploy id、两条队列同名或分色、`/readyz` 的维护文件和 `active_ws`、standby 失败不改入口、`active_ws` 为 0 或读不到时停旧进程、脚本不创建维护文件。
  - Consumer 覆盖 intake 三态、`run_flow` 的 `SADD` / `SREM`、`instance_id` 对不上时旧实例保持 `ACTIVE`、超时仍删 inflight 键、verify 要两个计数同时为 0。
  - Agent 覆盖非本机 `/preview/drain` 为 404、本机 drain 后新 run 为 503、认槽、drain 超时继续、`force_drain_skip`。
  - Frontend 覆盖公开环境键。AI 覆盖缺 `MONGODB_URI` 不起进程，以及只有字符串 `true` 才打开开关。
  - `scripts/test_release_smoke.py` 覆盖冒烟发生在部署成功记录之前。

- 为什么说当前还不是完整发布验收？
  - 仓库里没有 `novelcomic-publisher-blue.service` 这类单元文件。脚本假定主机上已经有同名单元。
  - `/ops/consumer/*` 仍没有来源判断。
  - 生产 Consumer 脚本默认只等 `inflight_count`。PEL、outbox 不在这个等待里。
  - Agent 的 `count` 和孤儿扫描仍是两套时钟。
  - 没有把 80 秒、3600 秒、1800 秒、900 秒写成 RTO，也没有五仓共用的 revision 清单。

- 如果切流后用户还连在旧实例，当前应该怎么排查？
  - Publisher 先看状态文件是不是新颜色，再看旧端口 `/readyz` 的 `active_ws`。这个数是本进程 v2 socket。v2 事件是否可补，看 Event Store 和 cursor。
  - Consumer 先看对外 `/health` 的 `instance_id` 是不是新颜色。对不上时旧实例应仍是 `ACTIVE`。对得上再看旧端口 intake 是不是 `DRAINING`，以及 `inflight_count`。
  - Agent 先看目标组里是不是只有新端口 healthy。再看本机 `/preview/active_runs` 的 `count`，以及 Redis 里 owner 心跳和 checkpoint。

- 什么时候才算本章完整验收？
  - 两个 Publisher 的 v2 队列名相同，实例队列分别带颜色。两个 Consumer 的三条队列名相同，实例 id 不同。两个 Agent 的 deploy id 不同。
  - Publisher standby 失败时入口和状态文件仍是旧颜色。切流成功后旧进程还在，`active_ws=0`、读不到数字或满 1 小时才停。
  - Consumer drain 之后不再拉 `run_flow`，`flow_resume` 在进程退出前仍可拉。对外 `instance_id` 对不上时旧实例仍是 `ACTIVE`。
  - 非本机调用 Agent `/preview/drain` 为 404。本机调用后新 run 为 503，`/health` 仍为 `ok`。两边都 healthy 时发布失败。
  - Frontend 不启动第二套进程。AI 配置不合法时进程不起。
  - 回滚把 Publisher / Consumer 的入口指回上一色，或把 Agent 上一槽重新 register。存储恢复另写。
