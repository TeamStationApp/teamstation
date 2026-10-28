import type { PlannedGame } from '../../common/autoScheduler/types'
import { addDays, daysBetween, monthDay } from '../../common/calendarDates'
import { weekdayOf } from '../../common/fieldAvailability'
import type { SchedulePreview } from '../../common/schedulePreviews'
import { placeholderTeamName } from '../scoring/placeholderPlayers'

/**
 * What the schedule preview shows: one season, team and field, each `null`
 * for all of them.
 */
export interface PreviewFilter {
  seasonId: string | null
  teamId: string | null
  fieldId: string | null
}

export const ALL_GAMES: PreviewFilter = {
  seasonId: null,
  teamId: null,
  fieldId: null
}

/**
 * A field as its pill names it: the venue shortened the way a team's name
 * is for its roster placeholders, then the field, with no spaces around the
 * slash. `Morley Field Sports Complex` and `TB1` read `MFS/TB1`.
 */
export function fieldPillLabel(field: {
  name: string
  venueName: string
}): string {
  return `${placeholderTeamName(field.venueName)}/${field.name}`
}

/**
 * Each field's label, by id: `fieldPillLabel`, except where two fields'
 * would read the same (two venues sharing the shortened name), or the venue
 * has nothing to shorten (no letter or digit, or only "The", which the
 * shortener reads as a placeholder "Team"); those read in full,
 * `venue/field`.
 */
export function fieldLabels(
  fields: Array<{ id: string; name: string; venueName: string }>
): Map<string, string> {
  const short = fields.map(field => fieldPillLabel(field))
  return new Map(
    fields.map((field, index) => {
      const label = short[index]
      const clashes = short.filter(each => each === label).length > 1
      const nothingToShorten =
        !/[\p{L}\p{N}]/u.test(field.venueName) ||
        (placeholderTeamName(field.venueName) === 'Team' &&
          field.venueName.trim() !== 'Team')
      return [
        field.id,
        clashes || nothingToShorten ? `${field.venueName}/${field.name}` : label
      ]
    })
  )
}

export interface FilterChoices {
  teams: Array<{ id: string; label: string }>
  fields: Array<{ id: string; label: string }>
}

const byLabel = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label)

/**
 * The Teams and Fields rows under a season: its participants and exhibition
 * teams, and the fields its games are on. With no season, every team and
 * every field.
 */
export function filterChoices(
  preview: Pick<SchedulePreview, 'teams' | 'seasons' | 'fields'>,
  games: PlannedGame[],
  seasonId: string | null
): FilterChoices {
  const season = preview.seasons.find(each => each.id === seasonId)
  const names = new Map(preview.teams.map(team => [team.id, team.name]))
  const teams =
    season == null
      ? preview.teams.map(team => ({ id: team.id, label: team.name }))
      : [...season.participants, ...season.exhibitionTeams].map(id => ({
          id,
          label: names.get(id) ?? 'A team'
        }))
  const used = new Set(
    games
      .filter(game => season == null || game.seasonId === season.id)
      .map(game => game.fieldId)
  )
  const labels = fieldLabels(preview.fields)
  const fields = preview.fields
    .filter(field => season == null || used.has(field.id))
    .map(field => ({ id: field.id, label: labels.get(field.id)! }))
  return { teams: teams.sort(byLabel), fields: fields.sort(byLabel) }
}

/**
 * The filter as it can be drawn, with the rows it is drawn in: a season the
 * preview no longer has, or a team or field the rows no longer offer, goes
 * back to all of them.
 */
export function normalizeFilter(
  filter: PreviewFilter,
  preview: Pick<SchedulePreview, 'teams' | 'seasons' | 'fields'>,
  games: PlannedGame[]
): { filter: PreviewFilter; choices: FilterChoices } {
  const seasonId = preview.seasons.some(each => each.id === filter.seasonId)
    ? filter.seasonId
    : null
  const choices = filterChoices(preview, games, seasonId)
  return {
    filter: {
      seasonId,
      teamId: choices.teams.some(each => each.id === filter.teamId)
        ? filter.teamId
        : null,
      fieldId: choices.fields.some(each => each.id === filter.fieldId)
        ? filter.fieldId
        : null
    },
    choices
  }
}

/** Whether two filters choose the same season, team and field. */
export function sameFilter(a: PreviewFilter, b: PreviewFilter): boolean {
  return (
    a.seasonId === b.seasonId &&
    a.teamId === b.teamId &&
    a.fieldId === b.fieldId
  )
}

/** The games in the season, with the team home or away, on the field. */
export function filteredGames(
  games: PlannedGame[],
  filter: PreviewFilter
): PlannedGame[] {
  return games.filter(
    game =>
      (filter.seasonId == null || game.seasonId === filter.seasonId) &&
      (filter.teamId == null ||
        game.homeTeamId === filter.teamId ||
        game.awayTeamId === filter.teamId) &&
      (filter.fieldId == null || game.fieldId === filter.fieldId)
  )
}

