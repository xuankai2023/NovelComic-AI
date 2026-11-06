# novelcomic-consumer

NovelComic 后台消费者骨架，基于 Python 3.11 和 FastAPI。当前 worker 仅等待停止事件，不声明或消费任何业务队列。

## 安装

```bash
cp .env.example .env.local
uv sync --extra dev
# 或：python3.11 -m venv .venv && .venv/bin/pip install -e '.[dev]'
```

## 运行

```bash
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001
```

- `GET /health`：仅表示 API 进程可响应。
- `GET /readyz`：分别检查 MongoDB、Redis、RabbitMQ；全部正常返回 200，否则返回 503。

## 检查

```bash
uv run ruff check .
uv run pytest
```
