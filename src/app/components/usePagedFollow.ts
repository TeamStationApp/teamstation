import type { LegendListRef } from '@legendapp/list/react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWindowDimensions } from 'react-native'

import type { PagedListProps } from './pagedListProps'
import type { PageScrollSource } from './pageScroll'
import { usePageActive } from './TabPages'

/** Screens of rows from an end at which the next page is read. */
export const EDGE_SCREENS = 1.5

/** Moves smaller than this are rounding, not a row that shifted. */
const SHIFT_PX = 0.5

// The scroller is the screen's, and knows nothing of a row resizing. What
// anchoring it needs is the position keeper's.
const NO_POSITION_KEEPING = { size: false, data: false }

interface Tracked {
  key: string
  at: number
  stop: () => void
}

/**
 * Keeps the reader's first row where it is while rows above it change height
 * or arrive. Answers what to call when the list may have shifted with no word
 * from Legend List, and what stops it.
 *
 * Only at rest: a `scrollTo` stops a fling dead, and is written from an offset
 * that has already been left behind. While the page moves a row that shifts
 * is simply recorded again, since a reader in a fling has no place to hold.
 *
 * `listenToPosition` covers rows settling, but it compares each row with
 * whatever stood at its index before: rows prepended to a list of even
 * height land on the positions the old ones held, and it says nothing. So
 * the keeper also reads its row's position itself, on a scroll and when the
 * rows change.
 */
function keepPosition<T>(
  list: LegendListRef,
  source: PageScrollSource,
  keyOf: (item: T) => string
): { check: () => void; stop: () => void } {
  let tracked: Tracked | undefined
  const correct = (at: number): void => {
    if (tracked == null) return
    const shift = at - tracked.at
    if (source.moving()) {
      tracked.at = at
      return
    }
    if (Math.abs(shift) <= SHIFT_PX) return
    tracked.at = at
    source.scrollBy(shift)
  }
  const check = (): void => {
    if (tracked == null) return
    const at = list.getState().positionByKey(tracked.key)
    if (at != null) correct(at)
  }
  /** The first row at or below the viewport's top, from now on. */
  const track = (): void => {
    check()
    const state = list.getState()
    const data = state.data as readonly T[]
    let index = Math.max(0, state.start)
    while (
      index < data.length - 1 &&
      (state.positionAtIndex(index) ?? 0) < state.scroll
    )
      index++
    const item = data[index]
    if (item == null) return
    const key = keyOf(item)
    const at = state.positionAtIndex(index) ?? 0
    if (tracked?.key === key) {
      tracked.at = at
      return
    }
    tracked?.stop()
    tracked = { key, at, stop: state.listenToPosition(key, correct) }
  }
  const unsubscribe = source.subscribe(
    { onOffset: track, onRest: track },
    { active: true }
  )
  track()
  return {
    check,
    stop: () => {
      unsubscribe()
      tracked?.stop()
    }
  }
}

export interface PagedFollow<T> {
  /** The props both platforms hand Legend List alike. */
  legend: {
    ref: React.RefObject<LegendListRef | null>
    data: readonly T[]
    extraData: unknown
    numColumns: number | undefined
    estimatedItemSize: number
    keyExtractor: (item: T) => string
    renderItem: (row: { item: T; index: number }) => React.ReactElement | null
    alwaysRender: { top: number; keys: string[] | undefined }
    dataVersion: number
    ListHeaderComponent: PagedListProps<T>['header']
    ListFooterComponent: PagedListProps<T>['footer']
    ListEmptyComponent: PagedListProps<T>['empty']
    maintainVisibleContentPosition: typeof NO_POSITION_KEEPING
    recycleItems: false
    onEndReached: (() => void) | undefined
    onStartReached: (() => void) | undefined
    onEndReachedThreshold: number
    onStartReachedThreshold: number
  }
}

/**
 * The rules a list keeps on either platform: what it may do on show and kept,
 * the position keeper, and reporting where its anchored row is.
 *
 * `listTop` reads the list's own top in its parent, and `topChanged` is a
 * value that changes when that may have.
 */
