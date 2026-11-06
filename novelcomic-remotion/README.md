# NovelComic Remotion 动态漫画制作服务

这是一个基于 Next.js + Remotion 的动态漫画合成工程。它保留了通用视频编辑器能力，同时新增了面向动态漫画的分镜、拆层、运动编排、口型/眨眼 sprite、批次渲染和交付清单能力。

本文档用于快速判断：这个项目目前能做哪些类似 AE 的动态漫画功能，哪些已经接进 API 和渲染链路，哪些还没有做完。更细的历史设计和 API 草稿可继续参考 `docs/` 目录。

## 项目定位

- 输入：漫画页、分镜图、拆层图片包、配音/字幕、已有 Remotion 工程 JSON。
- 处理：创建竖屏工程，管理 shot 分镜，导入 L0 原图和拆层，给镜头或图层写入 motion，生成字幕/音频，按时长切批渲染。
- 输出：Remotion 可渲染工程、预览帧、批次渲染任务、交付 manifest。
- 默认动态漫画规格：`1080x1920`、`30fps`。

## 技术栈

- Next.js 15 / React 19
- Remotion 4.0.443
- TypeScript
- Zod
- Vitest
- Tencent COS / Remotion Lambda / 本地 Remotion Renderer

## 快速启动

```bash
pnpm install
pnpm dev
```

默认端口：`3034`

