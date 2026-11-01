import { useCallback, useSyncExternalStore } from 'react'

import { watchVisualViewport } from './chatWebInteractions'

interface VisualViewport {
  bottom: number
  keyboardOpen: boolean
}
let state: VisualViewport | undefined
let stop: (() => void) | undefined
const listeners = new Set<() => void>()
const snapshot = (): VisualViewport | undefined => state
const empty = (): undefined => undefined

/** The composer and navigation observe the same keyboard and viewport lifetime. */
export function useChatVisualViewport(
  enabled = true
): VisualViewport | undefined {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (!enabled) return () => {}
      listeners.add(listener)
      stop ??= watchVisualViewport(next => {
        state = next
        for (const changed of listeners) changed()
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop?.()
          stop = undefined
          state = undefined
        }
      }
    },
    [enabled]
  )
  return useSyncExternalStore(subscribe, enabled ? snapshot : empty, empty)
}
