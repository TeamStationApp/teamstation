import { expect } from 'chai'
import { describe, it } from 'mocha'

import { NativeSeekQueue } from './nativeSeekQueue'

describe('TV native seek backpressure', () => {
  it('does not strand repeated fractional targets after native Float/CMTime rounding', () => {
    const sent: number[] = []
    let settled = 0
    const queue = new NativeSeekQueue(
      n => sent.push(n),
      () => {
        settled++
      }
    )
    queue.request(8192.02002)
    queue.complete(8192.02002, 8192.021484375)
    queue.request(8192.02002)
    expect(sent).deep.equals([8192.02002])
    expect(settled).equals(2)
    queue.request(8182)
    expect(sent).deep.equals([8192.02002, 8182])
    queue.complete(8182, 8182)
    expect(settled).equals(3)
  })
  it('coalesces slow native seeks and ignores stale completions until the latest target settles', () => {
    const sent: number[] = []
    let settled = 0
    const queue = new NativeSeekQueue(
      n => sent.push(n),
      () => {
        settled++
      }
    )
    queue.request(0)
    expect(settled).equals(1)
    queue.request(10)
    for (let n = 20; n <= 100; n += 10) queue.request(n)
    queue.progress(2)
    expect(sent).deep.equals([10])
    queue.complete(9, 9)
    expect(settled).equals(1)
    queue.complete(10, 10)
    expect(sent).deep.equals([10, 100])
    queue.complete(10, 10)
    expect(settled).equals(1)
    queue.complete(100, 100)
    expect(settled).equals(2)
    queue.complete(100, 100)
    expect(settled).equals(2)
    queue.progress(10) // queued progress from the previous seek must not reset position
    queue.request(100)
    expect(sent).deep.equals([10, 100])
    expect(settled).equals(3)
    queue.progress(101)
    queue.request(101)
    expect(settled).equals(4)
    expect(sent).deep.equals([10, 100])
    queue.request(90)
    queue.request(80)
    queue.request(70)
    queue.complete(90, 90)
    expect(sent).deep.equals([10, 100, 90, 70])
    queue.complete(70, 70)
    expect(settled).equals(5)
  })
})
