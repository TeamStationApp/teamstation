import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playerSplits } from './playerSplits'

/** A database that answers every query with the one game. */
const oneGame = new Proxy(
  {},
  {
    get(unused, key): unknown {
      if (key === 'execute') {
        return async () => [
          {
            id: 'gam_1',
            homeTeamId: 'tem_home',
            awayTeamId: 'tem_away',
            homeName: 'Hawks',
            awayName: 'Ravens'
          }
        ]
      }
      return () => oneGame
    }
  }
)

const line = (teamId: string, teamName: string): any => ({
  gameId: 'gam_1',
  teamId,
  teamName,
  seasonName: 'Spring',
  startAt: new Date('2026-05-16T18:00:00Z'),
  pa: 4,
  ab: 4,
  h: 1
})

describe('a player’s split rows', function () {
  it('keeps a pool player’s lines for both sides of a game as a row each, labelled by its own side', async function () {
    const splits = await playerSplits(
      oneGame as any,
      [line('tem_home', 'Hawks'), line('tem_away', 'Ravens')],
      'game'
    )
    expect(
      splits.batting.map(({ split }) => [
        split.teamName,
        split.opponentName,
        split.home
      ])
    ).to.have.deep.members([
      ['Hawks', 'Ravens', true],
      ['Ravens', 'Hawks', false]
    ])
    expect(splits.batting.map(row => row.line.ab)).deep.equals([4, 4])
  })
})
