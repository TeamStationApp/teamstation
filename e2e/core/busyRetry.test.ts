import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../src/common/errors'
import { isPasswordBusy, retryWhileBusy } from './busyRetry'

const busy = (): HttpError =>
  new HttpError(
    'unavailable',
    'Password verification is busy. Please try again'
  )

/** A clock that moves only when the retry sleeps. */
function clock(): {
  sleeps: number[]
  sleep: (ms: number) => Promise<void>
  now: () => number
} {
  let at = 1000
  const sleeps: number[] = []
  return {
    sleeps,
    sleep: async ms => {
      sleeps.push(ms)
      at += ms
    },
    now: () => at
  }
}

describe('retryWhileBusy', function () {
  it('knows the busy answer and nothing else', function () {
    expect(isPasswordBusy(busy())).equals(true)
    expect(
      isPasswordBusy(new HttpError('unavailable', 'Down for upgrade'))
    ).equals(false)
    expect(
      isPasswordBusy(
        new HttpError('unauthorized', 'Password verification is busy')
      )
    ).equals(false)
    expect(isPasswordBusy(new TypeError('x'))).equals(false)
    expect(isPasswordBusy(undefined)).equals(false)
  })

  it('tries again with growing, jittered waits until the sign-in gets in', async function () {
    const c = clock()
    let tries = 0
    const token = await retryWhileBusy(
      'signing coach in',
      async () => {
        tries++
        if (tries < 4) throw busy()
        return 'token-1'
      },
      { sleep: c.sleep, now: c.now, random: () => 0.5 }
    )
    expect(token).equals('token-1')
    expect(tries).equals(4)
    // Ceilings 250, 500, 1000: half of each plus half of the other half.
    expect(c.sleeps).deep.equals([188, 375, 750])
  })

  it('keeps each wait between half its ceiling and its ceiling, capped', async function () {
    const low = clock()
    const high = clock()
    for (const [c, random] of [
      [low, () => 0],
      [high, () => 0.999]
    ] as const) {
      let tries = 0
      await retryWhileBusy(
        'x',
        async () => {
          if (++tries < 8) throw busy()
          return 1
        },
        { sleep: c.sleep, now: c.now, random }
      )
    }
    expect(low.sleeps).deep.equals([125, 250, 500, 1000, 2000, 2000, 2000])
    expect(high.sleeps).deep.equals([250, 500, 1000, 1999, 3998, 3998, 3998])
  })

  it('fails clearly once the stack stays busy past the budget', async function () {
    const c = clock()
    let tries = 0
    const failure = await retryWhileBusy(
      'signing coach@example.test in',
      async () => {
        tries++
        throw busy()
      },
      { sleep: c.sleep, now: c.now, random: () => 0.5, budgetMs: 10_000 }
    ).then(
      () => null,
      (error: unknown) => error as Error
    )
    expect(failure?.message).equals(
      "signing coach@example.test in: the stack's password verification stayed busy for 9 s (7 tries)"
    )
    expect((failure as Error & { cause?: unknown }).cause).instanceOf(HttpError)
    expect(c.sleeps.reduce((a, b) => a + b, 0)).lessThanOrEqual(10_000)
    expect(tries).equals(7)
  })

  it('throws any other failure at once, untouched', async function () {
    const c = clock()
    const wrong = new HttpError(
      'unauthorized',
      'Wrong e-mail address or password'
    )
    let tries = 0
    const failure = await retryWhileBusy(
      'x',
      async () => {
        tries++
        throw wrong
      },
      { sleep: c.sleep, now: c.now }
    ).then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).equals(wrong)
    expect(tries).equals(1)
    expect(c.sleeps).deep.equals([])
  })

  it('waits on the real timer by default', async function () {
    let tries = 0
    const answer = await retryWhileBusy(
      'x',
      async () => {
        if (++tries < 2) throw busy()
        return 'in'
      },
      { baseDelayMs: 2 }
    )
    expect(answer).equals('in')
  })
})
