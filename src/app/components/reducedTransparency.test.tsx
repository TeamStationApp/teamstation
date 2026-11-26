import { expect } from 'chai'
import { AccessibilityInfo, Platform } from 'react-native'

import { watchReducedTransparency } from './reducedTransparency'
import { watchReducedTransparency as watchNative } from './reducedTransparency.native'

describe('navigation transparency preferences', () => {
  it('reads the browser preference and releases its change listener', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    let listener: (() => void) | undefined
    const query = {
      matches: true,
      addEventListener: (event: string, fn: () => void) => {
        expect(event).equals('change')
        listener = fn
      },
      removeEventListener: (event: string, fn: () => void) => {
        expect(event).equals('change')
        expect(fn).equals(listener)
        listener = undefined
      }
    }
    try {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: undefined
      })
      const results: boolean[] = []
      watchReducedTransparency(value => results.push(value))()
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (name: string) => {
          expect(name).equals('(prefers-reduced-transparency: reduce)')
          return query
        }
      })
      const stop = watchReducedTransparency(value => results.push(value))
      query.matches = false
      listener!()
      stop()
      expect(listener).equals(undefined)
      expect(results).deep.equals([false, true, false])
    } finally {
      if (original != null)
        Object.defineProperty(window, 'matchMedia', original)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  for (const os of ['android', 'ios'] as const) {
    it(
      'keeps the latest ' + os + ' setting when its initial read resolves late',
      async () => {
        const descriptors = Object.getOwnPropertyDescriptors(AccessibilityInfo)
        const platform = Object.getOwnPropertyDescriptor(Platform, 'OS')!
        const method =
          os === 'android'
            ? 'isHighTextContrastEnabled'
            : 'isReduceTransparencyEnabled'
        const eventName =
          os === 'android'
            ? 'highTextContrastChanged'
            : 'reduceTransparencyChanged'
        let accept: ((value: boolean) => void) | undefined
        let publish: ((value: boolean) => void) | undefined
        let removed = 0
        try {
          Object.defineProperty(Platform, 'OS', {
            configurable: true,
            value: os
          })
          Object.assign(AccessibilityInfo, {
            [method]: async (): Promise<boolean> =>
              await new Promise<boolean>(resolve => {
                accept = resolve
              }),
            addEventListener: (
              event: string,
              listener: (value: boolean) => void
            ) => {
              expect(event).equals(eventName)
              publish = listener
              return {
                remove: () => {
                  removed++
                }
              }
            }
          })
          const values: boolean[] = []
          const stop = watchNative(value => values.push(value))
          publish!(true)
          accept!(false)
          await new Promise<void>(resolve => setImmediate(resolve))
          stop()
          publish!(false)
          expect(removed).equals(1)
          expect(values).deep.equals([true])

          const fromRead = watchNative(value => values.push(value))
          accept!(false)
          await new Promise<void>(resolve => setImmediate(resolve))
          fromRead()
          expect(values).deep.equals([true, false])
        } finally {
          Object.defineProperty(Platform, 'OS', platform)
          for (const key of [method, 'addEventListener'] as const) {
            const descriptor = descriptors[key]
            if (descriptor != null)
              Object.defineProperty(AccessibilityInfo, key, descriptor)
            else Reflect.deleteProperty(AccessibilityInfo, key)
          }
        }
      }
    )
  }
})
