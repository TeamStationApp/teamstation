import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGuests } from './guests'

describe('game guest identities', function () {
  it('reads an absent field as independent empty arrays', function () {
    const first = asGuests(undefined)
    expect(first).deep.equals({ away: [], home: [] })
    first.away.push(1)
    expect(asGuests(undefined)).deep.equals({ away: [], home: [] })
    expect(first.home).deep.equals([])
  })
  it('accepts positive safe ids and refuses duplicate or malformed lists', function () {
    const guests = { away: [1, Number.MAX_SAFE_INTEGER], home: [99] }
    expect(asGuests(guests)).deep.equals(guests)
    for (const invalid of [
      null,
      {},
      { away: [], home: null },
      { away: [1, 1], home: [] },
      { away: ['1'], home: [] },
      { away: [0], home: [] },
      { away: [Number.MAX_SAFE_INTEGER + 1], home: [] }
    ])
      expect(() => asGuests(invalid)).throws()
  })
})
