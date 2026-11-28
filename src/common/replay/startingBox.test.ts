import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GameDetail, GameLineupsResponse } from '../api'
import { startingBox } from './startingBox'

describe('a starting box', function () {
  it('is none for a game with an open side, which has no lineup on it', function () {
    const lineup = { batters: [], defense: {} }
    const lineups = {
      away: { start: null, current: lineup },
      home: { start: null, current: lineup }
    } as unknown as GameLineupsResponse
    const game = {
      id: 'gam_1',
      homeTeamId: 'tem_hawks',
      awayTeamId: null,
      homeTeamName: 'Hawks',
      awayTeamName: 'TBD'
    } as unknown as GameDetail
    expect(startingBox(game, lineups)).equals(null)
  })
})
