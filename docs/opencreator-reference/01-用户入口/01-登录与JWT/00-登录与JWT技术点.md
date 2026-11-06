# 登录与 JWT：这里面有哪些技术点

先把这块拆开。每条都是后面对照 [01-登录与JWT.md](./01-登录与JWT.md) 时要认的东西，不是方案对比。NovelComic 还缺什么见 [登录页全链路与生命周期差距.md](../../../adr/登录页全链路与生命周期差距.md)；先写哪份文件见 [02-文件编写顺序.md](./02-文件编写顺序.md)。

整条链就这一段：

```text
验证码 / 密码 / Google
  → 换一张一次性票（ticket）
  → 前端拿票换浏览器 Session
  → 调业务接口时从 Session 取出 JWT
  → Publisher 验签，读 sub 当 user_id
  → 本地库里还要有一份业务用户
```

登录完成不是「接口 200」，也不是「页面能进」。三种凭证齐了、本地用户也能查到，才算打通。

---

## 1. 三种凭证，别混

| 凭证 | 干什么 | 不是什么 |
| --- | --- | --- |
| `ticket` / `sign_in_token` | 登录接口返回，前端交给身份平台换 Session | 不能当 Bearer 调业务接口 |
| Clerk Session | 浏览器登录态，由前端 SDK 管 | 后端业务接口不认 Session 本身 |
| `__opencreator_jwt` | 请求 Publisher 时放进 `Authorization` | 不是登录接口的返回值，也不该长期塞 localStorage |

看 OpenCreator 时先对这三样：谁签发、给谁用、活多久、丢了会怎样。

---

## 2. 身份用户 ≠ 业务用户

要两份数据，主键对齐：

- **身份侧**：邮箱、密码、OAuth、Session、签发 token。OpenCreator 交给 Clerk。
- **业务侧**：套餐、积分、邀请、项目归属。在自己的 Mongo 里。

关联键是 JWT 的 `sub`，也就是后面一路用的 `user_id`。

因此还要一条 **用户同步**：身份侧创建用户之后，用 webhook（`user.created`）在本地落库。这是最终一致，不是登录接口里顺手 insert。

对照时会看到：Session 已经有了、JWT 也能过，`/user/info` 仍可能 User not found。那是库还没写上，不是验签失败。

---

## 3. 三种登录方式

同一套后面（票 → Session → JWT），入口不同。

### 邮箱验证码

需要这些零件：

- 发码接口：按邮箱查身份用户，决定这次是 `login` 还是 `register`
- Redis：验证码、用途、过期、发送冷却；校验成功后删掉，不能重放
- 邮件通道：把码发出去
- 两个提交接口：登录验码、注册验码，不能拿 login 码去注册
- 注册额外：创身份用户、风控（设备指纹 / IP 国家 / 邮箱域名 / 时区）

### 密码

需要：

- 按邮箱查身份用户
- **验密在身份平台**，业务库不存密码哈希
- 同样只回 ticket，不回 JWT

### Google OAuth

需要：

- 前端身份 SDK 自己走 OAuth，不经过 Publisher 的验证码/密码接口
- 成功后照样 `setActive` 拿 Session
- 之后取 JWT、后端验签，和另外两条入口相同

---

## 4. ticket 换 Session

登录接口的终点是票，不是登录态。

前端必须再做两步：

```text
signIn.create({ strategy: "ticket", ticket })
  → createdSessionId
  → setActive({ session })
```

缺这一步：后端已经认这次验证码/密码，浏览器还没登录。

---

## 5. JWT 从哪来、怎么挂上请求

JWT **不是** Publisher 签的，也不是前端自己造的。

需要：

- 身份平台里一份 JWT Template（OpenCreator 名叫 `__opencreator_jwt`，配置在 Dashboard，不在仓库里）
- 前端 `getToken({ template })`，每次受保护请求前按需取
- 请求头：`Authorization: Bearer <JWT>`
- 统一 HTTP Client：没取到 token 就别发业务请求

长期登录态是 Session。JWT 是短时通行证。

---

## 6. 后端怎么验 JWT

一条请求进来，认证中间件做这些：

```text
路径是否白名单
  → 读 Authorization，去掉 Bearer
  → RS256 + 公钥验签
  → 检查是否过期
  → 读 payload.sub
  → request.user = AuthUser(user_id=sub)
  → 业务路由 Depends 取出当前用户
```

需要：

- PEM 公钥（或 JWKS + `kid`，轮换时用）
- 算法钉死 `RS256`，不要接受 HS256
- 至少验：签名、`exp`、`sub` 存在
- 更严的还要验 `iss` / `aud` / `azp`（OpenCreator 浏览器主链现在没全验，CLI 那条验了）

