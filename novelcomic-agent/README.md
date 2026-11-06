# novelcomic-agent

Python 3.11 / FastAPI Agent 服务。现有应用提供基础设施健康检查和有限结束的
SSE 探针；`src/novelcomic_agent/comic/` 在同一进程内增加单页漫画自动生产的
控制面骨架，不创建第二个应用或运行时。

comic 首批包含 Pydantic v2 契约、阶段 B/E 状态迁移、整数分预算、PostgreSQL
草稿 CAS、Compose 命令账本、outbox 和数据库 job lease。Redis 与 RabbitMQ
继续复用现有基础设施，但 PostgreSQL 是 comic 任务、草稿、成本和恢复事实的
持久化真相。Remotion Compose 通过注入的客户端调用。

阶段 B～E 的目录和模块位置已经建立，详见
`src/novelcomic_agent/comic/ARCHITECTURE.md`。新增模块当前只声明职责，不实现
分析、TTS、素材生成、渲染编排、自动 QA、ZIP 打包或 `comic_*` 工具，也不会
从应用入口注册。所有外部系统后续均通过 Protocol 注入。

## 本地启动

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
cp .env.example .env.local
uvicorn novelcomic_agent.main:app --host 0.0.0.0 --port 18791
```

默认通过父目录 `compose.local.yml` 暴露的宿主机端口连接 MongoDB、Redis 和
RabbitMQ。

comic PostgreSQL 初始化迁移位于：

```text
src/novelcomic_agent/comic/drafts/migrations/0001_initial.sql
```

应用当前不自动执行迁移。

## 端点

- `GET /health`：逐项检查 MongoDB、Redis、RabbitMQ；始终返回 HTTP 200，
  总状态为 `ok` 或 `degraded`。
- `GET /readyz`：执行相同的逐项检查；全部可用时返回 200，否则返回 503。
- `GET /v1/events/ping`：返回一个 `ping` SSE 事件后结束连接，便于自动化测试。

## 检查

```bash
ruff check .
pytest
```
