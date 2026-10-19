import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail } from './api'
import { asUnrostered } from './unroster'

describe('game unrostered identities', function () {
  it('reads both game lists from older and current API payloads', function () {
    const raw = {
      nonMemberView: false,
      id: 'gam_one',
      awayTeamId: 'tem_away',
      homeTeamId: 'tem_home',
      awayTeamName: 'Visitors',
      homeTeamName: 'Hosts',
      seasonId: null,
      startAt: null,
      venue: null,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      ingestStatus: 'pending',
      ingestMessage: null,
      canScore: true,
      videos: []
    }
    expect(asGameDetail(raw).unrostered).deep.equals({ away: [], home: [] })
    expect(asGameDetail(raw).guests).deep.equals({ away: [], home: [] })
    const lists = { away: [123], home: [] }
    expect(asGameDetail({ ...raw, unrostered: lists }).unrostered).deep.equals(
      lists
    )
  })
  it('reads an absent field as independent empty arrays', function () {
    const first = asUnrostered(undefined)
    expect(first).deep.equals({ away: [], home: [] })
    first.away.push(1)
    expect(asUnrostered(undefined)).deep.equals({ away: [], home: [] })
    expect(first.home).deep.equals([])
  })
  it('accepts positive safe ids and refuses duplicate or malformed lists', function () {
    const guests = { away: [1, Number.MAX_SAFE_INTEGER], home: [99] }
    expect(asUnrostered(guests)).deep.equals(guests)
    for (const invalid of [
      null,
      {},
      { away: [], home: null },
      { away: [1, 1], home: [] },
      { away: ['1'], home: [] },
      { away: [0], home: [] },
      { away: [Number.MAX_SAFE_INTEGER + 1], home: [] }
    ])
      expect(() => asUnrostered(invalid)).throws()
  })
})
