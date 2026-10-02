import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createRelay, frameSetter } from './fieldPropsRelay'

describe('the field props relay', function () {
  it('hands on the latest value and tells its listeners once per change', function () {
    const relay = createRelay({ n: 1 })
    let told = 0
    const stop = relay.subscribe(() => {
      told++
    })
    const next = { n: 2 }
    relay.set(next)
    relay.set(next)
    expect(relay.get()).equals(next)
    expect(told).equals(1)
    stop()
    relay.set({ n: 3 })
    expect(told).equals(1)
    expect(relay.get()).deep.equals({ n: 3 })
  })
})

describe('setting the relay once a frame', function () {
  it('hands on the latest value at the next frame, and nothing once cancelled', function () {
    const relay = createRelay({ n: 1 })
    const frames: Array<() => void> = []
    const setter = frameSetter(
      relay,
      run => frames.push(run),
      () => {
        frames.length = 0
      }
    )
    setter.set({ n: 2 })
    setter.set({ n: 3 })
    // One frame asked for, and nothing handed on before it.
    expect(frames).has.length(1)
    expect(relay.get()).deep.equals({ n: 1 })
    frames.shift()?.()
    expect(relay.get()).deep.equals({ n: 3 })
    setter.set({ n: 4 })
    expect(frames).has.length(1)
    setter.cancel()
    expect(frames).has.length(0)
    expect(relay.get()).deep.equals({ n: 3 })
    // A cancelled setter asks for a frame again.
    setter.set({ n: 5 })
    frames.shift()?.()
    expect(relay.get()).deep.equals({ n: 5 })
  })
})
