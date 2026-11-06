# 素材、存储、人脸与图像处理：按节补

这一份只写和现在 OpenCreator 现码对不上的行为。后面改代码时，按每一节列出的文件做 diff，只补这一节写明的行为。

OpenCreator 看 `opencreator-frontend`、`opencreator-publisher`、`opencreator-ai`。NovelComic 看 `novelcomic-frontend`、`novelcomic-publisher`、`novelcomic-ai`。

不在这一段：登录换 JWT、首页 Composer 发送、画布节点外壳、轨迹编辑器里除抠图以外的状态、模型家族注册、支付三池的入账规则。

# 已经对齐，不要重写

这些路径对过现码，用户能观察到的结果已经相同。差的是 import、日志和类怎么拆。

- `POST /api/v2/cos/presign` 返回 `presigned_url`、`object_key`、`cdn_url`、`expires_in`。`expires_in` 是 3600。对象键前缀是 `images/`、`videos/`、`audio/`、`uploads/`，名字 10 位，带原扩展名。这个接口不写 `user_id`。`/api/v2/cos/*` 在 JWT 白名单里
- `postUploadFile()` 的顺序是：没传 `skipPreprocess` 才压缩图片，然后预签名，再 PUT，最后 `normalizeCdnResourceUrl`
- 素材库三个 POST 都要当前用户：`/api/v3/assets/library`、`/api/v3/assets/fetch`、`/api/v3/assets/library/sink`
- `library_kind` 只有 `character`、`product`、`brand_visual`。上传固定 `source_kind = uploaded`。同一用户、同一 `library_kind`、同一 URL 再写一次，返回已有记录，并补上还没有的媒体尺寸
- 入库 URL 必须是 `https`，不能带用户名密码，端口只能空或 443。主机来自 COS CDN、加速域名、S3、CloudFront，以及 `{bucket}.cos.{region}.myqcloud.com`
- `sink` 找不到当前用户的生成结果返回 404。URL 不属于这条结果返回 400。写入前记录变了返回 409
- 人脸 `ingest`：同一 `user_id + url` 返回当前状态。`failed` 且还没有 `asset_id` 允许再创建。`content_hash` 命中别人的 `active` 时，新记录直接 `active`，并带 `reused_from_content_hash`
- `status` 按当前用户读 `media_face_verifications`。没有记录的 URL 返回 `not_found`，不落库
- 画布 ready 之后会查状态。`pending` / `processing` 每 3000 毫秒再查。`canvasEditorContent` 挂了 `FaceVerificationController`
- `MongoMediaAssetResolver` 只在 provider 是 `byteplus` 且状态是 `active` 时返回 `asset://{asset_id}`。其它 provider 是 `not_found`。还没 `active` 是 `not_ready`
- artifact worker：失败任务跳过整理，直接 `callback_pending`，再投 `consumer-callback`。成功任务走 `processing_artifacts`，再 `processResult`，再 `callback_pending`。worker 用的是 `PassThroughArtifactStore`，只在配置了 base URL 时补 `artifact_base_url`
- 分割单价按一次 0.0016 元、汇率 6.7、每美元 1000 积分向上取整，至少 1 积分。对象键前缀是 `images/segmentation/`，扩展名 `.png`
- 前端 `segmentImageCommon` 默认 `returnForm = crop`。没有 `result_url` 会抛错。402 或文案里的 insufficient credits 被认成积分不足
- 盖章还不是远程 URL 时，先 `postUploadFile(..., { skipPreprocess: true })`，再分割。失败回到 `idle`。积分不足和分割失败用不同文案

# 1. 浏览器直传要能超时、重试，并补上 base64 旁路

做完要达到：大文件按体积超时。网络错误、超时、5xx 和 403 会重试。预签名剩下不到 30 秒，或 PUT 返回 403，会换一张新的预签名再传。视频预览图仍走 `POST /api/v1/cos/upload_base64`。

## 现在

`s3DirectUpload.ts` 的 `uploadToS3Reliable()` 最多再试 1 次，而且只在 403，或预签名已经过期时才换签。没有按文件大小算的超时。`onabort` 不 reject，取消后这次 PUT 会挂住。网络错误和 5xx 直接失败。

`aws.ts` 里虽然写了 30 秒的刷新判断，但可靠上传只有在 403 或已经过期时才会调用它。到期前 30 秒不会提前换签。

