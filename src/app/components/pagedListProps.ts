import type React from 'react'

/** A row, a header or the like, as Legend List takes it. */
type Part = React.ComponentType | React.ReactElement | null | undefined

/**
 * What a `PagedList` takes, on either platform.
 *
 * Legend List redraws a mounted row only for a new item or `extraData`, so
 * anything a row reads besides its item goes in `extraData`.
 */
export interface PagedListProps<T> {
  data: readonly T[]
  keyOf: (item: T) => string
  renderItem: (item: T, index: number) => React.ReactElement | null
  extraData?: unknown
  numColumns?: number
  /** For a list in a horizontal scroller, which gives it no width. */
  width?: number
  header?: Part
  footer?: Part
  empty?: Part
  /** A row's height before it has been measured. */
  estimatedItemSize: number
  /** Rows kept drawn wherever the page is. */
  alwaysRenderKeys?: string[]
  /** The row whose place in the page `onAnchorPosition` reports. */
  anchorKey?: string | null
  /** Where that row's top is, from the top of the list's parent. */
  onAnchorPosition?: (y: number) => void
  onEndReached?: () => void
  /**
   * Reads older rows, which arrive above the reader. They wait for `atRest`,
   * since a page that moves under a fling has nothing to correct it with.
   */
  onStartReached?: (atRest: () => Promise<void>) => void
}
