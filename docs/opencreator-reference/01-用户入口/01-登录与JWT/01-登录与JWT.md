# OpenCreator 是怎么做登录与 JWT 的

## 一、先说结论

OpenCreator 使用 **Clerk + 自建登录页面 + Publisher JWT 验证中间件**。

它没有让前端生成 JWT，也没有让 Publisher 自签浏览器用户 JWT，而是把认证分成两步：

1. 登录接口返回 Clerk Sign-in Token，代码中叫 `ticket` 或 `sign_in_token`。
2. 前端拿 ticket 向 Clerk 换取 Session。调用业务接口时，再从 Session 获取 `__opencreator_jwt`，放入 `Authorization` 请求头。

完整链路：

👤 用户输入邮箱、验证码或密码  
→ [AuthForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/AuthForm.tsx)：登录入口，调用验证码、密码或 Google OAuth 登录流程  
→ [auth.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/auth.ts)：请求 Publisher 公开登录接口  
→ [auth.py](../../../../../opencreate/opencreator-publisher/controller/v2/auth.py)：接收前端登录请求  
→ [auth_service.py](../../../../../opencreate/opencreator-publisher/services/auth_service.py)：编排验证码登录、注册、密码登录逻辑  
→ [clerk.py](../../../../../opencreate/opencreator-publisher/services/clerk.py)：查询或创建 Clerk 用户，并创建 Sign-in Token  
→ [AuthForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/AuthForm.tsx) / [VerifyCodeForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/VerifyCodeForm.tsx)：调用 `signIn.create({ strategy: "ticket", ticket })`  
→ [AuthForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/AuthForm.tsx) / [VerifyCodeForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/VerifyCodeForm.tsx)：调用 `setActive({ session: createdSessionId })` 激活 Clerk Session  
→ [useHttp.tsx](../../../../../opencreate/opencreator-frontend/src/lib/useHttp.tsx) / [ClientProviders.tsx](../../../../../opencreate/opencreator-frontend/src/components/ClientProviders.tsx)：调用 `getToken({ template: "__opencreator_jwt" })`  
→ [client.ts](../../../../../opencreate/opencreator-frontend/src/api/client.ts) / [useHttp.tsx](../../../../../opencreate/opencreator-frontend/src/lib/useHttp.tsx)：把 JWT 放进 `Authorization: Bearer <JWT>`  
→ [auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py)：读取请求头里的 Bearer Token  
→ [jwt.py](../../../../../opencreate/opencreator-publisher/services/jwt.py)：用 Clerk PEM 公钥按 RS256 验签  
→ [jwt.py](../../../../../opencreate/opencreator-publisher/services/jwt.py)：读取 JWT 的 `sub` 作为 `user_id`  
→ [auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py)：把用户写入 `request.user`，业务接口通过 `request.user` 使用当前用户

所以必须区分三种东西：

- `ticket`：一次登录兑换凭证，不是业务 JWT。
- Clerk Session：浏览器登录状态，由 Clerk SDK 管理。
- `__opencreator_jwt`：调用 Publisher 业务接口时携带的 JWT。

## 二、要做哪些文件

### 1. 前端必须有的文件

按一次登录的顺序背。验证码要等发码接口返回后才到第 3 步。Session 激活之后才取 JWT。

前端文件链路：

`AuthForm.tsx` -> `auth.ts` -> `VerifyCodeForm.tsx` -> `ClientProviders.tsx` -> `client.ts` -> `useHttp.tsx`

1. `src/features/auth/components/AuthForm.tsx`：登录入口，先收邮箱、密码或 Google。
2. `src/api/modules/auth.ts`：这一步打开发码、密码登录或验证码提交接口。改密留到已经带 JWT 之后。
3. `src/features/auth/components/VerifyCodeForm.tsx`：拿到 `ticket` 或 `sign_in_token` 后，才换 Session 并 `setActive`。
4. `src/components/ClientProviders.tsx`：Session 激活后，把取 token 的函数注册进 API Client。
5. `src/api/client.ts`：保存这个函数，供后面的请求按需取 token。
6. `src/lib/useHttp.tsx`：业务请求前取出 `__opencreator_jwt`，写进 `Authorization`。

#### `src/features/auth/components/AuthForm.tsx`

OpenCreator 源码：[AuthForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/AuthForm.tsx)

负责登录入口，主要函数：

