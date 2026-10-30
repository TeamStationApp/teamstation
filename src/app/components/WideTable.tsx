import React, { createContext, useContext, useMemo, useRef } from 'react'
import { Platform, ScrollView, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface WideTableProps {
  children: React.ReactNode
}

/** A cell's place along the table: its left edge and width, in the rows. */
export interface WideTableSpan {
  x: number
  width: number
}

/**
 * How long an opened cell holds the table's sideways offset. The native
 * layout that follows a cell opening lands well inside it; a finger's drag
 * lets go of it at once.
 */
export const HOLD_MS = 1000

interface WideTableHold {
  /**
   * Keeps the table where it is while a cell opens in it, or moves it just
   * far enough to show the whole cell, and puts it back there if the native
   * scroll view moves it on its own in the moment that follows.
   */
  keep: (span: WideTableSpan | undefined) => void
}

const HoldContext = createContext<WideTableHold | undefined>(undefined)

/** The enclosing table's hold, for a cell that opens in place. */
export function useWideTableHold(): WideTableHold | undefined {
  return useContext(HoldContext)
}

/**
 * The offset that shows the whole of `span` in a viewport `width` wide,
 * moving as little as it can from `x`.
 */
export function offsetShowing(
  x: number,
  width: number,
  span: WideTableSpan | undefined
): number {
  if (span == null || width <= 0) return x
  if (span.x < x) return span.x
  if (span.x + span.width > x + width)
    return Math.min(span.x, span.x + span.width - width)
  return x
}

/**
 * A table that is wider than the screen, and says so by moving.
 *
 * A batting line is ten columns and a phone is not ten columns wide. The
 * alternative to scrolling is what was happening before: the last column —
 * the batting average, which is the one people look for — was quietly cut off
 * at the edge of the card with no way to reach it.
 *
 * A table with a name column does not use this: `FrozenNameTable` keeps the
 * names outside the scroll, which holds on the phone as well as in a browser.
 *
 * A cell that opens in place, such as the season grid's number cells, holds
 * the table's offset through `useWideTableHold`. Android's horizontal scroll
 * view can jump back to an offset from an earlier fling when a row's height
 * changes, which put the opened cell at the table's right edge; the hold
 * moves it back. A browser keeps its own offset, so the web has no hold.
 */
export function WideTable(props: WideTableProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const offset = useRef(0)
  const viewport = useRef(0)
  const held = useRef<{ x: number; until: number } | undefined>(undefined)
  const hold = useMemo<WideTableHold | undefined>(
    () =>
      Platform.OS === 'web'
        ? undefined
        : {
            keep: span => {
              const x = offsetShowing(offset.current, viewport.current, span)
              held.current = { x, until: Date.now() + HOLD_MS }
              if (Math.abs(x - offset.current) > 1) {
                offset.current = x
                scroll.current?.scrollTo({ x, animated: false })
              }
            }
          },
    []
  )
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator
      // A tap on another cell's input while one has the keyboard reaches
      // that cell, rather than only putting the keyboard away.
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onLayout={event => {
        viewport.current = event.nativeEvent.layout.width
      }}
      onScrollBeginDrag={() => {
        held.current = undefined
      }}
      onScroll={event => {
        const x = event.nativeEvent.contentOffset.x
        const keep = held.current
        if (keep != null && Date.now() > keep.until) held.current = undefined
        else if (keep != null && Math.abs(x - keep.x) > 1) {
          scroll.current?.scrollTo({ x: keep.x, animated: false })
          return
        }
        offset.current = x
      }}
      // The rows size themselves; the scroll view must not stretch them to its
      // own width, or there would be nothing to scroll.
      contentContainerStyle={styles.content}
    >
      {/*
        Grows into a window wider than the table and stays at its own width in
        one narrower, which is what makes it scroll: flex only gives out space
        that exists.
      */}
      <View style={styles.body}>
        <HoldContext.Provider value={hold}>
          {props.children}
        </HoldContext.Provider>
      </View>
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  content: {
    flexGrow: 1,
    paddingRight: theme.rem(theme.spaceSmRem)
  },
  body: {
    flexGrow: 1
  }
}))