常用命令：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm remotion:studio
pnpm remotion:deploy
```

## 动态漫画核心目录

| 目录/文件                                | 作用                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `src/editor/comic/`                      | 动态漫画领域逻辑：shot、拆层导入、motion 应用、批次规划、校验、交付 manifest |
| `src/editor/motion/`                     | 类 AE 动画数据结构、缓动、关键帧采样、预设展开、姿态求值                     |
| `app/api/compose/`                       | 自动化编排 API，包括创建工程、导入图层、写 motion、预览、批次渲染            |
| `src/remotion/`                          | Remotion Composition 入口，负责把工程 JSON 注入渲染上下文                    |
| `src/editor/items/image/image-layer.tsx` | 图片图层渲染时读取 motion、sprite 和 shot camera motion                      |
| `src/editor/rendering/`                  | 预览帧、本地渲染、Lambda 渲染、渲染参数校验                                  |

## 已实现的 AE 类能力

### 1. 图层时间线与基础剪辑

已做：

- 多轨道、多 item 的时间线模型。
- 支持 image、video、audio、text、captions、solid、gif。
- item 有 `from`、`durationInFrames`、尺寸、位置、不透明度、旋转、裁切、淡入淡出等基础属性。
- 轨道支持隐藏、静音。
- 支持复制粘贴、拖拽、裁切、扩展、rolling edit、时间线缩放、吸附、播放控制等编辑器基础交互。

未做或不完整：

- 没有 AE 式图层父子级/parenting。
- 没有 pre-compose / nested composition 的产品化能力。
- 没有 AE 式 mask、shape path、track matte、blend mode、3D layer、light/camera 3D 空间。

### 2. Shot 分镜系统

已做：

- `shots` 字段已接入工程 JSON。
- shot 包含 `id`、`name`、`from`、`durationInFrames`、`layerTrackIds`、`dialogueItemIds`、`transitionOut`、`cameraMotion`、`diagnostics`。
- 支持创建、编辑、删除 shot。
- 支持 shot 与图层/对白 item 的引用校验。
- 支持 shot 顺序、时间、交叉淡化范围校验。
- Remotion 渲染上下文已注入 `ShotsContext`。

对应文件：

- `src/editor/comic/upsert-shot.ts`
- `src/editor/comic/edit-shot.ts`
- `src/editor/comic/delete-shot.ts`
- `src/editor/comic/validate-project.ts`
- `src/remotion/main.tsx`

未做或不完整：

- UI 层没有完整的“分镜管理面板”。
- shot 过渡目前主要是数据和校验层能力，实际画面级高级转场库还没有成体系。

### 3. 关键帧动画

已做：

- 图片 item 支持 `motion.transform.keyframes`。
- 支持关键帧字段：`x`、`y`、`scaleX`、`scaleY`、`rotation`、`opacity`。
- 支持缓动：`linear`、`ease-in`、`ease-out`、`ease-in-out`。
- 支持循环：`none`、`repeat`、`ping-pong`。
- 支持 `anchorX`、`anchorY` 作为变换锚点。
- 支持 replace / append 两种写入模式。
- 渲染时会按当前帧采样关键帧，叠加到图片图层姿态上。

对应文件：

- `src/editor/motion/types.ts`
- `src/editor/motion/easing.ts`
- `src/editor/motion/evaluate.ts`
- `src/editor/comic/apply-motion.ts`
- `app/api/compose/item/motion/route.ts`

未做或不完整：

- 没有 AE 式曲线编辑器/Graph Editor。
- 没有逐属性时间轴 UI。
- 没有表达式系统。
- 没有空间路径编辑、贝塞尔运动路径、auto-orient。

### 4. 镜头运动/虚拟摄像机

已做：

- shot 支持 `cameraMotion`。
- 镜头关键帧支持 `x`、`y`、`scale`。
- 支持镜头 focal 点：`focalX`、`focalY`。
- 图层求值时会叠加当前 shot 的 camera motion。
- 支持前一个 crossfade shot 的过渡上下文。
- 已有镜头预设：`camera-push`、`camera-pull`、`pan-left`、`pan-right`。

对应文件：

- `src/editor/motion/evaluate.ts`
- `src/editor/motion/presets.ts`
- `src/editor/comic/apply-motion.ts`

未做或不完整：

- 不是 AE 的真实 3D Camera。
- 没有景深、透视、3D 层、灯光。
- 没有镜头路径可视化编辑器。

### 5. 动态漫画常用图层预设

已做：

- item motion 预设：
  - `breathing`：呼吸缩放。
  - `float`：上下漂浮。
  - `hair-sway`：头发/局部摆动。
- camera motion 预设：
  - `camera-push`
  - `camera-pull`
  - `pan-left`
  - `pan-right`
- 预设支持参数、seed、自动展开为关键帧。

对应文件：

- `src/editor/motion/presets.ts`
- `src/editor/comic/apply-motion.ts`

未做或不完整：

- 预设数量还比较少。
- 没有产品化预设面板。
- 没有预设缩略预览。

### 6. Sprite 状态动画：眨眼和口型

已做：

- 图片 item 支持 `motion.spriteStates`。
- 渲染时会根据当前帧切换 `assetId`，实现图片序列状态替换。
- 支持眨眼：
  - `openAssetId`
  - `closedAssetId`
  - `seed`
- 支持口型：
  - `closedAssetId`
  - `halfAssetId`
  - `openAssetId`
  - `dialogueItemIds`
- 拆层导入时会把 eye/mouth 语义图层合并为逻辑 sprite 组。

对应文件：

- `src/editor/comic/build-sprite-motion.ts`
- `src/editor/comic/apply-sprite-motion.ts`
- `src/editor/comic/import-layers.ts`
- `src/editor/motion/evaluate.ts`
- `src/editor/items/image/image-layer.tsx`

未做或不完整：

- 口型是基于 dialogue 时间段的规则状态，不是音素级自动口型识别。
- 没有 Live2D/骨骼绑定。
- 没有网格变形、局部 warping、puppet pin。

### 7. 拆层包导入

已做：

- 支持 `LayerPackage` 导入。
- 每个 layer 有语义、图片 URL、zIndex、bounds、anchor、confidence、motionPolicy。
- 支持语义：
  - `background`
  - `foreground`
  - `body`
  - `head`
  - `arm-left`
  - `arm-right`
  - `hair`
  - `eye-open`
  - `eye-closed`
  - `mouth-closed`
  - `mouth-half`
  - `mouth-open`
  - `effect`
  - `other`
- 导入时会创建 image asset、image item、track，并按 shot 重排轨道。
- 支持隐藏原 L0 面板轨道。
- 支持恢复 L0 原图。
- 支持导入 URL 白名单校验。

对应文件：

- `src/editor/comic/import-layers.ts`
- `app/api/compose/layers/import/route.ts`
- `app/api/compose/layers/restore-l0/route.ts`

未做或不完整：

- 项目本身不负责 AI 自动拆层。
- 不负责自动补全被遮挡区域。
- 不负责 PSD/AE 工程导入。
- `LayerPackage` 需要上游已经产出规范化图层图片和元数据。

### 8. 字幕、对白和配音

已做：

- 支持 captions item。
- 支持字幕生成接口，可走 ElevenLabs 或 OpenAI Whisper。
- 支持动态字幕样式：default、colored-words、scaling-words、animated-background。
- 支持向 shot 添加 dialogue captions。
- 支持向 dialogue 添加 voice audio。
- 支持音频素材探测和音频淡入淡出。

对应文件：

- `app/api/compose/subtitle/route.ts`
- `app/api/compose/dialogue/add/route.ts`
- `app/api/compose/dialogue/voice/route.ts`
- `src/editor/comic/add-dialogue.ts`
- `src/editor/comic/add-dialogue-voice.ts`

未做或不完整：

- 没有自动分配声线/角色声纹的完整系统。
- 口型与音频内容没有做真实 phoneme 对齐。

### 9. 预览帧和渲染

已做：

- 支持工程预览帧渲染。
- 支持完整视频渲染 API。
- 支持按 batch 渲染动态漫画片段。
- 支持本地 Remotion Renderer。
- 支持 Remotion Lambda。
- 本地渲染完成后会上传到 COS，并返回稳定 HTTPS CDN URL。
- 支持渲染进度查询。

对应文件：

- `app/api/compose/project/preview-frame/route.ts`
- `app/api/compose/project/render-batches/route.ts`
- `app/api/compose/project/merge-batches/route.ts`
- `app/api/render/route.ts`
- `app/api/progress/route.ts`
- `src/editor/rendering/render-preview-frame.ts`
- `src/editor/rendering/render-media-local.ts`
- `src/editor/rendering/submit-render.ts`

未做或不完整：

- 批次最终合并依赖服务端可用的 `ffmpeg` 和 COS 配置。
- 生产环境仍依赖 COS、AWS Lambda、Remotion site 等外部配置。

### 10. 批次规划和交付清单

已做：

- 支持按 5 到 18 秒的动态漫画交付区间规划 batch。
- 会保护 crossfade、对白字幕、必要音频，避免在不该断的地方切分。
- 支持尾段 re-balance。
- 支持 pad project。
- 支持 contact sheet 规划。
- 支持 delivery manifest，列出 source、layer、audio、subtitle、project、preview、final-video 等类别。
- 支持下载真实 ZIP 交付包，包内包含工程、manifest、文件索引和可下载文件。
- 支持 checksum 复核和从包内工程重新加载。
- 有分镜时，交付包按钮会自动渲染批次、合并完整 MP4，并同时保留批次视频。

对应文件：

- `src/editor/comic/plan-batches.ts`
- `src/editor/comic/pad-project.ts`
- `src/editor/comic/plan-contact-sheet.ts`
- `src/editor/comic/delivery-manifest.ts`
- `app/api/compose/project/plan-batches/route.ts`
- `app/api/compose/project/pad/route.ts`
- `app/api/compose/project/contact-sheet/route.ts`
- `app/api/compose/project/export-package/route.ts`

未做或不完整：

- 缺少文件会写入 manifest 并在界面中明确提示，不会静默伪装为完整交付。
- 最终 MP4 的合并仍需要 `ffmpeg` 可执行文件和可写入的 COS 配置。

## 已接入的动态漫画 API

| API                                        | 状态     | 作用                                          |
| ------------------------------------------ | -------- | --------------------------------------------- |
| `POST /api/compose/project/create`         | 已做     | 创建动态漫画工程，默认 1080x1920 / 30fps      |
| `POST /api/compose/shot/create`            | 已做     | 创建 shot                                     |
| `POST /api/compose/shot/edit`              | 已做     | 编辑 shot                                     |
| `POST /api/compose/shot/delete`            | 已做     | 删除 shot                                     |
| `POST /api/compose/image/sequence`         | 已做     | 追加图片序列/L0 面板                          |
| `POST /api/compose/layers/import`          | 已做     | 导入拆层包                                    |
| `POST /api/compose/layers/restore-l0`      | 已做     | 恢复 L0 原图轨道                              |
| `POST /api/compose/dialogue/add`           | 已做     | 添加对白字幕                                  |
| `POST /api/compose/dialogue/voice`         | 已做     | 添加对白音频                                  |
| `POST /api/compose/item/motion`            | 已做     | 给 item/shot 写入 motion 或 sprite motion     |
| `POST /api/compose/item/edit`              | 已做     | 编辑 item 几何、裁切、淡入淡出、motion 等字段 |
| `POST /api/compose/project/validate`       | 已做     | 校验动态漫画工程                              |
| `POST /api/compose/project/summary`        | 已做     | 输出工程摘要                                  |
| `POST /api/compose/project/preview-frame`  | 已做     | 渲染单帧预览                                  |
| `POST /api/compose/project/plan-batches`   | 已做     | 规划输出批次                                  |
| `POST /api/compose/project/render-batches` | 已做     | 提交批次渲染                                  |
| `POST /api/compose/project/merge-batches`  | 已做     | 合并已完成的批次为完整 MP4                    |
| `POST /api/compose/project/pad`            | 已做     | 补齐/延长工程                                 |
| `POST /api/compose/project/contact-sheet`  | 已做     | 规划 contact sheet                            |
| `POST /api/compose/project/export-package` | 已做     | 下载真实 ZIP 交付包并生成 manifest/checksum     |

## 和 AE 的差异

这个项目目前更像“面向动态漫画的 Remotion 自动合成器”，不是 AE 替代品。

已具备的 AE 类核心：

- 图层栈。
- 时间线 item。
- 关键帧动画。
- 缓动。
- 锚点。
- 循环动画。
- 2D 镜头推拉摇移。
- 预设动画。
- sprite 状态切换。
- 字幕和音频轨。
- 渲染输出。

没有做的 AE 能力：

- `.aep` 导入/导出。
- AE 表达式兼容。
- AE 插件兼容。
- Graph Editor。
- Shape Layer。
- Mask / Track Matte。
- Parenting。
- Null Object。
- 3D Layer / 3D Camera / Light。
- Puppet Pin / Mesh Warp。
- Roto / 抠像。
- PSD 分层导入。
- 时间重映射的完整产品能力。
- 可视化 motion 编辑面板的完整产品化。

## 当前完成度判断

可以认为已完成：

- 动态漫画工程 schema。
- shot 数据结构和生命周期。
- 拆层包导入。
- 2D transform motion 数据结构和渲染求值。
- camera motion 数据结构和渲染求值。
- 常用 motion preset。
- 眨眼/口型 sprite 状态动画。
- 工程校验。
- API 编排入口。
- 预览帧。
- 本地/Lambda 渲染提交。
- batch 规划。
- delivery manifest。
- 单元测试覆盖核心领域函数。

还需要继续做：

- 可视化 motion 面板和分镜面板。
- 更丰富的动画预设。
- 上游 AI 拆层、补图、角色一致性。
- 音频到口型的音素级对齐。
- PSD/AE/Live2D 等外部格式导入。
- 3D 图层、完整 Live2D runtime、AE 插件生成 `.aep` 等外部运行时能力。

## 推荐工作流

1. 调 `POST /api/compose/project/create` 创建工程。
2. 调 `POST /api/compose/image/sequence` 或 `POST /api/compose/shot/create` 放入 L0 漫画分镜。
3. 上游 AI 或人工产出 `LayerPackage`。
4. 调 `POST /api/compose/layers/import` 导入拆层。
5. 调 `POST /api/compose/dialogue/add` 添加对白字幕。
6. 调 `POST /api/compose/dialogue/voice` 添加配音。
7. 调 `POST /api/compose/item/motion` 添加镜头、图层、眨眼、口型动画。
8. 调 `POST /api/compose/project/validate` 校验工程。
9. 调 `POST /api/compose/project/preview-frame` 抽帧验收。
10. 调 `POST /api/compose/project/plan-batches` 规划批次。
11. 调 `POST /api/compose/project/render-batches` 渲染输出。
12. 轮询 `/api/progress`，等待每个批次得到视频 URL。
13. 调 `POST /api/compose/project/merge-batches` 合并完整 MP4。
14. 调 `POST /api/compose/project/export-package` 下载 ZIP 交付包。

### 可恢复的脚本生产流程

新的可恢复流程入口是：

```bash
pnpm comic:production \
  --production-id prod-001 \
  --source-url https://cdn.example.com/page.png \
  --analysis-file artifacts/page-analysis.json \
  --voice-file artifacts/voices.json \
  --motion-profile profiles/scene-001.json
