/**
 * How the umpire schedule is sorted: zero to two keys, each a field and a
 * direction, then the game's day, start and id.
 *
 * `date` is the calendar day in the zone the schedule is shown in, `season`
 * the season's name, `seasonPriority` the league's season priority (seasons
 * with none after those with one, by name) and `certification` the season's
 * required umpire level. A leading `-` runs a key the other way. `season` and
 * `seasonPriority` are one field, Season, so a sort holds at most one of them.
 * In a query or a route a sort is its keys joined by commas, and `none` is
 * the empty sort.
 */
export const UMPIRE_SORT_KEYS = [
  'date',
  '-date',
  'season',
  '-season',
  'seasonPriority',
  '-seasonPriority',
  'certification',
  '-certification'
] as const
export type UmpireSortKey = (typeof UMPIRE_SORT_KEYS)[number]
export type UmpireSortField = 'date' | 'season' | 'certification'
/** The sort with no league default saved: Date 1→9, then Season A→Z. */
export const DEFAULT_UMPIRE_SORT: UmpireSortKey[] = ['date', 'season']
/** The most keys a sort holds. */
export const UMPIRE_SORT_MOST = 2

export function isUmpireSortKey(value: unknown): value is UmpireSortKey {
  return (
    typeof value === 'string' &&
    (UMPIRE_SORT_KEYS as readonly string[]).includes(value)
  )
}
export function umpireSortDescending(key: UmpireSortKey): boolean {
  return key.startsWith('-')
}
export function umpireSortField(key: UmpireSortKey): UmpireSortField {
  const name = key.replace(/^-/, '')
  return name === 'seasonPriority' ? 'season' : (name as UmpireSortField)
}
/** The glyph pair a key's icon draws: A/Z for names, 1/9 for the rest. */
export function umpireSortGlyph(key: UmpireSortKey): 'AZ' | 'ZA' | '19' | '91' {
  const name = key.replace(/^-/, '')
  const numeric = name === 'date' || name === 'seasonPriority'
  const down = umpireSortDescending(key)
  return numeric ? (down ? '91' : '19') : down ? 'ZA' : 'AZ'
}

/** Whether keys are a sort: at most two, of different fields. */
function isSort(keys: unknown[]): keys is UmpireSortKey[] {
  if (keys.length > UMPIRE_SORT_MOST || !keys.every(isUmpireSortKey))
    return false
  return new Set(keys.map(umpireSortField)).size === keys.length
}
/** A sort as a query spells it, strictly: `none`, or one or two keys. */
export function parseUmpireSort(text: string): UmpireSortKey[] | null {
  if (text === 'none') return []
  const keys = text.split(',')
  return isSort(keys) ? keys : null
}
/** A sort as a JSON body holds it, strictly: an array of up to two keys. */
export function parseUmpireSortArray(value: unknown): UmpireSortKey[] | null {
  return Array.isArray(value) && isSort(value) ? [...value] : null
}
const sortFields = UMPIRE_SORT_KEYS.filter(key => !umpireSortDescending(key))
/**
 * What a refused sort is told: the fields, and, for a query, which spells the
 * empty sort as text, `none`.
 */
export function umpireSortError(spelling: 'query' | 'body'): string {
  const fields = `${sortFields.slice(0, -1).join(', ')} or ${sortFields.at(-1)}`
  return `Choose up to two sorts of different fields: ${fields}, each with an optional leading -${spelling === 'query' ? ', or none' : ''}`
}
/**
 * Keys read leniently: unknown keys, a second key of a field already used and
 * keys past the second valid one are dropped.
 */
function keptKeys(keys: readonly unknown[]): UmpireSortKey[] {
  const kept: UmpireSortKey[] = []
  for (const key of keys) {
    if (kept.length === UMPIRE_SORT_MOST) break
    if (
      isUmpireSortKey(key) &&
      !kept.some(held => umpireSortField(held) === umpireSortField(key))
    )
      kept.push(key)
  }
  return kept
}
/**
 * A sort from a route, leniently (`keptKeys`). Undefined when nothing valid is
 * left (the league default), `[]` for `none`.
 */
