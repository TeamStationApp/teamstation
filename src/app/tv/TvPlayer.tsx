import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  Animated,
  AppState,
  BackHandler,
  Easing,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg'
import type { VideoRef } from 'react-native-video'

import type {
  BoardTimelineWindow,
  TeamStationClient,
  TvHighlight,
  VideoSummary
} from '../../common/api'
import type { ScoreboardOverlay } from '../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../common/scoreboard'
import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { useMotionPreference } from '../components/useMotionPreference'
import type { Rect as TileRect } from '../player/multiCam/layout'
import { angleLabels } from '../player/multiCam/takes'
import type { NativeProgressData } from '../player/nativeProgress'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import { LineScoreBox } from '../player/scoreboardOverlay/LineScoreBox'
import { ScoreboardOverlay as PlacedScoreboard } from '../player/scoreboardOverlay/ScoreboardOverlay'
import {
  focusMagnification,
  NativeGradient,
  PlaybackBoundary,
  reducedMotionThumbnail,
  staticTileFocus,
  TvPoster
} from './NativePresentation'
import { NativeSeekQueue } from './nativeSeekQueue'
import { PlaybackClock } from './playbackClock'
import { PlaybackRecovery } from './playbackRecovery'
import {
  initialPlayback,
  type PlaybackAction,
  playbackReducer,
  type SidePanel
} from './playbackState'
import { timelineFor } from './playbackTimeline'
import { normalizeRemote, tvControl, tvEvents, TvFocusGuide } from './remote'
import {
  lineOf,
  readTvStatistics,
  type ReplayStatistics,
  statisticsAt
} from './replayStatistics'
import { TvTransport } from './transportState'
import { TransportVideo } from './TransportVideo'
import type { TvPlayRequest } from './TvBrowser'
import { TvButton } from './TvButton'
import { angleNeighbor, tvLayout } from './tvLayout'

const HIGHLIGHTS_PANEL_WIDTH = 420
const LAYOUT_DURATION = 240
const STATS_SCROLL_SENSITIVITY = 0.5
/** The one error camera recovery raises, and so the only one it may clear. */
const CAMERAS_FAILED = 'The cameras could not play. Try again.'
const withoutRecoveryError = (previous: string | null): string | null =>
  previous === CAMERAS_FAILED ? null : previous
/** Unchanged when `index` was not failing, so a playing camera re-renders nothing. */
const without =
  (index: number) =>
  (previous: number[]): number[] =>
    previous.includes(index) ? previous.filter(i => i !== index) : previous

interface Angle {
  name: string
  video: VideoSummary
  uri: string
  timeline: WallTimeline
  revision: number
}
interface Statistics extends ReplayStatistics {
  board: BoardTimelineWindow | null
}
const EMPTY_STATS: Statistics = {
  board: null,
  boxes: [],
  message: 'Loading statistics…'
}

