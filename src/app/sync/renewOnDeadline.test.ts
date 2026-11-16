import { expect } from 'chai'
import { describe, it } from 'mocha'

import { REQUEST_DEADLINE_MS } from '../../common/api'
import { renewOnDeadline } from './renewOnDeadline'

/** Lets the throttle's promises settle. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('a new connection when a request misses its deadline', function () {
  it('asks for one at most once a request deadline after it renewed', async function () {
    let now = 1_000_000
    let asked = 0
    const missed = renewOnDeadline(
      () => {
        asked++
        return true
      },
      () => now
    )
    missed()
    await settled()
    expect(asked).equals(1)
    // The other requests on the stalled link miss theirs too.
    now += REQUEST_DEADLINE_MS - 1
    missed()
    await settled()
    expect(asked).equals(1)
    now += 1
    missed()
    await settled()
    expect(asked).equals(2)
  })

  it('asks again at the next miss when it found the link slow and did not renew', async function () {
    const now = 0
    const answers = [false, true]
    let asked = 0
    const missed = renewOnDeadline(
      async () => answers[asked++] ?? true,
      () => now
    )
    missed()
    await settled()
    // Declined: the link stalls outright now, and the next miss asks again.
    missed()
    await settled()
    expect(asked).equals(2)
    missed()
    await settled()
    expect(asked).equals(2)
  })

  it('asks nothing more while a renewal is still deciding', async function () {
    let decide!: (renewed: boolean) => void
    let asked = 0
    const missed = renewOnDeadline(
      async () => {
        asked++
        return await new Promise<boolean>(resolve => {
          decide = resolve
        })
      },
      () => 0
    )
    missed()
    missed()
    await settled()
    expect(asked).equals(1)
    decide(false)
    await settled()
    missed()
    await settled()
    expect(asked).equals(2)
  })

  it('passes over a renew that throws, and asks again at the next miss', async function () {
    let asked = 0
    const missed = renewOnDeadline(
      () => {
        asked++
        throw new Error('no native module')
      },
      () => 0
    )
    expect(() => {
      missed()
    }).not.throws()
    await settled()
    missed()
    await settled()
    expect(asked).equals(2)
  })

  it('passes over a renew that fails, and asks again at the next miss', async function () {
    let asked = 0
    const missed = renewOnDeadline(
      async () => {
        asked++
        throw new Error('the bridge went away')
      },
      () => 0
    )
    missed()
    await settled()
    missed()
    await settled()
    expect(asked).equals(2)
  })

  it('asks once in the deadline it is given', async function () {
    let now = 0
    let asked = 0
    const missed = renewOnDeadline(
      () => {
        asked++
        return true
      },
      () => now,
      500
    )
    missed()
    await settled()
    now += 499
    missed()
    await settled()
    now += 1
    missed()
    await settled()
    expect(asked).equals(2)
  })
  it('stops waiting for a renew that never answers, and asks again at the next miss', async function () {
    let asked = 0
    const missed = renewOnDeadline(
      async () => {
        asked++
        return await new Promise<boolean>(() => undefined)
      },
      () => 0,
      REQUEST_DEADLINE_MS,
      10
    )
    missed()
    await settled()
    missed()
    expect(asked).equals(1)
    await new Promise(resolve => setTimeout(resolve, 30))
    missed()
    await settled()
    expect(asked).equals(2)
  })
})
