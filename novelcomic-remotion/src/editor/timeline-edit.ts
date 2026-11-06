import type { UndoableState } from './state/types'

export function deleteTimelineItem(state: UndoableState, itemId: string): UndoableState {
  const items = { ...state.items }
  delete items[itemId]
  return {
    ...state,
    items,
    tracks: state.tracks
      .map((track) => ({ ...track, items: track.items.filter((id) => id !== itemId) }))
      .filter((track) => track.items.length > 0),
  }
}