- `handleEmailContinue()`：校验邮箱并调用发送验证码接口，根据后端返回的 `code_type` 进入注册验证码或登录验证码流程。
- `handlePasswordLogin()`：调用密码登录接口，取得 `ticket` 后执行 `signIn.create()`，最后用 `setSignInActive()` 激活 Session。
- `handleGoogleAuth()`：打开 Clerk Google OAuth 弹窗；OAuth 完成后刷新 Clerk Client，并调用 `clerk.setActive()` 激活返回的 Session。
- `handleContinue()`：根据当前页面是否显示密码输入框，在验证码登录和密码登录之间分流。

#### `src/api/modules/auth.ts`

OpenCreator 源码：[auth.ts](../../../../../opencreate/opencreator-frontend/src/api/modules/auth.ts)

负责封装登录 HTTP 请求，必须有这些函数：

- `sendVerificationCode()`：请求 `POST /api/v2/auth/send-code`。
- `loginWithCode()`：请求 `POST /api/v2/auth/login-with-code`。
- `registerWithCode()`：请求 `POST /api/v2/auth/register-with-code`。
- `loginWithPassword()`：请求 `POST /api/v2/auth/login-with-password`。
- `changePassword()`：携带 JWT 请求 `POST /api/v2/auth/change-password`。

#### `src/features/auth/components/VerifyCodeForm.tsx`

OpenCreator 源码：[VerifyCodeForm.tsx](../../../../../opencreate/opencreator-frontend/src/features/auth/components/VerifyCodeForm.tsx)

负责提交邮箱验证码，主要函数：

- `handleVerify()`：根据 `codeType` 调用登录接口或注册接口。
- 登录时读取后端返回的 `ticket`，注册时读取 `sign_in_token`。
- 调用 `signIn.create({ strategy: "ticket", ticket })` 把 ticket 换成 Clerk Session。
- 调用 `setActive({ session: createdSessionId })` 激活 Session。
- `handleResendCode()`：重新调用发送验证码接口，并控制前端倒计时。

#### `src/components/ClientProviders.tsx`

OpenCreator 源码：[ClientProviders.tsx](../../../../../opencreate/opencreator-frontend/src/components/ClientProviders.tsx)

主要函数：

- `ApiTokenProvider()`：把 `getToken({ template: "__opencreator_jwt" })` 注册到 API Client。

这套 token provider 供部分独立 API 模块调用；普通业务请求也可以像 `useHttp.tsx` 一样直接取 token。两种写法最终使用的是同一个 Clerk Session 和同一个 JWT Template。

#### `src/api/client.ts`

OpenCreator 源码：[client.ts](../../../../../opencreate/opencreator-frontend/src/api/client.ts)

主要函数：

- `setTokenProvider()`：保存由 Clerk 提供的异步取 token 函数。
- `getApiToken()`：供 API 模块按需获取 token。
- `request()`：统一执行 `fetch`、解析 Publisher 响应和抛出认证错误。
- `requestData()`：只返回 Publisher 响应包中的 `data`。

#### `src/lib/useHttp.tsx`

OpenCreator 源码：[useHttp.tsx](../../../../../opencreate/opencreator-frontend/src/lib/useHttp.tsx)

负责受保护业务请求，主要函数：

- `initToken()`：调用 `getToken({ template: "__opencreator_jwt" })` 获取当前 JWT。
- `requireToken()`：没有取到 JWT 时停止请求，避免发送未认证的业务请求。
- `get()`、`post()`、`put()`、`patch()`、`del()`、`post_file()`：请求前统一加入 `Authorization: Bearer <token>`。

#### 前端文件调用流程

验证码登录/注册：

`src/features/auth/components/AuthForm.tsx` -> `src/api/modules/auth.ts` -> `src/features/auth/components/VerifyCodeForm.tsx` -> `src/api/modules/auth.ts`

密码登录：

`src/features/auth/components/AuthForm.tsx` -> `src/api/modules/auth.ts`

受保护业务请求：

`src/components/ClientProviders.tsx` -> `src/api/client.ts`

`src/lib/useHttp.tsx` -> 后端业务接口

### 2. Publisher 必须有的文件

按一次请求走进来的顺序背。前 3 个在请求之前就位。发码先查冷却，再查 Clerk，最后发信。业务请求才验 JWT。

Publisher 文件链路：

`config.py` -> `auth.py` -> `register.py` -> `routers.py` -> `controller/v2/auth.py` -> `auth_service.py` -> `redis_service.py` -> `clerk.py` -> `email_service.py` -> `auth_middleware.py` -> `jwt.py` -> `authenticated_user.py`

