import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  withDelay,
  withTiming
} from 'react-native-reanimated'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'

import { useContentInset } from './contentInset'
import { REVERSE_HOLD_MS, useMountOrder } from './mountOrder'
import { readNow } from './readNow'
import { useMotionPreference } from './useMotionPreference'

export const PAGE_MS = 280

const PageActiveContext = createContext(true)
const PageOffsetContext = createContext<number | undefined>(0)

/** A `fill` page's slide, which its content under the pills plays. */
interface PageSlide {
  role: 'incoming' | 'outgoing'
  direction: -1 | 1
  progress: SharedValue<number>
  span: number
}
const PageSlideContext = createContext<PageSlide | undefined>(undefined)

/**
 * Where a page in `role` is while `progress` runs from 0 to 1. The arriving
 * page comes in from `inFrom` (the edge, unless it was part way out) and the
 * leaving page goes out from `outFrom` (at rest, unless it was part way in).
 */
function slideX(
  role: Role,
  direction: -1 | 1,
  p: number,
  span: number,
  inFrom: number = direction * span,
  outFrom = 0
): number {
  'worklet'
  if (role === 'incoming') return inFrom * (1 - p)
  if (role === 'outgoing') return outFrom + (-direction * span - outFrom) * p
  // Beside the page on show, on the side it would come in from.
  if (role === 'kept') return direction * span
  return 0
}

/**
 * The move of the `fill` page this is in, for the part of it that slides:
 * nothing outside one, or while it is not sliding.
 */
function useSlideStyle(): ReturnType<typeof useAnimatedStyle> {
  const slide = useContext(PageSlideContext)
  return useAnimatedStyle(() => {
    if (slide == null) return { transform: [{ translateX: 0 }] }
    const p = Math.min(1, Math.max(0, slide.progress.value))
    return {
      transform: [
        { translateX: slideX(slide.role, slide.direction, p, slide.span) }
      ]
    }
  })
}

/**
 * Whether this is inside a `fill` page that is sliding. Its own background
 * would hide the other page's content, which is sliding beside its own.
 */
export function usePageSliding(): boolean {
  return useContext(PageSlideContext) != null
}

/**
 * Whether this is the hero and pills of a `fill` page sliding out. The
 * arriving page draws the same ones in the same place, with its own pill
 * chosen, so the leaving page's stand down rather than show the old choice.
 */
export function usePageHeadHidden(): boolean {
  return useContext(PageSlideContext)?.role === 'outgoing'
}

/**
 * A `fill` page's content under its pills: the part that slides when the
 * pages are two layouts of one screen, while the hero and pills above it
 * stay where they are. Elsewhere, a plain view.
 */
export function SlidingContent(
  props: React.ComponentProps<typeof Animated.View>
): React.ReactElement {
  const { style, ...rest } = props
  const role = useContext(PageSlideContext)?.role
  return (
    <Animated.View
      {...rest}
      dataSet={role == null ? undefined : { pageContent: '', pageRole: role }}
      style={[style, useSlideStyle()]}
    />
  )
}

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
 * A `View` whose `ref` and `onLayout` are let go inside a page sliding out or
 * kept out of sight (`useActiveRef`), for the ones a screen attaches inside
 * its pages: the screen's own render is outside them, so it cannot ask
 * itself.
 */
export function ActiveView(
  props: React.ComponentProps<typeof View>
): React.ReactElement {
  const { ref, onLayout, ...rest } = props
  return (
    <View {...rest} ref={useActiveRef(ref)} onLayout={useActiveRef(onLayout)} />
  )
}

/**
 * A page's part: on show (`top`), sliding in or out, or `kept`, built but
 * out of sight until it is chosen again.
 */
