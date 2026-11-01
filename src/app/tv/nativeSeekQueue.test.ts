import { expect } from 'chai'
import { describe, it } from 'mocha'

import { NativeSeekQueue } from './nativeSeekQueue'

describe('TV native seek backpressure', () => {
  it('acknowledges native no-ops even when playback moved beyond the last JS sample', () => {
    const sent: number[] = []
    let nativePosition = 10.25 // JS last saw 10; native has advanced.
    let settled = 0
    const queue = new NativeSeekQueue(
      target => {
        sent.push(target)
        // The patched native operation acknowledges both real and no-op seeks.
        nativePosition = target
        queue.complete(target)
      },
      () => {
        settled++
      }
    )
    queue.request(10.25)
    queue.request(20.25)
    queue.request(10.25)
    expect(sent).deep.equals([10.25, 20.25, 10.25])
    expect(nativePosition).equals(10.25)
    expect(settled).equals(3)
  })
  it('coalesces requests and rejects stale acknowledgements including fractional targets', () => {
    const sent: number[] = []
    let settled = 0
    const queue = new NativeSeekQueue(
      n => sent.push(n),
      () => {
        settled++
      }
    )
    queue.request(10)
    for (let n = 20; n <= 100; n += 10) queue.request(n)
    expect(sent).deep.equals([10])
    queue.complete(9)
    expect(settled).equals(0)
    queue.complete(10)
    expect(sent).deep.equals([10, 100])
    queue.complete(10)
    queue.complete(100)
    queue.complete(100)
    expect(settled).equals(1)
    queue.request(8192.02002)
    queue.complete(8192.021484375)
    queue.request(8192.02002)
    queue.complete(8192.02002)
    queue.request(8182)
    queue.complete(8182)
    expect(settled).equals(4)
    expect(sent).deep.equals([10, 100, 8192.02002, 8192.02002, 8182])
  })
})
