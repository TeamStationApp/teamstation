import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform
} from 'react-native'
import { useAnimatedScrollHandler } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { useSceneShown } from './sceneShown'
import { usePageActive } from './TabPages'

interface ScrollSample {
  y: number
  contentHeight: number
  viewportHeight: number
}
interface ScrollPosition {
  y: number
  travel: number
}
export function nextCompact(
  previous: ScrollPosition | null,
  sample: ScrollSample
): { position: ScrollPosition | null; compact?: boolean } {
  const { y, contentHeight, viewportHeight } = sample
  if (viewportHeight <= 0 || contentHeight <= viewportHeight)
    return { position: null, compact: false }
  if (y < 0 || y > contentHeight - viewportHeight) return { position: previous }
  const dy = previous == null ? 0 : y - previous.y
  const travel =
    previous == null ||
    (Math.sign(previous.travel) !== Math.sign(dy) && dy !== 0)
      ? dy
      : previous.travel + dy
  const position = { y, travel }
  if (y <= 96 || travel <= -24) return { position, compact: false }
  if (travel >= 48) return { position, compact: true }
  return { position }
}

const Compact = createContext(false)
const Observing = createContext(false)
interface ScrollSource {
  start?: { y: number; revision: number }
}
interface NavScroll {
  reset: () => void
  setEnabled: (enabled: boolean) => void
  update: (owner: ScrollSource, sample: ScrollSample, start: boolean) => void
}
const noop = (): void => {}
const Scroll = createContext<NavScroll>({
  reset: noop,
  setEnabled: noop,
  update: noop
})