进度回调现在是一个 0 到 100 的数字。OpenCreator 传的是 `{ loaded, total, percent }`。

`aws.ts` 没有 `postUploadImage()`。Publisher 没有 `upload_base64_to_cos()`，也没有 `POST /api/v1/cos/upload_base64`。用户选择的原始文件继续走 v2 预签名，这一段不要改这条主路径。

## 改哪些文件

1. `novelcomic-frontend/src/lib/s3DirectUpload.ts`：超时、重试、取消、进度事件对齐 OpenCreator 同名文件。超时至少 30 秒，按文件大小、每秒 50KB 上调。默认可重试 3 次，间隔从 1 秒按 2 的幂增加。403、5xx、网络错误、超时可以重试。403，或离过期不到 30 秒，调用 `resolveTarget` 换签。取消必须 reject。
2. `novelcomic-frontend/src/api/modules/aws.ts`：补 `postUploadImage()`，请求 `POST /api/v1/cos/upload_base64`，返回值走 `normalizeCdnResourceUrl`。`postUploadFile()` 继续把换签交给上面的可靠上传。
3. `novelcomic-publisher/app/utils/cos.py`：补 `upload_base64_to_cos()` 和异步包装。服务端 `put_object`，返回 CDN URL。
4. 新增 v1 COS 路由，挂到 `/api/v1/cos/upload_base64`。对照 OpenCreator `controller/v1/cos.py`。

调用 `onProgress` 的地方改成读 `percent`。

# 2. 生成结果按订阅保留，探测要能拿到尺寸

做完要达到：上传列表和生成结果列表不是同一批数据。生成结果只出成功记录，并按订阅等级藏起过期项。`sink` 只能归档成功结果。图片和视频在客户端没给尺寸时，服务端仍能探出宽高。

## 现在

`AssetsService._fetch_generated_assets_page()` 读 `node_results`。查询不要求 `status = success`。`subscription_level` 固定写 0，`retention_days` 固定空，`hidden_count` 固定 0。`category` 是 `audio`、`text`、`cut` 时，上传列表会在图片和视频过滤落空后把该用户的上传记录都返回。

上传列表把库里整份 `metadata` 合并进返回的 `metadata`。OpenCreator 只额外带上 `resource_info` 和 `aspect_ratio`。

`sink` 不要求目标记录 `status = success`。并发插入同一条上传记录时，没有处理重复键，第二次可能直接失败，而不是返回已有记录。

`asset_media_info.py` 只解析下载到的 PNG、GIF、JPEG、WebP 和 MP4 头。OpenCreator 的图片先请求 COS 的 `imageInfo`。视频头解析失败时，再用 OpenCV 读宽高。探测完仍然没有尺寸时，OpenCreator 会打警告，记录照样落下。

生成结果继续放在 NovelComic 已经在写的 `node_results`。不要为了集合名再开一套 `results`。

## 改哪些文件

1. `novelcomic-publisher/app/services/assets.py`，对照 OpenCreator `services/assets.py`、`dao/asset_library.py`、`dao/result.py` 的 `_build_user_assets_query()`。
2. `novelcomic-publisher/app/utils/asset_media_info.py`，对照 OpenCreator 同名文件的 `imageInfo` 和 OpenCV 分支。

生成结果查询：

- 只要 `status = success`
- `source_kind = generated` 时，包含还没有 `metadata.source_kind` 的旧记录
- 保留天数：等级 0 是 7 天，1 和 2 是 30 天，3 不限制。等级读当前用户订阅，读失败按 0
- `total_count` 不算保留期。`visible_total_count` 算。`hidden_count` 是两者的差
- 返回里的 `metadata.source_kind` 补成 `generated`
- 空的 `resource_info`、空的 `aspect_ratio` 不要留在返回里

`sink` 的查找和更新都加上 `status = success`。上传创建遇到重复键时，返回已有记录并合并还没有的尺寸。探测后仍然没有宽高和比例时打警告，不拒绝写入。

# 3. 合规盾只对 COS 地址，点击才入库

做完要达到：图片和视频节点上有合规盾。画布只查询，不入库。用户点盾牌，才对还是 `idle` 或 `failed` 的地址调用 `ingest`。能进检测的地址必须落在 COS CDN 前缀上。

## 现在

