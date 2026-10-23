import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  type LayoutChangeEvent,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { useMotionPreference } from '../components/useMotionPreference'
import { type SceneRole, SceneSlot } from './sceneSlot'
import {
  COVER_MS,
  type Direction,
  EDGE_WIDTH,
  PARALLAX,
  type Presentation,
  PUSH_MS,
  type StackScene,
  swipeCompletes,
  transitionOf
} from './stackScene'

/** Which way the navigation that changes the top went, from the shell. */
export interface StackIntent {
  direction: Direction | 'none'
  /** The browser already drew it; show it settled. */
  drawn?: boolean
}

/**
 * A drag back, driven by the edge pan or by Android's back gesture. `move`
 * takes how far the top has been dragged, in px.
 */
export interface StackDragControls {
  begin: () => boolean
  move: (dx: number) => void
  release: (dx: number, vx: number) => void
  cancel: () => void
  /** Completes from wherever the drag is, as a back press after a drag does. */
  complete: () => void
}

export interface StackNavigatorProps {
  top: StackScene
  /** Kept mounted and hidden: the scorer under a player's settings. */
  retained?: StackScene
  /** The scene a drag back reveals: the frame beneath the top. */
  renderBelow?: () => StackScene | undefined
  /** Header, banner and navbar, drawn above the topmost non-immersive scene. */
  chrome?: React.ReactNode
  /** Pops the top. Defined exactly when a drag back is allowed. */
  onSwipeBack?: () => void
  /** Read when the top changes; the shell clears it after each commit. */
  intent: { current: StackIntent | undefined }
  /** Whether Android's back gesture may drive a drag here. */
  predictiveBack?: boolean
  headerHeight: number
  onHandoff: (node: React.ReactNode) => void
  onBackOverride: (handler: (() => void) | null) => void
  dragControls?: React.Ref<StackDragControls>
}

/**
 * Each move and each drag has its own progress, made holding its start: the
 * first frame a new scene is drawn in is already where its move begins, with
 * nothing written to a shared value while React renders.
 */
interface Transition {
  id: number
  kind: Direction
  presentation: Presentation
  outgoing: StackScene
  progress: SharedValue<number>
}

interface Drag {
  beneath: StackScene
  completed: boolean
  progress: SharedValue<number>
}

interface Shown {
  topKey: string
  transition?: Transition
  drag?: Drag
}

/** How a scene is placed: the upper or lower of a moving pair, or still. */
type Place = 'upper' | 'lower' | 'rest' | 'hidden'

const EASE = Easing.bezier(0.2, 0.9, 0.3, 1)
// The navigator decides reduced motion for itself (`useMotionPreference`): a
// transition is then not started at all, while a drag still follows the
// finger and settles where it is let go.
const TIMING = { easing: EASE, reduceMotion: ReduceMotion.Never }
const SPRING_MS = 250
const FALLBACK_MS = 500

let transitions = 0

/**
 * The tab stacks' one transition layer: pushed screens slide in from the right
 * over the screen they cover, which shifts 30% left; a cover slides up over
 * everything; Back plays either in reverse; a drag from the left edge takes
 * the top off with the finger.
 *
 * The shell's router decides what is on top; this only draws the move from
 * the last top to the new one. Each scene is keyed, so a screen keeps its
 * React instance while its role changes — the top leaving becomes the
 * outgoing scene, a scene revealed by a drag becomes the top — and the
 * children render in the order they were first mounted, with stacking by
 * `zIndex`, so a role change never moves a DOM node (a moved `<video>` or
 * `<iframe>` starts over).
 */
