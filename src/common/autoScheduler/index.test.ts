// The interface holds only types; loading it shows it compiles to nothing.
import './types'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gameCalendarDay } from '../gameTime'
import {
  EXHIBITION_TEAMS,
  fixedGame,
  input,
  PARTICIPANTS,
  saturdaysInput,
  season,
  ZONE
} from './fixtures.test'
import { buildOptions } from './index'
import type { EngineInput, EngineResult, PlannedGame } from './types'

const MINUTE = 60_000

/** Runs the engine and says how long it took. */
function timed(name: string, run: EngineInput): EngineResult {
  const started = performance.now()
  const result = buildOptions(run)
  const seconds = (performance.now() - started) / 1000
  console.log(`      ${name}: ${seconds.toFixed(2)} s`)
  expect(seconds).lessThan(25)
  return result
}

// E7: seasonA already holds G1 (10:00–12:00, 50/70) and E4's 12:00 game
// (46/60) on Field 1, kept by Work around.
const G1 = fixedGame(
  'g1',
  'tem_hawks',
  'tem_owls',
  '2027-04-10T15:00:00.000Z',
  120
)
const NOON = fixedGame(
  'g2',
  'tem_foxes',
  'tem_bears',
  '2027-04-10T17:00:00.000Z',
  120,
  {
    size: '46/60'
  }
)

function overlapsFixed(game: PlannedGame): boolean {
  const start = Date.parse(game.startAt)
  const end = Date.parse(game.endAt)
  return [G1, NOON].some(fixed => {
    const switching = fixed.size === game.size ? 0 : 30 * MINUTE
    const gap = 10 * MINUTE + switching
    const field = start < fixed.end + gap && fixed.start < end + gap
    const teams =
      [fixed.homeTeamId, fixed.awayTeamId].some(
        team => team === game.homeTeamId || team === game.awayTeamId
      ) &&
      start < fixed.end &&
      fixed.start < end
    return field || teams
  })
}

