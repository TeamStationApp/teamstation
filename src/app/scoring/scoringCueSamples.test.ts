import { expect } from 'chai'
import { describe, it } from 'mocha'

import { CUE_SECONDS, cueSamples, int16Of } from './scoringCueSamples'

/**
 * The cues as the browser synthesized them before they moved here, measured
 * from that code: each cue's length, its peak, and a weighted sum of every
 * sample, so a changed sample anywhere changes it.
 */
const BEFORE: Record<
  string,
  { length: number; peak: number; checksum: number }
> = {
  'swish@44100': { length: 9702, peak: 0.504022, checksum: -65.011 },
  'pop@44100': { length: 4851, peak: 0.837544, checksum: 151.9301 },
  'bat@44100': { length: 2646, peak: 0.753289, checksum: 44.2729 },
  'swish@48000': { length: 10560, peak: 0.504348, checksum: -45.1059 },
  'pop@48000': { length: 5280, peak: 0.846862, checksum: 163.1125 },
  'bat@48000': { length: 2880, peak: 0.756181, checksum: 44.5226 }
}

describe('field cue samples', function () {
  it('are the cues the browser played before, sample for sample', function () {
    for (const rate of [44100, 48000])
      for (const kind of ['swish', 'pop', 'bat'] as const) {
        const data = cueSamples(kind, rate)
        let peak = 0
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          peak = Math.max(peak, Math.abs(data[i]))
          sum += data[i] * ((i % 7) + 1)
        }
        expect(
          {
            length: data.length,
            peak: Number(peak.toFixed(6)),
            checksum: Number(sum.toFixed(4))
          },
          `${kind}@${rate}`
        ).deep.equals(BEFORE[`${kind}@${rate}`])
        expect(data.length).equals(Math.ceil(rate * CUE_SECONDS[kind]))
      }
  })

  it('are the same every time', function () {
    expect([...cueSamples('pop', 22050)]).deep.equals([
      ...cueSamples('pop', 22050)
    ])
  })

  it('convert to 16-bit samples, clipped to range', function () {
    expect(int16Of(new Float32Array([0, 1, -1, 0.5, 2, -3]))).deep.equals([
      0, 32767, -32767, 16384, 32767, -32767
    ])
  })
})
