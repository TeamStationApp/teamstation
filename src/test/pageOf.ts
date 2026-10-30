import type { ListCounts, Page } from '../common/api'

export interface PageQuery {
  cursor?: string | null
  limit?: number
}

export interface PageOfOptions {
  /** The first page's. */
  counts?: ListCounts | null
  /** Where a first page opens, as `around` does: rows either side of it. */
  anchorIndex?: number
  /** The anchored row's id, reported on that first page. */
  anchorId?: string
}

const NEXT = 'next:'
const PREVIOUS = 'prev:'

/**
 * One way for a fake of a paged read to answer: `rows` cut into pages, with
 * cursors that walk them both ways as the server's do.
 *
 * A cursor is the index the next read starts from, or ends before. A fake
 * should not read more into it than the opaque string it is.
 */
export function pageOf<T>(
  rows: readonly T[],
  query: PageQuery = {},
  options: PageOfOptions = {}
): Page<T> {
  const { cursor, limit = 50 } = query
  const answer = (start: number, end: number, first: boolean): Page<T> => ({
    items: rows.slice(start, end),
    nextCursor: end < rows.length ? `${NEXT}${end}` : null,
    prevCursor: start > 0 ? `${PREVIOUS}${start}` : null,
    anchorId: first ? (options.anchorId ?? null) : null,
    counts: first ? (options.counts ?? null) : null
  })
  if (cursor == null) {
    const start =
      options.anchorIndex == null
        ? 0
        : Math.max(0, options.anchorIndex - Math.floor(limit / 2))
    const end = Math.min(rows.length, (options.anchorIndex ?? 0) + limit)
    return answer(start, end, true)
  }
  if (cursor.startsWith(NEXT)) {
    const start = Number(cursor.slice(NEXT.length))
    return answer(start, Math.min(rows.length, start + limit), false)
  }
  if (cursor.startsWith(PREVIOUS)) {
    const end = Number(cursor.slice(PREVIOUS.length))
    return answer(Math.max(0, end - limit), end, false)
  }
  throw new Error(`pageOf: not one of its cursors: ${cursor}`)
}
