import { expect } from 'chai'

import {
  isLocalTagRevision,
  localTagRevision,
  nextLocalTagRevision,
  supersededTag
} from './tagRevisions'

describe('tag revisions', function () {
  it('names the phone’s revisions apart from the server’s, each later than the last', function () {
    const firstAt = nextLocalTagRevision(1_000_000, 0)
    const first = localTagRevision(firstAt)
    const second = localTagRevision(nextLocalTagRevision(1_000_000, firstAt))
    expect(isLocalTagRevision(first)).equals(true)
    expect(isLocalTagRevision('42')).equals(false)
    expect(
      supersededTag(
        { revision: second, order: 2 },
        { revision: first, order: 1 }
      )
    ).equals(true)
    expect(
      supersededTag(
        { revision: first, order: 1 },
        { revision: second, order: 2 }
      )
    ).equals(false)
  })

  it('keeps each of the phone’s revisions later than the last when the clock goes back or many come in one millisecond (1.harness-review.4)', function () {
    let last = 0
    const numbers: number[] = []
    for (const now of [5_000, 5_000, 4_000, 5_000, 6_000]) {
      last = nextLocalTagRevision(now, last)
      numbers.push(last)
    }
    for (let i = 1; i < numbers.length; i++)
      expect(numbers[i]).greaterThan(numbers[i - 1])
    for (let i = 0; i < 2000; i++) last = nextLocalTagRevision(7_000, last)
    const later = nextLocalTagRevision(7_000, last)
    expect(
      supersededTag(
        { revision: localTagRevision(later), order: 2 },
        { revision: localTagRevision(last), order: 1 }
      )
    ).equals(true)
    // From the clock where it is ahead.
    expect(nextLocalTagRevision(9_000, last)).equals(9_000_000)
  })

  it('orders the server’s revisions as numbers, and takes any answer for a target with none', function () {
    expect(supersededTag(undefined, { revision: '1', order: 1 })).equals(false)
    expect(
      supersededTag({ revision: '10', order: 1 }, { revision: '9', order: 2 })
    ).equals(true)
    expect(
      supersededTag({ revision: '9', order: 1 }, { revision: '10', order: 2 })
    ).equals(false)
    expect(
      supersededTag({ revision: '12', order: 1 }, { revision: '11', order: 2 })
    ).equals(true)
  })

  it('never compares a phone revision with a server one: the later save wins', function () {
    const local = localTagRevision(1_700_000_000_000 * 1000 + 3)
    // A save sent to the server after a queued one: its short revision is
    // still the newer answer.
    expect(
      supersededTag({ revision: local, order: 1 }, { revision: '8', order: 2 })
    ).equals(false)
    // A server answer to a save made before the queued one arrives late.
    expect(
      supersededTag({ revision: local, order: 2 }, { revision: '8', order: 1 })
    ).equals(true)
    expect(
      supersededTag({ revision: '8', order: 1 }, { revision: local, order: 2 })
    ).equals(false)
    expect(
      supersededTag({ revision: '8', order: 2 }, { revision: local, order: 1 })
    ).equals(true)
  })
})
