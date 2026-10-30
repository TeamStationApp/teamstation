import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ListCounts, Page } from '../../common/api'
import { useLatestRequest } from './useLatestRequest'

/** Rows that fill a screen, for a list that does not say. */
const SCREEN_ROWS = 10

type Way = 'next' | 'previous'

export interface PagedListOptions<T> {
  /**
   * Which list this is. A new value drops what is held, and whatever was on
   * its way, so that a late page never lands on another filter.
   */
  listKey: string
  /** Reads a page: the first for `null`, otherwise that of a cursor. */
  read: (cursor: string | null) => Promise<Page<T>>
  keyOf: (row: T) => string
  /** A page adding fewer than this is followed at once by the next. */
  screenRows?: number
  /** Whether two reads of a row draw the same. By default, as written out. */
  same?: (a: T, b: T) => boolean
  /** Off when the screen decides when to read, as a scoped screen does. */
  auto?: boolean
}

interface Held<T> {
  listKey: string
  rows: T[]
  nextCursor: string | null
  prevCursor: string | null
  counts: ListCounts | null
  anchorId: string | null
  /** The cursor of the topmost page read: `null` is the first page. */
  topCursor: string | null
  /** Rows read above the first page, which a refresh leaves alone. */
  above: number
  /** The server has answered, so a stored page may no longer go under it. */
  answered: boolean
  /** A first read has not come back. */
  opening: boolean
  /** A page is on its way in that direction. */
  walking: Way | undefined
  /** Which end failed, and shows the Retry row. */
  failed: Way | undefined
  /** A first page or a refresh that failed. */
  error: unknown
}

export interface PagedRows<T> {
  rows: T[]
  counts: ListCounts | null
  anchorId: string | null
  /** No rows yet, and some may come: the spinner, not the empty message. */
  loading: boolean
  /** The list has been read to its end and holds nothing. */
  empty: boolean
  /** The end is being read. */
  loadingMore: boolean
  /** The end could not be read: `Could not load more`, and Retry. */
  failed: boolean
  error: unknown
  loadMore: () => Promise<void>
  /** Reads older rows, holding each page until `atRest` answers. */
  loadOlder: (atRest?: () => Promise<void>) => Promise<void>
  /** `loadMore` or `loadOlder` again, whichever failed. */
  retry: () => Promise<void>
  /** Reads the first page and lays it over the rows it covers. */
  refresh: () => Promise<void>
  /** Reads every held page again, in place. */
  refreshHeld: () => Promise<void>
  /** A stored first page, under anything the server has given. */
  paint: (page: Page<T>) => void
  update: (key: string, change: (row: T) => T) => void
  remove: (key: string) => void
}

function nothingHeld<T>(listKey: string): Held<T> {
  return {
    listKey,
    rows: [],
    nextCursor: null,
    prevCursor: null,
    counts: null,
    anchorId: null,
    topCursor: null,
    above: 0,
    answered: false,
    opening: true,
    walking: undefined,
    failed: undefined,
    error: undefined
  }
}

function sameWhenWritten<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The rows of a list, read from the server a page at a time.
 *
 * A row in place when a read comes back keeps its identity, so that its card
 * is not drawn again. A list that has not changed keeps its array.
 */
