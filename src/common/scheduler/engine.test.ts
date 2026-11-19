import { expect } from 'chai'
import { describe, it } from 'mocha'

import { packedLeagueRun, teamId } from '../../test/packedLeagueRun'
import {
  causeLine,
  DOUBLEHEADERS_CAUSE,
  TIME_LIMIT_CAUSE,
  WEEK_PARTS_CAUSE
} from '../autoScheduler/capacity'
import { buildContext } from '../autoScheduler/context'
import {
  EXHIBITION_TEAMS,
  FIELD,
  field,
  fixedGame,
  hoursOn,
  input,
  PARTICIPANTS,
  saturdaysInput,
  SEASON,
  season,
  ZONE
} from '../autoScheduler/fixtures.test'
import type {
  EngineBooking,
  EngineInput,
  PlannedGame
} from '../autoScheduler/types'
import { wallInstant } from '../fieldAvailability'
import { gameCalendarDay } from '../gameTime'
import { gameWeekPart } from '../gameWeekPart'
import {
  type Addon,
  addonPath,
  buildSchedule,
  CANCELED,
  type EngineBuild,
  type EngineDecision,
  type EngineEvent,
  EngineFailureError,
  type EngineLimit,
  failure,
  loadAddon,
  offsetAt,
  readEvent,
  readResult,
  reasonLine,
  wireRequest,
  zoneOffsets
} from './engine'
import {
  build,
  type Built,
  check,
  firstSaturday,
  four,
  packedSeason,
  replay,
  shared,
  sized,
  small,
  target,
  three,
  two,
  twoSaturdays,
  twoSeasonsOneTeam,
  twoSizes
} from './engineFixtures.test'

// The TypeScript engine's suites (exact, index, required, weekParts, options
// and capacity), run through the C++ engine's Node addon. Expectations the
// exact path produced are kept; cases the search ran are kept wherever they
// assert a property of any valid schedule, and a count only the search
// reached is re-baselined to the exact value (each is marked so).

const MINUTE = 60_000
const DAY = 86_400_000

const managerLine = (team: string): string =>
  `${input().teamNames[team] ?? team}’s Manager/Head Coach is booked during otherwise available game times`

const regularOf = (option: Built['options'][number], team: string): number =>
  option.fairness.find(row => row.teamId === team)?.regularGames ?? -1

describe('the C++ engine: the exact settlement', function () {
  this.timeout(120_000)

  it('settles required matchups and exhibition games exactly too', async function () {
    const required = await build(
      small(
        four,
        {},
        {
          required: [
            {
              key: 'r1',
              seasonId: SEASON,
              homeTeamId: four[0],
              awayTeamId: four[1],
              exhibition: false
            }
          ]
        }
      )
    )
    expect(required.options[0].games.map(game => game.key)).deep.equals(['r1'])
    const exhibition = await build(input())
    expect(exhibition.targets).deep.equals([
      { seasonId: SEASON, regular: 4, exhibition: 1 }
    ])
    const empty = await build(small(four, {}, { seasons: [] }))
    expect(empty.options).length(1)
    expect(empty.options[0].games).deep.equals([])
  })

  it('gives every team its need, every game fitting the hard rules', async function () {
    const run = small(four)
    const result = await build(run)
    expect(target(result, SEASON)).equals(2)
    const { teams } = check(run, result)
    for (const team of four) expect(teams.get(team)).equals(2)
    expect(result.options[0].unmet).deep.equals([])
  })

  it('keys matchups as buildMatchups does and balances hosting', async function () {
    const result = await build(small(four, { regularGames: 3 }))
    const hosted = new Map<string, number>()
    for (const game of result.options[0].games) {
      expect(game.key).matches(
        new RegExp(`^${SEASON}:${game.homeTeamId}:${game.awayTeamId}:\\d+$`)
      )
      expect(game.exhibition).equals(false)
      hosted.set(game.homeTeamId, (hosted.get(game.homeTeamId) ?? 0) + 1)
    }
    for (const team of four)
      expect(Math.abs(2 * (hosted.get(team) ?? 0) - 3)).lessThanOrEqual(1)
  })

  it('keeps pairs within the cap regularPairs allows', async function () {
    const run = small(three, { regularGames: 4 })
    const { teams, pairs } = check(run, await build(run))
    for (const team of three) expect(teams.get(team)).equals(4)
    for (const count of pairs.values()) expect(count).lessThanOrEqual(2)
  })

  it('follows lowerTargets on parity', async function () {
    const odd = await build(small(three, { regularGames: 1 }))
    expect(target(odd, SEASON)).equals(1)
    expect(odd.options[0].games).lengthOf(1)
    const lowered = await build(
      small(three, {
        regularGames: 2,
        windows: [
          {
            from: '2027-03-06',
            until: '2027-03-13',
            hours: hoursOn([6], '08:00', '09:30')
          }
        ]
      })
    )
    expect(target(lowered, SEASON)).equals(0)
    const partial = await build(
      small(three, { regularGames: 1 }, { teamIds: three.slice(0, 2) })
    )
    expect(target(partial, SEASON)).equals(1)
    expect(partial.options[0].games).lengthOf(1)
  })

  it('keeps the later game’s buffer and the switch time on a shared field', async function () {
    const run = twoSizes()
    const result = await build(run)
    check(run, result)
    expect(result.options[0].games).lengthOf(2)
  })

  it('counts fixed games toward needs and the weekly maximums', async function () {
    const run = small(
      four,
      { maxGamesOnWeekend: 1, maxGamesOnWeekdays: 0 },
      {
        fixed: [
          fixedGame('f1', four[0], four[1], '2027-03-06T14:00:00.000Z', 90)
        ]
      }
    )
    const { teams } = check(run, await build(run))
    expect(teams.get(four[0])).equals(1)
    expect(teams.get(four[1])).equals(1)
    expect(teams.get(four[2])).equals(2)
  })

  it('honours weeklyGames and bookings, and a managerOnly booking only for the manager', async function () {
    const run = small(
      four,
      { maxGamesOnWeekend: 1, maxGamesOnWeekdays: 0 },
      {
        headCoaches: { [four[0]]: 'coach:one', tem_outside: 'coach:one' },
        weeklyGames: [
          {
            seasonId: SEASON,
            fieldId: FIELD,
            teamIds: [four[2], four[3]],
            start: Date.parse('2027-03-13T14:00:00.000Z')
          }
        ],
        bookings: [
          {
            key: 'b1',
            fieldId: null,
            size: null,
            teamIds: ['tem_outside'],
            managerOnly: true,
            start: Date.parse('2027-03-20T13:00:00.000Z'),
            end: Date.parse('2027-03-20T23:00:00.000Z')
          }
        ]
      }
    )
    const result = await build(run)
    check(run, result)
    for (const game of result.options[0].games) {
      const date = gameCalendarDay(game.startAt, ZONE)
      if (date === '2027-03-13')
        expect([game.homeTeamId, game.awayTeamId]).not.include(four[2])
      if (date === '2027-03-20')
        expect([game.homeTeamId, game.awayTeamId]).not.include(four[0])
    }
  })

  it('names the weekly maximums when only they hold a count down', async function () {
    const everyDay = hoursOn([0, 1, 2, 3, 4, 5, 6], '08:00', '18:00')
    const run = small(
      four,
      {
        regularGames: 4,
        maxGamesOnWeekdays: 0,
        maxGamesOnWeekend: 1,
        startsOn: '2027-03-06',
        endsOn: '2027-03-21',
        windows: [{ from: '2027-03-06', until: '2027-03-21', hours: everyDay }]
      },
      {
        fields: [
          field({ availability: { ...field().availability, hours: everyDay } })
        ]
      }
    )
    const result = await build(run)
    expect(target(result, SEASON)).equals(3)
    expect(result.options[0].unmet[0].cause).equals(WEEK_PARTS_CAUSE)
    expect(result.causes[0][0]).include({ rule: 'weekParts', kind: 'regular' })
  })

  it('names the doubleheader rule when only it holds a count down', async function () {
    const result = await build(
      small(four, {
        regularGames: 4,
        doubleheaders: 'never',
        startsOn: '2027-03-06',
        endsOn: '2027-03-13',
        windows: [
          {
            from: '2027-03-06',
            until: '2027-03-13',
            hours: hoursOn([6], '08:00', '18:00')
          }
        ]
      })
    )
    expect(target(result, SEASON)).equals(2)
    expect(result.options[0].unmet[0].cause).equals(DOUBLEHEADERS_CAUSE)
  })

  it('names the team whose manager is busy elsewhere', async function () {
    const run = twoSaturdays({
      headCoaches: { [two[0]]: 'coach:one', tem_outside: 'coach:one' },
      bookings: [firstSaturday(['tem_outside'])]
    })
    const result = await build(run)
    expect(target(result, SEASON)).equals(1)
    expect(result.options[0].unmet[0].cause).equals(managerLine(two[0]))
    expect(result.causes[0][0]).include({
      rule: 'manager',
      teamId: two[0],
      managerId: 'coach:one'
    })
  })

  it('gives a team whose fixed games already pass its request no new game', async function () {
    const run = small(
      four,
      { regularGames: 2 },
      {
        fixed: [1, 2, 3].map(day =>
          fixedGame(
            `fixed${day}`,
            four[0],
            four[1],
            `2027-02-0${day}T15:00:00.000Z`
          )
        )
      }
    )
    const result = await build(run)
    expect(target(result, SEASON)).equals(2)
    const { teams } = check(run, result)
    expect(teams.get(four[0])).equals(undefined)
    expect(teams.get(four[1])).equals(undefined)
    expect(teams.get(four[2])).equals(2)
    expect(teams.get(four[3])).equals(2)
  })

  it('names a manager held by their own booking, though they coach one team', async function () {
    const result = await build(
      twoSaturdays({
        headCoaches: { [two[1]]: 'coach:one' },
        bookings: [firstSaturday([two[1]], true)]
      })
    )
    expect(target(result, SEASON)).equals(1)
    expect(result.options[0].unmet[0].cause).equals(managerLine(two[1]))
  })

  it('names the team whose manager is held, not the first managed team by name', async function () {
    const result = await build(
      twoSaturdays({
        headCoaches: {
          [two[0]]: 'coach:hawks',
          [two[1]]: 'coach:owls',
          tem_outside: 'coach:owls'
        },
        bookings: [firstSaturday(['tem_outside'])]
      })
    )
    expect(result.options[0].unmet[0].cause).equals(managerLine(two[1]))
  })

  it('leaves the cause to today’s line when the teams’ own bookings hold them, not the fields', async function () {
    const run = twoSaturdays({ bookings: [firstSaturday([two[0]])] }, [
      '08:00',
      '09:30'
    ])
    const result = await build(run)
    expect(target(result, SEASON)).equals(1)
    const [line] = result.options[0].unmet
    expect(line.cause).not.matches(/field time/)
    expect(result.causes[0][0].rule).equals('teamOpenDates')
  })

  it('settles the packed league exactly, with the causes that really bind', async function () {
    const run = packedLeagueRun()
    const started = Date.now()
    const result = await build(run)
    console.log(
      `      packed league: ${((Date.now() - started) / 1000).toFixed(1)} s`
    )
    expect(
      Object.fromEntries(
        run.seasons.map(each => [each.name, target(result, each.id)])
      )
    ).deep.equals({ S1: 10, S2: 10, S3: 12, S4: 14, S5: 16, S6: 16 })
    const [best] = result.options
    const { teams } = check(run, result)
    for (const each of run.seasons)
      for (const team of each.participants)
        expect(teams.get(team), team).equals(target(result, each.id))
    expect(replay(run, best.games).violations).deep.equals([])
    expect(best.unmet.map(line => [line.message, line.cause])).deep.equals([
      [
        'every team gets 16 of the 18 requested regular-season games',
        'not enough 46/60 field time to give every team 18 games'
      ],
      [
        'every team gets 16 of the 18 requested regular-season games',
        WEEK_PARTS_CAUSE
      ]
    ])
    // The shared managers never overlap.
    expect(teams.get(teamId(0, 3))).equals(10)
  })

  it('is deterministic: the same request twice gives the same options', async function () {
    const run = small(four, { regularGames: 3 })
    expect(await build(run)).deep.equals(await build(run))
    const e7 = input({ seasons: [season({ endsOn: '2027-04-30' })] })
    expect(await build(e7)).deep.equals(await build(e7))
  })

  it('answers a model over the column limit with a typed failure, and a limit of nothing with the time limit', async function () {
    const run = small(four)
    expect(await buildSchedule({ input: run, maxColumns: 1 })).deep.include({
      kind: 'failure',
      failure: 'broken',
      columns: 144,
      limit: 1
    })
    // At its limit a build pauses, and without an answer takes its best;
    // with none yet, it waits one more limit for the first, and a limit of
    // nothing waits for nothing: the time limit's failure.
    const late = await buildSchedule({ input: run, limitMs: 0 })
    expect(late).include({
      kind: 'failure',
      failure: 'broken',
      message: 'The targets solve ran out of time'
    })
    expect(
      (
        await buildSchedule(
          { input: run, limitMs: 0 },
          {
            onLimit: async limit =>
              limit.bestGames == null ? 'continue' : 'use'
          }
        )
      ).kind
    ).equals('options')
  })

  it('never gives a team in two seasons two games at once', async function () {
    const run = twoSeasonsOneTeam()
    const { teams } = check(run, await build(run))
    expect(teams.get(PARTICIPANTS[0])).equals(2)
  })
})

