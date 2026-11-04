import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ListCounts, Page } from '../../common/api'
import { useLatestRequest } from './useLatestRequest'

/** Rows that fill a screen, for a list that does not say. */
const SCREEN_ROWS = 10

export type Way = 'next' | 'previous'

/** A page with nothing on it, which ends a list that holds nothing. */
export const EMPTY_PAGE: Page<never> = {
  items: [],
  nextCursor: null,
  prevCursor: null,
  anchorId: null,
  counts: null
}

export interface PagedListOptions<T> {
  /**
   * Which list this is. A new value drops what is held, and whatever was on
   * its way, so that a late page never lands on another filter.
   */
  listKey: string
  /**
   * Reads a page: the first for `null`, otherwise that of a cursor. `count`
   * asks for that many rows, where the server takes a size: only
   * `refreshHeld` gives one, and only with `largestPage`.
   */
  read: (cursor: string | null, count?: number) => Promise<Page<T>>
  /**
   * The most rows the server answers in one read, for a list that takes a
   * size. `refreshHeld` then reads the held rows in pages this large, not
   * in pages of the usual size.
   */
  largestPage?: number
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
  /** The directions a page is on its way in: both may be at once. */
  walking: Record<Way, boolean>
  /** Which end failed, and shows the Retry row. */
  failed: Way | undefined
  /** A first page or a refresh that failed. */
  error: unknown
  /** How many first pages have replaced the list, rather than laid over it. */
  opened: number
}

export interface PagedRows<T> {
  rows: T[]
  /**
   * Counts each first page that replaced what was held, so that a screen can
   * tell a fresh list from the same one read on or read again.
   */
  opened: number
  counts: ListCounts | null
  anchorId: string | null
  /** No rows yet, and some may come: the spinner, not the empty message. */
  loading: boolean
  /** The list has been read to its end and holds nothing. */
  empty: boolean
  /**
   * The end is being read. An older page on its way says nothing: it lands
   * at rest above the reader, and a spinner after the last row would point
   * the wrong way.
   */
  loadingMore: boolean
  /** The end could not be read: `Could not load more`, and Retry. */
  failed: boolean
  /**
   * Which way the read that failed went: `previous` is at the top of the
   * list, where its Retry goes, and `next` at the bottom.
   */
  failedWay: Way | undefined
  error: unknown
  loadMore: () => Promise<void>
  /** Reads older rows, holding each page until `atRest` answers. */
  loadOlder: (atRest?: () => Promise<void>) => Promise<void>
  /** `loadMore` or `loadOlder` again, whichever failed. */
  retry: () => Promise<void>
  /** Reads the first page and lays it over the rows it covers. */
  refresh: () => Promise<void>
  /** `refresh`, for a first page the screen read for itself. */
  apply: (page: Page<T>) => Promise<void>
  /**
   * Reads every held page again, in place: in as few reads as `largestPage`
   * allows, or a page at a time.
   */
  refreshHeld: () => Promise<void>
  /**
   * A first page the screen read for itself, which failed: the list stops
   * opening and holds the failure, for its Retry. An open list is left be.
   */
  fail: (error: unknown) => void
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
    walking: { next: false, previous: false },
    failed: undefined,
    error: undefined,
    opened: 0
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
  /** The latest refresh: an earlier one's answer is out of date. */
  const refreshes = useRef(0)
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

