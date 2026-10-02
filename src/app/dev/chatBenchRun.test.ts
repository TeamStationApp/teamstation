import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  BENCH_BYTES,
  BENCH_WRAPS,
  benchLines,
  type ChatBenchResult,
  runChatBench
} from './chatBenchRun'

describe('the chat crypto bench', () => {
  it('defaults to 20 MiB and 1,000 wraps', () => {
    expect(BENCH_BYTES).equals(20 * 1024 * 1024)
    expect(BENCH_WRAPS).equals(1000)
  })

  it('times a stream round trip and the wraps, on a fake clock', () => {
    let tick = 0
    // Every reading is 100 ms after the last: each timed span is 100 ms.
    const result = runChatBench({
      bytes: 1024 * 1024,
      wraps: 3,
      now: () => (tick += 100)
    })
    expect(result.bytes).equals(1024 * 1024)
    expect(result.wraps).equals(3)
    expect(result.sealMs).equals(100)
    expect(result.openMs).equals(100)
    expect(result.wrapMs).equals(100)
    expect(result.sealMBps).equals(10)
    expect(result.openMBps).equals(10)
    expect(result.streamMBps).equals(10)
    expect(result.wrapsPerSecond).equals(30)
  })

  it('runs on the real clock, and with no wraps at all', () => {
    const result = runChatBench({ bytes: 4096, wraps: 0 })
    expect(result.streamMBps).greaterThan(0)
    expect(result.wraps).equals(0)
  })

  it('writes the lines the screen shows, stream MB/s first', () => {
    const result: ChatBenchResult = {
      bytes: 20971520,
      wraps: 1000,
      sealMs: 500,
      openMs: 400,
      wrapMs: 2000,
      sealMBps: 40,
      openMBps: 50,
      streamMBps: 40,
      wrapsPerSecond: 500
    }
    expect(benchLines(result)).deep.equals([
      'stream MB/s: 40.0',
      'seal MB/s: 40.0 (500 ms)',
      'open MB/s: 50.0 (400 ms)',
      'wraps/s: 500.0 (1000 in 2000 ms)',
      'bytes: 20971520 (MB = 2^20 bytes)'
    ])
    expect(
      benchLines({ ...result, sealMBps: Infinity, wrapsPerSecond: Infinity })[1]
    ).equals('seal MB/s: ∞ (500 ms)')
  })

  it('counts a zero-length span as infinitely fast rather than dividing by zero', () => {
    const result = runChatBench({ bytes: 1000, wraps: 1, now: () => 5 })
    expect(result.streamMBps).equals(Infinity)
    expect(result.wrapsPerSecond).equals(Infinity)
  })
})
