import { seasonZones } from '../../common/autoScheduler/seasonZones'
import type { EngineInput, PlannedGame } from '../../common/autoScheduler/types'
import { badRequest } from '../../common/errors'
import { gameCalendarDay } from '../../common/gameTime'
import { fieldSizeLabel } from '../../common/venues'
import { type Holding, type RuleContext, ruleProblem } from './rules'
import type { Snapshot } from './snapshot'

// The hard rules an admin's added games and a publication's games are
// checked by, against what holds the run's fields and teams.

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