describe('buildOptions', () => {
  it('builds E7’s options: equal counts, the exhibition split, nothing over the fixed games', () => {
    const result = timed('E7', input({ fixed: [G1, NOON] }))
    expect(result.blocking).equals(null)
    expect(result.options).length(3)
    expect(result.options[1].reasons.length).greaterThan(0)
    for (const option of result.options) {
      expect(option.unmet).deep.equals([])
      expect(option.games.filter(overlapsFixed)).deep.equals([])
      for (const team of PARTICIPANTS) {
        const row = option.fairness.find(entry => entry.teamId === team)
        expect(row?.regularGames, team).equals(4)
        expect(row?.exhibitionGames, team).equals(1)
      }
      const split = EXHIBITION_TEAMS.map(
        team =>
          option.fairness.find(entry => entry.teamId === team)?.exhibitionGames
      )
      expect(split.sort((a, b) => (a ?? 0) - (b ?? 0))).deep.equals([3, 4])
      // Fixed games stay out of the new games, but count in the totals.
      expect(option.games).length(19)
      expect(option.score).length(6)
    }
  }).timeout(30_000)

  it('places no game on a day no window period covers', () => {
    const [spring, june] = season().settings.windows
    const { options } = buildOptions(
      input({
        seasons: [
          season({ windows: [{ ...spring, until: '2027-05-20' }, june] })
        ],
        fixed: [G1, NOON]
      })
    )
    expect(options.length).greaterThan(0)
    for (const option of options) {
      expect(option.games.length).greaterThan(0)
      const dates = option.games.map(game =>
        gameCalendarDay(game.startAt, ZONE)
      )
      expect(
        dates.filter(date => date >= '2027-05-21' && date <= '2027-05-31')
      ).deep.equals([])
    }
  }).timeout(30_000)

  it('spreads each team’s E7 games over the whole season', () => {
    const { options } = buildOptions(input({ fixed: [G1, NOON] }))
    const DAY = 86_400_000
    options.forEach((option, index) => {
      for (const team of [...PARTICIPANTS, ...EXHIBITION_TEAMS]) {
        const starts = [
          ...option.games
            .filter(
              game => game.homeTeamId === team || game.awayTeamId === team
            )
            .map(game => Date.parse(game.startAt)),
          ...[G1, NOON]
            .filter(
              game => game.homeTeamId === team || game.awayTeamId === team
            )
            .map(game => game.start)
        ].sort((a, b) => a - b)
        const months = new Set(
          starts.map(start => new Date(start).toISOString().slice(0, 7))
        )
        // Five games reach into at least four months, four into three.
        expect(months.size, `Option ${index + 1}, ${team}`).at.least(
          Math.min(4, starts.length - 1)
        )
        // From the first game to the last is at least half the season.
        expect(
          (starts[starts.length - 1] - starts[0]) / DAY,
          `Option ${index + 1}, ${team}`
        ).at.least(76)
        for (const start of starts) {
          const within = starts.filter(
            other => other >= start && other < start + 14 * DAY
          ).length
          expect(within, `Option ${index + 1}, ${team}`).at.most(
            Math.max(1, Math.ceil(starts.length / 2))
          )
        }
      }
    })
  }).timeout(30_000)

  it('gives every team E10’s 30 Saturday games when they fit', () => {
    const result = timed('E10, 30 games', saturdaysInput(30))
    const [best] = result.options
    expect(best.unmet).deep.equals([])
    expect(best.games).length(112)
    for (const team of PARTICIPANTS)
      expect(
        best.fairness.find(row => row.teamId === team)?.regularGames
      ).equals(30)
  }).timeout(30_000)

  it('lowers E10 equally when the Saturdays can’t hold the games', () => {
    const result = timed('E10, 40 games', saturdaysInput(40))
    for (const option of result.options) {
      expect(option.unmet).deep.equals([
        {
          seasonId: 'sea_demo',
          message:
            'every team gets 34 of the 40 requested regular-season games',
          cause: 'not enough 50/70 field time to give every team 40 games'
        }
      ])
      for (const team of PARTICIPANTS)
        expect(
          option.fairness.find(row => row.teamId === team)?.regularGames
        ).equals(34)
    }
  }).timeout(30_000)

  it('gives the same result for the same input', () => {
    const run = input({ seasons: [season({ endsOn: '2027-04-30' })] })
    expect(buildOptions(run)).deep.equals(buildOptions(run))
  }).timeout(30_000)

  it('gives new games only to the teams of a partial run', () => {
    const { options } = buildOptions(
      input({
        teamIds: ['tem_hawks', 'tem_owls'],
        seasons: [
          season({ endsOn: '2027-04-30', regularGames: 2, exhibitionGames: 0 })
        ],
        fixed: [
          fixedGame('g1', 'tem_hawks', 'tem_bears', '2027-03-06T15:00:00.000Z')
        ]
      })
    )
    for (const option of options)
      for (const game of option.games) {
        expect(['tem_hawks', 'tem_owls']).include(game.homeTeamId)
        expect(['tem_hawks', 'tem_owls']).include(game.awayTeamId)
      }
    expect(options[0].games).length(1)
  }).timeout(30_000)

  it('schedules several seasons around each other on a shared field', () => {
    const { options } = buildOptions(
      input({
        seasons: [
          season(
            { endsOn: '2027-04-30', exhibitionGames: 0 },
            { participants: PARTICIPANTS.slice(0, 4), exhibitionTeams: [] }
          ),
          season(
            {
              endsOn: '2027-04-30',
              exhibitionGames: 0,
              fieldSize: '46/60',
              gameMinutes: 60
            },
            {
              id: 'sea_tball',
              participants: ['tem_t1', 'tem_t2', 'tem_t3', 'tem_t4'],
              exhibitionTeams: []
            }
          )
        ]
      })
    )
    const [best] = options
    expect(best.games.filter(game => game.seasonId === 'sea_tball')).length(8)
    expect(best.games.filter(game => game.seasonId === 'sea_demo')).length(8)
    const sorted = [...best.games].sort((a, b) =>
      a.startAt.localeCompare(b.startAt)
    )
    for (let i = 1; i < sorted.length; i++) {
      const before = sorted[i - 1]
      const after = sorted[i]
      const gap = Date.parse(after.startAt) - Date.parse(before.endAt)
      const needed =
        10 * MINUTE + (before.size === after.size ? 0 : 30 * MINUTE)
      expect(gap).at.least(needed)
    }
  }).timeout(30_000)
})
