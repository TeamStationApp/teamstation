import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import { buildContext, type RunContext } from './context'
import { field, fixedGame, input, present, season, ZONE } from './fixtures.test'
import { buildOptions } from './index'
import type { Matchup } from './matchups'
import {
  chooseOptions,
  differentShare,
  fairnessRows,
  optionReasons,
  plannedGames,
  WEIGHTINGS
} from './options'
import type { Placement } from './placement'
import { SeasonLedger, TRUE_ORDER } from './score'
import type { EngineInput } from './types'

/** A schedule placed by hand: each game's teams and its slot's date and time. */
function manual(
  context: RunContext,
  games: Array<[string, string, string, string] | [string, string, null, null]>
): Placement {
  const [demo] = context.seasons
  const matchups: Matchup[] = games.map(([home, away], i) => ({
    key: `sea_demo:${home}:${away}:${i + 1}`,
    seasonId: 'sea_demo',
    homeTeamId: home,
    awayTeamId: away,
    exhibition: false
  }))
  const slots = games.map(([, , date, time]) =>
    date == null || time == null
      ? null
      : present(
          demo.slots.find(slot => slot.start === wallInstant(date, time, ZONE))
        )
  )
  const planned = new Map<string, number>()
  for (const { homeTeamId, awayTeamId } of matchups)
    for (const team of [homeTeamId, awayTeamId])
      planned.set(team, (planned.get(team) ?? 0) + 1)
  const ledger = new SeasonLedger(demo, games.length, planned)
  matchups.forEach((matchup, i) => {
    const slot = slots[i]
    if (slot != null)
      ledger.add(matchup.homeTeamId, matchup.awayTeamId, slot, slot.scarcity)
  })
  return {
    matchups,
    slots,
    score: ledger.score(),
    ledgers: new Map([['sea_demo', ledger]])
  }
}

const context = buildContext(input())

describe('chooseOptions', () => {
  it('builds three options from E7’s run, each at least 25% different', () => {
    const { options, blocking } = buildOptions(input())
    expect(blocking).equals(null)
    expect(options).length(3)
    const slotsOf = (index: number): string[] =>
      options[index].games.map(game => `${game.fieldId}|${game.startAt}`)
    for (let later = 1; later < 3; later++)
      for (let earlier = 0; earlier < later; earlier++) {
        const theirs = new Set(slotsOf(earlier))
        const mine = slotsOf(later)
        const different = mine.filter(key => !theirs.has(key)).length
        expect(different / mine.length).at.least(0.25)
      }
    expect(options[0].reasons).deep.equals([])
    expect(options[1].reasons.length).greaterThan(0)
    for (const option of options) {
      expect(option.games).length(21)
      expect(option.unmet).deep.equals([])
    }
  }).timeout(30_000)

  it('offers fewer options when the space is small', () => {
    // One Saturday with room for a single game.
    const { options } = buildOptions(
      input({
        seasons: [
          season(
            { endsOn: '2027-03-06', regularGames: 2, exhibitionGames: 0 },
            { participants: ['tem_hawks', 'tem_owls'], exhibitionTeams: [] }
          )
        ],
        fields: [
          field({
            availability: {
              ...field().availability,
              startsOn: '2027-03-06',
              endsOn: '2027-03-06'
            }
          })
        ]
      })
    )
    expect(options.length).lessThan(3)
    const one = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-06', '08:00']
    ])
    expect(chooseOptions([one, one, one])).deep.equals([one])
    expect(chooseOptions([])).deep.equals([])
  }).timeout(30_000)

  it('ranks by the true ranking and never offers one with more games unplaced', () => {
    const best = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-06', '08:00'],
      ['tem_bears', 'tem_foxes', '2027-03-13', '08:00']
    ])
    const short = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-20', '08:00'],
      ['tem_bears', 'tem_foxes', null, null]
    ])
    expect(chooseOptions([short, best])).deep.equals([best])
    expect(differentShare(short, best)).equals(1)
    expect(differentShare(manual(context, []), best)).equals(0)
    expect(WEIGHTINGS[0]).equals(TRUE_ORDER)
  }).timeout(30_000)
})

