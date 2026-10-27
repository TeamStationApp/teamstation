import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import type { TeamStationClient, VideoSummary } from '../../../common/api'
import { lstrings } from '../../locales/strings'
import { FLASH_MS, type SeekFlash, useFlash } from '../GestureFeedback'
import { livePlaybackRetryDelay } from '../liveRejoin'
import type { PlayIntent } from '../playIntent'
import { SLOW_RATE } from '../slowMotion'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'
import { HAVE_CURRENT_DATA, HAVE_METADATA, seekableEndOf } from '../videoHandle'
import {
  type AngleVideo,
  placedAlone,
  secondsAt,
  wallAt,
  type Window,
  windowOf
} from '../wallClock'
import { MAPPING_WAIT_MS, type WallMapping } from '../wallMapping'
import {
  type AngleZone,
  angleZoneFor,
  gestureAction,
  HOLD_MS,
  SCRUB_EDGE_FRACTION,
  SCRUB_RATE,
  STEP_SECONDS,
  STILL_FRACTION
} from '../zones'
import {
  correctionFor,
  endFor,
  everythingEnded,
  hasStalled,
  holdExpired,
  isFinished,
  isOurSilence,
  JOIN_LEAD_SEC,
  liveOpeningMs,
  masterOf,
  NUDGE_MAX_SEC,
  nudgeRate,
  type ParkReason,
  type Placeable,
  WATCHDOG_MS,
  worthCorrecting
} from './align'
import {
  acrossStartHole,
  AHEAD_SEC,
  canStart,
  heldAhead,
  isDry,
  isReady,
  readyWhereItStands,
  START_GAP_SEC,
  strayed,
  type TileBuffer,
  toLeaveOut
} from './buffering'
import {
  aspectOf,
  dragSlots,
  gridShape,
  MAX_TILES,
  move,
  type Rect,
  swap,
  tileRects
} from './layout'
import { scrubSeeks } from './scrubSeeks'
import { angleLabels, soundAngle } from './takes'
import type { TileHandle } from './tileHandle'

export type { TileHandle }

export interface MultiCamProps {
  client: TeamStationClient
  /**
   * The game the angles are of, whose scoreboard is drawn over them. Absent,
   * there is no board.
   */
  gameId?: string | null
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
  /**
   * The grid went, however it went — its ✕, or the browser's Back taking the
   * angles off the address — with where its pictures were then, or the
   * clock's reading where none was playing.
   */
  onGone?: (atWallMs: number | null) => void
  /**
   * The viewer left, with the wall time the grid had got to, for the videos
   * page's player to pick up at; null before any tile has placed it.
   */
  onClose: (atWallMs: number | null) => void
  /**
   * Whether the server still lists a video as live, for a tile whose live
   * playlist was closed under it (`PlayIntent.isLive`).
   */
  isLive?: (videoId: string) => Promise<boolean>
}

export interface MultiCamOptions {
  /** The box the tiles are laid out in. */
  width: number
  height: number
  /** Draw what each tile is doing (`?debug=1` on the web). */
  debug?: boolean
  /**
   * Each tile's rectangle, in reading order, as the player's layout puts
   * them around the board and the box score (`playerLayout`). Drags and
   * drops measure against them. Without them the tiles fill the box
   * (`tileRects`).
   */
  rects?: Rect[]
  /**
   * Called just before the tiles stand aside for a dragged one, so a phone
   * can animate the change it is about to draw.
   */
  beforeShuffle?: () => void
  /**
   * How long to wait before asking again for a live angle that has no
   * address yet, after so many asks; undefined to stop. Tests shorten it.
   */
  liveRetryDelay?: (asks: number) => number | undefined
  /**
   * A tile's mapping onto the wall clock when its player has none of its own:
   * the server's wall timeline for the video (`GridScoreboard`). Without
   * either, its start time places it. Undefined while the timeline is still
   * being fetched.
   */
  fallbackMapping?: (videoId: string) => WallMapping | null | undefined
}

/**
 * How often a playing grid looks for a tile about to run dry.
 *
 * Faster than the watchdog, because the point is to stop everybody *before*
 * one of them stops on its own: at once a second a tile with half a second
 * left has usually frozen by the next look.
 */
export const DRY_CHECK_MS = 250

/** Tenths of a second from `since` to `now`, for the readout. */
function secondsSince(now: number, since: number | undefined): number {
  return Math.round((now - (since ?? now)) / 100) / 10
}

/** How often a joining tile looks to see whether the game has reached it. */
const JOIN_POLL_MS = 30

/** How far past the seekable end a tile's place may be and still count. */
const SEEKABLE_SLACK_SEC = 0.25

/** How long the bar stays up after the last touch of it. */
const BAR_HIDE_MS = 3000

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
  parked: ParkReason | null
  stalledSince: number | null
  ended: boolean
}

const freshTile = (): TileState => ({
  parked: null,
  stalledSince: null,
  ended: false
})

/** One finger on the view, followed from down to up. */
/**
 * What a press has become.
 *
 * - `pending`: down, and not yet anything; lifted under the tap slop it is a
 *   tap.
 * - `scrub`: it went sideways from the middle before `HOLD_MS`, and moves the
 *   playhead.
 * - `held`: it rested on the middle-right square, and crawls until lifted.
 * - `reorder`: it rested on a tile of several, and carries the tile.
 * - `dead`: anything else; its lift does nothing.
 */
export type PressMode = 'pending' | 'held' | 'scrub' | 'reorder' | 'dead'

