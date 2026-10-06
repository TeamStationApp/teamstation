import { expect } from 'chai'
import { describe, it } from 'mocha'

import { calibratePasswordCosts } from './passwordCalibration'
import { DEFAULT_PASSWORD_COSTS } from './passwordProtocol'

const proof = 'ab'.repeat(32)
describe('device password calibration', () => {
  it('scales the measured baseline linearly, rounds upward and keeps the floor and ceiling', async () => {
    for (const [duration, iterations] of [
      [4000, 6],
      [3000, 6],
      [1500, 12],
      [1000, 18],
      [1100, 17],
      [1, 1024]
    ]) {
      let clock = 0
      const result = await calibratePasswordCosts(
        async (_input, p) => {
          expect(p.memoryKiB).equals(32768)
          expect(p.iterations).equals(6)
          expect(p.parallelism).equals(4)
          return proof
        },
        undefined,
        undefined,
        () => (clock++ === 0 ? 100 : 100 + duration)
      )
      expect(result).deep.equals({
        baselineMs: duration,
        costs: { ...DEFAULT_PASSWORD_COSTS, iterations }
      })
    }
  })
  it('preserves a stronger configured baseline and supports a tunable target', async () => {
    const baseline = { memoryKiB: 65536, iterations: 12, parallelism: 4 }
    let time = 0
    expect(
      (
        await calibratePasswordCosts(
          async () => proof,
          baseline,
          1000,
          () => time++ * 2000
        )
      ).costs
    ).deep.equals(baseline)
    time = 0
    expect(
      (
        await calibratePasswordCosts(
          async () => proof,
          baseline,
          6000,
          () => time++ * 2000
        )
      ).costs.iterations
    ).equals(36)
  })
  it('rejects weak configuration, invalid clocks/targets and KDF failures without returning costs', async () => {
    const fails = async (operation: () => Promise<unknown>): Promise<void> => {
      let error: unknown
      try {
        await operation()
      } catch (e) {
        error = e
      }
      expect(error).instanceOf(Error)
    }
    for (const patch of [
      { memoryKiB: 19456 },
      { iterations: 5 },
      { parallelism: 1 },
      { iterations: 1025 }
    ])
      await fails(
        async () =>
          await calibratePasswordCosts(
            async () => {
              throw new Error('must not derive')
            },
            { ...DEFAULT_PASSWORD_COSTS, ...patch }
          )
      )
    for (const target of [0, -1, NaN, Infinity])
      await fails(
        async () =>
          await calibratePasswordCosts(async () => proof, undefined, target)
      )
    for (const duration of [0, -1, NaN, Infinity]) {
      let i = 0
      await fails(
        async () =>
          await calibratePasswordCosts(
            async () => proof,
            undefined,
            undefined,
            () => (i++ === 0 ? 0 : duration)
          )
      )
    }
    await fails(
      async () =>
        await calibratePasswordCosts(async () => {
          throw new Error('KDF unavailable')
        })
    )
    await fails(async () => await calibratePasswordCosts(async () => 'invalid'))
  })
})
