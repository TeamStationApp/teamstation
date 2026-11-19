import { expect } from 'chai'

import { packedLeagueRun } from '../../test/packedLeagueRun'
import { buildContext } from '../autoScheduler/context'
import { Occupancy } from '../autoScheduler/feasibility'
import {
  field,
  hoursOn,
  input,
  PARTICIPANTS,
  season
} from '../autoScheduler/fixtures.test'
import type {
  EngineBooking,
  EngineInput,
  PlannedGame
} from '../autoScheduler/types'
import { buildSchedule, type EngineBuild, type EngineRequest } from './engine'

// Inputs and checks engine.test.ts's suites share, from the TypeScript
// engine's exact suites.

export type Built = Extract<EngineBuild, { kind: 'options' }>

/** A build that must answer options. */
export async function build(
  run: EngineInput,
  changes: Omit<EngineRequest, 'input'> = {}
): Promise<Built> {
  const result = await buildSchedule({ input: run, ...changes })
  if (result.kind !== 'options')
    throw new Error(`${result.failure}: ${result.message}`)
  return result
}

/**
 * Replays games through the TypeScript engine's hard rules (`Occupancy`,
 * which the server's checks use): the rule each breaks, or, for each game
 * that fits, nothing. Each team's and pair's count of new games comes back
 * too.
 */
export function replay(
  run: EngineInput,
  games: PlannedGame[]
): {
  violations: string[]
  teams: Map<string, number>
  pairs: Map<string, number>
} {
  const context = buildContext(run)
  const occupancy = new Occupancy(context)
  const violations: string[] = []
  const teams = new Map<string, number>()
  const pairs = new Map<string, number>()
  games.forEach((game, i) => {
    const season = context.seasonById.get(game.seasonId)
    const start = Date.parse(game.startAt)
    const slot = season?.slots.find(
      each => each.fieldId === game.fieldId && each.start === start
    )
    if (season == null || slot == null) {
      violations.push(`${game.key} at ${game.startAt} is not a slot`)
      return
    }
    if (!occupancy.fits(season, game.homeTeamId, game.awayTeamId, slot)) {
      violations.push(`${game.key} at ${game.startAt} breaks a hard rule`)
      return
    }
    occupancy.place(i, season, game.homeTeamId, game.awayTeamId, slot)
    for (const team of [game.homeTeamId, game.awayTeamId])
      teams.set(team, (teams.get(team) ?? 0) + 1)
    const pair = [game.homeTeamId, game.awayTeamId].sort().join('|')
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  })
  return { violations, teams, pairs }
}

/** Every option's games keep the hard rules; the best option's counts. */
export function check(
  run: EngineInput,
  result: Built
): { teams: Map<string, number>; pairs: Map<string, number> } {
  for (const option of result.options)
    expect(replay(run, option.games).violations).deep.equals([])
  return replay(run, result.options[0]?.games ?? [])
}

/** A season's settled regular count. */
export function target(result: Built, seasonId: string): number | undefined {
  return result.targets.find(each => each.seasonId === seasonId)?.regular
}

/**
 * A short, exact-ready run: the given teams, no exhibition games, and
 * Saturdays 08:00–18:00 in March 2027 unless the settings say otherwise.
 */
export function small(
  teams: string[],
  settings: Partial<EngineInput['seasons'][number]['settings']> = {},
  changes: Partial<EngineInput> = {}
): EngineInput {
  return input({
    seasons: [
      season(
        {
          regularGames: 2,
          exhibitionGames: 0,
          startsOn: '2027-03-01',
          endsOn: '2027-03-31',
          windows: [
            {
              from: '2027-03-01',
              until: '2027-03-31',
              hours: hoursOn([6], '08:00', '18:00')
            }
          ],
          ...settings
        },
        { participants: teams, exhibitionTeams: [] }
      )
    ],
    ...changes
  })
}

export const four = PARTICIPANTS.slice(0, 4)
export const three = PARTICIPANTS.slice(0, 3)
export const two = PARTICIPANTS.slice(0, 2)

/** Two Saturdays, one game a day each, two asked: Hawks against Owls. */
export function twoSaturdays(
  changes: Partial<EngineInput>,
  hours: [string, string] = ['08:00', '18:00']
): EngineInput {
  return small(
    two,
    {
      regularGames: 2,
      doubleheaders: 'never',
      startsOn: '2027-03-06',
      endsOn: '2027-03-13',
      windows: [
        {
          from: '2027-03-06',
          until: '2027-03-13',
          hours: hoursOn([6], hours[0], hours[1])
        }
      ]
    },
    changes
  )
}

