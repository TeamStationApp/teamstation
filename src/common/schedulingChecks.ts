import { addDays, type WindowPeriod } from './fieldAvailability'
import type { ScheduleSettings } from './seasonScheduling'
import { type FieldSize, fieldSizeLabel, wallMinutes } from './venues'

export type SchedulingCheckKind =
  | 'noSeasons'
  | 'noGames'
  | 'oddTotal'
  | 'unevenExhibition'
  | 'noExhibitionTeams'
  | 'noField'
  | 'fieldDates'
  | 'noWindows'
  | 'shortWindow'
  | 'windowGap'

/** Something about a run worth knowing before it is built. */
export interface SchedulingCheck {
  kind: SchedulingCheckKind
  /** The season it is about; empty for the run as a whole. */
  seasonId: string
  message: string
  /** A blocking check keeps the schedule from being built. */
  blocking: boolean
}

export interface CheckedSeason {
  id: string
  name: string
  participants: number
  exhibitionTeams: number
  settings: Pick<
    ScheduleSettings,
    | 'fieldSize'
    | 'gameMinutes'
    | 'regularGames'
    | 'exhibitionGames'
    | 'startsOn'
    | 'endsOn'
    | 'windows'
  >
}

export interface CheckedField {
  id: string
  name: string
  venueName: string
  sizes: readonly FieldSize[]
  startsOn: string | null
  endsOn: string | null
  deleted: boolean
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

/** "Mar 1", or "Mar 1 – May 31" for a run of days. */
function dateSpan(from: string, to: string): string {
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`
}

/**
 * The runs of the season's days that no window period covers: before the
 * first period begins, after a period's end date and before the next, and
 * after the last period's end date.
 */
export function windowGaps(
  settings: Pick<ScheduleSettings, 'startsOn' | 'endsOn' | 'windows'>
): Array<{ from: string; to: string }> {
  const { startsOn, endsOn } = settings
  const periods = [...settings.windows].sort((a, b) =>
    a.from.localeCompare(b.from)
  )
  const gaps: Array<{ from: string; to: string }> = []
  const gap = (from: string, to: string): void => {
    const last = to > endsOn ? endsOn : to
    if (from <= last) gaps.push({ from, to: last })
  }
  // The first day not yet known to be covered.
  let next = startsOn
  periods.forEach((period: WindowPeriod, index) => {
    const following = periods[index + 1]
    const end =
      period.until ?? (following == null ? endsOn : addDays(following.from, -1))
    if (period.from > next) gap(next, addDays(period.from, -1))
    if (end >= next) next = addDays(end, 1)
  })
  gap(next, endsOn)
  return gaps
}

/**
 * The early warnings of a run, live as its grid changes: arithmetic that
 * can't come out even, and seasons with nowhere or no time to play.
 */
export function schedulingChecks(
  seasons: CheckedSeason[],
  fields: CheckedField[]
): SchedulingCheck[] {
  const checks: SchedulingCheck[] = []
  const add = (
    kind: SchedulingCheckKind,
    seasonId: string,
    message: string,
    blocking = false
  ): void => {
    checks.push({ kind, seasonId, message, blocking })
  }
  if (seasons.length === 0)
    add('noSeasons', '', 'Choose a season to schedule.', true)
  const usable = fields.filter(field => !field.deleted)
  for (const season of seasons) {
    const s = season.settings
    const name = season.name
    if (s.regularGames === 0 && s.exhibitionGames === 0)
      add('noGames', season.id, `${name} has no games to schedule.`, true)
    const total = season.participants * s.regularGames
    if (total % 2 === 1)
      add(
        'oddTotal',
        season.id,
        `${name}: ${plural(season.participants, 'team')} × ${plural(s.regularGames, 'game')} is ${plural(total, 'team game')}, an odd number, so one team plays one regular-season game fewer.`
      )
    if (s.exhibitionGames > 0 && season.exhibitionTeams === 0)
      add(
        'noExhibitionTeams',
        season.id,
        `${name} has exhibition games but no exhibition teams, so none are scheduled. Flag exhibition teams on the season.`
      )
    else if (s.exhibitionGames > 0) {
      const games = season.participants * s.exhibitionGames
      const each = Math.floor(games / season.exhibitionTeams)
      const more = games % season.exhibitionTeams
      if (more !== 0) {
        const rest = season.exhibitionTeams - more
        add(
          'unevenExhibition',
          season.id,
          `${name}: ${games} exhibition games don’t split evenly over ${plural(season.exhibitionTeams, 'exhibition team')}: ${each + 1} for ${more === 1 ? 'one' : 'some'}, ${each} for ${rest === 1 ? 'the other' : 'the others'}.`
        )
      }
    }
    const sized = usable.filter(field => field.sizes.includes(s.fieldSize))
    if (sized.length === 0)
      add(
        'noField',
        season.id,
        `${name} has no chosen field that sets up as ${fieldSizeLabel(s.fieldSize)}.`,
        true
      )
    for (const field of sized)
      if (
        field.startsOn != null &&
        field.endsOn != null &&
        (field.startsOn > s.startsOn || field.endsOn < s.endsOn)
      )
        add(
          'fieldDates',
          season.id,
          `${field.name} at ${field.venueName} is open ${shortDate(field.startsOn)} to ${shortDate(field.endsOn)}, not all of ${name}.`
        )
    if (s.windows.every(period => period.hours.length === 0))
      add('noWindows', season.id, `${name} has no game windows.`, true)
    else
      for (const gap of windowGaps(s))
        add(
          'windowGap',
          season.id,
          `${name} has no game windows ${dateSpan(gap.from, gap.to)}.`
        )
    for (const period of s.windows)
      for (const day of period.hours)
        if (wallMinutes(day.end) - wallMinutes(day.start) < s.gameMinutes)
          add(
            'shortWindow',
            season.id,
            `${name}: the ${WEEKDAY_NAMES[day.weekday]} window ${day.start}–${day.end} from ${shortDate(period.from)}${period.until == null ? '' : ` to ${shortDate(period.until)}`} is shorter than a ${s.gameMinutes}-minute game.`
          )
  }
  return checks
}

/** Whether a run may be built: no blocking check. */
export function buildable(checks: SchedulingCheck[]): boolean {
  return checks.every(check => !check.blocking)
}
