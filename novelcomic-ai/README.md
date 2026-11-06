# novelcomic-ai

独立的 Node.js 22 + pnpm workspace TypeScript ESM 基础仓库，包含 Fastify API 与 BullMQ worker。当前只实现本地 smoke 队列闭环，不接入任何真实厂商或业务。

## 环境要求

Node.js 22+、pnpm 10+、MongoDB、Redis。

## 启动

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

API 默认监听 `http://localhost:5151`：

- `GET /health`：进程存活检查
- `GET /readyz`：MongoDB 和 Redis 就绪检查
- `POST /v1/smoke/jobs`：创建 smoke job，body 可传 `{ "message": "hello" }`
- `GET /v1/smoke/jobs/:id`：查询 job 状态和结果

```bash
curl -X POST http://localhost:5151/v1/smoke/jobs -H 'content-type: application/json' -d '{"message":"hello"}'
```

## KIE 配置

本地 `.env.local` 支持 `KIE_API_KEY` 和 `KIE_BASE_URL`。密钥文件已被 Git 忽略；
当前仅完成配置加载，尚未实现 KIE 模型调用接口。

质量命令：`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`。所有 BullMQ key 使用 `novelcomic` 前缀。