`use-verifiable-media.ts` 收集所有 `https` 地址。`imageInput` 收了 `imageBase64` 之后，仍会把该节点的生成结果再收一遍。没有 ImageKit 规范化，也不要求 COS CDN 前缀。

`use-face-verification-controller.tsx` 在 URL 一变化时就请求全部地址，没有 250 毫秒延迟。轮询要等满 3 秒才打第一下。换 `workflowId` 不 `reset()`。

`face-verification.store.ts` 只按 URL 存查询结果。没有当前节点正在看的那条媒体，没有提交中，也没有请求失败。

`ingestVerifiableMedia()` 没有界面调用。没有 `ComplianceShield`，没有 `use-node-face-verification`。图片和视频结果组件也不会把当前画面写进这个 store。

OpenCreator：

- `normalizeFaceVerificationUrl()` 先走 ImageKit，再要求以 COS CDN 前缀开头。其它地址丢掉
- `imageInput` 只看 `imageBase64`，`videoInput` 只看 `inputVideo`。其它图片或视频节点只看输出里的 CDN 地址
- 没见过的 URL 延迟 250 毫秒查一次。`pending` / `processing` 先立刻查，再每 3000 毫秒查。`workflowId` 变化时 `reset()`
- 盾牌只出现在图片或视频节点。节点正在上传、正在跑，或当前结果是失败时，不渲染
- 一个节点多条 URL 时，任一 `verifying` 就显示验证中。有失败且没有进行中的，显示失败
- 验证中再点盾牌，不再次 `ingest`

## 改哪些文件

1. `use-verifiable-media.ts`：按节点类型收集，并套上 COS 前缀过滤。
2. `face-verification.store.ts`：补当前媒体、提交中、请求失败和 `reset()`。
3. `use-face-verification-controller.tsx`：250 毫秒首查、立刻开始的 3 秒轮询、换 flow 清空。组件不再接收 `results`，自己从节点结果里取 URL。
4. 新建 `use-node-face-verification.ts` 和 `custom_nodes/layers/ComplianceShield.tsx`。对照 OpenCreator 同名文件。
5. 图片和视频节点，以及图片、视频结果内容，把当前 URL 写进 store，并挂上盾牌。`shouldShowComplianceShield()` 只对图片和视频输出为真。

Publisher 的 `ingest` 继续按现有记录做幂等。这一节不改 BytePlus 签名。

# 4. CreateAsset 走 BytePlus 签名，GetAsset 按间隔回写

做完要达到：点盾牌后 Publisher 用签名调用 BytePlus CreateAsset。时长不在 1.8 秒到 15.2 秒时，记录写成 `failed`，公开原因是这段时长限制。AI 返回 202 只表示入队。worker 之后把同一条记录写成 `active`、`failed` 或 `unknown`。写操作不碰 `ai_task`。

## 现在

`_create_byteplus_asset()` 向配置里的 URL 发一封带可选 Bearer 的 JSON。没有 HMAC 签名，也不识别时长超限。

`_enqueue_ai_verification()` 在没配 AI 地址时直接返回。记录会停在 `processing`。它不看返回项的 `status`，也不带 `auth_key`。并发插入同一 URL 时，没有把重复键收成已有记录。

AI 的 `POST /v1/media-face-verifications/enqueue` 把单项状态写成 `queued`。OpenCreator 写成 `enqueued`。没有记录是 `not_found`。入队异常是 `enqueue_failed`。HTTP 仍是 202。

worker 的 GetAsset 同样是一封可选 Bearer 的 JSON。没配地址时一直当作 `Processing`。再次入队没有延迟，会紧循环打 GetAsset。API 第一次入队的 job id 固定成 `media-face-{assetId}`，同一次 asset 的重复 enqueue 会被丢掉。回写不带 `project_name` 和 `asset_url`，也不阻止把已经 `active` 的记录降级。

OpenCreator：

