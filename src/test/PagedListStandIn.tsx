import React, { useEffect, useRef } from 'react'
import { View } from 'react-native'

import type { PagedListProps } from '../app/components/pagedListProps'
import { usePageScroll } from '../app/components/pageScroll'
import { usePageActive } from '../app/components/TabPages'

export type { PagedListProps }

interface StandingList {
  props: PagedListProps<never>
  active: boolean
}

/** The lists on the page, last mounted last. */
const standing: StandingList[] = []

function onShow(): StandingList {
  const list = standing.findLast(entry => entry.active)
  if (list == null) throw new Error('No PagedList is on show')
  return list
}

/** What Legend List does when the reader comes near a list's end. */
export function reachEnd(): void {
  onShow().props.onEndReached?.()
}

/** What Legend List does when the reader comes near a list's top. */
export function reachStart(): void {
  onShow().props.onStartReached?.(async () => undefined)
}

/** What a list reports when its anchored row settles at `y`. */
export function reportAnchor(y: number): void {
  onShow().props.onAnchorPosition?.(y)
}

function part(content: PagedListProps<never>['header']): React.ReactNode {
  if (content == null || React.isValidElement(content)) return content
  return React.createElement(content)
}

/**
 * The bundled tests' `PagedList`, which `scripts/pagedListStandInPlugin.mjs`
 * swaps in. The test DOM has no layout, so the real one would draw no rows.
 * This draws every row, and needs a scroller above it as the real one does.
 * A suite plays Legend List's part with `reachEnd`, `reachStart` and
 * `reportAnchor`.
 */
export function PagedList<T>(props: PagedListProps<T>): React.ReactElement {
  const { data, keyOf, renderItem, header, footer, empty } = props
  usePageScroll()
  const active = usePageActive()
  const entry = useRef<StandingList>({
    props: props as unknown as PagedListProps<never>,
    active
  })
  entry.current.props = props as unknown as PagedListProps<never>
  entry.current.active = active
  useEffect(() => {
    const mine = entry.current
    standing.push(mine)
    return () => {
      standing.splice(standing.indexOf(mine), 1)
    }
  }, [])
  return (
    <View>
      {part(header)}
      {data.length === 0
        ? part(empty)
        : data.map((item, index) => (
            <React.Fragment key={keyOf(item)}>
              {renderItem(item, index)}
            </React.Fragment>
          ))}
      {part(footer)}
    </View>
  )
}