1. `core/config.py`：启动时读出 Clerk API Key、公钥和 webhook secret。
2. `schemas/auth.py`：请求进来之前，入参和返回字段已经定死。
3. `core/register.py`：启动时挂上认证中间件和路由。
4. `controller/routers.py`：请求先到这里，再分到 `/api/v2/auth`。
5. `controller/v2/auth.py`：收参并调用 `AuthService`，不自己调 Clerk。
6. `services/auth_service.py`：编排发码、验码、注册、密码登录和改密。
7. `services/redis_service.py`：先查发送冷却，再存验证码；校验成功后删除。
8. `services/clerk.py`：查用户、验密、建用户、开 Sign-in Token。
9. `services/email_service.py`：验证码写入 Redis 之后，把邮件发出去。
10. `middleware/auth_middleware.py`：登录接口走白名单。业务请求才验 Bearer。
11. `services/jwt.py`：中间件调用它，用 RS256 公钥验签，读 `sub` 当 `user_id`。
12. `dependencies/authenticated_user.py`：从 `request.user` 取出当前用户给路由用。

#### `core/config.py`

OpenCreator 源码：[core/config.py](../../../../../opencreate/opencreator-publisher/core/config.py)

至少需要：

- `CLERK_API_KEY`：Publisher 调 Clerk 后端 API。
- `CLERK_PEM_PUBLIC_KEY`：Publisher 验证 Clerk JWT 的 RS256 公钥。
- `CLERK_WEBHOOK_SECRET`：`controller/v3/clerk_webhook.py` 验证 Clerk Session Webhook 时使用。
- `FASTAPI_API_PREFIX`：组成 `/api/v1`、`/api/v2` 等路由前缀。

#### `schemas/auth.py`

OpenCreator 源码：[schemas/auth.py](../../../../../opencreate/opencreator-publisher/schemas/auth.py)

负责定义接口入参和返回值：

- `SendCodeRequest`、`SendCodeResponse`：发送验证码。
- `LoginWithCodeRequest`：验证码登录。
- `RegisterWithCodeRequest`：验证码注册。
- `LoginWithPasswordRequest`：密码登录。
- `LoginResponse`：返回 `ticket` 和 `user_id`。
- `RegisterResponse`：返回 `sign_in_token`、有效期和 `user_id`。
- `ChangePasswordRequest`、`ChangePasswordResponse`：修改密码。

#### `core/register.py`

OpenCreator 源码：[core/register.py](../../../../../opencreate/opencreator-publisher/core/register.py)

主要函数：

- `register_middleware()`：把 `AuthenticationMiddleware(ClerkAuthenticationBackend())` 和 `AuthErrorMiddleware` 注册到 FastAPI。
- `register_router()`：注册 v1、v2、v3 路由。
- `register_app()`：创建应用并统一注册中间件、路由和异常处理。

#### `controller/routers.py`

OpenCreator 源码：[controller/routers.py](../../../../../opencreate/opencreator-publisher/controller/routers.py)

负责把 `controller/v2/auth.py` 注册到 `/api/v2/auth`。登录接口不加 `get_api_key` 路由依赖，是否公开最终仍由认证中间件的 `WHITE_LIST` 决定。

#### `controller/v2/auth.py`

OpenCreator 源码：[controller/v2/auth.py](../../../../../opencreate/opencreator-publisher/controller/v2/auth.py)

负责暴露 HTTP 接口，不直接实现 Clerk 业务：

- `send_verification_code()`：接收邮箱、设备指纹和时区，调用业务层发送验证码。
- `login_with_code()`：调用业务层校验验证码并登录。
- `register_with_code()`：提取客户端 IP，调用业务层完成风控、注册和 ticket 创建。
- `login_with_password()`：调用业务层查询用户、验证密码并创建 ticket。
- `change_password()`：从认证用户中取得 `user_id`，验证旧密码后修改密码。

#### `services/auth_service.py`

OpenCreator 源码：[services/auth_service.py](../../../../../opencreate/opencreator-publisher/services/auth_service.py)

这是登录业务编排的核心，主要函数：

