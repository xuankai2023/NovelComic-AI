# 测试脚本与架构治理 question

## 核心概念

- “测试脚本与架构治理”讲的是什么？
  - 讲的是一次改动留下的证据停在哪一层：入口在不在、本地能不能跑、远程会不会自动跑、失败以后 job 还绿不绿、五仓 commit 有没有锁在同一份 manifest。
  - 它不重写业务断言。断言留在各仓已有测试文件里。

- 这五层各自回答什么？
  - 入口在：五仓都有测试文件或 `test:*`。
  - 本地能跑：Frontend 跑 `test:*`，AI 跑 `pnpm test`，Python 三仓跑 pytest。
  - 远程自动跑：只有 Frontend `ci.yml` 会在 PR 上启动。它调用 lint、`tsc --noEmit`、build。
  - 失败阻断：这份 `ci.yml` 里，lint 和 type check 写了 `continue-on-error`。build 失败或没有 `dist` 才让 job 失败。Agent 排水允许失败，外部 `/health` 记 warning。
  - 组合被锁：没有 revision manifest，也没有同时 checkout 多仓的 job。

- 为什么“有测试”“CI 绿”“contract 绿”“五仓都绿”“部署成功”不能混在一起？
  - 有测试只表示入口路径到了文件。
  - CI 绿要看这次 job 的命令，以及哪些步骤允许失败。
  - contract 绿要看对端仓库有没有进同一个 job。
  - 五仓都绿要看 manifest 里五个 commit 是否写全。
  - 部署成功要看关键冒烟是否非零阻断，旧实例是否走完可恢复排空。

## 入口按仓分开

- Frontend 的测试入口在哪，PR 跑不跑？
  - 入口在 `package.json` 的 `test:*`。
  - `test:workflow-reconnect` 跑 reconnect policy、command journal、side-effect claim、resumable websocket，四条 node 命令用 `&&` 连接。
  - `test:onboarding-auth-flow` 跑全局登录弹窗。
  - `test:cli-authorization` 跑 CLI 授权。
  - `test:subscription-payment-safety` 跑订阅结账和支付窗口。
  - `test:model-dropdown-order` 跑模型下拉顺序。
  - 同文件还有 analytics、composer、agent UI 的 `test:*`。
  - `ci.yml` 不调用这些脚本。

- Frontend `ci.yml` 什么时候启动，跑哪些命令？
  - PR，以及 push 到 `main` / `master` / `develop`。Node 是 `20.x`。
  - `pnpm install --frozen-lockfile`，然后 `pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm build`。
  - `dist` 不存在则 `exit 1`。
  - `if: success()` 才打印 CI checks passed。
  - build 读 `VITE_SERVER_URL`、`VITE_WEBSOCKET_URL`、`VITE_CLERK_PUBLISHABLE_KEY`、`VITE_POSTHOG_KEY`。secret 空着就用占位符，让构建步骤能跑完。

- Publisher、Consumer、AI、Agent 的远程入口是什么？
  - Publisher 本地是 `pytest`，`requirements.txt` 里是 `pytest==8.3.5`。`workflows/README.md` 点了 `ci.yml`，目录里没有这份 yml。
  - Consumer 本地是 `pytest tests/unit_tests`，同样是 `pytest==8.3.5`。没有 `.github/workflows`。
  - AI 用 `vitest.config.ts` 收集 `tests/**/*.test.ts` 和 `packages/**/*.test.ts`。没有 `.github/workflows`。`pnpm test` 是 `vitest run`，`pnpm typecheck` 是 `tsc -b`，`pnpm lint` 扫 apps、packages、tests、scripts。
  - Agent 本地 `pytest` 的路径是 `tests/`，`asyncio_mode = "auto"`。`main-deploy.yml` 在 push `main` 或手动触发时部署，PR 不跑 pytest。

## 失败阻断

- 哪些步骤失败以后 job 还绿？
  - Frontend `pnpm lint`、`pnpm exec tsc --noEmit`：job 继续。后面的 `if: success()` 仍可能打印 type check completed。
  - Frontend `pnpm build`、检查 `dist`：job 失败。
  - Agent `Drain old active slot`：`continue-on-error: true`，接着把旧槽重启到新代码。
  - Agent 外部 `/health`：60 秒内打不通时 `::warning::`，步骤不 `exit 1`。
  - `force_drain_skip`：跳过排水，旧槽仍重启。
  - 排水超时写进成功通知的备注，job 仍可以成功。concurrency 组是 `prod-agent-deploy`，不取消正在跑的部署。