describe('the C++ engine: the exact settlement at size', function () {
  this.timeout(120_000)

  it('settles even and odd asks as lowerTargets does', async function () {
    const counts = async (run: EngineInput): Promise<number[]> => {
      const { teams } = check(run, await build(run))
      return [...teams.values()].sort((a, b) => a - b)
    }
    expect(await counts(sized(8, 17, 20))).deep.equals(Array(8).fill(17))
    expect(await counts(sized(9, 16, 20))).deep.equals(Array(9).fill(16))
    expect(await counts(sized(9, 17, 20))).deep.equals([
      16,
      ...Array(8).fill(17)
    ])
    const result = await build(sized(9, 18, 13))
    expect(target(result, SEASON)).equals(16)
    expect(result.options[0].games).lengthOf(72)
  })

  it('lets a partial run’s active teams meet as often as their need', async function () {
    const run = packedSeason('S6')
    const active = [1, 2, 3, 4].map(t => teamId(5, t))
    const partial = { ...run, teamIds: active }
    const result = await build(partial)
    expect(target(result, 'sea_s6')).equals(18)
    const { teams, pairs } = check(partial, result)
    expect([...teams.keys()].sort()).deep.equals([...active].sort())
    for (const team of active) expect(teams.get(team), team).equals(18)
    expect([...pairs.values()]).deep.equals(Array(6).fill(6))
  })

  it('raises a season held by its weekly maximums once they are lifted', async function () {
    const capped = await build(packedSeason('S6'))
    expect(target(capped, 'sea_s6')).equals(16)
    expect(capped.options[0].unmet[0].cause).equals(WEEK_PARTS_CAUSE)
    const lifted = await build(packedSeason('S6', { maxGamesOnWeekdays: 2 }))
    expect(target(lifted, 'sea_s6')).equals(18)
  })
})

describe('the C++ engine: the exact settlement on a shared field', function () {
  this.timeout(120_000)

  it('names field time, not a shared head coach, when the field is full', async function () {
    const run = shared(
      {
        teams: PARTICIPANTS.slice(0, 3),
        asked: 2,
        changes: { bufferMinutes: 0 }
      },
      {
        teams: PARTICIPANTS.slice(3, 6),
        asked: 4,
        changes: { bufferMinutes: 0 }
      },
      ['08:00', '11:00']
    )
    run.headCoaches = {
      [PARTICIPANTS[0]]: 'coach:shared',
      [PARTICIPANTS[3]]: 'coach:shared'
    }
    const result = await build(run)
    const short = run.seasons.filter(
      each => (target(result, each.id) ?? 0) < each.settings.regularGames
    )
    expect(short).lengthOf(1)
    const line = result.options[0].unmet.find(
      each => each.seasonId === short[0].id
    )
    expect(line?.cause).matches(/^not enough 50\/70 field time/)
  })

  it('reaches the exact count when two strides share the field', async function () {
    const run = shared(
      {
        teams: PARTICIPANTS.slice(0, 4),
        asked: 6,
        changes: { fieldSize: '46/60', gameMinutes: 60, bufferMinutes: 15 }
      },
      {
        teams: PARTICIPANTS.slice(4, 7).concat('tem_otters'),
        asked: 6,
        changes: { fieldSize: '50/70', gameMinutes: 90, bufferMinutes: 30 }
      },
      ['08:00', '18:00']
    )
    const result = await build(run)
    check(run, result)
    // Re-baselined: the search placed at least this many; the exact count
    // is every game asked for.
    expect(result.options[0].games).lengthOf(24)
  })

  it('blocks a booked-out field before any solve', async function () {
    const run = {
      ...small(four),
      bookings: [
        {
          key: 'b1',
          fieldId: FIELD,
          size: null,
          teamIds: [],
          start: Date.parse('2027-02-01T00:00:00.000Z'),
          end: Date.parse('2027-04-30T00:00:00.000Z')
        }
      ]
    }
    const result = await build(run)
    expect(result.options).deep.equals([])
    expect(result.blocking).equals(
      'not enough 50/70 field time to give every team 2 games'
    )
    expect(result.blockingCause).include({ rule: 'capacity', kind: 'regular' })
  })
})