export function NavCompactProvider({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const [compact, setCompact] = useState(false)
  const [observing, setObserving] = useState(true)
  const controls = useMemo<NavScroll>(() => {
    let enabled = true
    let revision = 0
    let source: ScrollSource | undefined
    let previous: ScrollPosition | null = null
    const reset = (): void => {
      revision++
      previous = null
      setCompact(false)
    }
    return {
      reset,
      setEnabled(value) {
        enabled = value
        setObserving(value)
        reset()
      },
      update(owner, sample, start) {
        if (!enabled) return
        if (start) {
          // Input bubbles through nested scrollers. Keep a starting offset for each
          // so that the pane that actually scrolls (including scroll chaining) wins.
          // Several wheel events can precede one throttled scroll sample.
          if (owner.start?.revision !== revision)
            owner.start = { y: Math.max(0, sample.y), revision }
          return
        }
        if (source !== owner) {
          source = owner
          previous = null
        }
        if (previous == null && owner.start?.revision === revision)
          previous = { y: owner.start.y, travel: 0 }
        owner.start = undefined
        const next = nextCompact(previous, sample)
        previous = next.position
        if (next.compact != null) setCompact(next.compact)
      }
    }
  }, [])
  return (
    <Scroll.Provider value={controls}>
      <Observing.Provider value={observing}>
        <Compact.Provider value={compact}>{children}</Compact.Provider>
      </Observing.Provider>
    </Scroll.Provider>
  )
}

export const useNavCompact = (): boolean => useContext(Compact)
export const useNavScroll = (): NavScroll => useContext(Scroll)
type Observe = (
  y: number,
  content: number,
  viewport: number,
  start?: boolean
) => void
type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>

export function useNavCompactScroll(enabled = true): Observe | undefined {
  const active = usePageActive()
  const shown = useSceneShown()
  const observing = useContext(Observing)
  const controls = useNavScroll()
  const owner = useRef<ScrollSource>({})
  const listening = enabled && observing && active && shown
  const live = useRef(listening)
  useLayoutEffect(() => {
    live.current = listening
    return () => {
      live.current = false
    }
  }, [listening])
  const observe = useCallback<Observe>(
    (y, contentHeight, viewportHeight, start = false) => {
      if (live.current)
        controls.update(
          owner.current,
          { y, contentHeight, viewportHeight },
          start
        )
    },
    [controls]
  )
  return listening ? observe : undefined
}

// Start and movement on the same worklet queue preserve the order of a fast fling.
export function useNavAnimatedScroll(
  observe: Observe | undefined
): ReturnType<typeof useAnimatedScrollHandler> | null {
  const handler = useAnimatedScrollHandler({
    onBeginDrag(event) {
      if (observe != null)
        scheduleOnRN(observe, event.contentOffset.y, 0, 0, true)
    },
    onScroll(event) {
      if (observe != null)
        scheduleOnRN(
          observe,
          event.contentOffset.y,
          event.contentSize.height,
          event.layoutMeasurement.height
        )
    }
  })
  return observe == null ? null : handler
}

interface WebScrollInput {
  currentTarget: unknown
  target?: unknown
  pointerType?: string
  key?: string
  deltaY?: number
}

interface ScrollInput<T = unknown> {
  ref?: React.RefCallback<T>
  onScrollBeginDrag?: (event: ScrollEvent) => void
  onWheel?: (event: WebScrollInput) => void
  onKeyDown?: (event: WebScrollInput) => void
  onPointerDown?: (event: WebScrollInput) => void
}

/** Capture the actual offset before a native drag or the browser's default scroll.
 * The first passive sample can instead be a restored reading position. */
export function useNavScrollInput<T = unknown>(
  observe: Observe | undefined,
  forwarded?: React.Ref<T>
): ScrollInput<T> {
  const browser = Platform.OS === 'web'
  const element = useRef<HTMLElement | null>(null)
  const rebind = useRef(noop)
  const lastOffset = useRef<number | undefined>(undefined)
  const ref = useMemo<React.RefCallback<T> | undefined>(() => {
    if (!browser && forwarded == null) return undefined
    return instance => {
      if (browser) {
        const scroller = instance as {
          getScrollableNode?: () => unknown
        } | null
        const node = scroller?.getScrollableNode?.() ?? instance
        element.current = node instanceof HTMLElement ? node : null
        rebind.current()
      }
      if (typeof forwarded === 'function') {
        const release = forwarded(instance)
        if (typeof release === 'function')
          return () => {
            element.current = null
            rebind.current()
            release()
          }
      } else if (forwarded != null) forwarded.current = instance
    }
  }, [browser, forwarded])
  useLayoutEffect(() => {
    if (!browser || observe == null) return
    let listening: HTMLElement | null = null
    const remember = (): void => {
      lastOffset.current = listening?.scrollTop
    }
    const bind = (): void => {
      listening?.removeEventListener('scroll', remember)
      listening = element.current
      remember()
      listening?.addEventListener('scroll', remember, { passive: true })
    }
    rebind.current = bind
    bind()
    return () => {
      listening?.removeEventListener('scroll', remember)
      rebind.current = noop
    }
  }, [browser, observe])
  return useMemo(() => {
    const refs = ref == null ? {} : { ref }
    if (observe == null) return refs
    if (Platform.OS !== 'web')
      return {
        ...refs,
        onScrollBeginDrag: (event: ScrollEvent) => {
          const y = event?.nativeEvent?.contentOffset?.y
          if (y != null) observe(y, 0, 0, true)
        }
      }
    const begin = (event: WebScrollInput): void => {
      const target = event.target as HTMLElement | undefined
      if (
        event.key != null &&
        (![
          'ArrowDown',
          'ArrowUp',
          'PageDown',
          'PageUp',
          'Home',
          'End',
          ' '
        ].includes(event.key) ||
          target?.closest?.(
            'input, textarea, select, [contenteditable="true"]'
          ) != null)
      )
        return
      if (
        event.deltaY === 0 ||
        (event.pointerType === 'mouse' && target !== event.currentTarget)
      )
        return
      const element = event.currentTarget as { scrollTop: number }
      // Chromium may move the compositor before a passive wheel handler runs.
      // The last delivered scroll offset was measured before that movement.
      observe(
        event.deltaY != null
          ? (lastOffset.current ?? element.scrollTop)
          : element.scrollTop,
        0,
        0,
        true
      )
    }
    return { ...refs, onWheel: begin, onKeyDown: begin, onPointerDown: begin }
  }, [ref, observe])
}

export function useNavListScroll<T = unknown>(
  enabled = true,
  forwarded?: React.Ref<T>
): ScrollInput<T> & { onScroll?: (event: ScrollEvent) => void } {
  const observe = useNavCompactScroll(enabled)
  const input = useNavScrollInput(observe, forwarded)
  const onScroll = useCallback(
    (event: ScrollEvent) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent
      if (contentSize != null && layoutMeasurement != null)
        observe?.(contentOffset.y, contentSize.height, layoutMeasurement.height)
    },
    [observe]
  )
  return { ...input, onScroll: observe == null ? undefined : onScroll }
}
