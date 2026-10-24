import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  type LayoutChangeEvent,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import Animated, {
  Easing,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  withTiming
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { useContentInset } from './contentInset'
import { useMotionPreference } from './useMotionPreference'

export const PAGE_MS = 280

const PageActiveContext = createContext(true)
const PageOffsetContext = createContext<number | undefined>(0)

/**
 * How far down its column a page starts, or `undefined` while its pages have
 * not been laid out yet. A view inside a page reports its layout from the
 * page's top; one whose position in the column matters (the pinned head's
 * content) adds this to say where it is in the column, and waits for it.
 */
export function usePageOffset(): number | undefined {
  return useContext(PageOffsetContext)
}

/**
 * Whether this content is the page on show. False only inside a page that is
 * sliding out of a `TabPages`; true everywhere else.
 */
export function usePageActive(): boolean {
  return useContext(PageActiveContext)
}

/**
 * `ref` while this page is on show, and `undefined` inside a page sliding out.
 *
 * Both pages of a slide render the same parts, and those parts attach one
 * shared ref or layout handler — the pinned head's content view, a screen's
 * scroller. Handed `undefined`, the leaving page lets go of it in the same
 * commit in which the arriving page takes it, so its unmount, a moment later,
 * has nothing of the arriving page's to clear.
 */
export function useActiveRef<T>(ref: T): T | undefined {
  return usePageActive() ? ref : undefined
}

/**
 * A `View` whose `ref` is let go inside a page sliding out (`useActiveRef`),
 * for a ref a screen attaches inside its pages: the screen's own render is
 * outside them, so it cannot ask itself.
 */
export function ActiveView(
  props: React.ComponentProps<typeof View>
): React.ReactElement {
  const { ref, ...rest } = props
  return <View {...rest} ref={useActiveRef(ref)} />
}

/** -1, 0 or 1: which way a pill at `index` lies from one at `previous`. */
export function pageDirection(previous: number, index: number): -1 | 0 | 1 {
  if (previous < 0 || index < 0 || previous === index) return 0
  return index > previous ? 1 : -1
}

export interface TabPagesProps {
  /** The page on show; a new value slides the old one out. */
  page: string
  /** The selected pill's position in its row, which decides the direction. */
  index: number
  /**
   * For a page that is itself a full-height scroller: both pages fill the
   * container. Otherwise the arriving page sits in the flow and sets the
   * height, and the leaving one is laid over it.
   */
  fill?: boolean
  /**
   * Run through the column's margins, so pages slide from the screen's edges
   * rather than the column's. The default in flow mode.
   */
  bleed?: boolean
  children: React.ReactNode
}

interface Page {
  key: string
  index: number
  node: React.ReactNode
}

interface Slide {
  id: number
  direction: -1 | 1
  outgoing: Page
  progress: SharedValue<number>
}

let slides = 0

/**
 * A pill group's content, sliding the way the chosen pill lies: a pill to the
 * right brings its page in from the right while the current one leaves to the
 * left, and the mirror for a pill to the left, also across pills that are not
 * neighbours. The first page appears without moving, and reduced motion
 * swaps pages at once.
 */
export function TabPages(props: TabPagesProps): React.ReactElement {
  const { page, index, fill = false, children } = props
  const bleed = props.bleed ?? !fill
  const reduced = useMotionPreference()
  const inset = useContentInset()
  const window = useWindowDimensions()
  const [width, setWidth] = useState(0)
  // Unknown until the pages have been laid out: a view that reported from 0
  // first would have the pinned head anchor twice, moving the page under a
  // finger.
  const [top, setTop] = useState<number | undefined>(undefined)
  const outer = usePageOffset()
  const offset = outer == null || top == null ? undefined : outer + top
  const committed = useRef<Page | undefined>(undefined)
  const [shown, setShown] = useState<{ page: string; slide?: Slide }>({
    page
  })
  let current = shown
  if (shown.page !== page) {
    const previous = committed.current
    const direction =
      previous == null ? 0 : pageDirection(previous.index, index)
    current = {
      page,
      slide:
        previous == null || direction === 0 || reduced
          ? undefined
          : {
              id: ++slides,
              direction,
              outgoing: previous,
              progress: makeMutable(0)
            }
    }
    setShown(current)
  }
  const { slide } = current

  useLayoutEffect(() => {
    committed.current = { key: page, index, node: children }
  })
  useLayoutEffect(() => {
    if (slide == null) return
    const id = slide.id
    slide.progress.value = withTiming(
      1,
      {
        duration: PAGE_MS,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.Never
      },
      done => {
        if (done === true) scheduleOnRN(settle, id)
      }
    )
  }, [slide])
  const settle = (id: number): void => {
    setShown(held =>
      held.slide?.id === id ? { page: held.page, slide: undefined } : held
    )
  }

  const span = width > 0 ? width : window.width
  const pages: Array<{ entry: Page; role: 'incoming' | 'outgoing' }> = [
    { entry: { key: page, index, node: children }, role: 'incoming' }
  ]
  if (slide != null && slide.outgoing.key !== page)
    pages.push({ entry: slide.outgoing, role: 'outgoing' })
  // In the order they were first mounted, as the stack navigator does: a pill
  // reversed mid-slide swaps the roles, and must not move a page's node (a
  // moved scroller loses its place, a moved video starts over).
  const order = useRef(new Map<string, number>())
  let next = 0
  for (const value of order.current.values()) next = Math.max(next, value + 1)
  for (const { entry } of pages)
    if (!order.current.has(entry.key)) order.current.set(entry.key, next++)
  pages.sort(
    (a, b) =>
      (order.current.get(a.entry.key) ?? 0) -
      (order.current.get(b.entry.key) ?? 0)
  )
  const mounted = pages.map(({ entry }) => entry.key)
  useLayoutEffect(() => {
    for (const key of [...order.current.keys()])
      if (!mounted.includes(key)) order.current.delete(key)
  })

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width: next, y } = event.nativeEvent.layout
    if (next !== width) setWidth(next)
    if (y !== top) setTop(y)
  }

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.container,
        fill && styles.fill,
        bleed && {
          marginLeft: -inset.left,
          marginRight: -inset.right,
          paddingLeft: inset.left,
          paddingRight: inset.right
        }
      ]}
    >
      <PageOffsetContext.Provider value={offset}>
        {pages.map(({ entry, role }) => (
          <PageFrame
            key={entry.key}
            pageKey={entry.key}
            role={slide == null ? 'top' : role}
            direction={slide?.direction ?? 1}
            progress={slide?.progress}
            span={span}
            fill={fill}
            inset={bleed ? inset : undefined}
          >
            {entry.node}
          </PageFrame>
        ))}
      </PageOffsetContext.Provider>
    </View>
  )
}