// ------------------------------------------------------------ index.test.ts

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
    const onField = start < fixed.end + gap && fixed.start < end + gap
    const teams =
      [fixed.homeTeamId, fixed.awayTeamId].some(
        team => team === game.homeTeamId || team === game.awayTeamId
      ) &&
      start < fixed.end &&
      fixed.start < end
    return onField || teams
  })
}

describe('the C++ engine: building options', function () {
  this.timeout(120_000)

  it('builds E7’s options: equal counts, the exhibition split, nothing over the fixed games', async function () {
    const run = input({ fixed: [G1, NOON] })
    const result = await build(run)
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
      expect(option.games).length(19)
      expect(option.score).length(7)
      expect(replay(run, option.games).violations).deep.equals([])
    }
  })

  it('places no game on a day no window period covers', async function () {
    const [spring, june] = season().settings.windows
    const { options } = await build(
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
  })

  it('spreads each team’s E7 games over the whole season', async function () {
    const { options } = await build(input({ fixed: [G1, NOON] }))
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
        expect(months.size, `Option ${index + 1}, ${team}`).at.least(
          Math.min(4, starts.length - 1)
        )
        expect(
          (starts[starts.length - 1] - starts[0]) / DAY,
          `Option ${index + 1}, ${team}`
        ).at.least(index === 0 ? 76 : 63)
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
  })

  it('gives every team E10’s 30 Saturday games when they fit, with 0 violations', async function () {
    const run = saturdaysInput(30)
    const result = await build(run)
    const [best] = result.options
    expect(best.unmet).deep.equals([])
    expect(best.games).length(112)
    for (const team of PARTICIPANTS) expect(regularOf(best, team)).equals(30)
    expect(replay(run, best.games).violations).deep.equals([])
  })

  it('lowers E10 equally when the Saturdays can’t hold the games', async function () {
    const run = saturdaysInput(40)
    const result = await build(run)
    // Re-baselined: the search lowered regular games first and kept the
    // exhibition (34 and 1); the exact objective puts every regular game
    // above every exhibition, so 36 and none.
    for (const option of result.options) {
      expect(option.unmet).deep.equals([
        {
          seasonId: 'sea_demo',
          message:
            'every team gets 36 of the 40 requested regular-season games',
          cause: 'not enough 50/70 field time to give every team 40 games'
        },
        {
          seasonId: 'sea_demo',
          message: 'every team gets 0 of the 1 requested exhibition game',
          cause:
            'not enough 50/70 field time to give every team 1 exhibition game'
        }
      ])
      for (const team of PARTICIPANTS)
        expect(regularOf(option, team)).equals(36)
      expect(replay(run, option.games).violations).deep.equals([])
    }
  })

  it('gives new games only to the teams of a partial run', async function () {
    const { options } = await build(
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
  })

  it('schedules several seasons around each other on a shared field', async function () {
    const { options } = await build(
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
      expect(gap).at.least(
        10 * MINUTE + (before.size === after.size ? 0 : 30 * MINUTE)
      )
    }
  })

  it('returns a blocked run’s reason before any solve', async function () {
    const run = input({
      seasons: [
        season(
          { regularGames: 4, exhibitionGames: 0, windows: [] },
          { exhibitionTeams: [] }
        )
      ]
    })
    const result = await build(run, { limitMs: 0 })
    expect(result.options).deep.equals([])
    expect(result.blocking).equals(
      'not enough 50/70 field time to give every team 4 games'
    )
  })
})

// --------------------------------------------------------- required.test.ts

type Required = NonNullable<EngineInput['required']>[number]

function matchup(
  key: string,
  home: string,
  away: string,
  exhibition = false
): Required {
  return {
    key,
    seasonId: 'sea_demo',
    homeTeamId: home,
    awayTeamId: away,
    exhibition
  }
}

function marchApril(changes: Partial<EngineInput> = {}): EngineInput {
  return input({ seasons: [season({ endsOn: '2027-04-30' })], ...changes })
}

const HAWKS_AWAY: EngineBooking = {
  key: 'bkg_hawks',
  fieldId: null,
  size: null,
  teamIds: ['tem_hawks'],
  start: Date.parse('2027-02-01T00:00:00Z'),
  end: Date.parse('2027-08-01T00:00:00Z')
}

describe('the C++ engine: required matchups', function () {
  this.timeout(120_000)

  it('places a required matchup even when its teams’ counts are already met', async function () {
    const fixed = [
      fixedGame('g1', 'tem_hawks', 'tem_bears', '2027-03-06T15:00:00.000Z'),
      fixedGame('g2', 'tem_foxes', 'tem_hawks', '2027-03-13T15:00:00.000Z'),
      fixedGame('g3', 'tem_owls', 'tem_wolves', '2027-03-20T15:00:00.000Z'),
      fixedGame('g4', 'tem_lynx', 'tem_owls', '2027-03-27T15:00:00.000Z')
    ]
    const result = await build(
      marchApril({
        seasons: [
          season({ endsOn: '2027-04-30', regularGames: 2, exhibitionGames: 0 })
        ],
        fixed,
        required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
      })
    )
    expect(result.blocking).equals(null)
    const [best] = result.options
    expect(best.games).length(1)
    expect(best.games[0]).include({
      key: 'row_1',
      homeTeamId: 'tem_hawks',
      awayTeamId: 'tem_owls',
      exhibition: false
    })
    expect(best.unmet).deep.equals([])
    expect(regularOf(best, 'tem_hawks')).equals(3)
    expect(best.fairness).length(9)
  })

  it('gives the keys, home, away and game type back unchanged, whatever teamIds says', async function () {
    const required = [
      matchup('gam_a', 'tem_owls', 'tem_hawks'),
      matchup('gam_b', 'tem_bears', 'tem_foxes'),
      matchup('gam_c', 'tem_lynx', 'tem_otters', true)
    ]
    const run = marchApril({ required, teamIds: ['tem_elks'] })
    const { options } = await build(run)
    expect(options.length).greaterThan(0)
    for (const option of options) {
      const games = [...option.games].sort((a, b) => a.key.localeCompare(b.key))
      expect(
        games.map(game => [
          game.key,
          game.homeTeamId,
          game.awayTeamId,
          game.exhibition
        ])
      ).deep.equals(
        required.map(each => [
          each.key,
          each.homeTeamId,
          each.awayTeamId,
          each.exhibition
        ])
      )
      expect(option.unmet).deep.equals([])
      expect(replay(run, option.games).violations).deep.equals([])
    }
  })

  it('reports a required matchup it couldn’t place, with the team that blocks it', async function () {
    const { options, blocking } = await build(
      marchApril({
        bookings: [HAWKS_AWAY],
        required: [
          matchup('row_1', 'tem_hawks', 'tem_owls'),
          matchup('row_2', 'tem_bears', 'tem_foxes')
        ]
      })
    )
    expect(blocking).equals(null)
    for (const option of options) {
      expect(option.games.map(game => game.key)).deep.equals(['row_2'])
      expect(option.unmet).deep.equals([
        {
          seasonId: 'sea_demo',
          message: '1 of the 2 games to place again couldn’t be placed',
          cause: 'Demo Hawks’s existing games leave too few open dates'
        }
      ])
    }
  })

  it('reports matchups the field time can’t hold', async function () {
    const saturday = hoursOn([6], '08:00', '09:30')
    const result = await build(
      input({
        seasons: [
          season({
            endsOn: '2027-03-06',
            windows: [{ from: '2027-03-01', hours: saturday }]
          })
        ],
        fields: [
          field({ availability: { ...field().availability, hours: saturday } })
        ],
        required: [
          matchup('row_1', 'tem_hawks', 'tem_owls'),
          matchup('row_2', 'tem_bears', 'tem_foxes')
        ]
      })
    )
    expect(result.options).length(1)
    expect(result.options[0].games).length(1)
    expect(result.options[0].unmet).deep.equals([
      {
        seasonId: 'sea_demo',
        message: '1 of the 2 games to place again couldn’t be placed',
        cause: 'not enough 50/70 field time to place 2 games again'
      }
    ])
    expect(result.causes[0][0]).include({
      rule: 'requiredUnplaced',
      kind: 'required',
      requested: 2
    })
  })

  it('blocks when none of them can be placed', async function () {
    const busy = await build(
      marchApril({
        bookings: [HAWKS_AWAY],
        required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
      })
    )
    expect([busy.options, busy.blocking]).deep.equals([
      [],
      'Demo Hawks’s existing games leave too few open dates'
    ])
    const noField = await build(
      marchApril({
        fields: [field({ sizes: ['46/60'] })],
        required: [matchup('row_1', 'tem_hawks', 'tem_owls')]
      })
    )
    expect([noField.options, noField.blocking]).deep.equals([
      [],
      'not enough 50/70 field time to place 1 game again'
    ])
  })

  it('still offers options that differ, with reasons', async function () {
    const required = [
      matchup('row_1', 'tem_hawks', 'tem_owls'),
      matchup('row_2', 'tem_bears', 'tem_foxes'),
      matchup('row_3', 'tem_wolves', 'tem_lynx'),
      matchup('row_4', 'tem_elks', 'tem_hawks'),
      matchup('row_5', 'tem_owls', 'tem_bears'),
      matchup('row_6', 'tem_foxes', 'tem_otters', true)
    ]
    const { options } = await build(marchApril({ required }))
    expect(options).length(3)
    const slotsOf = (index: number): string[] =>
      options[index].games.map(game => `${game.fieldId}|${game.startAt}`)
    for (let later = 1; later < 3; later++) {
      expect(options[later].reasons.length).greaterThan(0)
      for (let earlier = 0; earlier < later; earlier++) {
        const theirs = new Set(slotsOf(earlier))
        const different = slotsOf(later).filter(key => !theirs.has(key)).length
        expect(different / required.length).at.least(0.25)
      }
    }
  })

  it('gives one empty option when there is nothing to place', async function () {
    const result = await build(marchApril({ required: [] }))
    expect(result.blocking).equals(null)
    expect(result.options).length(1)
    const [only] = result.options
    expect(only.games).deep.equals([])
    expect(only.unmet).deep.equals([])
    expect(only.reasons).deep.equals([])
    expect(only.fairness).length(9)
    expect(only.fairness.every(row => row.regularGames === 0)).equals(true)
  })

  it('ignores matchups of other seasons and places a team outside the season’s lists', async function () {
    const { options } = await build(
      marchApril({
        required: [
          {
            ...matchup('row_x', 'tem_hawks', 'tem_owls'),
            seasonId: 'sea_other'
          },
          matchup('row_1', 'tem_hawks', 'tem_guests')
        ]
      })
    )
    expect(options[0].games.map(game => game.key)).deep.equals(['row_1'])
    expect(options[0].fairness.some(row => row.teamId === 'tem_guests')).equals(
      false
    )
  })

  it('places a recalculation around fixed games, packed against them', async function () {
    // One Saturday, and a fixed game in the middle of it: only the starts
    // packed after it, off the season's grid, hold both replacements.
    const hours = hoursOn([6], '08:00', '14:20')
    const run = input({
      seasons: [
        season({
          endsOn: '2027-03-06',
          regularGames: 1,
          exhibitionGames: 0,
          windows: [{ from: '2027-03-01', hours }]
        })
      ],
      fields: [field({ availability: { ...field().availability, hours } })],
      fixed: [
        fixedGame('f1', 'tem_elks', 'tem_lynx', '2027-03-06T15:25:00.000Z')
      ],
      required: [
        matchup('row_1', 'tem_hawks', 'tem_owls'),
        matchup('row_2', 'tem_bears', 'tem_foxes')
      ]
    })
    const result = await build(run)
    expect(result.options[0].games.map(game => game.key).sort()).deep.equals([
      'row_1',
      'row_2'
    ])
    expect(replay(run, result.options[0].games).violations).deep.equals([])
  })
})

// -------------------------------------------------------- weekParts.test.ts

describe('the C++ engine: weekly game portions', function () {
  this.timeout(120_000)

  const everyDay = hoursOn([0, 1, 2, 3, 4, 5, 6], '08:00', '20:00')
  function world(changes: Parameters<typeof season>[0] = {}): EngineInput {
    return input({
      seasons: [
        season({
          startsOn: '2027-03-01',
          endsOn: '2027-03-21',
          windows: [{ from: '2027-03-01', hours: everyDay }],
          maxGamesOnWeekdays: 1,
          maxGamesOnWeekend: 1,
          ...changes
        })
      ],
      fields: [
        field({ availability: { ...field().availability, hours: everyDay } })
      ]
    })
  }

  it('names binding weekly maximums for shortages and blocked recalculations, while retaining field shortages', async function () {
    const run = world({
      endsOn: '2027-03-07',
      regularGames: 4,
      exhibitionGames: 0
    })
    expect((await build(run)).options[0].unmet[0].cause).includes(
      'weekday/weekend game maximums'
    )
    const exhibitionLimited = structuredClone(run)
    exhibitionLimited.seasons[0].settings.regularGames = 0
    exhibitionLimited.seasons[0].settings.exhibitionGames = 1
    exhibitionLimited.seasons[0].exhibitionTeams = [
      exhibitionLimited.seasons[0].exhibitionTeams[0]
    ]
    expect((await build(exhibitionLimited)).options[0].unmet[0].cause).includes(
      'weekday/weekend game maximums'
    )
    const limitedField = structuredClone(run)
    limitedField.fields[0].availability.hours = hoursOn([6], '08:00', '09:30')
    expect((await build(limitedField)).options[0].unmet[0].cause).includes(
      'field time'
    )
    const closed = structuredClone(run)
    closed.seasons[0].settings.maxGamesOnWeekdays = 0
    closed.seasons[0].settings.maxGamesOnWeekend = 0
    expect((await build(closed)).blocking).includes(
      'weekday/weekend game maximums'
    )
    const [homeTeamId, awayTeamId] = closed.seasons[0].participants
    closed.required = [
      {
        key: 'replacement',
        seasonId: closed.seasons[0].id,
        homeTeamId,
        awayTeamId,
        exhibition: false
      }
    ]
    expect((await build(closed)).blocking).includes(
      'weekday/weekend game maximums'
    )
  })

  it('builds in the preferred portion and falls back when only the other portion is open', async function () {
    for (const preferGameOn of ['weekend', 'weekdays'] as const) {
      const run = world({ regularGames: 1, exhibitionGames: 0, preferGameOn })
      const context = buildContext(run)
      const options = await build(run)
      expect(options.options[0].games.length).greaterThan(0)
      for (const game of options.options[0].games) {
        const point = context.seasons[0].clock.pointOf(
          Date.parse(game.startAt),
          ZONE
        )
        expect(gameWeekPart(point.day).part).equals(preferGameOn)
      }
      run.seasons[0].settings.maxGamesOnWeekend =
        preferGameOn === 'weekend' ? 0 : 1
      run.seasons[0].settings.maxGamesOnWeekdays =
        preferGameOn === 'weekdays' ? 0 : 1
      const fallback = await build(run)
      expect(fallback.options[0].games.length).equals(
        options.options[0].games.length
      )
    }
  })
})

// ---------------------------------------------------------- options.test.ts

describe('the C++ engine: choosing options', function () {
  this.timeout(120_000)

  it('builds three options from E7’s run, each at least 25% different', async function () {
    const { options, blocking } = await build(input())
    expect(blocking).equals(null)
    expect(options).length(3)
    const slotsOf = (index: number): string[] =>
      options[index].games.map(game => `${game.fieldId}|${game.startAt}`)
    for (let later = 1; later < 3; later++)
      for (let earlier = 0; earlier < later; earlier++) {
        const theirs = new Set(slotsOf(earlier))
        const mine = slotsOf(later)
        expect(
          mine.filter(key => !theirs.has(key)).length / mine.length
        ).at.least(0.25)
      }
    expect(options[0].reasons).deep.equals([])
    expect(options[1].reasons.length).greaterThan(0)
    for (const option of options) {
      expect(option.games).length(21)
      expect(option.unmet).deep.equals([])
    }
  })

  it('offers fewer options when the space is small', async function () {
    const { options } = await build(
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
  })

  it('sums each team’s games in the fairness rows, fixed ones included', async function () {
    const run = input({
      fixed: [
        fixedGame(
          'g1',
          'tem_hawks',
          'tem_otters',
          '2027-03-20T14:00:00.000Z',
          90,
          { exhibition: true }
        ),
        fixedGame('g0', 'tem_hawks', 'tem_elks', '2026-10-10T15:00:00.000Z')
      ]
    })
    const [best] = (await build(run)).options
    expect(best.fairness).length(9)
    const hawks = best.fairness.find(row => row.teamId === 'tem_hawks')
    // Four regular games, last October's among them, and the fixed exhibition.
    expect(hawks).include({
      exhibitionTeam: false,
      regularGames: 4,
      exhibitionGames: 1
    })
    expect(
      best.fairness.find(row => row.teamId === 'tem_otters')?.exhibitionTeam
    ).equals(true)
    for (let i = 1; i < best.games.length; i++)
      expect(Date.parse(best.games[i].startAt)).at.least(
        Date.parse(best.games[i - 1].startAt)
      )
  })
})

// --------------------------------------------------------- capacity.test.ts

const SATURDAYS = hoursOn([6], '08:00', '18:00')

function saturdays(
  settings: Parameters<typeof season>[0] = {},
  fieldChanges: Partial<ReturnType<typeof field>['availability']> = {},
  changes: Partial<EngineInput> = {}
): EngineInput {
  return input({
    seasons: [
      season({
        endsOn: '2027-03-31',
        windows: [{ from: '2027-03-01', hours: SATURDAYS }],
        ...settings
      })
    ],
    fields: [
      field({
        availability: {
          ...field().availability,
          hours: SATURDAYS,
          ...fieldChanges
        }
      })
    ],
    ...changes
  })
}

const at = (date: string, time: string): number => wallInstant(date, time, ZONE)

function hawksBooked(date: string): EngineBooking {
  return {
    key: `bkg_${date}`,
    fieldId: null,
    size: null,
    teamIds: ['tem_hawks'],
    start: at(date, '07:00'),
    end: at(date, '19:00')
  }
}

describe('the C++ engine: causes', function () {
  this.timeout(120_000)

  it('names the manager whose outside game blocks the only open date', async function () {
    const run = saturdays(
      { regularGames: 1, exhibitionGames: 0 },
      { startsOn: '2027-03-06', endsOn: '2027-03-06' }
    )
    const [home, away] = run.seasons[0].participants
    run.seasons[0].participants = [home, away]
    run.headCoaches = { [home]: 'manager', outside: 'manager' }
    run.bookings = [{ ...hawksBooked('2027-03-06'), teamIds: ['outside'] }]
    const cause = managerLine('tem_hawks')
    expect((await build(run)).blocking).equals(cause)
    run.seasons[0].settings.maxGamesOnWeekend = 0
    expect((await build(run)).blocking).equals(WEEK_PARTS_CAUSE)
    run.seasons[0].settings.maxGamesOnWeekend = 200
    run.required = [
      {
        key: 'replace',
        seasonId: run.seasons[0].id,
        homeTeamId: home,
        awayTeamId: away,
        exhibition: false
      }
    ]
    expect((await build(run)).blocking).equals(cause)
    expect((await build({ ...run, headCoaches: undefined })).blocking).equals(
      null
    )
    run.bookings[0].teamIds = [home]
    expect((await build(run)).blocking).equals(
      'Demo Hawks’s existing games leave too few open dates'
    )
  })

  it('names the manager held by a game placed in the selected option on another field', async function () {
    const run = saturdays(
      { regularGames: 1, exhibitionGames: 0 },
      {
        startsOn: '2027-03-06',
        endsOn: '2027-03-06',
        hours: hoursOn([6], '08:00', '09:30')
      }
    )
    run.fields.push({ ...run.fields[0], id: 'second' })
    run.seasons[0].settings.fieldIds = run.fields.map(each => each.id)
    const [home, away, other, visitor] = run.seasons[0].participants
    run.headCoaches = { [home]: 'coach', [other]: 'coach' }
    run.seed = 1
    run.seasons[0].participants = [home, away, other, visitor]
    const ordinary = (await build(run)).options[0]
    expect(ordinary.games).length(2)
    expect(
      ordinary.games.some(
        g =>
          [g.homeTeamId, g.awayTeamId].includes(home) &&
          [g.homeTeamId, g.awayTeamId].includes(other)
      )
    ).equals(true)
    const allShare = (
      await build({
        ...run,
        headCoaches: Object.fromEntries(
          run.seasons[0].participants.map(team => [team, 'coach'])
        )
      })
    ).options[0]
    expect(allShare.unmet[0].cause).includes('Manager/Head Coach')
    run.required = [
      [home, away],
      [other, visitor]
    ].map(([homeTeamId, awayTeamId], i) => ({
      key: `required-${i}`,
      seasonId: run.seasons[0].id,
      homeTeamId,
      awayTeamId,
      exhibition: false
    }))
    const { options } = await build(run)
    expect(options.length).greaterThan(0)
    for (const option of options) {
      expect(option.games).length(1)
      expect(option.unmet[0].cause).includes('Manager/Head Coach')
    }
    expect(
      (await build({ ...run, headCoaches: undefined })).options[0].games
    ).length(2)
  })

  it('explains a reduced count when the manager still has one available date', async function () {
    const days = ['2027-03-06', '2027-03-13', '2027-03-20']
    const run = saturdays(
      { regularGames: 3, exhibitionGames: 0, doubleheaders: 'never' },
      {},
      {
        bookings: days.map(day => ({
          ...hawksBooked(day),
          teamIds: ['outside']
        }))
      }
    )
    const [home, away] = run.seasons[0].participants
    run.seasons[0].participants = [home, away]
    run.headCoaches = { [home]: 'coach', outside: 'coach' }
    const { options, blocking } = await build(run)
    expect(blocking).equals(null)
    expect(options[0].games.length).equals(1)
    expect(options[0].unmet[0].cause).equals(managerLine('tem_hawks'))
  })

  it('leaves the old field at full capacity for a manager-only interval', async function () {
    const run = saturdays(
      { regularGames: 1, exhibitionGames: 0 },
      {
        startsOn: '2027-03-06',
        endsOn: '2027-03-06',
        hours: hoursOn([6], '08:00', '11:10')
      }
    )
    run.seasons[0].participants = run.seasons[0].participants.slice(0, 4)
    const normal = (await build(run)).options[0].games
    expect(normal.length).equals(2)
    const retained =
      (
        await build({
          ...run,
          bookings: [
            {
              ...hawksBooked('2027-03-06'),
              fieldId: run.fields[0].id,
              teamIds: ['outside'],
              managerOnly: true
            }
          ]
        })
      ).options[0]?.games ?? []
    expect(retained).deep.equals(normal)
  })

  it('phrases a lowered target’s cause against the requested count', async function () {
    const { options, blocking } = await build(saturdays({ regularGames: 8 }))
    expect(blocking).equals(null)
    // Re-baselined: 4 and the exhibition by the search; 6 and no exhibition
    // exactly, a regular game weighing above every exhibition.
    expect(options[0].unmet).deep.equals([
      {
        seasonId: 'sea_demo',
        message: 'every team gets 6 of the 8 requested regular-season games',
        cause: 'not enough 50/70 field time to give every team 8 games'
      },
      {
        seasonId: 'sea_demo',
        message: 'every team gets 0 of the 1 requested exhibition game',
        cause:
          'not enough 50/70 field time to give every team 1 exhibition game'
      }
    ])
  })

  it('names a team whose own games leave it too few open dates', async function () {
    const run = saturdays(
      { doubleheaders: 'never', regularGames: 4, exhibitionGames: 0 },
      {},
      { bookings: ['2027-03-06', '2027-03-13'].map(hawksBooked) }
    )
    const { options } = await build(run)
    // Re-baselined: the search's heuristic named Demo Hawks' own games;
    // relaxing the never-doubleheaders rule lets Demo Hawks reach 4, so the
    // exact cause (the TypeScript exact path's too) is that rule.
    expect(options[0].unmet[0]).deep.equals({
      seasonId: 'sea_demo',
      message: 'every team gets 2 of the 4 requested regular-season games',
      cause: DOUBLEHEADERS_CAUSE
    })
  })

  const noSlot = (changes: Partial<EngineInput> = {}): EngineInput =>
    saturdays(
      { regularGames: 30 },
      {
        startsOn: '2027-03-06',
        endsOn: '2027-03-06',
        hours: hoursOn([6], '08:00', '09:00')
      },
      changes
    )

  it('blocks when no new game fits, even with fixed games and pending proposals', async function () {
    const result = await build(
      noSlot({
        fixed: [
          fixedGame(
            'g1',
            'tem_hawks',
            'tem_owls',
            '2027-03-06T14:00:00.000Z',
            60
          ),
          fixedGame(
            'g2',
            'tem_foxes',
            'tem_bears',
            '2027-03-07T15:00:00.000Z',
            90,
            { fieldId: null }
          )
        ]
      })
    )
    expect([result.options, result.blocking]).deep.equals([
      [],
      'not enough 50/70 field time to give every team 30 games'
    ])
  })

  it('gives an option, not a block, when one game fits', async function () {
    const oneSlot = (fixed: EngineInput['fixed']): EngineInput =>
      saturdays(
        { regularGames: 30 },
        {
          startsOn: '2027-03-06',
          endsOn: '2027-03-06',
          hours: hoursOn([6], '08:00', '09:30')
        },
        { fixed }
      )
    const run = oneSlot([
      fixedGame('g1', 'tem_hawks', 'tem_owls', '2027-03-07T15:00:00.000Z', 90, {
        fieldId: null
      })
    ])
    const result = await build(run)
    expect(result.blocking).equals(null)
    expect(result.options).length(1)
    expect(result.options[0].games).length(1)
    expect(replay(run, result.options[0].games).violations).deep.equals([])
    expect(result.options[0].unmet).length(2)
    expect(result.options[0].unmet[1].message).equals(
      'every team gets 0 of the 1 requested exhibition game'
    )
    expect(result.options[0].unmet[0].message).match(
      /^Demo \w+ gets 0 of 30 regular-season games; .*the others get 1 of 30$/
    )
    expect(result.options[0].unmet[0].cause).equals(
      'not enough 50/70 field time to give every team 30 games'
    )
    const none = await build(oneSlot([]))
    expect(none.blocking).equals(null)
    expect(none.options).length(1)
    expect(none.options[0].games).length(0)
    expect(none.options[0].unmet[0].message).equals(
      'every team gets 0 of the 30 requested regular-season games'
    )
  })

  it('does not block a run that needs nothing, and names exhibition counts', async function () {
    const nothing = noSlot({})
    nothing.seasons[0].settings.regularGames = 0
    nothing.seasons[0].settings.exhibitionGames = 0
    expect((await build(nothing)).blocking).equals(null)
    const exhibitionOnly = noSlot({})
    exhibitionOnly.seasons[0].settings.regularGames = 0
    expect((await build(exhibitionOnly)).blocking).equals(
      'not enough 50/70 field time to give every team 1 exhibition game'
    )
  })

  it('counts a field’s time in its own zone, wherever the field is', async function () {
    const tokyo = saturdays(
      { endsOn: '2027-03-06', regularGames: 2, exhibitionGames: 0 },
      { timezone: 'Asia/Tokyo' }
    )
    tokyo.seasons[0].participants = PARTICIPANTS.slice(0, 4)
    const result = await build(tokyo)
    expect(result.options[0].games.length).greaterThan(0)
    for (const game of result.options[0].games)
      expect(gameCalendarDay(game.startAt, 'Asia/Tokyo')).equals('2027-03-06')
    expect(replay(tokyo, result.options[0].games).violations).deep.equals([])
  })
})

// --------------------------------------------- exhibitions and the wrapper

describe('the C++ engine: exhibition games', function () {
  this.timeout(120_000)

  it('gives each participant its exhibition games, regular games first', async function () {
    const run = input({
      seasons: [
        season({ regularGames: 4, exhibitionGames: 2, endsOn: '2027-04-30' })
      ]
    })
    const result = await build(run)
    expect(result.targets).deep.equals([
      { seasonId: SEASON, regular: 4, exhibition: 2 }
    ])
    const [best] = result.options
    for (const team of PARTICIPANTS)
      expect(best.fairness.find(row => row.teamId === team)).include({
        regularGames: 4,
        exhibitionGames: 2
      })
    for (const game of best.games.filter(each => each.exhibition))
      expect(EXHIBITION_TEAMS).include(
        EXHIBITION_TEAMS.includes(game.homeTeamId)
          ? game.homeTeamId
          : game.awayTeamId
      )
    expect(replay(run, best.games).violations).deep.equals([])
  })

  it('keeps regular games when the field holds no room for exhibitions', async function () {
    // Three games a Saturday: room for the regular games and two more.
    const saturday = hoursOn([6], '08:00', '18:00')
    const run = input({
      seasons: [
        season(
          {
            regularGames: 2,
            exhibitionGames: 1,
            endsOn: '2027-03-13',
            windows: [{ from: '2027-03-01', hours: saturday }]
          },
          {
            participants: PARTICIPANTS.slice(0, 4),
            exhibitionTeams: ['tem_otters']
          }
        )
      ],
      fields: [
        field({
          availability: {
            ...field().availability,
            hours: hoursOn([6], '08:00', '13:10')
          }
        })
      ]
    })
    const result = await build(run)
    expect(target(result, SEASON)).equals(2)
    const [best] = result.options
    for (const team of PARTICIPANTS.slice(0, 4))
      expect(regularOf(best, team)).equals(2)
    expect(result.targets[0].exhibition).equals(0)
    expect(best.unmet.map(line => line.message)).deep.equals([
      'every team gets 0 of the 1 requested exhibition game'
    ])
    expect(result.causes[0][0]).include({ kind: 'exhibition' })
    expect(replay(run, best.games).violations).deep.equals([])
  })

  it('counts a participant with no exhibition team left as having its games', async function () {
    const run = input({
      teamIds: ['tem_hawks', 'tem_owls'],
      seasons: [
        season({ endsOn: '2027-04-30', regularGames: 1, exhibitionGames: 1 })
      ]
    })
    const result = await build(run)
    expect(result.options[0].games.filter(game => game.exhibition)).deep.equals(
      []
    )
    expect(result.options[0].games.filter(game => !game.exhibition)).length(1)
  })
})

describe('the C++ engine’s wrapper', function () {
  it('reads a zone’s offsets, each change to the minute', function () {
    const from = Date.parse('2027-03-01T00:00:00Z')
    const to = Date.parse('2027-11-30T00:00:00Z')
    expect(zoneOffsets(ZONE, from, to)).deep.equals([
      { fromUtc: from, offsetMinutes: -360 },
      { fromUtc: Date.parse('2027-03-14T08:00:00Z'), offsetMinutes: -300 },
      { fromUtc: Date.parse('2027-11-07T07:00:00Z'), offsetMinutes: -360 }
    ])
    expect(zoneOffsets('UTC', from, to)).deep.equals([
      { fromUtc: from, offsetMinutes: 0 }
    ])
    expect(offsetAt(Date.parse('2027-07-01T12:00:30Z'), 'Asia/Kolkata')).equals(
      330
    )
    const request = wireRequest({ input: input(), limitMs: 5000 })
    expect(Object.keys(request.offsets)).deep.equals([ZONE])
    expect(request.limitMs).equals(5000)
  })

  /** Each change `zoneOffsets` found sits on a minute, with `offsetAt` agreeing either side. */
  const expectChanges = (zone: string, from: number, to: number): number => {
    const found = zoneOffsets(zone, from, to)
    expect(found[0]).deep.equals({
      fromUtc: from,
      offsetMinutes: offsetAt(from, zone)
    })
    for (let index = 1; index < found.length; index++) {
      const change = found[index]
      expect(change.fromUtc % MINUTE, zone).equals(0)
      expect(offsetAt(change.fromUtc, zone), zone).equals(change.offsetMinutes)
      expect(offsetAt(change.fromUtc - MINUTE, zone), zone).equals(
        found[index - 1].offsetMinutes
      )
    }
    return found.length - 1
  }

  it('bisects a change at local midnight from a window start off the minute', function () {
    // These zones change their clocks at local midnight; a `from` that is
    // not on a whole minute once left the bisection a step under a minute.
    expect(
      zoneOffsets(
        'America/Santiago',
        Date.parse('2026-09-05T15:30:12.345Z'),
        Date.parse('2026-09-20T00:00:00Z')
      ).map(change => change.offsetMinutes)
    ).deep.equals([-240, -180])
    for (const zone of [
      'America/Santiago',
      'America/Asuncion',
      'America/Havana',
      'Africa/Cairo',
      'Asia/Beirut'
    ]) {
      const year = zoneOffsets(
        zone,
        Date.parse('2026-01-01T00:00:00Z'),
        Date.parse('2027-01-01T00:00:00Z')
      )
      for (const change of year.slice(1)) {
        // Start a few seconds off the minute, one to forty hours before the
        // change, so the change is the first day's next midnight at least once.
        for (let hours = 1; hours <= 40; hours++) {
          const from = change.fromUtc - hours * 3_600_000 + 12_345
          expect(expectChanges(zone, from, change.fromUtc + DAY)).equals(1)
        }
      }
    }
  })

  it('finds every zone’s changes over a year, each to the minute', function () {
    this.timeout(120_000)
    const from = Date.parse('2026-01-01T00:00:12.345Z')
    const to = Date.parse('2027-01-01T00:00:00Z')
    let changes = 0
    for (const zone of Intl.supportedValuesOf('timeZone'))
      changes += expectChanges(zone, from, to)
    expect(changes).greaterThan(100)
  })

  it('finds the addon, and says how to build it when it is missing', async function () {
    const saved = process.env.TS_SCHEDULER_ADDON
    try {
      process.env.TS_SCHEDULER_ADDON = '/nowhere/scheduler.node'
      expect(addonPath()).equals('/nowhere/scheduler.node')
      delete process.env.TS_SCHEDULER_ADDON
      expect(addonPath()).matches(/scheduler\/node\/scheduler\.node$/)
    } finally {
      if (saved == null) delete process.env.TS_SCHEDULER_ADDON
      else process.env.TS_SCHEDULER_ADDON = saved
    }
    expect(() =>
      loadAddon('/nowhere/scheduler.node', () => {
        throw new Error('not found')
      })
    ).throws(/run node scripts\/schedulerBuild.mjs node\. not found/)
    expect(() =>
      loadAddon('/nowhere/scheduler.node', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'gone'
      })
    ).throws(/gone/)
    // A stand-in addon answers as the engine does.
    const answer = await buildSchedule({ input: small(four) }, undefined, {
      build: () => ({
        promise: Promise.resolve(
          JSON.stringify({
            kind: 'failure',
            failure: 'canceled',
            message: 'stopped'
          })
        ),
        cancel: () => undefined,
        decide: () => undefined
      })
    })
    expect(answer).deep.equals({
      kind: 'failure',
      failure: 'canceled',
      message: 'stopped'
    })
    const addon = loadAddon()
    let refused: unknown
    try {
      ;(addon.build as unknown as (request: unknown) => unknown)(42)
    } catch (error) {
      refused = error
    }
    expect(String(refused)).matches(/takes the request as JSON text/)
    expect(JSON.parse(await addon.build('{').promise)).include({
      kind: 'failure',
      failure: 'broken'
    })
    const handle = addon.build('{"input": 1}')
    // A build that never pauses never reads an answer, nor one it does not know.
    expect(() => {
      handle.decide('continue')
      ;(handle.decide as (choice: unknown) => void)('maybe')
      ;(handle.decide as (choice: unknown) => void)(7)
    }).not.throws()
    expect(JSON.parse(await handle.promise)).include({
      kind: 'failure',
      failure: 'broken'
    })
  })

  it('stops a build the session aborts, and answers canceled', async function () {
    // Aborted while the packed league solves: HiGHS's interrupt callback
    // stops the solve well before its 5–14 s.
    const controller = new AbortController()
    const events: unknown[] = []
    const started = Date.now()
    setTimeout(() => {
      controller.abort()
    }, 300)
    const stopped = await buildSchedule(
      { input: packedLeagueRun() },
      { signal: controller.signal, onProgress: event => events.push(event) }
    )
    expect(stopped).deep.equals({
      kind: 'failure',
      failure: 'canceled',
      message: 'The build was canceled'
    })
    expect(Date.now() - started).lessThan(4000)
    // Aborted before it starts: no build at all.
    expect(
      await buildSchedule(
        { input: small(four) },
        { signal: controller.signal },
        {
          build: () => {
            throw new Error('never started')
          }
        }
      )
    ).deep.equals(CANCELED)
    // The next build runs as ever.
    const after = await build(small(four))
    expect(after.kind).equals('options')
  }).timeout(60_000)

  it('stops a build paused in an environment that goes, so the next build runs', async function () {
    // A worker thread's build pauses at its 1 ms limit and waits for an
    // answer; the worker then ends, and its environment's teardown stops
    // the build, which frees the lock every environment's builds share.
    const { Worker } = await import('node:worker_threads')
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const addon = require(workerData.path)
      addon.build(workerData.request, event => {
        if (JSON.parse(event).kind === 'limit') parentPort.postMessage('paused')
      })
      `,
      {
        eval: true,
        workerData: {
          path: addonPath(),
          request: JSON.stringify(
            wireRequest({ input: packedLeagueRun(), limitMs: 1 })
          )
        }
      }
    )
    expect(
      await new Promise(resolve => worker.once('message', resolve))
    ).equals('paused')
    await worker.terminate()
    const after = await build(small(four))
    expect(after.kind).equals('options')
  }).timeout(60_000)

  it('hands the session every event the engine reports, and drops what is not one', async function () {
    const events: unknown[] = []
    const answer = await buildSchedule(
      { input: small(four) },
      { onProgress: event => events.push(event) },
      {
        build: (_request, onProgress) => {
          onProgress?.('{"kind":"phase-start","phase":"context"}')
          onProgress?.('{"kind":"phase","phase":"context","ms":3}')
          onProgress?.('{"kind":"other"}')
          onProgress?.('[1]')
          onProgress?.('not json')
          return {
            promise: Promise.resolve(
              JSON.stringify({
                kind: 'failure',
                failure: 'broken',
                message: 'x'
              })
            ),
            cancel: () => undefined,
            decide: () => undefined
          }
        }
      }
    )
    expect(answer).include({ failure: 'broken' })
    expect(events).deep.equals([
      { kind: 'phase-start', phase: 'context' },
      { kind: 'phase', phase: 'context', ms: 3 }
    ])
    expect(readEvent('null')).equals(null)
    expect(new EngineFailureError('noSolver', 'No WebAssembly')).include({
      failure: 'noSolver',
      message: 'No WebAssembly',
      name: 'EngineFailureError'
    })
    expect(failure('noSolver', 'gone')).deep.equals({
      kind: 'failure',
      failure: 'noSolver',
      message: 'gone'
    })
  })

  it('words every reason and cause as today', function () {
    const names = input().teamNames
    const lines = [
      reasonLine({ term: 'unplaced', more: 2 }, names),
      reasonLine({ term: 'doubleheaders', more: 1 }, names),
      reasonLine({ term: 'preference' }, names),
      reasonLine(
        {
          term: 'timeOfDay',
          teamId: 'tem_hawks',
          count: 3,
          games: 3,
          index: 2
        },
        names
      ),
      reasonLine(
        { term: 'weekday', teamId: 'tem_hawks', count: 2, games: 3, index: 1 },
        names
      ),
      reasonLine({ term: 'backToBack', teamId: 'tem_hawks', count: 2 }, names),
      reasonLine({ term: 'gap', teamId: 'tem_hawks', days: 126 }, names),
      reasonLine({ term: 'gap', teamId: 'tem_new', days: null }, names),
      reasonLine({ term: 'scarcity', more: 1 }, names),
      reasonLine({ term: 'scarcity', more: 0 }, names),
      reasonLine({ term: 'balanced' }, names)
    ]
    expect(lines).deep.equals([
      '2 more games left unplaced',
      '1 more doubleheader',
      'More games fall outside the preferred part of the week',
      'Demo Hawks plays 3 of its 3 games in the evening',
      'Demo Hawks plays 2 of its 3 games on Mondays',
      'Demo Hawks has 2 games on back-to-back days',
      'Demo Hawks goes 126 days without a game',
      'tem_new goes -Infinity days without a game',
      '1 more game on fields other seasons also need',
      'more use of fields other seasons also need',
      'Just as balanced as Option 1, at other dates and times'
    ])
    const read = readResult(
      JSON.stringify({
        kind: 'options',
        options: [],
        blocking: {
          seasonId: SEASON,
          kind: 'required',
          rule: 'teamOpenDates',
          teamId: 'tem_hawks',
          requested: 1,
          size: '50/70'
        }
      }),
      input()
    )
    expect(read).deep.include({
      blocking: 'Demo Hawks’s existing games leave too few open dates',
      targets: []
    })
    expect(
      causeLine(
        {
          seasonId: SEASON,
          kind: 'regular',
          rule: 'manager',
          teamId: 'tem_x',
          requested: 2,
          size: '50/70'
        },
        { teamNames: {} }
      )
    ).equals(
      'tem_x’s Manager/Head Coach is booked during otherwise available game times'
    )
  })
})

/**
 * The packed league at a limit of `limitMs` (1 s unless given), each limit
 * answered by `answer` after a moment.
 */
async function limited(
  answer: (limit: EngineLimit, count: number) => EngineDecision,
  signal?: AbortSignal,
  limitMs = 1000
): Promise<{
  result: EngineBuild
  events: EngineEvent[]
  limits: EngineLimit[]
}> {
  const events: EngineEvent[] = []
  const limits: EngineLimit[] = []
  const result = await buildSchedule(
    { input: packedLeagueRun(), limitMs },
    {
      signal,
      onProgress: event => events.push(event),
      onLimit: async limit => {
        limits.push(limit)
        // The admin takes a moment; that time is not the solver's.
        await new Promise(resolve => setTimeout(resolve, 200))
        return answer(limit, limits.length)
      }
    }
  )
  return { result, events, limits }
}

/** The least time a cause solve gets (kCauseMinimumMs in Engine.h). */
const CAUSE_MINIMUM_MS = 5000

const phasesOf = (events: EngineEvent[]): string[] =>
  events.flatMap(event => (event.kind === 'phase' ? [event.phase] : []))

describe('the C++ engine: the time limit', function () {
  this.timeout(120_000)

  it('pauses the packed league’s targets solve at the limit, and continuing reaches the proof', async function () {
    const { result, events, limits } = await limited(() => 'continue')
    expect(limits.length).greaterThan(0)
    expect(limits[0]).include({ kind: 'limit', stage: 'targets' })
    // Each limit comes at least another second of solving later (HiGHS
    // checks its interrupt between steps), the pauses left out.
    limits.forEach((limit, i) => {
      expect(limit.solvedMs).least(1000 * (i + 1))
      if (i > 0) expect(limit.solvedMs).least(limits[i - 1].solvedMs + 1000)
      expect(limit.boundGames).within(338, 400)
      if (limit.bestGames != null)
        expect(limit.bestGames).most(limit.boundGames)
    })
    expect(result.kind).equals('options')
    if (result.kind !== 'options') return
    expect(result.provenOptimal).equals(true)
    expect(result.targets.map(each => each.regular)).deep.equals([
      10, 10, 12, 14, 16, 16
    ])
    // Causes get at least 5 s each though the limit is spent, and never
    // pause: each cause solve finds the cause that really binds (as the
    // unlimited build does), or runs its 5 s out and leaves the cause to the
    // capacity reading. Which, depends on the machine's speed.
    const causePhases = events.filter(
      event => event.kind === 'phase' && event.phase === 'cause'
    )
    expect(result.causes[0].map(cause => cause.rule)).not.include('timeLimit')
    const exact = ['fieldTime', 'weekParts']
    result.causes[0].forEach((cause, i) => {
      const ran = causePhases[i]
      if (ran.kind !== 'phase') return
      if (ran.ms < CAUSE_MINIMUM_MS) expect(cause.rule).equals(exact[i])
      else expect(ran.ms).least(CAUSE_MINIMUM_MS)
    })
    const phases = phasesOf(events)
    expect(phases).deep.equals([
      'context',
      'model',
      'targets',
      'placement',
      'cause',
      'cause',
      'polish',
      'options'
    ])
    // Each step is heard starting, then ending, one at a time, a cause
    // naming its season both times.
    expect(
      events.flatMap(event =>
        event.kind === 'phase-start' || event.kind === 'phase'
          ? [
              `${event.kind === 'phase' ? '-' : '+'}${event.phase}${event.detail?.seasonName == null ? '' : ` ${event.detail.seasonName}`}`
            ]
          : []
      )
    ).deep.equals([
      '+context',
      '-context',
      '+model',
      '-model',
      '+targets',
      '-targets',
      '+placement',
      '-placement',
      '+cause S5',
      '-cause S5',
      '+cause S6',
      '-cause S6',
      '+polish',
      '-polish',
      '+options',
      '-options'
    ])
    // Better schedules and limits come while the targets solve runs.
    const targetsAt = events.findIndex(
      event => event.kind === 'phase-start' && event.phase === 'targets'
    )
    for (const [i, event] of events.entries())
      if (event.kind === 'progress' || event.kind === 'limit')
        expect(i).greaterThan(targetsAt)
    const model = events.find(
      event => event.kind === 'phase' && event.phase === 'model'
    )
    expect(model).deep.include({ detail: { columns: 23_776, rows: 10_685 } })
    const causes = events.filter(
      event => event.kind === 'phase' && event.phase === 'cause'
    )
    expect(
      causes.map(each => each.kind === 'phase' && each.detail)
    ).deep.equals([{ seasonName: 'S5' }, { seasonName: 'S6' }])
    const lastLimit = events.findLastIndex(event => event.kind === 'limit')
    const placed = events.findIndex(
      event => event.kind === 'phase' && event.phase === 'placement'
    )
    expect(lastLimit).lessThan(placed)
    // The solver's progress: games found, at most possible, and the gap.
    const progress = events.filter(event => event.kind === 'progress')
    expect(progress.length).greaterThan(0)
    for (const each of progress)
      if (each.kind === 'progress') {
        expect(each.incumbentGames).most(each.boundGames)
        expect(each.gap).closeTo(
          (each.boundGames - each.incumbentGames) / each.boundGames,
          1e-9
        )
      }
    expect(progress.at(-1)).include({ incumbentGames: 338, gap: 0 })
  })

  it('takes the best schedule at the limit, not proven the best, and says so', async function () {
    // A limit of nothing makes every interrupt check a limit, so where the
    // build pauses follows HiGHS's steps (one thread, a fixed seed), not the
    // machine's speed. Use at the first limit with a best to take: with
    // none, Use waits only one more limit for the first. That best comes
    // before the proof (the bound is still above it), so the solve stops
    // short of the proof.
    const { result, events, limits } = await limited(
      limit => (limit.bestGames == null ? 'continue' : 'use'),
      undefined,
      0
    )
    expect(limits[0].stage).equals('targets')
    const used = limits.find(limit => limit.bestGames != null)
    expect(used).include({ stage: 'targets' })
    expect(used?.bestGames).lessThan(used?.boundGames ?? 0)
    expect(result.kind).equals('options')
    if (result.kind !== 'options') return
    expect(result.provenOptimal).equals(false)
    const [best] = result.options
    expect(best.games.length).greaterThan(0)
    expect(best.unmet.length).greaterThan(0)
    for (const line of best.unmet) expect(line.cause).equals(TIME_LIMIT_CAUSE)
    for (const cause of result.causes[0]) expect(cause.rule).equals('timeLimit')
    // No cause is solved; the placement either came or paused at its own limit.
    const phases = phasesOf(events)
    expect(phases).not.include('cause')
    expect(phases).include('placement')
    expect(replay(packedLeagueRun(), best.games).violations).deep.equals([])
  })

  it('cancels at the limit: answered cancel, aborted while paused, or an answer that fails', async function () {
    expect((await limited(() => 'cancel')).result).deep.equals(CANCELED_RESULT)
    const controller = new AbortController()
    const paused = await limited(() => {
      controller.abort()
      return 'continue'
    }, controller.signal)
    expect(paused.result).deep.equals(CANCELED_RESULT)
    // The canceled build frees the addon: the next one runs.
    expect((await buildSchedule({ input: small(four) })).kind).equals('options')
    const failing = await buildSchedule(
      { input: packedLeagueRun(), limitMs: 500 },
      {
        onLimit: () => {
          throw new Error('the modal went away')
        }
      }
    )
    expect(failing).deep.equals(CANCELED_RESULT)
  })

  it('answers each limit through the handle: use without onLimit, cancel through cancel', async function () {
    const limit = JSON.stringify({
      kind: 'limit',
      stage: 'placement',
      bestGames: null,
      boundGames: 12,
      solvedMs: 1000
    })
    const stand = (decided: string[], canceled: number[]): Addon => ({
      build: (_request, onProgress) => {
        onProgress?.(limit)
        return {
          promise: new Promise(resolve =>
            setTimeout(() => {
              resolve(JSON.stringify(CANCELED_RESULT))
            }, 10)
          ),
          cancel: () => canceled.push(1),
          decide: choice => decided.push(choice)
        }
      }
    })
    const decided: string[] = []
    const canceled: number[] = []
    await buildSchedule({ input: small(four) }, {}, stand(decided, canceled))
    await buildSchedule(
      { input: small(four) },
      { onLimit: () => 'continue' },
      stand(decided, canceled)
    )
    await buildSchedule(
      { input: small(four) },
      { onLimit: async () => 'cancel' as const },
      stand(decided, canceled)
    )
    expect(decided).deep.equals(['use', 'continue'])
    expect(canceled).deep.equals([1])
    expect(
      causeLine(
        {
          seasonId: SEASON,
          kind: 'regular',
          rule: 'timeLimit',
          requested: 18,
          size: '50/70'
        },
        { teamNames: {} }
      )
    ).equals('Not proven optimal: stopped at the time limit')
  })
})

const CANCELED_RESULT = {
  kind: 'failure',
  failure: 'canceled',
  message: 'The build was canceled'
}
