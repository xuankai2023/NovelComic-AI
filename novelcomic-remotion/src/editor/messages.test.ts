import { describe, expect, it } from 'vitest'
import {
  buildUndoableStateFromAssets,
  createCloseWindowMessage,
  createPayloadChangeMessage,
  createUndoableStateFromInitData,
} from './messages'

describe('remotion editor messages', () => {
  it('builds timeline state from init_data assets', () => {
    const state = buildUndoableStateFromAssets([
      { type: 'image', value: 'https://cdn.test/image.png', nodeId: 'image-1' },
      { type: 'video', value: 'https://cdn.test/video.mp4', preview: 'https://cdn.test/poster.jpg', resultId: 'r1' },
    ])

    expect(Object.keys(state.assets)).toHaveLength(2)
    expect(Object.keys(state.items)).toHaveLength(2)
    expect(state.tracks[0].items).toHaveLength(2)
    expect(state.fps).toBe(30)
    expect(state.compositionWidth).toBe(736)
    expect(state.compositionHeight).toBe(414)
  })

  it('prefers assemblePayload when it contains saved timeline state', () => {
    const saved = buildUndoableStateFromAssets([{ type: 'audio', value: 'https://cdn.test/audio.mp3' }])
    const restored = createUndoableStateFromInitData({
      assets: [{ type: 'image', value: 'https://cdn.test/image.png' }],
      assemblePayload: JSON.stringify(saved),
    })

    expect(restored).toEqual(saved)
  })

  it('creates parent messages with remotion-editor source', () => {
    const state = buildUndoableStateFromAssets([{ type: 'text', value: 'hello' }])
    expect(createPayloadChangeMessage(state)).toMatchObject({
      source: 'remotion-editor',
      type: 'payload_change',
    })
    expect(createCloseWindowMessage()).toEqual({
      source: 'remotion-editor',
      type: 'close_window',
    })
  })
})
