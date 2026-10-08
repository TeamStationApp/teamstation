import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { lightHaptic } from './lightHaptic'

const original = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
afterEach(() => {
  if (original == null) delete (navigator as Partial<Navigator>).vibrate
  else Object.defineProperty(navigator, 'vibrate', original)
})
describe('optional browser light feedback', function () {
  it('requests a short pulse where available even if the browser refuses it', function () {
    const calls: number[] = []
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (ms: number) => {
        calls.push(ms)
        return false
      }
    })
    lightHaptic()
    expect(calls).deep.equals([8])
  })
  it('ignores unavailable and throwing vibration APIs', function () {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: undefined
    })
    expect(() => {
      lightHaptic()
    }).not.throws()
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('Blocked')
      }
    })
    expect(() => {
      lightHaptic()
    }).not.throws()
  })
})