interface Press {
  pointerId: number
  x0: number
  y0: number
  /** The tile it came down on, or null on the black around them. */
  tile: number | null
  /** The take's clock when it came down, which a scrub moves from. */
  startWall: number | null
  mode: PressMode
  /** Running while it may still become a hold. */
  timer: ReturnType<typeof setTimeout> | null
  /** It has moved beyond the tap slop, so its lift is not a tap. */
  travelled: boolean
  /** The scrub's next playhead, and the frame that will move there. */
  scrubTo: number | null
  frame: number
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
  /**
   * Where the pictures are now, on the wall clock: the heard tile's frame, or
   * the clock where nothing plays. `atWallMs` is the watchdog's last reading,
   * up to a second behind a playing tile — a close that reported it came back
   * that much short.
   */
  wallNow: () => number | null
  /**
   * The tile the clock is read from (`masterOf`), as the watchdog last chose
   * it; null until it has.
   */
  masterId: string | null
  /** The player of one tile, while it has one. */
  elementOf: (id: string) => TileHandle | undefined
  /** The `debug` lines, when asked for. */
  readout: string[]
  ended: boolean
  waiting: boolean
  /** The heard tile is playing without sound until the next touch. */
  soundBlocked: boolean
  /**
   * A tile's player was left playing silent because its sound needs a tap
   * (`PlayIntent.onSoundHeld`): the heard one's is then held as a refused
   * play's is, until the next touch.
   */
  soundHeld: (id: string) => void
  heardId: string | null
  /** Where each tile rests. */
  rects: Rect[]
  /** The tile that takes the whole box, by its index in `rects`, or null. */
  zoomed: number | null
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
  /** What the view wants each tile to be doing, for the source's recovery. */
  intents: { current: Map<string, boolean> }
  takeElement: (id: string) => (node: TileHandle | null) => void
  /** Where a tile's player hands its own wall-clock mapping (`PlayIntent`). */
  takeMapping: (id: string) => (mapping: WallMapping | null) => void
  attaching: (id: string) => number | null
  attached: (id: string, element: TileHandle, toSec: number | null) => void
  askAgain: (videoId: string) => void
  toggle: () => void
  skip: (deltaSec: number) => void
  goTo: (wallMs: number) => void
  /**
   * A drag along the bar: the playhead follows every move, the players are
   * sought at most four times a second, and `final` — the finger lifting, or
   * a tap — is always sought (`scrubSeeks`).
   */
  scrub: (wallMs: number, final?: boolean) => void
  showBar: () => void
  beginSlow: () => boolean
  endSlow: () => void
  runZone: (zone: AngleZone) => void
  /**
   * A finger, or the mouse, has come down at a point of the window, on a
   * tile or (null) the black around them. False when it is to be ignored,
   * because another finger is holding a crawl.
   */
  pressStart: (
    pointerId: number,
    x: number,
    y: number,
    tile: number | null
  ) => boolean
  /** It has moved to a point of the window. */
  pressMove: (pointerId: number, x: number, y: number) => void
  /** It has come up there; answers what it had become, or null if ignored. */
  pressEnd: (pointerId: number, x: number, y: number) => PressMode | null
  pressCancel: (pointerId: number) => void
  /** The tile a press has picked up, to be carried; null for none. */
  armedTile: number | null
  /** The bar's track width, which a scrub is measured against. */
  setTrackWidth: (px: number) => void
  moveTile: (index: number, x: number, y: number) => void
  dropTile: (index: number, x: number, y: number) => void
  /** The angles as the bar draws them: a name and a stretch of the take. */
  barAngles: (window: Window) => Array<{
    id: string
    name: string
    fromMs: number
    toMs: number
  }>
  /**
   * A tile has stopped drawing for long enough to say so, or is being left
   * out until it has caught up.
   */
  tileWaiting: (id: string) => boolean
  /** What a browser tile's source is told about its buffer (`attachHls`). */
  bufferFor: (id: string) => PlayIntent['buffer']
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
  const {
    width,
    height,
    debug = false,
    beforeShuffle,
    liveRetryDelay = livePlaybackRetryDelay,
    fallbackMapping
  } = options
  /** Each tile's own mapping, from its player; null when it has none. */
  const tileMappings = useRef(new Map<string, WallMapping | null>())
  const fallbackRef = useRef(fallbackMapping)
  fallbackRef.current = fallbackMapping
  /** How far a tile's player can reach, for its newest footage. */
  const seekableEndRef = useRef<(id: string) => number | null>(() => null)
  /**
   * The best mapping a tile has now: the server's wall timeline, then its
   * player's own.
   *
   * The timeline is placed by the frames' own wall clocks, across a reconnect
   * too. A playlist's program dates are when its segments were written: 4–5 s
   * after their pictures on a live ingest, and later still after a camera
   * stalled. A grid placed by them drew every board step that far ahead of its
   * picture, and two angles out of step by the stall. Its newest footage is
   * the timeline's wall time at what the player can reach.
   */
  const mappingOf = (id: string): WallMapping | null => {
    const served = fallbackRef.current?.(id) ?? null
    if (served == null) return tileMappings.current.get(id) ?? null
    return {
      ...served,
      newestWall: () => {
        const end = seekableEndRef.current(id)
        return (end == null ? null : served.wallAt(end)) ?? served.newestWall()
      }
    }
  }
  const mappingOfRef = useRef(mappingOf)
  mappingOfRef.current = mappingOf
  const takeMapping = useMemo(() => {
    const handed = new Map<string, (mapping: WallMapping | null) => void>()
    return (id: string) => {
      let take = handed.get(id)
      if (take == null) {
        take = mapping => {
          tileMappings.current.set(id, mapping)
        }
        handed.set(id, take)
      }
      return take
    }
  }, [])

  const chosen = useMemo(() => {
    const listed = order
      .map(id => videos.find(video => video.id === id))
      .filter((video): video is VideoSummary => video != null)
      .slice(0, MAX_TILES)
    // Each placed by its best mapping onto the wall clock, read afresh at
    // every conversion (`wallClock.ts`). A recording with no start has none:
    // alone it plays on its own media time, beside others it stays unplaced.
    return placedAlone(listed).map((video, index): VideoSummary & AngleVideo =>
      listed[index].startAt == null
        ? video
        : { ...video, clock: () => mappingOfRef.current(video.id) }
    )
  }, [order, videos])
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
  const [masterId, setMasterId] = useState<string | null>(null)

  const [readout, setReadout] = useState<string[]>([])
  const [ended, setEnded] = useState(false)
  /** Every camera that covers this moment is stuck. */
  const [waiting, setWaiting] = useState(false)
  /**
   * The browser would not let the heard tile play with its sound on.
   *
   * iOS Safari plays a video with sound only when a touch starts it, and the
   * grid starts its tiles once they hold enough — by when the touch that
   * opened it no longer counts. Refused, the heard tile sat paused and the
   * grid kept sending it to join the others, which on a phone is a black
   * flash every two seconds. It plays without sound instead, and the next
   * touch on the grid gives it back.
   */
  const [soundBlocked, setSoundBlocked] = useState(false)
  const soundBlockedRef = useRef(false)
  const playTile = useCallback((element: TileHandle): void => {
    element.play().catch((error: unknown) => {
      const refused = error instanceof Error && error.name === 'NotAllowedError'
      if (!refused || element.muted) return
      element.muted = true
      soundBlockedRef.current = true
      setSoundBlocked(true)
      element.play().catch(() => undefined)
    })
  }, [])

