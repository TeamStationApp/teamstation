import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TeamStationClient, VideoSummary } from '../../../common/api'
import { lstrings } from '../../locales/strings'
import { FLASH_MS, type SeekFlash, useFlash } from '../GestureFeedback'
import { SLOW_RATE } from '../slowMotion'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'
import { secondsAt, wallAt, type Window, windowOf } from '../wallClock'
import {
  type AngleZone,
  angleZoneFor,
  gestureAction,
  HOLD_MS,
  STEP_SECONDS
} from '../zones'
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
} from './align'
import {
  dragSlots,
  gridShape,
  MAX_TILES,
  move,
  type Rect,
  swap,
  tileRects
} from './layout'
import { angleLabels, soundAngle } from './takes'
import type { TileHandle } from './tileHandle'

export type { TileHandle }

export interface MultiCamProps {
  client: TeamStationClient
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
  /** Where the viewer now is, so the address can say so. */
  onMoment?: (wallMs: number) => void
  onClose: () => void
}

export interface MultiCamOptions {
  /** The box the tiles are laid out in. */
  width: number
  height: number
  /** Draw what each tile is doing (`?debug=1` on the web). */
  debug?: boolean
  /**
   * Called just before the tiles stand aside for a dragged one, so a phone
   * can animate the change it is about to draw.
   */
  beforeShuffle?: () => void
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
export const TILE_BUFFER = { seconds: 20, megabytes: 12 }

/** How long the bar stays up after the last touch of it. */
const BAR_HIDE_MS = 3000

/**
 * How long a finger has to rest on a tile before the tile can be moved.
 *
 * The tiles are the same surface the taps land on, so a drag that started at
 * once moved a picture whenever a tap to pause or skip slipped a little.
 */
export const REORDER_HOLD_MS = 1000

/**
 * How far a finger may slip, in pixels, and still have made a tap.
 *
 * Every touch tap carries a pixel or two, so a press that moved less than
 * this is the ordinary tap rather than the odd one; one that moved further is
 * a drag, on a tile or on the black around them alike.
 */
export const TAP_SLOP_PX = 8

/** Whether a finger has moved this far from where it came down. */
export function beyondSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) >= TAP_SLOP_PX || Math.abs(dy) >= TAP_SLOP_PX
}

