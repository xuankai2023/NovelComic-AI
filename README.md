# NovelComic AI

父目录仓库只保留本地联调、文档和跨服务验收。每个服务是独立 Git 仓库。GitHub Actions 只执行仓库根目录的 workflow，服务若放在父仓库子目录里，CI 和自动部署都不会触发。

| 本地目录 | 远程仓库 |
| --- | --- |
| `novelcomic-frontend` | https://github.com/xuankai2023/novelcomic-frontend |
| `novelcomic-publisher` | https://github.com/xuankai2023/novelcomic-publisher |
| `novelcomic-consumer` | https://github.com/xuankai2023/novelcomic-consumer |
| `novelcomic-agent` | https://github.com/xuankai2023/novelcomic-agent |
| `novelcomic-ai` | https://github.com/xuankai2023/novelcomic-ai-service |
| `novelcomic-remotion` | https://github.com/xuankai2023/novelcomic-remotion |

`novelcomic-ai` 的远程仓库叫 `novelcomic-ai-service`。GitHub 仓库名不区分大小写，不能再占用已经存在的 `NovelComic-AI`。

Agent 推送 `main` 时走蓝绿部署，Frontend 推送 `main` 时部署到 COS。这两份 workflow 目前在各服务的 `feature/reliability-security-ops` 上，合并进该服务的 `main` 之后才会在推送时触发。父仓库的推送不会部署任何服务。

## 仓库职责

- `novelcomic-frontend`：React 前端与服务状态面板，端口 `3000`。
- `novelcomic-publisher`：项目与用户 API 的预留入口，端口 `8000`。
- `novelcomic-consumer`：工作流执行进程骨架，端口 `8001`。
- `novelcomic-agent`：漫画 Agent 与 SSE 接口骨架，端口 `18791`。
- `novelcomic-ai`：Fastify API + BullMQ worker 双进程，端口 `5151`。

## 环境要求

- Docker Desktop 或兼容的 Docker Engine，支持 Compose v2
- Node.js 22、pnpm 10
- Python 3.11、推荐安装 `uv`

## 1. 启动基础设施

```bash
cp .env.example .env
./scripts/start-infra.sh
```

本地连接：

- MongoDB：`mongodb://localhost:27017/novelcomic`
- Redis：`redis://localhost:6379`
- RabbitMQ：`amqp://novelcomic:novelcomic@localhost:5672/`
- RabbitMQ 管理页：<http://localhost:15672>

## 2. 安装并配置服务

```bash
cd novelcomic-publisher && cp .env.example .env.local && uv sync --extra dev
cd ../novelcomic-consumer && cp .env.example .env.local && uv sync --extra dev
cd ../novelcomic-agent && cp .env.example .env.local && uv sync --extra dev
cd ../novelcomic-ai && cp .env.example .env.local && pnpm install
cd ../novelcomic-frontend && cp .env.example .env.local && pnpm install
```

## 3. 按顺序启动

分别在五个终端执行：

```bash
cd novelcomic-ai && pnpm dev
cd novelcomic-consumer && uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
cd novelcomic-publisher && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
cd novelcomic-agent && uv run uvicorn novelcomic_agent.main:app --host 0.0.0.0 --port 18791
cd novelcomic-frontend && pnpm dev
```

浏览器打开 <http://localhost:3000>，状态面板会检查四个后端的 `/health`。

## 4. 验证

```bash
curl http://localhost:5151/readyz
curl http://localhost:8001/readyz
curl http://localhost:8000/readyz
curl http://localhost:18791/readyz

JOB_ID=$(curl -sS -X POST http://localhost:5151/v1/smoke/jobs \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl "http://localhost:5151/v1/smoke/jobs/${JOB_ID}"
```

停止基础设施但保留数据：

```bash
./scripts/stop-infra.sh
```

只有明确需要清空本地数据时才执行：

```bash
./scripts/stop-infra.sh --volumes
```

## 后续业务开发顺序

1. 定义漫画项目、章节、页面、分格和角色领域模型。
2. 在 Publisher 提供项目 API 与持久化。
3. 定义 Publisher/Agent 到 Consumer 的工作流消息协议。
4. 在 AI 服务添加真实文生图、图生图模型适配与回调。
5. 在 Agent 实现故事拆解、角色设定和页格规划。
6. 在 Frontend 实现项目页、章节页、分格编辑器与阅读器。