type Role = 'top' | 'incoming' | 'outgoing' | 'kept'

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
   * container and slide whole. Otherwise the arriving page sits in the flow
   * and sets the height, and the leaving one is laid over it.
   */
  fill?: boolean
  /**
   * With `fill`: the pages are two layouts of one screen, with the same hero
   * and pills at the top. Those stay put, and only what each page slides
   * (`SlidingContent`, or a `TabPages` of its own) moves.
   *
   * What a layout that adopts it has to do, since both are drawn at once for
   * the length of a slide:
   * - Draw its hero and pills with `CardBand` and `PillBand` at the same
   *   size and place as the other layout's (the game's Videos takes the
   *   `Screen` column's from `useColumnSide` and `columnSpace`). The leaving
   *   layout's bands stand down (`usePageHeadHidden`); the arriving layout's
   *   are drawn over them.
   * - Put everything under its pills in `SlidingContent`, or in a pill group
   *   of its own, which is carried the same way.
   * - Paint no background of its own while it slides (`usePageSliding`, as
   *   `Screen` does): the other layout's content shows beside its own.
   *
   * One head drawn once, outside the pages, would need none of this, and is
   * the better shape for a screen built new.
   */
  keepHead?: boolean
  /**
   * Run through the column's margins, so pages slide from the screen's edges
   * rather than the column's. The default in flow mode.
   */
  bleed?: boolean
  /**
   * For pages that are costly to draw, such as a long list, which would
   * otherwise hold the slide up until they were drawn:
   * - A page chosen for the first time slides in as a spinner at once, and
   *   is drawn once it has landed.
   * - Once shown it stays built, out of sight beside the page on show, so a
   *   return to it slides in the page that is there rather than drawing it
   *   again. A kept page shows what it last drew until it is chosen again.
   */
  keep?: boolean
  children: React.ReactNode
}

interface Page {
  key: string
  index: number
  node: React.ReactNode
}

/** How a slide places the pages it moves. */
interface Placing {
  direction: -1 | 1
  progress: SharedValue<number>
  /** Where the arriving page starts, when not at the edge. */
  inFrom?: SharedValue<number>
  /** Where the leaving page starts, when not at rest. */
  outFrom?: SharedValue<number>
}

interface Slide extends Placing {
  id: number
  outgoing: Page
  /**
   * The slide this one was chosen during: where its pages stand is read
   * again (`inFrom`, `outFrom`) as this one begins on the thread that moves
   * them, since it has gone on moving while this was drawn.
   */
  during?: Placing
  /**
   * The slide the arriving page was still leaving by, when it comes back
   * from `trailing`: its `inFrom` is read from that one, not from `during`.
   */
  inBy?: Placing
  /** A running slide this one takes over and stops, holding a moment. */
  stops?: SharedValue<number>
  /**
   * Pages still leaving by earlier slides, each running on out by its own:
   * a fourth pill chosen before the third lands still lets the first finish
   * its way off the edge.
   */
  trailing?: Array<{ page: Page; by: Placing }>
}

/**
 * Just how a slide places its pages, for the thread that moves them: a slide
 * also holds its leaving page's React element, which must not be sent there.
 */
function placingOf(slide: Placing): Placing {
  const { direction, progress, inFrom, outFrom } = slide
  return { direction, progress, inFrom, outFrom }
}

