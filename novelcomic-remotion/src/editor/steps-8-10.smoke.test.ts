import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { speculateFunctionName } from '@remotion/lambda/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST as postProgress } from '../../app/api/progress/route'
import { POST as postRender } from '../../app/api/render/route'
import { COMP_NAME, DISK_SIZE_IN_MB, MEM_SIZE_IN_MB, SITE_NAME, TIMEOUT_IN_SECONDS } from '../remotion/constants'
import { DEFAULT_COMPOSITION_HEIGHT, DEFAULT_COMPOSITION_WIDTH, DEFAULT_FPS } from './constants'
import {
  buildUndoableStateFromAssets,
  createCloseWindowMessage,
  createPayloadChangeMessage,
  createUndoableStateFromInitData,
  getFrontendTargetOrigin,
} from './messages'
import { PROGRESS_POLL_INTERVAL_MS } from './rendering/render-state'
import { renderSettings } from './rendering/lambda-render'
import { validateRenderPayload } from './rendering/validate-render-payload'
import { getInitialState } from './state/initial-state'
import { loadState, REMOTION_EDITOR_STORAGE_KEY, saveState } from './state/persistance'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const remotionOrigin = 'http://localhost:5174'
const frontendOrigin = 'http://localhost:3000'

const sampleAssets = [
  { type: 'image' as const, nodeId: 'image-1', value: 'https://cdn.test/input.png', preview: 'https://cdn.test/input.png' },
  {
    type: 'video' as const,
    nodeId: 'video-1',
    resultId: 'result-1',
    value: 'https://cdn.test/scene.mp4',
    preview: 'https://cdn.test/poster.jpg',
    duration: 4,
  },
  { type: 'audio' as const, nodeId: 'audio-1', value: 'https://cdn.test/voice.mp3', duration: 3 },
]