/** Booked all of Saturday 6 March, for these teams. */
export function firstSaturday(
  teamIds: string[],
  managerOnly?: boolean
): EngineBooking {
  return {
    key: 'b1',
    fieldId: null,
    size: null,
    teamIds,
    ...(managerOnly == null ? {} : { managerOnly }),
    start: Date.parse('2027-03-06T13:00:00.000Z'),
    end: Date.parse('2027-03-07T01:00:00.000Z')
  }
}

/**
 * `n` teams asked for `asked` games, on Field 1 every day of March 2027 from
 * the 1st for `days` days, 08:00–14:00: six one-hour games a day.
 */
export function sized(n: number, asked: number, days: number): EngineInput {
  const teams = Array.from({ length: n }, (_, i) => `tem_n${i + 1}`)
  const everyDay = [0, 1, 2, 3, 4, 5, 6]
  const until = `2027-03-${String(days).padStart(2, '0')}`
  return small(
    teams,
    {
      regularGames: asked,
      gameMinutes: 60,
      bufferMinutes: 0,
      endsOn: until,
      windows: [
        {
          from: '2027-03-01',
          until,
          hours: hoursOn(everyDay, '08:00', '14:00')
        }
      ]
    },
    {
      fields: [
        field({
          availability: {
            ...field().availability,
            hours: hoursOn(everyDay, '08:00', '20:00')
          }
        })
      ]
    }
  )
}

/** The packed league's one season by name, alone in the run. */
export function packedSeason(
  name: string,
  settings: Partial<EngineInput['seasons'][number]['settings']> = {}
): EngineInput {
  const run = packedLeagueRun({
    seasons: each => ({ ...each, settings: { ...each.settings, ...settings } })
  })
  return { ...run, seasons: run.seasons.filter(each => each.name === name) }
}

/** Two seasons of the given teams and sizes on Field 1, Saturdays in March. */
export function shared(
  a: { teams: string[]; asked: number; changes?: object },
  b: { teams: string[]; asked: number; changes?: object },
  hours: [string, string]
): EngineInput {
  const settings = (asked: number): object => ({
    regularGames: asked,
    exhibitionGames: 0,
    startsOn: '2027-03-01',
    endsOn: '2027-03-31',
    windows: [
      {
        from: '2027-03-01',
        until: '2027-03-31',
        hours: hoursOn([6], hours[0], hours[1])
      }
    ]
  })
  return input({
    seasons: [
      season(
        { ...settings(a.asked), ...a.changes },
        { id: 'sea_a', participants: a.teams, exhibitionTeams: [] }
      ),
      season(
        { ...settings(b.asked), ...b.changes },
        { id: 'sea_b', participants: b.teams, exhibitionTeams: [] }
      )
    ]
  })
}

/** Two seasons on one field, one Saturday morning, of different sizes. */
export function twoSizes(): EngineInput {
  const morning = hoursOn([6], '08:00', '12:00')
  const day = {
    startsOn: '2027-03-06',
    endsOn: '2027-03-06',
    windows: [{ from: '2027-03-06', until: '2027-03-06', hours: morning }]
  }
  return input({
    seasons: [
      season(
        { regularGames: 1, exhibitionGames: 0, ...day, fieldSize: '50/70' },
        { participants: two, exhibitionTeams: [] }
      ),
      season(
        { regularGames: 1, exhibitionGames: 0, ...day, fieldSize: '46/60' },
        {
          id: 'sea_other',
          participants: PARTICIPANTS.slice(2, 4),
          exhibitionTeams: []
        }
      )
    ]
  })
}

/** Hawks in two seasons on two fields, with one game's time each Saturday. */
export function twoSeasonsOneTeam(): EngineInput {
  const saturdays = {
    regularGames: 2,
    exhibitionGames: 0,
    startsOn: '2027-03-06',
    endsOn: '2027-03-13',
    windows: [
      {
        from: '2027-03-06',
        until: '2027-03-13',
        hours: hoursOn([6], '08:00', '09:30')
      }
    ]
  }
  return input({
    seasons: [
      season(saturdays, {
        participants: [PARTICIPANTS[0], PARTICIPANTS[1]],
        exhibitionTeams: []
      }),
      season(
        { ...saturdays, fieldIds: ['fld_two'] },
        {
          id: 'sea_other',
          participants: [PARTICIPANTS[0], PARTICIPANTS[2]],
          exhibitionTeams: []
        }
      )
    ],
    fields: [field(), field({ id: 'fld_two', name: 'Field 2' })]
  })
}