export function TvPlayer({
  client,
  request,
  onClose
}: {
  client: TeamStationClient
  request: TvPlayRequest
  onClose: () => void
}): React.ReactElement {
  const [angles, setAngles] = useState<Angle[] | null>(null)
  const anglesRef = useRef<Angle[] | null>(null)
  anglesRef.current = angles
  const recovery = useRef(new Map<number, PlaybackRecovery>())
  const refreshing = useRef(new Set<number>())
  /** `finished`: a live camera swapped on purpose for its recording. */
  const refreshAngle = useRef<
    ((index: number, reason?: 'recover' | 'finished') => Promise<void>) | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const screen = useWindowDimensions()
  const reducedMotion = useMotionPreference()
  const lastExpanded = useRef<number | null>(null)
  const [boardSize, setBoardSize] = useState<{ width: number; height: number }>(
    SCOREBOARD_BOARD_SIZE
  )
  const measureBoard = useCallback(
    (size: { width: number; height: number }): void => {
      setBoardSize(old =>
        old.width === size.width && old.height === size.height ? old : size
      )
    },
    []
  )
  const angleNodes = useRef<Array<React.ComponentRef<typeof View> | null>>([])
  const focusedAngle = useRef<number | null>(0)
  const lastAngle = useRef(0)
  const focusChangedAt = useRef(0)
  const [highlightFocus, setHighlightFocus] = useState<string | null>(null)
  const [cameraFocus, setCameraFocus] = useState<number | null>(null)
  const statsScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const statsOffset = useRef(0)
  const statsPan = useRef<{
    y: number
    startY: number
    moved: boolean
    startedAtTop: boolean
  } | null>(null)
  const statsPanEnded = useRef(0)
  const statsMomentum = useRef<ReturnType<typeof requestAnimationFrame> | null>(
    null
  )
  const statsExtent = useRef({ content: 0, viewport: 0 })
  const scoreScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const scoreOffset = useRef(0)
  const scoreExtent = useRef({ content: 0, viewport: 0 })
  const [placement, setPlacement] = useState<ScoreboardOverlay | null>(null)
  useEffect(() => {
    let active = true
    let pending = false
    setPlacement(null)
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const value = await client.scoreboardOverlay(request.game.id)
        if (active) setPlacement(value)
      } catch {
        /* Retain the last authorized placement during transient failures. */
      } finally {
        pending = false
      }
    }
    refresh().catch(() => undefined)
    const timer = setInterval(() => {
      refresh().catch(() => undefined)
    }, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [client, request.game.id])
  const [focus, setFocus] = useState<number | null>(null)
  const [clips, setClips] = useState<TvHighlight[]>([])
  const [clipError, setClipError] = useState(false)
  const [stats, setStats] = useState<Statistics>(EMPTY_STATS)
  const [wall, setWall] = useState<number | null>(null)
  const [failures, setFailures] = useState<number[]>([])
  const [buffering, setBuffering] = useState<number[]>([])
  const bufferingRef = useRef(buffering)
  bufferingRef.current = buffering
  const [state, dispatch] = useReducer(playbackReducer, 0, initialPlayback)
  const current = useRef(state)
  current.current = state
  const refs = useRef<Array<VideoRef | null>>([])
  const seekQueues = useRef<NativeSeekQueue[]>([])
  const clock = useRef(new PlaybackClock())
  const [transportState, setTransportState] = useState({
    visible: false,
    rate: 1,
    scrubbing: false
  })
  const pendingRecordingEnd = useRef(false)
  const scrubber = useRef<ScrubberHandle>(null)
  const scrubWidth = useRef(screen.width - 320)
  const transport = useRef<TvTransport | null>(null)
  transport.current ??= new TvTransport({
    move: seconds => {
      const next = clock.current.move(seconds)
      if (next !== null) {
        setWall(next)
        dispatch({ type: 'seek' })
      }
    },
    seek: target => {
      clock.current.seek(target)
      setWall(target)
      dispatch({ type: 'seek' })
    },
    preview: target => scrubber.current?.preview(target),
    position: () => clock.current.wall,
    extent: () => clock.current.extent(),
    width: () => scrubWidth.current,
    panEnabled: enabled =>
      enabled || current.current.box !== 'closed'
        ? tvControl?.enableTVPanGesture()
        : tvControl?.disableTVPanGesture(),
    changed: snapshot => {
      setTransportState(snapshot)
      // Drain after the whole input action (cancel + optional seek), independently
      // of React batching. A new drag or game invalidates this pending drain.
      if (!snapshot.scrubbing) {
        const activeGeneration = generation.current
        queueMicrotask(() => {
          if (
            generation.current !== activeGeneration ||
            transport.current?.scrubbing === true
          )
            return
          if (pendingRecordingEnd.current) {
            pendingRecordingEnd.current = false
            if (
              !clock.current.ports.some((_, i) => clock.current.available(i))
            ) {
              dispatch({ type: 'ended' })
              dispatch({ type: 'open', panel: 'highlights' })
            }
          }
          const position = clock.current.wall
          if (position !== null) dispatch({ type: 'progress', wall: position })
        })
      }
    },
    now: Date.now,
    later: (callback, ms) => setTimeout(callback, ms),
    clear: timer => {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    }
  })
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => {
      if (value !== 'active') transport.current?.cancel()
    })
    return () => {
      subscription.remove()
      transport.current?.cancel()
    }
  }, [])
  useEffect(() => {
    if (state.side !== null || state.box !== 'closed' || error !== null)
      transport.current?.cancel()
  }, [state.side, state.box, error])
  const statisticsRefresh = useRef<(() => Promise<void>) | null>(null)
  const ready = useRef(false)
  const generation = useRef(0)
  const [readySequence, setReadySequence] = useState(0)
  const pendingClip = useRef(request.clip)
  const highlightScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const highlightOffset = useRef(0)
  const [renderedSide, setRenderedSide] =
    useState<Exclude<SidePanel, null>>('cameras')
  const [renderedBox, setRenderedBox] = useState<typeof state.box>('closed')
  const sideMotion = useRef(new Animated.Value(0)).current
  const boxMotion = useRef(new Animated.Value(0)).current
  useEffect(() => {
    tvControl?.enableTVMenuKey()
    return () => {
      tvControl?.disableTVMenuKey()
    }
  }, [])
  useEffect(() => {
    let active = true
    const activeGeneration = ++generation.current
    ready.current = false
    pendingRecordingEnd.current = false
    setReadySequence(0)
    clock.current = new PlaybackClock()
    setError(null)
    setAngles(null)
    setFailures([])
    recovery.current.clear()
    refreshing.current.clear()
    setStats(EMPTY_STATS)
    const load = async (): Promise<void> => {
      const game = await client.game(request.game.id)
      const videos = game.videos
        .filter(
          video =>
            video.numCameras <= 1 &&
            video.durationSec !== 0 &&
            (video.status === 'ready' || video.status === 'live')
        )
        .slice(0, 4)
      if (videos.length === 0)
        throw new Error('No camera angles are available for this game.')
      const names = new Map(
        angleLabels(game.videos).map(label => [label.id, label.name])
      )
      const results = await Promise.allSettled(
        videos.map(async video => {
          const [playback, timeline] = await Promise.all([
            client.playback(video.id),
            client
              .wallTimeline(video.id)
              .catch(() => timelineFor(video.startAt))
          ])
          if (playback.url === null)
            throw new Error(
              'This game is still preparing its video. Please try again.'
            )
          return {
            video,
            name: names.get(video.id) ?? video.title,
            uri: playback.url,
            timeline,
            revision: 0
          }
        })
      )
      const loaded = results.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      if (loaded.length === 0) {
        const failed = results.find(result => result.status === 'rejected')
        throw failed?.reason ?? new Error('No camera angles could open.')
      }
      if (!active) return
      // Mounts whose first settled seek restores them: only that seek earns
      // the opening grace. A drift correction on a mount that has played
      // earns none, or a frozen follower answering each one is never replaced.
      const restoring = new Set(loaded.map((_, index) => index))
      const seekQueue = (index: number): NativeSeekQueue =>
        new NativeSeekQueue(
          seconds => refs.current[index]?.seek(seconds, 0),
          () => {
            clock.current.settled(index)
            if (restoring.delete(index))
              recovery.current.get(index)?.opening(Date.now())
            else recovery.current.get(index)?.seeked()
            if (current.current.paused) {
              recovery.current.get(index)?.readyPaused(Date.now())
              setError(withoutRecoveryError)
            }
            setFailures(without(index))
          }
        )
      loaded.forEach((angle, index) => {
        const watch = new PlaybackRecovery(Date.now())
        watch.opening(Date.now())
        recovery.current.set(index, watch)
        seekQueues.current[index] = seekQueue(index)
        clock.current.register(index, angle.timeline, seconds => {
          seekQueues.current[index]?.request(seconds)
        })
      })
      dispatch({ type: 'reset', count: loaded.length })
      // State gets copies: `loaded` is rewritten in place by `refreshAngle`.
      setAngles([...loaded])
      refreshAngle.current = async (index, reason = 'recover') => {
        if (refreshing.current.has(index)) return
        refreshing.current.add(index)
        try {
          const previous = loaded[index]
          // As at load: a camera plays without a fresh timeline. The clock's
          // copy is the newest, which the periodic refresh keeps up to date.
          const [playback, timeline] = await Promise.all([
            client.playback(previous.video.id),
            client
              .wallTimeline(previous.video.id)
              .catch(() => clock.current.ports[index].timeline)
          ])
          if (!active || playback.url === null) return
          const updated = {
            ...previous,
            uri: playback.url,
            timeline,
            video: {
              ...previous.video,
              status: timeline.live ? ('live' as const) : ('ready' as const)
            },
            revision: previous.revision + 1
          }
          loaded[index] = updated
          // Rejects the old mount's callbacks now, not at the next render.
          const next = [...loaded]
          anglesRef.current = next
          clock.current.ports[index].timeline = timeline
          // Remounting abandons the old native seek, including its completion.
          seekQueues.current[index] = seekQueue(index)
          setBuffering(previous => previous.filter(i => i !== index))
          // A finished live camera is not unavailable: it is loading its recording.
          if (reason === 'recover')
            setFailures(previous => [...new Set([...previous, index])])
          restoring.add(index)
          recovery.current.get(index)?.opening(Date.now())
          setAngles(next)
        } finally {
          if (active) refreshing.current.delete(index)
        }
      }
      let refreshSequence = 0
      let appliedStatisticsSequence = 0
      let appliedTimelineSequence = 0
      const refresh = async (): Promise<void> => {
        const sequence = ++refreshSequence
        const [replay, highlights] = await Promise.all([
          readTvStatistics(client, request.game.id),
          client.tvHighlights(loaded[0].video.id).catch(() => null)
        ])
        if (!active) return
        if (sequence > appliedStatisticsSequence) {
          appliedStatisticsSequence = sequence
          setStats({
            ...replay,
            board: replay.board ?? null
          })
          setClipError(highlights === null)
          if (highlights !== null) setClips(highlights)
        }
        if (loaded.some(a => a.video.status === 'live')) {
          // A camera refreshed meanwhile already holds a newer timeline.
          const revisions = loaded.map(a => a.revision)
          const updates = await Promise.all(
            loaded.map(
              async a => await client.wallTimeline(a.video.id).catch(() => null)
            )
          )
          if (active && sequence > appliedTimelineSequence) {
            appliedTimelineSequence = sequence
            updates.forEach((timeline, i) => {
              if (timeline === null || loaded[i].revision !== revisions[i])
                return
              clock.current.ports[i].timeline = timeline
              if (!timeline.live && loaded[i].video.status === 'live')
                refreshAngle.current?.(i, 'finished').catch(() => undefined)
            })
          }
        }
      }
      statisticsRefresh.current = refresh
      await refresh()
      if (
        active &&
        (game.status === 'inProgress' ||
          loaded.some(a => a.video.status === 'live'))
      )
        timer = setInterval(() => {
          refresh().catch(() => undefined)
        }, 10000)
    }
    let timer: ReturnType<typeof setInterval> | undefined
    load().catch((reason: unknown) => {
      if (active)
        setError(
          reason instanceof Error ? reason.message : 'This game could not open.'
        )
    })
    return () => {
      active = false
      statisticsRefresh.current = null
      refreshAngle.current = null
      generation.current = activeGeneration + 1
      clearInterval(timer)
    }
  }, [client, request, retry])
  useEffect(() => {
    const timer = setInterval(() => {
      for (const [index, watch] of recovery.current) {
        const port = clock.current.ports[index]
        if (port == null) continue
        if (seekQueues.current[index]?.timedOut()) {
          clock.current.fail(index)
          watch.error(Date.now())
          setFailures(previous => [...new Set([...previous, index])])
        }
        const live = anglesRef.current?.[index].video.status === 'live'
        const heldForMaster =
          bufferingRef.current.includes(clock.current.master) &&
          index !== clock.current.master
        if (
          !seekQueues.current[index]?.pending &&
          watch.retry(
            Date.now(),
            !current.current.paused &&
              !heldForMaster &&
              clock.current.available(index),
            !live && port.ended
          )
        ) {
          clock.current.fail(index)
          setFailures(previous => [...new Set([...previous, index])])
          refreshAngle.current?.(index).catch(() => undefined)
        }
        if (watch.exhausted && clock.current.ports.every(p => p.failed))
          setError(CAMERAS_FAILED)
      }
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const previousOverlay = useRef(false)
  const previousFull = useRef<number | null>(null)
  useEffect(() => {
    const overlay =
      state.side !== null || state.box !== 'closed' || error !== null
    const restore =
      !overlay &&
      (previousOverlay.current || previousFull.current !== state.full)
    previousFull.current = state.full
    previousOverlay.current = overlay
    if (!restore) return
    const timer = setTimeout(() => {
      const node =
        angleNodes.current[
          current.current.full ??
            (current.current.visible.includes(lastAngle.current)
              ? lastAngle.current
              : current.current.visible[0])
        ]
      if (
        node != null &&
        'requestTVFocus' in node &&
        typeof node.requestTVFocus === 'function'
      )
        node.requestTVFocus()
    }, 250)
    return () => {
      clearTimeout(timer)
    }
  }, [state.side, state.box, state.full, error])
  const sources = useMemo(
    () => angles?.map(angle => ({ uri: angle.uri })) ?? [],
    [angles]
  )
  const open = useCallback(
    (panel: Exclude<SidePanel, null>): void => {
      if (panel === 'cameras' && (angles?.length ?? 0) < 2) return
      dispatch({ type: 'open', panel })
    },
    [angles]
  )
  const changeLayout = useCallback(
    (
      action: Extract<
        PlaybackAction,
        { type: 'toggle' | 'enlarge' | 'collapse' }
      >
    ): void => {
      if (Platform.isTV && !reducedMotion) {
        LayoutAnimation.configureNext(
          LayoutAnimation.create(LAYOUT_DURATION, 'easeInEaseOut', 'scaleXY')
        )
      }
      if (action.type === 'enlarge') lastExpanded.current = action.index
      dispatch(action)
    },
    [reducedMotion]
  )
  const back = useCallback((): void => {
    transport.current?.cancel()
    const held = current.current
    if (held.side !== null || held.box !== 'closed')
      dispatch({ type: 'dismiss' })
    else if (held.full !== null) changeLayout({ type: 'collapse' })
    else onClose()
  }, [onClose, changeLayout])
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        back()
        return true
      }
    )
    return () => {
      subscription.remove()
    }
  }, [back])
  useEffect(() => {
    if (readySequence === 0) return
    const timer = setTimeout(() => {
      dispatch({ type: 'previewTimeout' })
    }, 2000)
    return () => {
      clearTimeout(timer)
    }
  }, [readySequence])
  useEffect(() => {
    if (state.side !== 'cameras' || state.preview) return
    const timer = setTimeout(() => {
      dispatch({ type: 'cameraTimeout' })
    }, 3000)
    return () => {
      clearTimeout(timer)
    }
  }, [state.side, state.preview, state.activity])
  useEffect(() => {
    if (state.side !== null) {
      setRenderedSide(state.side)
      sideMotion.setValue(0)
    }
    const animation = Animated.timing(sideMotion, {
      toValue: state.side === null ? 0 : 1,
      duration: 220,
      useNativeDriver: true
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [state.side, sideMotion])
  useEffect(() => {
    if (renderedSide === 'highlights')
      highlightScroll.current?.scrollTo({
        y: highlightOffset.current,
        animated: false
      })
  }, [renderedSide])
  useEffect(() => {
    if (state.box !== 'closed') setRenderedBox(state.box)
    if (state.box === 'compact') {
      statsOffset.current = 0
      statsScroll.current?.scrollTo({ y: 0, animated: false })
    }
    const animation = Animated.timing(boxMotion, {
      toValue: state.box === 'closed' ? 0 : 1,
      duration: 220,
      useNativeDriver: false
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [state.box, boxMotion])
  const stopStatsMomentum = useCallback(() => {
    if (statsMomentum.current !== null)
      cancelAnimationFrame(statsMomentum.current)
    statsMomentum.current = null
  }, [])
  const glideStats = useCallback(
    (initialVelocity: number) => {
      stopStatsMomentum()
      let velocity =
        Math.max(-2400, Math.min(2400, initialVelocity)) *
        STATS_SCROLL_SENSITIVITY
      let last = Date.now()
      const tick = (): void => {
        if (current.current.box === 'closed') return
        const now = Date.now()
        const dt = Math.min(32, Math.max(1, now - last))
        last = now
        const next = Math.max(
          0,
          Math.min(
            Math.max(
              0,
              statsExtent.current.content - statsExtent.current.viewport
            ),
            statsOffset.current + (velocity * dt) / 1000
          )
        )
        if (Math.abs(next - statsOffset.current) < 0.01) return
        statsOffset.current = next
        statsScroll.current?.scrollTo({ y: next, animated: false })
        velocity *= Math.exp(-dt / 260)
        if (Math.abs(velocity) > 12 * STATS_SCROLL_SENSITIVITY)
          statsMomentum.current = requestAnimationFrame(tick)
      }
      statsMomentum.current = requestAnimationFrame(tick)
    },
    [stopStatsMomentum]
  )
  const statsOpen = state.box !== 'closed'
  useEffect(() => {
    if (!statsOpen) return
    tvControl?.enableTVPanGesture()
    return () => {
      statsPan.current = null
      stopStatsMomentum()
      tvControl?.disableTVPanGesture()
    }
  }, [statsOpen, stopStatsMomentum])
  const handleStatsPan = useCallback(
    (body: { state: string; y?: number; velocityY?: number }) => {
      if (current.current.box === 'closed') return
      if (body?.state === 'Ended' || body?.state === 'Cancelled') {
        if (statsPan.current?.moved === true) statsPanEnded.current = Date.now()
        if (body?.state === 'Ended' && Number.isFinite(body.velocityY))
          glideStats(body.velocityY!)
        else stopStatsMomentum()
        statsPan.current = null
        return
      }
      if (!Number.isFinite(body?.y)) return
      const y = body.y!
      if (body?.state === 'Began' || statsPan.current === null) {
        stopStatsMomentum()
        statsPan.current = {
          y,
          startY: y,
          moved: false,
          startedAtTop: statsOffset.current <= 1
        }
        return
      }
      const delta = y - statsPan.current.y
      statsPan.current.y = y
      if (Math.abs(delta) < 0.1) return
      statsPan.current.moved = true
      if (
        y - statsPan.current.startY < -8 &&
        statsPan.current.startedAtTop &&
        statsOffset.current <= 1
      ) {
        statsPanEnded.current = Date.now()
        dispatch({ type: 'dismiss' })
        return
      }
      if (delta > 0 && current.current.box !== 'expanded') {
        dispatch({ type: 'box' })
        return
      }
      statsOffset.current = Math.max(
        0,
        Math.min(
          Math.max(
            0,
            statsExtent.current.content - statsExtent.current.viewport
          ),
          statsOffset.current + delta * STATS_SCROLL_SENSITIVITY
        )
      )
      statsScroll.current?.scrollTo({
        y: statsOffset.current,
        animated: false
      })
    },
    [glideStats, stopStatsMomentum]
  )
  useEffect(() => {
    const subscription = tvEvents?.addListener(event => {
      if (current.current.box !== 'closed' && event.eventType === 'pan') {
        // Physical tvOS receives a dedicated native pan stream below.
        if (Platform.OS !== 'ios' && event.body !== undefined)
          handleStatsPan(event.body)
        return
      }
      const input = normalizeRemote(event, Platform.OS === 'ios')
      if (input === null) return
      if (input.kind === 'cancel') {
        transport.current?.cancel()
        return
      }
      if (input.kind === 'playPause') {
        togglePlayback()
        return
      }
      const held = current.current
      if (error !== null) return
      if (
        held.side === null &&
        held.box === 'closed' &&
        focusedAngle.current !== null &&
        transport.current?.handle(input) === true
      )
        return
      if (input.kind !== 'click' && input.kind !== 'swipe') return
      const direction = input.direction
      if (held.side !== null) {
        if (held.side === 'cameras') dispatch({ type: 'activity' })
        if (
          input.kind === 'swipe' &&
          ((held.side === 'cameras' && direction === 'right') ||
            (held.side === 'highlights' && direction === 'left'))
        )
          dispatch({ type: 'dismiss' })
        return
      }
      if (held.box !== 'closed') {
        // The same touch also emits a discrete swipe; do not scroll twice.
        if (
          input.kind === 'swipe' &&
          (statsPan.current?.moved === true ||
            Date.now() - statsPanEnded.current < 250)
        )
          return
        if (direction === 'up' && statsOffset.current <= 1) {
          dispatch({ type: 'dismiss' })
          return
        }
        if (direction === 'left' || direction === 'right') {
          scoreOffset.current = Math.max(
            0,
            Math.min(
              scoreExtent.current.content - scoreExtent.current.viewport,
              scoreOffset.current +
                ((direction === 'right' ? 1 : -1) *
                  scoreExtent.current.viewport) /
                  2
            )
          )
          scoreScroll.current?.scrollTo({
            x: scoreOffset.current,
            animated: true
          })
        }
        if (direction === 'down' && held.box !== 'expanded')
          dispatch({ type: 'box' })
        else if (
          (direction === 'down' || direction === 'up') &&
          input.kind === 'click'
        ) {
          statsOffset.current = Math.max(
            0,
            Math.min(
              statsExtent.current.content - statsExtent.current.viewport,
              statsOffset.current +
                (direction === 'down' ? 100 : -100) * STATS_SCROLL_SENSITIVITY
            )
          )
          statsScroll.current?.scrollTo({
            y: statsOffset.current,
            animated: true
          })
        }
        return
      }
      const index = focusedAngle.current
      if (index === null) return
      if (input.kind !== 'swipe') return
      // Ignore only the event that just moved UIKit focus, not the next gesture.
      if (Date.now() - focusChangedAt.current < 100) return
      const neighbor = angleNeighbor(held, index, direction)
      if (neighbor !== null) return
      if (direction === 'left') open('cameras')
      else if (direction === 'right') open('highlights')
      else if (direction === 'down') {
        statsOffset.current = 0
        dispatch({ type: 'box' })
      }
    })
    return () => {
      subscription?.remove()
    }
  }, [open, error, handleStatsPan])
  const chooseClip = (clip: TvHighlight, sourceIndex = 0): void => {
    const timeline = clock.current.ports[sourceIndex]?.timeline
    if (timeline === undefined) return
    const start = wallAt(timeline.anchors, clip.startOffsetSec * 1000)
    const end =
      clip.endOffsetSec === undefined
        ? null
        : wallAt(timeline.anchors, clip.endOffsetSec * 1000)
    if (start === null) {
      setError('This highlight has no video timeline.')
      return
    }
    clock.current.seek(start)
    setWall(start)
    dispatch({ type: 'clip', id: clip.eventId, end })
  }
  function togglePlayback(): void {
    const held = clock.current
    const port = held.ports[held.master]
    if (
      current.current.paused &&
      port !== undefined &&
      Number.isFinite(port.duration) &&
      port.position >= port.duration - 0.5
    ) {
      const start = wallAt(port.timeline.anchors, 0)
      if (start !== null) {
        held.seek(start)
        setWall(start)
      }
    }
    dispatch({ type: 'pause' })
  }
  const loaded = (index: number, duration: number): void => {
    clock.current.load(
      index,
      angles?.[index].video.status === 'live' ? Infinity : duration
    )
    // A paused live remount waits for seekable bounds that only playback
    // reports. It has opened; the selected moment is restored on play.
    if (
      current.current.paused &&
      clock.current.ports[index].pendingWall !== null
    )
      recovery.current.get(index)?.readyPaused(Date.now())
    markReady()
  }
  const markReady = (): void => {
    if (ready.current || !clock.current.ports.every(p => p.loaded || p.failed))
      return
    ready.current = true
    setReadySequence(n => n + 1)
    if (angles?.some(a => a.video.status === 'live') !== true)
      clock.current.start()
    dispatch({ type: 'ready', count: angles?.length ?? 0 })
    if (pendingClip.current !== undefined) {
      const capturedGeneration = generation.current
      const clip = pendingClip.current
      const source = angles?.findIndex(a => a.video.id === clip.videoId) ?? -1
      if (source >= 0) chooseClip(clip, source)
      else
        client
          .wallTimeline(clip.videoId)
          .then(timeline => {
            if (capturedGeneration !== generation.current) return
            const start = wallAt(timeline.anchors, clip.startOffsetSec * 1000)
            const end =
              clip.endOffsetSec === undefined
                ? null
                : wallAt(timeline.anchors, clip.endOffsetSec * 1000)
            if (start !== null) {
              clock.current.seek(start)
              dispatch({ type: 'clip', id: clip.eventId, end })
            }
          })
          .catch(() => {
            if (capturedGeneration !== generation.current) return
            setError('This highlight is unavailable.')
          })
      pendingClip.current = undefined
    }
  }
  const progress = (
    index: number,
    seconds: number,
    seekableEnd?: number,
    seekableStart?: number
  ): void => {
    const port = clock.current.ports[index]
    if (
      port != null &&
      !port.failed &&
      !port.settling &&
      port.target == null &&
      port.pendingWall === null &&
      recovery.current.get(index)?.progress(seconds, Date.now()) === true
    ) {
      setError(withoutRecoveryError)
      setFailures(without(index))
    }
    const next = clock.current.progress(
      index,
      seconds,
      seekableEnd,
      seekableStart,
      !(current.current.paused && transportState.rate === 1) &&
        transport.current?.scrubbing !== true
    )
    if (index !== clock.current.master || next === null) return
    setWall(previous =>
      previous !== null &&
      Math.floor(previous / 1000) === Math.floor(next / 1000)
        ? previous
        : next
    )
    if (
      transport.current?.scrubbing !== true &&
      current.current.clipEnd !== null &&
      next >= current.current.clipEnd
    )
      dispatch({ type: 'progress', wall: next })
  }
  const board = boardAt(stats.board?.steps ?? [], wall)?.state
  const { box, message: statsMessage } = statisticsAt(stats, wall)
  const line =
    boardAt(stats.lines ?? [], wall)?.line ??
    (box === undefined ? null : lineOf(box))
  const layout = tvLayout(
    state,
    screen,
    placement,
    board != null,
    line != null,
    boardSize
  )
  const staticScore =
    state.full === null &&
    (state.visible.length === 2 || state.visible.length === 3)
  const innings = Math.max(
    6,
    line?.away.innings.length ?? 0,
    line?.home.innings.length ?? 0
  )
  const scoreWidth = Math.min(
    screen.width - 80,
    360 + (Math.min(9, innings) + 3) * 64
  )
  const boxGrowth = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const animation = Animated.timing(boxGrowth, {
      toValue: state.box === 'expanded' ? 1 : 0,
      duration: 280,
      useNativeDriver: false
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [state.box, boxGrowth])
  const audio =
    (state.full !== null && clock.current.available(state.full)
      ? state.full
      : state.visible.find(i => clock.current.available(i))) ??
    clock.current.master
  const overlay =
    state.side !== null || state.box !== 'closed' || error !== null
  const extent = clock.current.recordingExtent()
  return (
    <PlaybackBoundary
      testID="tv-player"
      style={styles.scene}
      transportEnabled={!overlay && focus !== null}
      scrubEnabled={
        state.box !== 'closed' || (!overlay && transportState.visible)
      }
      onTransportRelease={event =>
        transport.current?.handle({
          kind: 'hold',
          direction: event.nativeEvent.direction,
          phase: 'end'
        })
      }
      statsPanEnabled={statsOpen}
      onStatsPan={event => {
        handleStatsPan(event.nativeEvent)
      }}
      onCancelTransport={() => transport.current?.cancel()}
      onPanCancelled={() =>
        transport.current?.handle({ kind: 'pan', phase: 'cancel', x: 0 })
      }
    >
      <TvFocusGuide
        style={StyleSheet.absoluteFill}
        {...{
          trapFocusLeft: true,
          trapFocusRight: true,
          trapFocusDown: true,
          trapFocusUp: true
        }}
      >
        {angles?.map((angle, index) => {
          const rect = layout.tiles[state.visible.indexOf(index)]
          const available = clock.current.available(index)
          const port = clock.current.ports[index]
          // Past its recording's last frame, not missing: says so.
          const notice =
            available && !failures.includes(index)
              ? null
              : port.ended && !port.failed && !failures.includes(index)
                ? 'end of video'
                : 'video unavailable at this moment'
          return (
            <CameraFrame
              key={angle.video.id}
              rect={rect}
              reducedMotion={reducedMotion}
              zIndex={
                state.full === index
                  ? 4
                  : rect === undefined
                    ? 3
                    : lastExpanded.current === index
                      ? 2
                      : 1
              }
            >
              <Pressable
                ref={node => {
                  angleNodes.current[index] = node
                }}
                testID={`tv-angle-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Camera ${angle.name}${notice === null ? '' : `: ${notice}`}`}
                accessibilityValue={{
                  text: `${clock.current.ports[index]?.position.toFixed(1)} seconds`
                }}
                focusable={
                  !overlay &&
                  state.visible.includes(index) &&
                  (state.full === null || state.full === index)
                }
                {...{
                  hasTVPreferredFocus:
                    !overlay && (state.full ?? state.visible[0]) === index
                }}
                onFocus={() => {
                  focusChangedAt.current = Date.now()
                  lastAngle.current = index
                  focusedAngle.current = index
                  setFocus(index)
                }}
                onBlur={() => {
                  transport.current?.cancel()
                  if (focusedAngle.current === index)
                    focusedAngle.current = null
                  setFocus(null)
                }}
                onPress={() => {
                  changeLayout({ type: 'enlarge', index })
                }}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  bottom: 0,
                  borderWidth:
                    focus === index &&
                    state.full === null &&
                    state.visible.length > 1
                      ? 4
                      : 0,
                  borderColor: '#fff'
                }}
              >
                <TransportVideo
                  key={`${angle.video.id}:${angle.revision}`}
                  ref={ref => {
                    refs.current[index] = ref
                  }}
                  source={sources[index]}
                  style={StyleSheet.absoluteFill}
                  muted={index !== audio}
                  rate={transportState.rate}
                  paused={
                    readySequence === 0 ||
                    (state.paused && transportState.rate === 1) ||
                    (buffering.includes(clock.current.master) &&
                      index !== clock.current.master)
                  }
                  resizeMode="contain"
                  progressUpdateInterval={250}
                  reportBandwidth
                  onBandwidthUpdate={() => {
                    if (anglesRef.current?.[index] !== angle) return
                    seekQueues.current[index]?.transferProgress()
                    recovery.current.get(index)?.transfer(Date.now())
                  }}
                  onLoad={event => {
                    if (anglesRef.current?.[index] !== angle) return
                    loaded(index, event.duration)
                    if (clock.current.wall === null)
                      setFailures(previous => previous.filter(i => i !== index))
                  }}
                  onSeek={event => {
                    if (anglesRef.current?.[index] !== angle) return
                    seekQueues.current[index]?.complete(event.seekTime)
                  }}
                  onProgress={(event: NativeProgressData) => {
                    if (anglesRef.current?.[index] !== angle) return
                    progress(
                      index,
                      event.currentTime,
                      event.seekableEnd ?? event.seekableDuration,
                      event.seekableStart
                    )
                  }}
                  onBuffer={event => {
                    if (anglesRef.current?.[index] !== angle) return
                    seekQueues.current[index]?.buffer(event.isBuffering)
                    recovery.current
                      .get(index)
                      ?.buffer(event.isBuffering, Date.now())
                    setBuffering(previous =>
                      event.isBuffering
                        ? [...new Set([...previous, index])]
                        : previous.filter(i => i !== index)
                    )
                  }}
                  onEnd={() => {
                    if (anglesRef.current?.[index] !== angle) return
                    if (angle.video.status === 'live') {
                      seekQueues.current[index]?.fail()
                      recovery.current.get(index)?.error(Date.now())
                      return
                    }
                    const complete = clock.current.end(index)
                    setWall(clock.current.wall)
                    setReadySequence(n => n + 1)
                    if (complete) {
                      if (transport.current?.scrubbing === true) {
                        pendingRecordingEnd.current = true
                        return
                      }
                      dispatch({ type: 'ended' })
                      open('highlights')
                    }
                  }}
                  onError={() => {
                    if (anglesRef.current?.[index] !== angle) return
                    seekQueues.current[index]?.fail()
                    const unavailable = clock.current.fail(index)
                    recovery.current.get(index)?.error(Date.now())
                    markReady()
                    setFailures(previous => [...new Set([...previous, index])])
                    if (unavailable) setError(CAMERAS_FAILED)
                  }}
                />
                {notice !== null && (
                  <View style={styles.unavailable}>
                    <Text style={styles.copy}>
                      {angle.name}: {notice}
                    </Text>
                  </View>
                )}
              </Pressable>
            </CameraFrame>
          )
        })}
      </TvFocusGuide>
      {transportState.visible && !overlay && (
        <Scrubber
          ref={scrubber}
          wall={wall}
          extent={extent}
          width={scrubWidth}
        />
      )}
      {angles === null && error === null && (
        <Text style={styles.copy}>Opening game…</Text>
      )}
      {board != null && placement?.show === true && layout.board != null && (
        <View
          pointerEvents="none"
          testID="tv-scoreboard"
          collapsable={false}
          style={[styles.placedScore, frameStyle(layout.board)]}
        >
          <PlacedScoreboard
            step={boardAt(stats.board?.steps ?? [], wall) ?? null}
            onNaturalSize={measureBoard}
            place={() => ({ ...layout.board!, x: 0, y: 0 })}
          />
        </View>
      )}
      {staticScore && layout.box !== null && line != null && (
        <View
          pointerEvents="none"
          collapsable={false}
          style={[styles.placedScore, frameStyle(layout.box)]}
        >
          <LineScoreBox
            rect={{ ...layout.box, x: 0, y: 0 }}
            line={line ?? null}
            teams={
              stats.teams ?? {
                away: request.game.awayTeamName,
                home: request.game.homeTeamName
              }
            }
            at={wall}
          />
        </View>
      )}
      <Animated.View
        testID={state.side === null ? undefined : `tv-${renderedSide}-panel`}
        accessibilityElementsHidden={state.side === null}
        pointerEvents={state.side === null ? 'none' : 'auto'}
        style={[
          styles.side,
          renderedSide === 'cameras'
            ? { left: 0, paddingTop: 40, width: 356 }
            : { right: 0, width: HIGHLIGHTS_PANEL_WIDTH },
          {
            opacity: sideMotion,
            transform: [
              {
                translateX: sideMotion.interpolate({
                  inputRange: [0, 1],
                  outputRange: [renderedSide === 'cameras' ? -550 : 550, 0]
                })
              }
            ]
          }
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.sideGradient,
            { width: HIGHLIGHTS_PANEL_WIDTH + screen.width * 0.25 },
            renderedSide === 'cameras' ? { left: 0 } : { right: 0 }
          ]}
        >
          <PanelGradient
            direction={renderedSide === 'cameras' ? 'left' : 'right'}
          />
        </View>
        <TvFocusGuide
          autoFocus
          focusable={state.side !== null}
          style={{ flex: 1, display: state.side === null ? 'none' : 'flex' }}
        >
          {renderedSide === 'highlights' && (
            <Text style={styles.heading}>Highlights</Text>
          )}
          {renderedSide === 'cameras' ? (
            angles?.map((angle, index) => (
              <Pressable
                key={angle.video.id}
                testID={`tv-toggle-${index}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: state.visible.includes(index) }}
                accessibilityLabel={`Toggle ${angle.name}`}
                {...{
                  hasTVPreferredFocus:
                    state.side === 'cameras' &&
                    !state.preview &&
                    index === (focus ?? state.visible[0]),
                  tvParallaxProperties: {
                    enabled: true,
                    magnification: focusMagnification,
                    shiftDistanceX: 10,
                    shiftDistanceY: 10,
                    tiltAngle: 0.08,
                    pressMagnification: 1.08
                  }
                }}
                onFocus={() => {
                  setCameraFocus(index)
                  dispatch({ type: 'activity' })
                }}
                onBlur={() => {
                  setCameraFocus(null)
                }}
                onPress={() => {
                  changeLayout({ type: 'toggle', index })
                }}
                style={[
                  styles.angleOption,
                  {
                    shadowOpacity: cameraFocus === index ? 0.5 : 0,
                    shadowRadius: 12,
                    shadowColor: '#fff',
                    shadowOffset: { width: 0, height: 0 }
                  }
                ]}
              >
                <View style={styles.cameraThumbnail}>
                  {angle.video.posterUrl !== null && (
                    <TvPoster uri={angle.video.posterUrl} focused={false} />
                  )}
                  {!state.visible.includes(index) && (
                    <View
                      testID={`tv-camera-dim-${index}`}
                      pointerEvents="none"
                      style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: 'rgba(0,0,0,0.6)' }
                      ]}
                    />
                  )}
                  <View pointerEvents="none" style={styles.cameraCaption}>
                    <Svg
                      style={StyleSheet.absoluteFill}
                      width="100%"
                      height="100%"
                    >
                      <Defs>
                        <LinearGradient
                          id={`camera-${index}`}
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <Stop offset="0" stopColor="#000" stopOpacity={0} />
                          <Stop
                            offset="1"
                            stopColor="#000"
                            stopOpacity={0.75}
                          />
                        </LinearGradient>
                      </Defs>
                      <Rect
                        width="100%"
                        height="100%"
                        fill={`url(#camera-${index})`}
                      />
                    </Svg>
                    <Text numberOfLines={1} style={styles.cameraName}>
                      {angle.name}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))
          ) : (
            <ScrollView
              ref={highlightScroll}
              style={{ marginLeft: -16 }}
              contentContainerStyle={{ padding: 8, paddingLeft: 24 }}
              onScroll={event => {
                highlightOffset.current = event.nativeEvent.contentOffset.y
              }}
              scrollEventThrottle={100}
            >
              {clipError && (
                <Text style={styles.copy}>
                  Highlights are unavailable. Reopen this game to retry.
                </Text>
              )}
              {!clipError && clips.length === 0 && (
                <Text style={styles.copy}>
                  No highlights for this game yet.
                </Text>
              )}
              {clips.map((clip, index) => (
                <Pressable
                  key={clip.eventId}
                  testID={`tv-highlight-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={clip.title}
                  {...{
                    hasTVPreferredFocus:
                      state.side === 'highlights' &&
                      (state.selectedClip === clip.eventId ||
                        (state.selectedClip === null && index === 0))
                  }}
                  onPress={() => {
                    chooseClip(clip)
                  }}
                  onFocus={() => {
                    setHighlightFocus(clip.eventId)
                  }}
                  onBlur={() => {
                    setHighlightFocus(null)
                  }}
                  style={styles.clip}
                >
                  <View
                    testID={`tv-highlight-thumbnail-${index}`}
                    style={[
                      styles.preview,
                      reducedMotion && reducedMotionThumbnail,
                      reducedMotion &&
                        highlightFocus === clip.eventId &&
                        staticTileFocus
                    ]}
                  >
                    <TvPoster
                      uri={clip.stillUrl}
                      focused={highlightFocus === clip.eventId}
                    />
                  </View>
                  <Text style={[styles.copy, styles.clipText]}>
                    {clip.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </TvFocusGuide>
      </Animated.View>
      <Animated.View
        testID={state.box === 'closed' ? undefined : 'tv-box-panel'}
        accessibilityElementsHidden={state.box === 'closed'}
        pointerEvents={state.box === 'closed' ? 'none' : 'auto'}
        style={[
          styles.box,
          {
            height: boxGrowth.interpolate({
              inputRange: [0, 1],
              outputRange: ['20%', '25%']
            }),
            opacity: boxMotion,
            transform: [
              {
                translateY: boxMotion.interpolate({
                  inputRange: [0, 1],
                  outputRange: [400, 0]
                })
              }
            ]
          }
        ]}
      >
        <View
          collapsable={false}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { top: -screen.height * 0.1, bottom: -screen.height * 0.15 }
          ]}
        >
          <PanelGradient direction="bottom" maxOpacity={0.75} />
        </View>
        <TvFocusGuide
          autoFocus
          focusable={state.box !== 'closed'}
          style={{ flex: 1, display: state.box === 'closed' ? 'none' : 'flex' }}
        >
          <ScrollView
            testID="tv-stats-scroll"
            ref={statsScroll}
            scrollEnabled={false}
            onContentSizeChange={(_width, height) => {
              statsExtent.current.content = height
            }}
            onLayout={event => {
              statsExtent.current.viewport = event.nativeEvent.layout.height
            }}
            onScroll={event => {
              statsOffset.current = event.nativeEvent.contentOffset.y
            }}
            scrollEventThrottle={16}
          >
            {stats.message !== null &&
              stats.message !== 'Loading statistics…' && (
                <View style={{ alignSelf: 'flex-start' }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry statistics"
                    onPress={() => {
                      statisticsRefresh.current?.().catch(() => undefined)
                    }}
                    style={{ paddingVertical: 6 }}
                  >
                    <Text style={styles.statsNote}>Retry statistics</Text>
                  </Pressable>
                </View>
              )}
            {!staticScore && (
              <>
                {line === undefined || line === null ? (
                  <Text style={styles.statsNote}>{statsMessage}</Text>
                ) : (
                  <>
                    <ScrollView
                      ref={scoreScroll}
                      onContentSizeChange={width => {
                        scoreExtent.current.content = width
                      }}
                      onLayout={event => {
                        scoreExtent.current.viewport =
                          event.nativeEvent.layout.width
                      }}
                      onScroll={event => {
                        scoreOffset.current = event.nativeEvent.contentOffset.x
                      }}
                      scrollEventThrottle={16}
                      testID="tv-line-score"
                      horizontal
                      style={{ width: scoreWidth, alignSelf: 'center' }}
                      contentContainerStyle={{
                        width: 360 + (innings + 3) * 64
                      }}
                    >
                      <View
                        style={{
                          flex: 1,
                          minWidth: 360 + (innings + 3) * 64
                        }}
                      >
                        <StatRow
                          name="Team"
                          onPress={() => {
                            dispatch({ type: 'box' })
                          }}
                          values={[
                            ...Array.from(
                              {
                                length: innings
                              },
                              (_, i) => i + 1
                            ),
                            'R',
                            'H',
                            'E'
                          ]}
                          heading
                        />
                        {(['away', 'home'] as const).map(side => (
                          <StatRow
                            key={side}
                            singleLine
                            name={
                              stats.teams?.[side] ??
                              (side === 'away'
                                ? request.game.awayTeamName
                                : request.game.homeTeamName)
                            }
                            values={[
                              ...Array.from(
                                {
                                  length: innings
                                },
                                (_, i) => line[side].innings[i] ?? '–'
                              ),
                              line[side].r,
                              line[side].h ?? '–',
                              line[side].e ?? '–'
                            ]}
                          />
                        ))}
                      </View>
                    </ScrollView>
                  </>
                )}
              </>
            )}
            {!staticScore && renderedBox !== 'expanded' ? null : box ===
                undefined || box === null ? (
              staticScore || line != null ? (
                <Text style={styles.statsNote}>{statsMessage}</Text>
              ) : null
            ) : (
              <>
                {box.from !== null && (
                  <Text style={styles.small}>
                    Recorded statistics begin in inning {box.from.inning} (
                    {box.from.half}).
                  </Text>
                )}
                <View style={styles.statsColumns}>
                  {(['away', 'home'] as const).map(side => (
                    <View
                      key={side}
                      testID={`tv-stats-${side}`}
                      style={styles.statsTeam}
                    >
                      <Text style={styles.statsHeading}>{box[side].name}</Text>
                      <Text style={styles.statText}>
                        Runs {box[side].runs} Hits {box[side].hits ?? '—'}{' '}
                        Errors {box[side].errors ?? '—'}
                      </Text>
                      <StatRow
                        name="Batting"
                        values={['AB', 'R', 'H', 'RBI', 'BB', 'K']}
                        heading
                      />
                      {box[side].batting.map(player => (
                        <StatRow
                          key={player.id}
                          name={player.name}
                          values={[
                            player.ab,
                            player.r,
                            player.h,
                            player.rbi,
                            player.bb,
                            player.k
                          ]}
                        />
                      ))}
                      <StatRow
                        name="Pitching"
                        values={['IP', 'H', 'R', 'ER', 'BB', 'K', 'PC']}
                        heading
                      />
                      {box[side].pitching.map(player => (
                        <StatRow
                          key={player.id}
                          name={player.name}
                          values={[
                            player.ip,
                            player.h,
                            player.r,
                            player.er,
                            player.bb,
                            player.k,
                            player.pc ?? '—'
                          ]}
                        />
                      ))}
                    </View>
                  ))}
                </View>
              </>
            )}
          </ScrollView>
        </TvFocusGuide>
      </Animated.View>
      {error !== null && (
        <View style={styles.error}>
          <Text style={styles.statsNote}>{error}</Text>
          <TvButton
            label="Retry video"
            preferred
            onPress={() => {
              setRetry(n => n + 1)
            }}
          />
        </View>
      )}
    </PlaybackBoundary>
  )
}

function StatRow({
  name,
  values,
  heading = false,
  singleLine = false,
  onPress
}: {
  name: string
  values: Array<string | number>
  heading?: boolean
  singleLine?: boolean
  onPress?: () => void
}): React.ReactElement {
  return (
    <View style={styles.statRow}>
      {onPress === undefined ? (
        <Text
          numberOfLines={singleLine ? 1 : 2}
          style={[
            heading ? styles.statLabel : styles.statText,
            styles.statName
          ]}
        >
          {name}
        </Text>
      ) : (
        <Pressable
          testID="Team and player statistics"
          accessibilityRole="button"
          accessibilityLabel="Team and player statistics"
          onPress={onPress}
          style={styles.statName}
        >
          <Text style={styles.statLabel}>{name} ⌃</Text>
        </Pressable>
      )}
      {values.map((value, index) => (
        <Text
          key={index}
          testID={
            heading && name === 'Team' ? `tv-score-column-${value}` : undefined
          }
          style={[
            heading ? styles.statLabel : styles.statText,
            styles.statCell
          ]}
        >
          {value}
        </Text>
      ))}
    </View>
  )
}

function frameStyle(rect: TileRect): {
  left: number
  top: number
  width: number
  height: number
} {
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
}

/** Keep the decoder and focus target mounted even after their picture shrinks away. */
function CameraFrame({
  rect,
  reducedMotion,
  zIndex,
  children
}: {
  rect: TileRect | undefined
  reducedMotion: boolean
  zIndex: number
  children: React.ReactNode
}): React.ReactElement {
  const shown = rect !== undefined
  const lastRect = useRef<TileRect>({ x: 0, y: 0, w: 1, h: 1 })
  const [visibility] = useState(() => new Animated.Value(shown ? 1 : 0))
  useLayoutEffect(() => {
    if (rect !== undefined) lastRect.current = rect
  }, [rect])
  useLayoutEffect(() => {
    const toValue = shown ? 1 : 0
    if (reducedMotion) {
      visibility.setValue(toValue)
      return
    }
    const animation = Animated.timing(visibility, {
      toValue,
      duration: LAYOUT_DURATION,
      easing: Easing.inOut(value => Easing.ease(value)),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [reducedMotion, shown, visibility])
  return (
    <Animated.View
      collapsable={false}
      pointerEvents={shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!shown}
      style={[
        styles.cameraFrame,
        frameStyle(rect ?? lastRect.current),
        { zIndex, opacity: visibility, transform: [{ scale: visibility }] }
      ]}
    >
      {children}
    </Animated.View>
  )
}

function PanelGradient({
  direction,
  maxOpacity = 0.75
}: {
  maxOpacity?: number
  direction: 'left' | 'right' | 'bottom'
}): React.ReactElement {
  const id = useId().replace(/[^A-Za-z0-9]/g, '')
  const [size, setSize] = useState({ width: 0, height: 0 })
  if (NativeGradient !== null)
    return (
      <NativeGradient
        testID="tv-panel-gradient"
        collapsable={false}
        pointerEvents="none"
        gradientDirection={direction}
        maxOpacity={maxOpacity}
        style={StyleSheet.absoluteFill}
      />
    )
  return (
    <View
      testID="tv-panel-gradient"
      collapsable={false}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={({ nativeEvent: { layout } }) => {
        setSize(previous =>
          previous.width === layout.width && previous.height === layout.height
            ? previous
            : { width: layout.width, height: layout.height }
        )
      }}
    >
      <Svg
        width={size.width}
        height={size.height}
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <LinearGradient
            id={id}
            x1={direction === 'right' ? '100%' : '0%'}
            y1={direction === 'bottom' ? '100%' : '0%'}
            x2={direction === 'left' ? '100%' : '0%'}
            y2="0%"
          >
            <Stop offset="0" stopColor="#000" stopOpacity={maxOpacity} />
            <Stop offset="1" stopColor="#000" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}
interface ScrubberHandle {
  preview: (wall: number | null) => void
}

/** Touch updates stay inside this small view, away from replay and video work. */
const Scrubber = React.forwardRef<
  ScrubberHandle,
  {
    wall: number | null
    extent: { start: number; end: number } | null
    width: React.RefObject<number>
  }
>(function Scrubber({ wall, extent, width }, ref) {
  const [preview, setPreview] = useState<number | null>(null)
  React.useImperativeHandle(ref, () => ({ preview: setPreview }), [])
  const position = preview ?? wall
  const elapsed =
    extent === null || position === null
      ? 0
      : Math.max(0, (position - extent.start) / 1000)
  const duration = extent === null ? 0 : (extent.end - extent.start) / 1000
  const timeLabel = (seconds: number): string => {
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  return (
    <View testID="tv-scrubber" pointerEvents="none" style={styles.scrubber}>
      <Text testID="tv-current-time" style={styles.copy}>
        {extent === null ? 'LIVE' : timeLabel(elapsed)}
      </Text>
      <View
        testID="tv-scrub-track"
        style={styles.scrubTrack}
        onLayout={event => {
          width.current = event.nativeEvent.layout.width
        }}
      >
        <View
          testID="tv-scrub-dot"
          style={[
            styles.scrubDot,
            {
              left: `${duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0}%`
            }
          ]}
        />
      </View>
      <Text testID="tv-total-time" style={styles.copy}>
        {extent === null ? 'Seeking unavailable' : timeLabel(duration)}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', paddingVertical: 2, alignItems: 'center' },
  statName: { width: 300, paddingRight: 20 },
  statCell: { flex: 1, minWidth: 48, textAlign: 'center' },
  statText: {
    color: '#fff',
    fontSize: 33,
    textShadowColor: '#0009',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 }
  },
  statLabel: { color: '#fff', fontSize: 29.25, fontWeight: '600' },
  statsHeading: { color: '#fff', fontSize: 39, fontWeight: '700' },
  statsColumns: { flexDirection: 'row', gap: 48 },
  hidden: { display: 'none' },
  scene: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center'
  },
  copy: { color: '#fff', fontSize: 25 },
  small: { color: '#ddd', fontSize: 16.5 },
  statsNote: { color: '#fff', fontSize: 18.75 },
  heading: { color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 16 },
  error: {
    zIndex: 8,
    backgroundColor: '#252525',
    padding: 40,
    gap: 24,
    borderRadius: 24
  },
  scrubber: {
    position: 'absolute',
    left: 40,
    right: 40,
    bottom: 40,
    zIndex: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    padding: 20,
    backgroundColor: '#0006',
    borderRadius: 16
  },
  scrubTrack: { flex: 1, height: 5, backgroundColor: '#fff7' },
  scrubDot: {
    position: 'absolute',
    top: -8,
    marginLeft: -10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff'
  },
  scoreboard: {
    position: 'absolute',
    top: 24,
    left: 32,
    pointerEvents: 'none',
    zIndex: 6
  },
  side: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    paddingBottom: 32,
    width: 540,
    paddingTop: 100,
    paddingHorizontal: 40,
    zIndex: 5
  },
  box: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 6,
    paddingTop: 12,
    paddingHorizontal: 40,
    zIndex: 4
  },
  angleOption: {
    width: 207,
    borderRadius: 12,
    marginVertical: 12
  },
  cameraThumbnail: {
    width: 207,
    height: (207 * 9) / 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#252525'
  },
  cameraCaption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '33.333333%',
    justifyContent: 'center',
    paddingHorizontal: 12
  },
  cameraName: { color: '#fff', fontSize: 25, fontWeight: '600' },
  cameraFrame: { position: 'absolute', overflow: 'hidden' },
  placedScore: { position: 'absolute', zIndex: 4 },
  sideGradient: { position: 'absolute', top: 0, bottom: 0 },
  clip: {
    width: 306,
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
    gap: 16,
    paddingTop: 10,
    paddingBottom: 20
  },
  preview: { width: 300, height: 170, margin: 3, borderRadius: 6 },
  clipText: { alignSelf: 'stretch', fontSize: 31.25 },
  statsTeam: { flex: 1, gap: 8, paddingVertical: 12 },
  unavailable: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#171717',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40
  }
})
