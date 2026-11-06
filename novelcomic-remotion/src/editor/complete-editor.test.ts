import { describe, expect, it } from 'vitest'
import { editorExportFileName, resolveDoneOutputFile, renderOutputObjectKey } from './rendering/output-file'
import { readUndoableStateFromUrl, resolveEditorBootstrap } from './state/bootstrap'
import { deleteTimelineItem } from './timeline-edit'
import { buildUndoableStateFromAssets } from './messages'

const timeline = buildUndoableStateFromAssets([
  { type: 'image', value: 'https://cdn.test/a.png' },
  { type: 'video', value: 'https://cdn.test/b.mp4' },
])

describe('complete remotion editor helpers', () => {
  it('restores locale switch before url and local storage, and skips both when save is disabled', () => {
    const locale = { ...timeline, fps: 24 }
    const url = { ...timeline, fps: 12 }
    expect(resolveEditorBootstrap({
      saveButtonEnabled: true,
      localeSwitch: locale,
      urlState: url,
      storedState: timeline,
    })).toEqual(locale)
    expect(resolveEditorBootstrap({
      saveButtonEnabled: false,
      localeSwitch: null,
      urlState: url,
      storedState: timeline,
    })).toBeNull()
    expect(resolveEditorBootstrap({
      saveButtonEnabled: false,
      localeSwitch: locale,
      urlState: url,
      storedState: timeline,
    })).toEqual(locale)
  })

  it('reads a url hash state without decoding an already decoded payload twice', () => {
    const payload = {
      fps: 30,
      compositionWidth: 736,
      compositionHeight: 414,
      tracks: [],
      items: {},
      assets: { hero: { remoteUrl: 'https://cdn.test/a%20b.png' } },
      deletedAssets: [],
    }
    const href = `http://localhost:5174/#state=${encodeURIComponent(JSON.stringify(payload))}`

    expect(readUndoableStateFromUrl(href)).toEqual(payload)
  })

  it('names exported mp4 files with a timestamp', () => {
    expect(editorExportFileName(new Date(2026, 8, 28, 12, 7, 8))).toBe('cut_video_20260928120708.mp4')
  })

  it('deletes a timeline item from its track', () => {
    const itemId = timeline.tracks[0]?.items[0] || ''
    const next = deleteTimelineItem(timeline, itemId)
    expect(next.items[itemId]).toBeUndefined()
    expect(next.tracks[0]?.items).not.toContain(itemId)
  })

  it('copies a finished render to renders/{renderId} and falls back to the lambda url', async () => {
    expect(renderOutputObjectKey('render-1', 'cut_video_20260928120000.mp4')).toBe(
      'renders/render-1/cut_video_20260928120000.mp4',
    )
    await expect(resolveDoneOutputFile({
      sourceUrl: 'https://lambda.test/out.mp4',
      renderId: 'render-1',
      outputName: 'cut_video_20260928120000.mp4',
      copy: async (_source, key) => `https://cdn.test/${key}`,
    })).resolves.toBe('https://cdn.test/renders/render-1/cut_video_20260928120000.mp4')
    await expect(resolveDoneOutputFile({
      sourceUrl: 'https://lambda.test/out.mp4',
      renderId: 'render-1',
      outputName: 'cut_video_20260928120000.mp4',
      copy: async () => {
        throw new Error('COS is not configured')
      },
    })).resolves.toBe('https://lambda.test/out.mp4')
  })
})
