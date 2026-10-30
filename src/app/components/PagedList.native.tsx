import { LegendList } from '@legendapp/list/react-native'
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { type LayoutRectangle, View, type ViewProps } from 'react-native'

import type { PagedListProps } from './pagedListProps'
import { usePageScroll } from './pageScroll'
import { usePageActive } from './TabPages'
import { usePagedFollow } from './usePagedFollow'

export type { PagedListProps }

/** What Legend List hands its scroll component, as this one takes it. */
interface ScrollComponentProps {
  ref?: React.Ref<unknown>
  children?: React.ReactNode
  style?: ViewProps['style']
  contentContainerStyle?: ViewProps['style']
  onLayout?: (event: { nativeEvent: { layout: LayoutRectangle } }) => void
  onScroll?: (event: unknown) => void
  onScrollBeginDrag?: (event: unknown) => void
  onScrollEndDrag?: (event: unknown) => void
}

/** A drag's event: Legend List only passes it on. */
const DRAG_EVENT = { nativeEvent: {} }

/**
 * Stands where Legend List expects its scroll view, in a list that is a block
 * in the page: a plain `View` as tall as the rows, which turns the page's
 * scroller into what Legend List would have heard from its own.
 *
 * - `measure` and `onLayout` report the page's viewport, since that is the
 *   length rows are drawn for, not this view's height, which is all of them.
 * - An offset is the page's, less how far down it this list starts, and 0
 *   while the list has not reached the top of the page.
 * - `scrollTo` is the other way about.
 * - A drag on the page is a drag here, because `onScrollBeginDrag` is what
 *   reopens Legend List's end-reached gate on a phone.
 *
 * The list's top is measured against the scroller's content, on its own layout
 * and whenever that content changes height: something above the list that
 * resizes moves the list, and sends it no layout.
 *
 * Kept or sliding out it follows at rest only, so that it holds rows for where
 * the page is without working through a scroll it cannot be seen in.
 */
export function PageScrollProxy(
  props: ScrollComponentProps
): React.ReactElement {
  const {
    ref,
    children,
    style,
    contentContainerStyle,
    onLayout,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag
  } = props
  const source = usePageScroll()
  const active = usePageActive()
  const view = useRef<React.ComponentRef<typeof View>>(null)
  const latest = useRef({
    onLayout,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag
  })
  latest.current = { onLayout, onScroll, onScrollBeginDrag, onScrollEndDrag }
  const listTop = useRef(0)
  const laidOut = useRef<LayoutRectangle>(undefined)

  const reportOffset = useCallback((): void => {
    const { offset, viewport } = source.current()
    const { width = 0, height = 0 } = laidOut.current ?? {}
    latest.current.onScroll?.({
      nativeEvent: {
        contentOffset: { x: 0, y: Math.max(0, offset - listTop.current) },
        // Legend List ignores a scroll of nothing, which a list that has yet
        // to be laid out is not.
        contentSize: { width, height: Math.max(1, height) },
        layoutMeasurement: { width, height: viewport }
      }
    })
  }, [source])

  const reportViewport = useCallback((): void => {
    const layout = laidOut.current
    if (layout == null) return
    const height = source.current().viewport
    latest.current.onLayout?.({
      nativeEvent: { layout: { ...layout, height } }
    })
  }, [source])

  const measureTop = useCallback((): void => {
    const content = source.contentRef.current
    if (view.current == null || content == null) return
    view.current.measureLayout(
      content,
      (_left, top) => {
        if (top === listTop.current) return
        listTop.current = top
        reportOffset()
      },
      () => undefined
    )
  }, [reportOffset, source])

  useImperativeHandle(
    ref,
    () => ({
      // Legend List's scroll length, read at mount on the new architecture.
      measure: (
        answer: (
          x: number,
          y: number,
          width: number,
          height: number,
          pageX: number,
          pageY: number
        ) => void
      ) => {
        view.current?.measure((x, y, width, _height, pageX, pageY) => {
          answer(x, y, width, source.current().viewport, pageX, pageY)
        })
      },
      scrollTo: ({ y = 0, animated }: { y?: number; animated?: boolean }) => {
        source.scrollTo(listTop.current + y, animated)
      }
    }),
    [source]
  )

  const follow = useCallback((): void => {
    measureTop()
    reportOffset()
  }, [measureTop, reportOffset])

  useEffect(
    () =>
      source.subscribe(
        {
          onOffset: active ? reportOffset : follow,
          onViewport: reportViewport,
          onContentSize: active ? measureTop : undefined,
          onBeginDrag: () => {
            latest.current.onScrollBeginDrag?.(DRAG_EVENT)
          },
          onEndDrag: () => {
            latest.current.onScrollEndDrag?.(DRAG_EVENT)
          }
        },
        { active }
      ),
    [active, follow, measureTop, reportOffset, reportViewport, source]
  )
  // On show, and arriving on show, with the page wherever it is by now.
  useEffect(() => {
    if (active) follow()
  }, [active, follow])

  return (
    <View
      ref={view}
      style={[style, contentContainerStyle]}
      onLayout={event => {
        laidOut.current = { ...event.nativeEvent.layout }
        reportViewport()
        measureTop()
      }}
    >
      {children}
    </View>
  )
}

/**
 * A list that is a block in its page: as tall as all its rows, drawing only
 * those near the screen, following the page's scroller. The phone's half.
 */
export function PagedList<T>(props: PagedListProps<T>): React.ReactElement {
  const { width } = props
  const source = usePageScroll()
  const [top, setTop] = useState<number | undefined>(undefined)
  const follow = usePagedFollow(props, source, () => top, top)
  return (
    <LegendList
      {...follow.legend}
      renderScrollComponent={scrollProps => (
        <PageScrollProxy {...(scrollProps as ScrollComponentProps)} />
      )}
      style={width == null ? undefined : { width }}
      onLayout={event => {
        setTop(event.nativeEvent.layout.y)
      }}
    />
  )
}