- CreateAsset 使用 HMAC-SHA256。`InvalidParameter.DurationTooLong` 写成 `failed`，公开文案是 `Video duration must be between 1.8s and 15.2s.`
- 没配 AI 地址或内部密钥时，enqueue 失败，记录进入 `failed`
- enqueue 带 `auth_key` 和 `trace_id`。返回里当前项的 `status` 必须是 `enqueued`，否则失败
- 可重试的 HTTP 错误会按退避再试。4xx 里除了 408 和 429，不再试
- worker 用签名的 GetAsset。`Active` 写 `active`，`Failed` 写 `failed`。未结束则按 `pollIntervalMs` 延迟再入队。超过 `pollMaxAgeMs` 写 `unknown`，`sync_status` 是 `sync_failed`
- 配置错误继续抛出。不可重试的 GetAsset 错误写 `unknown`
- 更新必须命中同一条 `media_url + asset_id`。已经 `active` 的记录不能被后到的状态盖掉

## 改哪些文件

1. `novelcomic-publisher/app/services/media_face_verification.py`：签名 CreateAsset、时长拒绝、enqueue 必须成功、重复键。
2. `novelcomic-ai/apps/api/src/index.ts` 里的 enqueue 路由：单项状态改成 `enqueued` / `not_found` / `enqueue_failed`，响应里带 `provider` 和 `results`。
3. `novelcomic-ai/packages/runtime/src/index.ts` 的 `MediaFaceVerificationWorkerProcessor`，以及 `apps/worker/src/index.ts` 里的 GetAsset 客户端。轮询间隔、最长等待、延迟再入队和回写字段对齐 OpenCreator `media-face-verification-worker.ts`。

`status` 查询继续只读 Mongo，不反查 AI。

# 5. 提交 BytePlus 媒体时才换成 asset://

做完要达到：记录变成 `active` 之后，Seedance 提交体里的对应 URL 是 `asset://{asset_id}`。还没就绪就拒绝这次提交。没有检测记录时，URL 保持原样。

## 现在

`MongoMediaAssetResolver` 已经能算出 `asset://`。worker 启动时没有把它放进 provider 上下文。`novelcomic-ai/packages/core` 里没有提交前调用 `resolveUrl()` 的路径。

OpenCreator 在 `apps/worker/src/main.ts` 把 `MongoMediaAssetResolver` 交给 provider。`packages/core/src/api/byteplus/seedance-2.0.ts` 的 `resolveSeedanceMediaUrl()`，以及 KIE 的 `seedance-2.ts`、`seedance-2.5.ts`，在组请求前调用它：

- 已经是 `asset://`，或 provider 不是这条解析，保持原 URL
- `not_found` 保持原 URL
- `resolved` 换成 `asset_uri`
- `not_ready` 抛出不可重试错误，`error_code` 是 `REAL_PERSON_DETECTED`

## 改哪些文件

1. `novelcomic-ai/apps/worker/src/index.ts`：provider 执行上下文带上 `MongoMediaAssetResolver`。
2. NovelComic 里已经存在的 BytePlus Seedance 和 KIE Seedance 提交函数，补上和 OpenCreator 相同的 `resolveSeedanceMediaUrl()`。

这一段不新注册 Seedance 模型。对应提交函数还没搬过来时，先把 resolver 挂到上下文，等模型映射那段接上提交函数再用。

# 6. cos 和 s3 要在 normalize 时拷贝文件

做完要达到：`storageProvider` 是 `pass_through` 时，结果仍是厂商 URL。是 `cos` 或 `s3` 时，厂商临时 URL 在 normalize 返回前变成本方 CDN URL，对象里真有那份字节。artifact worker 不再上传第二次。

## 现在

`createArtifactUploader()` 在 `cos` 和 `s3` 分支返回 `RemoteArtifactUploader`。它不下载，也不 `putObject`，只拼出一个 `{base}/artifacts/{时间}-{文件名}`。这个地址上没有文件。

`packages/core` 的 provider normalize 没有调用 `uploadRemoteUrl()`。worker 已经把 `PassThroughArtifactStore` 交给 artifact 处理器，这一段不要改成在 worker 里上传。

OpenCreator 的 `CosArtifactUploader` 和 `S3ArtifactUploader` 会下载远端字节再写入对象存储，返回真实 CDN URL。各 provider 的 normalize 调用 `context.uploader.uploadRemoteUrl()`。`apps/worker/src/main.ts` 把 `createArtifactUploader(config)` 交给 provider 处理器，把 `PassThroughArtifactStore` 交给 artifact 处理器。

## 改哪些文件

