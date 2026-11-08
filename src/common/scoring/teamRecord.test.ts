import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playForWire, playFromWire } from '../../server/events/wireRecords'
import { game, TEAMS } from '../../test/scoringGames'
import { recordOf } from './gumbo'
import { setupOf } from './state'
import {
  ownTeams,
  recordByTeam,
  requiresDeferredLineups,
  retargetRecord
} from './teamRecord'

describe('deferred lineup record compatibility', () => {
  it('keeps deferred sides attached to their team through wire reads and a side swap', () => {
    const record = recordByTeam(
      {
        version: 2,
        setupBefore: setupOf(game()),
        actions: [
          {
            type: 'lineup',
            kind: 'roster',
            setup: setupOf(game()),
            side: 'home',
            effectiveSides: ['home'],
            effectiveAtBat: 2
          }
        ]
      },
      TEAMS
    )
    const play = { teamStation: record }
    expect(record.version).equals(4)
    expect(requiresDeferredLineups(play)).equals(true)
    expect(playForWire(play, TEAMS)).equals(play)
    expect(playFromWire(play, TEAMS)).equals(play)
    expect(ownTeams(record)).deep.equals({
      away: { id: TEAMS.away.id },
      home: { id: TEAMS.home.id }
    })
    const switched = { away: TEAMS.home, home: TEAMS.away }
    const action = recordOf(play, switched)!.actions[0]
    expect(action).deep.includes({ side: 'away', effectiveAtBat: 2 })
    expect(action.type === 'lineup' && action.effectiveSides).deep.equals([
      'away'
    ])
    const moved = retargetRecord(record, TEAMS.home.id, 'replacement')
    expect(
      recordOf(
        { teamStation: moved },
        { ...TEAMS, home: { ...TEAMS.home, id: 'replacement' } }
      )!.actions[0]
    ).deep.includes({ side: 'home', effectiveAtBat: 2 })
  })

  it('leaves ordinary records compatible and recognizes earlier deferred envelopes', () => {
    const record = recordByTeam(
      {
        version: 2,
        setupBefore: setupOf(game()),
        actions: [{ type: 'pitch', call: 'B' }]
      },
      TEAMS
    )
    expect(record.version).equals(3)
    expect(requiresDeferredLineups({ teamStation: record })).equals(false)
    expect(
      (
        playForWire({ teamStation: record }, TEAMS).teamStation as {
          version: number
        }
      ).version
    ).equals(2)
    for (const value of [null, {}, { teamStation: {} }])
      expect(requiresDeferredLineups(value)).equals(false)
    expect(
      requiresDeferredLineups({
        teamStation: {
          version: 2,
          actions: [{ type: 'lineup', effectiveAtBat: 1 }]
        }
      })
    ).equals(true)
  })
})
