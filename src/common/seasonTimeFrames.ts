export interface SeasonTimeFrame {
  label: string
  startsOn: string
  endsOn: string
}

function frame(ordinal: number): SeasonTimeFrame {
  const year = Math.floor(ordinal / 4)
  const season = ((ordinal % 4) + 4) % 4
  if (season === 3)
    return {
      label: `Winter ${year}`,
      startsOn: `${year}-12-01`,
      endsOn: `${year + 1}-02-28`
    }
  return {
    label: `${['Spring', 'Summer', 'Fall'][season]} ${year}`,
    startsOn: `${year}-${['03', '06', '09'][season]}-01`,
    endsOn: `${year}-${['05', '08', '11'][season]}-${season === 2 ? '30' : '31'}`
  }
}

/** The four seasons a season's date range may be set to. */
export type SeasonName = 'Winter' | 'Spring' | 'Summer' | 'Fall'

const SEASON_INDEX: Record<SeasonName, number> = {
  Spring: 0,
  Summer: 1,
  Fall: 2,
  Winter: 3
}

/**
 * The dates of one season of `year`: Spring is March to May, Summer June to
 * August, Fall September to November, and Winter December of `year` to
 * February 28 of the next.
 */
export function presetFrame(year: number, season: SeasonName): SeasonTimeFrame {
  return frame(year * 4 + SEASON_INDEX[season])
}

/** Which season of which year these dates are exactly, if they are one. */
export function presetOf(
  startsOn: string | null,
  endsOn: string | null
): { year: number; season: SeasonName } | null {
  const year = Number(startsOn?.slice(0, 4))
  if (!Number.isInteger(year)) return null
  for (const season of Object.keys(SEASON_INDEX) as SeasonName[]) {
    const candidate = presetFrame(year, season)
    if (candidate.startsOn === startsOn && candidate.endsOn === endsOn)
      return { year, season }
  }
  return null
}

/** Winter uses the year in which it starts; January belongs to last year's Winter. */
export function seasonTimeFrames(now = new Date()): SeasonTimeFrame[] {
  if (!Number.isFinite(now.getTime()))
    throw new TypeError('Choose a valid reference date')
  const current = now.getFullYear() * 4 + Math.floor((now.getMonth() - 2) / 3)
  return [current, current - 1, current + 1, current + 2].map(frame)
}

export function formatDateRange(
  startsOn: string | null,
  endsOn: string | null
): string {
  if (startsOn == null || endsOn == null) return 'Time frame not set'
  const format = (day: string): string =>
    new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    })
  return startsOn === endsOn
    ? format(startsOn)
    : `${format(startsOn)} – ${format(endsOn)}`
}

/**
 * How a season names its time frame on a list: `Spring 2026` when its dates
 * are exactly one of the time frames creation offers, and the dates
 * themselves for custom ranges, regardless of how they were entered.
 *
 * A season stores only its dates, so the choice is read back from them.
 */
export function seasonPeriodLabel(
  startsOn: string | null,
  endsOn: string | null
): string {
  const year = Number(startsOn?.slice(0, 4))
  if (Number.isInteger(year))
    for (let season = 0; season < 4; season++) {
      const candidate = frame(year * 4 + season)
      if (candidate.startsOn === startsOn && candidate.endsOn === endsOn)
        return candidate.label
    }
  return formatDateRange(startsOn, endsOn)
}
