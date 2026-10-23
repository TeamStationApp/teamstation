import { expect } from 'chai'
import { describe, it } from 'mocha'
import { AppState, type AppStateStatus } from 'react-native'

import { isForeground, observeLifecycle } from './lifecycle'
import {
  isForeground as isNativeForeground,
  observeLifecycle as observeNativeLifecycle
} from './lifecycle.native'

describe('Analytics lifecycle platform boundaries', () => {
  it('observes browser visibility and page departure until disposal', () => {
    const original = Object.getOwnPropertyDescriptor(document, 'hidden')
    const changes: boolean[] = []
    let departures = 0
    const stop = observeLifecycle(
      value => changes.push(value),
      () => departures++
    )
    const stopDefault = observeLifecycle(() => {})
    try {
      for (const hidden of [true, false]) {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: hidden
        })
        expect(isForeground()).equals(!hidden)
        document.dispatchEvent(new window.Event('visibilitychange'))
      }
      window.dispatchEvent(new window.Event('pagehide'))
      expect(changes).deep.equals([false, true])
      expect(departures).equals(1)
      stop()
      stopDefault()
      document.dispatchEvent(new window.Event('visibilitychange'))
      window.dispatchEvent(new window.Event('pagehide'))
      expect(changes).length(2)
      expect(departures).equals(1)
    } finally {
      stop()
      stopDefault()
      if (original != null) Object.defineProperty(document, 'hidden', original)
      else Reflect.deleteProperty(document, 'hidden')
    }
  })

  it('uses native app state, treats inactive as background and removes its listener', () => {
    // Save the property for restoration; it is never called unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AppState.addEventListener
    const state = Object.getOwnPropertyDescriptor(AppState, 'currentState')
    let listener: ((state: AppStateStatus) => void) | undefined
    let removed = false
    const changes: boolean[] = []
    AppState.addEventListener = ((kind: string, callback: typeof listener) => {
      expect(kind).equals('change')
      listener = callback
      return {
        remove: () => {
          removed = true
          listener = undefined
        }
      }
    }) as typeof AppState.addEventListener
    try {
      const stop = observeNativeLifecycle(value => changes.push(value))
      for (const value of ['active', 'inactive', 'background'] as const) {
        Object.defineProperty(AppState, 'currentState', {
          configurable: true,
          value
        })
        expect(isNativeForeground()).equals(value === 'active')
        listener!(value)
      }
      expect(changes).deep.equals([true, false, false])
      stop()
      expect(removed).equals(true)
      expect(listener).equals(undefined)
    } finally {
      AppState.addEventListener = original
      if (state != null) Object.defineProperty(AppState, 'currentState', state)
      else Reflect.deleteProperty(AppState, 'currentState')
    }
  })
})
