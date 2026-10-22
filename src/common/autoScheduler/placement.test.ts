import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import { buildContext, type RunContext } from './context'
import { runMatchups } from './counts'
import { field, fixedGame, hoursOn, input, season, ZONE } from './fixtures.test'
import { place, type Placement, searchBudget } from './placement'
import { compareScores, TRUE_ORDER, UNPLACED } from './score'
import type { Slot } from './slots'
import type { EngineInput } from './types'

function run(changes: Partial<EngineInput> = {}): {
  context: RunContext
  placement: (seed: number, budget?: number) => Placement
} {
  const context = buildContext(input(changes))
  const matchups = runMatchups(context, new Map(), 3)
  return {
    context,
    placement: (seed, budget) =>
      place(context, matchups, seed, TRUE_ORDER, budget)
  }
}

/** Every pair of placed games keeps the hard rules between them. */
function expectHardRules(placement: Placement, bufferMs: number): void {
  const placed = placement.matchups
    .map((matchup, i) => ({ matchup, slot: placement.slots[i] }))
    .filter(
      (entry): entry is { matchup: typeof entry.matchup; slot: Slot } =>
        entry.slot != null
    )
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      const apart =
        a.slot.end + bufferMs <= b.slot.start ||
        b.slot.end + bufferMs <= a.slot.start
      if (a.slot.fieldId === b.slot.fieldId) expect(apart).equals(true)
      const teams = [a.matchup.homeTeamId, a.matchup.awayTeamId]
      if (
        teams.includes(b.matchup.homeTeamId) ||
        teams.includes(b.matchup.awayTeamId)
      )
        expect(a.slot.end <= b.slot.start || b.slot.end <= a.slot.start).equals(
          true
        )
    }
}

describe('place', () => {
  it('is deterministic for a seed', () => {
    const { placement } = run()
    const first = placement(11)
    const again = placement(11)
    expect(again.slots.map(slot => slot?.start)).deep.equals(
      first.slots.map(slot => slot?.start)
    )
    expect(again.score).deep.equals(first.score)
    const other = placement(12)
    expect(other.slots.map(slot => slot?.start)).not.deep.equals(
      first.slots.map(slot => slot?.start)
    )
  }).timeout(30_000)

  it('improves on the greedy result', () => {
    const { placement } = run()
    const greedy = placement(3, 0)
    const searched = placement(3)
    expect(greedy.score[UNPLACED]).equals(0)
    expect(compareScores(searched.score, greedy.score)).equals(-1)
  }).timeout(30_000)

  it('keeps the hard rules for every game it places', () => {
    const { placement } = run({
      seasons: [season({ regularGames: 12, endsOn: '2027-04-30' })],
      fixed: [
        fixedGame(
          'g1',
          'tem_hawks',
          'tem_owls',
          new Date(wallInstant('2027-03-06', '10:00', ZONE)).toISOString(),
          120
        )
      ]
    })
    const result = placement(5)
    expect(result.score[UNPLACED]).equals(0)
    expectHardRules(result, 10 * 60_000)
    const g1 = wallInstant('2027-03-06', '10:00', ZONE)
    for (const slot of result.slots)
      if (slot != null)
        expect(
          slot.end + 10 * 60_000 <= g1 ||
            slot.start >= g1 + 120 * 60_000 + 10 * 60_000
        ).equals(true)
  }).timeout(30_000)

  it('leaves what cannot fit unplaced', () => {
    const saturday = hoursOn([6], '08:00', '18:00')
    const { placement } = run({
      seasons: [
        season({
          endsOn: '2027-03-06',
          regularGames: 2,
          exhibitionGames: 0,
          windows: [{ from: '2027-03-01', hours: saturday }]
        })
      ],
      fields: [
        field({ availability: { ...field().availability, hours: saturday } })
      ]
    })
    // One Saturday holds six games; seven teams need seven.
    const result = placement(1)
    expect(result.score[UNPLACED]).equals(1)
    expect(result.slots.filter(slot => slot != null)).length(6)
    expectHardRules(result, 10 * 60_000)
  }).timeout(30_000)

  it('does nothing with nothing to place', () => {
    const context = buildContext(input())
    const result = place(context, [], 1)
    expect(result.slots).deep.equals([])
    expect(result.score[UNPLACED]).equals(0)
  }).timeout(30_000)

  it('sets the search budget by the number of games', () => {
    expect(searchBudget(21)).equals(8400)
    expect(searchBudget(112)).equals(20_000)
  }).timeout(30_000)
})