function PageFrame(props: {
  pageKey: string
  role: 'top' | 'incoming' | 'outgoing'
  direction: -1 | 1
  progress: SharedValue<number> | undefined
  span: number
  fill: boolean
  inset: { left: number; right: number } | undefined
  children: React.ReactNode
}): React.ReactElement {
  const { role, direction, progress, span, fill, inset } = props
  const moving = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, progress?.value ?? 1))
    if (role === 'incoming')
      return { transform: [{ translateX: direction * (1 - p) * span }] }
    if (role === 'outgoing')
      return { transform: [{ translateX: -direction * p * span }] }
    return { transform: [{ translateX: 0 }] }
  })
  const leaving = role === 'outgoing'
  // A page inside a page that is leaving is leaving too.
  const outer = usePageActive()
  return (
    <PageActiveContext.Provider value={outer && !leaving}>
      <Animated.View
        dataSet={{ page: props.pageKey, pageRole: role }}
        aria-hidden={leaving}
        importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
        style={[
          fill ? styles.filled : leaving ? styles.layer : undefined,
          leaving &&
            inset != null && {
              left: inset.left,
              right: inset.right
            },
          { pointerEvents: leaving ? 'none' : 'auto' },
          moving
        ]}
      >
        {props.children}
      </Animated.View>
    </PageActiveContext.Provider>
  )
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden'
  },
  fill: {
    flex: 1
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0
  },
  filled: {
    ...StyleSheet.absoluteFill
  }
})