/**
 * The first day of the season, or of the earliest season for all of them;
 * undefined when none says, and the weeks count from the first game.
 */
export function firstDayOf(
  preview: Pick<SchedulePreview, 'seasons'>,
  seasonId: string | null
): string | undefined {
  return preview.seasons
    .filter(season => seasonId == null || season.id === seasonId)
    .flatMap(season => (season.startsOn == null ? [] : [season.startsOn]))
    .sort()[0]
}

/**
 * The calendar day of each instant in a zone, `YYYY-MM-DD`, with the one
 * formatter a list of games shares.
 */
function dayReader(zone: string): (startAt: string) => string {
  const format = new Intl.DateTimeFormat('en', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  return startAt => {
    const parts = Object.fromEntries(
      format
        .formatToParts(new Date(startAt))
        .map(part => [part.type, part.value])
    )
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

/**
 * Where the weeks count from: the earlier of the season's first day
 * (`firstDayOf`) and the day its first game is read on in `zone`, which a
 * viewer west of the field can read before the season starts. Taken from
 * the season's games, never a team's or a field's, so a week keeps its
 * number whichever team or field is chosen.
 */
export function weekAnchor(
  preview: Pick<SchedulePreview, 'seasons'>,
  games: PlannedGame[],
  seasonId: string | null,
  zone: string
): string | undefined {
  const dayOf = dayReader(zone)
  const first = firstDayOf(preview, seasonId)
  return [
    ...(first == null ? [] : [first]),
    ...games
      .filter(game => seasonId == null || game.seasonId === seasonId)
      .map(game => dayOf(game.startAt))
  ].sort()[0]
}

/** The Monday on or before a calendar date. */
export function mondayOnOrBefore(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7))
}

/** One week of the calendar, Monday to Sunday. */
export interface CalendarWeek {
  /** Counted from Week 1, the Monday on or before the first day. */
  number: number
  /** Its seven calendar days, Monday first. */
  days: string[]
  /**
   * As many rows as its busiest day has games: day `d`'s games, in start
   * order, are `rows[0][d]`, `rows[1][d]`, …; the other cells are empty.
   */
  rows: Array<Array<PlannedGame | undefined>>
}

/**
 * The weeks with a game in them. Days are read in `zone`, the zone every
 * time on the screen is read in, so a game sits under the date its time is
 * read on. Week 1 starts on the Monday on or before `firstDay`, or before
 * the first game when that is earlier; a week with no game is left out and
 * the others keep their numbers.
 */
export function calendarWeeks(
  games: PlannedGame[],
  options: { firstDay: string | undefined; zone: string }
): CalendarWeek[] {
  if (games.length === 0) return []
  const sorted = [...games].sort((a, b) =>
    a.startAt === b.startAt
      ? a.key.localeCompare(b.key)
      : a.startAt.localeCompare(b.startAt)
  )
  const dayOf = dayReader(options.zone)
  const days = new Map<string, PlannedGame[]>()
  for (const game of sorted) {
    const day = dayOf(game.startAt)
    const played = days.get(day)
    if (played == null) days.set(day, [game])
    else played.push(game)
  }
  // The games are in start order, so the days and the weeks are too.
  const [earliest] = days.keys()
  const start = mondayOnOrBefore(
    options.firstDay != null && options.firstDay < earliest
      ? options.firstDay
      : earliest
  )
  const weeks = new Map<number, CalendarWeek>()
  for (const [day, played] of days) {
    const number = Math.floor(daysBetween(start, day) / 7) + 1
    const monday = addDays(start, (number - 1) * 7)
    const week = weeks.get(number) ?? {
      number,
      days: [0, 1, 2, 3, 4, 5, 6].map(offset => addDays(monday, offset)),
      rows: []
    }
    const column = daysBetween(monday, day)
    played.forEach((game, row) => {
      while (week.rows.length <= row) week.rows.push(Array(7).fill(undefined))
      week.rows[row][column] = game
    })
    weeks.set(number, week)
  }
  return [...weeks.values()]
}

const HEADER = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short'
})

/** A column's header: `Tue · Mar · 02`. */
export function dayHeader(day: string): string {
  const parts = Object.fromEntries(
    HEADER.formatToParts(new Date(`${day}T12:00:00Z`)).map(part => [
      part.type,
      part.value
    ])
  )
  return `${parts.weekday} · ${parts.month} · ${day.slice(8, 10)}`
}

/** A week's title: `Week 4 · Mar 23 – Mar 29`. */
export function weekTitle(week: CalendarWeek): string {
  return `Week ${week.number} · ${monthDay(week.days[0])} – ${monthDay(week.days[6])}`
}
