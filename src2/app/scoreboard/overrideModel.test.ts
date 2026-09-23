import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  NO_OVERRIDES,
  SAMPLE_SCOREBOARD,
  type ScoreboardState
} from '../../common/scoreboard'
import {
  acceptServerOverrides,
  isOverridden,
  type OverrideAction,
  type OverrideModel,
  overrideReducer,
  overridesKey
} from './overrideModel'

const automated: ScoreboardState = {
  ...SAMPLE_SCOREBOARD,
  balls: 1,
  strikes: 1,
  outs: 0,
  base1: true,
  base2: false,
  base3: true,
  inning: 4,
  half: 'bottom'
}
const start: OverrideModel = { automated, overrides: NO_OVERRIDES }

function run(...actions: OverrideAction[]): OverrideModel {
  return actions.reduce(overrideReducer, start)
}
function groupsOn(model: OverrideModel): string[] {
  return (['team', 'score', 'inning', 'bases', 'count'] as const).filter(
    group => isOverridden(model.overrides, group)
  )
}

describe('overrideModel', function () {
  it('turns the count on at the first ball, seeded from the automated count', function () {
    const model = run({ type: 'incrementCount', row: 'balls' })
    expect(model.overrides.overrideCountEnabled).equals(true)
    expect(model.overrides.overrideCount).deep.equals({
      balls: 2,
      strikes: 1,
      outs: 0
    })
    expect(groupsOn(model)).deep.equals(['count'])
  })

  it('stops at 3 balls, 2 strikes and 2 outs', function () {
    const presses = (row: 'balls' | 'strikes' | 'outs'): OverrideAction[] =>
      Array.from({ length: 5 }, () => ({ type: 'incrementCount', row }))
    const model = run(
      ...presses('balls'),
      ...presses('strikes'),
      ...presses('outs')
    )
    expect(model.overrides.overrideCount).deep.equals({
      balls: 3,
      strikes: 2,
      outs: 2
    })
  })

  it('clears one row with C', function () {
    const model = run(
      { type: 'incrementCount', row: 'outs' },
      { type: 'clearCount', row: 'balls' }
    )
    expect(model.overrides.overrideCount).deep.equals({
      balls: 0,
      strikes: 1,
      outs: 1
    })
  })

  it('flips one base, seeding the other two from the automated bases', function () {
    const model = run({ type: 'toggleBase', base: 'base2' })
    expect(model.overrides.overrideBases).deep.equals({
      base1: true,
      base2: true,
      base3: true
    })
    const again = overrideReducer(model, { type: 'toggleBase', base: 'base1' })
    expect(again.overrides.overrideBases).deep.equals({
      base1: false,
      base2: true,
      base3: true
    })
  })

  it('turns on only the group each edit belongs to', function () {
    expect(
      groupsOn(run({ type: 'setScore', side: 'home', score: 9 }))
    ).deep.equals(['score'])
    expect(
      run({ type: 'setScore', side: 'home', score: 9 }).overrides.overrideScore
    ).deep.equals({ homeScore: 9, awayScore: 2 })
    expect(
      run({ type: 'setScore', side: 'away', score: -2.4 }).overrides
        .overrideScore
    ).deep.equals({ homeScore: 3, awayScore: 0 })
    const team = run({ type: 'setTeam', side: 'away', name: 'OWLS' })
    expect(groupsOn(team)).deep.equals(['team'])
    expect(team.overrides.overrideTeam).deep.equals({
      homeTeam: 'PIONEERS',
      awayTeam: 'OWLS'
    })
    const home = overrideReducer(team, {
      type: 'setTeam',
      side: 'home',
      name: 'HAWKS'
    })
    expect(home.overrides.overrideTeam).deep.equals({
      homeTeam: 'HAWKS',
      awayTeam: 'OWLS'
    })
    const inning = run({ type: 'setInning', inning: 7 })
    expect(groupsOn(inning)).deep.equals(['inning'])
    expect(inning.overrides.overrideInning).deep.equals({
      inning: 7,
      half: 'bottom'
    })
    expect(
      run({ type: 'setInning', inning: 0 }).overrides.overrideInning?.inning
    ).equals(1)
  })

  it('adds one to a tapped score, seeded from the automated score', function () {
    const once = run({ type: 'incrementScore', side: 'home' })
    expect(groupsOn(once)).deep.equals(['score'])
    expect(once.overrides.overrideScore).deep.equals({
      homeScore: 4,
      awayScore: 2
    })
    const model = run(
      { type: 'incrementScore', side: 'home' },
      { type: 'incrementScore', side: 'home' },
      { type: 'incrementScore', side: 'away' }
    )
    expect(model.overrides.overrideScore).deep.equals({
      homeScore: 5,
      awayScore: 3
    })
  })

  it('adds one to a tapped inning, keeping the half', function () {
    const model = run({ type: 'incrementInning' }, { type: 'incrementInning' })
    expect(groupsOn(model)).deep.equals(['inning'])
    expect(model.overrides.overrideInning).deep.equals({
      inning: 6,
      half: 'bottom'
    })
  })

  it('switches halves, and a press on the half showing goes between halves', function () {
    const top = run({ type: 'toggleHalf', half: 'top' })
    expect(groupsOn(top)).deep.equals(['inning'])
    expect(top.overrides.overrideInning).deep.equals({ inning: 4, half: 'top' })
    const mid = overrideReducer(top, { type: 'toggleHalf', half: 'top' })
    expect(mid.overrides.overrideInning?.half).equals('mid')
    const bottom = overrideReducer(mid, { type: 'toggleHalf', half: 'bottom' })
    expect(bottom.overrides.overrideInning?.half).equals('bottom')
  })

  it('reverts only the count group with its ✕, and the next edit starts afresh', function () {
    const model = run(
      { type: 'incrementCount', row: 'balls' },
      { type: 'incrementCount', row: 'balls' },
      { type: 'toggleBase', base: 'base2' },
      { type: 'revert', group: 'count' }
    )
    expect(groupsOn(model)).deep.equals(['bases'])
    expect(model.overrides.overrideCountEnabled).equals(false)
    expect(model.overrides.overrideCount).equals(undefined)
    const next = overrideReducer(model, {
      type: 'incrementCount',
      row: 'strikes'
    })
    expect(next.overrides.overrideCount).deep.equals({
      balls: 1,
      strikes: 2,
      outs: 0
    })
  })

  it('resets to no overrides at all', function () {
    const model = run(
      { type: 'incrementCount', row: 'balls' },
      { type: 'setScore', side: 'home', score: 9 },
      { type: 'setTeam', side: 'home', name: 'X' },
      { type: 'toggleBase', base: 'base1' },
      { type: 'setInning', inning: 2 },
      { type: 'reset' }
    )
    expect(model.overrides).deep.equals(NO_OVERRIDES)
    expect(model.automated).equals(automated)
  })

  it('keeps an overridden group’s values as the base of the next edit', function () {
    const model = run(
      { type: 'setScore', side: 'home', score: 9 },
      { type: 'setScore', side: 'away', score: 4 }
    )
    expect(model.overrides.overrideScore).deep.equals({
      homeScore: 9,
      awayScore: 4
    })
  })
})