`sub` 有效只证明「这个人是谁」。项目、积分、别人的画布，还得按 `user_id` 查，不能信请求体里的用户 id。

---

## 7. 哪些接口必须公开

没 JWT 时要能登录，所以这些路径得进白名单：

- 发验证码
- 验证码登录 / 注册
- 密码登录
- 身份 webhook（不走 JWT，走自己的签名）
- 健康检查、文档、部分公开分享

不能进白名单：

- 改密码（已经登录了，要带 JWT）
- `/user/info` 和所有业务接口

白名单是「这条不验浏览器 JWT」，不是「这条不用认证」。webhook 必须验签名。

---

## 8. 用户 JWT 到不了 AI 仓

浏览器身份停在 Frontend ↔ Publisher（Agent 也验同一类 JWT）。再往后是内部凭证：

```text
浏览器 --Clerk JWT--> Publisher
Publisher --业务 user_id--> Consumer
Consumer --内部 auth_key--> opencreator-ai
```

要分开的几张钥匙：

| 钥匙 | 用途 |
| --- | --- |
| `__opencreator_jwt` | 浏览器用户调 Publisher / Agent |
| `ak_` / `sk_` | CLI / Developer API，机器凭证 |
| `INTERNAL_API_KEY` | Publisher ↔ Consumer |
| AI `auth_key` | Consumer 调 AI 任务接口 |
| 可灵 JWT | AI 调供应商的出站凭证，和用户登录无关 |

`client_context.user_id` 只是任务上下文，不能当身份证明。

---

## 9. 登出、禁用、JWT 失效不是同一时刻

Session 被撤掉之后，已经发出去的 JWT 通常还能用到 `exp`。

所以还要知道：

- Access Token 必须短
- 高风险操作要不要回查 Session
- 禁用用户：验签过了，业务层还得拦
- OpenCreator 现在没有做成单设备登录（注销其他 Session 的逻辑是关着的）

---

## 动手前要有的东西

### 外部

- Clerk 应用：邮箱验证码、密码、Google OAuth
- JWT Template，名字和前端 `getToken({ template })` 对上
- Clerk 后端 API Key、RS256 公钥（或 JWKS URL）
- `user.created` webhook 和验签 secret
- 发信通道（验证码邮件）

### 配置（只记名字，别把密钥写进仓库）

- 后端：`CLERK_API_KEY`、`CLERK_PEM_PUBLIC_KEY`、`CLERK_WEBHOOK_SECRET`
- 前端：publishable key（可以公开；secret key 不能进前端）

### 存储

- Redis：验证码、用途、过期、发送频率
- Mongo：业务用户，`user_id` 唯一且等于 JWT `sub`

套餐、积分、项目权限不要塞进 JWT。变得勤，必须服务端当场查。

### 前端要有的模块

- 身份 Provider（ClerkProvider）
- 登录表单、验证码表单
- 登录 API 封装（发码 / 验证码登录 / 注册 / 密码登录）
- 统一 HTTP Client：请求前 `getToken`，写 Bearer
- 页面门禁（有 Session 才渲染；这只挡 UI，不挡接口）

### 后端要有的模块

- 登录 schema / controller / 业务编排
- 身份平台适配（查用户、验密、建用户、开 ticket）
- Redis 验证码 + 邮件
- JWT 验签
- 认证中间件 + 白名单
- `get_current_user` 注入
- webhook 落本地用户（验签、幂等）

---

## 对照 OpenCreator 时按这个顺序看

| 技术点 | 去 01 的哪一节 |
| --- | --- |
| 三种凭证、整条链 | 第一节结论 |
| 前端表单、API、取 token | 第二节「前端必须有的文件」 |
| 登录接口、Clerk、Redis、验签、中间件 | 第二节「Publisher 必须有的文件」 |
| 发码 → 登录/注册 → 换 Session | 第三节 |
| 密码登录 | 第四节 |
| JWT Template、Bearer、RS256、`sub` | 第五节 |
| webhook 落库、User not found | 第六节 |
| 白名单、改密、WebSocket、CLI/API Key 别混 | 第八节 |
| 怎样才算真正登录完成 | 第九节 |

文件按什么顺序写，看 [02-文件编写顺序.md](./02-文件编写顺序.md)。

画布门禁、项目加载不在这篇里，那是 [02](../02-画布登录门禁与项目加载/02-画布登录门禁与项目加载.md)。内部 `auth_key`、租户隔离的完整清单在 [22](../../06-安全与运维/02-安全租户与内部鉴权/22-安全租户与内部鉴权.md)。
