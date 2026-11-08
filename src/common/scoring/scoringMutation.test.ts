import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asScoringMutation,
  authoredScoringMutation,
  compareScoringMutations,
  scoringFingerprintInput
} from './scoringMutation'

describe('scoring authorship', () => {
  const stamp = { at: 1000, id: 'phone-a', revision: 0, frontier: 2 }
  it('validates the wire identity and strips unrelated fields', () => {
    expect(asScoringMutation({ ...stamp, ignored: true })).deep.equals(stamp)
    for (const invalid of [
      null,
      {},
      { ...stamp, at: NaN },
      { ...stamp, at: Infinity },
      { ...stamp, at: -1 },
      { ...stamp, at: 1.5 },
      { ...stamp, id: '' },
      { ...stamp, id: 'a b' },
      { ...stamp, id: 'a'.repeat(129) },
      { ...stamp, revision: -1 },
      { ...stamp, revision: 0.5 },
      { ...stamp, frontier: -1 },
      { ...stamp, frontier: Number.MAX_SAFE_INTEGER + 1 }
    ])
      expect(() => asScoringMutation(invalid)).throws()
  })
  it('orders time first, deterministic identity second, normalization last', () => {
    expect(compareScoringMutations(stamp, { ...stamp, at: 1001 })).below(0)
    expect(compareScoringMutations(stamp, { ...stamp, id: 'phone-b' })).below(0)
    expect(compareScoringMutations(stamp, { ...stamp, id: 'phone-0' })).above(0)
    expect(compareScoringMutations(stamp, { ...stamp, revision: 1 })).below(0)
    expect(compareScoringMutations(stamp, { ...stamp, frontier: 0 })).equals(0)
  })
  it('authors distinct identities even in the same clock millisecond', () => {
    const a = authoredScoringMutation(1000)
    const b = authoredScoringMutation(1000)
    expect(a.at).equals(b.at)
    expect(a.id).not.equals(b.id)
    expect(compareScoringMutations(a, b)).below(0)
    expect(asScoringMutation(a)).deep.equals(a)
  })
  it('fingerprints values independently of property ordering', () => {
    expect(
      scoringFingerprintInput({
        b: [null, { y: 1, x: true }],
        a: 2,
        omitted: undefined
      })
    ).equals(scoringFingerprintInput({ a: 2, b: [null, { x: true, y: 1 }] }))
    expect(scoringFingerprintInput([1, 2])).not.equals(
      scoringFingerprintInput([2, 1])
    )
    expect(scoringFingerprintInput(undefined)).equals('null')
  })
})
