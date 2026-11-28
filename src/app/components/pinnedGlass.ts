import { useSyncExternalStore } from 'react'

/**
 * Which pinned pill bands (and sticky sections) carry the header's glass
 * right now, so the band and the header draw as one pane: while one does,
 * the shell's header draws no material and no lower line of its own, and
 * the band's pane draws both.
 *
 * A band reports here once its pane has started to grow, and only while its
 * scene is the stack's top (`useSceneTop`). Both platforms report: the
 * browser from its paint, the phone from the animation thread's reaction.
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

/** Whether `key`'s band carries the glass, or with no key, whether any does. */
export function usePinned(key?: object): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (key == null ? pinned.size > 0 : pinned.has(key)),
    () => false
  )
}

const ignore = (): (() => void) => () => undefined

/**
 * Whether any band carries the header's glass, for the shell's header only:
 * with `watch` false it neither subscribes nor reads, and answers false, so
 * a header of an overlay keeps its own glass over whatever is pinned.
 */
export function useGlassCarried(watch: boolean): boolean {
  return useSyncExternalStore(
    watch ? subscribe : ignore,
    () => watch && pinned.size > 0,
    () => false
  )
}
