# 附录 C：Provider 与模型注册清单

## 口径

本清单以 `opencreator-ai/packages/core/src/models/index.ts` 的 `CORE_MODELS` 和
`opencreator-ai/packages/core/src/types.ts` 的 `CoreProvider` 为唯一注册口径。统计结果：

- 180 个当前注册 model id；
- 66 个 alias；
- 311 条按数组顺序执行的 `robin_calls`；
- 23 个 `CoreProvider`，当前全部至少被一条 robin call 使用；
- 178 条 `webhook` call，133 条 `polling` call。

`robin` 的箭头保持代码中的 fallback 顺序；同一 provider 重复出现也不会合并。这里的
result mode 是 provider call 的完成方式，不是模型能力分类：`webhook` 等厂商回调，
`polling` 由 worker 主动查询（同步拿到结果的调用也沿用该类型）。

## 23 个 Provider

- `fal`、`google`、`openai`、`anthropic`、`xai`
- `byteplus`、`volcengine`、`ideogram`、`minimax`、`runway`、`luma`
- `fish_audio`、`replicate`、`deer`、`kie`、`baidu`、`sufy`、`kling`
- `qnaigc`、`aliyun`、`tencent`、`youchuan`、`gemini_openai`

## 当前注册模型（按 CORE_MODELS 顺序）

没有“别名”字段的条目表示 `aliases` 未配置，而不是 model id 不可用。