```

每个阶段都可以独立执行，例如：

```bash
pnpm comic:analyze --production-id prod-001 --source-url https://cdn.example.com/page.png
pnpm comic:create-project --production-id prod-001
pnpm comic:create-shots --production-id prod-001
pnpm comic:prepare-layers --production-id prod-001 --allow-layer-fallback
pnpm comic:validate --production-id prod-001
```

阶段产物保存在 `artifacts/comic/<productionId>/`，包含 `state.json`、阶段报告和每一步的工程快照。中断后可以从最近成功阶段继续：

```bash
pnpm comic:production \
  --production-id prod-001 \
  --from prepare-layers \
  --source-url https://cdn.example.com/page.png
```

每个部位可以单独设置运动和强度，`--motion-profile` 文件格式示例：

```json
{
  "camera": {"preset": "camera-push", "intensity": "medium"},
  "parts": {
    "body": {"preset": "breathing", "intensity": "heavy"},
    "hair": {"preset": "hair-sway", "intensity": "light"},
    "eyes": {"preset": "blink", "intensity": "medium"},
    "mouth": {"preset": "mouth-flap", "intensity": "medium"}
  }
}
```

渲染和交付属于显式操作，避免开发时重复提交外部任务：

```bash
pnpm comic:production \
  --production-id prod-001 \
  --from plan-batches \
  --render \
  --render-status-url https://agent.example.com/render/status \
  --deliver \
  --verify
