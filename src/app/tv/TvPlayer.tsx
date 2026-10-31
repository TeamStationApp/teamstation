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
  BackHandler,
  findNodeHandle,
  Image,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg'
import Video, { type VideoRef } from 'react-native-video'

import type {
  BoardTimelineWindow,
  LineScoreTimeline,
  TeamStationClient,
  TvHighlight,
  VideoSummary
} from '../../common/api'
import { SCOREBOARD_BOARD_SIZE } from '../../common/scoreboard'
import { wallAt, type WallTimeline } from '../../common/wallTimeline'
import { boardAt } from '../player/scoreboardOverlay/boardAt'
import { ScoreboardBoard } from '../scoreboard/ScoreboardBoard'
import { NativeGradient } from './NativePresentation'
import { PlaybackClock } from './playbackClock'
import {
  angleLayout,
  edgeSwipe,
  initialPlayback,
  playbackReducer,
  type SidePanel
} from './playbackState'
import { type BoxStep, boxTimeline, timelineFor } from './playbackTimeline'
import { tvControl, tvEvents, TvFocusGuide, TvTextScrollView } from './remote'
import type { TvPlayRequest } from './TvBrowser'
import { TvButton } from './TvButton'

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
  const [downTarget, setDownTarget] = useState<number | undefined>()
  const transportNode = useRef<React.ComponentRef<typeof View> | null>(null)
  const transportRef = useCallback(
    (node: React.ComponentRef<typeof View> | null): void => {
      transportNode.current = node
      setDownTarget(
        node === null || Platform.OS === 'web'
          ? undefined
          : (findNodeHandle(node) ?? undefined)
      )
    },
    []
  )
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
  const clock = useRef(new PlaybackClock())
  const ready = useRef(false)
  const generation = useRef(0)
  const consumedPan = useRef(false)
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
    tvControl?.enableTVPanGesture()
    return () => {
      tvControl?.disableTVMenuKey()
      tvControl?.disableTVPanGesture()
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
        clock.current.register(index, angle.timeline, seconds =>
          refs.current[index]?.seek(seconds, 0)
        )
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
  useEffect(() => {
    const overlay =
      state.side !== null || state.box !== 'closed' || error !== null
    const restore = previousOverlay.current && !overlay
    previousOverlay.current = overlay
    if (!restore) return
    const timer = setTimeout(() => {
      const node = transportNode.current
      if (
        node !== null &&
        'requestTVFocus' in node &&
        typeof node.requestTVFocus === 'function'
      )
        node.requestTVFocus()
    }, 250)
    return () => {
      clearTimeout(timer)
    }
  }, [state.side, state.box, error])
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
    const animation = Animated.timing(boxMotion, {
      toValue: state.box === 'closed' ? 0 : 1,
      duration: 220,
      useNativeDriver: true
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [state.box, boxMotion])
  useEffect(() => {
    const subscription = tvEvents?.addListener(event => {
      if (event.eventKeyAction === 1) return
      if (event.eventType === 'playPause') togglePlayback()
      if (current.current.side === 'cameras') dispatch({ type: 'activity' })
      if (event.eventType === 'pan' && event.body?.state === 'Began')
        consumedPan.current = false
      if (event.eventType === 'pan' && event.body?.state === 'Ended') {
        if (consumedPan.current) {
          consumedPan.current = false
          return
        }
        if (current.current.side === 'cameras' && event.body.x < -100)
          dispatch({ type: 'dismiss' })
        if (current.current.side === 'highlights' && event.body.x > 100)
          dispatch({ type: 'dismiss' })
        if (current.current.box !== 'closed' && event.body.y < -100)
          dispatch({ type: 'box' })
      }
    })
    const adapter = NativeModules.TVRemote
    const emitter =
      adapter === undefined ? null : new NativeEventEmitter(adapter)
    const edge = emitter?.addListener('tvEdgeSwipe', raw => {
      const event = raw as {
        start: { x: number; y: number }
        end: { x: number; y: number }
      }
      const panel = edgeSwipe(event.start, event.end)
      if (panel !== null) consumedPan.current = true
      if (panel === 'box') dispatch({ type: 'box' })
      else if (panel !== null) open(panel)
    })
    return () => {
      subscription?.remove()
      edge?.remove()
    }
  }, [open])
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
  const BoxScroll = renderedBox === 'expanded' ? TvTextScrollView : ScrollView
  const wideScore =
    line != null &&
    Math.max(line.away.innings.length, line.home.innings.length) > 18
  const ScoreScroll = wideScore ? TvTextScrollView : ScrollView
  const audio =
    (state.full !== null && clock.current.available(state.full)
      ? state.full
      : state.visible.find(i => clock.current.available(i))) ??
    clock.current.master
  const overlay =
    state.side !== null || state.box !== 'closed' || error !== null
  return (
    <View testID="tv-player" style={styles.scene}>
      {angles?.map((angle, index) => {
        const layout = angleLayout(index, state)
        const available = clock.current.available(index)
        return (
          <Pressable
            key={angle.video.id}
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
              nextFocusDown:
                state.full !== null ||
                state.visible.length <= 2 ||
                state.visible.indexOf(index) >= 2
                  ? downTarget
                  : undefined,
              hasTVPreferredFocus:
                !overlay && (state.full ?? state.visible[0]) === index
            }}
            onFocus={() => {
              setFocus(index)
            }}
            onBlur={() => {
              setFocus(null)
            }}
            onPress={() => {
              dispatch({ type: 'enlarge', index })
            }}
            style={{
              position: 'absolute',
              left: `${layout.left}%`,
              top: `${layout.top}%`,
              width: `${layout.width}%`,
              height: `${layout.height}%`,
              opacity: layout.opacity,
              zIndex: layout.zIndex,
              borderWidth: focus === index ? 4 : 0,
              borderColor: '#fff'
            }}
          >
            <Video
              ref={ref => {
                refs.current[index] = ref
              }}
              source={sources[index]}
              style={StyleSheet.absoluteFill}
              muted={index !== audio}
              paused={
                readySequence === 0 ||
                state.paused ||
                (buffering.includes(clock.current.master) &&
                  index !== clock.current.master)
              }
              resizeMode="contain"
              progressUpdateInterval={250}
              onLoad={event => {
                loaded(index, event.duration)
              }}
              onSeek={() => {
                clock.current.settled(index)
              }}
              onProgress={event => {
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
        )
      })}
      {angles === null && error === null && (
        <Text style={styles.copy}>Opening game…</Text>
      )}
      {board !== undefined && board !== null && (
        <View style={styles.scoreboard} testID="tv-scoreboard">
          <ScoreboardBoard
            state={board}
            minWidth={SCOREBOARD_BOARD_SIZE.width}
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
            height: renderedBox === 'expanded' || wideScore ? '33%' : '20%',
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
        <PanelGradient direction="bottom" />
        <TvFocusGuide
          autoFocus
          focusable={state.box !== 'closed'}
          style={{ flex: 1, display: state.box === 'closed' ? 'none' : 'flex' }}
        >
          {wideScore && renderedBox !== 'expanded' && (
            <TvButton
              label="Team and player statistics"
              onPress={() => {
                dispatch({ type: 'box' })
              }}
            />
          )}
          <BoxScroll>
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
                <ScoreScroll
                  testID="tv-line-score"
                  horizontal
                  contentContainerStyle={{ flexGrow: 1 }}
                >
                  <View
                    style={{
                      flex: 1,
                      minWidth:
                        360 +
                        (Math.max(
                          line.away.innings.length,
                          line.home.innings.length
                        ) +
                          3) *
                          64
                    }}
                  >
                    <StatRow
                      name="Team"
                      onPress={
                        wideScore
                          ? undefined
                          : () => {
                              dispatch({ type: 'box' })
                            }
                      }
                      values={[
                        ...Array.from(
                          {
                            length: Math.max(
                              line.away.innings.length,
                              line.home.innings.length
                            )
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
                              length: Math.max(
                                line.away.innings.length,
                                line.home.innings.length
                              )
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
                </ScoreScroll>
              </>
            )}
            {renderedBox !== 'expanded' ? null : box === undefined ||
              box === null ? (
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
          </BoxScroll>
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
    </View>
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
  direction
}: {
  direction: 'left' | 'right' | 'bottom'
}): React.ReactElement {
  const id = useId().replace(/[^A-Za-z0-9]/g, '')
  const [size, setSize] = useState({ width: 0, height: 0 })
  if (NativeGradient !== null)
    return (
      <NativeGradient
        direction={direction}
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
            <Stop
              offset="0"
              stopColor="#101010"
              stopOpacity={direction === 'bottom' ? 0.65 : 0.98}
            />
            <Stop
              offset={direction === 'bottom' ? '0.5' : '0.8'}
              stopColor="#101010"
              stopOpacity={direction === 'bottom' ? 0.325 : 0.9}
            />
            <Stop offset="1" stopColor="#101010" stopOpacity={0} />
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