  /** The rows, each key once: where it first came, as it last read. */
  const unique = useCallback((rows: T[]): T[] => {
    const { keyOf } = latest.current
    return [...new Map(rows.map(row => [keyOf(row), row])).values()]
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
          change({
            walking: { ...held.current.walking, [way]: true },
            failed: undefined
          })
          const page = await latest.current.read(cursor)
          if (way === 'previous' && current()) await olderLands.current()
          if (!current()) return
          // A refresh spliced over that end while the page was on its way:
          // the page belongs to rows no longer held, and the reader's next
          // arrival there reads on from the end that is.
          if (cursorNow() !== cursor) break
          const added = add(way, cursor, page)
          const { screenRows = SCREEN_ROWS } = latest.current
          if (added >= screenRows) break
        }
        if (current())
          change({ walking: { ...held.current.walking, [way]: false } })
      } catch {
        if (current())
          change({
            walking: { ...held.current.walking, [way]: false },
            failed: way
          })
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
        opening: false,
        opened: held.current.opened + 1
      })
    },
    [begin, kept, set, unique]
  )

  /**
   * A page's rows laid over those they cover, or `undefined` if none.
   *
   * A first page around the next game starts later once a game has passed.
   * The held rows before its first one stay, as rows above it, since no
   * cursor would read them again.
   */
  const spliced = useCallback(
    (page: Page<T>): Partial<Held<T>> | undefined => {
      const { keyOf } = latest.current
      const { rows, above, nextCursor, prevCursor } = held.current
      const first = page.items.at(0)
      if (first == null) return undefined
      const at = new Map(rows.map((row, index) => [keyOf(row), index]))
      // The page covers held rows up to its last one that is held: a row
      // new in its last slot does not throw away the pages read past it.
      let end = -1
      for (let index = page.items.length - 1; index >= 0; index--) {
        const heldAt = at.get(keyOf(page.items[index])) ?? -1
        if (heldAt >= above) {
          end = heldAt
          break
        }
      }
      if (end < 0) return undefined
      const start = at.get(keyOf(first)) ?? -1
      const from = start > above && start <= end ? start : above
      return {
        rows: unique([
          ...rows.slice(0, from),
          ...kept(page.items),
          ...rows.slice(end + 1)
        ]),
        nextCursor: end === rows.length - 1 ? page.nextCursor : nextCursor,
        prevCursor: from > 0 ? prevCursor : page.prevCursor,
        counts: page.counts ?? held.current.counts,
        anchorId: page.anchorId,
        above: from
      }
    },
    [kept, unique]
  )

  const apply = useCallback(
    async (page: Page<T>): Promise<void> => {
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
        over.above === now.above &&
        JSON.stringify(over.counts) === JSON.stringify(now.counts)
      change({
        ...(unchanged ? {} : over),
        answered: true,
        opening: false,
        error: undefined
      })
    },
    [change, replace, spliced, walk]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const turn = ++refreshes.current
    const inEra = era.current
    const current = (): boolean => turn === refreshes.current && inEra()
    let page: Page<T>
    try {
      page = await latest.current.read(null)
    } catch (caught) {
      if (current()) change({ error: caught, opening: false })
      return
    }
    if (current()) await apply(page)
  }, [apply, change])

  const refreshHeld = useCallback(async (): Promise<void> => {
    const { keyOf } = latest.current
    const current = era.current
    const lastRow = held.current.rows.at(-1)
    if (lastRow == null) {
      await refresh()
      return
    }
    const lastKey = keyOf(lastRow)
    const firstHeldKey = keyOf(held.current.rows[0])
    const heldRows = held.current.rows.length
    const topCursor = held.current.topCursor
    const { largestPage } = latest.current
    const rows: T[] = []
    let cursor = topCursor
    let top: Page<T> | undefined
    let next: string | null = null
    let covered = false
    let pages = 0
    // As many rows as are held, and a page more for rows added above the
    // last: a last row gone from the server is not looked for to the end.
    let most = heldRows + 1
    try {
      do {
        // Where the server takes a size, the rest of the held rows in one
        // read if it can, and then a page past them. Only a read forward
        // takes one: an older page's cursor sized would answer rows before
        // it that the reader never read, so it is read as it was loaded.
        const rest = heldRows - rows.length
        const olderTop = pages === 0 && topCursor != null
        const count =
          largestPage == null || olderTop
            ? undefined
            : Math.min(largestPage, rest > 0 ? rest : most - heldRows)
        const page: Page<T> = await latest.current.read(cursor, count)
        if (!current()) return
        if (top == null) {
          top = page
          most = heldRows + Math.max(1, page.items.length)
        }
        pages += 1
        rows.push(...page.items)
        next = page.nextCursor
        cursor = next
        covered = page.items.some(row => keyOf(row) === lastKey)
      } while (!covered && next != null && rows.length < most && pages < most)
    } catch (caught) {
      if (current()) change({ error: caught })
      return
    }
    // A page that landed behind these reads stays, with the cursor after it.
    const now = held.current
    const lastAt = now.rows.findIndex(row => keyOf(row) === lastKey)
    const behind = lastAt < 0 ? [] : now.rows.slice(lastAt + 1)
    // A first page around the next game that starts later leaves the held
    // rows before it above it, as `apply` does. Read from an older page,
    // the rows start at the top row held when the reads began: an older page
    // that landed above it meanwhile stays, with the cursors that read it.
    const firstKey =
      topCursor != null
        ? firstHeldKey
        : rows.length === 0
          ? undefined
          : keyOf(rows[0])
    const startAt =
      firstKey == null ? -1 : now.rows.findIndex(row => keyOf(row) === firstKey)
    const before =
      startAt > 0 && (lastAt < 0 || startAt <= lastAt)
        ? now.rows.slice(0, startAt)
        : []
    const fresh = unique(kept([...before, ...rows, ...behind]))
    // The older rows read again stay above the first page: it starts where
    // its first held row now stands.
    const firstOfPage = now.rows.at(now.above)
    const pageAt =
      firstOfPage == null
        ? -1
        : fresh.findIndex(row => keyOf(row) === keyOf(firstOfPage))
    change({
      rows: fresh,
      nextCursor: behind.length > 0 ? now.nextCursor : next,
      prevCursor:
        before.length > 0 ? now.prevCursor : (top?.prevCursor ?? null),
      counts: top?.counts ?? now.counts,
      above:
        topCursor == null
          ? before.length
          : pageAt >= 0
            ? pageAt
            : Math.min(now.above, fresh.length),
      error: undefined
    })
  }, [change, kept, refresh, unique])

  const fail = useCallback(
    (error: unknown): void => {
      if (held.current.opening) change({ opening: false, error })
    },
    [change]
  )

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
      // Left short with a cursor, as a short page would: nothing else reads
      // on, since Legend List has already reported this end.
      const { screenRows = SCREEN_ROWS } = latest.current
      if (rows.length - 1 < screenRows) walk('next').catch(() => undefined)
    },
    [change, walk]
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
    const loading =
      rows.length === 0 && (opening || walking.next || walking.previous)
    return {
      rows,
      opened: shown.opened,
      counts: shown.counts,
      anchorId: shown.anchorId,
      loading: loading && error == null,
      empty: rows.length === 0 && !loading && failed == null && error == null,
      loadingMore: walking.next && rows.length > 0,
      failed: failed != null,
      failedWay: failed,
      error,
      loadMore,
      loadOlder,
      retry,
      refresh,
      apply,
      refreshHeld,
      fail,
      paint,
      update,
      remove
    }
  }, [
    apply,
    fail,
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
