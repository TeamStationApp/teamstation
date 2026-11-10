import { expect } from 'chai'
import { describe, it } from 'mocha'

import { NativeSeekQueue } from './nativeSeekQueue'

describe('TV native seek backpressure', () => {
  it('keeps a buffering seek alive while transfers arrive and bounds silence', () => {
    let now = 0
    const queue = new NativeSeekQueue(
      () => undefined,
      () => undefined,
      () => now
    )
    expect(queue.pending).equals(false)
    queue.buffer(true)
    queue.transferProgress()
    queue.request(50)
    expect(queue.pending).equals(true)
    now = 90_000
    expect(queue.timedOut()).equals(false)
    queue.transferProgress()
    now = 150_000
    expect(queue.timedOut()).equals(false)
    queue.buffer(true) // Repeated state reports are not evidence of a transfer.
    now = 210_000
    expect(queue.timedOut()).equals(true)
    expect(queue.pending).equals(false)
    queue.transferProgress()
    queue.complete(50)
    expect(queue.pending).equals(false)
  })

  it('gives a ready decoder a fresh acknowledgement window and honors explicit failure', () => {
    let now = 0
    const queue = new NativeSeekQueue(
      () => undefined,
      () => undefined,
      () => now
    )
    queue.request(50)
    queue.buffer(true)
    now = 90_000
    queue.buffer(false)
    expect(queue.timedOut()).equals(false)
    now += 4999
    expect(queue.timedOut()).equals(false)
    queue.transferProgress()
    now++
    expect(queue.timedOut()).equals(true)
    queue.request(70)
    queue.fail()
    expect(queue.pending).equals(false)
    expect(queue.timedOut()).equals(false)
  })
  it('does not settle a failed paused seek when its completion arrives late', () => {
    let now = 0
    let settled = 0
    const queue = new NativeSeekQueue(
      () => undefined,
      () => {
        settled++
      },
      () => now
    )
    queue.request(50)
    now = 5001
    expect(queue.timedOut()).equals(true)
    now = 5500
    queue.complete(50)
    expect(settled).equals(0)
  })
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
  it('reports a lost completion once and keeps late completions quarantined until replacement', () => {
    let now = 0
    const queue = new NativeSeekQueue(
      () => undefined,
      () => undefined,
      () => now
    )
    expect(queue.timedOut()).equals(false)
    queue.request(10)
    now = 4999
    expect(queue.timedOut()).equals(false)
    queue.request(20)
    now = 5000
    expect(queue.timedOut()).equals(true)
    expect(queue.timedOut()).equals(false)
    queue.complete(10)
    expect(queue.timedOut()).equals(false)
    now = 10000
    expect(queue.timedOut()).equals(false)
    queue.complete(20)
    expect(queue.timedOut()).equals(false)
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
