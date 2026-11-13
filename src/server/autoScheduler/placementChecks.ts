import { seasonZones } from '../../common/autoScheduler/seasonZones'
import type {
  EngineInput,
  EngineResult,
  PlannedGame
} from '../../common/autoScheduler/types'
import { badRequest } from '../../common/errors'
import { gameCalendarDay } from '../../common/gameTime'
import { fieldSizeLabel } from '../../common/venues'
import { type Holding, type RuleContext, ruleProblem } from './rules'
import type { Snapshot } from './snapshot'

// The checks a device's placements must pass. The validation worker loads
// this module alone: nothing here may import the database, the server's
// routes or a native addon, whose teardown with the worker would take the
// whole process down.

/** The hard rules' context for a snapshot's fields and seasons. */
export function ruleContext(
  snap: Snapshot,
  others: RuleContext['others'],
  headCoaches?: Record<string, string>
): RuleContext {
  return {
    headCoaches,
    fields: new Map(
      snap.engine.fields.map(field => [
        field.id,
        {
          name: field.name,
          venueName: field.venueName,
          sizes: field.sizes,
          availability: field.availability,
          switchMs: field.switchMinutes * 60000
        }
      ])
    ),
    seasons: new Map(
      snap.engine.seasons.map(season => [
        season.id,
        {
          fieldIds: season.settings.fieldIds ?? [],
          bufferMinutes: season.settings.bufferMinutes,
          doubleheaders: season.settings.doubleheaders,
          maxGamesOnWeekdays: season.settings.maxGamesOnWeekdays,
          maxGamesOnWeekend: season.settings.maxGamesOnWeekend,
          fallback: {
            size: season.settings.fieldSize,
            zone: seasonZones(snap.engine.fields, season.settings)[0]
          }
        }
      ])
    ),
    others
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Holdings by the UTC day they start, so a game's rules read only those
 * near it: every rule looks at most a week either side. Long holdings are
 * always near. Their order only decides which of several problems a game
 * is refused for, so they are read in day order, not sorted.
 */
class NearHoldings {
  private readonly byDay = new Map<number, Holding[]>()
  private readonly long: Holding[] = []

  constructor(holdings: readonly Holding[]) {
    for (const holding of holdings) this.add(holding)
  }

  add(holding: Holding): void {
    if (holding.end - holding.start > DAY_MS) {
      this.long.push(holding)
      return
    }
    const day = Math.floor(holding.start / DAY_MS)
    const list = this.byDay.get(day) ?? []
    list.push(holding)
    this.byDay.set(day, list)
  }

  near(start: number): Holding[] {
    const day = Math.floor(start / DAY_MS)
    const found = [...this.long]
    for (let d = day - 9; d <= day + 9; d++) {
      const list = this.byDay.get(d)
      if (list != null) for (const holding of list) found.push(holding)
    }
    return found
  }
}

/** Validate device placements against the immutable server-held input. */
export function validatePlacements(snap: Snapshot, result: EngineResult): void {
  const { engine } = snap
  const seasons = new Map(
    engine.seasons.map(season => [
      season.id,
      {
        season,
        participants: new Set(season.participants),
        exhibition: new Set(season.exhibitionTeams)
      }
    ])
  )
  const required =
    engine.required == null
      ? null
      : new Map(engine.required.map(game => [game.key, game]))
  const fixedCounts = new Map<string, number>()
  for (const fixed of engine.fixed)
    for (const team of [fixed.homeTeamId, fixed.awayTeamId]) {
      const key = `${fixed.seasonId}:${team}:${fixed.exhibition}`
      fixedCounts.set(key, (fixedCounts.get(key) ?? 0) + 1)
    }
  const taken = new Set([
    ...engine.fixed.map(fixed => fixed.key),
    ...engine.bookings.map(booking => booking.key)
  ])
  engine.weeklyGames?.forEach((_, index) => taken.add(`weekly:${index}`))
  const base = ruleContext(snap, [], engine.headCoaches)
  const now = new Date(engine.notBefore - 1)
  for (const option of result.options) {
    const keys = new Set<string>()
    const counts = new Map<string, number>()
    const starting: Holding[] = [
      ...engine.bookings.map(booking => ({ ...booking, seasonId: null })),
      ...engine.fixed.map(game => ({
        ...game,
        teamIds: [game.homeTeamId, game.awayTeamId]
      }))
    ]
    const holdings = new NearHoldings(starting)
    // Without live weekly games, the weekly caps count the same holdings.
    const weekly =
      engine.weeklyGames == null
        ? holdings
        : new NearHoldings(
            engine.weeklyGames.map((game, index) => ({
              ...game,
              key: `weekly:${index}`,
              size: null,
              end: game.start
            }))
          )
    for (const game of option.games) {
      const start = Date.parse(game.startAt)
      const end = Date.parse(game.endAt)
      const of = seasons.get(game.seasonId)
      if (
        of == null ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        game.key.length === 0 ||
        game.key.length > 300 ||
        keys.has(game.key) ||
        taken.has(game.key)
      )
        throw badRequest('Submit unique games with valid seasons and times')
      keys.add(game.key)
      const { season, participants, exhibition } = of
      if (
        game.homeTeamId === game.awayTeamId ||
        end - start !== season.settings.gameMinutes * 60000
      )
        throw badRequest(
          'Each game needs two different teams and the season’s game length'
        )
      if (
        required == null &&
        (game.exhibition
          ? !(
              (participants.has(game.homeTeamId) &&
                exhibition.has(game.awayTeamId)) ||
              (participants.has(game.awayTeamId) &&
                exhibition.has(game.homeTeamId))
            )
          : !participants.has(game.homeTeamId) ||
            !participants.has(game.awayTeamId))
      )
        throw badRequest('Choose the season’s regular or exhibition matchups')
      const wanted = required?.get(game.key)
      if (required != null) {
        if (
          wanted?.seasonId !== game.seasonId ||
          wanted.homeTeamId !== game.homeTeamId ||
          wanted.awayTeamId !== game.awayTeamId ||
          wanted.exhibition !== game.exhibition
        )
          throw badRequest('Place only the requested games')
      } else {
        if (
          engine.teamIds != null &&
          (!engine.teamIds.includes(game.homeTeamId) ||
            !engine.teamIds.includes(game.awayTeamId))
        )
          throw badRequest('Place only the selected teams')
        for (const team of [game.homeTeamId, game.awayTeamId]) {
          if (!participants.has(team)) continue
          const key = `${game.seasonId}:${team}:${game.exhibition}`
          const count = (counts.get(key) ?? 0) + 1
          counts.set(key, count)
          if (
            count + (fixedCounts.get(key) ?? 0) >
            (game.exhibition
              ? season.settings.exhibitionGames
              : season.settings.regularGames)
          )
            throw badRequest('Do not exceed the season’s requested game counts')
        }
      }
      requireKeepsRulesIn(snap, game, now, wanted, {
        ...base,
        others: holdings.near(start),
        weeklyOthers: weekly.near(start)
      })
      holdings.add(holdingOf(game))
      if (weekly !== holdings) weekly.add(holdingOf(game))
    }
  }
}

/** A game, fixed or placed, as the hard rules see it. */
export function holdingOf(game: PlannedGame): Holding {
  return {
    key: game.key,
    fieldId: game.fieldId,
    size: game.size,
    teamIds: [game.homeTeamId, game.awayTeamId],
    seasonId: game.seasonId,
    start: Date.parse(game.startAt),
    end: Date.parse(game.endAt)
  }
}

/**
 * Checks an added game against the hard rules the engine places games by,
 * among the given other games, and says what is wrong with it: it is still
 * to come, within its season's dates on its field's local calendar, in the
 * season's field size, and between two of the season's teams.
 */
export function requireKeepsRules(
  snap: Snapshot,
  game: PlannedGame,
  others: Holding[],
  now: Date,
  headCoaches?: Record<string, string>,
  weeklyOthers?: Holding[]
): void {
  const required = snap.engine.required?.find(
    required =>
      required.key === game.key &&
      required.seasonId === game.seasonId &&
      required.homeTeamId === game.homeTeamId &&
      required.awayTeamId === game.awayTeamId &&
      required.exhibition === game.exhibition
  )
  requireKeepsRulesIn(snap, game, now, required, {
    ...ruleContext(snap, others, headCoaches),
    weeklyOthers
  })
}

type RequiredMatchup = NonNullable<EngineInput['required']>[number]

/**
 * The same checks in a rule context built once for many games; `required`
 * is the run's required matchup the game places, when it places one.
 */
function requireKeepsRulesIn(
  snap: Snapshot,
  game: PlannedGame,
  now: Date,
  required: RequiredMatchup | undefined,
  context: RuleContext
): void {
  const season = snap.engine.seasons.find(each => each.id === game.seasonId)
  if (season == null) throw badRequest('Choose a season of this run')
  if (Date.parse(game.startAt) <= now.getTime())
    throw badRequest('Choose a time still to come')
  const field = snap.engine.fields.find(each => each.id === game.fieldId)
  const day = gameCalendarDay(
    game.startAt,
    field?.availability.timezone ?? 'UTC'
  )
  if (day < season.settings.startsOn || day > season.settings.endsOn)
    throw badRequest(`Choose a day within ${season.name}’s dates`)
  if (game.size !== season.settings.fieldSize)
    throw badRequest(
      `${season.name} plays on ${fieldSizeLabel(season.settings.fieldSize)} fields`
    )
  const teams = new Set([...season.participants, ...season.exhibitionTeams])
  if (required != null) {
    teams.add(required.homeTeamId)
    teams.add(required.awayTeamId)
  }
  if (!teams.has(game.homeTeamId) || !teams.has(game.awayTeamId))
    throw badRequest(`Choose two of ${season.name}’s teams`)
  const problem = ruleProblem(
    {
      ...holdingOf(game),
      fieldId: game.fieldId,
      size: game.size,
      seasonId: game.seasonId
    },
    context
  )
  if (problem != null) throw badRequest(problem)
}