export function StackNavigator(props: StackNavigatorProps): React.ReactElement {
  const {
    top,
    retained,
    renderBelow,
    chrome,
    onSwipeBack,
    intent,
    headerHeight,
    onHandoff,
    onBackOverride
  } = props
  const reduced = useMotionPreference()
  const window = useWindowDimensions()
  const [size, setSize] = useState({ width: 0, height: 0 })
  const width = size.width > 0 ? size.width : window.width
  const height = size.height > 0 ? size.height : window.height
  const resting = useSharedValue(1)
  const committed = useRef<StackScene | undefined>(undefined)
  const [shown, setShown] = useState<Shown>({ topKey: top.key })
  let current = shown

  // The top changed: work out the move now, in this render, so the scene that
  // is leaving is still in the tree in the commit that brings the new one.
  if (shown.topKey !== top.key) {
    const previous = committed.current
    const said = intent.current
    const move = transitionOf(previous, top, said?.direction)
    const dragged =
      shown.drag?.completed === true && shown.drag.beneath.key === top.key
    current = {
      topKey: top.key,
      transition:
        move.kind === 'none' ||
        previous == null ||
        reduced ||
        said?.drawn === true ||
        dragged
          ? undefined
          : {
              id: ++transitions,
              kind: move.kind,
              presentation: move.presentation,
              outgoing: previous,
              progress: makeMutable(move.kind === 'forward' ? 0 : 1)
            }
    }
    setShown(current)
  }
  const { transition, drag } = current

  useLayoutEffect(() => {
    committed.current = top
  })

  const finish = useCallback((id: number) => {
    setShown(held =>
      held.transition?.id === id ? { ...held, transition: undefined } : held
    )
  }, [])
  useLayoutEffect(() => {
    if (transition == null) return
    const forward = transition.kind === 'forward'
    const duration = transition.presentation === 'cover' ? COVER_MS : PUSH_MS
    const id = transition.id
    transition.progress.value = withTiming(
      forward ? 1 : 0,
      { ...TIMING, duration },
      finished => {
        if (finished === true) scheduleOnRN(finish, id)
      }
    )
  }, [transition, finish])

  // A drag back.
  const dragging = useRef<Drag | undefined>(undefined)
  dragging.current = drag
  const latest = useRef({ renderBelow, onSwipeBack, width, topKey: top.key })
  latest.current = { renderBelow, onSwipeBack, width, topKey: top.key }
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(fallback.current)
    },
    []
  )
  const endDrag = useCallback(() => {
    setShown(held => (held.drag == null ? held : { ...held, drag: undefined }))
  }, [])
  const springBack = useCallback(() => {
    const held = dragging.current
    if (held == null) return
    held.progress.value = withTiming(
      1,
      { ...TIMING, duration: SPRING_MS },
      done => {
        if (done === true) scheduleOnRN(endDrag)
      }
    )
  }, [endDrag])
  const popped = useCallback(() => {
    const { onSwipeBack: pop, topKey } = latest.current
    setShown(held =>
      held.drag == null
        ? held
        : { ...held, drag: { ...held.drag, completed: true } }
    )
    pop?.()
    clearTimeout(fallback.current)
    fallback.current = setTimeout(() => {
      // The stack did not move: put the top back.
      if (latest.current.topKey === topKey && dragging.current != null)
        springBack()
    }, FALLBACK_MS)
  }, [springBack])
  const controls = useRef<StackDragControls>({
    begin: () => false,
    move: () => undefined,
    release: () => undefined,
    cancel: () => undefined,
    complete: () => undefined
  })
  controls.current = {
    begin: () => {
      if (dragging.current != null) return false
      const { renderBelow: below, onSwipeBack: pop } = latest.current
      const beneath = pop == null ? undefined : below?.()
      if (beneath == null) return false
      const next: Drag = { beneath, completed: false, progress: makeMutable(1) }
      dragging.current = next
      setShown(held => ({ ...held, transition: undefined, drag: next }))
      return true
    },
    move: dx => {
      const held = dragging.current
      if (held == null) return
      held.progress.value = Math.min(
        1,
        Math.max(0, 1 - dx / latest.current.width)
      )
    },
    release: (dx, vx) => {
      if (dragging.current == null) return
      if (swipeCompletes(dx, vx, latest.current.width))
        controls.current.complete()
      else controls.current.cancel()
    },
    cancel: () => {
      if (dragging.current == null) return
      springBack()
    },
    complete: () => {
      const held = dragging.current
      if (held == null) return
      held.progress.value = withTiming(
        0,
        { ...TIMING, duration: SPRING_MS },
        done => {
          if (done === true) scheduleOnRN(popped)
        }
      )
    }
  }
  useImperativeHandle(
    props.dragControls,
    () => ({
      begin: () => controls.current.begin(),
      move: dx => {
        controls.current.move(dx)
      },
      release: (dx, vx) => {
        controls.current.release(dx, vx)
      },
      cancel: () => {
        controls.current.cancel()
      },
      complete: () => {
        controls.current.complete()
      }
    }),
    []
  )
  const swipeEnabled = onSwipeBack != null && Platform.OS !== 'web'

  // Who is mounted, and how each is placed.
  const scenes: Array<{ scene: StackScene; role: SceneRole; place: Place }> = []
  const keys = new Set<string>()
  const add = (scene: StackScene, role: SceneRole, place: Place): void => {
    if (keys.has(scene.key)) return
    keys.add(scene.key)
    scenes.push({ scene, role, place })
  }
  if (drag != null) {
    add(top, 'top', 'upper')
    add(drag.beneath, 'beneath', 'lower')
  } else if (transition != null) {
    const forward = transition.kind === 'forward'
    add(top, 'top', forward ? 'upper' : 'lower')
    add(transition.outgoing, 'outgoing', forward ? 'lower' : 'upper')
  } else add(top, 'top', 'rest')
  if (retained != null) add(retained, 'retained', 'hidden')
  const presentation: Presentation =
    drag != null ? 'push' : (transition?.presentation ?? 'push')

  const order = useRef(new Map<string, number>())
  let next = 0
  for (const value of order.current.values()) next = Math.max(next, value + 1)
  for (const { scene } of scenes)
    if (!order.current.has(scene.key)) order.current.set(scene.key, next++)
  useLayoutEffect(() => {
    for (const key of [...order.current.keys()])
      if (!keys.has(key)) order.current.delete(key)
  })
  // Whole numbers: CSS drops a fractional z-index.
  const zOf = (place: Place): number =>
    place === 'hidden' ? 0 : place === 'lower' ? 2 : 4
  const visible = scenes.filter(({ place }) => place !== 'hidden')
  const plain = visible
    .filter(({ scene }) => !scene.immersive)
    .map(({ place }) => zOf(place))
  const chromeZ = plain.length === 0 ? undefined : Math.max(...plain) + 1

  const onLayout = (event: LayoutChangeEvent): void => {
    const { width: w, height: h } = event.nativeEvent.layout
    if (w !== size.width || h !== size.height) setSize({ width: w, height: h })
  }

  return (
    <View
      style={styles.container}
      onLayout={onLayout}
      dataSet={{
        swipeBack: String(onSwipeBack != null),
        predictiveBack: String(props.predictiveBack === true)
      }}
    >
      {[...scenes]
        .sort(
          (a, b) =>
            (order.current.get(a.scene.key) ?? 0) -
            (order.current.get(b.scene.key) ?? 0)
        )
        .map(({ scene, role, place }) => (
          <SceneFrame
            key={scene.key}
            sceneKey={scene.key}
            role={role}
            place={place}
            presentation={presentation}
            q={drag?.progress ?? transition?.progress ?? resting}
            width={width}
            height={height}
            z={zOf(place)}
            swipe={role === 'top' && swipeEnabled}
            controls={controls}
          >
            <SceneSlot
              role={role}
              headerHeight={scene.immersive ? 0 : headerHeight}
              onHandoff={onHandoff}
              onBackOverride={onBackOverride}
            >
              {scene.node}
            </SceneSlot>
          </SceneFrame>
        ))}
      {chromeZ != null && (
        <View
          key="chrome"
          dataSet={{ chrome: 'true' }}
          style={[styles.chrome, { zIndex: chromeZ }]}
        >
          {chrome}
        </View>
      )}
    </View>
  )
}