function renderBody(overrides: Record<string, unknown> = {}) {
  const state = buildUndoableStateFromAssets(sampleAssets)
  return {
    compositionHeight: state.compositionHeight,
    compositionWidth: state.compositionWidth,
    fps: state.fps,
    tracks: state.tracks,
    assets: state.assets,
    items: state.items,
    codec: 'h264',
    ...overrides,
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

describe('steps 8-10 smoke', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('restores an editor project from init_data and posts timeline changes back as assemblePayload', () => {
    const initial = getInitialState()
    expect(initial.undoableState).toMatchObject({
      fps: DEFAULT_FPS,
      compositionWidth: DEFAULT_COMPOSITION_WIDTH,
      compositionHeight: DEFAULT_COMPOSITION_HEIGHT,
      tracks: [],
      items: {},
      assets: {},
    })

    const fromAssets = createUndoableStateFromInitData({
      project_name: '第一集',
      assets: sampleAssets,
      assemblePayload: '',
    })
    expect(fromAssets.fps).toBe(30)
    expect(fromAssets.compositionWidth).toBe(736)
    expect(fromAssets.compositionHeight).toBe(414)
    expect(Object.values(fromAssets.assets).map((asset) => asset.remoteUrl ?? asset.text)).toEqual([
      'https://cdn.test/input.png',
      'https://cdn.test/scene.mp4',
      'https://cdn.test/voice.mp3',
    ])
    expect(fromAssets.tracks[0]?.items).toHaveLength(3)

    const payloadChange = createPayloadChangeMessage(fromAssets)
    expect(payloadChange).toMatchObject({ source: 'remotion-editor', type: 'payload_change' })
    if (payloadChange.type !== 'payload_change') throw new Error('expected payload_change')

    const restored = createUndoableStateFromInitData({
      assets: [],
      assemblePayload: payloadChange.payload,
    })
    expect(restored).toEqual(fromAssets)
    expect(createCloseWindowMessage()).toEqual({ source: 'remotion-editor', type: 'close_window' })
    expect(getFrontendTargetOrigin()).toBeTruthy()
  })

  it('saves editor state under remotion-editor-starter-state-v3 and rejects a disabled save flag', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const state = buildUndoableStateFromAssets(sampleAssets)

    saveState(state, {})
    expect(storage.getItem(REMOTION_EDITOR_STORAGE_KEY)).toContain('"fps":30')
    expect(loadState()).toEqual(state)
    expect(() => saveState(state, { asset: 'uploading' })).toThrow('uploaded to the cloud')
    expect(() => saveState(state, { asset: 'error' })).toThrow('Some assets have errors')

    vi.resetModules()
    vi.doMock('./flags', () => ({ FEATURE_SAVE_BUTTON: false }))
    const disabled = await import('./state/persistance')
    expect(() => disabled.loadState()).toThrow('Save button feature flag is disabled')
    expect(() => disabled.saveState(state, {})).toThrow('Save button feature flag is disabled')
    vi.doUnmock('./flags')
  })

  it('keeps lambda export settings aligned and rejects an unsafe render payload', async () => {
    expect({ COMP_NAME, SITE_NAME, TIMEOUT_IN_SECONDS, MEM_SIZE_IN_MB, DISK_SIZE_IN_MB }).toEqual({
      COMP_NAME: 'Main',
      SITE_NAME: 'remotion-editor-starter',
      TIMEOUT_IN_SECONDS: 240,
      MEM_SIZE_IN_MB: 3009,
      DISK_SIZE_IN_MB: 10240,
    })
    expect(renderSettings).toMatchObject({
      timeoutInSeconds: 240,
      memorySizeInMb: 3009,
      diskSizeInMb: 10240,
      codec: 'h264',
    })
    const functionName = speculateFunctionName({
      diskSizeInMb: DISK_SIZE_IN_MB,
      memorySizeInMb: MEM_SIZE_IN_MB,
      timeoutInSeconds: TIMEOUT_IN_SECONDS,
    })
    expect(functionName).toEqual(
      speculateFunctionName({
        diskSizeInMb: DISK_SIZE_IN_MB,
        memorySizeInMb: MEM_SIZE_IN_MB,
        timeoutInSeconds: TIMEOUT_IN_SECONDS,
      }),
    )

    const valid = validateRenderPayload(renderBody())
    expect(valid.codec).toBe('h264')
    expect(Object.keys(valid.items).length).toBeGreaterThan(0)

    const imageItem = Object.values(valid.items).find((item) => item.assetId)
    expect(imageItem).toBeTruthy()
    const brokenAssets = {
      ...valid.assets,
      [imageItem!.assetId!]: { ...valid.assets[imageItem!.assetId!], remoteUrl: '' },
    }
    expect(() => validateRenderPayload({ ...valid, assets: brokenAssets })).toThrow('remoteUrl')
    expect(() => validateRenderPayload({ ...valid, compositionWidth: 0 })).toThrow('compositionWidth')
    expect(() => validateRenderPayload({ ...valid, fps: 0 })).toThrow('fps')
    expect(() => validateRenderPayload({ ...valid, items: {} })).toThrow('at least one item')

    const nonH264 = await postRender(new Request('http://localhost/api/render', {
      method: 'POST',
      body: JSON.stringify(renderBody({ codec: 'vp9' })),
    }))
    expect(nonH264.status).toBe(400)
    await expect(nonH264.json()).resolves.toMatchObject({ type: 'error', error: 'codec must be "h264"' })

    const missingProgress = await postProgress(new Request('http://localhost/api/progress', {
      method: 'POST',
      body: JSON.stringify({ renderId: 'render-1' }),
    }))
    expect(missingProgress.status).toBe(400)
    await expect(missingProgress.json()).resolves.toMatchObject({ type: 'error', error: 'bucketName is not set' })
    expect(PROGRESS_POLL_INTERVAL_MS).toBe(2000)
  })

  it('keeps AutoEditor on /api/render2 and the iframe editor on /api/render', () => {
    const frontendRoot = resolve(repoRoot, 'novelcomic-frontend/src')
    const assembleApi = readFileSync(resolve(frontendRoot, 'api/modules/assemble.ts'), 'utf8')
    const renderHook = readFileSync(resolve(frontendRoot, 'hooks/useRemotionRender.ts'), 'utf8')
    const autoEditor = readFileSync(resolve(frontendRoot, 'components/remotion/AutoEditor/index.tsx'), 'utf8')
    const assembleNode = readFileSync(
      resolve(frontendRoot, 'features/canvas-workflow/components/custom_nodes/toolsNode/assembleNowNode.tsx'),
      'utf8',
    )
    const iframeEditor = readFileSync(resolve(frontendRoot, 'components/remotion/iframe_editor.tsx'), 'utf8')
    const lambdaRoute = readFileSync(resolve(repoRoot, 'novelcomic-remotion/app/api/render/route.ts'), 'utf8')
    const progressRoute = readFileSync(resolve(repoRoot, 'novelcomic-remotion/app/api/progress/route.ts'), 'utf8')

    expect(assembleApi).toContain("'/api/render2'")
    expect(assembleApi).toContain('type=VIDEO_RENDERING')
    expect(assembleApi).not.toContain('/api/progress')
    expect(renderHook).toContain('taskResponse.video.id')
    expect(renderHook).not.toContain('renderId')
    expect(autoEditor).toContain('useRemotionRender')
    expect(assembleNode).toContain('<AutoEditor')
    expect(assembleNode).toContain('setRemotionNodeId(id)')
    expect(iframeEditor).toContain("type: 'init_data'")
    expect(iframeEditor).toContain('assemblePayload')
    expect(iframeEditor).not.toContain('/api/render2')
    expect(lambdaRoute).toContain("codec: 'h264'")
    expect(lambdaRoute).not.toContain('/api/render2')
    expect(progressRoute).toContain('getLambdaProgress')
    expect(progressRoute).not.toContain('VIDEO_RENDERING')
  })

  it('serves the local editor and keeps the two render endpoints apart', async () => {
    const editorPage = await fetch(`${remotionOrigin}/`)
    expect(editorPage.status).toBe(200)
    const html = await editorPage.text()
    expect(html).toContain('NovelComic Remotion Editor')

    const frontendPage = await fetch(`${frontendOrigin}/`)
    expect(frontendPage.status).toBe(200)

    const rejectedRender = await fetch(`${remotionOrigin}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compositionWidth: 10 }),
    })
    expect(rejectedRender.status).toBe(400)
    await expect(rejectedRender.json()).resolves.toMatchObject({ type: 'error' })

    const rejectedProgress = await fetch(`${remotionOrigin}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(rejectedProgress.status).toBe(400)

    const render2OnEditor = await fetch(`${remotionOrigin}/api/render2`, { method: 'POST' })
    expect(render2OnEditor.status).toBe(404)
    const render2ProgressOnEditor = await fetch(`${remotionOrigin}/api/render2?id=video-1&type=VIDEO_RENDERING`)
    expect(render2ProgressOnEditor.status).toBe(404)
  })
})