  const elements = useRef(new Map<string, TileHandle>())
  /** The take's own window, readable from the watchdog. */
  const takeRef = useRef<Window | null>(null)
  /** What the view wants each tile to be doing, for `attachHls`'s recovery. */
  const intents = useRef(new Map<string, boolean>())
  /** How many pictures each tile had drawn at the last look. */
  const frames = useRef(new Map<string, number>())
  /** When this view last moved each tile, so its own silence is forgiven. */
  const seekedAt = useRef(new Map<string, number>())
  seekableEndRef.current = id => {
    const element = elements.current.get(id)
    return element == null ? null : seekableEndOf(element)
  }
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
   * Whether the tiles may play: every tile the grid waits for held enough
   * when it last started, and none has run dry since. See `buffering.ts`.
   */
  const flowing = useRef(false)
  /** When each tile the grid is waiting for was first seen short of enough. */
  const shortSince = useRef(new Map<string, number>())
  /** Where each held tile was last moved to by the gate (`placeHeld`). */
  const heldPlace = useRef(new Map<string, number>())
  /** When the first live tile had a picture, for a grid with no moment yet. */
  const liveSince = useRef<number | null>(null)
  /**
   * Tiles the grid has stopped waiting for: one that kept the rest standing
   * still too long, or one that arrived while the rest were already playing.
   * Each is kept where the game is and joins in once it holds enough there.
   */
  const leftOut = useRef(new Set<string>())
  /** The same, for drawing. */
  const [outIds, setOutIds] = useState<ReadonlySet<string>>(new Set())
  const showLeftOut = (): void => {
    setOutIds(new Set(leftOut.current))
  }
  /** Tiles held on a picture just ahead of the moment, until it arrives. */
  const joining = useRef(new Map<string, ReturnType<typeof setInterval>>())
  const stopJoining = (id?: string): void => {
    for (const [key, timer] of joining.current) {
      if (id != null && key !== id) continue
      clearInterval(timer)
      joining.current.delete(key)
    }
  }
  useEffect(
    () => () => {
      stopJoining()
    },
    []
  )
  /** Whether the viewer wants the grid playing, for a timer that outlives a render. */
  const playingRef = useRef(playing)
  playingRef.current = playing
  /** `gate`, for a callback made before it in the render. */
  const gateRef = useRef<
    ((instant: number, finished?: Map<string, boolean>) => boolean) | null
  >(null)

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
        videos
          // As the grid places them: a lone unplaced angle on its media time.
          .map(one => chosen.find(placed => placed.id === one.id) ?? one)
          .filter(one => urls[one.id] !== null),
        order,
        audioId,
        atWallMs
      ),
    [atWallMs, audioId, chosen, order, urls, videos]
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

  const zoomedAt =
    zoomedId == null ? -1 : chosen.findIndex(video => video.id === zoomedId)
  const zoomed = zoomedAt >= 0 ? zoomedAt : null
  const rects =
    options.rects ??
    tileRects({
      width,
      height,
      count: chosen.length,
      aspect: aspectOf(chosen),
      zoomed
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

  /** Those waiting for an angle's wall timeline, by id. */
  const timelineWaiters = useRef(new Map<string, Set<() => void>>())
  /** Settles once the angle's wall timeline has answered, or after a wait. */
  const timelineAnswered = useCallback(async (id: string): Promise<void> => {
    if (fallbackRef.current == null || fallbackRef.current(id) !== undefined)
      return
    await new Promise<void>(resolve => {
      const waiters = timelineWaiters.current.get(id) ?? new Set()
      timelineWaiters.current.set(id, waiters)
      const done = (): void => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, MAPPING_WAIT_MS)
      waiters.add(done)
    })
  }, [])
  // A timeline that arrives renders the grid again.
  useEffect(() => {
    for (const [id, waiters] of timelineWaiters.current)
      if (fallbackRef.current?.(id) !== undefined)
        for (const done of [...waiters]) done()
  })

  // Where to play each angle from. One request each, which is the same
  // membership check the single player makes, and the token it hands back
  // lasts six hours — longer than any game.
  //
  // A tile is handed its address only once the server's wall timeline has
  // answered, or `MAPPING_WAIT_MS` has passed, as the videos page's own
  // landing waits. It is placed the moment its source attaches, and placed
  // by its start instead — seconds off on a live ingest — it stayed there:
  // alone it is the master, and nothing moves it later.
  //
  // Each is asked for once, whatever else renders meanwhile: an angle given
  // its address used to ask again for every one still waiting, and start
  // each one's wait for its timeline over.
  const asking = useRef(new Map<string, TeamStationClient>())
  useEffect(() => {
    const held = asking.current
    return () => {
      held.clear()
    }
  }, [])
  useEffect(() => {
    for (const video of chosen) {
      const id = video.id
      if (urls[id] !== undefined || asking.current.get(id) === client) continue
      asking.current.set(id, client)
      // Only the newest ask's answer, and none once the grid has gone.
      const answer = (url: string | null): void => {
        if (asking.current.get(id) !== client) return
        asking.current.delete(id)
        setUrls(current => ({ ...current, [id]: url }))
      }
      client
        .playback(id)
        .then(async found => {
          await timelineAnswered(id)
          answer(found.url)
        })
        .catch(() => {
          answer(null)
        })
    }
  }, [chosen, client, timelineAnswered, urls])

  // A live angle is listed the moment its stream starts publishing, a few
  // seconds before its first segment is written, and until then `playback`
  // has no address for it. A grid opened in that moment drew the tile "not
  // available" and never asked again, so a viewer who opened All angles as a
  // camera came on saw it dead until a reload. Like the single player, the
  // grid asks again, backing off from 2 s to 30 s and giving up after ten
  // minutes, when a refused publish has plainly never written a segment.
  const [liveAsks, setLiveAsks] = useState<Record<string, number>>({})
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    for (const video of chosen) {
      if (video.status !== 'live' || urls[video.id] !== null) continue
      const asks = liveAsks[video.id] ?? 0
      const wait = liveRetryDelay(asks)
      if (wait == null) continue
      timers.push(
        setTimeout(() => {
          setLiveAsks(current => ({ ...current, [video.id]: asks + 1 }))
          askAgain(video.id)
        }, wait)
      )
    }
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [askAgain, chosen, liveAsks, liveRetryDelay, urls])

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
      const newest = newestSecOf(video)
      const inRange =
        toSec != null &&
        toSec >= 0 &&
        (video.durationSec == null || toSec <= video.durationSec) &&
        // Not yet at a live camera: it is not sent past its newest footage.
        (newest == null || toSec <= newest)
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
                mediaSec: endOfTile(video, element),
                newestSec: newestSecOf(video)
              }
            })

      // A camera that was not recording at this moment is parked before it is
      // ever played: it used to start at whatever frame it opened on — a
      // picture from later in the game, under a label saying it had not
      // started — and to play half a second of it out loud when it held the
      // sound.
      if (correction?.kind === 'park') {
        // A live camera behind the game waits where it opened.
        if (correction.reason !== 'notYet')
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

      if (toSec != null) {
        element.currentTime = toSec
        seekedAt.current.set(id, Date.now())
      }
      // One that arrives in the middle of a crawl joins it at once, rather
      // than running a frame or two at full speed with its sound on.
      const crawling = crawlRate.current !== 0
      if (crawling) {
        element.playbackRate = SLOW_RATE
        element.muted = true
      }
      // One that arrives while the rest are already playing has nothing in
      // hand yet. Waited for, it would stop the whole grid for the seconds it
      // takes to fill; so it fills where the game is, and joins in once it
      // holds enough there.
      if (!crawling && flowing.current) {
        leftOut.current.add(id)
        showLeftOut()
      }
      const run =
        crawling || (playing && flowing.current && !leftOut.current.has(id))
      intents.current.set(id, run)
      if (run) playTile(element)
      else element.pause()
      // The last tile to arrive is often the one the others were waiting for.
      if (!crawling && !flowing.current && instant != null) {
        gateRef.current?.(instant)
      }
    },
    [chosen, playTile, playing]
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

  /** The angles and the heard one, for timers that outlive a render. */
  const chosenRef = useRef(chosen)
  chosenRef.current = chosen

  /**
   * Where a live angle's newest footage is on the wall, by its mapping, or
   * failing that its player's seekable end; null where neither can say.
   */
  const newestWallOf = (video: VideoSummary & AngleVideo): number | null => {
    const element = elements.current.get(video.id)
    if (element == null) return null
    const newest = video.clock?.()?.newestWall()
    if (newest != null) return newest
    const end = seekableEndOf(element)
    return end == null ? null : wallAt(video, end)
  }
  const heardRef = useRef(heardId)
  heardRef.current = heardId

  /**
   * Where the game is this instant, read off a tile that is playing — the
   * heard one where it can, since it is never moved — rather than the
   * watchdog's clock, which is up to a second old.
   */
  const gameNow = (except: string): number | null => {
    const ids = [heardRef.current, ...chosenRef.current.map(video => video.id)]
    for (const id of ids) {
      if (id == null || id === except || joining.current.has(id)) continue
      const element = elements.current.get(id)
      const video = chosenRef.current.find(one => one.id === id)
      if (element == null || video == null || element.paused) continue
      const there = wallAt(video, element.currentTime)
      if (there != null) return there
    }
    return null
  }
  /** `gameNow`, for callbacks made once and kept. */
  const gameNowRef = useRef(gameNow)
  gameNowRef.current = gameNow
  const onGoneRef = useRef(props.onGone)
  onGoneRef.current = props.onGone
  // A layout effect's cleanup runs before the tiles' refs are detached, so
  // it still reads the picture's own moment rather than the clock's.
  useLayoutEffect(() => {
    return () => {
      onGoneRef.current?.(gameNowRef.current('') ?? atWallRef.current)
    }
  }, [])

  /**
   * Sends a tile just ahead of the game and starts it on the moment the game
   * reaches it (`JOIN_LEAD_SEC`).
   *
   * Started when it is *ready* there and the game has *arrived*, both, rather
   * than after a fixed wait: a seek under four decodes can take longer than
   * any wait chosen in advance, and a tile started before it has landed
   * starts behind. One the game has passed before it was ready is sent
   * further ahead and tried again.
   */
  const joinAhead = (
    video: VideoSummary,
    element: TileHandle,
    leadSec: number
  ): void => {
    stopJoining(video.id)
    const fromMs = gameNow(video.id) ?? atWallRef.current
    const target = fromMs == null ? null : secondsAt(video, fromMs)
    if (target == null) return
    if (element.playbackRate !== 1) element.playbackRate = 1
    intents.current.set(video.id, false)
    if (!element.paused) element.pause()
    element.currentTime = target + leadSec
    seekedAt.current.set(video.id, Date.now() + leadSec * 1000)
    const begun = Date.now()
    const start = (): void => {
      stopJoining(video.id)
      seekedAt.current.set(video.id, Date.now())
      const go =
        playingRef.current && flowing.current && !leftOut.current.has(video.id)
      intents.current.set(video.id, go)
      if (go) playTile(element)
    }
    joining.current.set(
      video.id,
      setInterval(() => {
        if (elements.current.get(video.id) !== element) {
          stopJoining(video.id)
          return
        }
        const now = gameNow(video.id)
        const there = wallAt(video, element.currentTime)
        // Nothing to follow: as good a guess as any is the lead itself.
        if (now == null || there == null) {
          if (Date.now() - begun >= leadSec * 1000) start()
          return
        }
        if (now < there) return
        const ready = element.seeking !== true && element.readyState >= 3
        if (ready) {
          start()
        } else if (now - there > 250) {
          joinAhead(video, element, Math.min(leadSec * 2, JOIN_LEAD_SEC * 4))
        }
      }, JOIN_POLL_MS)
    )
  }
  /** `joinAhead`, for the alignment, which is made once per render's angles. */
  const joinAheadRef = useRef(joinAhead)
  joinAheadRef.current = joinAhead

  /** Puts every tile on one instant, and says what each of them did. */
  const alignTo = useCallback(
    (
      wallMs: number,
      toleranceSec?: number,
      /**
       * Whether the tiles should run. Left out, each runs when the view is
       * playing, the grid is letting tiles play, and it is not left out.
       */
      runAll?: boolean,
      /**
       * `exact` goes where somebody asked: every tile to the instant, now.
       * `open` starts a held grid: every tile from where it stands, together.
       * `settle` is the watchdog's look: a tile still landing from the last
       * seek is left to land, one a little out is brought back by speed
       * (`nudgeRate`), and one joining or far out is sent just ahead and
       * started when the game reaches it (`JOIN_LEAD_SEC`).
       */
      mode: 'exact' | 'open' | 'settle' = 'exact'
    ): void => {
      const settle = mode !== 'exact'
      for (const video of chosen) {
        const element = elements.current.get(video.id)
        if (element == null) continue
        // Waiting for the game to reach it: left alone by the watchdog, and
        // overtaken by anything somebody asked for.
        if (joining.current.has(video.id)) {
          if (mode === 'settle') continue
          stopJoining(video.id)
        }
        const run =
          runAll ??
          (playing && flowing.current && !leftOut.current.has(video.id))
        const correction = correctionFor({
          wallMs,
          follower: {
            video,
            atSec: element.currentTime,
            mediaSec: endOfTile(video, element),
            newestSec: newestSecOf(video)
          },
          toleranceSec
        })
        if (correction.kind === 'park') {
          intents.current.set(video.id, false)
          element.pause()
          // Waiting for its live footage to reach the game: left where it is,
          // with nothing sought, until its mapping says the footage is there.
          if (correction.reason === 'notYet') {
            setTiles(current =>
              current[video.id]?.parked === 'notYet'
                ? current
                : {
                    ...current,
                    [video.id]: {
                      ...(current[video.id] ?? freshTile()),
                      parked: 'notYet'
                    }
                  }
            )
            continue
          }
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
        // A tile a little out, while it plays, is brought back by speed: a
        // seek costs more than the gap everywhere but Chrome (`align.ts`).
        const target = secondsAt(video, wallMs)
        const errorSec = target == null ? 0 : target - element.currentTime
        // Joining — starting late, coming back, or too far out to close by
        // speed — it is sent just ahead and started when the game gets there.
        const joins =
          mode === 'settle' &&
          run &&
          crawlRate.current === 0 &&
          target != null &&
          (element.paused ||
            (Math.abs(errorSec) > NUDGE_MAX_SEC &&
              worthCorrecting(element.readyState, errorSec)))
        if (joins) {
          setTiles(current =>
            current[video.id]?.parked == null
              ? current
              : {
                  ...current,
                  [video.id]: { ...current[video.id], parked: null }
                }
          )
          joinAheadRef.current(video, element, JOIN_LEAD_SEC)
          continue
        }
        const nudging =
          settle &&
          run &&
          crawlRate.current === 0 &&
          target != null &&
          Math.abs(errorSec) <= NUDGE_MAX_SEC
        if (nudging) {
          const rate = nudgeRate(errorSec)
          if (element.playbackRate !== rate) element.playbackRate = rate
        } else if (crawlRate.current === 0 && element.playbackRate !== 1) {
          element.playbackRate = 1
        }
        if (correction.kind === 'seek' && !nudging) {
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
          const now = Date.now()
          // Still landing from the last seek: judge where it landed, not
          // where it is on the way.
          if (!(settle && isOurSilence(now, seekedAt.current.get(video.id)))) {
            element.currentTime = correction.toSec
            // We moved it, so it will draw nothing for a moment: that silence
            // is this view's own doing, for a second and a half and no longer.
            // The baseline stays. Deleting it made the next look read as "it
            // drew something" — because there was nothing to compare against
            // — which wiped the stall of a tile that had drawn nothing for a
            // minute and a half. `isOurSilence` is what forgives our own
            // seek; the evidence does not need destroying as well.
            seekedAt.current.set(video.id, now)
          }
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
          playTile(element)
        } else if (!run && !element.paused) {
          element.pause()
        }
      }
    },
    [playing, playTile, chosen]
  )

  /**
   * The tiles the grid waits for at this instant: those that cover it, can be
   * played, have not finished, and have not been left out.
   */
  const awaited = useCallback(
    (instant: number, finished?: Map<string, boolean>): VideoSummary[] =>
      chosen.filter(video => {
        // An angle with no address is never coming; `undefined` is one still
        // being asked for, which is.
        if (urls[video.id] === null || leftOut.current.has(video.id)) {
          return false
        }
        if (finished?.get(video.id) ?? tiles[video.id]?.ended) {
          return false
        }
        const element = elements.current.get(video.id)
        const correction = correctionFor({
          wallMs: instant,
          follower: {
            video,
            atSec: element?.currentTime ?? 0,
            mediaSec: endOfTile(video, element),
            newestSec: newestSecOf(video)
          }
        })
        return correction.kind !== 'park'
      }),
    [chosen, tiles, urls]
  )

  /**
   * Whether anything has had a picture, which is when a hold is worth saying
   * out loud: a grid still opening says so on each tile instead.
   */
  const anyPicture = useCallback(
    (): boolean =>
      everStarted.current.size > 0 ||
      [...elements.current.values()].some(element => element.readyState >= 2),
    []
  )

  /**
   * A tile the grid waits for is about to run out of pictures — rather than
   * settling after this view moved it.
   *
   * A phone's player says it is buffering for a moment after every seek, even
   * one into what it already holds, and says nothing else about how much it
   * holds. Read as running dry, that held the grid after every alignment, and
   * the restart that followed moved the tiles again: a loop that kept a Pixel
   * standing still for half a minute at a time. A browser tile says how many
   * seconds it holds, which a seek does not fake, so it is taken at its word.
   */
  const runningDry = useCallback(
    (video: VideoSummary, now: number): boolean => {
      const buffer = bufferOf(elements.current.get(video.id))
      if (!isDry(buffer)) return false
      return (
        buffer.aheadSec != null ||
        !isOurSilence(now, seekedAt.current.get(video.id))
      )
    },
    []
  )

  /** Stops every tile where it is, until they all hold enough again. */
  const hold = useCallback((): void => {
    flowing.current = false
    stopJoining()
    // The clock stops where the pictures stop: read from the tile that is
    // heard, which is never moved, or failing that any tile still playing.
    // The watchdog last set it up to a second ago, and starting again from
    // there put every tile back by however far it had played since.
    const running = chosen.filter(
      video => elements.current.get(video.id)?.paused === false
    )
    const from = running.find(video => video.id === heardId) ?? running[0]
    const fromElement = from == null ? null : elements.current.get(from.id)
    const stoppedAt =
      from == null || fromElement == null
        ? null
        : wallAt(from, fromElement.currentTime)
    if (stoppedAt != null) {
      atWallRef.current = stoppedAt
      setAtWallMs(stoppedAt)
    }
    for (const [id, element] of elements.current) {
      if (element.paused) continue
      intents.current.set(id, false)
      element.pause()
    }
  }, [chosen, heardId])

  /**
   * Moves a held tile that holds nothing where the gate measures it to that
   * place, once for each place (`strayed`), and says whether it did: its
   * player loads around where it stands, so left there it never comes to hold
   * enough where it is wanted, or — within `START_GAP_SEC` of it — opens the
   * grid a segment past the moment.
   *
   * Only a browser's tile, which says what it holds, once it knows its
   * stream, and never past what can be sought to — a live tile ahead of its
   * footage waits as `notYet` instead. Once for each place, because a player
   * that steps over a hole at the start (`START_GAP_SEC`) lands a little past
   * where it was sent, and sending it back would be a loop.
   */
  const placeHeld = useCallback(
    (video: VideoSummary, instant: number): boolean => {
      const element = elements.current.get(video.id)
      if (element?.buffered == null || element.seeking === true) return false
      if (element.readyState < HAVE_METADATA) return false
      const target = secondsAt(video, instant)
      if (target == null || target < 0) return false
      const end = mediaLengthOf(element)
      if (end != null && target > end) return false
      // A recording's player steps over only a short hole where it starts:
      // one standing in a wider one, near the moment, is sent across it, or
      // it stays there frozen once the grid plays.
      const across =
        video.status === 'live'
          ? null
          : acrossStartHole(heldRanges(element), element.currentTime)
      if (
        across != null &&
        Math.abs(element.currentTime - target) <= START_GAP_SEC
      ) {
        // And not sent back into the hole for this place.
        heldPlace.current.set(video.id, target)
        seekedAt.current.set(video.id, Date.now())
        element.currentTime = across
        return true
      }
      if (heldPlace.current.get(video.id) === target) return false
      if (!strayed(heldRanges(element), element.currentTime, target)) {
        return false
      }
      heldPlace.current.set(video.id, target)
      seekedAt.current.set(video.id, Date.now())
      element.currentTime = target
      return true
    },
    []
  )

  /**
   * Lets the grid play from this instant if every tile it waits for holds
   * enough there, and says whether it did.
   *
   * Measured where each tile is about to be put rather than where it sits,
   * so a tile is not passed on a buffer it is about to be moved out of. One
   * that has kept the others standing still for `LEAVE_OUT_MS`, while another
   * was ready, is left out, and the rest go without it.
   */
  const gate = useCallback(
    (instant: number, finished?: Map<string, boolean>): boolean => {
      const now = Date.now()
      const awaiting = awaited(instant, finished)
      const alone = awaiting.length === 1
      const waits = awaiting.map(video => {
        const element = elements.current.get(video.id)
        // One just moved holds nothing yet where it was sent.
        let ready =
          !placeHeld(video, instant) &&
          isReady(bufferAt(video, element, instant))
        // A player that says it can play where it stands is not kept waiting
        // for seconds it will never fetch: Safari loads little ahead of a
        // paused video, so the grid's own measure, taken at its clock, can
        // stay short for ever — a lone angle has nobody to be left out for.
        const since = shortSince.current.get(video.id) ?? now
        if (
          !ready &&
          element != null &&
          readyWhereItStands({
            waitedMs: now - since,
            readyState: element.readyState,
            aheadSec: bufferOf(element).aheadSec,
            alone
          })
        ) {
          ready = true
        }
        if (ready) shortSince.current.delete(video.id)
        else if (!shortSince.current.has(video.id)) {
          shortSince.current.set(video.id, now)
        }
        return {
          id: video.id,
          ready,
          waitingSinceMs: shortSince.current.get(video.id) ?? now
        }
      })
      const out = toLeaveOut(waits, now)
      for (const id of out) {
        leftOut.current.add(id)
        shortSince.current.delete(id)
      }
      if (out.length > 0) showLeftOut()
      if (!waits.every(wait => wait.ready || out.includes(wait.id))) {
        return false
      }
      // From where the heard tile actually is, which is never moved: starting
      // from the clock's last reading instead moved every tile on each
      // restart, and on a phone every move is a moment of buffering.
      const waited = awaited(instant, finished)
      const from = waited.find(video => video.id === heardId) ?? waited[0]
      const fromElement = from == null ? null : elements.current.get(from.id)
      const there =
        from == null || fromElement == null
          ? null
          : wallAt(from, fromElement.currentTime)
      // Never further than that, even for a tile released on its player's
      // word: right after a seek its picture still stands where the seek
      // came from, and starting from there undid the seek.
      const startAt =
        there != null && Math.abs(there - instant) < 3000 ? there : instant
      if (startAt !== instant) {
        atWallRef.current = startAt
        setAtWallMs(startAt)
      }
      flowing.current = true
      shortSince.current.clear()
      // A stall recorded while everybody was held is forgotten: what it
      // measured was the hold.
      setTiles(current => {
        if (Object.values(current).every(tile => tile.stalledSince == null)) {
          return current
        }
        const next: Record<string, TileState> = {}
        for (const [id, tile] of Object.entries(current)) {
          next[id] = { ...tile, stalledSince: null }
        }
        return next
      })
      frames.current.clear()
      setWaiting(false)
      alignTo(startAt, undefined, undefined, 'open')
      return true
    },
    [alignTo, awaited, heardId, placeHeld]
  )
  gateRef.current = gate

  /**
   * Stops the grid the moment a tile it waits for is about to run dry,
   * rather than letting that tile freeze on its own and the others play on
   * past it.
   */
  const dryCheck = useRef(() => {})
  dryCheck.current = () => {
    if (!playing || !flowing.current || slowFrame.current !== 0) return
    const instant = atWallRef.current
    if (instant == null) return
    const now = Date.now()
    const dry = awaited(instant).some(video => runningDry(video, now))
    if (!dry) return
    hold()
    setWaiting(anyPicture())
  }
  useEffect(() => {
    const timer = setInterval(() => {
      dryCheck.current()
    }, DRY_CHECK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])

  // The watchdog. Once a second, not once a frame: four tiles through Media
  // Source were measured holding to 17 ms of each other over ten minutes, so
  // there is nothing here to chase — and hls.js ignores ManagedMediaSource's
  // `endstreaming` while an element is seeking, so a busier loop would suppress
  // WebKit's own load shedding on a phone.
  //
  // Both this and the dry check run on one timer each, started once, that
  // calls the newest render's look through a ref. A timer remade whenever the
  // tiles, the gate or the angles change was put back to a full second each
  // time — and after a scrub they change several times a second, so for
  // seconds at a time nothing looked at all: no stall noticed, no tile put
  // back in step, no readout.
  const watchdog = useRef(() => {})
  watchdog.current = () => {
    // Nothing is inferred while slow motion is stepping the clock itself.
    if (slowFrame.current !== 0) return
    const now = Date.now()

    /** What each tile is doing, for `?debug=1`. */
    const showReadout = (clockMs: number, ceiling: number): void => {
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
          `to ${secondsAt(video, clockMs)?.toFixed(1) ?? '—'}  ` +
          `${element.paused ? 'paused' : 'playing'}  ${stalled}` +
          (tile?.parked != null ? `  parked ${tile.parked}` : '') +
          (leftOut.current.has(video.id) ? '  left out' : '') +
          // What the gate holds against it: how long it has been short,
          // where it was last sent, and what places it on the wall.
          (shortSince.current.has(video.id)
            ? `  short ${secondsSince(now, shortSince.current.get(video.id))}s`
            : '') +
          (heldPlace.current.has(video.id)
            ? `  sent ${heldPlace.current.get(video.id)?.toFixed(1)}`
            : '') +
          `  map ${mappingOfRef.current(video.id)?.source ?? 'none'}`
        )
      })
      const heard = chosen.find(video => video.id === heardId)
      const waits = [...shortSince.current.values()]
      lines.push(
        `clock ${((clockMs - (takeRef.current?.fromMs ?? clockMs)) / 1000).toFixed(1)}s  ` +
          `${flowing.current ? 'playing' : 'held'}  ahead ≤ ${ceiling.toFixed(0)}s` +
          (heard != null ? `  heard ${names.get(heard.id) ?? heard.id}` : '') +
          (flowing.current
            ? ''
            : `  gate ${waits.length} short` +
              (waits.length > 0
                ? ` ${secondsSince(now, Math.min(...waits))}s`
                : ''))
      )
      setReadout(lines)
    }

    // A tile that has stopped moving on its own. By the clock, never by the
    // `waiting` event, which fires on every seek this view makes on purpose
    // — and never before a tile has any pictures at all, because a tile that
    // is still opening its source has not stalled, it has not started.
    const finishedNow = new Map<string, boolean>()
    /** Which tiles this tick found stuck, before React has re-rendered. */
    const stuckNow = new Map<string, boolean>()
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
      stuckNow.set(video.id, stalled)
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

    // A live grid opens behind the newest footage its tiles have
    // (`liveOpeningMs`), once they have pictures and a mapping to say where
    // that is.
    if (atWallRef.current == null) {
      // Every live angle that may yet play, the ones still being asked
      // for included: the opening waits for them (`LIVE_OPEN_WAIT_MS`).
      // And only once each has a picture: before it, a player can say little
      // about where its footage ends. A move or the bar does not wait for
      // that, since a seek out of what they hold takes every tile's picture
      // away at once while their footage is no less there.
      const at = chosen
        .filter(video => video.status === 'live' && urls[video.id] !== null)
        .map(video =>
          (elements.current.get(video.id)?.readyState ?? 0) < HAVE_CURRENT_DATA
            ? null
            : newestWallOf(video)
        )
      if (liveSince.current == null && at.some(one => one != null)) {
        liveSince.current = now
      }
      const opening = liveOpeningMs(at, now - (liveSince.current ?? now))
      if (opening != null) {
        atWallRef.current = opening
        setAtWallMs(opening)
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
      if (stalledSince != null && holdExpired(now - stalledSince)) return false
      // And showing *this* moment. A tile still sitting at its own zero —
      // freshly attached, or one the alignment has not reached yet — is not
      // the truth about where the game is; it is the thing to be corrected.
      const there = wallAt(tile.video, tileElement.currentTime)
      return (
        there != null && (instant == null || Math.abs(there - instant) < 2000)
      )
    })

    const leader = masterOf(showing, heardId)
    if (leader != null) setMasterId(leader)
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

    // A tile that was left out joins in once it holds enough where the game
    // is now.
    let rejoined = false
    for (const id of [...leftOut.current]) {
      const video = chosen.find(one => one.id === id)
      const ready =
        video != null &&
        instant != null &&
        isReady(bufferAt(video, elements.current.get(id), instant))
      if (video != null && !ready) continue
      leftOut.current.delete(id)
      rejoined = true
    }
    if (rejoined) showLeftOut()

    /**
     * Waiting: a tile the grid waits for is short of pictures, or somebody's
     * camera covers this moment and none of them is managing to draw it.
     *
     * Said out loud, because still pictures with no explanation is the state
     * a viewer cannot diagnose. And **held**, every tile where it is, until
     * every one of them holds a few seconds (`buffering.ts`). Letting them
     * go the moment each had its next frame started them with nothing in
     * hand, so the first to run dry stopped them all again a moment later:
     * a stutter that never settled.
     */
    const waitingNow = playing && covering.length > 0 && showing.length === 0
    if (playing && instant != null) {
      const dry = awaited(instant, finishedNow).some(video =>
        runningDry(video, now)
      )
      if (flowing.current && (waitingNow || dry)) hold()
      if (!flowing.current) {
        if (gate(instant, finishedNow)) return
        hold()
        setWaiting(anyPicture())
        if (debug) showReadout(instant, AHEAD_SEC)
        return
      }
    }
    setWaiting(false)

    if (wallMs == null) return

    // Ended is a property of the moment as well as of the tiles: at the end
    // of the take with nothing playing, the game is over whether the tiles
    // call themselves ended or merely parked.
    const end = takeRef.current?.toMs
    setEnded(
      everythingEnded(placeables()) ||
        (showing.length === 0 && end != null && wallMs >= end - 1000)
    )

    if (debug) showReadout(wallMs, AHEAD_SEC)

    setAtWallMs(wallMs)
    // A master that has stopped drawing is not a clock to pull everybody
    // back to. Aligning to it put the others back a second on every tick
    // until it was handed over — three healthy pictures jerking backwards
    // for the one that was stuck. They play on instead, and are put back on
    // it in one step when it moves again, or follow whoever takes over.
    const leaderStuck = leader != null && stuckNow.get(leader) === true
    if (!leaderStuck) alignTo(wallMs, undefined, undefined, 'settle')
  }
  useEffect(() => {
    const timer = setInterval(() => {
      watchdog.current()
    }, WATCHDOG_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])

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

  /**
   * The furthest a live take may be moved to: where a live viewer plays,
   * `LIVE_DELAY_SEC` behind the newest footage of its slowest angle
   * (`liveOpeningMs`). Only the angles the grid plays count, as at the
   * opening: one it has no address for, one left out, or one with no picture
   * yet would hold every other angle back at its own last footage. Null for
   * a take with nothing live, or none that can say yet.
   */
  const livePointMs = (): number | null => {
    // Only angles with an address that are not left out: none still being
    // asked for, which the opening waits for and a move need not. And none
    // whose newest footage the grid has already played past: a camera that
    // has stopped sending, though still listed live, is parked there and
    // would otherwise hold every other angle back at its last picture.
    const here = gameNowRef.current('') ?? atWallRef.current
    const at = chosenRef.current
      .filter(
        video =>
          video.status === 'live' &&
          urls[video.id] != null &&
          !leftOut.current.has(video.id)
      )
      .map(newestWallOf)
      .filter(newest => newest == null || here == null || newest >= here)
    return liveOpeningMs(at, Number.POSITIVE_INFINITY)
  }
  const livePointRef = useRef(livePointMs)
  livePointRef.current = livePointMs

  /**
   * A seek the viewer asked for: every tile, at once, to one instant.
   *
   * A step within what the tiles already hold plays straight on. One beyond
   * it holds the grid until every tile has filled at the new place, rather
   * than starting each the moment it has a frame.
   */
  const goTo = useCallback(
    (asked: number): void => {
      // A drag or a tap at the end of a live bar lands at the live point:
      // the newest pictures are still arriving, and asked for, every angle
      // would wait for them. Never behind where the grid already is, though:
      // the live point moves a segment at a time, and an angle whose camera
      // has just gone holds it still while the pictures play on, so a move
      // forward from there would have jumped back.
      const limit = livePointRef.current()
      const here = gameNowRef.current('') ?? atWallRef.current
      const wallMs =
        limit == null || asked <= limit
          ? asked
          : Math.max(limit, Math.min(asked, here ?? limit))
      atWallRef.current = wallMs
      setAtWallMs(wallMs)
      shortSince.current.clear()
      if (flowing.current) {
        const held = awaited(wallMs).map(video =>
          bufferAt(video, elements.current.get(video.id), wallMs)
        )
        if (!canStart(held)) flowing.current = false
      }
      alignTo(wallMs)
    },
    [alignTo, awaited]
  )

  // A drag's seeks, coalesced; the newest `goTo` is the one they make.
  const goToRef = useRef(goTo)
  goToRef.current = goTo
  const scrubber = useMemo(
    () =>
      scrubSeeks(wallMs => {
        goToRef.current(wallMs)
      }),
    []
  )
  useEffect(
    () => () => {
      scrubber.cancel()
    },
    [scrubber]
  )
  const scrub = useCallback(
    (wallMs: number, final = true): void => {
      if (final) {
        scrubber.end(wallMs)
        return
      }
      // The playhead goes with the finger; the pictures follow at their pace.
      atWallRef.current = wallMs
      setAtWallMs(wallMs)
      scrubber.move(wallMs)
    },
    [scrubber]
  )

  const toggle = useCallback((): void => {
    // Stopped where the pictures stop: the clock's last reading is up to a
    // second behind a playing tile, and a skip from it after the pause landed
    // short by that much.
    if (playingRef.current) {
      const there = gameNowRef.current('')
      if (there != null) {
        atWallRef.current = there
        setAtWallMs(there)
      }
    }
    setPlaying(current => {
      const next = !current
      for (const video of chosen) {
        const element = elements.current.get(video.id)
        if (element == null) continue
        if (tiles[video.id]?.parked != null) continue
        // A grid that is still filling, or a tile left out, plays when the
        // watchdog lets it.
        const run = next && flowing.current && !leftOut.current.has(video.id)
        intents.current.set(video.id, run)
        if (run) playTile(element)
        else element.pause()
      }
      return next
    })
  }, [chosen, playTile, tiles])

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
    // From where the pictures are. The watchdog last set the clock up to a
    // second ago, and a crawl begun from there put every tile back by however
    // far it had played since: a visible step back as the hold took.
    atWallRef.current = gameNowRef.current('') ?? atWallRef.current
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
      // From where the pictures are, as a crawl begins: the clock was last
      // set up to a second ago, and a skip from it landed short by that much.
      const from = gameNowRef.current('') ?? atWallRef.current
      goTo(from + deltaSec * 1000)
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

  /** The tile a press is carrying, for the views to draw it picked up. */
  const [armedTile, setArmedTile] = useState<number | null>(null)
  /** The bar's track, in px; the window's width until it has said. */
  const trackWidth = useRef<number | null>(null)
  const setTrackWidth = useCallback((px: number): void => {
    trackWidth.current = px > 0 ? px : null
  }, [])

  /** Stops a press's timer and any scrub frame it has waiting. */
  const settlePress = (state: Press): void => {
    if (state.timer != null) clearTimeout(state.timer)
    state.timer = null
    if (state.frame !== 0) cancelAnimationFrame(state.frame)
    state.frame = 0
  }

  /**
   * A finger has come down. False when it is to be ignored, because another
   * finger is holding a crawl.
   *
   * Every finger reaches this one press, so it is kept by pointer. A second
   * finger used to replace the first outright: the crawl the first was holding
   * then never saw its finger lift and ran on for good, and the second
   * finger's lift was taken for a tap. Any other press is given up to the
   * newer finger, which is the one the viewer is thinking about.
   */
  const pressStart = (
    pointerId: number,
    x: number,
    y: number,
    tile: number | null
  ): boolean => {
    const current = press.current
    if (current?.mode === 'held' && current.pointerId !== pointerId) {
      return false
    }
    if (current != null) {
      // A scrub given up where it had got to.
      if (current.scrubTo != null) goTo(current.scrubTo)
      settlePress(current)
    }
    setArmedTile(null)
    const state: Press = {
      pointerId,
      x0: x,
      y0: y,
      tile,
      // From where the pictures are, as a skip or a crawl begins: the clock's
      // last reading is up to a second behind, and a scrub from it stepped
      // every tile back before it moved them.
      startWall: gameNowRef.current('') ?? atWallRef.current,
      mode: 'pending',
      timer: null,
      travelled: false,
      scrubTo: null,
      frame: 0
    }
    // Still for `HOLD_MS`: a crawl on the +10 s square (`gestureAction`), a
    // tile picked up anywhere else when there are others to swap it with.
    // Otherwise it stays a press whose lift, still under the slop, is a tap.
    state.timer = setTimeout(() => {
      state.timer = null
      if (press.current !== state || state.mode !== 'pending') return
      const zone = angleZoneFor(state.x0, state.y0, width, height)
      if (
        zone !== 'controls' &&
        gestureAction(zone, 'hold') === 'slowForward'
      ) {
        // Held only if this press started the crawl. One already running —
        // an arrow key held down — belongs to its key, and lifting this
        // finger must not end it.
        state.mode = beginSlow() ? 'held' : 'dead'
        return
      }
      if (state.tile != null && chosen.length > 1) {
        state.mode = 'reorder'
        setArmedTile(state.tile)
      }
    }, HOLD_MS)
    press.current = state
    return true
  }

  /** The press this pointer is making, if it is the one being followed. */
  const pressOf = (pointerId: number): Press | null =>
    press.current?.pointerId === pointerId ? press.current : null

  /**
   * The finger has moved. Before `HOLD_MS`, a move of `STILL_FRACTION` of the
   * width is a drag: sideways from the middle it scrubs, otherwise it is
   * nothing. A scrub moves the playhead at `SCRUB_RATE` of the bar's own rate,
   * once a frame, and leaves playing or paused as it was.
   */
  const pressMove = (pointerId: number, x: number, y: number): void => {
    const state = pressOf(pointerId)
    if (state == null) return
    const dx = x - state.x0
    const dy = y - state.y0
    if (beyondSlop(dx, dy)) state.travelled = true
    if (state.mode === 'pending') {
      if (Math.hypot(dx, dy) < STILL_FRACTION * width) return
      // Its timer runs until `HOLD_MS`; a press still past that scrubs no more.
      const early = state.timer != null
      settlePress(state)
      const fromMiddle =
        state.x0 >= SCRUB_EDGE_FRACTION * width &&
        state.x0 <= (1 - SCRUB_EDGE_FRACTION) * width
      state.mode =
        early &&
        fromMiddle &&
        Math.abs(dx) > Math.abs(dy) &&
        state.startWall != null
          ? 'scrub'
          : 'dead'
    }
    if (state.mode !== 'scrub' || state.startWall == null) return
    const take = takeRef.current
    const span = take == null ? 0 : take.toMs - take.fromMs
    const track = trackWidth.current ?? width
    if (take == null || track <= 0) return
    state.scrubTo = Math.min(
      take.toMs,
      Math.max(
        take.fromMs,
        state.startWall + ((dx * span) / track) * SCRUB_RATE
      )
    )
    showBar()
    if (state.frame !== 0) return
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      if (state.scrubTo != null) scrub(state.scrubTo, false)
    })
  }

  /**
   * The finger has come up: a crawl ends, a scrub lands, and a press that
   * never became anything and stayed under the slop is a tap.
   */
  const pressEnd = (
    pointerId: number,
    x: number,
    y: number
  ): PressMode | null => {
    const state = pressOf(pointerId)
    if (state == null) return null
    // Inside the touch, which is the one moment iOS lets the sound back on:
    // unmuted any other time, a playing video is paused instead.
    if (soundBlockedRef.current) {
      const heard = heardId == null ? null : elements.current.get(heardId)
      if (heard != null) heard.muted = false
      soundBlockedRef.current = false
      setSoundBlocked(false)
    }
    press.current = null
    settlePress(state)
    setArmedTile(null)
    if (state.mode === 'held') endSlow()
    if (state.mode === 'scrub' && state.scrubTo != null) scrub(state.scrubTo)
    if (state.mode === 'pending' && !state.travelled) {
      runZoneRef.current(angleZoneFor(x, y, width, height))
    }
    return state.mode
  }

  const pressCancel = (pointerId: number): void => {
    const state = pressOf(pointerId)
    if (state == null) return
    press.current = null
    settlePress(state)
    setArmedTile(null)
    if (state.mode === 'held') endSlow()
  }

  useEffect(() => {
    return () => {
      if (press.current != null) settlePress(press.current)
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

  // A live take has no end of its own: it ends at the newest footage any of
  // its angles has, which grows as they stream, from the first picture of the
  // first camera at 0. Held at the moment the viewer had reached, the bar
  // could only ever go back: dragging it forward reached nothing, and a
  // viewer who had fallen behind could not get back to live. A finished take
  // has none: letting the clock extend the window made the total in the
  // corner of the bar grow by a second every time it was watched to the end.
  const anyLive = chosen.some(video => video.status === 'live')
  // Each angle read as the live point reads it (`newestWallOf`): by its
  // mapping, or its player's seekable end where it has none, as a phone's
  // tile before the server's timeline arrives.
  const newest = anyLive
    ? chosen
        .filter(video => video.status === 'live')
        .map(newestWallOf)
        .reduce<number | null>(
          (most, one) => (one == null ? most : Math.max(most ?? one, one)),
          null
        )
    : null
  const played = anyLive ? atWallMs : null
  const liveEnd =
    newest != null && played != null
      ? Math.max(newest, played)
      : (newest ?? played ?? undefined)
  const take = windowOf(chosen, liveEnd)
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

  /**
   * What a browser tile's source is told: load `AHEAD_SEC` ahead, as every
   * player does.
   */
  const bufferFor = useCallback(
    (_id: string): PlayIntent['buffer'] => ({ aheadSec: AHEAD_SEC }),
    []
  )

  return {
    chosen,
    names,
    urls,
    tiles,
    playing,
    atWallMs,
    masterId,
    elementOf: (id: string) => elements.current.get(id),
    readout,
    ended,
    waiting,
    soundBlocked,
    soundHeld: (id: string): void => {
      // The heard angle now: a tile's prime calls this from the render that
      // attached it, and the viewer may have chosen another since.
      if (id !== heardRef.current) return
      soundBlockedRef.current = true
      setSoundBlocked(true)
    },
    heardId,
    rects,
    zoomed,
    shownRects,
    take,
    slow,
    flash,
    barShown,
    controlsShown: barShown || flashing,
    drag,
    intents,
    takeElement,
    attaching,
    attached,
    askAgain,
    toggle,
    skip,
    goTo,
    scrub,
    showBar,
    beginSlow,
    endSlow,
    runZone,
    takeMapping,
    pressStart,
    pressMove,
    pressEnd,
    pressCancel,
    armedTile,
    setTrackWidth,
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
    wallNow: (): number | null => gameNowRef.current('') ?? atWallRef.current,
    tileWaiting: (id: string): boolean =>
      outIds.has(id) ||
      (tiles[id]?.stalledSince != null &&
        holdExpired(Date.now() - (tiles[id]?.stalledSince ?? 0))),
    bufferFor
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

/** The stretches a tile holds, in order; none where its player does not say. */
function heldRanges(element: TileHandle): Array<[number, number]> {
  const ranges = element.buffered
  if (ranges == null) return []
  const held: Array<[number, number]> = []
  for (let index = 0; index < ranges.length; index++) {
    held.push([ranges.start(index), ranges.end(index)])
  }
  return held
}

/** Seconds of stream ahead of where a tile is playing (`heldAhead`). */
function bufferAhead(element: TileHandle, at = element.currentTime): number {
  return heldAhead(heldRanges(element), at)
}

/**
 * A live tile's newest footage, in its own seconds, by its mapping onto the
 * wall clock; null for a recording, or a tile whose mapping cannot say.
 */
function newestSecOf(video: VideoSummary & AngleVideo): number | null {
  if (video.status !== 'live') return null
  const mapping = video.clock?.()
  const newest = mapping?.newestWall()
  return mapping == null || newest == null ? null : mapping.secAt(newest)
}

/**
 * What a tile has in hand, measured from `atSec` — where it is playing, unless
 * the caller is about to put it somewhere else.
 *
 * A tile with no element has nothing; one whose player does not say how much
 * it holds (a phone's) answers with its `readyState` alone.
 */
function bufferOf(element: TileHandle | undefined, atSec?: number): TileBuffer {
  if (element == null) return { aheadSec: 0, leftSec: null, readyState: 0 }
  const at = atSec ?? element.currentTime
  const end = mediaLengthOf(element)
  // A place past what can be sought to holds nothing, and is not a tile at
  // the end of everything there is: it is not ready.
  if (end != null && at > end + SEEKABLE_SLACK_SEC) {
    return { aheadSec: 0, leftSec: null, readyState: element.readyState }
  }
  return {
    aheadSec: element.buffered == null ? null : bufferAhead(element, at),
    leftSec: end == null ? null : Math.max(0, end - at),
    readyState: element.readyState
  }
}

/** What a tile holds at the place the game is, at this instant. */
function bufferAt(
  video: VideoSummary,
  element: TileHandle | undefined,
  instant: number
): TileBuffer {
  const target = secondsAt(video, instant)
  return bufferOf(element, target != null && target >= 0 ? target : undefined)
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