export function routeUmpireSort(text?: string): UmpireSortKey[] | undefined {
  if (text == null || text === '') return undefined
  if (text === 'none') return []
  const kept = keptKeys(text.split(','))
  return kept.length === 0 ? undefined : kept
}
/**
 * A sort a server answers, leniently (`keptKeys`), so a key from a newer
 * server degrades rather than failing the answer: `[]` stays the empty sort,
 * and keys with nothing valid among them are undefined (the default).
 */
export function answeredUmpireSort(
  keys: readonly unknown[]
): UmpireSortKey[] | undefined {
  const kept = keptKeys(keys)
  return kept.length === 0 && keys.length > 0 ? undefined : kept
}
/**
 * A league's saved default sort as the database holds it, read as the app
 * reads an answered one (`answeredUmpireSort`): a key a newer build wrote is
 * dropped and the known ones kept, and a default with no known key, or none
 * saved, is null (the built-in default).
 */
export function storedUmpireSort(value: unknown): UmpireSortKey[] | null {
  return Array.isArray(value) ? (answeredUmpireSort(value) ?? null) : null
}
/** A sort as a query or a route spells it. */
export function umpireSortText(sort: readonly UmpireSortKey[]): string {
  return sort.length === 0 ? 'none' : sort.join(',')
}
export function sameUmpireSort(
  a: readonly UmpireSortKey[],
  b: readonly UmpireSortKey[]
): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

/** What a sort reads of a schedule row. */
export interface UmpireSortRow {
  id: string
  /** The start instant, in milliseconds. */
  start: number
  /** The calendar day of `start` in the zone the schedule is shown in. */
  day: string
  seasonId: string
  seasonName: string
  /** The league's position for the season, 1 first; null when it has none. */
  seasonPriority: number | null
  levelName: string
}

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
/** Natural, case-insensitive name order, then code points, so it is total. */
function compareNames(a: string, b: string): number {
  const natural = names.compare(a, b)
  if (natural !== 0) return natural
  return a === b ? 0 : a < b ? -1 : 1
}
function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}
/** By name, then id, so two seasons of one name never interleave. */
function compareSeasons(a: UmpireSortRow, b: UmpireSortRow): number {
  const name = compareNames(a.seasonName, b.seasonName)
  return name !== 0 ? name : compareText(a.seasonId, b.seasonId)
}
type RowOrder = (a: UmpireSortRow, b: UmpireSortRow) => number
function keyOrder(key: UmpireSortKey): RowOrder {
  const sign = umpireSortDescending(key) ? -1 : 1
  switch (key.replace(/^-/, '')) {
    case 'date':
      return (a, b) => sign * compareText(a.day, b.day)
    case 'season':
      return (a, b) => sign * compareSeasons(a, b)
    case 'certification':
      return (a, b) => sign * compareNames(a.levelName, b.levelName)
    default:
      // No priority comes last both ways; ties fall back to name A→Z.
      return (a, b) => {
        const pa = a.seasonPriority
        const pb = b.seasonPriority
        if (pa != null && pb != null && pa !== pb) return sign * (pa - pb)
        if (pa == null && pb != null) return 1
        if (pa != null && pb == null) return -1
        return compareSeasons(a, b)
      }
  }
}
/**
 * The order of rows in `sort`, worked out once for a whole sort: each key in
 * turn, then the day, the start instant and the id, which run newest first
 * under Date 9→1 and oldest first otherwise.
 */
export function umpireRowOrder(sort: readonly UmpireSortKey[]): RowOrder {
  const orders = sort.map(keyOrder)
  const sign = sort.includes('-date') ? -1 : 1
  return (a, b) => {
    for (const order of orders) {
      const placed = order(a, b)
      if (placed !== 0) return placed
    }
    const day = compareText(a.day, b.day)
    if (day !== 0) return sign * day
    const start = a.start - b.start
    if (start !== 0) return sign * start
    return sign * compareText(a.id, b.id)
  }
}