1. `novelcomic-ai/packages/storage/src/index.ts`：删掉只拼路径的 `RemoteArtifactUploader`。`cos` 和 `s3` 对照 OpenCreator 的 `cos-uploader.ts`、`s3-uploader.ts`、`artifact-uploader-utils.ts`。缺密钥、桶或 CDN 域名时仍要启动失败。
2. `novelcomic-ai/apps/worker/src/index.ts`：provider 处理器接收 `createArtifactUploader()` 的结果。artifact 处理器继续用 `PassThroughArtifactStore`。
3. NovelComic 里已经有、并且 OpenCreator 对应 normalize 调用了 `uploadRemoteUrl()` 的 provider，补上同样的调用。没有对应 provider 的，不要为了转存新注册模型。

`pass_through` 继续原样返回厂商 URL。

# 7. 分割扣当前用户的积分，结果进 CloudFront

做完要达到：积分不够时返回 402，阿里云不会被调用。成功时返回新的 CloudFront URL。原图还在。扣费记在 `image_segmentation`。盖章要等扫描结束才换成这张新图。

## 现在

`ImageSegmentationService` 用配置项 `image_segmentation_credit_balance` 做门槛。没配这个值就直接调用阿里云。`_charge_credits_if_configured()` 不写积分。

结果用 COS `put_object`，返回 COS CDN。OpenCreator 用服务端 S3 下载并上传，再换成 CloudFront URL。

阿里云调用已经放在线程里。这一段保持这样，不要改回阻塞事件循环。

`preview-motion-path-canvas.tsx` 在分割响应一到就改 `displayThumbnailUrl` 和 `subjectThumbnailUrl`。OpenCreator 先等盖章扫描结束，再把 `resultUrl` 贴成透明前景。

## 改哪些文件

1. `novelcomic-publisher/app/services/image_segmentation.py`：调用阿里云前用现有 `UnifiedCreditsService` 看当前用户余额。不够抛 402。转存成功后再扣，金额是这一次的积分，`source` 是 `image_segmentation`，幂等键用阿里云 request id。
2. 结果转存对照 OpenCreator `_persist_aliyun_result()`：`images/segmentation/{nanoid24}.png` 进 S3，返回 CloudFront URL。不要再写 COS。
3. `preview-motion-path-canvas.tsx` 的 `handleCutoutStamp()`：结果先挂起，扫描结束再替换前景。失败仍回到 `idle`，两条文案保持现在的区分。

分割结果不覆盖原图，不写节点结果，也不进个人素材库。

# 验收

按这个顺序看。前一条没过，先不要改后面的文件。

1. 选一张图能拿到 `https://{CDN}/{object_key}`。Publisher 进程没有这张图的字节。PUT 403、临近过期、网络错误或超时后会换签或重试。取消会结束，不会挂住。
2. `POST /api/v1/cos/upload_base64` 返回 CDN URL。用户选择的原始文件仍走 v2 预签名。
3. 别人的域名不能进个人库。同一 URL 再创建一次，记录数仍是 1。
4. `source_kind = uploaded` 只出上传库。生成结果只出 `success`，过期项进 `hidden_count`，`retention_days` 随订阅等级变化。
5. `library/sink` 不能归档失败结果，也不能归档不属于这条结果的 URL。
6. 图片和视频节点能看到合规盾。没点之前只有 status 查询。点一次之后，同一 URL 再点返回已有状态，`is_new` 是 false。
7. 非 COS CDN 前缀的地址不会进检测。`pending` / `processing` 约每 3 秒更新。换成另一张 flow 后，上一张 flow 的盾牌状态不残留。
8. 视频时长超出 1.8 秒到 15.2 秒时，记录是 `failed`，并带这段公开原因。AI enqueue 不是 `enqueued` 时，这条记录不能停在 `processing`。
9. GetAsset 变成 `active` 后盾牌是已验证，轮询停止。worker 的写操作里没有 `ai_task`。
10. `active` 的 BytePlus 媒体在 Seedance 提交时变成 `asset://{asset_id}`。还没 `active` 的这次提交失败。没有记录的 URL 保持原样。
11. `pass_through` 保留厂商 URL。`cos` 或 `s3` 的转存发生在 normalize 返回前，对象里有文件。artifact worker 之后任务进入 `callback_pending`，不再上传。
12. 分割积分不足返回 402。成功时返回新的 CloudFront `result_url`，原图仍可访问。节点结果和个人素材库都没有多出这条分割记录。