interface SceneFrameProps {
  sceneKey: string
  role: SceneRole
  place: Place
  presentation: Presentation
  q: SharedValue<number>
  width: number
  height: number
  z: number
  /** The edge pan, on the top scene of a phone when a drag back is allowed. */
  swipe: boolean
  controls: { current: StackDragControls }
  children: React.ReactNode
}

/** One scene's wrapper: where it sits in the move, and whether it takes touches. */
function SceneFrame(props: SceneFrameProps): React.ReactElement {
  const { role, place, presentation, q, width, height, z } = props
  // Clamped: a frame stamped a moment before the animation began eases a
  // negative time, which would nudge the scene past where it starts.
  const moving = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, q.value))
    if (place === 'upper')
      return presentation === 'cover'
        ? { transform: [{ translateY: (1 - p) * height }] }
        : { transform: [{ translateX: (1 - p) * width }] }
    if (place === 'lower' && presentation === 'push')
      return { transform: [{ translateX: -PARALLAX * p * width }] }
    return { transform: [{ translateX: 0 }] }
  }, [q, place, presentation, width, height])
  const dim = useAnimatedStyle(
    () => ({
      opacity:
        place === 'lower' && presentation === 'push'
          ? 0.1 * Math.min(1, Math.max(0, q.value))
          : 0
    }),
    [q, place, presentation]
  )
  const { controls } = props
  // Every scene has its own, so a scene keeps its tree when it stops being
  // the top; only the top's is enabled.
  const pan = usePanGesture({
    enabled: props.swipe,
    runOnJS: true,
    hitSlop: { left: 0, width: EDGE_WIDTH },
    activeOffsetX: 10,
    failOffsetY: [-20, 20],
    onActivate: () => {
      controls.current.begin()
    },
    onUpdate: event => {
      controls.current.move(event.translationX)
    },
    onDeactivate: event => {
      if (event.canceled) controls.current.cancel()
      else controls.current.release(event.translationX, event.velocityX)
    },
    onFinalize: event => {
      if (event.canceled) controls.current.cancel()
    }
  })
  const inactive = role !== 'top'
  const hidden = place === 'hidden'
  const frame = (
    <Animated.View
      dataSet={{ scene: props.sceneKey, sceneRole: sceneRoleOf(role, place) }}
      aria-hidden={inactive}
      importantForAccessibility={inactive ? 'no-hide-descendants' : 'auto'}
      style={[
        styles.scene,
        { zIndex: z, pointerEvents: inactive ? 'none' : 'auto' },
        place === 'upper' && presentation === 'push' && styles.edgeShadow,
        hidden && (Platform.OS === 'web' ? styles.gone : styles.invisible),
        moving
      ]}
    >
      {props.children}
      {place === 'lower' && <Animated.View style={[styles.dim, dim]} />}
    </Animated.View>
  )
  // The browser owns its edges; there is no edge pan on the web.
  return Platform.OS === 'web' ? (
    frame
  ) : (
    <GestureDetector gesture={pan}>{frame}</GestureDetector>
  )
}

/** What the e2e sampler reads: incoming and outgoing during a transition. */
function sceneRoleOf(role: SceneRole, place: Place): string {
  if (role === 'top' && place === 'upper') return 'incoming'
  if (role === 'top' && place === 'lower') return 'incoming'
  return role
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden'
  },
  scene: {
    ...StyleSheet.absoluteFill
  },
  edgeShadow: {
    boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.18)'
  },
  gone: {
    display: 'none'
  },
  invisible: {
    opacity: 0
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000',
    pointerEvents: 'none'
  },
  chrome: {
    ...StyleSheet.absoluteFill,
    pointerEvents: 'box-none'
  }
})
