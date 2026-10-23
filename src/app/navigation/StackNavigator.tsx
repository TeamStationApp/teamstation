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
  cancelAnimation,
  Easing,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming
} from 'react-native-reanimated'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'

import { useMotionPreference } from '../components/useMotionPreference'
import { usePredictiveBack } from './predictiveBack'
import type { PredictiveBackHandlers } from './predictiveBackTypes'
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
  begin: (source?: DragSource) => boolean
  move: (dx: number, source?: DragSource) => void
  release: (dx: number, vx: number, source?: DragSource) => void
  cancel: (source?: DragSource) => void
  /** Completes from wherever the drag is, as a back press after a drag does. */
  complete: (source?: DragSource) => void
}

/**
 * What is driving a drag. Each only moves, ends or cancels a drag it began:
 * under Android's gesture navigation the system takes an edge touch from the
 * app's pan, whose cancel must not end the back gesture's drag.
 */
export type DragSource = 'pan' | 'predictive'

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
  /** The move this one turns back, for a Back pressed mid-push. */
  reverses?: SharedValue<number>
}

interface Drag {
  beneath: StackScene
  completed: boolean
  /** Let go short of popping, and springing back: it no longer owns Back. */
  springing?: boolean
  /**
   * Where the top stood as the drag began: at rest, or part way in when a
   * push was still running. The finger moves it from there.
   */
  base: number
  progress: SharedValue<number>
  source: DragSource
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
// transition is then not started at all. A drag still follows the finger,
// and once let go springs back or runs out in `SPRING_MS` as it would
// otherwise: the person moved the screen themselves.
const TIMING = { easing: EASE, reduceMotion: ReduceMotion.Never }
const SPRING_MS = 250
/** How long a move turned back mid-way stands still before it goes back. */
const REVERSE_HOLD_MS = 48
const FALLBACK_MS = 500

let transitions = 0

/**
 * Android's back gesture as a drag back: `started` reveals the screen
 * beneath, progress moves the top with the finger, `cancelled` springs it
 * back, and `invoked` completes the drag — or, a plain press with no drag,
 * pops with the ordinary back move.
 *
 * Off, it takes nothing: the native callback is turned off an effect and a
 * bridge hop after the shell says so (Tess's layer opening, a pill change),
 * and a gesture in that gap must neither drag the top nor pop it. Its press
 * goes on to `BackHandler`, as it would once the callback is off.
 */
export function backGestureHandlers(
  controls: StackDragControls,
  options: {
    enabled: boolean
    width: () => number
    dragging: () => boolean
    /** Pops the top; false when there is nothing to pop it with. */
    pop: () => boolean
  }
): PredictiveBackHandlers {
  return {
    enabled: options.enabled,
    onStart: () => {
      if (options.enabled) controls.begin('predictive')
    },
    onProgress: progress => {
      if (options.enabled)
        controls.move(progress * options.width(), 'predictive')
    },
    onCancel: () => {
      controls.cancel('predictive')
    },
    onInvoke: () => {
      if (!options.enabled) {
        // A drag it began before turning off is let go, not completed.
        controls.cancel('predictive')
        return false
      }
      if (!options.dragging()) return options.pop()
      controls.complete('predictive')
      return true
    }
  }
}

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
    // A drag that ran out pops with nothing more to draw; one springing back
    // (its pop refused, or late) has the top coming back in, and its pop
    // plays as a move from where the spring stands (below).
    const dragged =
      shown.drag?.completed === true &&
      shown.drag.springing !== true &&
      shown.drag.beneath.key === top.key
    // A move turned back before it ends — Back mid-push, or the same scene
    // pushed again mid-pop — goes on from where the two scenes stand: the
    // progress means the same placing either way.
    const running = shown.transition
    // So does a Back while a drag springs back: the pop starts from where
    // the drag let go of the top.
    const springing =
      shown.drag?.springing === true && shown.drag.beneath.key === top.key
        ? shown.drag.progress
        : undefined
    const reverses =
      running?.outgoing.key === top.key &&
      previous?.key === shown.topKey &&
      running.kind !== move.kind
        ? running.progress
        : springing
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
              progress: makeMutable(
                reverses != null
                  ? reverses.value
                  : move.kind === 'forward'
                    ? 0
                    : 1
              ),
              reverses
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
    const whole = transition.presentation === 'cover' ? COVER_MS : PUSH_MS
    const { id, progress, reverses } = transition
    // On the thread that moves the scenes: a move turned back starts where
    // the one it turns stands now, stops it, and holds a moment while the
    // scenes take their new places in a commit that reaches the screen a
    // frame or two later.
    scheduleOnUI(() => {
      'worklet'
      let hold = 0
      if (reverses != null) {
        progress.value = reverses.value
        cancelAnimation(reverses)
        hold = REVERSE_HOLD_MS
      }
      const left = forward ? 1 - progress.value : progress.value
      progress.value = withDelay(
        hold,
        withTiming(
          forward ? 1 : 0,
          // The rest of a move turned back takes the rest of the time.
          { ...TIMING, duration: whole * left },
          finished => {
            if (finished === true) scheduleOnRN(finish, id)
          }
        ),
        ReduceMotion.Never
      )
    })
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
    // Once: a cancelled pan says so twice, as it ends and as it is finalized.
    if (held == null || held.springing === true) return
    dragging.current = { ...held, springing: true }
    setShown(shownNow =>
      shownNow.drag === held
        ? { ...shownNow, drag: dragging.current }
        : shownNow
    )
    held.progress.value = withTiming(
      1,
      { ...TIMING, duration: SPRING_MS },
      done => {
        if (done === true) scheduleOnRN(endDrag)
      }
    )
  }, [endDrag])
  // `from` is the top the drag completed on: a Back that popped it while the
  // drag ran out has done the drag's work.
  const popped = useCallback(
    (from: string) => {
      const { onSwipeBack: pop, topKey } = latest.current
      if (topKey !== from) return
      pop?.()
      clearTimeout(fallback.current)
      fallback.current = setTimeout(() => {
        // The stack did not move: put the top back.
        if (latest.current.topKey === topKey && dragging.current != null)
          springBack()
      }, FALLBACK_MS)
    },
    [springBack]
  )
  const controls = useRef<StackDragControls>({
    begin: () => false,
    move: () => undefined,
    release: () => undefined,
    cancel: () => undefined,
    complete: () => undefined
  })
  // The drag a source may act on: its own, and no other, and none once it
  // has completed — a second swipe started while it runs out must not move
  // it, cancel it, or complete it again.
  const owned = (source: DragSource): Drag | undefined => {
    const held = dragging.current
    return held?.source === source && !held.completed ? held : undefined
  }
  controls.current = {
    begin: (source = 'pan') => {
      const held = dragging.current
      if (held != null) {
        // Under gesture navigation the edge pan can start on the first move,
        // before the system says it has the gesture: the back gesture takes
        // that drag over, so the pan's cancel when the system takes the
        // touch leaves it alone.
        if (source !== 'predictive' || held.source !== 'pan' || held.completed)
          return false
        // Taken up again if the pan's cancel came first: the finger has it.
        cancelAnimation(held.progress)
        const taken: Drag = { ...held, source, springing: false }
        dragging.current = taken
        setShown(shownNow => ({ ...shownNow, drag: taken }))
        return true
      }
      // Not while a pop is still taking the top off: the scene leaving would
      // vanish and the new top jump to rest under the finger. Back then pops
      // again as a press does.
      if (shown.transition?.kind === 'back') return false
      const { renderBelow: below, onSwipeBack: pop } = latest.current
      const beneath = pop == null ? undefined : below?.()
      if (beneath == null) return false
      // A drag begun while a push is still bringing the top in takes the top
      // from where the push has it, over the scene it was covering.
      const pushing = shown.transition
      const base =
        pushing?.kind === 'forward' && pushing.outgoing.key === beneath.key
          ? Math.min(1, Math.max(0, pushing.progress.value))
          : 1
      if (base < 1 && pushing != null) cancelAnimation(pushing.progress)
      const next: Drag = {
        beneath,
        completed: false,
        progress: makeMutable(base),
        source,
        base
      }
      dragging.current = next
      setShown(held => ({ ...held, transition: undefined, drag: next }))
      return true
    },
    move: (dx, source = 'pan') => {
      const held = owned(source)
      if (held == null) return
      held.progress.value = Math.min(
        1,
        Math.max(0, held.base - dx / latest.current.width)
      )
    },
    release: (dx, vx, source = 'pan') => {
      const held = owned(source)
      if (held == null) return
      // Decided on where the top stands, which for a drag begun mid-push is
      // further along than the finger has gone.
      const { width: across } = latest.current
      if (swipeCompletes(dx + (1 - held.base) * across, vx, across))
        controls.current.complete(source)
      else controls.current.cancel(source)
    },
    cancel: (source = 'pan') => {
      if (owned(source) == null) return
      springBack()
    },
    complete: (source = 'pan') => {
      const held = owned(source)
      // A completed drag has already popped once (`owned` gives none); until
      // the top changes, or its pop is refused and it springs back, a second
      // Back adds nothing.
      if (held == null) return
      // Completed from here on, not once it has run out: Back in between is
      // this drag's, not a second pop.
      const taken: Drag = { ...held, completed: true }
      dragging.current = taken
      setShown(shownNow =>
        shownNow.drag === held ? { ...shownNow, drag: taken } : shownNow
      )
      const from = latest.current.topKey
      held.progress.value = withTiming(
        0,
        { ...TIMING, duration: SPRING_MS },
        done => {
          if (done === true) scheduleOnRN(popped, from)
        }
      )
    }
  }
  useImperativeHandle(
    props.dragControls,
    () => ({
      begin: source => controls.current.begin(source),
      move: (dx, source) => {
        controls.current.move(dx, source)
      },
      release: (dx, vx, source) => {
        controls.current.release(dx, vx, source)
      },
      cancel: source => {
        controls.current.cancel(source)
      },
      complete: source => {
        controls.current.complete(source)
      }
    }),
    []
  )
  const swipeEnabled = onSwipeBack != null && Platform.OS !== 'web'
  // Never on without a pop: the shell turns it off an effect and a bridge hop
  // after a back override takes Back.
  const gestureBack = props.predictiveBack === true && onSwipeBack != null
  usePredictiveBack(
    backGestureHandlers(controls.current, {
      enabled: gestureBack,
      width: () => latest.current.width,
      // A drag under way, or run out, owns Back: a three-button Back during
      // the edge pan's drag must not pop beside it. One springing back has
      // been given up, and Back pops as it would without it.
      dragging: () =>
        dragging.current != null && dragging.current.springing !== true,
      pop: () => {
        const pop = latest.current.onSwipeBack
        if (pop == null) return false
        pop()
        return true
      }
    })
  )

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
    // A scene kept beneath the next (the scorer) leaves as the scene it is
    // now kept as — inactive — rather than as it was last on top.
    add(
      retained?.key === transition.outgoing.key
        ? { ...transition.outgoing, node: retained.node }
        : transition.outgoing,
      'outgoing',
      forward ? 'lower' : 'upper'
    )
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
  // Pushed over a scene that draws no chrome (the scorer), or popped back to
  // it, the header and navbar are the moving scene's: they slide with it.
  const chromeRides =
    presentation === 'push' &&
    visible.some(({ scene, place }) => place === 'upper' && !scene.immersive) &&
    visible.some(({ scene, place }) => place === 'lower' && scene.immersive)

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
        predictiveBack: String(gestureBack)
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
        <ChromeFrame
          key="chrome"
          q={drag?.progress ?? transition?.progress ?? resting}
          width={width}
          rides={chromeRides}
          z={chromeZ}
        >
          {chrome}
        </ChromeFrame>
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
/** The header and navbar, sliding with the scene they belong to (`rides`). */
function ChromeFrame(props: {
  q: SharedValue<number>
  width: number
  rides: boolean
  z: number
  children: React.ReactNode
}): React.ReactElement {
  const { q, width, rides, z } = props
  const moving = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: rides ? (1 - Math.min(1, Math.max(0, q.value))) * width : 0
      }
    ]
  }))
  return (
    <Animated.View
      dataSet={{ chrome: 'true', chromeRides: String(rides) }}
      style={[styles.chrome, { zIndex: z }, moving]}
    >
      {props.children}
    </Animated.View>
  )
}

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
  })
  const dim = useAnimatedStyle(() => ({
    opacity:
      place === 'lower' && presentation === 'push'
        ? 0.1 * Math.min(1, Math.max(0, q.value))
        : 0
  }))
  const { controls } = props
  // Every scene has its own, so a scene keeps its tree when it stops being
  // the top; only the top's is enabled.
  const pan = usePanGesture({
    enabled: props.swipe,
    runOnJS: true,
    // Only a touch that starts at the left edge reaches it; one anywhere else
    // never meets the recognizer, and goes to the content as before.
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
  // On the scene itself rather than a view over its edge, which would take a
  // scroll or a tap that starts there from the content beneath. The browser
  // owns its edges; there is no edge pan on the web.
  return Platform.OS === 'web' ? (
    frame
  ) : (
    <GestureDetector gesture={pan}>{frame}</GestureDetector>
  )
}

/** What the e2e sampler reads: incoming and outgoing during a transition. */
function sceneRoleOf(role: SceneRole, place: Place): string {
  return role === 'top' && (place === 'upper' || place === 'lower')
    ? 'incoming'
    : role
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
