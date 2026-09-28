import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pressable, Text, useWindowDimensions, View } from 'react-native'

import type { GameStationClient, VideoSummary } from '../../common/api'
import { webStyle } from '../components/glass'
import { VideoPoster } from '../components/VideoPoster'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import { SeekFlashView, SlowMoBadge, useFlash } from './GestureFeedback'
import {
  correctionFor,
  endFor,
  everythingEnded,
  hasStalled,
  holdExpired,
  isFinished,
  isOurSilence,
  liveTargetMs,
  masterOf,
  type Placeable,
  WATCHDOG_MS,
  worthCorrecting
} from './multiCam/align'
import { useFullScreen } from './multiCam/fullScreen'
import {
  dropTarget,
  MAX_TILES,
  type Rect,
  swap,
  tileRects
} from './multiCam/layout'
import { angleLabels, soundAngle } from './multiCam/takes'
import { barHeightRem, MultiCamBar } from './MultiCamBar'
import { SLOW_RATE } from './slowMotion'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { secondsAt, wallAt, type Window, windowOf } from './wallClock'
import { type AngleZone, angleZoneFor, HOLD_MS, STEP_SECONDS } from './zones'

export interface MultiCamViewProps {
  client: GameStationClient
  /** Every video of the game, for names and for the strips on the bar. */
  videos: VideoSummary[]
  /** The chosen angles, in quadrant order. */
  order: string[]
  /** Which tile is heard. */
  audioId: string | null
  /** Which tile fills the box, if any. */
  zoomedId: string | null
  /** Where to open, as an instant. */
  atMs?: number
  onChange: (next: {
    order?: string[]
    audioId?: string | null
    zoomedId?: string | null
  }) => void
  /** What the game is called, for the gate a phone held upright shows. */
  title?: string
  /** Where the viewer now is, so the address can say so. */
  onMoment?: (wallMs: number) => void
  onClose: () => void
}

/**
 * What one tile may run ahead, so four of them do not race for the line.
 *
 * Twenty seconds is comfortably more than any stumble this view rides out,
 * and four tiles at 12 MB ask for less between them than a single player does
 * on its own. Left to itself hls.js grows each tile's target until it holds
 * 60 MB, and four doing that at once is what turns a connection that could
 * carry this take into four streams starving each other.
 */
const TILE_BUFFER = { seconds: 20, megabytes: 12 }

/** How often a crawl backwards moves the tiles, at most. */
const BACK_STEP_MS = 80

/** How long the bar stays up after the last touch of it. */
const BAR_HIDE_MS = 3000

/**
 * How long a finger has to rest on a tile before the tile can be moved.
 *
 * The tiles are the same surface the taps land on, so a drag that started at
 * once moved a picture whenever a tap to pause or skip slipped a little.
 */
const REORDER_HOLD_MS = 1000

/**
 * How far a finger may slip, in CSS pixels, and still have made a tap.
 *
 * Every touch tap carries a pixel or two, so a press that moved less than
 * this is the ordinary tap rather than the odd one; one that moved further is
 * a drag, on a tile or on the black around them alike.
 */
const TAP_SLOP_PX = 8

/** Whether a finger has moved this far from where it came down. */
function beyondSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) >= TAP_SLOP_PX || Math.abs(dy) >= TAP_SLOP_PX
}

interface TileState {
  parked: 'beforeStart' | 'afterEnd' | null
  stalledSince: number | null
  ended: boolean
}

const freshTile = (): TileState => ({
  parked: null,
  stalledSince: null,
  ended: false
})

/** One finger on the view, followed from down to up. */
interface Press {
  pointerId: number
  /** Running while the press may still become a crawl. */
  timer: ReturnType<typeof setTimeout> | null
  /** It became one, and its lift ends the crawl. */
  held: boolean
  /** It has moved far enough to be a drag, so its lift is not a tap. */
  travelled: boolean
}

/**
 * A mouse button other than the main one.
 *
 * A right click is the browser's menu and a middle click its scroll, and
 * neither is a tap on the picture — a long right press used to start a crawl.
 */
function otherButton(event: { pointerType: string; button: number }): boolean {
  return event.pointerType === 'mouse' && event.button !== 0
}

/**
 * Four angles of one game, playing together.
 *
 * The pictures are ours to place, so the browser's own controls are off and
 * `MultiCamBar` draws the only ones there are. Everything about where a tile
 * should be is worked out in wall-clock time: `align.ts` decides what to do
 * with each follower, `wallClock.ts` converts, and this file is the part that
 * has to touch the DOM.
 *
 * It lives inside the game screen rather than on a route of its own, because
 * this app renders only the top of its navigation stack and a route would tear
 * the game screen — and its player — down on the way in. That leaves the
 * single player mounted underneath, which is why it is suspended while this is
 * up: five decoders on a phone is not four, and two capture-phase key
 * listeners would both answer an arrow.
 */