describe('optionReasons', () => {
  // Spread over the season: a Monday evening, a Saturday morning in May and
  // a Tuesday evening in July.
  const best = manual(context, [
    ['tem_hawks', 'tem_owls', '2027-03-01', '17:30'],
    ['tem_owls', 'tem_hawks', '2027-05-15', '08:00'],
    ['tem_hawks', 'tem_owls', '2027-07-06', '18:00']
  ])

  it('names extra doubleheaders', () => {
    const option = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-13', '08:00'],
      ['tem_owls', 'tem_hawks', '2027-03-13', '13:00'],
      ['tem_hawks', 'tem_owls', '2027-07-06', '18:00']
    ])
    expect(optionReasons(context, option, best)[0]).equals(
      '2 more doubleheaders'
    )
  }).timeout(30_000)

  it('names the team and part of the day it leans to', () => {
    const option = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-01', '17:30'],
      ['tem_owls', 'tem_hawks', '2027-05-18', '18:00'],
      ['tem_hawks', 'tem_owls', '2027-07-06', '18:00']
    ])
    expect(optionReasons(context, option, best)[0]).equals(
      'Demo Hawks plays 3 of its 3 games in the evening'
    )
  }).timeout(30_000)

  it('names the team and weekday it leans to', () => {
    const mondays = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-01', '17:30'],
      ['tem_owls', 'tem_hawks', '2027-05-15', '08:00'],
      ['tem_hawks', 'tem_owls', '2027-07-05', '18:00']
    ])
    expect(optionReasons(context, mondays, best)).deep.equals([
      'Demo Hawks plays 2 of its 3 games on Mondays'
    ])
  }).timeout(30_000)

  it('names back-to-back days and games bunched in part of the season', () => {
    const backToBack = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-12', '17:30'],
      ['tem_owls', 'tem_hawks', '2027-03-13', '08:00'],
      ['tem_hawks', 'tem_owls', '2027-07-06', '18:00']
    ])
    expect(optionReasons(context, backToBack, best)[0]).equals(
      'Demo Hawks has 2 games on back-to-back days'
    )
    const late = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-07-05', '18:00'],
      ['tem_owls', 'tem_hawks', '2027-07-17', '08:00'],
      ['tem_hawks', 'tem_owls', '2027-07-27', '18:00']
    ])
    expect(optionReasons(context, late, best)[0]).equals(
      'Demo Hawks goes 126 days without a game'
    )
  }).timeout(30_000)

  it('names unplaced games and fields other seasons need', () => {
    const short = manual(context, [
      ['tem_hawks', 'tem_owls', '2027-03-01', '17:30'],
      ['tem_owls', 'tem_hawks', '2027-05-15', '08:00'],
      ['tem_hawks', 'tem_owls', null, null]
    ])
    expect(optionReasons(context, short, best)[0]).equals(
      '1 more game left unplaced'
    )
    const scarce = { ...best, score: [...best.score] }
    scarce.score[5] += 2
    expect(optionReasons(context, scarce, best)).deep.equals([
      'more use of fields other seasons also need'
    ])
    const shared = buildContext(
      input({
        seasons: [season(), season({ fieldSize: '46/60' }, { id: 'sea_tball' })]
      })
    )
    const plain = manual(shared, [])
    const used = manual(shared, [
      ['tem_hawks', 'tem_owls', '2027-03-01', '17:30']
    ])
    expect(
      optionReasons(
        shared,
        { ...used, score: [0, 0, 0, 0, 0, 1] },
        { ...plain, score: [0, 0, 0, 0, 0, 0] }
      )
    ).deep.equals(['1 more game on fields other seasons also need'])
  }).timeout(30_000)

  it('says so when an option ties Option 1', () => {
    expect(optionReasons(context, best, best)).deep.equals([
      'Just as balanced as Option 1, at other dates and times'
    ])
  }).timeout(30_000)
})

describe('fairnessRows and plannedGames', () => {
  it('sums each team’s games, fixed ones included', () => {
    const run: EngineInput = input({
      fixed: [
        fixedGame(
          'g1',
          'tem_hawks',
          'tem_otters',
          '2027-03-20T14:00:00.000Z',
          90,
          {
            exhibition: true
          }
        ),
        // Played last October, before the season's dates.
        fixedGame('g0', 'tem_hawks', 'tem_elks', '2026-10-10T15:00:00.000Z')
      ]
    })
    const withFixed = buildContext(run)
    const placement = manual(withFixed, [
      ['tem_owls', 'tem_hawks', '2027-03-13', '08:00'],
      ['tem_hawks', 'tem_owls', '2027-03-13', '13:00'],
      ['tem_hawks', 'tem_owls', '2027-03-01', '17:30']
    ])
    const rows = fairnessRows(withFixed, placement)
    expect(rows).length(9)
    expect(rows.find(row => row.teamId === 'tem_hawks')).deep.equals({
      teamId: 'tem_hawks',
      seasonId: 'sea_demo',
      exhibitionTeam: false,
      regularGames: 4,
      exhibitionGames: 1,
      mornings: 3,
      afternoons: 1,
      evenings: 1,
      weekdays: [0, 1, 0, 0, 0, 0, 4],
      // Last October's game counts, but not toward the gaps.
      shortestGapDays: 0,
      longestGapDays: 12,
      doubleheaders: 1
    })
    const otters = rows.find(row => row.teamId === 'tem_otters')
    expect(otters?.exhibitionTeam).equals(true)
    expect(rows.find(row => row.teamId === 'tem_elks')).include({
      shortestGapDays: null,
      longestGapDays: null,
      regularGames: 1
    })
    expect(rows.find(row => row.teamId === 'tem_bears')).include({
      shortestGapDays: null,
      regularGames: 0
    })

    const games = plannedGames(placement)
    expect(games.map(game => game.startAt)).deep.equals([
      '2027-03-01T23:30:00.000Z',
      '2027-03-13T14:00:00.000Z',
      '2027-03-13T19:00:00.000Z'
    ])
    expect(games[0]).deep.equals({
      key: 'sea_demo:tem_hawks:tem_owls:3',
      seasonId: 'sea_demo',
      homeTeamId: 'tem_hawks',
      awayTeamId: 'tem_owls',
      exhibition: false,
      fieldId: 'fld_one',
      size: '50/70',
      startAt: '2027-03-01T23:30:00.000Z',
      endAt: '2027-03-02T01:00:00.000Z'
    })
  }).timeout(30_000)
})