export function usePagedList<T>(options: PagedListOptions<T>): PagedRows<T> {
  const { listKey, auto = true } = options
  const latest = useRef(options)
  latest.current = options
  const held = useRef<Held<T>>(nothingHeld(listKey))
  const [view, setView] = useState(held.current)
  const set = useCallback((next: Held<T>): void => {
    held.current = next
    setView(next)
  }, [])
  const change = useCallback(
    (fields: Partial<Held<T>>): void => {
      set({ ...held.current, ...fields })
    },
    [set]
  )

  const begin = useLatestRequest()
  /** Whether what is held is still the list a read was started for. */
  const era = useRef<() => boolean>(() => false)
  /** The walk under way each way, one at a time, in the era it began. */
  const walks = useRef<Partial<Record<Way, () => boolean>>>({})
  /** What an older page waits for before it lands above the reader. */
  const olderLands = useRef<() => Promise<void>>(async () => undefined)

  /** Each row as held, wherever the new read has it the same. */
  const kept = useCallback((rows: readonly T[]): T[] => {
    const { keyOf, same = sameWhenWritten } = latest.current
    const byKey = new Map(held.current.rows.map(row => [keyOf(row), row]))
    return rows.map(row => {
      const old = byKey.get(keyOf(row))
      return old != null && (old === row || same(old, row)) ? old : row
    })
  }, [])

  /** The rows, each key once, whichever end a repeat came in from. */
  const unique = useCallback((rows: T[]): T[] => {
    const { keyOf } = latest.current
    const seen = new Set<string>()
    return rows.filter(row => {
      const key = keyOf(row)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [])

  const add = useCallback(
    (way: Way, cursor: string, page: Page<T>): number => {
      const now = held.current
      const before = now.rows.length
      const rows =
        way === 'next'
          ? unique([...now.rows, ...page.items])
          : unique([...page.items, ...now.rows])
      const added = rows.length - before
      change(
        way === 'next'
          ? { rows, nextCursor: page.nextCursor }
          : {
              rows,
              prevCursor: page.prevCursor,
              topCursor: cursor,
              above: now.above + added
            }
      )
      return added
    },
    [change, unique]
  )

  /**
   * Reads on from one end. Legend List does not report an end again until the
   * reader has moved well away from it, so a page that leaves the screen
   * short is followed at once by the next, for as long as there is a cursor.
   */
  const walk = useCallback(
    async (way: Way): Promise<void> => {
      const current = era.current
      if (walks.current[way] === current) return
      const cursorNow = (): string | null =>
        way === 'next' ? held.current.nextCursor : held.current.prevCursor
      if (cursorNow() == null || !current()) return
      walks.current[way] = current
      try {
        for (;;) {
          const cursor = cursorNow()
          if (cursor == null) break
          change({ walking: way, failed: undefined })
          const page = await latest.current.read(cursor)
          if (way === 'previous' && current()) await olderLands.current()
          if (!current()) return
          const added = add(way, cursor, page)
          const { screenRows = SCREEN_ROWS } = latest.current
          if (added >= screenRows) break
        }
        change({ walking: undefined })
      } catch {
        if (current()) change({ walking: undefined, failed: way })
      } finally {
        if (walks.current[way] === current) walks.current[way] = undefined
      }
    },
    [add, change]
  )

  const replace = useCallback(
    (page: Page<T>): void => {
      era.current = begin()
      set({
        ...nothingHeld(held.current.listKey),
        rows: unique(kept(page.items)),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        counts: page.counts,
        anchorId: page.anchorId,
        answered: true,
        opening: false
      })
    },
    [begin, kept, set, unique]
  )

  /** A page's rows laid over those they cover, or `undefined` if none. */
  const spliced = useCallback(
    (page: Page<T>): Partial<Held<T>> | undefined => {
      const { keyOf } = latest.current
      const { rows, above, nextCursor, prevCursor } = held.current
      const last = page.items.at(-1)
      if (last == null) return undefined
      const lastKey = keyOf(last)
      const end = rows.findIndex(row => keyOf(row) === lastKey)
      if (end < above) return undefined
      return {
        rows: unique([
          ...rows.slice(0, above),
          ...kept(page.items),
          ...rows.slice(end + 1)
        ]),
        nextCursor: end === rows.length - 1 ? page.nextCursor : nextCursor,
        prevCursor: above > 0 ? prevCursor : page.prevCursor,
        counts: page.counts ?? held.current.counts,
        anchorId: page.anchorId
      }
    },
    [kept, unique]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const current = era.current
    let page: Page<T>
    try {
      page = await latest.current.read(null)
    } catch (caught) {
      if (current()) change({ error: caught, opening: false })
      return
    }
    if (!current()) return
    const over = spliced(page)
    if (over == null) {
      replace(page)
      const { screenRows = SCREEN_ROWS } = latest.current
      if (held.current.rows.length < screenRows) await walk('next')
      return
    }
    const now = held.current
    const unchanged =
      over.rows?.length === now.rows.length &&
      over.rows.every((row, index) => row === now.rows[index]) &&
      over.nextCursor === now.nextCursor &&
      over.prevCursor === now.prevCursor &&
      over.anchorId === now.anchorId &&
      JSON.stringify(over.counts) === JSON.stringify(now.counts)
    change({
      ...(unchanged ? {} : over),
      answered: true,
      opening: false,
      error: undefined
    })
  }, [change, replace, spliced, walk])

  const refreshHeld = useCallback(async (): Promise<void> => {
    const { keyOf } = latest.current
    const current = era.current
    const lastRow = held.current.rows.at(-1)
    if (lastRow == null) {
      await refresh()
      return
    }
    const lastKey = keyOf(lastRow)
    const topCursor = held.current.topCursor
    const rows: T[] = []
    let cursor = topCursor
    let top: Page<T> | undefined
    let next: string | null = null
    let covered = false
    try {
      do {
        const page: Page<T> = await latest.current.read(cursor)
        if (!current()) return
        top ??= page
        rows.push(...page.items)
        next = page.nextCursor
        cursor = next
        covered = page.items.some(row => keyOf(row) === lastKey)
      } while (!covered && next != null)
    } catch (caught) {
      if (current()) change({ error: caught })
      return
    }
    const now = held.current
    change({
      rows: unique(kept(rows)),
      nextCursor: next,
      prevCursor: top?.prevCursor ?? null,
      counts: top?.counts ?? now.counts,
      above: topCursor == null ? 0 : now.above,
      error: undefined
    })
  }, [change, kept, refresh, unique])

  const paint = useCallback(
    (page: Page<T>): void => {
      if (held.current.answered) return
      change({
        rows: unique(kept(page.items)),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        counts: page.counts,
        anchorId: page.anchorId
      })
    },
    [change, kept, unique]
  )

  const update = useCallback(
    (key: string, edit: (row: T) => T): void => {
      const { keyOf } = latest.current
      change({
        rows: held.current.rows.map(row =>
          keyOf(row) === key ? edit(row) : row
        )
      })
    },
    [change]
  )

  const remove = useCallback(
    (key: string): void => {
      const { keyOf } = latest.current
      const { rows, above } = held.current
      const at = rows.findIndex(row => keyOf(row) === key)
      if (at < 0) return
      change({
        rows: rows.filter((_row, index) => index !== at),
        above: at < above ? above - 1 : above
      })
    },
    [change]
  )

  useEffect(() => {
    era.current = begin()
    walks.current = {}
    if (held.current.listKey !== listKey) set(nothingHeld(listKey))
    if (auto) refresh().catch(() => undefined)
  }, [auto, begin, listKey, refresh, set])

  const loadMore = useCallback(async () => {
    await walk('next')
  }, [walk])
  const loadOlder = useCallback(
    async (atRest?: () => Promise<void>) => {
      if (atRest != null) olderLands.current = atRest
      await walk('previous')
    },
    [walk]
  )
  const retry = useCallback(async () => {
    const way = held.current.failed
    if (way != null) await walk(way)
  }, [walk])

  // A list told it is another one has this one's rows for one render.
  const shown = view.listKey === listKey ? view : nothingHeld<T>(listKey)
  return useMemo(() => {
    const { rows, walking, failed, opening, error } = shown
    const loading = rows.length === 0 && (opening || walking != null)
    return {
      rows,
      counts: shown.counts,
      anchorId: shown.anchorId,
      loading: loading && error == null,
      empty: rows.length === 0 && !loading && failed == null && error == null,
      loadingMore: walking != null && rows.length > 0,
      failed: failed != null,
      error,
      loadMore,
      loadOlder,
      retry,
      refresh,
      refreshHeld,
      paint,
      update,
      remove
    }
  }, [
    loadMore,
    loadOlder,
    paint,
    refresh,
    refreshHeld,
    remove,
    retry,
    shown,
    update
  ])
}
