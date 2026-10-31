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
  View,
  type ViewStyle
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

import { REVERSE_HOLD_MS, useMountOrder } from '../components/mountOrder'
import { readNow } from '../components/readNow'
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
  /** The frame beneath the top: kept mounted, and what a drag back reveals. */
  renderBelow?: () => StackScene | undefined
  /** Header, banner and navbar, drawn above the topmost non-immersive scene. */
  chrome?: React.ReactNode
  /** Pops the top. Defined exactly when a drag back is allowed. */
  onSwipeBack?: () => void
  /** Read when the top changes; the shell clears it after each commit. */
  intent: { current: StackIntent | undefined }
  /** Whether Android's back gesture may drive a drag here. */
  predictiveBack?: boolean
  /** The same, asked again as a gesture comes (see `allows`). */
  predictiveBackNow?: () => boolean
  /**
   * Whether a pop asked for is still being decided (a leave check saving an
   * open note): a completed drag waits for it, run out, rather than
   * springing back and running out again once it lands.
   */
  popPending?: () => boolean
  headerHeight: number
  /** The floating navbar's height, for every scene's screen. */
  navigationHeight?: number
  onHandoff: (node: React.ReactNode) => void
  onHandoffHeight?: (height: number) => void
  onBackOverride: (handler: (() => void) | null) => void
  dragControls?: React.Ref<StackDragControls>
  /** A scene no longer drawn, with nothing of it kept. */
  onForget?: (key: string) => void
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
  /**
   * Where this move starts from: the move it turns back (a Back pressed
   * mid-push), or a drag let go (run out, or springing back).
   */
  reverses?: SharedValue<number>
  /** Whether it stands still a moment first: a move turned back does. */
  holds: boolean
}

