import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pressable, Text, useWindowDimensions, View } from 'react-native'

import type { GameStationClient, VideoSummary } from '../../common/api'
import { webStyle } from '../components/glass'
import { VideoPoster } from '../components/VideoPoster'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import {
  BEHIND_WINDOW_MS,
  correctionFor,
  endFor,
  everythingEnded,
  hasStalled,
  holdExpired,
  isFinished,
  isOurSilence,
  isStarved,
  liveTargetMs,
  masterOf,
  type Placeable,
  promotionWait,
  readyToPromote,
  runningBehind,
  WATCHDOG_MS,
  worthCorrecting
} from './multiCam/align'
import {
  dropTarget,
  MAX_TILES,
  type Rect,
  swap,
  tileRects
} from './multiCam/layout'
import { angleLabels, soundAngle } from './multiCam/takes'
import { MultiCamBar } from './MultiCamBar'
import { SLOW_RATE } from './slowMotion'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { secondsAt, wallAt, type Window, windowOf } from './wallClock'

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

/** How long a tile may stall before the view drops to two of them. */
const DEMOTE_AFTER_MS = 6000

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
  const [demoted, setDemoted] = useState(false)
  /**
   * Demotions so far, which decides how long the view waits before trying
   * four angles again and when it stops trying on its own.
   */
  const [demotions, setDemotions] = useState(0)
  /**
   * `?debug=1`, which draws what each tile is actually doing.
   *
   * Written because the view's own account of itself — "two angles, a camera
   * kept dropping out" — is a conclusion, and a conclusion is no use to
   * somebody on a gigabit line who can see the same view demote. This shows
   * the numbers it reached that conclusion from.
   */
  const debug = useMemo(
    () =>
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('debug') === '1',
    []
  )
  const [readout, setReadout] = useState<string[]>([])
  /** Why the view last dropped to two, kept for the readout. */
  const lastDemotion = useRef<string>('')
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
  /** The clock's own progress, for spotting a take that cannot keep up. */
  const rateSample = useRef<{ wallMs: number; at: number } | null>(null)
  /**
   * When the trouble last stopped: nothing stalled, nothing behind. Null
   * while something is still wrong, so a demoted view only counts calm that
   * has held without interruption.
   */
  const calmSince = useRef<number | null>(null)
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
   * viewer is: `soundAngle` keeps a tile somebody picked from the bar, and
   * otherwise takes the longest angle that has a picture at this moment. A
   * grid can span two takes, so an answer worked out once when the address
   * was written goes wrong the first time anybody scrubs.
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

  /**
   * The two the view keeps when a weak connection makes four impossible.
   *
   * The one being heard, then the one that was made big, then whatever comes
   * next in the arrangement. Picking them with a filter kept only one where
   * the sound and the first tile were the same video, which is the ordinary
   * case — two is the point.
   */
  const shown = useMemo(() => {
    if (!demoted) return chosen
    const stuck = (video: VideoSummary): boolean =>
      tiles[video.id]?.stalledSince != null
    const keep: VideoSummary[] = []
    const add = (video: VideoSummary | undefined): void => {
      if (video != null && !keep.some(one => one.id === video.id))
        keep.push(video)
    }
    // A camera that has stopped drawing is the last thing to keep: demotion
    // exists to leave the viewer with pictures, and keeping the dead one
    // because it happened to hold the sound leaves them with one.
    if (!stuck(chosen.find(video => video.id === heardId) ?? chosen[0])) {
      add(chosen.find(video => video.id === heardId))
    }
    add(chosen.find(video => video.id === zoomedId && !stuck(video)))
    for (const video of chosen) {
      if (keep.length >= 2) break
      if (!stuck(video)) add(video)
    }
    // And if everything is stuck, two of them anyway: something has to be on
    // the screen, and they may all come back together.
    for (const video of chosen) {
      if (keep.length >= 2) break
      add(video)
    }
    return keep.slice(0, 2)
  }, [chosen, demoted, heardId, tiles, zoomedId])

  /**
   * The tile the sound actually comes out of.
   *
   * `heardId` is the answer for the grid; this is the answer for the two
   * tiles left when a weak connection has demoted it. Demotion drops the
   * heard tile when it is the one that has stalled — that is the whole point,
   * the viewer is left with pictures — and the sound went on naming it, so
   * both surviving tiles stayed muted with no speaker glyph anywhere for the
   * length of the demotion.
   */
  const audibleId = useMemo(() => {
    if (heardId != null && shown.some(video => video.id === heardId)) {
      return heardId
    }
    return soundAngle(
      shown.filter(one => urls[one.id] !== null),
      shown.map(one => one.id),
      null,
      atWallMs
    )
  }, [atWallMs, heardId, shown, urls])

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

  /**
   * Back to four angles, from wherever the view got to.
   *
   * A fresh start for every tile, not just the two that stayed: the stall
   * that caused the demotion is still written down, and without clearing it
   * the next tick simply demotes again — which is what made the button look
   * dead to anybody who pressed it. `everStarted` goes with it, because the
   * two tiles coming back are being attached from nothing and a tile that is
   * opening its source has not stalled, it has not started.
   */
  const restoreAll = useCallback(() => {
    setTiles(current => {
      const next: Record<string, TileState> = {}
      for (const [id, tile] of Object.entries(current)) {
        next[id] = { ...tile, stalledSince: null }
      }
      return next
    })
    frames.current.clear()
    everStarted.current.clear()
    calmSince.current = null
    rateSample.current = null
    setDemoted(false)
  }, [])

  const rects = tileRects({
    width,
    height,
    count: shown.length,
    aspect: aspectOf(shown),
    zoomed:
      zoomedId == null ? null : shown.findIndex(video => video.id === zoomedId)
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
   * Each tile owns its own attach, so removing one — which is what demotion
   * does — leaves the others playing instead of tearing every element down and
   * rebuilding it. Doing that as one effect over the whole set meant a weak
   * connection was answered by reloading the two tiles that were still
   * managing, which is the opposite of the help intended.
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
      intents.current.set(id, playing)
      if (playing) element.play().catch(() => undefined)
    },
    [chosen, playing]
  )

  /** Everything the alignment rules need to know about a tile right now. */
  const placeables = useCallback(
    (): Placeable[] =>
      shown.map(video => ({
        id: video.id,
        video,
        playable:
          elements.current.get(video.id) != null && urls[video.id] != null,
        ended: tiles[video.id]?.ended
      })),
    [shown, tiles, urls]
  )

  /** Puts every tile on one instant, and says what each of them did. */
  const alignTo = useCallback(
    (wallMs: number, toleranceSec?: number): void => {
      for (const video of shown) {
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
        intents.current.set(video.id, playing)
        if (playing && element.paused) {
          element.play().catch(() => undefined)
        }
      }
    },
    [playing, shown]
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
      for (const video of shown) {
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

      // Four buffers can fail where one would have stalled, and a viewer
      // cannot diagnose four posters. Two tiles is the valve, and it says so.
      //
      // **Starving, not merely stopped.** Dropping two pictures relieves the
      // line, so it is worth doing when the line is the trouble: a tile with
      // nothing buffered has run out of stream. A tile sitting on twenty
      // seconds that has stopped drawing is short of nothing — the decoder is
      // wedged, or the tab was throttled — and taking two other cameras away
      // fixes none of it. Judging on the stall alone is how a gigabit
      // connection was told it could not carry four streams.
      const stuckNow = shown.some(
        video => tiles[video.id]?.stalledSince != null
      )
      if (!demoted && shown.length > 2) {
        const struggling = shown.filter(video => {
          const since = tiles[video.id]?.stalledSince
          if (since == null || now - since <= DEMOTE_AFTER_MS) return false
          const element = elements.current.get(video.id)
          if (element == null) return false
          return isStarved({
            bufferAheadSec: bufferAhead(element),
            readyState: element.readyState
          })
        })
        if (struggling.length > 0) {
          const who = struggling
            .map(video => names.get(video.id) ?? video.id)
            .join(', ')
          lastDemotion.current = `${clockOf(now)} starved: ${who}`
          setDemoted(true)
          setDemotions(count => count + 1)
          calmSince.current = null
        }
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
        const summary = shown.find(video => video.id === tile.id)
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

      const leader = masterOf(showing, audibleId)
      const leaderVideo = shown.find(video => video.id === leader)
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
       * a viewer cannot diagnose — and with two angles left there is no
       * demotion to fall back on. And **held**, not merely announced: the clock
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

      // A connection that cannot carry four streams delivers all of them
      // slowly: every tile draws, none stalls, and the game runs at two
      // thirds speed. The clock is the only thing that shows it.
      //
      // Only while a camera is actually showing the moment. The clock stops
      // at the end of a take by design, and stands still in the gap between
      // recordings — read as a rate, both look exactly like a connection that
      // has given out, and the first real four-camera take demoted itself on
      // a healthy line as it reached its own last second.
      const sample = rateSample.current
      const measurable = playing && showing.length > 0
      let behind = false
      if (sample == null || !measurable) {
        rateSample.current = measurable ? { wallMs, at: now } : null
      } else if (runningBehind(wallMs - sample.wallMs, now - sample.at)) {
        behind = true
        if (!demoted && shown.length > 2) {
          const rate = (wallMs - sample.wallMs) / (now - sample.at)
          lastDemotion.current = `${clockOf(now)} take ran at ${rate.toFixed(2)}×`
          setDemoted(true)
          setDemotions(count => count + 1)
        }
        rateSample.current = { wallMs, at: now }
      } else if (now - sample.at >= BEHIND_WINDOW_MS) {
        rateSample.current = { wallMs, at: now }
      }

      /**
       * How long the trouble has been over, and whether that is long enough.
       *
       * Calm is nothing stalled and nothing behind, held without a break —
       * any stumble puts the clock back to nought rather than shortening the
       * wait. It is only counted while the take is actually playing: a paused
       * view is not evidence that a connection has recovered.
       */
      if (stuckNow || behind || !measurable) {
        calmSince.current = null
      } else {
        calmSince.current ??= now
      }
      if (
        demoted &&
        calmSince.current != null &&
        readyToPromote({
          calmForMs: now - calmSince.current,
          attempts: demotions
        })
      ) {
        restoreAll()
      }

      if (debug) {
        const lines = shown.map(video => {
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
        if (lastDemotion.current !== '') {
          lines.push(`last drop: ${lastDemotion.current}`)
        }
        lines.push(
          `demotions ${demotions}  clock ${((wallMs - (takeRef.current?.fromMs ?? wallMs)) / 1000).toFixed(1)}s`
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
    demoted,
    demotions,
    audibleId,
    landscape,
    names,
    placeables,
    playing,
    restoreAll,
    shown,
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
      // A scrub is a jump, not progress: the measurement starts again.
      rateSample.current = null
      setAtWallMs(wallMs)
      alignTo(wallMs)
    },
    [alignTo]
  )

  useEffect(() => {
    if (!landscape || !playing) return
    for (const video of shown) {
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
      for (const video of shown) {
        const element = elements.current.get(video.id)
        if (element == null) continue
        if (tiles[video.id]?.parked != null) continue
        intents.current.set(video.id, next)
        if (next) element.play().catch(() => undefined)
        else element.pause()
      }
      return next
    })
  }, [shown, tiles])

  /**
   * A quarter speed, in both directions, by moving the clock.
   *
   * Not four `playbackRate`s: nothing has measured four decoders agreeing at
   * 0.25×, the rate control would fight the alignment at exactly the moment
   * somebody is studying a swing frame by frame, and backwards has no browser
   * support anywhere. The tiles are paused and stepped, which is what
   * `slowMotion.ts` already does for the single player — here it is the take's
   * own clock that is stepped, and every tile follows it.
   */
  const slowFrame = useRef(0)
  const [slow, setSlow] = useState(0)

  const holdAll = useCallback((): void => {
    for (const video of shown) {
      const element = elements.current.get(video.id)
      if (element == null) continue
      intents.current.set(video.id, false)
      element.pause()
    }
  }, [shown])

  const beginSlow = useCallback(
    (direction: 'slowForward' | 'slowBack'): void => {
      if (slowFrame.current !== 0 || atWallRef.current == null) return
      const rate = direction === 'slowForward' ? SLOW_RATE : -SLOW_RATE
      holdAll()
      setSlow(rate)
      let last = performance.now()
      const step = (now: number): void => {
        const seconds = (now - last) / 1000
        last = now
        const next = (atWallRef.current ?? 0) + seconds * rate * 1000
        atWallRef.current = next
        setAtWallMs(next)
        // A tenth of a second is nothing at full speed and four frames at a
        // quarter of it, so the tiles are held far tighter while stepping.
        alignTo(next, 0.01)
        slowFrame.current = requestAnimationFrame(step)
      }
      slowFrame.current = requestAnimationFrame(step)
    },
    [alignTo, holdAll]
  )

  const endSlow = useCallback((): void => {
    if (slowFrame.current === 0) return
    cancelAnimationFrame(slowFrame.current)
    slowFrame.current = 0
    setSlow(0)
    if (!playing) return
    for (const video of shown) {
      const element = elements.current.get(video.id)
      if (element == null || tilesRef.current[video.id]?.parked != null)
        continue
      intents.current.set(video.id, true)
      element.play().catch(() => undefined)
    }
  }, [playing, shown])

  // A key held while the tab changes never delivers its `keyup`.
  useEffect(() => {
    return () => {
      if (slowFrame.current !== 0) cancelAnimationFrame(slowFrame.current)
    }
  }, [])

  const skip = useCallback(
    (deltaSec: number): void => {
      if (atWallMs == null) return
      goTo(atWallMs + deltaSec * 1000)
    },
    [atWallMs, goTo]
  )

  // The keyboard, and only here: the single player behind this stands down.
  // The same hook it uses, so the two cannot both answer one key — and the
  // arrows are taken over, because moving a take means moving four pictures
  // rather than the one this hook would otherwise seek.
  useKeyboardShortcuts({
    video: () => elements.current.get(shown[0]?.id ?? '') ?? null,
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

  // A landscape phone, where a browser will let us ask. Both of these fail on
  // an iPhone — Safari has never supported locking the orientation, and
  // fullscreen on something that is not a `<video>` arrived late and is not to
  // be relied on — so neither is depended on and the portrait gate below is
  // what actually carries the rule.
  useEffect(() => {
    const root = document.documentElement as HTMLElement & {
      requestFullscreen?: () => Promise<void>
    }
    root.requestFullscreen?.().catch(() => undefined)
    // `lock` is the Screen Orientation API's newest corner: Chrome on Android
    // has it, Safari has never had it, and the two type-checkers this repo
    // runs disagree about whether it exists — so the two methods are asked
    // for by shape, which is true wherever they are and an assertion nowhere.
    const orientation: {
      lock?: (to: string) => Promise<void>
      unlock?: () => void
    } = screen.orientation
    orientation?.lock?.('landscape').catch(() => undefined)
    return () => {
      if (document.fullscreenElement != null) {
        document.exitFullscreen?.().catch(() => undefined)
      }
      orientation?.unlock?.()
    }
  }, [])

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
      {(attachTiles ? shown : []).map((video, index) => (
        <Tile
          key={video.id}
          videoId={video.id}
          url={urls[video.id] ?? null}
          unavailable={urls[video.id] === null}
          onGiveUp={askAgain}
          muted={video.id !== audibleId}
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
          onMove={(x, y) => {
            setDrag({ index, x, y })
          }}
          onDrop={(x, y) => {
            setDrag(null)
            // A press that went nowhere is a tap: the tile goes back where it
            // was, and nothing is reordered. Every touch tap carries a pixel
            // or two, so this is the ordinary case rather than the odd one.
            if (Math.abs(x) < 8 && Math.abs(y) < 8) return
            const rect = rects[index]
            if (rect == null) return
            const target = dropTarget(rects, {
              x: rect.x + rect.w / 2 + x,
              y: rect.y + rect.h / 2 + y
            })
            if (target == null || target === index) return
            onChange({ order: swap(order, index, target) })
          }}
          onZoom={() => {
            // Size only. Handing the sound to whatever was made big reads
            // well and is wrong on every real game: a camera's archive is
            // silent by design, so a double-tap on one took the sound off the
            // tile that had any, gave it to a tile that could not make one,
            // and did not give it back when the picture was made small again.
            // Which tile is heard is `soundAngle`'s to decide and the bar's
            // chips to change.
            onChange({ zoomedId: zoomedId === video.id ? null : video.id })
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

      {slow !== 0 ? (
        <View style={styles.speed} pointerEvents="none">
          <Text style={styles.speedText}>{slow < 0 ? '◀ 0.25×' : '0.25×'}</Text>
        </View>
      ) : null}

      {/* One at a time, most specific first: they share a place on the screen
          and two of them printed over each other unreadably. */}
      {!demoted && !ended && waiting ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>{lstrings.angles_waiting}</Text>
        </View>
      ) : null}

      {!demoted && ended ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>{lstrings.angles_all_ended}</Text>
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

      {demoted ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            {promotionWait(demotions) == null
              ? lstrings.angles_demoted_stuck
              : lstrings.angles_demoted}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.angles_restore}
            onPress={restoreAll}
          >
            <Text style={styles.noticeAction}>{lstrings.angles_restore}</Text>
          </Pressable>
        </View>
      ) : null}

      {landscape && take != null && atWallMs != null ? (
        <MultiCamBar
          window={take}
          atMs={atWallMs}
          playing={playing}
          angles={shown.map(video => ({
            id: video.id,
            name: names.get(video.id) ?? video.title,
            fromMs: startOf(video, take.fromMs),
            toMs:
              startOf(video, take.fromMs) +
              (video.durationSec ?? (take.toMs - take.fromMs) / 1000) * 1000,
            audio: video.id === audibleId
          }))}
          onTogglePlay={toggle}
          onSkip={skip}
          onScrub={goTo}
          onPickAudio={id => {
            // Tapping the tile that is already heard hands the choice back to
            // the grid. Without a way back, one tap pinned the sound to a
            // tile for good — and a pinned tile stops moving when the
            // position leaves its span, which is the silence this rule was
            // written to end.
            onChange({ audioId: audibleId === id ? null : id })
          }}
          onClose={onClose}
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

/** `14:07:22`, so a line in the readout can be matched to a moment. */
function clockOf(atMs: number): string {
  return new Date(atMs).toTimeString().slice(0, 8)
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
  onMove: (x: number, y: number) => void
  onDrop: (x: number, y: number) => void
  onZoom: () => void
}): React.ReactElement {
  const {
    rect,
    dragging,
    name,
    parked,
    unavailable,
    unplaceable,
    waiting,
    takeRef
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const element = useRef<HTMLVideoElement | null>(null)

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
   * Dragging and the double tap, on pointer events.
   *
   * Not through the gesture library the single player uses, for two reasons
   * that are both about where this view lives: it is portalled into the
   * document body, outside the tree that library instruments, and the app is
   * web-only, so a pointer is a pointer. The same seam the game screen already
   * keeps for its `<video>` and its sticky `div`.
   */
  const dragFrom = useRef<{ x: number; y: number; id: number } | null>(null)
  const lastTapAt = useRef(0)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    dragFrom.current = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId
    }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    if (from?.id !== event.pointerId) return
    props.onMove(event.clientX - from.x, event.clientY - from.y)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    dragFrom.current = null
    if (from == null) return
    const moved = {
      x: event.clientX - from.x,
      y: event.clientY - from.y
    }
    // A press that went nowhere is a tap, not a drag of no distance. Dropping
    // it anyway swapped two tiles on every single tap — and while one was
    // zoomed its rectangle is the whole grid, so the drop landed in the first
    // quadrant and reordered the lot.
    const still = Math.abs(moved.x) < 8 && Math.abs(moved.y) < 8
    // Always: the parent decides what a press means, and it also has to put
    // the picture back when the press meant nothing.
    props.onDrop(moved.x, moved.y)
    // Two taps in a third of a second is the double tap that makes a picture
    // big, and makes it small again.
    if (still) {
      const now = Date.now()
      if (now - lastTapAt.current < 350) {
        lastTapAt.current = 0
        props.onZoom()
      } else {
        lastTapAt.current = now
      }
    }
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
          touchAction: 'none',
          cursor: 'grab'
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragFrom.current = null
          props.onDrop(0, 0)
        }}
      />
      <Text style={styles.tileName} numberOfLines={1}>
        {name}
      </Text>
      {parked != null || unavailable || unplaceable || waiting ? (
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
                    : lstrings.angles_waiting}
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
  speed: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 6,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(1),
    margin: theme.rem(theme.spaceSmRem),
    backgroundColor: 'rgba(0, 0, 0, 0.65)'
  },
  speedText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600'
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
    // Above the tiles: demotion happens on its own, so `Show all four` is its
    // only way back and a press that lands on a picture instead is no way back
    // at all.
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
  },
  noticeAction: {
    color: theme.activeColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  }
}))