/** Where a page in `role` stands under a slide now. */
function standing(by: Placing, role: Role, span: number): number {
  'worklet'
  return slideX(
    role,
    by.direction,
    Math.min(1, Math.max(0, by.progress.value)),
    span,
    by.inFrom?.value,
    by.outFrom?.value
  )
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
  const { page, index, fill = false, keep = false, children } = props
  const keepHead = fill && props.keepHead === true
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
  /** The width a page slides across, as last drawn. */
  const spanNow = useRef(0)
  const kept = useRef(new Map<string, Page>())
  /** The pages that have been on show: drawn, not a spinner. */
  const landed = useRef(new Set<string>())
  /**
   * Each page's height as it was last on show, which the container keeps
   * while it slides out.
   */
  const heights = useRef(new Map<string, number>())
  const [shown, setShown] = useState<{ page: string; slide?: Slide }>({
    page
  })
  let current = shown
  if (shown.page !== page) {
    const previous = committed.current
    const direction =
      previous == null ? 0 : pageDirection(previous.index, index)
    const running = shown.slide
    const span = spanNow.current
    let slide: Slide | undefined
    if (previous != null && direction !== 0 && !reduced) {
      slide = {
        id: ++slides,
        direction,
        outgoing: previous,
        progress: makeMutable(0)
      }
      if (running != null && previous.key === shown.page) {
        // Read where its pages stand on the thread that moves them, from
        // its placing alone.
        const at = placingOf(running)
        const placed =
          running.inFrom != null ||
          running.outFrom != null ||
          (running.trailing?.length ?? 0) > 0
        if (running.outgoing.key === page && !placed) {
          // A pill reversed mid-slide sends the same two pages back the way
          // they came, from where they are: under the swapped parts, the
          // same places at the mirrored progress.
          slide.progress = makeMutable(
            1 -
              readNow(() => {
                'worklet'
                return Math.min(1, Math.max(0, at.progress.value))
              })
          )
          slide.stops = running.progress
        } else if (running.outgoing.key === page) {
          // Reversed again after a third pill: both pages go back from
          // where they are, and the page that was trailing out goes on.
          const [back, out] = readNow(() => {
            'worklet'
            return [
              standing(at, 'outgoing', span),
              standing(at, 'incoming', span)
            ]
          })
          slide.inFrom = makeMutable(back)
          slide.outFrom = makeMutable(out)
          slide.during = at
          slide.stops = running.progress
          slide.trailing = running.trailing
        } else {
          // A third pill: the page part way in leaves from where it is, and
          // the page part way out goes on out as it was going.
          slide.outFrom = makeMutable(
            readNow(() => {
              'worklet'
              return standing(at, 'incoming', span)
            })
          )
          slide.during = at
          const trailing = [
            ...(running.trailing ?? []),
            { page: running.outgoing, by: running }
          ]
          // A page still trailing out that is chosen again comes back from
          // where its own slide has it, not in from the edge.
          const back = trailing.find(entry => entry.page.key === page)
          if (back != null) {
            const by = placingOf(back.by)
            slide.inFrom = makeMutable(
              readNow(() => {
                'worklet'
                return standing(by, 'outgoing', span)
              })
            )
            slide.inBy = by
          }
          slide.trailing = trailing.filter(entry => entry.page.key !== page)
        }
      }
    }
    current = { page, slide }
    setShown(current)
  }
  const { slide } = current

  useLayoutEffect(() => {
    committed.current = { key: page, index, node: children }
    if (keep) kept.current.set(page, committed.current)
    else kept.current.clear()
    if (slide == null) landed.current.add(page)
  })
  useLayoutEffect(() => {
    if (slide == null) return
    const { id, progress, during, inBy, stops, inFrom, outFrom } = slide
    const leaving = slide.outgoing.key
    const width = spanNow.current
    // On the thread that moves the pages: a slide chosen during another
    // starts from where that one's pages stand now, which have gone on
    // moving while this was drawn. One that takes its two pages over stops
    // the other there, and holds a moment before it goes: the pages take
    // their new parts in a commit that reaches the screen a frame or two
    // later, and until then they still move by the old slide.
    scheduleOnUI(() => {
      'worklet'
      let hold = 0
      const inAt = inBy ?? during
      if (inFrom != null && inAt != null)
        inFrom.value = standing(inAt, 'outgoing', width)
      if (outFrom != null && during != null)
        outFrom.value = standing(during, 'incoming', width)
      if (stops != null) {
        if (during == null)
          progress.value = 1 - Math.min(1, Math.max(0, stops.value))
        cancelAnimation(stops)
        hold = REVERSE_HOLD_MS
      }
      // The rest of a slide turned back takes the rest of the time.
      const left =
        inFrom == null
          ? 1 - progress.value
          : Math.min(1, Math.abs(inFrom.value) / Math.max(1, width))
      progress.value = withDelay(
        hold,
        withTiming(
          1,
          {
            duration: PAGE_MS * left,
            easing: Easing.out(Easing.cubic),
            reduceMotion: ReduceMotion.Never
          },
          done => {
            if (done === true) scheduleOnRN(settle, id, page, leaving)
          }
        ),
        ReduceMotion.Never
      )
    })
  }, [slide, page])
  const settle = (id: number, arrived: string, leaving: string): void => {
    // Landed no taller than the page it replaced: no layout says so, and the
    // container still stands at that height.
    const height = heights.current.get(leaving)
    if (!heights.current.has(arrived) && height != null)
      heights.current.set(arrived, height)
    setShown(held =>
      held.slide?.id === id ? { page: held.page, slide: undefined } : held
    )
  }

  const span = width > 0 ? width : window.width
  spanNow.current = span
  const pages: Array<{ entry: Page; role: Role; by?: Placing }> = [
    { entry: { key: page, index, node: children }, role: 'incoming' }
  ]
  if (slide != null && slide.outgoing.key !== page)
    pages.push({ entry: slide.outgoing, role: 'outgoing' })
  for (const trailing of slide?.trailing ?? [])
    if (!pages.some(shown => shown.entry.key === trailing.page.key))
      pages.push({ entry: trailing.page, role: 'outgoing', by: trailing.by })
  if (keep)
    for (const entry of kept.current.values())
      if (!pages.some(shown => shown.entry.key === entry.key))
        pages.push({ entry, role: 'kept' })
  // In the order they were first mounted, as the stack navigator does: a pill
  // reversed mid-slide swaps the roles, and must not move a page's node.
  const ordered = useMountOrder(
    pages,
    ({ entry }) => entry.key,
    key => {
      heights.current.delete(key)
      landed.current.delete(key)
    }
  )
  // Laid over the arriving page, the leaving one is cut to its height: a
  // spinner would take all but a strip of a long list off the screen at once.
  const leavingHeight =
    slide == null || fill ? undefined : heights.current.get(slide.outgoing.key)

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width: next, y, height } = event.nativeEvent.layout
    if (next !== width) setWidth(next)
    if (y !== top) setTop(y)
    // At rest the container is as tall as the page on show: its height, for
    // when it slides out. While a slide holds the leaving page's height, a
    // container grown past it is the arriving page's.
    if (slide == null || height > (leavingHeight ?? 0))
      heights.current.set(page, height)
  }
  // Pills inside a `fill` page: their pages are its content, and move with it.
  const carried = useSlideStyle()
  const carrier = useContext(PageSlideContext)?.role

  return (
    <Animated.View
      onLayout={onLayout}
      dataSet={
        fill || carrier == null
          ? undefined
          : { pageContent: '', pageRole: carrier }
      }
      style={[
        styles.container,
        fill && styles.fill,
        bleed && {
          marginLeft: -inset.left,
          marginRight: -inset.right,
          paddingLeft: inset.left,
          paddingRight: inset.right
        },
        !fill && carried,
        leavingHeight != null && { minHeight: leavingHeight }
      ]}
    >
      <PageOffsetContext.Provider value={offset}>
        {ordered.map(({ entry, role: part, by }) => {
          const role = slide == null && part !== 'kept' ? 'top' : part
          // Not drawn until it has been on show: until then, sliding or
          // kept (a slide reversed before it landed), it is a spinner.
          const waiting =
            keep && role !== 'top' && !landed.current.has(entry.key)
          return (
            <PageFrame
              key={entry.key}
              pageKey={entry.key}
              role={role}
              direction={
                role === 'kept'
                  ? entry.index < index
                    ? -1
                    : 1
                  : (by?.direction ?? slide?.direction ?? 1)
              }
              progress={(by ?? slide)?.progress}
              inFrom={(by ?? slide)?.inFrom}
              outFrom={(by ?? slide)?.outFrom}
              span={span}
              fill={fill}
              keepHead={keepHead}
              inset={bleed ? inset : undefined}
              still={reduced}
            >
              {waiting ? (
                <ActivityIndicator
                  accessibilityLabel="Loading"
                  style={styles.spinner}
                />
              ) : (
                entry.node
              )}
            </PageFrame>
          )
        })}
      </PageOffsetContext.Provider>
    </Animated.View>
  )
}