export interface TileState {
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

/** A tile being moved, by how far it has come from where it was picked up. */
export interface TileDrag {
  index: number
  x: number
  y: number
  /** The slot it would land in if it were let go now. */
  target: number | null
}

/** What a view gets from `useMultiCam`: the state to draw and what to call. */
export interface MultiCam {
  /** The angles on the grid, in quadrant order. */
  chosen: VideoSummary[]
  names: Map<string, string>
  /** Each angle's address; `null` when it cannot be played. */
  urls: Record<string, string | null>
  tiles: Record<string, TileState>
  playing: boolean
  atWallMs: number | null
  /** The `debug` lines, when asked for. */
  readout: string[]
  ended: boolean
  waiting: boolean
  heardId: string | null
  /** Where each tile rests. */
  rects: Rect[]
  /**
   * Where each tile is drawn: its resting place, or — while another is being
   * dragged — the place it has slid to, to show where that one would land.
   */
  shownRects: Rect[]
  take: Window | null
  /** The crawl's rate, or 0. */
  slow: number
  flash: SeekFlash | null
  barShown: boolean
  /**
   * Whether any control is up — the bar, or the flash of a tap — which is
   * when the way out shows too.
   */
  controlsShown: boolean
  drag: TileDrag | null
  pressPointer: number | null
  /** What the view wants each tile to be doing, for the source's recovery. */
  intents: { current: Map<string, boolean> }
  takeElement: (id: string) => (node: TileHandle | null) => void
  attaching: (id: string) => number | null
  attached: (id: string, element: TileHandle, toSec: number | null) => void
  askAgain: (videoId: string) => void
  toggle: () => void
  skip: (deltaSec: number) => void
  goTo: (wallMs: number) => void
  showBar: () => void
  beginSlow: () => boolean
  endSlow: () => void
  runZone: (zone: AngleZone) => void
  pressStart: (pointerId: number, x: number, y: number) => boolean
  pressMoved: (pointerId: number) => void
  pressEnd: (pointerId: number, still: boolean, x: number, y: number) => boolean
  pressCancel: (pointerId: number) => void
  mayReorder: (pointerId: number) => boolean
  moveTile: (index: number, x: number, y: number) => void
  dropTile: (index: number, x: number, y: number) => void
  /** The angles as the bar draws them: a name and a stretch of the take. */
  barAngles: (window: Window) => Array<{
    id: string
    name: string
    fromMs: number
    toMs: number
  }>
  /** A tile has stopped drawing for long enough to say so. */
  tileWaiting: (id: string) => boolean
}

/**
 * Four angles of one game, playing together: everything the grid decides,
 * for whichever screen draws it.
 *
 * Everything about where a tile should be is worked out in wall-clock time:
 * `align.ts` decides what to do with each follower, `wallClock.ts` converts,
 * and this hook holds the tiles to it — the watchdog, the parking, the sound,
 * the crawl, the bar's timer and what a finger on the grid means. The two
 * views draw it: `MultiCamView.tsx` with the browser's elements, and
 * `MultiCamView.native.tsx` with the phone's players, each a `TileHandle`.
 */
export function useMultiCam(
  props: MultiCamProps,
  options: MultiCamOptions
): MultiCam {
  const { client, videos, order, audioId, zoomedId, atMs, onChange, onMoment } =
    props
  const { width, height, debug = false, beforeShuffle } = options

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

  const [readout, setReadout] = useState<string[]>([])
  const [ended, setEnded] = useState(false)
  /** Every camera that covers this moment is stuck. */
  const [waiting, setWaiting] = useState(false)

  const elements = useRef(new Map<string, TileHandle>())
  /** The take's own window, readable from the watchdog. */
  const takeRef = useRef<Window | null>(null)
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
      (node: TileHandle | null): void => {
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
    (id: string, element: TileHandle, toSec: number | null): void => {
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
      // than running a frame or two at full speed with its sound on.
      const crawling = crawlRate.current !== 0
      if (crawling) {
        element.playbackRate = SLOW_RATE
        element.muted = true
      }
      const run = crawling || playing
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
  useEffect(() => {
    const timer = setInterval(() => {
      // Nothing is inferred while slow motion is stepping the clock itself.
      if (slowFrame.current !== 0) return
      const now = Date.now()

      /** What each tile is doing, for `?debug=1`. */
      const showReadout = (clockMs: number): void => {
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
            `${element.paused ? 'paused' : 'playing'}  ${stalled}` +
            (tile?.parked != null ? `  parked ${tile.parked}` : '')
          )
        })
        lines.push(
          `clock ${((clockMs - (takeRef.current?.fromMs ?? clockMs)) / 1000).toFixed(1)}s`
        )
        setReadout(lines)
      }

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
          ended: tileElement.ended === true,
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
      // Drawn while waiting too: a grid that is stuck is exactly when the
      // numbers are wanted.
      if (debug && waitingNow && instant != null) showReadout(instant)
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

      if (debug) showReadout(wallMs)

      setAtWallMs(wallMs)
      alignTo(wallMs)
    }, WATCHDOG_MS)
    return () => {
      clearInterval(timer)
    }
  }, [alignTo, debug, heardId, names, placeables, playing, chosen, tiles])

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
   * A quarter speed, forwards, by moving the clock — in silence.
   *
   * Every tile plays at a quarter of its rate and the take's clock steps at
   * the same pace; a tile is only moved when it drifts past the usual
   * tolerance. The first version paused the tiles and seeked all four on every
   * frame — and handed each step to an alignment that called `play()` on them
   * because the view was playing, so between seeks they ran at full speed with
   * their sound on and every seek pulled them back: the picture lurched
   * forwards and backwards and the sound stuttered.
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
  const beginSlow = useCallback((): boolean => {
    if (slowFrame.current !== 0 || atWallRef.current == null) return false
    crawlRate.current = SLOW_RATE
    setRateAll(SLOW_RATE, () => true)
    setSlow(SLOW_RATE)
    alignTo(atWallRef.current, undefined, true)
    // The baseline is the first frame's own timestamp: `requestAnimationFrame`
    // hands one to its callback on every platform, so no clock is needed here
    // (`performance` is a browser global a phone does not type).
    let last = 0
    const step = (now: number): void => {
      const seconds = last === 0 ? 0 : (now - last) / 1000
      last = now
      const next = (atWallRef.current ?? 0) + seconds * SLOW_RATE * 1000
      atWallRef.current = next
      setAtWallMs(next)
      // Every frame, not once at the start. A tile handed a new source
      // mid-crawl loads at full speed, and one whose sound was switched on by
      // the angle it was heard from changing would play out loud: set once,
      // either lurched ahead of the others until the next seek.
      setRateAll(SLOW_RATE, () => true)
      alignTo(next, undefined, true)
      slowFrame.current = requestAnimationFrame(step)
    }
    slowFrame.current = requestAnimationFrame(step)
    return true
  }, [alignTo, setRateAll])

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

