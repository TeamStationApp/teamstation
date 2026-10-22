import { expect } from 'chai'
import { describe, it } from 'mocha'

import { buildContext } from './context'
import { fixedGame, input, season } from './fixtures.test'
import {
  addScores,
  compareScores,
  DOUBLEHEADERS,
  mixDeviation,
  SCARCITY,
  SeasonLedger,
  SPACING,
  TeamTally,
  TIME_OF_DAY,
  TRUE_ORDER,
  UNPLACED,
  WEEKDAY
} from './score'
import { AFTERNOON, EVENING, type GamePoint, MORNING } from './slots'

const point = (day: number, timeOfDay = EVENING, weekday = 1): GamePoint => ({
  date: `d${day}`,
  day,
  weekday,
  timeOfDay
})

describe('compareScores', () => {
  it('compares term by term in the true order', () => {
    expect(TRUE_ORDER).deep.equals([
      UNPLACED,
      DOUBLEHEADERS,
      TIME_OF_DAY,
      SPACING,
      WEEKDAY,
      SCARCITY
    ])
    // One unplaced game outweighs everything after it.
    expect(compareScores([0, 9, 9, 9, 9, 9], [1, 0, 0, 0, 0, 0])).equals(-1)
    // Then doubleheaders, time of day, spacing, weekday and scarcity.
    expect(compareScores([0, 1, 0, 0, 0, 0], [0, 0, 5, 5, 5, 5])).equals(1)
    expect(compareScores([0, 0, 0.1, 0, 0, 0], [0, 0, 0, 9, 9, 9])).equals(1)
    expect(compareScores([0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 9, 9])).equals(1)
    expect(compareScores([0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 9])).equals(1)
    expect(compareScores([0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 2])).equals(-1)
  })

  it('treats rounding noise as a tie and follows another order', () => {
    expect(compareScores([0, 0, 1e-12, 0, 0, 0], [0, 0, 0, 0, 0, 0])).equals(0)
    const weekdayLast = [
      UNPLACED,
      DOUBLEHEADERS,
      TIME_OF_DAY,
      SPACING,
      SCARCITY,
      WEEKDAY
    ]
    expect(
      compareScores([0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 1, 0], weekdayLast)
    ).equals(1)
    expect(compareScores([0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 1, 0])).equals(-1)
  })

  it('adds scores term by term', () => {
    expect(addScores([1, 2, 3], [4, 5, 6])).deep.equals([5, 7, 9])
  })
})

describe('mixDeviation', () => {
  it('sums how far each share strays from the field time’s share', () => {
    expect(mixDeviation([1, 1, 2], 4, [1, 1, 2], 4)).equals(0)
    expect(mixDeviation([0, 0, 4], 4, [1, 1, 2], 4)).closeTo(1, 1e-12)
    expect(mixDeviation([0, 0, 0], 0, [1, 1, 2], 4)).equals(0)
    expect(mixDeviation([1, 0, 0], 1, [0, 0, 0], 0)).equals(0)
  })
})