- 允许失败要写什么？
  - 允许失败的步骤要同时写 Owner 和到期日。
  - 没有这两项，红灯不挡合并。该步失败就是 job 失败。

## 契约锁的是本仓解析

- HTTP、Workflow、AI callback、Agent SSE 各锁什么？
  - HTTP：`test_auth_middleware.py`、`test_subscription_checkout_safety.py` 锁鉴权、状态码、支付幂等键。
  - Workflow：`test_workflow_event_store.py`、`test_flow_command_idempotency.py` 锁 `command_id`、`event_id`、cursor。
  - AI callback：`createSignature` 对 `timestamp.rawBody` 做 SHA-256 HMAC。`model-call-contracts.test.ts` 和 `test_callback_parser.py` 两边各自解析 payload。
  - Agent SSE：事件帧、`Last-Event-ID`、`ResumeWindowExpiredError`、HITL 时 active run 仍在。HTTP `410` 写在 `server.py`。Redis 测试断言的是 `ResumeWindowExpiredError`。

- 为什么 AI schema 绿了，不能说 callback 契约已经一起验过？
  - AI 的 schema 测试和 Consumer 的 parser 测试不在同一个 job。
  - Consumer 的 `test_provider_contract.py` 用假的 `submit` 断言本仓如何组请求。它和 AI 的 schema 测试各跑各的。
  - 同一轮要一起看，得用 manifest 把两个 commit 钉在一次夜间跑里。
  - 只通过其中一边时，产物写成「仓内解析通过」。

- `test:kling-*` 和真实模型脚本进 PR 吗？
  - 不进。
  - `test:kling-*`、`test:gemini-*-live`、`test:gpt-image-2-robin` 是单独的 `tsx` 脚本，请求外部 provider，不在 `pnpm test` 里。
  - Consumer 的 `verify_webhook_pipeline.py`、`verify_bluegreen_drain.py`、`verify_redis_consistency.py`、`run_real_opencreator_ai_e2e.py` 打外部依赖，留在本地或发布前。
  - `verify_bluegreen_drain.py` 在 `POST /ops/consumer/drain` 后轮询，直到 `inflight_count` 和 `submitted_webhook_invocation_count` 都是 0，默认 300 秒。它不代替 Publisher 和 Agent 的探活。

- Consumer 幂等测试怎么证明只进入一次？
  - `test_flow_command_idempotency.py` 用假的 inbox。
  - 同一个 `command_id` 第二次 `find_one_and_update` 抛 `DuplicateKeyError`，状态机只进入一次。

## 三层门

- 三层门各证明一件事，现码跑到哪一层？
  - PR 快速门：本仓这次改动，本仓轻量检查会红。现码只自动跑了 Frontend 的 lint、tsc、build，而且前两步允许失败。
  - 夜间跨仓门：manifest 里点名的旧新组合跑过。同日提交和各仓最新 HEAD 都不算这一层。现码没有这份 manifest，也没有夜间 job。
  - 发布前门：目标环境里登录、读项目、最短 run、callback、结果回传、WS/SSE 终态都通。只打 `/health` 只证明进程活着。现码没有这份冒烟 workflow。

- 夜间产物要留下什么？
  - revision、打码后的配置摘要、测试列表、日志、失败 owner。
  - 格子失败则 job 失败。
  - 缺任何一个键，夜间 job 在跑测试之前失败。
  - 默认分支的 HEAD 不出现在清单里。

- 夜间矩阵有哪七格？
  - 新 Frontend + 旧 Publisher。
  - 旧 Frontend + 新 Publisher。
  - 新 Publisher + 旧 Consumer。
  - 旧 Publisher + 新 Consumer。
  - 新 AI + 旧 Consumer。
  - 旧 AI + 新 Consumer。
  - 新 Agent + manifest 中的 Publisher 与 Consumer：创建 run，收到 SSE，走完一条 HITL。
  - `test:kling-*` 和 `run_real_opencreator_ai_e2e.py` 单独一步，日志标明打的是外部模型。这一步不代替上面的七格。

- 发布前冒烟失败以后怎么算？
  - 放在切流之后、成功通知之前。
  - 目标 slot 的 `/health`、`/readyz` 之后，还要登录并取得 JWT、读取自己的 flow project、创建最短 workflow run、callback 进入 Consumer、RabbitMQ 把结果交回 Publisher、WS 或 SSE 收到终态。
  - `/health` 已通、后面的 run 或 callback 失败，job 失败。
  - 目标端口不通时冒烟非零退出，部署不记成功。
  - 外部 DNS 还没切完、通知 webhook 失败，可以 warning，日志写明它不证明 run 和 callback。
  - 把流量指回旧 slot 沿蓝绿入口做。

