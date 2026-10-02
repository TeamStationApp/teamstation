import { expect } from 'chai'
import { describe, it } from 'mocha'

import { freeBytes, roomToRecord } from './diskSpace'

const FLOOR = 10_000_000_000

describe('room to record', function () {
  it('allows a stream when there is room', function () {
    expect(roomToRecord(50_000_000_000, FLOOR).ok).equals(true)
    expect(roomToRecord(FLOOR, FLOOR).ok).equals(true)
  })

  it('refuses one when there is not, and says what is left', function () {
    const result = roomToRecord(2_500_000_000, FLOOR)
    expect(result.ok).equals(false)
    expect(result.reason).contains('2.5 GB free')
    expect(result.reason).contains('10 GB is the floor')
  })

  it('allows a stream when the room cannot be measured', function () {
    // A net that cannot see is worse than no net: it would stop a game being
    // filmed for a reason nobody could check.
    expect(roomToRecord(undefined, FLOOR).ok).equals(true)
  })

  it('reads a real filesystem, and shrugs at one that is not there', async function () {
    const here = await freeBytes(process.cwd())
    expect(here).is.a('number')
    expect(here ?? 0).is.greaterThan(0)
    expect(await freeBytes('/no/such/place/at/all')).equals(undefined)
  })
})
