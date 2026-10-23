import type { Availability } from '../../common/fieldAvailability'
import { coversGame } from '../../common/fieldAvailability'
import { gameCalendarDay } from '../../common/gameTime'
import type { Doubleheaders } from '../../common/seasonScheduling'
import { type FieldSize, fieldSizeLabel } from '../../common/venues'

/** A game to check, or something already holding a field or teams. */
export interface Holding {
  key: string
  fieldId: string | null
  size: string | null
  teamIds: string[]
  seasonId: string | null
  start: number
  end: number
}

export interface RuleContext {
  fields: Map<
    string,
    {
      name: string
      venueName: string
      sizes: readonly string[]
      availability: Availability
      switchMs: number
    }
  >
  seasons: Map<
    string,
    { bufferMinutes: number; doubleheaders: Doubleheaders; timezone: string }
  >
  /** Everything else holding the run's fields and teams. */
  others: Holding[]
}

/**
 * Why a game breaks one of the scheduler's hard rules, or null when it keeps
 * them all: its field is chosen and takes its size and is open for all of
 * it; nothing else on the field is closer than the later game's season's
 * time between games, plus the size switch time when the sizes differ;
 * neither team is busy then; and in a season with no doubleheaders, neither
 * team already plays that day.
 */
export function ruleProblem(
  game: Holding & { fieldId: string; size: FieldSize; seasonId: string },
  context: RuleContext
): string | null {
  const field = context.fields.get(game.fieldId)
  if (field == null) return 'Choose one of this run’s fields.'
  const where = `${field.name} at ${field.venueName}`
  if (!field.sizes.includes(game.size))
    return `${where} can’t be set up as ${fieldSizeLabel(game.size)}.`
  if (
    !coversGame(
      field.availability,
      new Date(game.start).toISOString(),
      new Date(game.end).toISOString()
    )
  )
    return `${where} is not open for all of this game.`
  const season = context.seasons.get(game.seasonId)
  const bufferMs = (season?.bufferMinutes ?? 0) * 60 * 1000
  const day = (instant: number): string =>
    gameCalendarDay(new Date(instant).toISOString(), season?.timezone ?? 'UTC')
  for (const other of context.others) {
    if (other.key === game.key) continue
    if (other.fieldId === game.fieldId) {
      const switching =
        other.size != null && other.size !== game.size ? field.switchMs : 0
      // The later game's season sets the time between them, as the engine
      // places them; a booking outside the run takes this game's.
      const otherSeason =
        other.seasonId == null ? undefined : context.seasons.get(other.seasonId)
      const before = bufferMs + switching
      const after =
        (otherSeason == null
          ? bufferMs
          : otherSeason.bufferMinutes * 60 * 1000) + switching
      if (game.start < other.end + before && other.start < game.end + after)
        return `Another game on ${where} is too close to this one.`
    }
    const shared = other.teamIds.filter(id => game.teamIds.includes(id))
    if (shared.length === 0) continue
    if (game.start < other.end && other.start < game.end)
      return 'A team already plays at this time.'
    if (
      season?.doubleheaders === 'never' &&
      other.seasonId === game.seasonId &&
      day(other.start) === day(game.start)
    )
      return 'This season has no doubleheaders, and a team already plays that day.'
  }
  return null
}