```

脚本只负责步骤编排、轮询、本地阶段产物和降级记录；`productionId` 的持久化、真正的 CAS、worker 租约和生产任务终态由上游 `novelcomic-agent` 负责。

## 环境变量

`.env.example` 中包含项目需要的基础配置。常见类别包括：

- Remotion Lambda / AWS 配置。
- COS 上传和 CDN 读取配置。
- OpenAI / ElevenLabs 字幕识别配置。
- 远程素材 URL 白名单配置。

生产渲染前需要确认外部服务都可用，否则预览、字幕识别、上传或 Lambda 渲染可能失败。

## 校验建议

```bash
pnpm test
pnpm typecheck
pnpm lint
```

人工校验请按功能逐步执行 [`docs/动态漫画PS人工校验步骤.md`](./docs/动态漫画PS人工校验步骤.md)。该清单只保留浏览器操作、画面观察、保存重载、时间线和最终结果核对。

PSD、AE 和 Live2D 的交换包格式及导入 API 见 [`docs/动态漫画外部导入交换包.md`](./docs/动态漫画外部导入交换包.md)。

重点建议手工校验：

- 导入拆层包后图层顺序是否正确。
- L0 恢复是否能回到原图状态。
- camera motion 是否和 item motion 叠加正确。
- sprite 眨眼/口型是否在正确帧切换 asset。
- crossfade 附近 batch 是否不会切断对白或必要音频。
- 本地渲染和 Lambda 渲染输出是否一致。
