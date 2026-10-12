import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  isScoringPlayerChild,
  isScoringPlayerReturn
} from './scoringPlayerReturn'
const origin = { gameId: 'game_fixture', userId: '100', teamId: 'away' }
describe('scoring player visit boundaries', function () {
  it('accepts only the retained game and player/team, including their own tabs and filters', function () {
    expect(
      isScoringPlayerReturn(
        { name: 'scoreGame', gameId: origin.gameId },
        origin
      )
    ).equals(true)
    expect(
      isScoringPlayerReturn({ name: 'scoreGame', gameId: 'other' }, origin)
    ).equals(false)
    expect(isScoringPlayerReturn({ name: 'home' }, origin)).equals(false)
    expect(
      isScoringPlayerReturn({ name: 'scoreGame', gameId: origin.gameId })
    ).equals(false)
    for (const tab of ['settings', 'stats', 'videos', 'walkup'] as const)
      expect(
        isScoringPlayerChild(
          {
            name: 'player',
            userId: '100',
            onTeam: 'away',
            tab,
            teamId: 'other'
          },
          origin
        )
      ).equals(true)
    for (const route of [
      { name: 'player' as const, userId: '100', onTeam: 'home' },
      { name: 'player' as const, userId: '200', onTeam: 'away' },
      { name: 'home' as const }
    ])
      expect(isScoringPlayerChild(route, origin)).equals(false)
    expect(
      isScoringPlayerChild({ name: 'player', userId: '100', onTeam: 'away' })
    ).equals(false)
  })
})
