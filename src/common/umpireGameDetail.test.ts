import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail } from './api'

describe('game detail umpire contract', () => {
  const game = {
    nonMemberView: false,
    id: 'gam_demo',
    awayTeamId: 'tem_away',
    homeTeamId: 'tem_home',
    awayTeamName: 'Demo Visitors',
    homeTeamName: 'Demo Hosts',
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
  const umpires = {
    positions: [
      {
        slot: 'uty_first:1',
        typeId: 'uty_first',
        typeName: '1st',
        ordinal: 1,
        required: false,
        person: null
      }
    ]
  }
  it('preserves typed optional positions supplied by the game endpoint', () => {
    expect(asGameDetail({ ...game, umpires }).umpires).deep.equals(umpires)
  })
  it('allows an absent game umpire block', () => {
    expect(asGameDetail(game).umpires).equals(null)
  })
})
