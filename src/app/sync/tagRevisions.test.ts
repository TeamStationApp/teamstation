import { expect } from 'chai'

import {
  isLocalTagRevision,
  localTagRevision,
  supersededTag
} from './tagRevisions'

describe('tag revisions', function () {
  it('names the phone’s revisions apart from the server’s, each later than the last', function () {
    const first = localTagRevision(1_000_000, 0)
    const second = localTagRevision(1_000_000, 1)
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
    const local = localTagRevision(1_700_000_000_000, 3)
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