- `opencreator/text-to-image/fast-sdxl`；robin=fal(webhook)
- `opencreator/image-to-image/fast-sdxl`；robin=fal(webhook)
- `opencreator/text-to-image/nano-banana`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/image-to-image/nano-banana`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/text-to-image/nano-banana-pro`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/image-to-image/nano-banana-pro`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/text-to-image/nano-banana-2`；别名=`opencreator/text-to-image/banana2-2026`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/image-to-image/nano-banana-2`；别名=`opencreator/image-to-image/banana2-2026`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/text-to-image/nano-banana-2-vip`；别名=`opencreator/text-to-image/banana2-2026-vip`；robin=baidu(polling) → fal(webhook)
- `opencreator/image-to-image/nano-banana-2-vip`；别名=`opencreator/image-to-image/banana2-2026-vip`；robin=baidu(polling) → fal(webhook)
- `opencreator/text-to-image/nano-banana-2-lite`；别名=`opencreator/text-to-image/banana2-lite-2026`；robin=google(polling)
- `opencreator/image-to-image/nano-banana-2-lite`；别名=`opencreator/image-to-image/banana2-lite-2026`；robin=google(polling)
- `opencreator/text-to-image/Google-imagen-4`；robin=google(polling) → fal(webhook)
- `opencreator/text-to-image/seedream-v3`；robin=fal(webhook)
- `opencreator/text-to-image/seedream-v4`；robin=fal(webhook)
- `opencreator/image-to-image/seedream-v4`；robin=fal(webhook)
- `opencreator/text-to-image/seedream-v4.5`；robin=fal(webhook)
- `opencreator/image-to-image/seedream-v4.5`；robin=fal(webhook)
- `opencreator/text-to-image/seedream-v5`；robin=fal(webhook)
- `opencreator/image-to-image/seedream-v5`；robin=fal(webhook)
- `opencreator/text-to-image/seedream-v5-pro`；robin=volcengine(polling) → fal(webhook)
- `opencreator/image-to-image/seedream-v5-pro`；robin=volcengine(polling) → fal(webhook)
- `opencreator/text-to-image/seedream-v5-lite`；robin=fal(webhook)
- `opencreator/image-to-image/seedream-v5-lite`；robin=fal(webhook)
- `opencreator/text-to-image/flux-2-pro`；robin=fal(webhook)
- `opencreator/image-to-image/flux-2-pro`；robin=fal(webhook)
- `opencreator/image-to-image/flux-pro-kontext`；robin=fal(webhook)
- `opencreator/text-to-image/flux-1.1-pro`；robin=fal(webhook)
- `opencreator/text-to-image/gpt-image-1.5`；robin=fal(webhook)
- `opencreator/image-to-image/gpt-image-1.5`；robin=fal(webhook)
- `opencreator/text-to-image/grok-imagine`；robin=fal(webhook)
- `opencreator/image-to-image/grok-imagine`；robin=fal(webhook)
- `opencreator/image-to-image/qwen-image-edit`；robin=fal(webhook)
- `opencreator/image-to-image/qwen-image-edit-multiple-angles`；别名=`opencreator/image-angle-control/qwen-image-edit-multiple-angles`、`fal-ai/qwen-image-edit-2511-multiple-angles`；robin=fal(webhook)
- `opencreator/image-to-image/gemini-v2-flash-edit`；robin=google(polling) → tencent(polling) → sufy(polling) → baidu(polling) → fal(webhook)
- `opencreator/text-to-image/gpt-image-1`；robin=openai(polling)
- `opencreator/image-to-image/gpt-image-1-edit`；robin=openai(polling)
- `opencreator/text-to-image/gpt-image-2`；robin=baidu(polling) → tencent(polling) → openai(polling) → fal(webhook) → kie(webhook)
- `opencreator/image-to-image/gpt-image-2-edit`；robin=baidu(polling) → tencent(polling) → openai(polling) → fal(webhook) → kie(webhook)
- `opencreator/text-to-image/ideogram-v3`；robin=ideogram(polling)
- `opencreator/text-to-image/minimax-hailuo-image-01`；robin=minimax(polling)
- `opencreator/text-to-image/midjourney-v8-1`；别名=`opencreator/text-to-image/midjourney-v8`；robin=youchuan(polling)
- `opencreator/image-to-image/midjourney-v8-1`；别名=`opencreator/image-to-image/midjourney-v8`；robin=youchuan(polling)
- `opencreator/text-to-image/midjourney-v8-2`；robin=youchuan(polling)
- `opencreator/image-to-image/midjourney-v8-2`；robin=youchuan(polling)
- `opencreator/text-to-video/minimax-h3`；robin=minimax(webhook)
- `opencreator/image-to-video/minimax-h3`；robin=minimax(webhook)
- `opencreator/reference-to-video/minimax-h3`；robin=minimax(webhook)
- `opencreator/image-to-video/runway-gen4-turbo`；robin=runway(polling)
- `opencreator/image-to-video/luma-ray-2`；robin=luma(polling)
- `opencreator/music/suno-chirp`；robin=deer(polling)
- `opencreator/music/suno-kie`；robin=kie(webhook)
- `opencreator/text-to-audio/fish-audio-speech-1.6`；robin=fish_audio(polling)
- `opencreator/text-to-audio/fish-audio-s2-1-pro`；robin=fish_audio(polling)
- `opencreator/image-upscale/topaz`；别名=`Replicate Topaz Image Upscale`、`topazlabs/image-upscale`；robin=replicate(polling)
- `opencreator/text-to-video/hailuo-02-std`；robin=fal(webhook)
- `opencreator/image-to-video/hailuo-02-std`；robin=fal(webhook)
- `opencreator/image-to-video/hailuo-2.3-pro`；robin=fal(webhook)
- `opencreator/text-to-video/veo-3`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/image-to-video/veo-3`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/text-to-video/veo-3-fast`；robin=google(polling) → fal(webhook)
- `opencreator/image-to-video/veo-3-fast`；robin=google(polling) → fal(webhook)
- `opencreator/text-to-video/veo-3.1`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/image-to-video/veo-3.1`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/text-to-video/veo-3.1-fast`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/image-to-video/veo-3.1-fast`；robin=google(polling) → baidu(webhook) → fal(webhook)
- `opencreator/text-to-video/veo-3.1-lite`；robin=baidu(webhook)
- `opencreator/image-to-video/veo-3.1-lite`；robin=baidu(webhook)
- `opencreator/text-to-video/wan-v2.6`；robin=fal(webhook)
- `opencreator/image-to-video/wan-v2.6`；robin=fal(webhook)
- `opencreator/image-to-video/wan-v2.2-a14b`；robin=fal(webhook)
- `opencreator/text-to-video/wan-2.5`；robin=fal(webhook)
- `opencreator/image-to-video/wan-2.5`；robin=fal(webhook)
- `opencreator/image-to-video/wan-v2.2-lora`；robin=fal(webhook)
- `opencreator/text-to-video/wan-v2.7`；robin=aliyun(polling)
- `opencreator/image-to-video/wan-v2.7`；robin=aliyun(polling)
- `opencreator/text-to-video/sora-2`；别名=`fal-ai/sora-2/text-to-video`；robin=fal(webhook)
- `opencreator/image-to-video/sora-2`；别名=`fal-ai/sora-2/image-to-video`；robin=fal(webhook)
- `opencreator/text-to-video/sora-2-pro`；别名=`fal-ai/sora-2/text-to-video/pro`；robin=fal(webhook)
- `opencreator/image-to-video/sora-2-pro`；别名=`fal-ai/sora-2/image-to-video/pro`；robin=fal(webhook)
- `opencreator/text-to-video/kling-v3-std`；别名=`fal-ai/kling-video/v3/standard/text-to-video`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-v3-std`；别名=`fal-ai/kling-video/v3/standard/image-to-video`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/text-to-video/kling-v3-pro`；别名=`fal-ai/kling-video/v3/pro/text-to-video`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-v3-pro`；别名=`fal-ai/kling-video/v3/pro/image-to-video`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/text-to-video/kling-3.0-turbo`；robin=qnaigc(polling)
- `opencreator/image-to-video/kling-3.0-turbo`；robin=qnaigc(polling)
- `opencreator/text-to-video/kling-o3-std`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-o3-std`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-o3-std-reference`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/text-to-video/kling-o3-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-o3-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/text-to-video/kling-v2.6-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/image-to-video/kling-v2.6-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/video-to-video/kling-o3-std-edit`；别名=`fal-ai/kling-video/o3/standard/video-to-video/edit`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/video-to-video/kling-o3-std-reference`；别名=`fal-ai/kling-video/o3/standard/video-to-video/reference`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/video-to-video/kling-o3-pro-edit`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/video-to-video/kling-o3-pro-reference`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-o3-pro-reference`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/image-to-video/kling-v2.5-turbo-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/image-to-video/kling-v2.1-std`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/image-to-video/kling-v2.1-pro`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/image-to-video/kling-v2.1-master`；robin=sufy(webhook) → fal(webhook)
- `opencreator/video-to-video/kling-o1-edit`；别名=`fal-ai/kling-video/o1/video-to-video/edit`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/video-to-video/kling-o1-reference`；别名=`fal-ai/kling-video/o1/video-to-video/reference`；robin=tencent(polling) → sufy(webhook) → fal(webhook)
- `opencreator/image-to-video/kling-v1.6-pro`；robin=tencent(polling) → fal(webhook)
- `opencreator/video-to-video/kling-video-extend`；robin=tencent(polling)
- `opencreator/aigc-element/kling`；robin=tencent(polling)
- `opencreator/image-to-video/veo-2`；robin=fal(webhook)
- `opencreator/text-to-video/vidu-q3`；robin=fal(webhook)
- `opencreator/image-to-video/vidu-q3`；robin=fal(webhook)
- `opencreator/text-to-video/grok-imagine-video`；robin=fal(webhook)
- `opencreator/image-to-video/grok-imagine-video`；robin=fal(webhook)
- `opencreator/image-to-video/seedance-v1-pro`；robin=fal(webhook)
- `opencreator/image-to-video/seedance-v1-lite`；robin=fal(webhook)
- `opencreator/text-to-video/seedance-v1-lite`；robin=fal(webhook)
- `opencreator/text-to-video/seedance-v1.5-pro`；robin=volcengine(polling) → fal(webhook)
- `opencreator/image-to-video/seedance-v1.5-pro`；robin=volcengine(polling) → fal(webhook)
- `opencreator/text-to-video/seedance-2.0`；别名=`doubao-seedance-2-0-260128`；robin=kie(webhook) → byteplus(polling) → fal(webhook)
- `opencreator/image-to-video/seedance-2.0`；别名=`doubao-seedance-2-0-260128/i2v`；robin=kie(webhook) → byteplus(polling) → fal(webhook)
- `opencreator/text-to-video/seedance-2.0-fast`；别名=`doubao-seedance-2-0-fast-260128`；robin=kie(webhook) → byteplus(polling) → fal(webhook)
- `opencreator/image-to-video/seedance-2.0-fast`；别名=`doubao-seedance-2-0-fast-260128/i2v`；robin=kie(webhook) → byteplus(polling) → fal(webhook)
- `opencreator/text-to-video/seedance-2.0-mini`；robin=kie(webhook)
- `opencreator/image-to-video/seedance-2.0-mini`；robin=kie(webhook)
- `opencreator/text-to-video/seedance-2.5`；别名=`dreamina-seedance-2-5-260628`；robin=kie(webhook) → fal(webhook)
- `opencreator/image-to-video/seedance-2.5`；别名=`dreamina-seedance-2-5-260628/i2v`；robin=kie(webhook) → fal(webhook)
- `opencreator/text-to-video/gemini-omni-flash`；别名=`opencreator/google/gemini-omni-flash/text2video`；robin=google(polling)
- `opencreator/image-to-video/gemini-omni-flash`；别名=`opencreator/google/gemini-omni-flash/image2video`；robin=google(polling)
- `opencreator/text-to-audio/elevenlabs-tts`；robin=fal(webhook)
- `opencreator/text-to-audio/minimax-speech-2.8-hd`；robin=fal(webhook)
- `opencreator/text-to-audio/minimax-speech-2.8-turbo`；robin=fal(webhook)
- `opencreator/text-to-audio/cassette-music`；robin=fal(webhook)
- `opencreator/voice-clone/minimax`；robin=fal(webhook)
- `opencreator/voice-clone/qwen3-tts`；robin=fal(webhook)
- `opencreator/motion-control/kling-v2.6-std`；别名=`fal-ai/kling-video/v2.6/standard/motion-control`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/motion-control/kling-v2.6-pro`；别名=`fal-ai/kling-video/v2.6/pro/motion-control`；robin=tencent(polling) → sufy(webhook) → fal(webhook) → kling(webhook)
- `opencreator/motion-control/kling-v3-std`；robin=tencent(polling)
- `opencreator/motion-control/kling-v3-pro`；robin=tencent(polling)
- `opencreator/image-audio-to-video/infinitalk`；别名=`fal-ai/infinitalk`；robin=fal(webhook)
- `opencreator/video-to-video/infinitalk`；别名=`fal-ai/infinitalk/video-to-video`；robin=fal(webhook)
- `opencreator/image-audio-to-video/kie-infinitalk`；别名=`kie/infinitalk/from-audio`；robin=kie(webhook)
- `opencreator/text-to-video/moonvalley-marey`；robin=fal(webhook)
- `opencreator/image-to-video/moonvalley-marey`；robin=fal(webhook)
- `opencreator/video-to-video/sync-lipsync-v2`；别名=`fal-ai/sync-lipsync/v2`；robin=fal(webhook)
- `opencreator/video-to-video/pixverse-lipsync`；别名=`fal-ai/pixverse/lipsync`；robin=fal(webhook)
- `opencreator/image-audio-to-video/omnihuman-v1.5`；别名=`fal-ai/bytedance/omnihuman/v1.5`；robin=fal(webhook)
- `opencreator/background-editor/remove-bg`；别名=`Fal Bria Background Remove`、`fal-ai/bria/background/remove`；robin=fal(webhook)
- `opencreator/background-editor/change-bg`；别名=`Fal ICLight V2`、`fal-ai/iclight-v2`；robin=fal(webhook)
- `opencreator/video-upscale/topaz`；别名=`fal-ai/topaz/upscale/video`；robin=fal(webhook)
- `opencreator/sync-video-audio/mmaudio-v2`；别名=`fal-ai/mmaudio-v2`；robin=fal(webhook)
- `opencreator/video-to-video/latentsync`；别名=`fal-ai/latentsync`；robin=fal(webhook)
- `opencreator/video-to-video/runway-gen4-aleph`；robin=runway(polling)
- `opencreator/openai/4o/text2text`；别名=`opencreator/text-to-text/gpt-4o`；robin=openai(polling)
- `opencreator/openai/4o-mini/text2text`；别名=`opencreator/text-to-text/gpt-4o-mini`；robin=openai(polling)
- `opencreator/openai/5/text2text`；别名=`opencreator/text-to-text/gpt-5`；robin=openai(polling)
- `opencreator/openai/5-4/text2text`；别名=`opencreator/text-to-text/gpt-5.4`；robin=openai(polling)
- `opencreator/openai/5-5/text2text`；别名=`opencreator/text-to-text/gpt-5.5`；robin=openai(polling)
- `opencreator/openai/5-2/text2text`；别名=`opencreator/text-to-text/gpt-5.2`；robin=openai(polling)
- `opencreator/openai/5-2-pro/text2text`；别名=`opencreator/text-to-text/gpt-5.2-pro`；robin=openai(polling)
- `opencreator/text-to-text/claude-3-7-sonnet`；robin=anthropic(polling)
- `opencreator/text-to-text/claude-3-5-haiku`；robin=anthropic(polling)
- `opencreator/gemini/2-0-flash/text2text`；别名=`opencreator/text-to-text/gemini-2.0-flash`；robin=google(polling)
- `opencreator/gemini/3-pro/text2text`；别名=`opencreator/text-to-text/gemini-3-pro`；robin=google(polling)
- `opencreator/gemini/3-flash/text2text`；别名=`opencreator/text-to-text/gemini-3-flash`；robin=google(polling)
- `opencreator/gemini/3-1-pro/text2text`；别名=`opencreator/text-to-text/gemini-3.1-pro`；robin=google(polling)
- `opencreator/gemini/3-1-flash-lite/text2text`；别名=`opencreator/text-to-text/gemini-3.1-flash-lite`；robin=google(polling)
- `opencreator/gemini/3-5-flash/text2text`；别名=`opencreator/text-to-text/gemini-3.5-flash`；robin=google(polling)
- `opencreator/gemini/3-8-flash/text2text`；别名=`opencreator/text-to-text/gemini-3.8-flash`；robin=gemini_openai(polling)
- `opencreator/deepseek/v4-pro/text2text`；别名=`opencreator/text-to-text/deepseek-v4-pro`；robin=aliyun(polling)
- `opencreator/deepseek/v4-flash/text2text`；别名=`opencreator/text-to-text/deepseek-v4-flash`；robin=aliyun(polling)
- `opencreator/text-to-text/grok-2`；robin=xai(polling)
- `opencreator/text-to-video/happy-horse-1-1`；别名=`opencreator/text-to-video/happy-horse`；robin=aliyun(polling)
- `opencreator/image-to-video/happy-horse-1-1`；别名=`opencreator/image-to-video/happy-horse`；robin=aliyun(polling)
- `opencreator/reference-to-video/happy-horse-1-1`；别名=`opencreator/reference-to-video/happy-horse`；robin=aliyun(polling)
- `opencreator/happyhorse/1-0/text2video`；robin=aliyun(polling)
- `opencreator/happyhorse/1-0/image2video`；robin=aliyun(polling)
- `opencreator/happyhorse/1-0/reference2video`；robin=aliyun(polling)
- `opencreator/happyhorse/1-1/text2video`；robin=aliyun(polling)
- `opencreator/happyhorse/1-1/image2video`；robin=aliyun(polling)
- `opencreator/happyhorse/1-1/reference2video`；robin=aliyun(polling)
- `opencreator/video-to-video/happy-horse-edit`；robin=aliyun(polling)

## 脚本存在但未注册

以下字符串出现在 `opencreator-ai/scripts/*.ts`，但既不是当前 `CORE_MODELS` 的 id，也不是
alias。它们只能说明有探测、联调或能力表脚本，不能当成线上已注册模型：

- 阿里云图像脚本：`opencreator/text-to-image/qwen-image-2.0-pro`、`qwen-image-3.0-pro`、
  `wan-2.2-t2i-flash`、`wan-2.2-t2i-plus`、`wan-2.5-t2i-preview`、`wan-2.6-t2i`、
  `wan-2.7-image`、`wan-2.7-image-pro`、`wanx-2.0-t2i-turbo`、
  `wanx-2.1-t2i-plus`、`wanx-2.1-t2i-turbo`、`wanx-v1`。
- 阿里云图像编辑脚本：`opencreator/image-to-image/qwen-image-2.0-pro`、
  `qwen-image-3.0-pro`、`wan-2.7-image`、`wan-2.7-image-pro`。
- 腾讯探测脚本：`opencreator/text-to-video/kling-o1-std`。
- Kling Image live 脚本按 `taskKind × imageCase` 动态组成六个未注册 id：
  `opencreator/text-to-image/kling-image-3.0`、
  `opencreator/image-to-image/kling-image-3.0`、
  `opencreator/text-to-image/kling-image-3.0-omni`、
  `opencreator/image-to-image/kling-image-3.0-omni`、
  `opencreator/text-to-image/kling-image-o1`、
  `opencreator/image-to-image/kling-image-o1`。脚本直接选择 provider call，不经过
  `requireCoreModel`，因此成功联调也不代表 registry 已开放。
- 能力表生成脚本中的规范化目标：`opencreator/wan/2-7/text2video`、
  `opencreator/wan/2-7/image2video`；当前实际注册 id 仍是
  `opencreator/text-to-video/wan-v2.7` 和 `opencreator/image-to-video/wan-v2.7`。

`youchuan-video.ts` 中的 Youchuan 文生/图生视频模型定义及 `index.ts` 对应 import/export
均被注释，因此也不属于当前注册表。`MidjourneyV8TextToImageModel` 与
`MidjourneyV8ImageToImageModel` 虽仍被导出，但没有进入 `CORE_MODELS`；当前 V8 入口由
V8.1 的 aliases 承接。