describe('overridesKey and acceptServerOverrides', function () {
  const sent = run({ type: 'incrementCount', row: 'balls' }).overrides
  const second = run(
    { type: 'incrementCount', row: 'balls' },
    { type: 'incrementCount', row: 'balls' }
  ).overrides

  it('names the same overrides the same whatever the key order', function () {
    const reordered = JSON.parse(
      '{"overrideCount":{"outs":0,"strikes":1,"balls":2},"overrideInningEnabled":false,"overrideScoreEnabled":false,"overrideTeamEnabled":false,"overrideBasesEnabled":false,"overrideCountEnabled":true}'
    )
    expect(overridesKey(reordered)).equals(overridesKey(sent))
    expect(overridesKey(second)).not.equals(overridesKey(sent))
    // A group switched off says nothing about the values it once held.
    expect(
      overridesKey({
        ...NO_OVERRIDES,
        overrideCount: { balls: 1, strikes: 0, outs: 0 }
      })
    ).equals(overridesKey(NO_OVERRIDES))
  })

  it('takes the server’s word when nothing is in flight', function () {
    expect(acceptServerOverrides([], NO_OVERRIDES)).deep.equals({
      pending: [],
      adopt: true
    })
  })

  it('keeps its own until the echo of the latest send arrives', function () {
    const pending = [overridesKey(sent), overridesKey(second)]
    const first = acceptServerOverrides(pending, sent)
    expect(first).deep.equals({ pending: [overridesKey(second)], adopt: false })
    const other = acceptServerOverrides(first.pending, NO_OVERRIDES)
    expect(other.adopt).equals(false)
    expect(acceptServerOverrides(other.pending, second)).deep.equals({
      pending: [],
      adopt: true
    })
  })
})
