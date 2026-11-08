import { expect } from 'chai'

import { F, game } from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import {
  latestLineupChanges,
  lineupSides,
  olderThan,
  stampTime
} from './lineupTimes'
import { copyState, setupOf } from './state'

describe('lineup change times (U41)', function () {
  const opening = setupOf(game())
  const roster = (
    change: (setup: ReturnType<typeof setupOf>) => void,
    from = opening
  ): ScoringAction => {
    const setup = copyState(from)
    change(setup)
    return { type: 'lineup', kind: 'roster', setup }
  }
  const reverseHome = (setup: ReturnType<typeof setupOf>): void => {
    setup.sides.home.battingOrder = [...setup.sides.home.battingOrder].reverse()
  }
  const reverseAway = (setup: ReturnType<typeof setupOf>): void => {
    setup.sides.away.battingOrder = [...setup.sides.away.battingOrder].reverse()
  }

  it('reads which sides each lineup change changes, through every kind of change', function () {
    const home = roster(reverseHome)
    const both = roster(
      setup => {
        reverseAway(setup)
        reverseHome(setup)
      },
      (home as { setup: ReturnType<typeof setupOf> }).setup
    )
    // The home second baseman moves to short: a home change.
    const moved: ScoringAction = {
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position: 'SS',
      player: F['2B']
    }
    const afterMove = applyAction(
      [home, both, moved].reduce(
        (state, action) => applyAction(state, action).state,
        game()
      ),
      { type: 'pitch', call: 'B' }
    ).state
    // Then a roster made on that game that changes only the away order.
    const awayOnly = roster(reverseAway, setupOf(afterMove))
    const log: ScoringAction[] = [
      home,
      both,
      moved,
      { type: 'pitch', call: 'B' },
      awayOnly,
      roster(() => undefined, (awayOnly as { setup: typeof opening }).setup)
    ]
    expect(lineupSides(game(), log)).deep.equals([
      ['home'],
      ['away', 'home'],
      ['home'],
      null,
      ['away'],
      []
    ])
    // From an action the game refuses, a lineup action counts as it names.
    expect(
      lineupSides(game(), [
        { type: 'lineup', kind: 'position', side: 'away', position: 'C' },
        { type: 'lineup', kind: 'battingOrder', order: [] }
      ])
    ).deep.equals([['away'], ['away', 'home']])
  })

  it('finds each side’s latest change from a point on, and weighs a change against it', function () {
    const sides = [['home'], null, ['away', 'home'], ['away']] as const
    const times = [
      '2026-09-25T12:00:30.000Z',
      '2026-09-25T12:00:40.000Z',
      '2026-09-25T12:00:10.000Z',
      undefined
    ]
    expect(latestLineupChanges(sides, times)).deep.equals({
      home: Date.parse('2026-09-25T12:00:30.000Z'),
      away: Date.parse('2026-09-25T12:00:10.000Z')
    })
    const fromTwo = latestLineupChanges(sides, times, 2)
    expect(fromTwo).deep.equals({
      home: Date.parse('2026-09-25T12:00:10.000Z'),
      away: Date.parse('2026-09-25T12:00:10.000Z')
    })
    expect(olderThan(['home'], '2026-09-25T12:00:05.000Z', fromTwo)).equals(
      true
    )
    expect(olderThan(['home'], '2026-09-25T12:00:10.000Z', fromTwo)).equals(
      false
    )
    expect(olderThan([], '2026-09-25T12:00:05.000Z', fromTwo)).equals(false)
    // A change with no time it was made at, or an unreadable one, stands.
    expect(olderThan(['home'], undefined, fromTwo)).equals(false)
    expect(olderThan(['home'], 'soon', fromTwo)).equals(false)
    expect(stampTime('soon')).equals(undefined)
    expect(olderThan(['away'], '2026-09-25T12:00:05.000Z', {})).equals(false)
  })
})
