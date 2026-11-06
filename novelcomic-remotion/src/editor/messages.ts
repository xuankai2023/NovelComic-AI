import { DEFAULT_COMPOSITION_HEIGHT, DEFAULT_COMPOSITION_WIDTH, DEFAULT_FPS } from './constants'
import { defaultInitialState } from './state/initial-state'
import type { AssetType, EditorStarterAsset, EditorStarterItem, TrackType, UndoableState } from './state/types'

export type AssembleAsssetItem = {
  type: AssetType
  resultId?: string
  nodeId?: string
  value: string
  preview?: string
  duration?: number
}

export type RemotionInitData = {
  project_name?: string
  assets?: AssembleAsssetItem[]
  assemblePayload?: string
}

export type ParentToEditorMessage = {
  source?: string
  type?: 'init_data'
  data?: RemotionInitData
}

export type EditorToParentMessage =
  | { source: 'remotion-editor'; type: 'payload_change'; payload: string }
  | { source: 'remotion-editor'; type: 'close_window' }
  | { source: 'remotion-editor'; type: 'posthug'; posthug: { event: string; source: string } }

const DEFAULT_ASSET_DURATION_SECONDS = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isUndoableState(value: unknown): value is UndoableState {
  if (!isRecord(value)) return false
  return (
    Array.isArray(value.tracks) &&
    isRecord(value.assets) &&
    isRecord(value.items) &&
    typeof value.fps === 'number' &&
    typeof value.compositionWidth === 'number' &&
    typeof value.compositionHeight === 'number'
  )
}

export function parseAssemblePayload(payload?: string): UndoableState | null {
  if (!payload?.trim()) return null
  const parsed = JSON.parse(payload) as unknown
  if (!isUndoableState(parsed)) {
    throw new Error('assemblePayload is not a valid Remotion editor state')
  }
  return parsed
}

function createAssetId(item: AssembleAsssetItem, index: number) {
  return `asset-${item.nodeId || 'source'}-${item.resultId || index}`
}

function createItemId(assetId: string) {
  return `item-${assetId}`
}

function buildAsset(item: AssembleAsssetItem, assetId: string): EditorStarterAsset {
  return {
    id: assetId,
    type: item.type,
    remoteUrl: item.type === 'text' ? null : item.value,
    previewUrl: item.preview,
    text: item.type === 'text' ? item.value : undefined,
    duration: item.duration,
  }
}

function buildItem(asset: EditorStarterAsset, index: number, fps: number): EditorStarterItem {
  const durationInSeconds = asset.duration && asset.duration > 0 ? asset.duration : DEFAULT_ASSET_DURATION_SECONDS
  return {
    id: createItemId(asset.id),
    type: asset.type,
    assetId: asset.id,
    from: Math.round(index * DEFAULT_ASSET_DURATION_SECONDS * fps),
    durationInFrames: Math.max(1, Math.round(durationInSeconds * fps)),
    x: 0,
    y: 0,
    width: DEFAULT_COMPOSITION_WIDTH,
    height: DEFAULT_COMPOSITION_HEIGHT,
    text: asset.text,
  }
}

export function buildUndoableStateFromAssets(assets: AssembleAsssetItem[] = []): UndoableState {
  const editorAssets: Record<string, EditorStarterAsset> = {}
  const items: Record<string, EditorStarterItem> = {}
  const track: TrackType = {
    id: 'track-main',
    hidden: false,
    muted: false,
    items: [],
  }

  assets.forEach((assetItem, index) => {
    if (!assetItem.value) return
    const assetId = createAssetId(assetItem, index)
    const asset = buildAsset(assetItem, assetId)
    const item = buildItem(asset, track.items.length, DEFAULT_FPS)
    editorAssets[assetId] = asset
    items[item.id] = item
    track.items.push(item.id)
  })

  return {
    ...structuredClone(defaultInitialState),
    assets: editorAssets,
    items,
    tracks: track.items.length > 0 ? [track] : [],
  }
}

export function createUndoableStateFromInitData(data: RemotionInitData): UndoableState {
  const parsedPayload = parseAssemblePayload(data.assemblePayload)
  if (parsedPayload) return parsedPayload
  return buildUndoableStateFromAssets(data.assets ?? [])
}

export function serializeUndoableState(state: UndoableState): string {
  return JSON.stringify(state)
}

export function createPayloadChangeMessage(state: UndoableState): EditorToParentMessage {
  return {
    source: 'remotion-editor',
    type: 'payload_change',
    payload: serializeUndoableState(state),
  }
}

export function createCloseWindowMessage(): EditorToParentMessage {
  return {
    source: 'remotion-editor',
    type: 'close_window',
  }
}

export function getFrontendTargetOrigin(): string {
  const env = typeof process === 'undefined' ? undefined : process.env
  return env?.NEXT_PUBLIC_IFRAME_ORIGIN || env?.NEXT_PUBLIC_FRONTEND_ORIGIN || '*'
}
