import { LegendList } from '@legendapp/list/react-native'
import React, { useLayoutEffect, useRef } from 'react'
import { View } from 'react-native'

import type { PagedListProps } from './pagedListProps'
import { usePageScroll } from './pageScroll'
import { usePagedFollow } from './usePagedFollow'

export type { PagedListProps }

/** The lists on a scroller that want the browser's own anchoring off it. */
const anchorHolds = new WeakMap<HTMLElement, number>()

/**
 * The browser would correct a shift above the reader as well as the position
 * keeper, and move the page twice.
 */
function holdScrollAnchoring(element: HTMLElement): () => void {
  anchorHolds.set(element, (anchorHolds.get(element) ?? 0) + 1)
  element.style.overflowAnchor = 'none'
  return () => {
    const left = (anchorHolds.get(element) ?? 1) - 1
    anchorHolds.set(element, left)
    if (left === 0) element.style.overflowAnchor = ''
  }
}

/**
 * A list that is a block in its page: as tall as all its rows, drawing only
 * those near the screen, following the page's scroller. The browser's half;
 * Legend List follows a node it is given and allows for what is above it.
 */
export function PagedList<T>(props: PagedListProps<T>): React.ReactElement {
  const { width, onStartReached } = props
  const source = usePageScroll()
  const { element } = source
  const box = useRef<React.ComponentRef<typeof View>>(null)
  const follow = usePagedFollow(
    props,
    source,
    () => {
      const node = box.current as unknown as HTMLElement | null
      if (node?.parentElement == null) return undefined
      return (
        node.getBoundingClientRect().top -
        node.parentElement.getBoundingClientRect().top
      )
      // The list mounts with the node, and until then has no rows to report.
    },
    element
  )
  const hasStart = onStartReached != null
  useLayoutEffect(() => {
    if (element == null || !hasStart) return
    return holdScrollAnchoring(element as unknown as HTMLElement)
  }, [element, hasStart])
  // Typed for the phone, where the option does not exist.
  const scroller: object = { scrollElement: element }
  return (
    <View ref={box} style={width == null ? undefined : { width }}>
      {element == null ? null : <LegendList {...follow.legend} {...scroller} />}
    </View>
  )
}