- `generate_verification_code()`：生成 6 位数字验证码。
- `send_verification_code()`：检查发送频率、查询 Clerk 用户是否存在、确定 `login/register` 类型、把验证码存入 Redis、发送邮件。
- `verify_code_and_login()`：从 Redis 读取验证码，要求类型为 `login`，验证成功后为已有 Clerk 用户创建 ticket，并删除验证码。
- `register_with_code()`：要求验证码类型为 `register`，执行设备指纹、IP 国家、邮箱域名和时区风控，然后创建 Clerk 用户和 ticket。
- `login_with_password()`：按邮箱查询 Clerk 用户，验证密码，创建 ticket。
- `change_password()`：验证旧密码并更新 Clerk 用户密码。

#### `services/redis_service.py`

OpenCreator 源码：[redis_service.py](../../../../../opencreate/opencreator-publisher/services/redis_service.py)

负责验证码和频率限制：

- `check_rate_limit()`：检查邮箱是否仍在发送冷却期。
- `set_rate_limit()`：验证码发送后写入频率限制 key。
- `get_rate_limit_ttl()`：返回剩余冷却秒数。
- `store_code_data()`：保存验证码、用途、设备指纹、时区和创建时间。
- `get_code_data()`：读取验证码数据。
- `delete_code_data()`：验证成功后删除验证码，防止重复使用。

#### `services/clerk.py`

OpenCreator 源码：[services/clerk.py](../../../../../opencreate/opencreator-publisher/services/clerk.py)

这是 Clerk 后端 SDK 适配层，主要函数：

- `get_user_by_email()`：按邮箱查询 Clerk 用户。
- `verify_user_password()`：让 Clerk 验证用户密码。
- `create_user_with_email()`：在 Clerk 创建邮箱用户，并写入设备指纹、时区、来源、邀请码等 metadata。
- `create_sign_in_token()`：为 Clerk 用户创建 Sign-in Token，返回给前端换 Session。
- `update_user_password()`：修改 Clerk 用户密码。
- `get_user_sessions()`、`revoke_session()`、`revoke_other_sessions()`：Session 查询和注销能力；不属于 JWT 验签主链。

#### `services/email_service.py`

OpenCreator 源码：[services/email_service.py](../../../../../opencreate/opencreator-publisher/services/email_service.py)

主要函数：

- `send_verification_code()`：发送验证码邮件；OpenCreator 会根据邮箱类型选择阿里云或 AWS SES。

#### `middleware/auth_middleware.py`

OpenCreator 源码：[auth_middleware.py](../../../../../opencreate/opencreator-publisher/middleware/auth_middleware.py)

负责所有 HTTP 请求的认证入口：

- `WHITE_LIST`：声明不需要浏览器用户 JWT 的公开路径，登录、注册和验证码接口必须加入这里。
- `AuthUser`：只保存认证后的 `user_id`。
- `ClerkAuthenticationBackend.authenticate()`：
  1. 判断请求是否命中白名单；
  2. 读取 `Authorization`；
  3. 去掉 `Bearer`  前缀；
  4. 调用 `JwtService.get_user_id_with_backoff()`；
  5. 创建 `AuthUser(user_id=user_id)` 并写入 `request.user`。
- `AuthErrorMiddleware.dispatch()`：把认证异常转换成统一 401 响应。

#### `services/jwt.py`

OpenCreator 源码：[services/jwt.py](../../../../../opencreate/opencreator-publisher/services/jwt.py)

负责业务 JWT 验证：

- `JwtService.get_user_id_with_backoff()`：使用 `CLERK_PEM_PUBLIC_KEY` 和 `RS256` 解码 JWT，检查 payload 必须是对象并且包含 `sub`，最后返回 `sub`。
- `JwtExpiredTokenError`：表示 JWT 已过期。
- `JwtInvalidTokenError`：表示签名、格式或 `sub` 不合法。

实际验签代码等价于：

```python
decoded_token = jwt.decode(
    token,
    CLERK_PEM_PUBLIC_KEY,
    algorithms=["RS256"],
)
user_id = decoded_token.get("sub")
```

#### `dependencies/authenticated_user.py`

OpenCreator 源码：[authenticated_user.py](../../../../../opencreate/opencreator-publisher/dependencies/authenticated_user.py)

主要函数：

- `get_authenticated_user()`：从 `request.user` 取出中间件已经认证的 `AuthUser`，供路由通过 `Depends()` 注入。

业务接口使用方式：

```python
async def user_info_v2(
    user: AuthUser = Depends(get_authenticated_user),
):
    return await UserService.get_user_by_id(user.user_id)
```

## 三、邮箱验证码登录是怎么执行的

### 第一步：发送验证码