export function MultiCamView(props: MultiCamViewProps): React.ReactElement {
  const {
    client,
    videos,
    order,
    audioId,
    zoomedId,
    atMs,
    title,
    onChange,
    onMoment,
    onClose
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { height, width } = useWindowDimensions()

  const chosen = useMemo(
    () =>
      order
        .map(id => videos.find(video => video.id === id))
        .filter((video): video is VideoSummary => video != null)
        .slice(0, MAX_TILES),
    [order, videos]
  )
  const names = useMemo(() => {
    const labels = angleLabels(
      videos.map(video => ({
        id: video.id,
        title: video.title,
        status: video.status,
        numCameras: video.numCameras,
        durationSec: video.durationSec
      }))
    )
    // The same name the picker used, mosaic and all: two names for one video
    // in two places of one feature is how a viewer loses track of which
    // picture is which.
    return new Map(
      labels.map(label => [
        label.id,
        label.mosaic ? lstrings.video_multi_angle : label.name
      ])
    )
  }, [videos])

  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [tiles, setTiles] = useState<Record<string, TileState>>({})
  const [playing, setPlaying] = useState(true)
  const [atWallMs, setAtWallMs] = useState<number | null>(atMs ?? null)
  /**
   * `?debug=1`, which draws what each tile is actually doing.
   *
   * Written because the view's own account of itself — "camera catching up",
   * "waiting for the pictures" — is a conclusion, and a conclusion is no use
   * to somebody on a gigabit line who can see the same view stall. This shows
   * the numbers it reached that conclusion from.
   */
  const debug = useMemo(
    () =>
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('debug') === '1',
    []
  )
  const [readout, setReadout] = useState<string[]>([])
  const [ended, setEnded] = useState(false)
  /** Every camera that covers this moment is stuck. */
  const [waiting, setWaiting] = useState(false)

  const elements = useRef(new Map<string, HTMLVideoElement>())
  /** The take's own window, readable from the watchdog. */
  const takeRef = useRef<Window | null>(null)
  /** The tiles' state, for effects that must not re-run when it changes. */
  const tilesRef = useRef<Record<string, TileState>>({})
  /** What the view wants each tile to be doing, for `attachHls`'s recovery. */
  const intents = useRef(new Map<string, boolean>())
  /** How many pictures each tile had drawn at the last look. */
  const frames = useRef(new Map<string, number>())
  /** When this view last moved each tile, so its own silence is forgiven. */
  const seekedAt = useRef(new Map<string, number>())
  /** Tiles that have had pictures at some point, for telling a stall apart. */
  const everStarted = useRef(new Set<string>())
  /**
   * The instant the view is showing, readable from an effect that must not
   * re-run when it changes — which is every attach. Without it a tile that is
   * attached later starts at the beginning of its own file while the rest of
   * the grid is an hour into the game.
   */
  const atWallRef = useRef<number | null>(atMs ?? null)
  atWallRef.current = atWallMs
  /**
   * Tiles that have been handed a source and have not yet been put back where
   * the game is.
   *
   * A freshly attached element reads `currentTime === 0`, and the watchdog
   * takes the master's position as the truth — so a master that is still
   * loading would tell the whole grid the game is back at its first frame, and
   * the restore would then aim at that. The tick is skipped until the seek
   * that follows `loadedmetadata` has happened.
   */
  const restoring = useRef(new Set<string>())

  // Landscape only. Turned upright mid-watch the tiles are **held**, not torn
  // down — detaching four of them loses the position, the buffer and, on a
  // live stream, the whole hold-back wait on the way back — but they are
  // paused and silent behind the gate, because a phone held upright showing a
  // rotate prompt should not be playing a ball game out loud. Opened in
  // portrait, nothing attaches at all until it is turned.
  const landscape = width > height
  const everLandscape = useRef(false)
  if (landscape) everLandscape.current = true
  const attachTiles = landscape || everLandscape.current

  /**
   * The tile the sound comes out of.
   *
   * Derived here rather than handed in, because it depends on where the
   * viewer is: `soundAngle` keeps the angle chosen in the picker while it is
   * still on the grid, and otherwise takes the longest angle that has a
   * picture at this moment. A grid can span two takes, so an answer worked out
   * once when the address was written goes wrong the first time anybody
   * scrubs.
   */
  const heardId = useMemo(
    // Not the angles the game holds: the ones this grid has been told it can
    // play. A row can be `ready` with its media gone — a volume unmounted, an
    // object deleted — and `playback` answers `unavailable`. Those used to be
    // ticked, handed the sound because they are often the longest, and drawn
    // as a black square, so the game played in silence against a tile that
    // never had a source. `undefined` is "not asked yet", which is not the
    // same as "cannot play".
    () =>
      soundAngle(
        videos.filter(one => urls[one.id] !== null),
        order,
        audioId,
        atWallMs
      ),
    [atWallMs, audioId, order, urls, videos]
  )

  tilesRef.current = tiles

  /**
   * A tile whose player has stopped trying, and wants a new address.
   *
   * `attachHls` rides out five minutes of network trouble and then stops, on
   * the reasoning that the address itself is the likeliest thing left to be
   * wrong — a playback token that ran out, or one minted by a server that has
   * since restarted. The single player has always answered that by asking for
   * a new one; the grid passed nothing, so a tile that used up its patience
   * was dead for the rest of the sitting with nothing able to bring it back.
   *
   * Forgetting the address is the whole of it: the effect that fetches them
   * skips any it already has, so dropping one makes it ask again, and the new
   * address re-attaches the tile.
   */
  const askAgain = useCallback((videoId: string) => {
    setUrls(current => {
      if (current[videoId] === undefined) return current
      return Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== videoId)
      )
    })
  }, [])

  const rects = tileRects({
    width,
    height,
    count: chosen.length,
    aspect: aspectOf(chosen),
    zoomed:
      zoomedId == null ? null : chosen.findIndex(video => video.id === zoomedId)
  })

  /**
   * The moment the grid opens on.
   *
   * The take's beginning, unless a link named one. Without this every tile
   * started at its own zero and the first watchdog tick took the clock from
   * whichever of them was longest — which on a game whose longest angle
   * started *last* opened the grid three hours in, with the other cameras
   * already reading "Stopped recording".
   *
   * A live take is left alone: its beginning is hours ago and nobody opening
   * one wants the first pitch.
   */
  useEffect(() => {
    if (atWallRef.current != null) return
    const anyLive = chosen.some(video => video.status === 'live')
    if (anyLive) return
    const window = windowOf(chosen)
    if (window == null) return
    atWallRef.current = window.fromMs
    setAtWallMs(window.fromMs)
  }, [chosen])

  // Where to play each angle from. One request each, which is the same
  // membership check the single player makes, and the token it hands back
  // lasts six hours — longer than any game.
  useEffect(() => {
    let live = true
    for (const video of chosen) {
      if (urls[video.id] !== undefined) continue
      client
        .playback(video.id)
        .then(found => {
          if (live) setUrls(current => ({ ...current, [video.id]: found.url }))
        })
        .catch(() => {
          if (live) setUrls(current => ({ ...current, [video.id]: null }))
        })
    }
    return () => {
      live = false
    }
  }, [chosen, client, urls])

  const takeElement = useCallback(
    (id: string) =>
      (node: HTMLVideoElement | null): void => {
        if (node == null) elements.current.delete(id)
        else elements.current.set(id, node)
      },
    []
  )

  /**
   * A tile has been handed a source. Where should it start, and may the
   * watchdog believe it yet?
   *
   * Each tile owns its own attach, so a tile given a new address, or taken
   * off the grid, leaves the others playing instead of tearing every element
   * down and rebuilding it.
   */
  const attaching = useCallback(
    (id: string): number | null => {
      const video = chosen.find(one => one.id === id)
      const restore = atWallRef.current
      if (video == null || restore == null) return null
      const toSec = secondsAt(video, restore)
      const inRange =
        toSec != null &&
        toSec >= 0 &&
        (video.durationSec == null || toSec <= video.durationSec)
      if (!inRange || toSec == null) return null
      restoring.current.add(id)
      return toSec
    },
    [chosen]
  )

  const attached = useCallback(
    (id: string, element: HTMLVideoElement, toSec: number | null): void => {
      restoring.current.delete(id)
      const video = chosen.find(one => one.id === id)
      const instant = atWallRef.current
      const correction =
        video == null || instant == null
          ? null
          : correctionFor({
              wallMs: instant,
              follower: {
                video,
                atSec: toSec ?? element.currentTime,
                mediaSec: endOfTile(video, element)
              }
            })

      // A camera that was not recording at this moment is parked before it is
      // ever played: it used to start at whatever frame it opened on — a
      // picture from later in the game, under a label saying it had not
      // started — and to play half a second of it out loud when it held the
      // sound.
      if (correction?.kind === 'park') {
        element.currentTime =
          correction.reason === 'beforeStart'
            ? 0
            : (mediaLengthOf(element) ?? element.currentTime)
        intents.current.set(id, false)
        element.pause()
        setTiles(current => ({
          ...current,
          [id]: { ...(current[id] ?? freshTile()), parked: correction.reason }
        }))
        return
      }

      if (toSec != null) element.currentTime = toSec
      // One that arrives in the middle of a crawl joins it at once, rather
      // than running a frame or two at full speed with its sound on: forwards
      // it plays slowly, backwards it waits to be stepped.
      const crawl = crawlRate.current
      if (crawl !== 0) {
        element.playbackRate = crawl > 0 ? SLOW_RATE : 1
        element.muted = true
      }
      const run = crawl === 0 ? playing : crawl > 0
      intents.current.set(id, run)
      if (run) element.play().catch(() => undefined)
    },
    [chosen, playing]
  )

  /** Everything the alignment rules need to know about a tile right now. */
  const placeables = useCallback(
    (): Placeable[] =>
      chosen.map(video => ({
        id: video.id,
        video,
        playable:
          elements.current.get(video.id) != null && urls[video.id] != null,
        ended: tiles[video.id]?.ended
      })),
    [chosen, tiles, urls]
  )

  /** Puts every tile on one instant, and says what each of them did. */
  const alignTo = useCallback(
    (
      wallMs: number,
      toleranceSec?: number,
      /** Whether the tiles should run; the view's own play state if left out. */
      run: boolean = playing
    ): void => {
      for (const video of chosen) {
        const element = elements.current.get(video.id)
        if (element == null) continue
        const correction = correctionFor({
          wallMs,
          follower: {
            video,
            atSec: element.currentTime,
            mediaSec: endOfTile(video, element)
          },
          toleranceSec
        })
        if (correction.kind === 'park') {
          intents.current.set(video.id, false)
          element.pause()
          // Its own first or last frame, rather than whatever it happened to
          // be showing when the viewer scrubbed out of its stretch of the
          // game: a scene from an hour later under a label saying this camera
          // was not recording yet is a contradiction on the face of it.
          const edge =
            correction.reason === 'beforeStart'
              ? 0
              : (mediaLengthOf(element) ?? element.currentTime)
          if (Math.abs(element.currentTime - edge) > 0.5) {
            element.currentTime = edge
          }
          setTiles(current => ({
            ...current,
            [video.id]: {
              ...(current[video.id] ?? freshTile()),
              parked: correction.reason
            }
          }))
          continue
        }
        if (correction.kind === 'seek') {
          // Not a tile with nothing in hand: it cannot show where it is, let
          // alone where it is moved to, and every seek would be a fresh excuse
          // for the silence that follows — which is how a starved camera used
          // to drag the whole take down to a quarter speed in silence instead
          // of being dropped. It is aligned the moment it has pictures again.
          if (
            !worthCorrecting(
              element.readyState,
              correction.toSec - element.currentTime
            )
          ) {
            continue
          }
          element.currentTime = correction.toSec
          // We moved it, so it will draw nothing for a moment: that silence is
          // this view's own doing, for a second and a half and no longer.
          // The baseline stays. Deleting it made the next look read as "it
          // drew something" — because there was nothing to compare against —
          // which wiped the stall of a tile that had drawn nothing for a
          // minute and a half. `isOurSilence` is what forgives our own seek;
          // the evidence does not need destroying as well.
          seekedAt.current.set(video.id, Date.now())
        }
        setTiles(current =>
          current[video.id]?.parked == null
            ? current
            : {
                ...current,
                [video.id]: { ...current[video.id], parked: null }
              }
        )
        intents.current.set(video.id, run)
        if (run && element.paused) {
          element.play().catch(() => undefined)
        } else if (!run && !element.paused) {
          element.pause()
        }
      }
    },
    [playing, chosen]
  )

  // The watchdog. Once a second, not once a frame: four tiles through Media
  // Source were measured holding to 17 ms of each other over ten minutes, so
  // there is nothing here to chase — and hls.js ignores ManagedMediaSource's
  // `endstreaming` while an element is seeking, so a busier loop would suppress
  // WebKit's own load shedding on a phone.
  // Behind the gate everything holds where it is.
  useEffect(() => {
    if (landscape) return
    for (const video of chosen) {
      const element = elements.current.get(video.id)
      if (element == null) continue
      intents.current.set(video.id, false)
      element.pause()
    }
  }, [chosen, landscape])

  useEffect(() => {
    const timer = setInterval(() => {
      // Nothing moves while the phone is upright, and nothing is inferred
      // while slow motion is stepping the clock itself.
      if (!landscape || slowFrame.current !== 0) return
      const now = Date.now()

      // A tile that has stopped moving on its own. By the clock, never by the
      // `waiting` event, which fires on every seek this view makes on purpose
      // — and never before a tile has any pictures at all, because a tile that
      // is still opening its source has not stalled, it has not started.
      const finishedNow = new Map<string, boolean>()
      for (const video of chosen) {
        const tileElement = elements.current.get(video.id)
        if (tileElement == null) continue
        if (tileElement.readyState >= 2) everStarted.current.add(video.id)
        // What it has drawn, which is the one thing our own seeking cannot
        // fake: the alignment moves a starved tile's `currentTime` forward on
        // every tick, so a frozen picture reports a position that keeps
        // changing.
        const quality = tileElement.getVideoPlaybackQuality?.()
        const drawn = quality?.totalVideoFrames ?? tileElement.currentTime
        const lastDrawn = frames.current.get(video.id)
        const progressed = lastDrawn == null || drawn !== lastDrawn
        frames.current.set(video.id, drawn)
        // A tile that has never had a frame is opening, not stalling; one this
        // view has just moved is quiet because of us.
        const started = everStarted.current.has(video.id)
        const ours = isOurSilence(now, seekedAt.current.get(video.id))
        const stalled =
          started &&
          !ours &&
          hasStalled({
            paused: tileElement.paused,
            progressed,
            unchangedForMs: WATCHDOG_MS
          })
        // Worked out here rather than inside the state updater below, which
        // React may run later or twice: the rest of this tick reads it.
        const finished = isFinished({
          ended: tileElement.ended,
          atSec: tileElement.currentTime,
          mediaSec: video.status === 'live' ? null : mediaLengthOf(tileElement)
        })
        finishedNow.set(video.id, finished)
        setTiles(current => {
          const held = current[video.id] ?? freshTile()
          // Drawing again clears the record; stalling starts it; and a silence
          // this view caused leaves it exactly as it was. Clearing it on an
          // amnesty tick is what let a starved tile's stall be wiped over and
          // over, since a starved tile is the one that gets seeked most.
          const since = stalled
            ? (held.stalledSince ?? now)
            : progressed
              ? null
              : ours
                ? held.stalledSince
                : null
          if (held.stalledSince === since && held.ended === finished) {
            return current
          }
          return {
            ...current,
            [video.id]: { ...held, stalledSince: since, ended: finished }
          }
        })
      }

      /**
       * Who the clock is read from.
       *
       * Only a tile that is **showing this moment**: not parked, not still
       * being put back, and actually moving. A parked tile is paused wherever
       * it happened to stop, and reading the time off one of those is how the
       * view used to throw itself back to the start of the game the moment
       * somebody scrubbed past the end of the longest recording.
       */
      const instant = atWallRef.current

      /**
       * The tiles that *ought* to be showing this moment: the take covers it
       * as far as they are concerned, whatever they are actually managing.
       */
      const covering = placeables().filter(tile => {
        if (instant == null) return false
        // A tile that has finished expects nothing more of the take, whatever
        // the arithmetic makes of its declared length. Read from this tick's
        // own reckoning, not from the state written a moment ago: React has
        // not re-rendered yet, and the tick's lag was a second of `Waiting for
        // the pictures` at the end of every take.
        if (finishedNow.get(tile.id) === true || tile.ended === true) {
          return false
        }
        const element = elements.current.get(tile.id)
        const summary = chosen.find(video => video.id === tile.id)
        const correction = correctionFor({
          wallMs: instant,
          follower: {
            video: tile.video,
            atSec: element?.currentTime ?? 0,
            mediaSec: summary == null ? null : endOfTile(summary, element)
          }
        })
        return correction.kind !== 'park'
      })

      /** And of those, the ones actually putting pictures up right now. */
      const showing = covering.filter(tile => {
        if (restoring.current.has(tile.id)) return false
        const tileElement = elements.current.get(tile.id)
        if (tileElement == null || tileElement.paused) return false
        // Not stuck, either: a picture that has stopped is not a clock,
        // however healthy the connection looks.
        const stalledSince = tiles[tile.id]?.stalledSince
        if (stalledSince != null && holdExpired(now - stalledSince))
          return false
        // And showing *this* moment. A tile still sitting at its own zero —
        // freshly attached, or one the alignment has not reached yet — is not
        // the truth about where the game is; it is the thing to be corrected.
        const there = wallAt(tile.video, tileElement.currentTime)
        return (
          there != null && (instant == null || Math.abs(there - instant) < 2000)
        )
      })

      const leader = masterOf(showing, heardId)
      const leaderVideo = chosen.find(video => video.id === leader)
      const leaderElement = leader == null ? null : elements.current.get(leader)

      let wallMs: number | null = null
      if (leaderVideo != null && leaderElement != null) {
        wallMs = wallAt(leaderVideo, leaderElement.currentTime)
      } else if (playing && instant != null && covering.length === 0) {
        // Nothing covers this moment — every camera is parked, or the take has
        // run past the last of them — so the clock keeps its own time rather
        // than being dragged back to whatever a stopped picture says, and the
        // stretch between recordings can be watched through and left. It stops
        // at the end of the take: a clock that runs past the last recording is
        // counting nothing.
        //
        // Only when nothing *covers* it. A camera that should be showing this
        // moment and is stuck is a picture to wait for, not a reason to run on
        // without it: letting the clock advance there skipped two minutes of a
        // game during a two-minute stall, and made the view seek every starved
        // element once a second to keep up the fiction.
        const end = takeRef.current?.toMs
        wallMs = Math.min(instant + WATCHDOG_MS, end ?? Number.MAX_SAFE_INTEGER)
      }

      /**
       * Waiting: somebody's camera covers this moment and none of them is
       * managing to draw it.
       *
       * Said out loud, because still pictures with no explanation is the state
       * a viewer cannot diagnose. And **held**, not merely announced: the clock
       * has stopped, so a tile that is somehow still playing must stop with it
       * or it walks away from the moment the bar is showing. Without the hold a
       * mis-judged stall left a sharp picture running on half a minute past a
       * frozen clock, with no way back but another scrub.
       */
      const waitingNow = playing && covering.length > 0 && showing.length === 0
      setWaiting(waitingNow)
      if (waitingNow) {
        const backAgain = covering.every(
          tile => (elements.current.get(tile.id)?.readyState ?? 0) >= 3
        )
        if (!backAgain) {
          for (const tile of covering) {
            const held = elements.current.get(tile.id)
            if (held == null || held.paused) continue
            intents.current.set(tile.id, false)
            held.pause()
          }
          return
        }
        // The pictures are back. Put them on the moment the clock stopped at
        // and let them go, with the stall forgotten.
        setTiles(current => {
          const next: Record<string, TileState> = {}
          for (const [id, tile] of Object.entries(current)) {
            next[id] = { ...tile, stalledSince: null }
          }
          return next
        })
        frames.current.clear()
        if (instant != null) {
          alignTo(instant)
          for (const tile of covering) {
            const back = elements.current.get(tile.id)
            if (back == null) continue
            intents.current.set(tile.id, true)
            back.play().catch(() => undefined)
          }
        }
        return
      }

      if (wallMs == null) return

      // Ended is a property of the moment as well as of the tiles: at the end
      // of the take with nothing playing, the game is over whether the tiles
      // call themselves ended or merely parked.
      const end = takeRef.current?.toMs
      setEnded(
        everythingEnded(placeables()) ||
          (showing.length === 0 && end != null && wallMs >= end - 1000)
      )

      if (debug) {
        const lines = chosen.map(video => {
          const element = elements.current.get(video.id)
          const tile = tiles[video.id]
          if (element == null) return `${names.get(video.id) ?? video.id}: —`
          const stalled =
            tile?.stalledSince == null
              ? 'ok'
              : `stalled ${Math.round((now - tile.stalledSince) / 100) / 10}s`
          return (
            `${(names.get(video.id) ?? video.id).padEnd(9)} ` +
            `buf ${bufferAhead(element).toFixed(1)}s  ` +
            `ready ${element.readyState}  ` +
            `at ${element.currentTime.toFixed(1)}  ` +
            `${element.paused ? 'paused' : 'playing'}  ${stalled}`
          )
        })
        lines.push(
          `clock ${((wallMs - (takeRef.current?.fromMs ?? wallMs)) / 1000).toFixed(1)}s`
        )
        setReadout(lines)
      }

      setAtWallMs(wallMs)
      alignTo(wallMs)
    }, WATCHDOG_MS)
    return () => {
      clearInterval(timer)
    }
  }, [
    alignTo,
    debug,
    heardId,
    landscape,
    names,
    placeables,
    playing,
    chosen,
    tiles
  ])

  /**
   * The address follows the moment, every few seconds.
   *
   * On an interval rather than a timeout per change: the moment changes on
   * every watchdog tick, so a timeout that was reset each time only ever
   * elapsed once the clock had stopped — which meant a link copied while
   * watching pointed at wherever the viewer last paused.
   */
  const momentRef = useRef<number | null>(null)
  momentRef.current = atWallMs
  const onMomentRef = useRef(onMoment)
  onMomentRef.current = onMoment
  useEffect(() => {
    const timer = setInterval(() => {
      const at = momentRef.current
      if (at != null) onMomentRef.current?.(at)
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  /** A seek the viewer asked for: every tile, at once, to one instant. */
  const goTo = useCallback(
    (wallMs: number): void => {
      atWallRef.current = wallMs
      setAtWallMs(wallMs)
      alignTo(wallMs)
    },
    [alignTo]
  )

  useEffect(() => {
    if (!landscape || !playing) return
    for (const video of chosen) {
      const element = elements.current.get(video.id)
      if (element == null || tilesRef.current[video.id]?.parked != null)
        continue
      intents.current.set(video.id, true)
      element.play().catch(() => undefined)
    }
    // Only on the turn back: the watchdog owns it from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landscape])

  const toggle = useCallback((): void => {
    setPlaying(current => {
      const next = !current
      for (const video of chosen) {
        const element = elements.current.get(video.id)
        if (element == null) continue
        if (tiles[video.id]?.parked != null) continue
        intents.current.set(video.id, next)
        if (next) element.play().catch(() => undefined)
        else element.pause()
      }
      return next
    })
  }, [chosen, tiles])

  /**
   * A quarter speed, in both directions, by moving the clock — in silence.
   *
   * Forwards, every tile plays at a quarter of its rate and the take's clock
   * steps at the same pace; a tile is only moved when it drifts past the
   * usual tolerance. The first version paused the tiles and seeked all four
   * on every frame — and handed each step to an alignment that called
   * `play()` on them because the view was playing, so between seeks they ran
   * at full speed with their sound on and every seek pulled them back: the
   * picture lurched forwards and backwards and the sound stuttered.
   *
   * Backwards has no browser support anywhere, so it is still paused and
   * stepped, but a seek at most every `BACK_STEP_MS`: four decoders cannot
   * finish sixty seeks a second, and piling them up is what jitters.
   */
  const slowFrame = useRef(0)
  const [slow, setSlow] = useState(0)
  /** The crawl's rate, for callbacks that outlive the render they were made in. */
  const crawlRate = useRef(0)

  /**
   * Every tile at the given rate, and heard or not as `muted` says.
   *
   * Over the elements actually on screen rather than a list of angles, so a
   * crawl that outlives the render it began in still reaches every tile. Only
   * what differs is written: an element announces every rate it is given.
   */
  const setRateAll = useCallback(
    (rate: number, muted: (id: string) => boolean): void => {
      for (const [id, element] of elements.current) {
        if (element.playbackRate !== rate) element.playbackRate = rate
        const silent = muted(id)
        if (element.muted !== silent) element.muted = silent
      }
    },
    []
  )

  /** False when a crawl was already running, or there is no clock to move. */
  const beginSlow = useCallback(
    (direction: 'slowForward' | 'slowBack'): boolean => {
      if (slowFrame.current !== 0 || atWallRef.current == null) return false
      const forward = direction === 'slowForward'
      const rate = forward ? SLOW_RATE : -SLOW_RATE
      const elementRate = forward ? SLOW_RATE : 1
      crawlRate.current = rate
      setRateAll(elementRate, () => true)
      setSlow(rate)
      alignTo(atWallRef.current, undefined, forward)
      let last = performance.now()
      let lastSeek = 0
      const step = (now: number): void => {
        const seconds = (now - last) / 1000
        last = now
        const next = (atWallRef.current ?? 0) + seconds * rate * 1000
        atWallRef.current = next
        setAtWallMs(next)
        // Every frame, not once at the start. A tile handed a new source
        // mid-crawl loads at full speed, and one whose sound was switched on
        // by the angle it was heard from changing would play out loud: set
        // once, either lurched ahead of the others until the next seek.
        setRateAll(elementRate, () => true)
        if (forward) {
          alignTo(next, undefined, true)
        } else if (now - lastSeek >= BACK_STEP_MS) {
          lastSeek = now
          // A tenth of a second is nothing at full speed and four frames at
          // a quarter of it, so a stepped tile is held far tighter.
          alignTo(next, 0.01, false)
        }
        slowFrame.current = requestAnimationFrame(step)
      }
      slowFrame.current = requestAnimationFrame(step)
      return true
    },
    [alignTo, setRateAll]
  )

  const endSlow = useCallback((): void => {
    if (slowFrame.current === 0) return
    cancelAnimationFrame(slowFrame.current)
    slowFrame.current = 0
    crawlRate.current = 0
    setSlow(0)
    setRateAll(1, id => id !== heardId)
    if (atWallRef.current != null) alignTo(atWallRef.current)
  }, [alignTo, heardId, setRateAll])

  // A key held while the tab changes never delivers its `keyup`.
  useEffect(() => {
    return () => {
      if (slowFrame.current !== 0) cancelAnimationFrame(slowFrame.current)
    }
  }, [])

  // From the ref, not the render: a tap on a tile acts a moment after it
  // lands, by which time the render it was made in is behind the game.
  const skip = useCallback(
    (deltaSec: number): void => {
      if (atWallRef.current == null) return
      goTo(atWallRef.current + deltaSec * 1000)
    },
    [goTo]
  )

  /**
   * The bar, which gets out of the way.
   *
   * Up when the take first has a clock to show, and for three seconds after anything touches it
   * or a tap lands in the bottom third of the screen; gone otherwise, so the
   * pictures have the whole screen.
   */
  const [barShown, setBarShown] = useState(true)
  const barTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the three seconds were last started again. */
  const barShownAt = useRef(0)
  const showBar = useCallback((): void => {
    // A mouse over the bottom third or the bar lands here on every move, many
    // times a second, and a quarter of a second makes no difference to a
    // three-second timer that is already running.
    const now = Date.now()
    if (barTimer.current != null && now - barShownAt.current < 250) return
    barShownAt.current = now
    setBarShown(true)
    if (barTimer.current != null) clearTimeout(barTimer.current)
    barTimer.current = setTimeout(() => {
      barTimer.current = null
      setBarShown(false)
    }, BAR_HIDE_MS)
  }, [])
  useEffect(() => {
    return () => {
      if (barTimer.current != null) clearTimeout(barTimer.current)
    }
  }, [])

  const [flash, showFlash] = useFlash()

  // A mouse over the bottom third calls the bar up, as a tap there does. A
  // mouse only: a finger's `pointermove` is a drag, and belongs to the tiles.
  useEffect(() => {
    const hover = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return
      if (event.clientY >= (window.innerHeight * 2) / 3) showBar()
    }
    document.addEventListener('pointermove', hover)
    return () => {
      document.removeEventListener('pointermove', hover)
    }
  }, [showBar])

  /**
   * The keyboard calls the bar up too, and Tab takes the focus into it.
   *
   * A hidden bar is inert, so Tab alone cannot be trusted to reach it: the
   * focus may move before React has drawn the bar as visible, and then lands
   * on the page behind the view instead. So a Tab from outside the bar is taken over —
   * the bar is shown, and once it has been drawn the focus goes to its first
   * control, or its last for Shift-Tab. Inside the bar, Tab is left alone and
   * only keeps it up. The keys the view answers show it as well, so a seek
   * from the keyboard shows where it went.
   */
  const barRoot = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const keys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
    const down = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const bar = barRoot.current
      if (bar == null) return
      if (event.key === 'Tab') {
        showBar()
        if (bar.contains(document.activeElement)) return
        event.preventDefault()
        const backwards = event.shiftKey
        requestAnimationFrame(() => {
          const controls = barRoot.current?.querySelectorAll<HTMLElement>(
            'button, [tabindex="0"]'
          )
          if (controls == null || controls.length === 0) return
          controls[backwards ? controls.length - 1 : 0]?.focus()
        })
        return
      }
      if (keys.has(event.key) || event.key === ' ' || event.key === 'k') {
        showBar()
      }
    }
    window.addEventListener('keydown', down, true)
    return () => {
      window.removeEventListener('keydown', down, true)
    }
  }, [showBar])

  /** What a tap in one of the nine squares does. */
  const runZone = (zone: AngleZone): void => {
    if (zone === 'controls') {
      showBar()
      return
    }
    if (zone === 'seekBack' || zone === 'seekForward') {
      const back = zone === 'seekBack'
      skip(back ? -STEP_SECONDS : STEP_SECONDS)
      showFlash(back ? 'back' : 'forward')
      return
    }
    toggle()
    showFlash(playing ? 'pause' : 'play')
  }
  const runZoneRef = useRef(runZone)
  runZoneRef.current = runZone

  /**
   * One finger on the screen, from down to up.
   *
   * The squares are worked out against the whole screen — the view is fixed
   * to the window, so a pointer's client position is already in it — and not
   * against whichever tile the finger happens to be on.
   */
  const press = useRef<Press | null>(null)
  /**
   * The finger the press belongs to, for the tiles: one that has picked its
   * picture up puts it down again the moment another finger takes over.
   */
  const [pressPointer, setPressPointer] = useState<number | null>(null)

  /**
   * A finger has come down. False when it is to be ignored, because another
   * finger is holding a crawl.
   *
   * Every finger reaches this one press, so it is kept by pointer. A second
   * finger used to replace the first outright: the crawl the first was holding
   * then never saw its finger lift and ran on for good, and the second
   * finger's lift was taken for a tap. A press that is only waiting to become
   * a hold is given up to the newer finger, which is the one the viewer is
   * thinking about.
   */
  const pressStart = (pointerId: number, x: number, y: number): boolean => {
    const current = press.current
    if (current?.held === true && current.pointerId !== pointerId) return false
    if (current?.timer != null) clearTimeout(current.timer)
    const slowZone = angleZoneFor(x, y, width, height) === 'slowForward'
    const state: Press = {
      pointerId,
      timer: null,
      held: false,
      travelled: false
    }
    if (slowZone) {
      state.timer = setTimeout(() => {
        state.timer = null
        // Held only if this press started the crawl. One already running —
        // an arrow key held down — belongs to its key, and lifting this
        // finger must not end it.
        state.held = beginSlow('slowForward')
      }, HOLD_MS)
    }
    press.current = state
    setPressPointer(pointerId)
    return true
  }

  /** The press this pointer is making, if it is the one being followed. */
  const pressOf = (pointerId: number): Press | null =>
    press.current?.pointerId === pointerId ? press.current : null

  /** The finger has travelled: it is a drag, and will not become a hold. */
  const pressMoved = (pointerId: number): void => {
    const state = pressOf(pointerId)
    if (state == null) return
    state.travelled = true
    if (state.timer == null) return
    clearTimeout(state.timer)
    state.timer = null
  }

  /**
   * Whether this pointer may still pick a tile up: it is the press being
   * followed, and that press is not holding a crawl. A finger that has lost
   * the press to another is done.
   */
  const mayReorder = (pointerId: number): boolean => {
    const state = pressOf(pointerId)
    return state != null && !state.held
  }

  /**
   * The finger has come up. True when it was a hold, which the tile must not
   * then read as a drop.
   *
   * A finger that travelled on the way is not a tap, even if it came back to
   * where it started.
   */
  const pressEnd = (
    pointerId: number,
    still: boolean,
    x: number,
    y: number
  ): boolean => {
    const state = pressOf(pointerId)
    if (state == null) return false
    press.current = null
    if (state.timer != null) clearTimeout(state.timer)
    if (state.held) {
      endSlow()
      return true
    }
    if (still && !state.travelled) {
      runZoneRef.current(angleZoneFor(x, y, width, height))
    }
    return false
  }

  const pressCancel = (pointerId: number): void => {
    const state = pressOf(pointerId)
    if (state == null) return
    press.current = null
    if (state.timer != null) clearTimeout(state.timer)
    if (state.held) endSlow()
  }

  /** Where a press on the black around the tiles came down. */
  const marginFrom = useRef<{ x: number; y: number; id: number } | null>(null)

  useEffect(() => {
    return () => {
      if (press.current?.timer != null) clearTimeout(press.current.timer)
    }
  }, [])

  // The keyboard, and only here: the single player behind this stands down.
  // The same hook it uses, so the two cannot both answer one key — and the
  // arrows are taken over, because moving a take means moving four pictures
  // rather than the one this hook would otherwise seek.
  useKeyboardShortcuts({
    video: () => elements.current.get(chosen[0]?.id ?? '') ?? null,
    act: zone => {
      if (zone === 'toggle') toggle()
    },
    seek: skip,
    // Only the two zones that crawl; the hook's own type covers all five.
    beginSlow: zone => {
      if (zone === 'slowForward' || zone === 'slowBack') beginSlow(zone)
    },
    endSlow,
    // A crawl is running exactly while there is a frame scheduled for it.
    holding: () => slowFrame.current !== 0
  })

  // Black around the view as well as under it. Safari keeps the page out of
  // the notch and the home indicator when a phone is held sideways, and
  // paints those two strips in the page's own background — the app's pale
  // green-grey, which read as white bars either side of the pictures.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const theme = document.querySelector('meta[name="theme-color"]')
    const before = {
      html: html.style.backgroundColor,
      body: body.style.backgroundColor,
      theme: theme?.getAttribute('content') ?? null
    }
    html.style.backgroundColor = '#000000'
    body.style.backgroundColor = '#000000'
    theme?.setAttribute('content', '#000000')
    // A long press is a crawl or a move here, never a selection: Safari
    // answered one by selecting the whole view and offering to copy it. Set
    // on the body, where the prefixed names reach the browser as written.
    const unselectable = [
      'user-select',
      '-webkit-user-select',
      '-webkit-touch-callout'
    ]
    const selecting = unselectable.map(name =>
      body.style.getPropertyValue(name)
    )
    for (const name of unselectable) body.style.setProperty(name, 'none')
    return () => {
      unselectable.forEach((name, index) => {
        body.style.setProperty(name, selecting[index] ?? '')
      })
      html.style.backgroundColor = before.html
      body.style.backgroundColor = before.body
      if (before.theme != null) theme?.setAttribute('content', before.theme)
    }
  }, [])

  // Full screen, to the extent each browser allows; the portrait gate below
  // is what actually carries the landscape rule. On an iPhone this is a swipe
  // the viewer makes, and the layers let it through to the page while it is
  // wanted.
  const { swipeToHide } = useFullScreen(landscape, height)
  const touchAction = swipeToHide ? 'pan-y' : 'none'

  const notice = ended
    ? lstrings.angles_all_ended
    : waiting
      ? lstrings.angles_waiting
      : swipeToHide
        ? lstrings.angles_swipe_full_screen
        : null

  // A live take has no end of its own, so the furthest anybody has played to
  // stands in for one. A finished take does not: letting the clock extend the
  // window made the total in the corner of the bar grow by a second every time
  // it was watched to the end.
  const anyLive = chosen.some(video => video.status === 'live')
  const take = windowOf(
    chosen,
    anyLive
      ? (liveTargetMs(
          chosen.map(video =>
            video.status === 'live' && atWallMs != null ? atWallMs : null
          )
        ) ??
          atWallMs ??
          undefined)
      : undefined
  )
  takeRef.current = take

  // The three seconds start when there is a bar to see, not when the view
  // mounts: four sources take longer than that to open, and a bar that hid
  // before it was ever drawn left the view with no sign it had one.
  const barReady = landscape && take != null && atWallMs != null
  useEffect(() => {
    if (barReady) showBar()
  }, [barReady, showBar])

  const [drag, setDrag] = useState<{
    index: number
    x: number
    y: number
  } | null>(null)

  // Into the document's own body, not into the screen that opened it.
  //
  // Two things go wrong without this, and both are invisible until it is on a
  // real page: the app's header is a later sibling with its own stacking
  // context, so it draws *over* a picture that is supposed to be the whole
  // screen; and `position: fixed` is measured against the nearest transformed
  // ancestor rather than the window, which a scroll view up the tree supplies
  // — so the grid started below the header and ran off the bottom by the same
  // amount.
  return createPortal(
    <View style={styles.overlay}>
      {/* The black around the tiles, which takes the same squares they do. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          touchAction
        }}
        onPointerDown={event => {
          if (otherButton(event)) return
          if (!pressStart(event.pointerId, event.clientX, event.clientY)) {
            return
          }
          ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
          marginFrom.current = {
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId
          }
        }}
        // The same rule as on a tile: a finger that travels is a drag, which
        // neither becomes a crawl nor lands as a tap.
        onPointerMove={event => {
          const from = marginFrom.current
          if (from?.id !== event.pointerId) return
          if (beyondSlop(event.clientX - from.x, event.clientY - from.y)) {
            pressMoved(event.pointerId)
          }
        }}
        onPointerUp={event => {
          const from = marginFrom.current
          if (from?.id !== event.pointerId) return
          marginFrom.current = null
          const still = !beyondSlop(
            event.clientX - from.x,
            event.clientY - from.y
          )
          pressEnd(event.pointerId, still, event.clientX, event.clientY)
        }}
        onPointerCancel={event => {
          if (marginFrom.current?.id === event.pointerId) {
            marginFrom.current = null
          }
          pressCancel(event.pointerId)
        }}
        onPointerLeave={event => {
          if (marginFrom.current?.id === event.pointerId) {
            marginFrom.current = null
          }
          pressCancel(event.pointerId)
        }}
      />
      {(attachTiles ? chosen : []).map((video, index) => (
        <Tile
          key={video.id}
          videoId={video.id}
          url={urls[video.id] ?? null}
          unavailable={urls[video.id] === null}
          onGiveUp={askAgain}
          // Silent throughout a crawl, whichever angle is heard: the sound
          // follows the moment, and a crawl across two recordings would
          // otherwise switch one on at a quarter speed.
          muted={slow !== 0 || video.id !== heardId}
          onAttaching={attaching}
          onAttached={attached}
          wantsToPlay={() => intents.current.get(video.id) === true}
          rect={rects[index] ?? { x: 0, y: 0, w: 0, h: 0 }}
          dragging={drag?.index === index ? drag : null}
          name={names.get(video.id) ?? video.title}
          parked={tiles[video.id]?.parked ?? null}
          waiting={
            tiles[video.id]?.stalledSince != null &&
            holdExpired(Date.now() - (tiles[video.id]?.stalledSince ?? 0))
          }
          unplaceable={video.startAt == null}
          takeRef={takeElement(video.id)}
          touchAction={touchAction}
          heard={video.id === heardId}
          onPressStart={pressStart}
          onPressMoved={pressMoved}
          onPressEnd={pressEnd}
          onPressCancel={pressCancel}
          canReorder={mayReorder}
          pressPointer={pressPointer}
          onMove={(x, y) => {
            setDrag({ index, x, y })
          }}
          onDrop={(x, y) => {
            setDrag(null)
            // A press that went nowhere is a tap: the tile goes back where it
            // was, and nothing is reordered.
            if (!beyondSlop(x, y)) return
            const rect = rects[index]
            if (rect == null) return
            const target = dropTarget(rects, {
              x: rect.x + rect.w / 2 + x,
              y: rect.y + rect.h / 2 + y
            })
            if (target == null || target === index) return
            onChange({ order: swap(order, index, target) })
          }}
        />
      ))}

      {!landscape ? (
        <View style={styles.gate}>
          {/* The angles that are about to play, and the game they are of. The
              tiles themselves are not attached until the phone is turned, so
              this is the only picture there is to show — and a black screen
              with one sentence on it does not say what is waiting. */}
          <View style={styles.gatePosters}>
            {chosen.slice(0, MAX_TILES).map(video => (
              <View key={video.id} style={styles.gatePoster}>
                <VideoPoster uri={video.posterUrl ?? null} />
              </View>
            ))}
          </View>
          {title != null && title !== '' ? (
            <Text style={styles.gateTitle}>{title}</Text>
          ) : null}
          <Text style={styles.gateText}>{lstrings.angles_rotate}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.angles_close}
            style={styles.gateClose}
            onPress={onClose}
          >
            <Text style={styles.gateCloseText}>{lstrings.angles_close}</Text>
          </Pressable>
        </View>
      ) : null}

      <SeekFlashView flash={flash} />
      <SlowMoBadge
        rate={slow}
        bottom={
          landscape && barShown
            ? theme.rem(barHeightRem(theme) + theme.spaceSmRem)
            : undefined
        }
      />

      {/* One at a time, most specific first: they share a place on the screen
          and two of them printed over each other unreadably. The swipe for
          full screen comes last, because it is advice about the browser and
          can wait while the pictures themselves have something to say. */}
      {notice != null ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {debug && readout.length > 0 ? (
        <View style={styles.readout} pointerEvents="none">
          {readout.map(line => (
            <Text key={line} style={styles.readoutText}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {landscape && take != null && atWallMs != null ? (
        <MultiCamBar
          window={take}
          atMs={atWallMs}
          playing={playing}
          angles={chosen.map(video => ({
            id: video.id,
            name: names.get(video.id) ?? video.title,
            fromMs: startOf(video, take.fromMs),
            toMs:
              startOf(video, take.fromMs) +
              (video.durationSec ?? (take.toMs - take.fromMs) / 1000) * 1000
          }))}
          onTogglePlay={toggle}
          onSkip={skip}
          onScrub={goTo}
          onClose={onClose}
          onInteract={showBar}
          visible={barShown}
          rootRef={barRoot}
        />
      ) : null}
    </View>,
    document.body
  )
}

/**
 * The end to judge one tile by: what its element holds, less the slack, and
 * nothing at all for a live recording — whose seekable range ends at the live
 * edge, which is not an end but the present moment.
 */
function endOfTile(
  video: { status: string },
  element: HTMLVideoElement | null | undefined
): number | null {
  if (element == null || video.status === 'live') return null
  return endFor(mediaLengthOf(element))
}

/**
 * How much media an element actually holds, when it knows.
 *
 * `duration` once the metadata is in, and the end of the seekable range where
 * that is shorter — which is what a recording whose row overstates its length
 * looks like from here.
 */
function mediaLengthOf(element: HTMLVideoElement): number | null {
  const declared = Number.isFinite(element.duration) ? element.duration : null
  const ranges = element.seekable
  const seekable =
    ranges != null && ranges.length > 0 ? ranges.end(ranges.length - 1) : null
  if (declared == null) return seekable
  if (seekable == null) return declared
  return Math.min(declared, seekable)
}

/**
 * Seconds of stream ahead of where a tile is playing.
 *
 * The range it is *in*, not the furthest one buffered: a tile that has been
 * seeked holds a stretch it is nowhere near, and counting that as its lead is
 * how a starving tile looks comfortable.
 */
function bufferAhead(element: HTMLVideoElement): number {
  const ranges = element.buffered
  const at = element.currentTime
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= at && at <= ranges.end(index)) {
      return ranges.end(index) - at
    }
  }
  return 0
}

/** The tiles' shared shape, or 16:9 until the files agree on another. */
/**
 * When a recording began, in wall-clock milliseconds, or the take's own start
 * where it has no time of its own — which is the one case the strips cannot
 * draw and the picker already warns about.
 */
function startOf(video: VideoSummary, takeFromMs: number): number {
  const parsed = Date.parse(video.startAt ?? '')
  return Number.isNaN(parsed) ? takeFromMs : parsed
}

function aspectOf(videos: VideoSummary[]): number {
  for (const video of videos) {
    if (video.width != null && video.height != null && video.height > 0) {
      return video.width / video.height
    }
  }
  return 16 / 9
}

function Tile(props: {
  videoId: string
  /** This one has stopped drawing, and has been stopped long enough to say. */
  waiting: boolean
  url: string | null
  /** Its player has stopped trying; the address is what to try next. */
  onGiveUp: (videoId: string) => void
  muted: boolean
  /** Where this tile should start, and a note that it is not there yet. */
  onAttaching: (id: string) => number | null
  onAttached: (
    id: string,
    element: HTMLVideoElement,
    toSec: number | null
  ) => void
  wantsToPlay: () => boolean
  rect: Rect
  dragging: { x: number; y: number } | null
  name: string
  parked: 'beforeStart' | 'afterEnd' | null
  unplaceable: boolean
  /** Its media is not there — the server answered, and there is nothing to play. */
  unavailable: boolean
  takeRef: (node: HTMLVideoElement | null) => void
  /** `pan-y` while a swipe should reach the page and hide Safari's bars. */
  touchAction: 'none' | 'pan-y'
  /** True while this is the one being heard. */
  heard: boolean
  /**
   * False while the press is doing something else, like a crawl, or once
   * another finger has taken it over.
   */
  canReorder: (pointerId: number) => boolean
  /** The finger the view's press now belongs to. */
  pressPointer: number | null
  /**
   * The press itself, in window coordinates, for the view's nine squares.
   * False when the view is ignoring this finger.
   */
  onPressStart: (pointerId: number, x: number, y: number) => boolean
  onPressMoved: (pointerId: number) => void
  /** True when the press was a hold, which is not a drop. */
  onPressEnd: (
    pointerId: number,
    still: boolean,
    x: number,
    y: number
  ) => boolean
  onPressCancel: (pointerId: number) => void
  onMove: (x: number, y: number) => void
  onDrop: (x: number, y: number) => void
}): React.ReactElement {
  const {
    rect,
    dragging,
    name,
    parked,
    unavailable,
    unplaceable,
    waiting,
    takeRef,
    heard
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const element = useRef<HTMLVideoElement | null>(null)
  /**
   * Whether this tile has drawn its first picture since its source was
   * attached. Until then it is black, and says it is loading rather than
   * leaving a black square to explain itself.
   */
  const [hasPicture, setHasPicture] = useState(false)
  useEffect(() => {
    const node = element.current
    setHasPicture(node != null && node.readyState >= 2)
    if (node == null) return
    const drew = (): void => {
      setHasPicture(true)
    }
    node.addEventListener('loadeddata', drew)
    return () => {
      node.removeEventListener('loadeddata', drew)
    }
  }, [props.url])

  // This tile's own source, attached when it has one and detached with it.
  // The play intent is injected rather than read off the element's pause
  // events: the view pauses tiles itself — holding them while another stalls,
  // parking one that was not recording yet — and `attachHls` would otherwise
  // read every one of those as the viewer pressing pause and never resume this
  // tile after a media error again.
  useEffect(() => {
    const node = element.current
    const { url, videoId, onAttaching, onAttached, onGiveUp, wantsToPlay } =
      props
    if (node == null || url == null) return
    const toSec = onAttaching(videoId)
    const detach = attachHls(
      node,
      url,
      () => {
        onGiveUp(videoId)
      },
      { wantsToPlay, buffer: TILE_BUFFER }
    )
    const start = (): void => {
      onAttached(videoId, node, toSec)
    }
    if (node.readyState >= 1) start()
    else node.addEventListener('loadedmetadata', start, { once: true })
    return () => {
      node.removeEventListener('loadedmetadata', start)
      detach()
    }
    // The source and which video it is. Muting and playing are handled
    // elsewhere; including them here would reset the element on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url, props.videoId])

  useEffect(() => {
    if (element.current != null) element.current.muted = props.muted
  }, [props.muted])

  /**
   * The press the view turns into a square's action, and — after a finger has
   * rested for a second — a drag that moves the picture.
   *
   * Not through the gesture library the single player uses, for two reasons
   * that are both about where this view lives: it is portalled into the
   * document body, outside the tree that library instruments, and the app is
   * web-only, so a pointer is a pointer. The same seam the game screen already
   * keeps for its `<video>` and its sticky `div`.
   */
  const dragFrom = useRef<{ x: number; y: number; id: number } | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armedRef = useRef(false)
  const [armed, setArmed] = useState(false)

  const disarm = (): void => {
    if (armTimer.current != null) clearTimeout(armTimer.current)
    armTimer.current = null
    armedRef.current = false
    setArmed(false)
  }
  useEffect(() => disarm, [])

  // Another finger has taken the press: a picture this tile had picked up
  // goes back where it was, and the finger that lifted it is done with it.
  const onDropRef = useRef(props.onDrop)
  onDropRef.current = props.onDrop
  useEffect(() => {
    const from = dragFrom.current
    if (!armedRef.current || from == null || from.id === props.pressPointer) {
      return
    }
    disarm()
    onDropRef.current(0, 0)
  }, [props.pressPointer])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (otherButton(event)) return
    // A finger the view is ignoring — another is holding a crawl — is not
    // this tile's to follow either.
    if (!props.onPressStart(event.pointerId, event.clientX, event.clientY)) {
      return
    }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    dragFrom.current = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId
    }
    disarm()
    armTimer.current = setTimeout(() => {
      armTimer.current = null
      if (!props.canReorder(event.pointerId)) return
      armedRef.current = true
      setArmed(true)
    }, REORDER_HOLD_MS)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    if (from?.id !== event.pointerId) return
    const x = event.clientX - from.x
    const y = event.clientY - from.y
    if (armedRef.current) {
      if (!props.canReorder(event.pointerId)) return
      props.onMove(x, y)
      return
    }
    // A finger that travels before the second is up is a slip, not a drag:
    // it neither moves the picture nor becomes one later.
    if (beyondSlop(x, y)) {
      if (armTimer.current != null) clearTimeout(armTimer.current)
      armTimer.current = null
      props.onPressMoved(event.pointerId)
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    if (from?.id !== event.pointerId) return
    dragFrom.current = null
    // Armed, and still the press: a finger that lost it to another is done,
    // and drops nothing.
    const wasArmed = armedRef.current && props.canReorder(event.pointerId)
    disarm()
    const moved = {
      x: event.clientX - from.x,
      y: event.clientY - from.y
    }
    const still = !beyondSlop(moved.x, moved.y)
    // A press that became a move is never also a tap.
    props.onPressEnd(
      event.pointerId,
      still && !wasArmed,
      event.clientX,
      event.clientY
    )
    // Always: the parent puts the picture back when the press meant nothing.
    if (wasArmed) props.onDrop(moved.x, moved.y)
    else props.onDrop(0, 0)
  }

  return (
    <View
      style={[
        styles.tile,
        {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          transform: [
            { translateX: dragging?.x ?? 0 },
            { translateY: dragging?.y ?? 0 }
          ],
          zIndex: dragging != null ? 2 : 1
        }
      ]}
    >
      <video
        ref={node => {
          element.current = node
          takeRef(node)
        }}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        playsInline
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          touchAction: props.touchAction,
          cursor: 'grab'
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={event => {
          if (dragFrom.current?.id !== event.pointerId) return
          dragFrom.current = null
          disarm()
          props.onPressCancel(event.pointerId)
          props.onDrop(0, 0)
        }}
      />
      {armed ? <View style={styles.tileArmed} pointerEvents="none" /> : null}
      <View style={styles.tileName} pointerEvents="none">
        <Text style={styles.tileNameText} numberOfLines={1}>
          {heard ? `🔊 ${name}` : name}
        </Text>
      </View>
      {parked != null ||
      unavailable ||
      unplaceable ||
      waiting ||
      !hasPicture ? (
        <View style={styles.tileParked} pointerEvents="none">
          <Text style={styles.tileParkedText}>
            {unavailable
              ? lstrings.game_video_unavailable
              : unplaceable
                ? lstrings.angles_unplaceable
                : parked === 'beforeStart'
                  ? lstrings.angles_not_recording_yet
                  : parked === 'afterEnd'
                    ? lstrings.angles_stopped
                    : waiting
                      ? lstrings.angles_tile_catching_up
                      : lstrings.angles_tile_loading}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // Pinned to the window rather than to whatever happens to be positioned
  // above it in the tree: this is the whole screen while it is up. `fixed` is
  // a web value React Native has no name for, so it goes through the one cast
  // this app keeps for exactly that.
  overlay: webStyle({
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000000',
    zIndex: 100
  }),
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000'
  },
  tileName: {
    position: 'absolute',
    top: theme.rem(theme.spaceXsRem),
    left: theme.rem(theme.spaceSmRem),
    maxWidth: '80%',
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  tileArmed: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderWidth: 3,
    borderColor: theme.activeColor
  },
  tileNameText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowRadius: 4
  },
  tileParked: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)'
  },
  tileParkedText: {
    color: '#ffffff',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    textAlign: 'center',
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  gate: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // Above the tiles, which stack explicitly. Without this the gate's way out
    // was drawn over the pictures and pressed through to them — and on a phone
    // held upright that Close is the only way out of the grid.
    zIndex: 7,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceMdRem),
    // Solid, not nine tenths: a tile showing through the gate reads as the
    // game playing behind a message that says it is not.
    backgroundColor: '#000000'
  },
  gatePosters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem),
    maxWidth: theme.rem(22),
    paddingHorizontal: theme.rem(theme.spaceMdRem)
  },
  gatePoster: {
    // The shape belongs to `VideoPoster`, which already keeps 16:9 on its own
    // frame. Two of them nested is what left the row misaligned.
    width: theme.rem(9),
    borderRadius: theme.rem(0.375),
    overflow: 'hidden'
  },
  gateTitle: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    textAlign: 'center',
    paddingHorizontal: theme.rem(theme.spaceLgRem)
  },
  gateText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center',
    paddingHorizontal: theme.rem(theme.spaceLgRem)
  },
  gateClose: {
    minHeight: theme.rem(3),
    justifyContent: 'center',
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(1.5),
    backgroundColor: 'rgba(255, 255, 255, 0.15)'
  },
  gateCloseText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875)
  },
  readout: {
    position: 'absolute',
    // Above the tiles and clear of the notice, which sits at the top middle.
    zIndex: 6,
    top: theme.rem(theme.spaceSmRem),
    left: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(0.375),
    backgroundColor: 'rgba(0, 0, 0, 0.72)'
  },
  readoutText: {
    color: '#9cff9c',
    fontFamily: 'monospace',
    fontSize: theme.rem(0.6875)
  },
  notice: {
    position: 'absolute',
    // Above the tiles, which stack explicitly: otherwise the pictures draw
    // over the words.
    zIndex: 6,
    top: theme.rem(theme.spaceSmRem),
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.7)'
  },
  noticeText: {
    color: '#ffffff',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125)
  }
}))