  const [flash, flashFor] = useFlash()
  /**
   * The flash is on screen: from a tap until it has faded. The flash itself
   * stays set once drawn — it is the last one, kept so the next counts on
   * from it — so the way out cannot follow it, and follows this.
   */
  const [flashing, setFlashing] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showFlash = (direction: SeekFlash['direction']): void => {
    flashFor(direction)
    setFlashing(true)
    if (flashTimer.current != null) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null
      setFlashing(false)
    }, FLASH_MS)
  }
  useEffect(() => {
    return () => {
      if (flashTimer.current != null) clearTimeout(flashTimer.current)
    }
  }, [])

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
    // Only the +10 s square crawls when held (`gestureAction`).
    const zone = angleZoneFor(x, y, width, height)
    const slowZone =
      zone !== 'controls' && gestureAction(zone, 'hold') === 'slowForward'
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
        state.held = beginSlow()
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
    beginSlow: action => {
      if (action === 'slowForward') beginSlow()
    },
    endSlow,
    // A crawl is running exactly while there is a frame scheduled for it.
    holding: () => slowFrame.current !== 0
  })

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
  const barReady = take != null && atWallMs != null
  useEffect(() => {
    if (barReady) showBar()
  }, [barReady, showBar])

  const [drag, setDrag] = useState<TileDrag | null>(null)
  const { columns } = gridShape(width, height, rects.length)

  /** Each tile's place while `drag` is in flight, or its resting one. */
  const slots =
    drag == null
      ? null
      : dragSlots(rects, columns, drag.index, { x: drag.x, y: drag.y }).slots
  const shownRects =
    slots == null
      ? rects
      : rects.map((rect, index) => rects[slots[index]] ?? rect)

  /** A tile has been carried `x`, `y` from where it was picked up. */
  const moveTile = (index: number, x: number, y: number): void => {
    const { target } = dragSlots(rects, columns, index, { x, y })
    if (target !== (drag?.target ?? index)) beforeShuffle?.()
    setDrag({ index, x, y, target })
  }

  /**
   * A tile was let go `x`, `y` from where it was picked up. Upright it is put
   * in the row under its centre and the others close up (`move`); sideways it
   * swaps with the tile under its centre (`swap`). A press that went nowhere
   * is a tap, and the tile goes back where it was.
   */
  const dropTile = (index: number, x: number, y: number): void => {
    setDrag(null)
    if (!beyondSlop(x, y)) return
    const { target } = dragSlots(rects, columns, index, { x, y })
    if (target == null || target === index) return
    const ids = chosen.map(video => video.id)
    const next =
      columns === 1 ? move(ids, index, target) : swap(ids, index, target)
    // Angles chosen but not on the grid (past the fourth, or not found) keep
    // their place after the ones that are.
    const rest = order.filter(id => !ids.includes(id))
    onChange({ order: [...next, ...rest] })
  }

  return {
    chosen,
    names,
    urls,
    tiles,
    playing,
    atWallMs,
    readout,
    ended,
    waiting,
    heardId,
    rects,
    shownRects,
    take,
    slow,
    flash,
    barShown,
    controlsShown: barShown || flashing,
    drag,
    pressPointer,
    intents,
    takeElement,
    attaching,
    attached,
    askAgain,
    toggle,
    skip,
    goTo,
    showBar,
    beginSlow,
    endSlow,
    runZone,
    pressStart,
    pressMoved,
    pressEnd,
    pressCancel,
    mayReorder,
    moveTile,
    dropTile,
    barAngles: (window: Window) =>
      chosen.map(video => ({
        id: video.id,
        name: names.get(video.id) ?? video.title,
        fromMs: startOf(video, window.fromMs),
        toMs:
          startOf(video, window.fromMs) +
          (video.durationSec ?? (window.toMs - window.fromMs) / 1000) * 1000
      })),
    tileWaiting: (id: string): boolean =>
      tiles[id]?.stalledSince != null &&
      holdExpired(Date.now() - (tiles[id]?.stalledSince ?? 0))
  }
}

/**
 * The end to judge one tile by: what its element holds, less the slack, and
 * nothing at all for a live recording — whose seekable range ends at the live
 * edge, which is not an end but the present moment.
 */
function endOfTile(
  video: { status: string },
  element: TileHandle | null | undefined
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
function mediaLengthOf(element: TileHandle): number | null {
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
function bufferAhead(element: TileHandle): number {
  const ranges = element.buffered
  if (ranges == null) return 0
  const at = element.currentTime
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= at && at <= ranges.end(index)) {
      return ranges.end(index) - at
    }
  }
  return 0
}

/**
 * When a recording began, in wall-clock milliseconds, or the take's own start
 * where it has no time of its own — which is the one case the strips cannot
 * draw and the picker already warns about.
 */
export function startOf(video: VideoSummary, takeFromMs: number): number {
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