- Agent 发布门要改哪一处？
  - `main-deploy.yml` 把外部 `/health` 从 warning 改成失败即 `exit 1`。
  - 排水超时仍继续发布，成功通知保留 timeout 备注，并在 ADR 里写 Owner 和 Review by。
  - 部署文件继续只在 push `main` 和 `workflow_dispatch` 时切流，里面仍然没有 pytest。

## ADR 与指标

- ADR 记什么，现码有没有？
  - 业务仓没有 `ADR*` / `adr*` 目录。`docs/architecture-study` 里的 ADR 是学习材料，留在原处。
  - 一条记录最少这些字段：编号、状态、背景、选择、替代方案、后果、Owner、证据路径、Review by、Superseded by。
  - 状态从 Proposed 到 Accepted。到复审日仍成立就保留。被替换时改成 Superseded，并指向新编号。
  - 状态还是 Proposed 时，文档里把它写成待复审。

- 指标记哪四类？
  - CI 的 p50/p95、排队时间和 runner 成本。
  - flaky 次数和隔离期限。到期后修掉，或恢复为阻断。
  - 逃逸层：PR、夜间、发布前、生产。
  - 跨仓等待时间、回滚率和 MTTR。

## 面试短答

- 一句话讲测试脚本与架构治理？
  - 先看测试入口在不在，再看 PR 会不会跑、失败会不会让 job 变红，最后看五仓 commit 有没有锁进同一份 manifest。现码只有 Frontend 的 build 能挡住远程 job。

- 一句话讲为什么 CI 绿不等于断言跑过？
  - Frontend PR 不调用 `test:*`。lint 和 type check 写了 `continue-on-error`，build 和 `dist` 失败才让 job 失败。

- 一句话讲为什么五仓各自绿不等于这一轮组合验过？
  - 没有 job checkout 第二个仓。夜间门只认 manifest 里点名的旧新 SHA。同日提交和各仓最新 HEAD 都不算。

- 一句话讲为什么 `/health` 通了还不能记部署成功？
  - 发布前门还要登录、读项目、最短 run、callback、结果回传和 WS/SSE 终态。只打 `/health` 只证明进程活着。

## NovelComic 当前实现自查问题

