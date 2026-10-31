import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  compareSplits,
  splitLabels,
  splitTieKey,
  type StatSplit
} from './playerStatSplits'

const split = (fields: Partial<StatSplit>): StatSplit => ({
  teamId: 'hawks',
  teamName: 'Hawks',
  seasonName: 'Spring 2026',
  gameId: null,
  startAt: '2026-05-16T18:00:00.000Z',
  opponentName: null,
  home: null,
  ...fields
})

/** A fixed date, so the labels do not hang on the machine's time zone. */
const date = (startAt: string): string => startAt.slice(5, 10)

describe('player stat split labels', function () {
  it('names a team row by its team, and adds the season only to a shared name', function () {
    expect(
      splitLabels(
        [
          split({ teamId: 'hawks26' }),
          split({ teamId: 'ravens', teamName: 'Ravens', seasonName: 'Fall' }),
          split({ teamId: 'hawks25', seasonName: 'Fall 2025' }),
          split({ teamId: null, teamName: null, seasonName: null })
        ],
        'team',
        date
      )
    ).deep.equals([
      'Hawks · Spring 2026',
      'Ravens',
      'Hawks · Fall 2025',
      'No team'
    ])
  })

  it('keeps a shared name bare when the row has no season to tell it by', function () {
    expect(
      splitLabels(
        [split({ teamId: 'a', seasonName: null }), split({ teamId: 'b' })],
        'team',
        date
      )
    ).deep.equals(['Hawks', 'Hawks · Spring 2026'])
  })

  it('names a game row by its date and opponent, vs at home and @ away', function () {
    expect(
      splitLabels(
        [
          split({ gameId: 'g1', opponentName: 'Ravens', home: true }),
          split({ gameId: 'g2', opponentName: 'Owls', home: false }),
          split({ gameId: 'g3' }),
          split({ gameId: 'g4', startAt: null })
        ],
        'game',
        date
      )
    ).deep.equals(['05-16 vs Ravens', '05-16 @ Owls', '05-16', 'No date'])
  })

  it('adds the year to a game row only when the rows span years', function () {
    expect(
      splitLabels(
        [
          split({ gameId: 'g1', startAt: '2026-05-16T18:00:00.000Z' }),
          split({ gameId: 'g2', startAt: '2025-05-16T18:00:00.000Z' }),
          split({ gameId: 'g3', startAt: null })
        ],
        'game',
        date
      )
    ).deep.equals(['05-16, 2026', '05-16, 2025', 'No date'])
    expect(
      splitLabels(
        [split({ gameId: 'g1', startAt: '2026-05-16T18:00:00.000Z' })],
        'game',
        date
      )
    ).deep.equals(['05-16'])
  })

  it('reads the rows’ years as the year filter does, in UTC', function () {
    // A US evening on New Year's Eve is the new year here and on the server.
    expect(
      splitLabels(
        [
          split({ gameId: 'g1', startAt: '2026-01-01T02:00:00.000Z' }),
          split({ gameId: 'g2', startAt: '2026-03-01T18:00:00.000Z' })
        ],
        'game',
        date
      )
    ).deep.equals(['01-01', '03-01'])
  })

  it('adds the team to a game row only when the rows span teams', function () {
    expect(
      splitLabels(
        [
          split({ gameId: 'g1', opponentName: 'Ravens', home: true }),
          split({
            gameId: 'g2',
            teamId: 'owls',
            teamName: 'Owls',
            opponentName: 'Hawks',
            home: false
          })
        ],
        'game',
        date
      )
    ).deep.equals(['05-16 vs Ravens · Hawks', '05-16 @ Hawks · Owls'])
  })

  it('numbers rows that still read the same, in both of a page’s tables', function () {
    const first = split({ teamId: 'a' })
    const second = split({ teamId: 'b' })
    expect(splitLabels([first, second], 'team', date)).deep.equals([
      'Hawks (1) · Spring 2026',
      'Hawks (2) · Spring 2026'
    ])
    expect(splitLabels([second], 'team', date, [first, second])).deep.equals([
      'Hawks (2) · Spring 2026'
    ])
  })

  it('numbers a doubleheader in the order it was played, the number by the date', function () {
    const late = split({
      gameId: 'g2',
      startAt: '2026-05-23T20:00:00.000Z',
      opponentName: 'Mountain Ridge Renegades 12U',
      home: false
    })
    const early = { ...late, gameId: 'g1', startAt: '2026-05-23T16:00:00.000Z' }
    expect(splitLabels([late, early], 'game', date)).deep.equals([
      '05-23 (2) @ Mountain Ridge Renegades 12U',
      '05-23 (1) @ Mountain Ridge Renegades 12U'
    ])
  })

  it('tells a page’s tables apart the same way', function () {
    const hawks = split({ teamId: 'a', seasonName: 'Spring 2026' })
    const others = split({ teamId: 'b', seasonName: 'Fall 2025' })
    expect(splitLabels([hawks], 'team', date, [hawks, others])).deep.equals([
      'Hawks · Spring 2026'
    ])
    expect(
      splitLabels(
        [split({ gameId: 'g1', opponentName: 'Ravens', home: true })],
        'game',
        date,
        [
          split({ gameId: 'g1', opponentName: 'Ravens', home: true }),
          split({ gameId: 'g2', startAt: '2025-05-16T18:00:00.000Z' }),
          split({ gameId: 'g3', teamId: 'owls', teamName: 'Owls' })
        ]
      )
    ).deep.equals(['05-16, 2026 vs Ravens · Hawks'])
  })

  it('orders newest first, an undated row last, equal starts by label and then id', function () {
    const newest = split({ gameId: 'g1', startAt: '2026-06-01T00:00:00.000Z' })
    const vs = split({ gameId: 'g3', opponentName: 'Ravens', home: true })
    const at = split({ gameId: 'g2', opponentName: 'Ravens', home: false })
    const twinA = split({ gameId: 'g4', opponentName: 'Owls', home: true })
    const twinB = split({ gameId: 'g5', opponentName: 'Owls', home: true })
    const undated = split({ gameId: 'g6', startAt: null })
    expect(
      [undated, twinB, vs, at, newest, twinA]
        .sort(compareSplits)
        .map(row => row.gameId)
    ).deep.equals(['g1', 'g2', 'g4', 'g5', 'g3', 'g6'])
    expect(compareSplits(twinA, twinA)).equals(0)
    expect(
      compareSplits(undated, split({ gameId: 'g7', startAt: null }))
    ).lessThan(0)
    const team = (teamId: string | null): StatSplit =>
      split({ teamId, startAt: null })
    expect(compareSplits(team(null), team('a'))).lessThan(0)
  })

  it('ties on the side and opponent, then the team and its season', function () {
    expect(splitTieKey(split({ opponentName: 'Ravens', home: true }))).equals(
      'vs Ravens\u0000Hawks\u0000Spring 2026'
    )
    expect(splitTieKey(split({ teamName: null, seasonName: null }))).equals(
      '\u0000\u0000'
    )
  })
})
