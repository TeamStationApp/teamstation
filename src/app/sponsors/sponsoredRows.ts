import type { SponsoredRow } from '../../common/sponsors/types'

/** A sponsored row as an item of a Schedule list, among its games. */
export interface SponsoredItem {
  kind: 'sponsored'
  row: SponsoredRow
}

/** A Schedule list's item: one of its own, or a sponsored row. */
export type WithSponsored<T> = T | SponsoredItem

/** Whether a Schedule list's item is a sponsored row. */
export function isSponsored<T>(item: WithSponsored<T>): item is SponsoredItem {
  return (
    typeof item === 'object' &&
    item != null &&
    (item as { kind?: unknown }).kind === 'sponsored' &&
    'row' in item
  )
}

/** A sponsored row's list key, apart from every game's. */
export const sponsoredKey = (item: SponsoredItem): string =>
  `sponsored:${item.row.id}`

/** A list's key for either kind of item. */
export function keyWithSponsored<T>(
  keyOf: (item: T) => string
): (item: WithSponsored<T>) => string {
  return item => (isSponsored(item) ? sponsoredKey(item) : keyOf(item))
}

/** Whether a list holds everything that way: no page left to read. */
export interface ListEnds {
  /** Nothing before the first loaded item. */
  start: boolean
  /** Nothing after the last loaded item. */
  end: boolean
}

/**
 * A Schedule's items with its sponsored rows among them, each at its own
 * `startsAt`: before the first loaded item that starts after it, in
 * `ascending` order, or before the first that starts before it, descending.
 * A row and a game at the same time put the row after the game, either way.
 * An item with no start counts as the latest of all. A row that would go
 * before the first loaded item or after the last goes in only when the list
 * is complete that way, since an unread page may hold what sits between.
 *
 * Only the rows `window` keeps are placed: the list's own `When`
 * (`rowWindow`). Nothing ever moves a row from its time: an added or moved
 * game takes its own place around it.
 */
export function withSponsoredRows<T>(
  items: readonly T[],
  rows: readonly SponsoredRow[],
  startOf: (item: T) => string | null,
  order: 'asc' | 'desc',
  ends: ListEnds,
  window: (row: SponsoredRow) => boolean
): Array<WithSponsored<T>> {
  const kept = rows.filter(window)
  if (kept.length === 0) return [...items]
  const starts = items.map(item => {
    const start = startOf(item)
    return start == null ? Infinity : Date.parse(start)
  })
  /** Where a row goes: before the item at that index, or at the end. */
  const placeOf = (at: number): number => {
    const index = starts.findIndex(start =>
      order === 'asc' ? start > at : start < at
    )
    return index < 0 ? items.length : index
  }
  const before = new Map<number, SponsoredItem[]>()
  const sign = order === 'asc' ? 1 : -1
  const byStart = (a: SponsoredRow, b: SponsoredRow): number => {
    const apart = sign * (Date.parse(a.startsAt) - Date.parse(b.startsAt))
    return apart !== 0 ? apart : a.id.localeCompare(b.id)
  }
  for (const row of [...kept].sort(byStart)) {
    const index = placeOf(Date.parse(row.startsAt))
    if (index === 0 && !ends.start) continue
    if (index === items.length && !ends.end) continue
    before.set(index, [
      ...(before.get(index) ?? []),
      { kind: 'sponsored', row }
    ])
  }
  const spliced: Array<WithSponsored<T>> = []
  items.forEach((item, index) => {
    spliced.push(...(before.get(index) ?? []), item)
  })
  spliced.push(...(before.get(items.length) ?? []))
  return spliced
}
