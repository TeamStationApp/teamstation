import { useEffect, useRef } from 'react'
import {
  DeviceEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform
} from 'react-native'

import type { PredictiveBackHandlers } from './predictiveBackTypes'

interface PredictiveBackModule {
  setEnabled: (enabled: boolean) => void
  addListener: (eventName: string) => void
  removeListeners: (count: number) => void
}

interface PredictiveBackEvent {
  type: 'started' | 'progress' | 'cancelled' | 'invoked'
  progress?: number
  /**
   * `BackEventCompat.swipeEdge`: 0 the left edge, 1 the right, 2 none (a
   * preview from three-button navigation's Back).
   */
  swipeEdge?: number
}

/**
 * Android's back gesture, as the stack navigator's drag (see
 * `PredictiveBackModule.kt`). Android only: an iPhone has no system Back, and
 * its left edge is the app's own pan.
 *
 * `enabled` turns the native callback on and off. Off, Back goes where it
 * always did, through React Native's `BackHandler`.
 */
export function usePredictiveBack(handlers: PredictiveBackHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers
  const module =
    Platform.OS === 'android'
      ? (NativeModules.TSPredictiveBack as PredictiveBackModule | undefined)
      : undefined
  const { enabled } = handlers
  /** Turned off natively for a declined press, whatever JS says. */
  const declined = useRef(false)
  useEffect(() => {
    declined.current = false
    module?.setEnabled(enabled)
  }, [module, enabled])
  // A declined press turns the callback off with nothing in JS changing, so
  // it is put back as JS has it on the next render, which follows the move
  // `BackHandler` made of the press: never before it, or the callback would
  // take back a press `BackHandler` handed on to Android. A press
  // `BackHandler` swallows with nothing re-rendering (a route still being
  // delivered) leaves Back plain, with no drag, until the next render: safe,
  // and a timer instead could not know Android has had the press.
  useEffect(() => {
    if (!declined.current) return
    declined.current = false
    if (enabled) module?.setEnabled(true)
  })
  useEffect(() => {
    if (module == null) return
    const subscription = new NativeEventEmitter<{
      TSPredictiveBack: [PredictiveBackEvent]
    }>(module).addListener('TSPredictiveBack', (event: PredictiveBackEvent) => {
      const on = latest.current
      if (event.type === 'started') on.onStart()
      else if (event.type === 'progress')
        on.onProgress(
          event.progress ?? 0,
          event.swipeEdge === 0
            ? 'left'
            : event.swipeEdge === 1
              ? 'right'
              : 'none'
        )
      else if (event.type === 'cancelled') on.onCancel()
      // A press the navigator could not take, in the moment before the
      // callback turns off, goes on to `BackHandler` as a plain Back would.
      // The callback is turned off first: at the bottom of the history
      // `BackHandler` hands the press back to Android to leave the app, and
      // a callback still on would take it again, and again.
      else if (!on.onInvoke()) {
        module.setEnabled(false)
        declined.current = true
        DeviceEventEmitter.emit('hardwareBackPress', {})
      }
    })
    return () => {
      subscription.remove()
      module.setEnabled(false)
    }
  }, [module])
}
