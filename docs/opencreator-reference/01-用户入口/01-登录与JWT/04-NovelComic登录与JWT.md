# NovelComic 登录与 JWT

字段见 [03-接口形状.md](./03-接口形状.md)。成功时读 `data`，外层是 `{ "code", "msg", "data" }`。OpenCreator 的运行时说明在 [01-登录与JWT.md](./01-登录与JWT.md)。这里只记 NovelComic 现在怎么走。

## 三种凭证

```text
发验证码 / 密码 / Google
  → ticket 或 sign_in_token
  → Session
  → JWT（Authorization: Bearer，模板 __opencreator_jwt）
  → 验签后 sub = user_id
  → 本地业务用户
```

`ticket` 和 `sign_in_token` 都只换 Session。登录用 `ticket`，注册用 `sign_in_token`，换 Session 时都填进 `ticket` 参数。业务接口只认 JWT。身份用户在 Clerk，`user.created` 验签通过之后才写入本地库。

模板名保持 `__opencreator_jwt`，和 `getToken({ template: "__opencreator_jwt" })` 一致。

## 文件调用顺序

入口是：[/sign-in](../../../../novelcomic-frontend/src/features/auth/SignInPage.tsx) 的表单 → [auth.ts](../../../../novelcomic-frontend/src/api/modules/auth.ts) → [controller/v2/auth.py](../../../../novelcomic-publisher/app/controller/v2/auth.py) → [auth_service.py](../../../../novelcomic-publisher/app/services/auth_service.py)。

文件链路：

`SignInPage.tsx` -> `auth.ts` -> `controller/v2/auth.py` -> `auth_service.py` -> `redis_service.py` / `clerk.py` / `email_service.py` -> `ClientProviders.tsx` -> `useHttp.tsx` -> `auth_middleware.py` -> `jwt.py` -> `authenticated_user.py` -> `controller/v1/user.py` -> `services/user.py` -> `controller/v2/user.py`

```text
发码        redis 冷却 → clerk 定 code_type → redis 存码 → email 发信 → redis 再写 60 秒冷却
验证码登录  redis 只收 login → clerk 开票 → redis 删码 → 返回 ticket
验证码注册  redis 只收 register → clerk 建用户并开票 → redis 删码 → 返回 sign_in_token
密码登录    clerk 查用户、验密、开票 → 返回 ticket。不读 Redis
换 Session  signIn.create({ strategy: 'ticket', ticket }) → setActive
业务 JWT    ClientProviders 注册 getApiToken
            useHttp 再取同一个模板，请求头写 Authorization: Bearer
            → auth_middleware → jwt → authenticated_user
改密        先过验签，user_id 取 sub → clerk 验旧密码并写入新密码
            token 从 getApiToken() 取，没取到就不发
本地用户    user.created → controller/v1/user.py 先验 Svix 签名 → services/user.py
            查询走 GET /api/v2/user/info
```

前端必须留下 `code_type`。Google 走 `authenticateWithRedirect({ strategy: 'oauth_google' })`，回来后有 Session 再 `setActive`。

表单包在 [providers-router.tsx](../../../../novelcomic-frontend/src/components/providers/providers-router.tsx) 的 `ClerkProvider` 里。`useSignIn` 来自 `@clerk/react/legacy`。

## 谁验签

[auth_middleware.py](../../../../novelcomic-publisher/app/middleware/auth_middleware.py) 的白名单放行这些路径，不带 `Authorization` 也能进：

- `POST /api/v2/auth/send-code`
- `POST /api/v2/auth/login-with-code`
- `POST /api/v2/auth/register-with-code`
- `POST /api/v2/auth/login-with-password`
- `POST /api/v1/user/create`

`POST /api/v2/auth/change-password` 和 `GET /api/v2/user/info` 不在白名单里。不带、带错、过期的 JWT 得到 401。合法 JWT 之后，`request.user.user_id` 等于 payload 的 `sub`。

`POST /api/v1/user/create` 不验 JWT，但要验 Clerk Webhook 的 Svix 签名，密钥是 `CLERK_WEBHOOK_SECRET`。签名不对返回 400。事件不是 `user.created` 时直接忽略。

## 本地用户

[services/user.py](../../../../novelcomic-publisher/app/services/user.py) 的集合是 `users`，文档只有 `user_id` 和 `user_email`。`user_id` 用 Clerk `data.id`。已存在则跳过，不重复插入。

`GET /api/v2/user/info` 用 `sub` 查这份文档。查不到时消息是 `User not found: <user_id>`，这时回去查 `clerk_webhook_handler()`，不要改验签。

套餐、积分、邀请不在这次落库里。
