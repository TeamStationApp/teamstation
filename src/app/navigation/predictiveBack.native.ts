import { useEffect, useRef } from 'react'
import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

import type { PredictiveBackHandlers } from './predictiveBackTypes'

interface PredictiveBackModule {
  setEnabled: (enabled: boolean) => void
  addListener: (eventName: string) => void
  removeListeners: (count: number) => void
}

interface PredictiveBackEvent {
  type: 'started' | 'progress' | 'cancelled' | 'invoked'
  progress?: number
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
  useEffect(() => {
    module?.setEnabled(enabled)
  }, [module, enabled])
  useEffect(() => {
    if (module == null) return
    const subscription = new NativeEventEmitter<{
      TSPredictiveBack: [PredictiveBackEvent]
    }>(module).addListener('TSPredictiveBack', (event: PredictiveBackEvent) => {
      const on = latest.current
      if (event.type === 'started') on.onStart()
      else if (event.type === 'progress') on.onProgress(event.progress ?? 0)
      else if (event.type === 'cancelled') on.onCancel()
      else on.onInvoke()
    })
    return () => {
      subscription.remove()
      module.setEnabled(false)
    }
  }, [module])
}
