import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('the DOM test animation clock', () => {
  it('cancels a frame with the matching host before it can reschedule itself', async () => {
    let calls = 0
    let handle = 0
    const frame = (): void => {
      calls += 1
      handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    cancelAnimationFrame(handle)
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(calls).equals(0)
    } finally {
      cancelAnimationFrame(handle)
    }
  })

  it('uses the same performance clock as animations for a delivered frame', async () => {
    const before = performance.now()
    const timestamp = await new Promise<number>(resolve => {
      requestAnimationFrame(resolve)
    })
    expect(timestamp).at.least(before)
    expect(timestamp).at.most(performance.now())
  })
})
