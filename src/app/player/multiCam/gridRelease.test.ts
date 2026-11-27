import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { GridRelease } from './gridRelease'

describe('an iOS grid lift on a display frame shared with another finger', function () {
  const block = { x: 0, y: 0, w: 100, h: 100 }
  const frames = new Map<number, FrameRequestCallback>()
  let index = 0
  let originalRequest: typeof requestAnimationFrame
  let originalCancel: typeof cancelAnimationFrame
  let seen: boolean[]
  let release: GridRelease
  const draw = (): void => {
    const scheduled = [...frames.values()]
    frames.clear()
    scheduled.forEach(fn => {
      fn(0)
    })
  }
  beforeEach(function () {
    seen = []
    release = new GridRelease(value => seen.push(value))
    originalRequest = globalThis.requestAnimationFrame
    originalCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = fn => {
      frames.set(++index, fn)
      return index
    }
    globalThis.cancelAnimationFrame = id => {
      if (id != null) frames.delete(id)
    }
  })
  afterEach(function () {
    release.dispose()
    frames.clear()
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  })
  it('publishes a plain lift or a fresh side contact on the next frame', function () {
    release.begin()
    draw()
    release.contact(50, 50, block, null)
    release.lifted()
    release.begin()
    release.contact(87, 50, block, null)
    draw()
    expect(seen).deep.equals([true, false, true, false])
  })
  it('lets a same-frame center tap pause first and publishes the saved rate on the next frame', function () {
    release.begin()
    release.contact(50, 50, block, null)
    draw()
    expect(seen).deep.equals([true])
    release.lifted()
    draw()
    expect(seen).deep.equals([true, false])
  })
  it('bounds a second contact that lingers and cancels a dragged or abandoned release', async function () {
    release.begin()
    release.contact(50, 50, block, null)
    draw()
    await new Promise(resolve => setTimeout(resolve, 110))
    expect(seen).deep.equals([true, false])
    release.begin()
    const stale = [...frames.values()][0]
    release.finish()
    release.begin()
    stale(0)
    release.dispose()
    draw()
    expect(seen).deep.equals([true, false, true, false, true])
  })
})