- 只看本章，当前 NovelComic 做到哪一步了？
  - 五仓都有 `ci.yml`，在 PR 和 push `main` / `develop` 时跑。lint、typecheck、test、build 没有 `continue-on-error`，一步失败 job 失败。
  - Frontend 跑 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`，再检查 `dist`。`VITE_*` 用 secret，空着就用占位符。Node 是 22。
  - Publisher、Consumer、Agent 用 `uv sync --frozen --extra dev` 之后 `uv run pytest`。`testpaths` 是 `tests`，`asyncio_mode` 是 `auto`。
  - AI 跑 `pnpm lint`、`pnpm typecheck`、`pnpm test`。`pnpm test` 是 `vitest run`。
  - `revision-manifest.json` 写了五份树的 commit、本轮命令和 owner。五个目录在同一个 git 仓库里，同一个 SHA 锁的是同一次提交里的五份树。`new` 与 `old` 是两个不同的完整 SHA，清单里不出现默认分支 HEAD。
  - `.github/workflows/nightly-matrix.yml` 先校验清单，再跑七格，再单独跑外部模型。缺键或写成 HEAD，在跑测试之前失败。产物留下 manifest、打码配置、命令、日志和 owner。
  - AI 的 webhook schema、callback HMAC 与 Consumer 的 `test_callback_hmac.py` 写在同一轮 `tests.contracts` 里。只通过一边时产物是「仓内解析通过」。
  - `.github/workflows/release-smoke.yml` 和 `scripts/release_smoke.py` 放在切流之后。目标端口不通，或 `/health` 已通但登录、项目、run、callback、Publisher 终态、WS/SSE 终态失败，退出码非零。外部 DNS 和通知 webhook 失败只记 warning，并写明不证明 run 和 callback。
  - Publisher / Consumer 的蓝绿脚本在记下成功之前调用这份冒烟。`verify_bluegreen_drain.py` 要另外打开才跑，不代替探活。
  - `docs/adr/ADR-0001.md` 状态是 Proposed，Owner 是 `novelcomic-platform`，Review by 是 2026-12-31。Agent 排水超时仍继续发布，外部 `/health` 打不通则 `exit 1`。
  - `novelcomic-agent/.github/workflows/main-deploy.yml` 仍不跑 pytest。

- 当前实现能不能算本章主链路打通？
  - 可以算三层门的文件已经齐。
  - 因为本仓 PR 会红、夜间清单能锁旧新组合、发布前冒烟会在关键链失败时非零退出。
  - 这不等于治理已经收口：ADR 还是 Proposed，四类指标只写在 ADR 里，外部模型那两条命令还没有对应脚本，仓库里也没有分支保护配置。

- 当前和 OpenCreator 现码有哪些已经对齐、哪些口径不同？
  - OpenCreator 远程只自动跑 Frontend 的 lint、tsc、build，而且前两步允许失败。NovelComic 五仓 PR 都跑，lint 和 typecheck 失败即 job 失败。
  - OpenCreator Frontend 的关键断言在四条 `test:*` 里，`ci.yml` 不调用。NovelComic Frontend 的 PR 跑的是 `pnpm test`，仓库里没有那四条脚本名。
  - OpenCreator 的 PR pytest 是点名文件。NovelComic 的 Python 三仓 PR 跑的是整个 `tests/`。
  - OpenCreator 五个目录是五份树。NovelComic 要跑「新 Frontend + 旧 Publisher」时，用两个 SHA 各做一个 worktree。
  - OpenCreator Agent 外部 `/health` 记 warning。NovelComic 配了地址时失败即 `exit 1`。排水超时两边都继续发布。
  - 清单里的外部步骤点了 `pnpm test:kling-image` 和 `novelcomic-consumer/scripts/run_real_opencreator_ai_e2e.py`。`package.json` 里没有 `test:kling-image`，Consumer 目录里也没有这份 e2e 脚本。

- 当前测试覆盖了哪些本章风险？
  - `scripts/test_nightly_matrix.py` 覆盖清单里的完整 commit、缺键时不跑命令、写成默认分支 HEAD 时在跑测试之前失败、只通过一边时产物是「仓内解析通过」、外部模型不进入七格。
  - `scripts/test_release_smoke.py` 覆盖目标端口不通、`/health` 通但 callback 失败时非零退出，以及外部 DNS、通知 webhook 只记 warning。
  - 各仓 `ci.yml` 本身没有 `continue-on-error`。

- 为什么说当前还不是完整治理验收？
  - ADR 状态仍是 Proposed，证据路径能打开，但还没有复审成 Accepted。
  - p50、p95、flaky、逃逸层、回滚率和 MTTR 写在 ADR 的表里。仓库里没有采集这些数的任务。当前没有隔离中的 flaky。
  - job 变红是 workflow 的失败语义。挡住合并还要 GitHub 把这些 check 设成 required。这份设置不在仓库里。
  - 夜间 external 步骤真跑时，会执行清单里那两条还不存在的外部模型命令。
  - 冒烟 workflow 是 `workflow_dispatch` 和 `workflow_call`。它不会在每个 PR 上自己启动。

- 如果 PR 是绿的，当前应该怎么看？
  - 先看是哪一个仓的 `ci.yml`。Frontend 绿表示 lint、typecheck、`pnpm test`、build 和 `dist` 都过了。
  - 再看夜间产物里的 SHA 是不是 manifest 里的 `new` / `old`，而不是默认分支 HEAD。
  - contract 只过一边时，日志里应是「仓内解析通过」。
  - 部署成功还要看冒烟日志里有没有登录、run、callback 和终态。只有 `/health` 时，不能记成这条链通过。

- 什么时候才算本章完整验收？
  - 改坏一条 PR 断言，该仓 check 变红，并且 required check 挡住合并。
  - Frontend 的 lint 或 typecheck 失败时 job 失败。
  - 夜间产物里的 commit 与 manifest 一致。缺键、写成 HEAD 或某一格失败时 job 失败。
  - 停掉目标端口，冒烟非零退出，部署不记成功。`/health` 通、callback 失败时，job 仍然失败。
  - `docs/adr/ADR-0001.md` 带 Owner、证据路径和 Review by。复审通过后状态改为 Accepted。
  - 外部模型命令要有真实入口，或从清单里拿掉。没有 Owner 和到期日的步骤，失败就是阻断。