function PageFrame(props: {
  pageKey: string
  role: Role
  direction: -1 | 1
  progress: SharedValue<number> | undefined
  /** Where an arriving page starts, when not at the edge. */
  inFrom?: SharedValue<number>
  /** Where a leaving page starts, when not at rest. */
  outFrom?: SharedValue<number>
  span: number
  fill: boolean
  keepHead: boolean
  inset: { left: number; right: number } | undefined
  /** Reduced motion: pages swap at once, with nothing to slide. */
  still: boolean
  children: React.ReactNode
}): React.ReactElement {
  const {
    pageKey,
    role,
    direction,
    progress,
    inFrom,
    outFrom,
    span,
    fill,
    keepHead,
    inset,
    still
  } = props
  const moving = useAnimatedStyle(() => {
    // A page that keeps its head stays where it is: its content slides.
    if (keepHead)
      return {
        opacity: role === 'kept' ? 0 : 1,
        transform: [{ translateX: 0 }]
      }
    // A kept page waits beside the page on show, where the container cuts it
    // off, rather than hidden by a style: a phone moves the pages on its own
    // thread, ahead of a commit's styles, so one shown by a commit would come
    // in a frame late, or a frame early where it last stood.
    const p = Math.min(1, Math.max(0, progress?.value ?? 1))
    return {
      transform: [
        {
          translateX: slideX(
            role,
            direction,
            p,
            span,
            inFrom?.value,
            outFrom?.value
          )
        }
      ]
    }
  })
  // A kept page is out of the way as a leaving one is, and hidden.
  const leaving = role === 'outgoing' || role === 'kept'
  // A page inside a page that is leaving is leaving too.
  const outer = usePageActive()
  const slide = useMemo<PageSlide | undefined>(
    () =>
      keepHead &&
      (role === 'incoming' || role === 'outgoing') &&
      progress != null
        ? { role, direction, progress, span }
        : undefined,
    [keepHead, role, direction, progress, span]
  )
  return (
    <PageActiveContext.Provider value={outer && !leaving}>
      <PageSlideContext.Provider value={slide}>
        <Animated.View
          dataSet={{ page: pageKey, pageRole: role }}
          aria-hidden={leaving}
          importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
          style={[
            fill ? styles.filled : leaving ? styles.layer : undefined,
            // The arriving page's hero and pills over the leaving one's.
            keepHead && { zIndex: leaving ? 0 : 1 },
            leaving &&
              inset != null && {
                left: inset.left,
                right: inset.right
              },
            { pointerEvents: leaving ? 'none' : 'auto' },
            role === 'kept' && styles.kept,
            // Swapped at once, a page put by in the commit that shows the
            // next is hidden in it too, not a frame later by its move.
            role === 'kept' && still && styles.hidden,
            moving
          ]}
        >
          {props.children}
        </Animated.View>
      </PageSlideContext.Provider>
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
  },
  // A browser would still reach the links of a page out of sight with the
  // Tab key. Hidden, it keeps its layout, which a return to a long page would
  // otherwise have to wait for.
  kept: (Platform.OS === 'web'
    ? { visibility: 'hidden' }
    : {}) as unknown as ViewStyle,
  hidden: {
    opacity: 0
  },
  spinner: {
    paddingVertical: 32
  }
})