```text
AuthForm.handleEmailContinue()
  → AuthAPI.sendVerificationCode()
  → POST /api/v2/auth/send-code
  → controller.send_verification_code()
  → AuthService.send_verification_code()
  → RedisService.check_rate_limit()
  → ClerkService.get_user_by_email()
  → 得到 code_type：已有用户为 login，新用户为 register
  → RedisService.store_code_data()
  → EmailService.send_verification_code()
  → RedisService.set_rate_limit()
```

后端返回：

```json
{
  "email": "user@example.com",
  "code_type": "login",
  "expires_in": 300
}
```

前端必须保存 `code_type`，因为后面要决定调用登录接口还是注册接口。

### 第二步：已有用户验证码登录

```text
VerifyCodeForm.handleVerify()
  → AuthAPI.loginWithCode()
  → POST /api/v2/auth/login-with-code
  → controller.login_with_code()
  → AuthService.verify_code_and_login()
  → RedisService.get_code_data()
  → 校验 code_type == "login"
  → 校验验证码
  → ClerkService.get_user_by_email()
  → ClerkService.create_sign_in_token()
  → RedisService.delete_code_data()
  → 返回 ticket
```

### 第三步：新用户验证码注册

```text
VerifyCodeForm.handleVerify()
  → AuthAPI.registerWithCode()
  → POST /api/v2/auth/register-with-code
  → controller.register_with_code()
  → AuthService.register_with_code()
  → 校验 code_type == "register" 和验证码
  → 检查用户没有重复注册
  → 执行设备、IP、邮箱、时区风控
  → ClerkService.create_user_with_email()
  → ClerkService.create_sign_in_token()
  → RedisService.delete_code_data()
  → 返回 sign_in_token
```

### 第四步：ticket 换 Session

登录和注册最后都执行：

```ts
const result = await signIn.create({
  strategy: 'ticket',
  ticket,
})

if (result.status === 'complete' && result.createdSessionId) {
  await setActive({ session: result.createdSessionId })
}
```

这一步完成后浏览器才真正拥有 Clerk Session。

## 四、密码登录是怎么执行的

```text
AuthForm.handlePasswordLogin()
  → AuthAPI.loginWithPassword()
  → POST /api/v2/auth/login-with-password
  → controller.login_with_password()
  → AuthService.login_with_password()
  → ClerkService.get_user_by_email()
  → ClerkService.verify_user_password()
  → ClerkService.create_sign_in_token()
  → 前端 signIn.create({ strategy: "ticket", ticket })
  → 前端 setActive({ session })
```

Publisher 仍然只返回 ticket，不直接返回业务 JWT。

## 五、JWT 是怎么生成和使用的

### 1. JWT 在哪里生成

JWT 由 Clerk 根据 Dashboard 中的 JWT Template 生成，模板名是：

```text
__opencreator_jwt
```

这个模板配置不在代码仓库中。部署前必须在 Clerk Dashboard 创建同名模板，否则：

```ts
getToken({ template: '__opencreator_jwt' })
```

无法取得 Publisher 需要的 JWT。

### 2. 前端怎么使用 JWT

每次受保护请求前按需取 token：

```ts
const token = await getToken({
  template: '__opencreator_jwt',
})
```

然后加入请求头：

```http
Authorization: Bearer <JWT>
```

OpenCreator 不把业务 JWT 当作长期登录凭证保存；长期状态由 Clerk Session 管理，JWT 由 Clerk SDK 按需获取和刷新。

### 3. Publisher 怎么验证 JWT

```text
HTTP 请求
  → AuthenticationMiddleware
  → ClerkAuthenticationBackend.authenticate()
  → 检查 WHITE_LIST
  → 读取 Authorization
  → JwtService.get_user_id_with_backoff()
  → RS256 + CLERK_PEM_PUBLIC_KEY 验签
  → 读取 payload.sub
  → AuthUser(user_id=sub)
  → request.user
  → get_authenticated_user()
  → 业务 Controller
```

当前浏览器业务 JWT 主链实际验证：

- JWT 签名；
- `exp` 是否过期；
- payload 是否为对象；
- `sub` 是否存在。

`sub` 就是 OpenCreator 后续使用的 `user_id`。

## 六、注册后为什么还要 Clerk Webhook

Clerk 用户和 OpenCreator MongoDB 用户不是同一份数据：

- Clerk 保存登录身份、密码、OAuth 和 Session。
- MongoDB 保存套餐、积分、邀请关系等业务数据。

OpenCreator 通过 Clerk 的 `user.created` 事件创建本地业务用户。

