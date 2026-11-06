import { FEATURE_SAVE_BUTTON } from '../flags'
import { loadState } from './persistance'
import type { UndoableState } from './types'

export const LOCALE_SWITCH_STORAGE_KEY = 'remotion-editor-locale-switch'

export function resolveEditorBootstrap(input: {
  saveButtonEnabled: boolean
  localeSwitch: UndoableState | null
  urlState: UndoableState | null
  storedState: UndoableState | null
}): UndoableState | null {
  if (!input.saveButtonEnabled && !input.localeSwitch) return null
  return input.localeSwitch ?? input.urlState ?? (input.saveButtonEnabled ? input.storedState : null)
}

export function readLocaleSwitchState(): UndoableState | null {
  if (typeof sessionStorage === 'undefined') return null
  const raw = sessionStorage.getItem(LOCALE_SWITCH_STORAGE_KEY)
  if (!raw) return null
  return JSON.parse(raw) as UndoableState
}

export function readUndoableStateFromUrl(href = typeof window === 'undefined' ? '' : window.location.href): UndoableState | null {
  const hash = href.split('#')[1] || ''
  if (!hash) return null
  const decoded = new URLSearchParams(hash).get('state')
  if (!decoded) return null
  return JSON.parse(decoded) as UndoableState
}

export function readBootstrapState(): UndoableState | null {
  let storedState: UndoableState | null = null
  if (FEATURE_SAVE_BUTTON) {
    try {
      storedState = loadState()
    } catch {
      storedState = null
    }
  }
  let localeSwitch: UndoableState | null = null
  let urlState: UndoableState | null = null
  try {
    localeSwitch = readLocaleSwitchState()
  } catch {
    localeSwitch = null
  }
  try {
    urlState = readUndoableStateFromUrl()
  } catch {
    urlState = null
  }
  return resolveEditorBootstrap({
    saveButtonEnabled: FEATURE_SAVE_BUTTON,
    localeSwitch,
    urlState,
    storedState,
  })
}
