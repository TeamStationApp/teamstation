import { useSyncExternalStore } from 'react'

/**
 * Which pill bands are pinned under the header right now, so a glass band
 * and the header can draw as one pane: the band takes the header's glass,
 * and the header drops the line along its lower edge while one is pinned.
 *
 * Work in progress, and the browser's only: the phone's head runs on the
 * animation thread and never reports here.
 */
const pinned = new Set<object>()
const listeners = new Set<() => void>()

export function markPinned(key: object, on: boolean): void {
  if (pinned.has(key) === on) return
  if (on) pinned.add(key)
  else pinned.delete(key)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether `key`'s band is pinned, or with no key, whether any band is. */
export function usePinned(key?: object): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (key == null ? pinned.size > 0 : pinned.has(key)),
    () => false
  )
}
