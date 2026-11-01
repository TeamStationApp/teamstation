import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  Animated,
  AppState,
  BackHandler,
  Image,
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
  LineScoreTimeline,
  TeamStationClient,
  TvHighlight,
  VideoSummary
} from '../../common/api'
import type { ScoreboardOverlay } from '../../common/nodeSettings'
import { SCOREBOARD_BOARD_SIZE } from '../../common/scoreboard'
import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import { LineScoreBox } from '../player/scoreboardOverlay/LineScoreBox'
import { ScoreboardOverlay as PlacedScoreboard } from '../player/scoreboardOverlay/ScoreboardOverlay'
import { NativeGradient, PlaybackBoundary } from './NativePresentation'
import { NativeSeekQueue } from './nativeSeekQueue'
import { PlaybackClock } from './playbackClock'
import {
  initialPlayback,
  playbackReducer,
  type SidePanel
} from './playbackState'
import { type BoxStep, boxTimeline, timelineFor } from './playbackTimeline'
import { normalizeRemote, tvControl, tvEvents, TvFocusGuide } from './remote'
import { TvTransport } from './transportState'
import { TransportVideo } from './TransportVideo'
import type { TvPlayRequest } from './TvBrowser'
import { TvButton } from './TvButton'
import { angleNeighbor, tvLayout } from './tvLayout'

