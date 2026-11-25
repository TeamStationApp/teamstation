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
  retargetRecord,
  SCORING_FEATURES,
  supportsScoringRecords
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

  it('keeps version 5 records by team on the wire and checks capabilities independently', () => {
    const deferred = {
      type: 'lineup' as const,
      kind: 'roster' as const,
      effectiveSides: ['away' as const]
    }
    const record = recordByTeam(
      {
        version: 2,
        liveScoring: true,
        setupBefore: setupOf(game()),
        actions: [deferred]
      },
      TEAMS
    )
    const play = { teamStation: record }
    expect(record.version).equals(5)
    expect(playForWire(play, TEAMS)).equals(play)
    expect(playFromWire(play, TEAMS)).equals(play)
    expect(
      JSON.parse(JSON.stringify(recordByTeam(recordOf(play, TEAMS)!, TEAMS)))
    ).deep.equals(record)
    const swapped = { away: TEAMS.home, home: TEAMS.away }
    expect(recordOf(play, swapped)!.actions[0]).deep.includes({
      effectiveSides: ['home']
    })
    const replaced = retargetRecord(record, TEAMS.home.id, 'replacement')
    expect(ownTeams(replaced).home.id).equals('replacement')
    expect(supportsScoringRecords(undefined, [play])).equals(false)
    expect(supportsScoringRecords('deferred-lineups-v1', [play])).equals(false)
    expect(supportsScoringRecords('live-scoring-v1', [play])).equals(false)
    expect(supportsScoringRecords(SCORING_FEATURES, [play])).equals(true)
    expect(
      supportsScoringRecords('unknown, live-scoring-v1, deferred-lineups-v1', [
        play
      ])
    ).equals(true)
    expect(
      supportsScoringRecords('deferred-lineups-v1', [
        { teamStation: { version: 4 } }
      ])
    ).equals(true)
    expect(
      supportsScoringRecords(undefined, [{ teamStation: { version: 3 } }, null])
    ).equals(true)
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
