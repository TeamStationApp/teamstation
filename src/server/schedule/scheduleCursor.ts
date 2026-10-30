import { base64url } from 'rfc4648'

import { badRequest } from '../../common/errors'

/**
 * Where a page of a schedule stops.
 *
 * A list runs by `start_at`, then `id` in byte order, in one direction, and
 * every start is `not null`, so a start and an id are a place in any list.
 * `next` reads on from that place, and `prev` reads back from it. A cursor
 * carries its list's order, so the query that follows it need not say it and
 * cannot walk the other way by leaving it out. It names no filter: the rest
 * of the query is the one that was given it.
 */
export interface ScheduleCursor {
  startAt: string
  id: string
  direction: 'next' | 'prev'
  order: ListOrder
}

export type ListOrder = 'asc' | 'desc'

interface Placed {
  id: string
  startAt: string | null
}

/** The rows of a page, and how to leave it either way. */
export interface PageCut<T> {
  items: T[]
  nextCursor: string | null
  prevCursor: string | null
}

export function encodeScheduleCursor(cursor: ScheduleCursor): string {
  const { startAt, id, direction, order } = cursor
  return base64url.stringify(
    new TextEncoder().encode(JSON.stringify([startAt, id, direction, order])),
    { pad: false }
  )
}

function isCursorDate(text: string): boolean {
  const time = Date.parse(text)
  return !Number.isNaN(time) && new Date(time).toISOString() === text
}

/** The cursor a request carries. Anything else is a 400. */
export function decodeScheduleCursor(text: string): ScheduleCursor {
  let fields: unknown
  try {
    fields = JSON.parse(
      new TextDecoder().decode(base64url.parse(text, { loose: true }))
    )
  } catch {
    throw badRequest('cursor is not a cursor this list gave')
  }
  if (Array.isArray(fields) && fields.length === 4) {
    const [startAt, id, direction, order] = fields as unknown[]
    if (
      typeof startAt === 'string' &&
      isCursorDate(startAt) &&
      typeof id === 'string' &&
      id !== '' &&
      (direction === 'next' || direction === 'prev') &&
      (order === 'asc' || order === 'desc')
    )
      return { startAt, id, direction, order }
  }
  throw badRequest('cursor is not a cursor this list gave')
}

/** The order to read rows in to walk the cursor's list in its direction. */
export function readingOrder(cursor: ScheduleCursor): ListOrder {
  if (cursor.direction === 'next') return cursor.order
  return cursor.order === 'asc' ? 'desc' : 'asc'
}

/** Which of two places runs first in `asc`, by start and then by `id`. */
function comparePlaces(a: Placed, b: Placed): number {
  const date = Date.parse(a.startAt!) - Date.parse(b.startAt!)
  if (date !== 0) return date
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
}

/**
 * Whether `row` comes after the cursor's place as the cursor reads, by what
 * JavaScript sees of a start, to the millisecond.
 */
export function pastCursor(row: Placed, cursor: ScheduleCursor): boolean {
  const sign = readingOrder(cursor) === 'asc' ? 1 : -1
  return comparePlaces(row, cursor) * sign > 0
}

/** Rows as a list of `order` runs, which is the order a cursor walks. */
export function inListOrder<T extends Placed>(
  rows: readonly T[],
  order: ListOrder
): T[] {
  const sign = order === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => comparePlaces(a, b) * sign)
}

function cursorAt(
  row: Placed,
  direction: ScheduleCursor['direction'],
  order: ListOrder
): string {
  // A proposal's start is as it was written, so it is put in one spelling.
  const startAt = new Date(row.startAt!).toISOString()
  return encodeScheduleCursor({ startAt, id: row.id, direction, order })
}

/** A first page of a list in its order. */
export function firstPage<T extends Placed>(
  rows: readonly T[],
  limit: number,
  order: ListOrder
): PageCut<T> {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor:
      rows.length > limit ? cursorAt(items[limit - 1], 'next', order) : null,
    prevCursor: null
  }
}

/**
 * The page a cursor reads, from up to `limit + 1` rows in its reading order.
 *
 * The extra row says more lie that way. The way it came from always has a
 * row, the cursor's own, so that side's cursor is always there, and an empty
 * page leaves from the place it was read from.
 */
export function pageFromCursor<T extends Placed>(
  rows: readonly T[],
  limit: number,
  cursor: ScheduleCursor
): PageCut<T> {
  const { order } = cursor
  const more = rows.length > limit
  const read = rows.slice(0, limit)
  if (cursor.direction === 'next') {
    return {
      items: read,
      nextCursor: more ? cursorAt(read[limit - 1], 'next', order) : null,
      prevCursor: cursorAt(read[0] ?? cursor, 'prev', order)
    }
  }
  const items = read.reverse()
  return {
    items,
    nextCursor: cursorAt(items.at(-1) ?? cursor, 'next', order),
    prevCursor: more ? cursorAt(items[0], 'prev', order) : null
  }
}

/** A page of a list held whole: its first in `order`, or the cursor's. */
export function pageOfHeld<T extends Placed>(
  rows: readonly T[],
  order: ListOrder,
  limit: number,
  cursor?: ScheduleCursor
): PageCut<T> {
  if (cursor == null) return firstPage(inListOrder(rows, order), limit, order)
  const read = inListOrder(rows, readingOrder(cursor)).filter(row =>
    pastCursor(row, cursor)
  )
  return pageFromCursor(read.slice(0, limit + 1), limit, cursor)
}

/**
 * `limit / 2` rows before the row at `index`, and `limit` from it, of a list
 * in `asc` order, which is the only way a page around a row runs.
 */
export function pageAround<T extends Placed>(
  rows: readonly T[],
  index: number,
  limit: number
): PageCut<T> {
  const start = Math.max(0, index - Math.floor(limit / 2))
  const end = index + limit
  const items = rows.slice(start, end)
  return {
    items,
    nextCursor:
      end < rows.length ? cursorAt(items.at(-1)!, 'next', 'asc') : null,
    prevCursor: start > 0 ? cursorAt(items[0], 'prev', 'asc') : null
  }
}