涉及文件和函数：

- [controller/v1/user.py](../../../../../opencreate/opencreator-publisher/controller/v1/user.py) 的 `clerk_webhook_handler()`：处理 `user.created`，调用 `UserService.create_user()` 写入 MongoDB，并处理邀请关系和新用户积分。
- [controller/v2/user.py](../../../../../opencreate/opencreator-publisher/controller/v2/user.py) 的 `user_info_v2()`：使用 JWT 中的 `user_id` 查询本地业务用户。

因此注册后可能短暂出现：

```text
Clerk Session 已激活
  → JWT 验证成功
  → Clerk webhook 还没完成 MongoDB 落库
  → GET /api/v2/user/info 返回 User not found
```

这不是 JWT 验证失败，而是本地用户数据尚未同步完成。

## 七、照 OpenCreator 实现时的落地顺序

落地链路：

`Clerk 应用` -> `__opencreator_jwt` -> `Publisher 环境变量` -> `schemas/auth.py` -> `redis_service.py` / `email_service.py` / `clerk.py` -> `auth_service.py` -> `controller/v2/auth.py` -> `WHITE_LIST` -> `AuthenticationMiddleware` -> `AuthForm.tsx` / `VerifyCodeForm.tsx` -> `getToken({ template })` -> `Clerk user.created Webhook` -> `/api/v2/user/info`

1. 在 Clerk 创建应用，配置邮箱、密码和 Google OAuth 登录方式。
2. 在 Clerk Dashboard 创建 `__opencreator_jwt` JWT Template。
3. 配置 Publisher 的 `CLERK_API_KEY`、`CLERK_PEM_PUBLIC_KEY` 和 `CLERK_WEBHOOK_SECRET`。
4. 完成 `schemas/auth.py`，先固定登录接口的数据结构。
5. 完成 Redis 验证码、邮件发送和 `ClerkService`。
6. 完成 `AuthService`，把验证码、风控、Clerk 用户和 ticket 串起来。
7. 完成 `controller/v2/auth.py` 并注册路由。
8. 把登录接口加入 `WHITE_LIST`，其余业务接口默认要求 JWT。
9. 注册 `AuthenticationMiddleware`，实现 JWT 验签和 `request.user` 注入。
10. 前端完成登录表单、验证码表单和 ticket 换 Session。
11. 前端业务请求统一调用 `getToken({ template: "__opencreator_jwt" })` 并添加 Bearer Token。
12. 配置 Clerk `user.created` Webhook，把 Clerk 用户同步到本地数据库。
13. 登录后调用 `/api/v2/user/info`，确认 Session、JWT 和本地业务用户三层都已打通。

## 八、实现时必须注意

- `ticket` 不能当 JWT 使用，它只能交给 Clerk `signIn.create()` 换 Session。
- 登录接口必须公开，否则用户还没有 JWT 时无法登录。
- 业务接口不能只靠前端页面拦截，真正的安全边界是 Publisher 认证中间件。
- `get_user_id_with_backoff()` 虽然名字包含 `backoff`，当前实现没有重试。
- 当前主 JWT 验证链没有统一校验 `aud`、`azp` 等声明；如果新项目安全要求更高，应补充 issuer、audience 和 authorized party 校验。
- `dependencies/api_key.py` 中的 `get_api_key()` 只检查 `Authorization` 请求头是否存在，不负责 JWT 验签；真正验签发生在 `ClerkAuthenticationBackend`。
- 当前创建本地用户的 `controller/v1/user.py::clerk_webhook_handler()` 直接读取 `user.created` 请求体，没有使用 `CLERK_WEBHOOK_SECRET` 验签；新项目照此实现前应补上 Svix 签名验证。`controller/v3/clerk_webhook.py` 有签名验证，但它处理的是 Session 事件，不负责创建本地用户。
- WebSocket 被认证中间件直接放行，不能认为 HTTP JWT 逻辑会自动保护 WebSocket。
- CLI 的 Session JWT、`ak_` API Key 和 Developer API 的 `sk_` Key 是其他认证链路，不要和浏览器的 `__opencreator_jwt` 混用。

## 九、判断登录是否真正完成

```text
Publisher 返回 ticket
  → 只表示可以向 Clerk 换 Session

setActive() 完成
  → 只表示浏览器已有 Clerk Session

携带 __opencreator_jwt 请求 /api/v2/user/info 成功
  → 才表示 JWT 验证通过，并且本地业务用户已经可用
```