interface Drag {
  /** Which drag: one taken over by Android's gesture is the same drag. */
  id: number
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
const FALLBACK_MS = 500
/**
 * The longest a completed drag stays run out waiting on a pop still being
 * decided (a leave check saving over a network that may stall): past it the
 * top springs back, usable, and a pop that lands later slides as Back does.
 */
const PENDING_MAX_MS = 3000
/** How often a pending pop is asked again: a refusal springs back soon. */
const PENDING_POLL_MS = 100

let transitions = 0
let drags = 0

/**
 * Android's back gesture as a drag back: the first progress reveals the
 * screen beneath, progress moves the top with the finger, `cancelled` springs
 * it back, and `invoked` completes the drag — or, a plain press with no drag,
 * pops with the ordinary back move.
 *
 * A gesture sends progress from the moment it starts. A Back key or button
 * press sends `started` and `invoked` and no progress, so it is not a drag:
 * it pops as the header's chevron does, turning a push back mid-way and
 * honouring reduced motion. Nor is a swipe from the right edge, where the
 * top would slide right, away from a finger moving left, nor a preview with
 * no edge, which three-button navigation's Back sends: each pops when it is
 * let go.
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
    /**
     * A gesture started and not yet drawn as a drag: kept across renders by
     * the navigator, since each render makes new handlers.
     */
    started?: { current: boolean }
    /**
     * Whether a drag may pop the top now, asked as the gesture comes: the
     * shell's `enabled` reaches here a render late, and the native callback
     * a bridge hop after that, so a gesture right after a pill change would
     * otherwise pop the screen rather than walk back to the last pill.
     */
    allows?: () => boolean
  }
): PredictiveBackHandlers {
  const started = options.started ?? { current: false }
  const on = (): boolean => options.enabled && options.allows?.() !== false
  return {
    enabled: options.enabled,
    onStart: () => {
      if (!on()) return
      // A drag the edge pan began is taken over now, before the pan's cancel
      // as the system takes the touch.
      if (options.dragging()) controls.begin('predictive')
      else started.current = true
    },
    onProgress: (progress, edge) => {
      if (!options.enabled) return
      if (started.current) {
        started.current = false
        // From the left edge only: from the right the top would slide away
        // from the finger, and a preview with no edge (three-button Back)
        // is a press.
        if ((edge ?? 'left') === 'left') controls.begin('predictive')
      }
      controls.move(progress * options.width(), 'predictive')
    },
    onCancel: () => {
      started.current = false
      controls.cancel('predictive')
    },
    onInvoke: () => {
      started.current = false
      if (!on()) {
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
  /**
   * Each scene key's instance. A key that comes back as a different frame —
   * game G pushed again from a team over game G (`[G, team, G]`), or that
   * second G popped off while the first is kept beneath — is a screen of its
   * own, not the hidden instance kept for the other frame.
   */
  const instances = useRef(new Map<string, number>())
  const renew = (key: string): void => {
    instances.current.set(key, (instances.current.get(key) ?? 0) + 1)
  }
  /**
   * The scene kept covered in the last commit, every scene mounted in it,
   * and the last move.
   */
  const lastCovered = useRef<string | undefined>(undefined)
  const lastMounted = useRef<ReadonlySet<string>>(new Set())
  const lastMove = useRef<
    { kind: Direction | 'none'; outgoing: string } | undefined
  >(undefined)
  const [shown, setShown] = useState<Shown>({ topKey: top.key })
  let current = shown

  // The top changed: work out the move now, in this render, so the scene that
  // is leaving is still in the tree in the commit that brings the new one.
  if (shown.topKey !== top.key) {
    const previous = committed.current
    const said = intent.current
    const move = transitionOf(previous, top, said?.direction)
    // A move turned back before it ends — Back mid-push, or the same scene
    // pushed again mid-pop — goes on from where the two scenes stand: the
    // progress means the same placing either way.
    const running = shown.transition
    const turned =
      running?.outgoing.key === top.key &&
      previous?.key === shown.topKey &&
      running.kind !== move.kind
        ? running.progress
        : undefined
    // So does the pop of a drag let go: one that completed pops at once,
    // and its move goes on from where the run out has the top (the new top's
    // header with it); one springing back (its pop refused, or late) has the
    // top coming back in, and its pop starts from where the spring stands.
    // The finger moved these, so they move under reduced motion too.
    const held = shown.drag
    const letGo =
      held?.beneath.key === top.key &&
      (held.completed || held.springing === true)
        ? held.progress
        : undefined
    const reverses = turned ?? letGo
    current = {
      topKey: top.key,
      transition:
        move.kind === 'none' ||
        previous == null ||
        (reduced && letGo == null) ||
        said?.drawn === true
          ? undefined
          : {
              id: ++transitions,
              kind: move.kind,
              presentation: move.presentation,
              outgoing: previous,
              progress: makeMutable(
                reverses != null
                  ? readNow(() => {
                      'worklet'
                      return reverses.value
                    })
                  : move.kind === 'forward'
                    ? 0
                    : 1
              ),
              reverses,
              holds: turned != null
            }
    }
    // Pushed onto the key of a scene still mounted — kept beneath, or still
    // sliding out of a push not yet done: a new screen. Decided by the move,
    // drawn or not (reduced motion, a move the browser drew). Not a pop
    // turned back: the screen it brings back is the one leaving.
    if (
      move.kind === 'forward' &&
      turned == null &&
      lastMounted.current.has(top.key)
    )
      renew(top.key)
    lastMove.current =
      previous == null ? undefined : { kind: move.kind, outgoing: previous.key }
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
    const { id, progress, reverses, holds } = transition
    // On the thread that moves the scenes: a move turned back starts where
    // the one it turns stands now, stops it, and holds a moment while the
    // scenes take their new places in a commit that reaches the screen a
    // frame or two later. A drag let go goes straight on.
    scheduleOnUI(() => {
      'worklet'
      if (reverses != null) {
        progress.value = reverses.value
        cancelAnimation(reverses)
      }
      const hold = holds ? REVERSE_HOLD_MS : 0
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
  const latest = useRef({
    renderBelow,
    onSwipeBack,
    width,
    topKey: top.key,
    predictiveBackNow: props.predictiveBackNow,
    popPending: props.popPending,
    onForget: props.onForget
  })
  latest.current = {
    renderBelow,
    onSwipeBack,
    width,
    topKey: top.key,
    predictiveBackNow: props.predictiveBackNow,
    popPending: props.popPending,
    onForget: props.onForget
  }
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(fallback.current)
    },
    []
  )
  // Ends the drag whose spring has finished, and no other: one dropped when
  // the top changed under it can finish springing after a new drag began.
  const endDrag = useCallback((id: number) => {
    setShown(held =>
      held.drag?.id === id ? { ...held, drag: undefined } : held
    )
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
    const { id } = held
    held.progress.value = withTiming(
      1,
      { ...TIMING, duration: SPRING_MS },
      done => {
        if (done === true) scheduleOnRN(endDrag, id)
      }
    )
  }, [endDrag])
  // Pops for a completed drag, and puts the top back if the stack does not
  // move. A top changed under the drag has already dropped it (`current`).
  const popped = useCallback(() => {
    const { onSwipeBack: pop, topKey } = latest.current
    pop?.()
    clearTimeout(fallback.current)
    const asked = Date.now()
    const wait = (delay: number): void => {
      fallback.current = setTimeout(() => {
        if (latest.current.topKey !== topKey || dragging.current == null) return
        // Still being decided, for a while: the top stays run out, asked
        // again often, so a refusal brings it back as soon as it comes.
        if (
          latest.current.popPending?.() === true &&
          Date.now() - asked < PENDING_MAX_MS
        )
          wait(PENDING_POLL_MS)
        // The stack did not move, or not in time: put the top back.
        else springBack()
      }, delay)
    }
    wait(FALLBACK_MS)
  }, [springBack])
  const controls = useRef<StackDragControls>({
    begin: () => false,
    move: () => undefined,
    release: () => undefined,
    cancel: () => undefined,
    complete: () => undefined
  })
  // The drag a source may act on: its own, and no other, and none once it
  // has completed or been let go to spring back — a second swipe started
  // while it runs out or springs back must not move it (which would stop the
  // spring short of ending the drag), cancel it, or complete it again.
  const owned = (source: DragSource): Drag | undefined => {
    const held = dragging.current
    return held?.source === source && !held.completed && held.springing !== true
      ? held
      : undefined
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
        // Taken up again if the pan's cancel came first: the finger has it,
        // from where the top stands now. The gesture's progress starts at
        // nothing, and adds to that.
        const { progress } = held
        const base = readNow(() => {
          'worklet'
          cancelAnimation(progress)
          return Math.min(1, Math.max(0, progress.value))
        })
        const taken: Drag = { ...held, source, springing: false, base }
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
      // Read and stopped together, where the push has it now.
      const covering =
        pushing?.kind === 'forward' && pushing.outgoing.key === beneath.key
          ? pushing.progress
          : undefined
      const base =
        covering == null
          ? 1
          : readNow(() => {
              'worklet'
              cancelAnimation(covering)
              return Math.min(1, Math.max(0, covering.value))
            })
      const next: Drag = {
        id: ++drags,
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
      // Runs out while the shell pops, which can take a few frames: the pop
      // then goes on from where this has the top.
      held.progress.value = withTiming(0, { ...TIMING, duration: SPRING_MS })
      popped()
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
  const gestureStarted = useRef(false)
  usePredictiveBack(
    backGestureHandlers(controls.current, {
      enabled: gestureBack,
      started: gestureStarted,
      allows: () => latest.current.predictiveBackNow?.() !== false,
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
    // Drawn as the shell has it now, as the top is: a drag held for a while
    // shows what changed beneath it meanwhile. The same scene, or the one it
    // began over if the shell no longer offers it.
    const below = renderBelow?.()
    add(
      below?.key === drag.beneath.key ? below : drag.beneath,
      'beneath',
      'lower'
    )
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
  // The scene beneath the top stays mounted, hidden, as it was when it was
  // covered: Back reveals it as it stood, not a fresh mount still loading.
  // Only the one beneath; a drag, a move or Back reveals no other.
  if (drag == null && transition == null) {
    const below = renderBelow?.()
    // Popped off onto the key of the frame now beneath it: that frame is
    // not the screen that just left.
    if (
      below != null &&
      lastMove.current?.kind === 'back' &&
      lastMove.current.outgoing === below.key &&
      lastCovered.current !== below.key
    )
      renew(below.key)
    if (below != null) add(below, 'covered', 'hidden')
  }
  const coveredKey = scenes.find(({ role }) => role === 'covered')?.scene.key
  useLayoutEffect(() => {
    lastCovered.current = coveredKey
    lastMounted.current = keys
    // The move's renewal is decided once it is at rest with a scene beneath.
    if (transition == null && coveredKey != null) lastMove.current = undefined
  })
  // A screen that draws no header coming over one — the scorer's cover, or
  // Replay and Coach Game pushed — or one popped back to, under a screen that
  // draws one leaving it: the header is the screen that draws it until the
  // move has landed.
  const coverRising = transition != null && top.immersive
  const presentation: Presentation =
    drag != null ? 'push' : (transition?.presentation ?? 'push')

  // A key no longer drawn forgets its instance too: it comes back as a new
  // screen whatever its number.
  const ordered = useMountOrder(
    scenes,
    ({ scene }) => scene.key,
    key => {
      instances.current.delete(key)
      latest.current.onForget?.(key)
    }
  )
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
      {ordered.map(({ scene, role, place }) => (
        <SceneFrame
          key={`${scene.key}~${instances.current.get(scene.key) ?? 0}`}
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
            navigationHeight={scene.immersive ? 0 : props.navigationHeight}
            onHandoff={onHandoff}
            onHandoffHeight={props.onHandoffHeight}
            holdsHandoff={coverRising ? role === 'outgoing' : role === 'top'}
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
      // As a prop: the browser build turns only that into the class that
      // lets touches through the layer to the scenes beneath, while the
      // header and navbar in it still take theirs.
      pointerEvents="box-none"
      style={[styles.chrome, { zIndex: z }, moving]}
    >
      {props.children}
    </Animated.View>
  )
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
  // Hidden, a scene keeps its layout, and with it its scrollers' places: a
  // browser drops a scroller's offset when it is taken out of layout
  // (`display: none`), so Back would show the covered screen at its top. A
  // hidden scene takes no pointer and no Tab focus.
  gone: { visibility: 'hidden' } as unknown as ViewStyle,
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