describe('TeamTally', () => {
  it('counts games beyond the first on a day as doubleheaders', () => {
    const tally = new TeamTally(10, 0, 100)
    tally.add(point(5))
    tally.add(point(5))
    tally.add(point(5))
    tally.add(point(9))
    expect(tally.doubleheaders).equals(2)
    tally.remove(point(5))
    expect(tally.doubleheaders).equals(1)
    tally.remove(point(9))
    expect(tally.days).deep.equals([5, 5])
    expect(tally.games).equals(2)
  })

  it('scores back-to-back days and games bunched in part of the season', () => {
    // Sixty days in five slices of twelve.
    const tally = new TeamTally(5, 0, 59)
    for (const day of [10, 11, 12, 30, 50]) tally.add(point(day))
    expect(tally.backToBack()).equals(3)
    expect(tally.gaps()).deep.equals([10, 1, 1, 18, 20, 9])
    // Two games in the first slice and none in the fourth.
    expect(tally.unevenness()).equals(2)
    expect(tally.spacing()).equals(5)

    const early = new TeamTally(5, 0, 59)
    for (const day of [0, 2, 4, 6, 8]) early.add(point(day))
    expect(early.spacing()).equals(8)
    const even = new TeamTally(5, 0, 59)
    for (const day of [6, 18, 30, 42, 54]) even.add(point(day))
    expect(even.spacing()).equals(0)
    // A doubleheader day next to another counts each of its games.
    tally.add(point(11))
    expect(tally.backToBack()).equals(4)
  })

  it('leaves out games before the open days and edge gaps that do not exist', () => {
    const tally = new TeamTally(2, 10, 29)
    expect(tally.gaps()).deep.equals([])
    expect(tally.spacing()).equals(2)
    // A game already played before the season's open days doesn't count.
    tally.add(point(3))
    tally.add(point(9))
    tally.add(point(15))
    tally.add(point(29))
    expect(tally.spanDays()).deep.equals([15, 29])
    expect(tally.gaps()).deep.equals([5, 14])
    expect(tally.spacing()).equals(0)
    const none = new TeamTally(0, 0, 10)
    expect(none.spacing()).equals(0)
    none.add(point(4))
    expect(none.unevenness()).equals(1)
  })

  it('caches its terms until a game changes', () => {
    const supply = {
      games: 4,
      timeOfDay: [2, 2, 0],
      weekdays: [0, 0, 0, 0, 0, 0, 4]
    }
    const tally = new TeamTally(2, 0, 19)
    tally.add(point(6, MORNING, 1))
    const first = tally.terms(supply)
    expect(first).deep.equals([0, 1, 1, 2])
    expect(tally.terms(supply)).equals(first)
    tally.add(point(13, AFTERNOON, 6))
    expect(tally.terms(supply)).deep.equals([0, 0, 0, 1])
  })
})

describe('SeasonLedger', () => {
  const context = buildContext(
    input({
      seasons: [season({ endsOn: '2027-03-31' })],
      fixed: [fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-06T14:00:00Z')]
    })
  )
  const [demo] = context.seasons
  const planned = new Map(demo.teams.map(team => [team, 3]))

  it('counts fixed games from the start and unplaced games first', () => {
    const ledger = new SeasonLedger(demo, 2, planned)
    expect(ledger.tallies.get('tem_hawks')?.games).equals(1)
    expect(ledger.score()[UNPLACED]).equals(2)
    const saturday = demo.slots.find(
      slot => slot.date === '2027-03-06' && slot.timeOfDay === AFTERNOON
    )
    if (saturday == null) throw new Error('no slot')
    ledger.add('tem_hawks', 'tem_bears', saturday, 2)
    const score = ledger.score()
    expect(score[UNPLACED]).equals(1)
    expect(score[DOUBLEHEADERS]).equals(1)
    expect(score[SCARCITY]).equals(2)
    ledger.remove('tem_hawks', 'tem_bears', saturday, 2)
    expect(ledger.score()).deep.equals(
      new SeasonLedger(demo, 2, planned).score()
    )
  })

  it('counts doubleheaders only where they are a last resort', () => {
    const allowed = buildContext(
      input({
        seasons: [season({ endsOn: '2027-03-31', doubleheaders: 'allowed' })],
        fixed: [
          fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-06T14:00:00Z'),
          fixedGame('g2', 'tem_hawks', 'tem_owls', '2027-03-06T18:00:00Z')
        ]
      })
    ).seasons[0]
    const ledger = new SeasonLedger(allowed, 0, planned)
    expect(ledger.tallies.get('tem_hawks')?.doubleheaders).equals(1)
    expect(ledger.score()[DOUBLEHEADERS]).equals(0)
  })

  it('ignores fixed games of teams outside the season', () => {
    const outside = buildContext(
      input({
        fixed: [
          fixedGame('g1', 'tem_hawks', 'tem_outside', '2027-03-06T14:00:00Z')
        ]
      })
    ).seasons[0]
    const ledger = new SeasonLedger(outside, 0, new Map())
    expect(ledger.tallies.has('tem_outside')).equals(false)
    expect(ledger.tallies.get('tem_hawks')?.games).equals(1)
  })
})
