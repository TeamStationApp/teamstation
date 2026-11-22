import { base64url } from 'rfc4648'

import { badRequest } from '../../common/errors'
import {
  parseUmpireSort,
  umpireRowOrder,
  type UmpireSortKey,
  type UmpireSortRow,
  umpireSortText
} from '../../common/umpireSort'
import type { PageCut } from '../schedule/scheduleCursor'

/**
 * Where a page of the umpire schedule stops.
 *
 * The schedule runs in a sort (`common/umpireSort`), and its order is total,
 * so the keys of a row are a place in the list. The cursor holds its sort
 * and the boundary row's keys, so a page read with it is in its sort whatever
 * the league default became, and it still places the next page when the
 * boundary row is gone. `next` reads on from that place and `prev` reads back.
 */
export interface UmpireCursor {
  sort: UmpireSortKey[]
  row: UmpireSortRow
  direction: 'next' | 'prev'
}

export function encodeUmpireCursor(cursor: UmpireCursor): string {
  const { sort, row, direction } = cursor
  return base64url.stringify(
    new TextEncoder().encode(
      JSON.stringify({
        sort: umpireSortText(sort),
        row: [
          row.day,
          new Date(row.start).toISOString(),
          row.id,
          row.seasonId,
          row.seasonName,
          row.seasonPriority,
          row.levelName
        ],
        direction
      })
    ),
    { pad: false }
  )
}

const notOurs = 'cursor is not a cursor this list gave'

/** The cursor a request carries. Anything else is a 400. */
export function decodeUmpireCursor(text: string): UmpireCursor {
  let fields: unknown
  try {
    fields = JSON.parse(
      new TextDecoder().decode(base64url.parse(text, { loose: true }))
    )
  } catch {
    throw badRequest(notOurs)
  }
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields))
    throw badRequest(notOurs)
  const { sort: sortText, row, direction } = fields as Record<string, unknown>
  const sort = typeof sortText === 'string' ? parseUmpireSort(sortText) : null
  if (
    sort == null ||
    (direction !== 'next' && direction !== 'prev') ||
    !Array.isArray(row) ||
    row.length !== 7
  )
    throw badRequest(notOurs)
  const [day, startAt, id, seasonId, seasonName, seasonPriority, levelName] =
    row as unknown[]
  if (
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    typeof startAt !== 'string' ||
    Number.isNaN(Date.parse(startAt)) ||
    typeof id !== 'string' ||
    id === '' ||
    typeof seasonId !== 'string' ||
    typeof seasonName !== 'string' ||
    (seasonPriority !== null && !Number.isInteger(seasonPriority)) ||
    typeof levelName !== 'string'
  )
    throw badRequest(notOurs)
  return {
    sort,
    row: {
      day,
      start: Date.parse(startAt),
      id,
      seasonId,
      seasonName,
      seasonPriority: seasonPriority as number | null,
      levelName
    },
    direction
  }
}

/**
 * The cursor at `row`, or, with no row (an empty page), at `fallback`, the
 * place the page was read from.
 */
function cursorAt<T>(
  row: T | undefined,
  keys: (row: T) => UmpireSortRow,
  sort: UmpireSortKey[],
  direction: UmpireCursor['direction'],
  fallback?: UmpireSortRow
): string {
  const place = row === undefined ? fallback! : keys(row)
  return encodeUmpireCursor({ sort, row: place, direction })
}

/** A first page of `rows`, which are in `sort`. */
export function umpireFirstPage<T>(
  rows: readonly T[],
  limit: number,
  sort: UmpireSortKey[],
  keys: (row: T) => UmpireSortRow
): PageCut<T> {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor:
      rows.length > limit
        ? cursorAt(items[limit - 1], keys, sort, 'next')
        : null,
    prevCursor: null
  }
}

/**
 * A page of `rows`, which are in `sort`: the first, or the cursor's, read in
 * the cursor's sort. The way a cursor came from always has a row, its own, so
 * that side's cursor is always there, and an empty page leaves from the place
 * it was read from.
 */
export function umpirePageOfHeld<T>(
  rows: readonly T[],
  limit: number,
  sort: UmpireSortKey[],
  keys: (row: T) => UmpireSortRow,
  cursor?: UmpireCursor
): PageCut<T> {
  if (cursor == null) return umpireFirstPage(rows, limit, sort, keys)
  const order = umpireRowOrder(cursor.sort)
  const place = (row: T): number => order(keys(row), cursor.row)
  const at = (
    row: T | undefined,
    direction: UmpireCursor['direction']
  ): string => cursorAt(row, keys, cursor.sort, direction, cursor.row)
  if (cursor.direction === 'next') {
    const read = rows.filter(row => place(row) > 0)
    const items = read.slice(0, limit)
    return {
      items,
      nextCursor: read.length > limit ? at(items[limit - 1], 'next') : null,
      prevCursor: at(items[0], 'prev')
    }
  }
  const read = rows.filter(row => place(row) < 0)
  const items = read.slice(Math.max(0, read.length - limit))
  return {
    items,
    nextCursor: at(items.at(-1), 'next'),
    prevCursor: read.length > limit ? at(items[0], 'prev') : null
  }
}

/**
 * `limit / 2` rows before the row at `index` of `rows`, which are in `sort`,
 * and `limit` from it.
 */
export function umpirePageAround<T>(
  rows: readonly T[],
  index: number,
  limit: number,
  sort: UmpireSortKey[],
  keys: (row: T) => UmpireSortRow
): PageCut<T> {
  const start = Math.max(0, index - Math.floor(limit / 2))
  const end = index + limit
  const items = rows.slice(start, end)
  return {
    items,
    nextCursor:
      end < rows.length ? cursorAt(items.at(-1), keys, sort, 'next') : null,
    prevCursor: start > 0 ? cursorAt(items[0], keys, sort, 'prev') : null
  }
}