interface Angle {
  video: VideoSummary
  uri: string
  timeline: WallTimeline
}
interface Statistics {
  board: BoardTimelineWindow | null
  line: LineScoreTimeline | null
  boxes: BoxStep[]
}
const EMPTY_STATS: Statistics = { board: null, line: null, boxes: [] }

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
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const screen = useWindowDimensions()
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
  const handledFocus = useRef(0)
  const transportNode = useRef<React.ComponentRef<typeof View> | null>(null)
  const transportRef = useCallback(
    (node: React.ComponentRef<typeof View> | null): void => {
      transportNode.current = node
    },
    []
  )
  const requestFocus = (
    node: React.ComponentRef<typeof View> | null | undefined
  ): void => {
    if (
      node != null &&
      'requestTVFocus' in node &&
      typeof node.requestTVFocus === 'function'
    )
      node.requestTVFocus()
  }
  const statsScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const statsOffset = useRef(0)
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
  const [state, dispatch] = useReducer(playbackReducer, 0, initialPlayback)
  const current = useRef(state)
  current.current = state
  const refs = useRef<Array<VideoRef | null>>([])
  const seekQueues = useRef<NativeSeekQueue[]>([])
  const clock = useRef(new PlaybackClock())
  const [transportState, setTransportState] = useState({
    visible: false,
    rate: 1
  })
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
    position: () => clock.current.wall,
    extent: () => clock.current.extent(),
    width: () => scrubWidth.current,
    panEnabled: enabled =>
      enabled
        ? tvControl?.enableTVPanGesture()
        : tvControl?.disableTVPanGesture(),
    changed: setTransportState,
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
    setReadySequence(0)
    clock.current = new PlaybackClock()
    setError(null)
    setAngles(null)
    setFailures([])
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
          return { video, uri: playback.url, timeline }
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
      loaded.forEach((angle, index) => {
        const queue = new NativeSeekQueue(
          seconds => refs.current[index]?.seek(seconds, 0),
          () => {
            clock.current.settled(index)
          }
        )
        seekQueues.current[index] = queue
        clock.current.register(index, angle.timeline, seconds => {
          queue.request(seconds)
        })
      })
      dispatch({ type: 'reset', count: loaded.length })
      setAngles(loaded)
      const refresh = async (): Promise<void> => {
        const [board, line, stored, highlights] = await Promise.all([
          client.scoreboardTimeline(game.id).catch(() => null),
          client.lineScore(game.id).catch(() => null),
          client.gameEvents(game.id).catch(() => null),
          client.tvHighlights(loaded[0].video.id).catch(() => null)
        ])
        if (!active) return
        setStats({
          board,
          line,
          boxes: stored === null ? [] : boxTimeline(game, stored)
        })
        setClipError(highlights === null)
        if (highlights !== null) setClips(highlights)
        if (loaded.some(a => a.video.status === 'live')) {
          const updates = await Promise.all(
            loaded.map(
              async a =>
                await client.wallTimeline(a.video.id).catch(() => a.timeline)
            )
          )
          if (active)
            updates.forEach((timeline, i) => {
              clock.current.ports[i].timeline = timeline
            })
        }
      }
      await refresh()
      if (active && loaded.some(a => a.video.status === 'live'))
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
      generation.current = activeGeneration + 1
      clearInterval(timer)
    }
  }, [client, request, retry])
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
      handledFocus.current =
        current.current.full ??
        (current.current.visible.includes(lastAngle.current)
          ? lastAngle.current
          : current.current.visible[0])
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
  const back = useCallback((): void => {
    transport.current?.cancel()
    const held = current.current
    if (held.side !== null || held.box !== 'closed')
      dispatch({ type: 'dismiss' })
    else if (held.full !== null) dispatch({ type: 'collapse' })
    else onClose()
  }, [onClose])
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
  useEffect(() => {
    const subscription = tvEvents?.addListener(event => {
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
        transport.current?.handle(input) === true
      )
        return
      if (input.kind !== 'click' && input.kind !== 'swipe') return
      const direction = input.direction
      if (held.side !== null) {
        if (held.side === 'cameras') dispatch({ type: 'activity' })
        if (
          input.kind === 'swipe' &&
          ((held.side === 'cameras' && direction === 'left') ||
            (held.side === 'highlights' && direction === 'right'))
        )
          dispatch({ type: 'dismiss' })
        return
      }
      if (held.box !== 'closed') {
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
        else if (direction === 'down' || direction === 'up') {
          statsOffset.current = Math.max(
            0,
            Math.min(
              statsExtent.current.content - statsExtent.current.viewport,
              statsOffset.current + (direction === 'down' ? 100 : -100)
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
      if (index !== handledFocus.current) {
        handledFocus.current = index
        return
      }
      const neighbor = angleNeighbor(held, index, direction)
      if (neighbor !== null) return
      if (direction === 'left') open('cameras')
      else if (direction === 'right') open('highlights')
      else if (direction === 'down') {
        statsOffset.current = 0
        dispatch({ type: 'box' })
      } else requestFocus(transportNode.current)
    })
    return () => {
      subscription?.remove()
    }
  }, [open, error])
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
  const progress = (index: number, seconds: number): void => {
    const next = clock.current.progress(index, seconds)
    if (index !== clock.current.master || next === null) return
    setWall(previous =>
      previous !== null &&
      Math.floor(previous / 1000) === Math.floor(next / 1000)
        ? previous
        : next
    )
    if (current.current.clipEnd !== null && next >= current.current.clipEnd)
      dispatch({ type: 'progress', wall: next })
  }
  const seek = (seconds: number): void => {
    const next = clock.current.move(seconds)
    if (next !== null) {
      setWall(next)
      dispatch({ type: 'seek' })
    }
  }
  const board = boardAt(stats.board?.steps ?? [], wall)?.state
  const line = boardAt(stats.line?.steps ?? [], wall)?.line
  const box = boardAt(stats.boxes, wall)?.box
  const layout = tvLayout(
    state,
    screen,
    placement,
    board != null,
    stats.line !== null,
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
  const elapsed =
    extent === null || wall === null
      ? 0
      : Math.max(0, (wall - extent.start) / 1000)
  const duration = extent === null ? 0 : (extent.end - extent.start) / 1000
  const timeLabel = (seconds: number): string => {
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  return (
    <PlaybackBoundary
      testID="tv-player"
      style={styles.scene}
      transportEnabled={!overlay}
      scrubEnabled={!overlay && transportState.visible}
      onTransportRelease={event =>
        transport.current?.handle({
          kind: 'hold',
          direction: event.nativeEvent.direction,
          phase: 'end'
        })
      }
      onCancelTransport={() => transport.current?.cancel()}
      onPanCancelled={() =>
        transport.current?.handle({ kind: 'pan', phase: 'cancel', x: 0 })
      }
    >
      <TvFocusGuide
        style={StyleSheet.absoluteFill}
        {...{ trapFocusLeft: true, trapFocusRight: true, trapFocusDown: true }}
      >
        {angles?.map((angle, index) => {
          const rect = layout.tiles[state.visible.indexOf(index)] ?? {
            x: 0,
            y: 0,
            w: screen.width / 2,
            h: screen.height / 2
          }
          const available = clock.current.available(index)
          return (
            <View
              key={angle.video.id}
              style={{
                position: 'absolute',
                left: rect.x,
                top: rect.y,
                width: rect.w,
                height: rect.h,
                opacity: state.visible.includes(index) ? 1 : 0,
                zIndex: state.full === index ? 2 : 1
              }}
            >
              <Pressable
                ref={node => {
                  angleNodes.current[index] = node
                }}
                testID={`tv-angle-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Camera ${angle.video.title}`}
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
                  lastAngle.current = index
                  focusedAngle.current = index
                  setFocus(index)
                }}
                onBlur={() => {
                  if (focusedAngle.current === index)
                    focusedAngle.current = null
                  setFocus(null)
                }}
                onPress={() => {
                  dispatch({ type: 'enlarge', index })
                }}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  bottom: 0,
                  borderWidth: focus === index ? 4 : 0,
                  borderColor: '#fff'
                }}
              >
                <TransportVideo
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
                  onLoad={event => {
                    loaded(index, event.duration)
                  }}
                  onSeek={event => {
                    seekQueues.current[index]?.complete(
                      event.seekTime,
                      event.currentTime
                    )
                  }}
                  onProgress={event => {
                    seekQueues.current[index]?.progress(event.currentTime)
                    progress(index, event.currentTime)
                  }}
                  onBuffer={event => {
                    setBuffering(previous =>
                      event.isBuffering
                        ? [...new Set([...previous, index])]
                        : previous.filter(i => i !== index)
                    )
                  }}
                  onEnd={() => {
                    const complete = clock.current.end(index)
                    setWall(clock.current.wall)
                    setReadySequence(n => n + 1)
                    if (complete) {
                      dispatch({ type: 'ended' })
                      open('highlights')
                    }
                  }}
                  onError={() => {
                    const unavailable = clock.current.fail(index)
                    loaded(index, 0)
                    setFailures(previous => [...new Set([...previous, index])])
                    if (unavailable)
                      setError('The cameras could not play. Try again.')
                  }}
                />
                {(!available || failures.includes(index)) && (
                  <View style={styles.unavailable}>
                    <Text style={styles.copy}>
                      {angle.video.title}: video unavailable at this moment
                    </Text>
                  </View>
                )}
              </Pressable>
            </View>
          )
        })}
      </TvFocusGuide>
      {transportState.visible && !overlay && (
        <View testID="tv-scrubber" pointerEvents="none" style={styles.scrubber}>
          <Text testID="tv-current-time" style={styles.copy}>
            {extent === null ? 'LIVE' : timeLabel(elapsed)}
          </Text>
          <View
            testID="tv-scrub-track"
            style={styles.scrubTrack}
            onLayout={event => {
              scrubWidth.current = event.nativeEvent.layout.width
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
      )}
      {angles === null && error === null && (
        <Text style={styles.copy}>Opening game…</Text>
      )}
      {board != null && placement?.show === true && (
        <View
          pointerEvents="none"
          testID="tv-scoreboard"
          style={[StyleSheet.absoluteFill, { zIndex: 4 }]}
        >
          <PlacedScoreboard
            step={boardAt(stats.board?.steps ?? [], wall) ?? null}
            onNaturalSize={measureBoard}
            place={natural =>
              tvLayout(
                state,
                screen,
                placement,
                true,
                stats.line !== null,
                natural
              ).board
            }
          />
        </View>
      )}
      {staticScore && layout.box !== null && stats.line !== null && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { zIndex: 4 }]}
        >
          <LineScoreBox
            rect={layout.box}
            line={line ?? null}
            teams={stats.line.teams}
            at={wall}
          />
        </View>
      )}
      {state.box === 'closed' && (
        <TvFocusGuide
          autoFocus
          focusable={error === null}
          style={styles.controls}
        >
          <TvButton
            buttonRef={transportRef}
            label={
              state.side !== null || state.box !== 'closed'
                ? 'Close panel'
                : state.full !== null
                  ? 'Back to cameras'
                  : 'Back to games'
            }
            onPress={back}
          />
          {(angles?.length ?? 0) > 1 && (
            <TvButton
              label="Cameras"
              onPress={() => {
                open('cameras')
              }}
            />
          )}
          <TvButton
            label="Highlights"
            onPress={() => {
              open('highlights')
            }}
          />
          <TvButton
            label="Box score"
            onPress={() => {
              dispatch({ type: 'box' })
            }}
          />
          <TvButton
            label={state.paused ? 'Play' : 'Pause'}
            onPress={() => {
              togglePlayback()
            }}
          />
          <TvButton
            label="−10 seconds"
            onPress={() => {
              seek(-10)
            }}
          />
          <TvButton
            label="+10 seconds"
            onPress={() => {
              seek(10)
            }}
          />
        </TvFocusGuide>
      )}
      <Animated.View
        testID={state.side === null ? undefined : `tv-${renderedSide}-panel`}
        accessibilityElementsHidden={state.side === null}
        pointerEvents={state.side === null ? 'none' : 'auto'}
        style={[
          styles.side,
          renderedSide === 'cameras'
            ? { left: 0, paddingTop: board == null ? 100 : 320 }
            : { right: 0 },
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
        <PanelGradient
          direction={renderedSide === 'cameras' ? 'left' : 'right'}
        />
        <TvFocusGuide
          autoFocus
          focusable={state.side !== null}
          style={{ flex: 1, display: state.side === null ? 'none' : 'flex' }}
        >
          <Text style={styles.heading}>
            {renderedSide === 'cameras' ? 'Camera angles' : 'Highlights'}
          </Text>
          {renderedSide === 'cameras' ? (
            angles?.map((angle, index) => (
              <Pressable
                key={angle.video.id}
                testID={`tv-toggle-${index}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: state.visible.includes(index) }}
                accessibilityLabel={`Toggle ${angle.video.title}`}
                {...{
                  hasTVPreferredFocus:
                    state.side === 'cameras' &&
                    !state.preview &&
                    index === (focus ?? state.visible[0])
                }}
                onFocus={() => {
                  dispatch({ type: 'activity' })
                }}
                onPress={() => {
                  dispatch({ type: 'toggle', index })
                }}
                style={({
                  focused
                }: {
                  pressed: boolean
                  focused?: boolean
                }) => [
                  styles.angleOption,
                  {
                    borderColor:
                      focused === true
                        ? '#b596ff'
                        : state.visible.includes(index)
                          ? '#fff'
                          : '#777',
                    backgroundColor:
                      state.visible.length === 1 && state.visible[0] === index
                        ? '#fff'
                        : '#262626bb'
                  }
                ]}
              >
                <Text
                  style={[
                    styles.copy,
                    state.visible.length === 1 &&
                      state.visible[0] === index && { color: '#111' }
                  ]}
                >
                  {state.visible.includes(index) ? '✓ ' : ''}
                  {angle.video.title}
                </Text>
              </Pressable>
            ))
          ) : (
            <ScrollView
              ref={highlightScroll}
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
                  style={({
                    focused
                  }: {
                    pressed: boolean
                    focused?: boolean
                  }) => [styles.clip, focused === true && styles.selected]}
                >
                  <Image
                    source={{ uri: clip.stillUrl }}
                    style={styles.preview}
                  />
                  <Text
                    numberOfLines={3}
                    style={[styles.copy, styles.clipText]}
                  >
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
              outputRange: ['25%', '33%']
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
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: boxGrowth.interpolate({
                inputRange: [0, 1],
                outputRange: [2 / 3, 1]
              })
            }
          ]}
        >
          <PanelGradient direction="bottom" maxOpacity={0.15} />
        </Animated.View>
        <TvFocusGuide
          autoFocus
          focusable={state.box !== 'closed'}
          style={{ flex: 1, display: state.box === 'closed' ? 'none' : 'flex' }}
        >
          <ScrollView
            ref={statsScroll}
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
            {!staticScore && (
              <>
                {(line === undefined || line === null) &&
                  renderedBox !== 'expanded' && (
                    <TvButton
                      label="Team and player statistics"
                      onPress={() => {
                        dispatch({ type: 'box' })
                      }}
                    />
                  )}
                {line === undefined || line === null ? (
                  <Text style={styles.copy}>
                    Statistics unavailable at this point in the video.
                  </Text>
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
                            name={stats.line?.teams[side] ?? side}
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
              <Text style={styles.copy}>
                Player statistics unavailable at this point in the video.
              </Text>
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
                        Runs {box[side].runs} Hits {box[side].hits} Errors{' '}
                        {box[side].errors}
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
                            player.pc
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
          <Text style={styles.copy}>{error}</Text>
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

function PanelGradient({
  direction,
  maxOpacity = 0.1
}: {
  maxOpacity?: number
  direction: 'left' | 'right' | 'bottom'
}): React.ReactElement {
  const id = useId().replace(/[^A-Za-z0-9]/g, '')
  const [size, setSize] = useState({ width: 0, height: 0 })
  if (NativeGradient !== null)
    return (
      <NativeGradient
        direction={direction}
        maxOpacity={maxOpacity}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
    )
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        setSize({ width, height })
      }}
    >
      <Svg
        key={`${size.width}:${size.height}`}
        width={size.width}
        height={size.height}
      >
        <Defs>
          <LinearGradient
            id={id}
            x1={direction === 'right' ? '1' : '0'}
            y1={direction === 'bottom' ? '1' : '0'}
            x2={direction === 'left' ? '1' : '0'}
            y2="0"
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
const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', paddingVertical: 3, alignItems: 'center' },
  statName: { width: 300, paddingRight: 20 },
  statCell: { flex: 1, minWidth: 48, textAlign: 'center' },
  statText: {
    color: '#fff',
    fontSize: 44,
    textShadowColor: '#0009',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 }
  },
  statLabel: { color: '#fff', fontSize: 39, fontWeight: '600' },
  statsHeading: { color: '#fff', fontSize: 52, fontWeight: '700' },
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
  small: { color: '#ddd', fontSize: 22 },
  heading: { color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 16 },
  error: {
    zIndex: 8,
    backgroundColor: '#252525',
    padding: 40,
    gap: 24,
    borderRadius: 24
  },
  controls: {
    position: 'absolute',
    bottom: 20,
    left: 32,
    right: 32,
    zIndex: 7,
    flexDirection: 'row',
    gap: 12,
    flexWrap: 'wrap'
  },
  scrubber: {
    position: 'absolute',
    left: 40,
    right: 40,
    bottom: 110,
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
    paddingBottom: 110,
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
    paddingBottom: 8,
    paddingTop: 16,
    paddingHorizontal: 40,
    zIndex: 4
  },
  angleOption: {
    borderWidth: 3,
    borderRadius: 20,
    padding: 20,
    marginVertical: 8
  },
  clip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 10,
    borderWidth: 3,
    borderColor: 'transparent',
    borderRadius: 12
  },
  selected: { borderColor: '#fff', backgroundColor: '#5559' },
  preview: { width: 120, height: 68, borderRadius: 6 },
  clipText: { flex: 1 },
  statsTeam: { flex: 1, gap: 16, paddingVertical: 24 },
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