export function usePagedFollow<T>(
  props: PagedListProps<T>,
  source: PageScrollSource,
  listTop: () => number | undefined,
  topChanged?: unknown
): PagedFollow<T> {
  const {
    data,
    renderItem,
    extraData,
    numColumns,
    estimatedItemSize,
    alwaysRenderKeys,
    anchorKey,
    onEndReached
  } = props
  const active = usePageActive()
  const list = useRef<LegendListRef>(null)
  const latest = useRef(props)
  latest.current = props

  // Set only by the reader, since the app's own scrolls to an anchor look the
  // same as any other, and only for the time on show: a page returned to is
  // anchored again, which is the anchor's until somebody moves it.
  const [moved, setMoved] = useState(false)
  if (moved && !active) setMoved(false)
  const hasStart = props.onStartReached != null
  useEffect(() => {
    if (!active || !hasStart) return
    return source.subscribe(
      {
        onReaderMoved: () => {
          setMoved(true)
        }
      },
      { active }
    )
  }, [active, hasStart, source])

  const keeper = useRef<ReturnType<typeof keepPosition<T>>>(undefined)
  const keeping = active && moved && hasStart
  useEffect(() => {
    const current = list.current
    if (!keeping || current == null) return
    const running = keepPosition<T>(current, source, item =>
      latest.current.keyOf(item)
    )
    keeper.current = running
    return () => {
      running.stop()
      keeper.current = undefined
    }
  }, [keeping, source])
  useEffect(() => {
    keeper.current?.check()
  }, [data])

  // A list coming on show checks its own end: Legend List heard no
  // `onEndReached` while it was kept, and the reader may have arrived there.
  const wasActive = useRef(active)
  useEffect(() => {
    const returned = active && !wasActive.current
    wasActive.current = active
    if (!returned || latest.current.data.length === 0) return
    const state = list.current?.getState()
    if (state == null) return
    const left = state.contentLength - state.scroll - state.scrollLength
    if (left <= EDGE_SCREENS * state.scrollLength)
      latest.current.onEndReached?.()
  }, [active])

  // Passive, not layout: `usePinnedTabs` calls `select` in a layout effect of
  // the same commit, which clears the row's measurement, and this has to land
  // after it. Rows that settle are heard from Legend List; new rows, like the
  // keeper's, are read here, since it can say nothing for those.
  const reported = useRef<number | undefined>(undefined)
  const report = useRef<(force: boolean) => void>(() => undefined)
  report.current = force => {
    const { anchorKey: key, onAnchorPosition } = latest.current
    if (key == null || onAnchorPosition == null) return
    const position = list.current?.getState().positionByKey(key)
    const top = listTop()
    if (position == null || top == null) return
    const y = top + position
    if (!force && y === reported.current) return
    reported.current = y
    onAnchorPosition(y)
  }
  useEffect(() => {
    if (!active || anchorKey == null) return
    report.current(true)
    return list.current?.getState().listenToPosition(anchorKey, () => {
      report.current(false)
    })
  }, [active, anchorKey, topChanged])
  useEffect(() => {
    if (active) report.current(false)
  }, [active, data])

  const reachedStart = useCallback(() => {
    latest.current.onStartReached?.(source.atRest)
  }, [source])

  // Legend List lays out a newly pinned row with its next pass; a new version
  // makes that pass now, before the row is measured.
  const pinned = useRef({ keys: '', version: 0 })
  const joined = (alwaysRenderKeys ?? []).join('\n')
  if (joined !== pinned.current.keys)
    pinned.current = { keys: joined, version: pinned.current.version + 1 }

  // Stable, or Legend List would work out its pinned rows on every render.
  const keyExtractor = useCallback((item: T) => latest.current.keyOf(item), [])
  const window = useWindowDimensions()
  const screenOfRows =
    Math.ceil(window.height / estimatedItemSize) * (numColumns ?? 1)

  return {
    legend: {
      ref: list,
      data,
      extraData,
      numColumns,
      estimatedItemSize,
      keyExtractor,
      renderItem: ({ item, index }) => renderItem(item, index),
      alwaysRender: { top: screenOfRows, keys: alwaysRenderKeys },
      dataVersion: pinned.current.version,
      ListHeaderComponent: props.header,
      ListFooterComponent: props.footer,
      ListEmptyComponent: props.empty,
      maintainVisibleContentPosition: NO_POSITION_KEEPING,
      recycleItems: false,
      // An edge heard with nothing to act on it would latch Legend List's
      // gate, and the end it reported would not be reported again.
      onEndReached: active ? onEndReached : undefined,
      onStartReached: keeping ? reachedStart : undefined,
      onEndReachedThreshold: EDGE_SCREENS,
      onStartReachedThreshold: EDGE_SCREENS
    }
  }
}
