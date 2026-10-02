import { useSyncExternalStore } from 'react'

/**
 * The latest value of something, for a component in another React root.
 *
 * The phone field's Canvas is a separate renderer whose element stays the
 * same between renders, so that Fiber does not reconfigure (and resize) the
 * scene on every change of the field's props; the scene reads them from here.
 */
export interface Relay<T> {
  get: () => T
  set: (value: T) => void
  subscribe: (listener: () => void) => () => void
}

export function createRelay<T>(initial: T): Relay<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: next => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export function useRelay<T>(relay: Relay<T>): T {
  return useSyncExternalStore(relay.subscribe, relay.get, relay.get)
}

export interface FrameSetter<T> {
  /** Hands `value` on at the next frame, in place of any given before it. */
  set: (value: T) => void
  cancel: () => void
}

/**
 * Sets `relay` once a frame at most, on the frame after it was asked to, with
 * the latest value asked for. A tap re-renders the scoring screen (about
 * 20 ms on a phone) and the scene the relay feeds (about 25 ms); in one task
 * together they made a frame of 60–80 ms after every pitch. Apart, each goes
 * in a frame of its own.
 */
export function frameSetter<T>(
  relay: Relay<T>,
  frame: (run: () => void) => unknown = run => requestAnimationFrame(run),
  cancelFrame: (handle: unknown) => void = handle => {
    cancelAnimationFrame(handle as number)
  }
): FrameSetter<T> {
  let latest: { value: T } | null = null
  let handle: unknown = null
  return {
    set: value => {
      latest = { value }
      handle ??= frame(() => {
        handle = null
        if (latest == null) return
        const { value } = latest
        latest = null
        relay.set(value)
      })
    },
    cancel: () => {
      if (handle != null) cancelFrame(handle)
      handle = null
      latest = null
    }
  }
}
