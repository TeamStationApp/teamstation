import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import {
  asGameDetail,
  type BoxScore as BoxScoreData,
  type GameDetail,
  type Highlight,
  type LineScoreSide,
  type Playback,
  type TeamStationClient,
  type TeamSummary,
  type VideoSummary
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { eventName } from '../../common/eventInfo'
import { eventHeroLines, viewerTimezone } from '../../common/eventTime'
import type { GameSocket } from '../../common/gameSocket'
import type { Side } from '../../common/scoring/state'
import type { WallTimeline } from '../../common/wallTimeline'
import {
  AnglePickerModal,
  AnglesUnavailableModal,
  Card,
  GameHeroCard,
  GlassView,
  HandoffView,
  LivePill,
  PillTabs,
  Screen,
  SettingsGear,
  type TeamStatLine,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
  usePaneWidth,
  VideoPoster
} from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { ContentInsetContext, NO_INSET } from '../components/contentInset'
import { EventTagText } from '../components/EventTagText'
import {
  CardBand,
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import { useScreenBottom } from '../components/Screen'
import { usePinnedTabs } from '../components/usePinnedTabs'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useScreenScope } from '../hooks/useScreenScope'
import { highlightColumnsFor } from '../layout/grid'
import { watchLayout, type WatchMode } from '../layout/watch'
import { lstrings } from '../locales/strings'
import type { PlayerFrom } from '../navigation/gameAngles'
import { useInsets } from '../platform/safeArea'
import { landingSec, sameMoment, switchTarget } from '../player/angleSwitch'
import { attachHls } from '../player/attachHls'
import { playerEngine } from '../player/engine'
import { seekTo } from '../player/explicitSeek'
import { livePlaybackRetryDelay } from '../player/liveRejoin'
import { multiAngleSupported } from '../player/multiCam/support'
import { angleLabels, defaultAngles } from '../player/multiCam/takes'
import { MultiCamView } from '../player/MultiCamView'
import { playableHere } from '../player/playable'
import { PlayerSurface } from '../player/PlayerSurface'
import { pictureRect } from '../player/scoreboardOverlay/overlayLayout'
import { isStillLive } from '../player/stillLive'
import { useVideoAspect } from '../player/useVideoAspect'
import {
  openingVideo,
  sameVideos,
  useVideoListRefresh
} from '../player/useVideoListRefresh'
import {
  HAVE_METADATA,
  seekableEndOf,
  type VideoHandle
} from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import {
  placedAlone,
  resumeSecondsAt,
  wallAt,
  windowOf
} from '../player/wallClock'
import {
  fromAnchors,
  fromMedia,
  fromStart,
  MAPPING_WAIT_MS,
  type WallMapping
} from '../player/wallMapping'
import type { GameRecording } from '../stream/gameRecording'
import { StreamFooter } from '../stream/StreamFooter'
import { useGameRecording } from '../stream/useGameRecording'
import { gameKey } from '../sync/documentKeys'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { BoxScore } from './BoxScore'
import { EventInfoTab } from './EventInfoTab'
import { defaultEventTab, eventEndTime } from './eventTabPolicy'
import { gameStatusLine, winnerOf } from './format'
import { gameActions, gameTabs, heroCoachSides } from './gameTabs'
import { GameWatchLayout } from './GameWatchLayout'
import { watchHandoff } from './gameWatchLayoutProps'
import { showVideoLivePill } from './livePillPolicy'
import { MembershipAccess } from './MembershipAccess'
import { openableTeams as teamsWithAPage } from './openableTeams'
import { VideoMembershipSheet } from './VideoMembershipSheet'

export interface GamePlaybackReturn {
  videoId: string
  at: number
  autoPlay: boolean
}

/**
 * The longest the picture is covered on its way back from full screen: past
 * the resume's own wait for a mapping, and then the seek.
 */
const UNCOVER_MS = 6000

/** How far past the seekable end a resume may still be sought to. */
const SEEKABLE_SLACK_SEC = 0.25

export interface GameScreenProps {
  client: TeamStationClient
  gameId: string
  signedIn?: boolean
  onSignIn?: () => void
  socket?: Pick<GameSocket, 'subscribe'>
  /** Opens the scoring choices as a separate page, retaining the watched moment. */
  onScoreGame?: (resume?: GamePlaybackReturn) => void
  /** An embedded recording controller; otherwise use this device's camera. */
  recording?: GameRecording
  /**
   * Opens Coach Game on a team the viewer head-coaches. A head coach of both
   * teams picks one first.
   */
  onCoachGame?: (teamId: string) => void
  onDjGame?: () => void
  /** Opens the game's replay. */
  onReplay?: () => void
  /** Opens a separate scheduling settings screen for a participating team admin. */
  onSettings?: () => void
  /** An explicit section. Bare addresses use the event's current default. */
  initialTab?: Tab
  /** Start the video, silent, as the videos page's picture always plays. */
  autoPlay?: boolean
  /**
   * Tells the shell what this game is called once it is known.
   *
   * A game opened from a pasted link has no title to put in the header, so
   * without this the header read the literal word `Game` — which is what a
   * shared link showed anybody who followed it.
   */
  onTitle?: (title: string) => void
  /** Which of the game's videos to open, from the address. */
  initialVideoId?: string
  /** Where in it to start, in seconds, from the address. */
  startAtSec?: number
  /** Tells the shell where the reader now is, so the address can say so. */
  onMoment?: (videoId: string, atSec: number) => void
  /**
   * Tells the shell which half is showing.
   *
   * The `Box Score` button on the home card set this through the address and
   * the pill did not, so opening the box score from the button could be
   * linked and reloaded while opening it from the pill could not — the same
   * destination, two different addresses.
   */
  onTab?: (tab: Tab) => void
  /**
   * The angles showing at once, in the order they are laid out, from the
   * address. Empty or absent is the ordinary single player.
   */
  angles?: string[]
  /** Which angle is heard. */
  audioId?: string
  /** Tells the shell what the viewer has arranged, so the address can say so. */
  onAngles?: (next: {
    angles?: string[]
    /**
     * `null` clears it, `undefined` leaves it alone. Without the difference
     * there is no way to say "nothing is zoomed any more" — which made the
     * zoom a one-way door on a phone, where there is no address bar to edit.
     */
    audio?: string | null
    zoom?: string | null
    /**
     * Seconds into the take, for a link to a moment of the grid. `null`
     * clears it: beside `video=` the same parameter means seconds into one
     * file, so a take's moment left behind on a closed grid would seek the
     * single player to a number that means nothing in it.
     */
    at?: number | null
    /**
     * The videos page's picture the player is opened from, and where it was:
     * the player opens on that moment. `null` clears it, on the way out.
     */
    from?: PlayerFrom | null
    /**
     * `null`: the highlight `highlightUntil` asked for is done with — opened
     * in the full-screen player in the app, or, in a browser, left to the
     * picture, which plays from it.
     */
    highlightUntil?: null
  }) => void
  /** Where the open player was opened from (`onAngles`'s `from`). */
  from?: PlayerFrom
  /**
   * A highlight chosen on another page, ending here in `initialVideoId`'s
   * seconds. In the app, once that video can play, the full-screen player
   * opens on it at `startAtSec`, playing, and stops here — as a highlight
   * chosen on this page does. In a browser it plays in the picture from
   * `startAtSec`, which the page does for any moment, and is dropped.
   */
  highlightUntil?: number
  /** Opens one of the two teams, from its name or its mark on the card. */
  onOpenTeam?: (team: TeamSummary) => void
  /** Opens one player, from their line in the box score. */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
}

type Tab = 'info' | 'boxScore' | 'watch'

/**
 * What each of a game's videos is called on the strip under the picture.
 *
 * Never its file name. `2026-05-16 Hawks vs Bay Stars raw` is a file on a
 * disk, not a thing a parent would say. The names come from what a take's
 * videos share: strip the words they all begin with and what is left is the
 * camera — `3rd`, `home`, `Behind the plate` — and the one with nothing left
 * is the program output. A mosaic is named for what it is.
 */
function angleNames(videos: VideoSummary[]): Map<string, string> {
  const labels = angleLabels(
    videos.map(video => ({
      id: video.id,
      title: video.title,
      status: video.status,
      numCameras: video.numCameras,
      durationSec: video.durationSec
    }))
  )
  return new Map(
    labels.map(label => [
      label.id,
      label.mosaic ? lstrings.video_multi_angle : label.name
    ])
  )
}

function teamStatsOf(
  linescore: GameDetail['linescore']
): { away: TeamStatLine | null; home: TeamStatLine | null } | null {
  if (linescore == null) return null
  const side = (
    own: LineScoreSide,
    other: LineScoreSide
  ): TeamStatLine | null => {
    if (own.h == null || own.bb == null || own.k == null || own.hr == null) {
      return null
    }
    return {
      h: own.h,
      bb: own.bb,
      k: own.k,
      hr: own.hr,
      e: own.e ?? 0,
      kDef: other.k ?? 0
    }
  }
  return {
    away: side(linescore.away, linescore.home),
    home: side(linescore.home, linescore.away)
  }
}

/**
 * One side of the score, as the header draws it: the name, cut with an
 * ellipsis, and the number hard against the right.
 *
 * Fixed widths on both halves, so the block does not resize as the scroll
 * carries it in, and a 4 does not make the names wider than a 12 does.
 */
function ScoreRow(props: {
  name: string
  score: number | null
  theme: Theme
}): React.ReactElement {
  const { name, score, theme } = props
  const styles = getStyles(theme)
  return (
    <View style={styles.headerScoreRow}>
      <Text style={styles.headerScoreName} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.headerScoreValue}>{score ?? '–'}</Text>
    </View>
  )
}

/**
 * How wide the header's copy of the score is allowed to be.
 *
 * Half of an iPhone 16 Pro, and the same number of pixels on every device: a
 * block that took a share of the width put the score against the right edge of
 * a desktop, a foot from the names it belongs to. Fixed, the two stay together
 * and the names still have room for most of what a team is called.
 */
/**
 * The pill that is not a camera.
 *
 * A value no video id can collide with, because the strip's ids are video ids
 * and one of its entries is not a video at all.
 */
const ALL_ANGLES = '\u0000allAngles'

const HEADER_SCORE_WIDTH = 201

/** How long a chosen highlight's full account stays under the video. */
const DESCRIPTION_SECONDS = 90

/**
 * A highlight chosen in the app opens in the full-screen player, which closes
 * at its end; in a browser it plays in the page's own picture.
 */
function highlightOpensFullScreen(): boolean {
  return Platform.OS !== 'web'
}

/**
 * One game: its videos, the highlights under them, and the box score.
 *
 * A highlight is a **timestamp into the full video**, never a separate clip.
 * Pressing one seeks the player and keeps it playing.
 *
 * The video takes the whole width and the highlights go underneath it. They
 * used to share the width on a wide window, which put the one thing the screen
 * exists for into a column with something else beside it.
 *
 * The player does not scroll. It is pegged above a list that does, so reading
 * to the bottom of a long game does not take the video off the screen.
 */
export function GameScreen(props: GameScreenProps): React.ReactElement {
  const {
    client,
    gameId,
    initialTab,
    autoPlay = false,
    onTitle,
    initialVideoId,
    startAtSec,
    onMoment,
    onTab,
    angles,
    audioId,
    onAngles,
    from,
    onOpenTeam,
    onOpenPlayer
  } = props
  const deviceRecording = useGameRecording(client, gameId)
  const recording = props.recording ?? deviceRecording
  const theme = useTheme()
  const styles = getStyles(theme)
  // The pane's width, which beside Tess's chat is less than the window's.
  const { height } = useWindowDimensions()
  const width = usePaneWidth()
  /**
   * Nothing in a browser, and the reason a phone on its side used to break.
   *
   * `useWindowDimensions` reports the whole screen. On a phone held sideways
   * the camera housing takes about sixty points off one edge and the rounded
   * corner takes a little off the other, and the layout below is inset by
   * exactly that much — so the arrangement was being worked out for a width
   * the content never had. Two columns that fitted on paper did not fit on the
   * glass, the row wrapped, and the highlights ended up *underneath* the
   * pegged picture, showing as slivers past its left edge.
   *
   * On the web these are all zero (`app/web/index.html` deliberately does not
   * ask for `viewport-fit=cover`), so this line changes nothing there.
   */
  const insets = useInsets()
  // One measured number: the header overlays the content, so the card clears
  // it with padding and the pegged player sticks below it.
  const { headerHeight } = useHeaderSlot()
  const screenBottom = useScreenBottom()

  const requestedTab =
    initialTab ??
    (autoPlay ||
    initialVideoId != null ||
    startAtSec != null ||
    (angles?.length ?? 0) > 0
      ? 'watch'
      : undefined)
  const [tab, setTab] = useState<Tab>(requestedTab ?? 'info')
  const explicitSelection = useRef(requestedTab != null)
  useEffect(() => {
    explicitSelection.current = requestedTab != null
    setTab(requestedTab ?? 'info')
  }, [requestedTab, gameId])

  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [clockNow, setClockNow] = useState(Date.now)
  const [localTimezone, setLocalTimezone] = useState(viewerTimezone)
  const live = useRef(true)
  const currentGameId = useRef(gameId)
  currentGameId.current = gameId
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const gameRequest = useRef(0)
  /** Whether this game has been shown since it was opened. */
  const shown = useRef(false)
  const videoHints = useRef({ onTitle, initialVideoId })
  videoHints.current = { onTitle, initialVideoId }
  /** Shows `found`, unless a newer read of this game has started since. */
  const showGame = useCallback(
    (found: GameDetail, request: number): void => {
      if (
        !live.current ||
        currentGameId.current !== gameId ||
        request !== gameRequest.current
      )
        return
      setGame(found)
      shown.current = true
      setError(undefined)
      videoHints.current.onTitle?.(
        eventName(found) ?? `${found.awayTeamName} @ ${found.homeTeamName}`
      )
      setVideo(current =>
        current != null && found.videos.some(item => item.id === current.id)
          ? current
          : (found.videos.find(
              item => item.id === videoHints.current.initialVideoId
            ) ?? openingVideo(found.videos))
      )
    },
    [gameId]
  )
  const refreshGame = useCallback(async (): Promise<void> => {
    if (live.current && currentGameId.current === gameId)
      setLocalTimezone(viewerTimezone())
    const request = ++gameRequest.current
    try {
      showGame(await client.game(gameId), request)
    } catch (error) {
      if (
        live.current &&
        currentGameId.current === gameId &&
        request === gameRequest.current
      )
        throw error
    }
  }, [client, gameId, showGame])
  /** The game as the phone last stored it, until the read returns. */
  const paintGame = useCallback(async (): Promise<void> => {
    const request = ++gameRequest.current
    const stored = await client.cached(gameKey(gameId), asGameDetail)
    if (stored != null) showGame(stored, request)
  }, [client, gameId, showGame])
  /**
   * `refreshGame` once the event's scope allows: after its acknowledgement
   * when there is a socket, at once for a visitor with none. Failing before
   * the game was ever shown, the game is not found. Failing after, the
   * screen keeps what it shows through no signal or a server error, but not
   * the server saying the game is gone (404) or no longer this person's
   * (403): the phone's stored copy goes with it (`CachingClient`).
   */
  const loadGame = useCallback(async (): Promise<void> => {
    try {
      await refreshGame()
    } catch (error: unknown) {
      if (!live.current || currentGameId.current !== gameId) return
      const gone =
        error instanceof HttpError &&
        (error.code === 'notFound' || error.code === 'forbidden')
      if (!shown.current || gone) setError(lstrings.common_not_found)
    }
  }, [refreshGame, gameId])
  const readGame = useScreenScope(loadGame, client, paintGame)
  // A new game is read again from scratch; a socket arriving (a sign-in) is
  // not a new game.
  const readLatest = useRef(readGame)
  readLatest.current = readGame
  useForegroundRefresh(readGame)
  useEffect(() => {
    if (game == null) return
    if (game.eventKind === 'event') setTab('info')
    else if (!explicitSelection.current) setTab(defaultEventTab(game, clockNow))
  }, [game, clockNow, requestedTab])
  useEffect(() => {
    if (game == null) return
    const start = game.startAt == null ? NaN : Date.parse(game.startAt)
    const marks = [eventEndTime(game), Number.isFinite(start) ? start : null]
    const now = Date.now()
    if (marks.some(mark => mark != null && mark <= now && clockNow < mark)) {
      setClockNow(now)
      return
    }
    const pending = marks.filter(
      (mark): mark is number => mark != null && mark > now
    )
    if (pending.length === 0) return
    const next = Math.min(...pending)
    const timer = setTimeout(
      () => {
        setClockNow(Date.now())
      },
      Math.min(2147483647, next - now + 1)
    )
    return () => {
      clearTimeout(timer)
    }
  }, [game, clockNow])
  useEffect(() => {
    if (props.socket == null || game?.eventKind === 'event') return
    try {
      return props.socket.subscribe(gameId, event => {
        if (
          event.type === 'resync' ||
          (event.type === 'change' &&
            (event.kind === 'plays' || event.kind === 'game'))
        ) {
          // A play body is news of its own: read now, as before, without
          // waiting on the event's scope. The answer counts for the scope,
          // so its notice of the same commit reads the game no second time.
          readLatest.current.alongside(refreshGame).catch(() => undefined)
          setBox(undefined)
        }
      })
    } catch {
      // A host without a socket transport still receives foreground REST updates.
      return undefined
    }
  }, [props.socket, gameId, game?.eventKind, refreshGame])
  const [canManageSchedule, setCanManageSchedule] = useState(false)
  useEffect(() => {
    setCanManageSchedule(false)
  }, [gameId])
  useEffect(() => {
    let active = true
    const permission =
      game?.eventKind === 'event'
        ? client.eventInfo(gameId).then(info => info.canManage)
        : // A scorekeeper may swap home and away there, if nothing else.
          game?.canScore === true
          ? Promise.resolve(true)
          : client
              .gameScheduling(gameId)
              .then(state => state.withdrawTeamIds.length > 0)
    permission.then(
      allowed => {
        if (active) setCanManageSchedule(allowed)
      },
      () => {
        if (active) setCanManageSchedule(false)
      }
    )
    return () => {
      active = false
    }
  }, [client, gameId, game])
  const [video, setVideo] = useState<VideoSummary | undefined>(undefined)
  const [membershipWarning, setMembershipWarning] = useState(false)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [withheld, setWithheld] = useState<string | null>(null)
  const [dropped, setDropped] = useState(0)
  const [box, setBox] = useState<BoxScoreData | undefined>(undefined)
  // A head coach of both teams, choosing which to coach.
  const [choosingCoach, setChoosingCoach] = useState(false)
  /**
   * The two sides' teams, where they are ones that can actually be opened.
   *
   * Looked up ahead of the tap rather than on it: a name that answers a press
   * by doing nothing, a beat later, is worse than one that never answered. A
   * side missing from here is left un-pressable — an opponent from outside the
   * season has no page, and neither has a team in a season this person is not
   * in.
   */
  const [openableTeams, setOpenableTeams] = useState<Map<string, TeamSummary>>(
    () => new Map()
  )
  const [playback, setPlayback] = useState<Playback | undefined>(undefined)
  /**
   * Which video the current playback URL belongs to.
   *
   * Without this the resume after an angle switch was applied to the *old*
   * source: the video had already changed but its URL had not been fetched
   * yet, so the effect ran, seeked the source still attached, and cleared the
   * resume — and by the time the new one loaded there was nothing left.
   */
  const [playbackFor, setPlaybackFor] = useState<string | undefined>(undefined)
  /**
   * Bumped when the player gives up on the address it was given.
   *
   * A playback URL carries a token, and a token can run out or be made
   * worthless by the server restarting — during a live game, the moment that
   * happens every watching player stops. Asking again is the whole of the
   * cure, and this is what makes the asking happen.
   */
  const [addressAttempt, setAddressAttempt] = useState(0)
  const [activeEventId, setActiveEventId] = useState<string | undefined>()
  const [chosen, setChosen] = useState<Highlight | undefined>(undefined)
  /**
   * Where to pick up after the source changes, for an angle switch.
   *
   * Tagged with the video it belongs to. Without that it was applied to
   * whichever source happened to be attached — the *old* one, because the new
   * playback URL is fetched a moment later — and cleared, so by the time the
   * new video loaded there was nothing left to restore and it started at zero.
   */
  const [resumeAt, setResumeAt] = useState<
    | {
        videoId: string
        /** Seconds into the video, or */
        sec?: number
        /** the wall time to put it at, from the full-screen player. */
        wallMs?: number
        playing: boolean
      }
    | undefined
  >(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Open while saying the grid is not offered in this browser. */
  const [anglesUnavailable, setAnglesUnavailable] = useState(false)
  /** Open while somebody is choosing which angles to watch together. */
  const [picking, setPicking] = useState(false)

  /**
   * Whether the multi-camera view is up, and the single player is not.
   *
   * It is a state of this screen rather than a route of its own, because the
   * shell renders only the top of its stack: a pushed screen would unmount
   * this one, taking the `<video>` with it and stopping playback dead.
   */
  const engine = useMemo(() => playerEngine(), [])
  /** Whether this browser can play the video at all (`playable.ts`). */
  const playable = useMemo(() => playableHere(), [])
  /** "All angles": several at once. */
  const anglesOffered = multiAngleSupported(engine, 2)
  /**
   * A guest or somebody who is a member of neither team: the score, the line
   * score and the highlights' pictures, and not the video, the box score's
   * tables or the summary under the card, which are kept for members.
   * Nothing kept is asked for, so the page never meets the server's refusal.
   */
  const nonMemberView = game?.nonMemberView === true
  const showAngles =
    !nonMemberView &&
    angles != null &&
    angles.length > 0 &&
    multiAngleSupported(engine, angles.length)

  // The card's own content goes up into the header as the card scrolls away:
  // the away team over the home team, small, with their scores beside them.
  // The header carries nothing for this screen otherwise — the card says it
  // all while it is on the screen.
  // Half way down the card, because that is where the names and the scores
  // are: anchored at its bottom the copy arrived in the header well after the
  // words it copies had gone under it.
  const handoff = useHandoff(headerHeight, 0.5)
  /**
   * The full-width section band's height: the picture pegs below it and the
   * highlight column leaves the same room in portrait and landscape.
   */
  const [tabsHeight, setTabsHeight] = useState(0)
  const [sectionPillsHeight, setSectionPillsHeight] = useState(0)
  /**
   * How tall the camera-angle buttons are, so the picture can leave room.
   *
   * Measured rather than guessed at, because it is nothing at all on the games
   * with one camera and the picture on a phone held sideways has no height to
   * spare for a number that is wrong.
   */
  const [pickerHeight, setPickerHeight] = useState(0)
  /**
   * Whether the window is short, readable from a callback.
   *
   * The layout is worked out further down, after the video's shape is known,
   * so the scroll handler cannot close over it. A ref rather than state: it is
   * read on scroll and never rendered from.
   */
  const shortWindow = useRef(false)
  const progress = handoff.progress
  const pinnedHandoff = watchHandoff(handoff, shortWindow)
  const { pinned, selectTab } = usePinnedTabs({
    head: { headerHeight, handoff: pinnedHandoff },
    ready: game != null,
    tab,
    anchorOnRow: false
  })
  const headerScore = useMemo(
    () =>
      game == null ? null : game.eventKind === 'event' ? (
        <HandoffView progress={progress}>
          <Text style={styles.eventHeaderTitle}>{eventName(game)}</Text>
        </HandoffView>
      ) : (
        <HandoffView progress={progress} style={styles.headerScore}>
          <ScoreRow
            name={game.awayTeamName}
            score={game.awayScore}
            theme={theme}
          />
          <ScoreRow
            name={game.homeTeamName}
            score={game.homeScore}
            theme={theme}
          />
        </HandoffView>
      ),
    [game, progress, styles.headerScore, styles.eventHeaderTitle, theme]
  )
  useHeaderHandoff(headerScore)

  const playerRef = useRef<VideoHandle | null>(null)

  // The box takes the video's own shape, read from the file, so there is
  // nothing left over for a black bar to fill. Until the browser knows, 16:9.
  const aspect = useVideoAspect(playerRef, video?.id)
  const mode = useRef<WatchMode>('stacked')
  const layout = watchLayout({
    // The width the content actually gets, not the width of the screen.
    width: width - insets.left - insets.right,
    height,
    // The picture leaves room for the section pills pinned below the header.
    chromeHeight: headerHeight + tabsHeight,
    // Conditional actions must not feed back into the decision to show them.
    shortChromeHeight: headerHeight + sectionPillsHeight,
    // The camera-angle buttons are pegged with the picture and have to stay
    // on the screen with it. Twice the small space as well: `onLayout`
    // measures the card and not the margin above it, and the second keeps the
    // card's lower edge off the bottom of the window rather than on it.
    belowVideo:
      (game?.videos.length ?? 0) > 1
        ? pickerHeight + 2 * theme.rem(theme.spaceXsRem)
        : 0,
    aspect,
    previous: mode.current
  })
  mode.current = layout.mode
  const sideBySide = layout.mode === 'sideBySide'
  // A phone held sideways. The picture is as tall as the window allows and no
  // taller, so there is nothing under it to peg a description to.
  const short = layout.short
  shortWindow.current = short
  useEffect(() => {
    // A short window may never scroll at all — everything that moves is
    // inside the column — so the header is told once rather than waiting for
    // a hand-over that will not come. Turned upright again, the card is back
    // and the measurement decides, from where the page actually is.
    if (short) {
      progress.value = 1
      return
    }
    const frame = requestAnimationFrame(() => {
      handoff.handleScroll()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [handoff, progress, short])
  // From the list's own width, not the window's: beside the video the list is
  // 402px wide and takes one column, and asking the window would have given it
  // two squeezed into that.
  const columns = highlightColumnsFor(
    sideBySide ? layout.sideWidth : width - 2 * 16
  )

  /**
   * The same element, as state, so that a **new** one is an event.
   *
   * A ref changing is invisible to React, and the box score unmounts the
   * player: coming back mounted a fresh one with the same chosen video,
   * so the attach effect — which fires only when the source changes — never
   * ran and the new element was never handed a manifest. It sat at
   * `readyState 0` with no source, and a highlight tap moved its timecode and
   * reported itself playing, so nothing on screen said anything was wrong.
   *
   * Attaching when the element is new *as well as* when the source is keeps
   * both halves: the narrow rule that stopped the restarts, and a player that
   * works after every mount.
   */
  const [playerNode, setPlayerNode] = useState<VideoHandle | null>(null)
  const takePlayer = useCallback((node: VideoHandle | null): void => {
    playerRef.current = node
    setPlayerNode(node)
  }, [])
  /** So a link's moment is honoured once, not on every re-attach. */
  const startedFromLink = useRef(false)

  useEffect(() => {
    setGame(undefined)
    setVideo(undefined)
    setBox(undefined)
    setError(undefined)
    startedFromLink.current = false
    shown.current = false
    readLatest.current().catch(() => undefined)
    return () => {
      gameRequest.current++
    }
  }, [refreshGame])

  /** The videos the cameras panel has seen publishing on this game. */
  const [publishing, setPublishing] = useState<string[]>([])
  const gameIdRef = useRef(gameId)
  gameIdRef.current = gameId
  const refreshVideos = useCallback((): void => {
    const forGame = gameId
    client
      .game(forGame)
      .then(found => {
        if (gameIdRef.current !== forGame) return
        setGame(current =>
          current == null || sameVideos(current.videos, found.videos)
            ? current
            : { ...current, videos: found.videos }
        )
        // A page that had nothing to play opens on what there is now. One
        // already playing something is left on it, but takes that video's
        // fresh entry: a camera that ended reads as no longer live, and a
        // start the phone corrected is the one an angle switch maps through.
        setVideo(current => {
          if (current == null) return openingVideo(found.videos)
          const listed = found.videos.find(item => item.id === current.id)
          return listed == null || sameVideos([current], [listed])
            ? current
            : listed
        })
      })
      .catch(() => undefined)
  }, [client, gameId])
  useVideoListRefresh({
    videos: game?.videos,
    publishing,
    refresh: refreshVideos
  })

  const seasonId = game?.seasonId
  const awayTeamId = game?.awayTeamId
  const homeTeamId = game?.homeTeamId
  useEffect(() => {
    if (awayTeamId == null || homeTeamId == null) return
    let live = true
    const load = async (): Promise<void> => {
      // Both lists: your own teams, which you can always open, and the rest of
      // the season, which a season you are allowed to watch lets you open too.
      // An opponent from outside the season is in neither, which is the whole
      // point — it has no page.
      const lists = await Promise.all([
        client.teams().catch(() => []),
        seasonId == null
          ? Promise.resolve([])
          : client.seasonTeams(seasonId).catch(() => [])
      ])
      if (!live) return
      setOpenableTeams(teamsWithAPage(lists, [awayTeamId, homeTeamId]))
    }
    load().catch(() => undefined)
    return () => {
      live = false
    }
  }, [awayTeamId, client, homeTeamId, seasonId])

  // Keyed by the video's id, not its entry: a refresh that brings the same
  // video with a new status or start neither reloads its highlights nor
  // restarts its player.
  const videoId = video?.id
  const videoStatus = video?.status
  useEffect(() => {
    if (videoId == null) return
    let live = true
    client
      .highlights(videoId)
      .then(found => {
        if (!live) return
        setHighlights(found.highlights)
        setDropped(found.droppedCount)
        setWithheld(found.withheld)
      })
      .catch(() => {
        if (live) setHighlights([])
      })
    return () => {
      live = false
    }
  }, [client, videoId, addressAttempt])

  // The app never builds a media URL: the server knows where the video is and
  // checks membership while it looks, so asking is the only way to find out.
  /** How many times a live video without files has been asked for again. */
  const [playbackAsks, setPlaybackAsks] = useState(0)
  useEffect(() => {
    if (videoId == null || nonMemberView) return
    const forVideoId = videoId
    let live = true
    setPlayback(undefined)
    setPlaybackFor(undefined)
    // Each video's asks back off from the first wait, not from where the
    // last video's had got to.
    setPlaybackAsks(0)
    client
      .playback(forVideoId)
      .then(found => {
        if (!live) return
        setPlayback(found)
        setPlaybackFor(forVideoId)
      })
      .catch(() => {
        if (live) setPlayback(undefined)
      })
    return () => {
      live = false
    }
  }, [client, videoId, nonMemberView])

  // A live video is listed the moment its stream starts publishing, a few
  // seconds before its first segment is written, and until then the server
  // says its files are not there. The page that picked it up then — the
  // publishing phone's own, or a viewer's — asks again rather than saying
  // for good that the video is not available.
  useEffect(() => {
    if (
      videoId == null ||
      videoStatus !== 'live' ||
      playbackFor !== videoId ||
      playback == null ||
      playback.url != null
    )
      return
    // Backing off, and given up after ten minutes: a refused publish never
    // writes a segment.
    const wait = livePlaybackRetryDelay(playbackAsks)
    if (wait == null) return
    const forVideoId = videoId
    let live = true
    const askAgain = (): void => {
      if (live) setPlaybackAsks(asks => asks + 1)
    }
    const timer = setTimeout(() => {
      client
        .playback(forVideoId)
        .then(found => {
          if (!live) return
          if (found.url == null) askAgain()
          else setPlayback(found)
        })
        .catch(askAgain)
    }, wait)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, videoId, videoStatus, playback, playbackFor, playbackAsks])

  // Fetched when the tab is first opened, not with the game: most people come
  // here to watch, and the box score is a second query against every play.
  // After the game, too, which says whether this is a non-member's, whose
  // tables are kept for members.
  const gameLoaded = game != null
  useEffect(() => {
    if (tab !== 'boxScore' || box != null || !gameLoaded || nonMemberView)
      return
    let live = true
    client
      .boxScore(gameId)
      .then(rows => {
        if (live) setBox(rows)
      })
      .catch(() => {
        if (live) setBox({ batting: [], pitching: [], stats: undefined })
      })
    return () => {
      live = false
    }
  }, [box, client, nonMemberView, gameId, gameLoaded, tab])

  const playbackUrl = playback?.url ?? null

  /**
   * What the playhead should do the next time a source is attached.
   *
   * Refs, not dependencies, and that is the whole point. This lived in the
   * attach effect's dependency array and cost two bugs at once, because
   * re-running the effect calls `attachHls` again and an element handed a
   * fresh manifest goes back to zero:
   *
   * - Tapping a highlight writes `?t=` to the address, which comes back down
   *   as `startAtSec`. The first tap worked only by accident — it took the
   *   link branch below — and every tap after it re-attached the source and
   *   dropped the reader at the start of the game.
   * - The angle switch's own `setResumeAt(undefined)`, at the end of a
   *   successful resume, re-ran the effect and undid the resume it had just
   *   finished.
   *
   * Reading them through refs means the source is attached exactly when the
   * source changes, and nothing else can reach in and restart it.
   */
  const resumeAtRef = useRef(resumeAt)
  resumeAtRef.current = resumeAt
  /** The grid's ✕ closed it, so its going leaves the resume alone. */
  const closedByX = useRef(false)
  const startAtSecRef = useRef(startAtSec)
  startAtSecRef.current = startAtSec
  const autoPlayRef = useRef(props.autoPlay)
  autoPlayRef.current = props.autoPlay
  const placeFor = useRef<{
    video?: VideoSummary
    videoId?: string
    playbackFor?: string
    /** Asks the server, for a video that was live when it was opened. */
    isLive?: () => Promise<boolean>
  }>({})
  // The game's own copy of the row when it has one: the selected entry is a
  // snapshot, and a recording that has finished must not be watched as live.
  const freshStatus = (
    game?.videos.find(item => item.id === video?.id) ?? video
  )?.status
  placeFor.current = {
    video,
    videoId: video?.id,
    playbackFor,
    isLive:
      video != null && freshStatus === 'live'
        ? async () => await isStillLive(client, gameId, video.id)
        : undefined
  }

  /**
   * What the viewer wants the single player to be doing, and who paused it.
   *
   * The multi-camera view leaves this screen mounted, so the player behind it
   * has to be stood down — a fifth decoder and a fifth buffer on a phone is
   * the difference between four tiles playing and four tiles stuttering. It is
   * **not** done with a bare `pause()`: `attachHls` reads any pause it did not
   * cause as the viewer's, and would then refuse to resume this player after a
   * media error for the rest of the game. So the intent is injected and this
   * screen owns it.
   */
  const viewerWants = useRef(false)
  /**
   * The card plays silent until its own sound square turns it on — or, in a
   * browser, a highlight chosen here or on a player's page, which is heard as
   * the full-screen player it stands in for was.
   */
  const [cardSound, setCardSound] = useState(
    () => props.highlightUntil != null && !highlightOpensFullScreen()
  )
  /**
   * In a browser, a highlight chosen before the picture has its metadata:
   * where it lands once it has, which a seek made sooner may not have done.
   */
  const aimedAt = useRef<number | null>(null)
  /**
   * The card is on its way back from the full-screen player, to the moment
   * it left: covered until it lands there.
   */
  const [backFromGrid, setBackFromGrid] = useState(false)
  const suspended = useRef(false)
  suspended.current = showAngles
  /**
   * Where the single player had got to, sampled as it plays.
   *
   * Read from the element when the angles open, it was always zero: React runs
   * an effect's cleanup before the next effect's body, so the detach — which
   * resets the element — had already happened by the time anything asked. So
   * the position is kept as it goes, and the last one before the grid opened
   * is the one that comes back.
   */
  const lastTime = useRef(0)
  /** The picture's own mapping onto the wall clock, from its stream's dates. */
  const mappingRef = useRef<WallMapping | null>(null)
  /** The server's wall timeline for it, as its board has it. */
  const timelineRef = useRef<{
    videoId: string | undefined
    timeline: WallTimeline | null
  } | null>(null)
  /** A resume waiting on a mapping, to look again when one arrives. */
  const landRef = useRef<(() => void) | null>(null)
  const takeTimeline = useCallback((timeline: WallTimeline | null): void => {
    timelineRef.current = { videoId: placeFor.current.videoId, timeline }
    landRef.current?.()
  }, [])
  /**
   * The picture's best mapping onto the wall clock: the server's wall
   * timeline, then its stream's dates, then its start; a lone recording with
   * no start, its own media time.
   */
  const inlineMapping = (of: VideoSummary): WallMapping => {
    // A recording with no start is on its own media time, whatever dates
    // its stream carries: the full-screen player places it there too.
    if (of.startAt == null) return fromMedia()
    const held = timelineRef.current
    const anchors =
      held?.videoId === of.id ? (held.timeline?.anchors ?? []) : []
    // The server's wall timeline first, as the full-screen player places its
    // tiles: it follows the frames' own wall clocks, and the stream's dates
    // run seconds behind them on a live ingest.
    const player = playerRef.current
    return (
      (anchors.length > 0
        ? fromAnchors(anchors, () =>
            player == null ? null : seekableEndOf(player)
          )
        : null) ??
      mappingRef.current ??
      fromStart(of)
    )
  }

  useEffect(() => {
    const element = playerNode
    if (element == null) return
    const onTime = (): void => {
      if (!suspended.current && element.currentTime > 0) {
        lastTime.current = element.currentTime
      }
    }
    const onPlay = (): void => {
      viewerWants.current = true
    }
    const onPause = (): void => {
      if (!suspended.current) viewerWants.current = false
    }
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('play', onPlay)
    element.addEventListener('pause', onPause)
    return () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
    }
  }, [playerNode])

  // Uncovered once the picture is at that moment: the resume sets its time
  // and the player draws the frame there a moment later, when it says the
  // seek is done.
  useEffect(() => {
    if (!backFromGrid || resumeAt != null) return
    const element = playerNode
    const uncover = (): void => {
      setBackFromGrid(false)
    }
    // Gone already, or never on its way: nothing to wait for. A browser's
    // player says when its seek is done and over, and the event for it may
    // have come before this listened.
    if (
      element == null ||
      element.readyState < HAVE_METADATA ||
      (element as { seeking?: boolean }).seeking === false
    ) {
      uncover()
      return
    }
    // The phone's player can also land a seek through its progress, with no
    // `seeked`: its next time, with no seek in flight, says so.
    const landed = (): void => {
      if ((element as { seeking?: boolean }).seeking === false) uncover()
    }
    element.addEventListener('seeked', uncover)
    element.addEventListener('timeupdate', landed)
    return () => {
      element.removeEventListener('seeked', uncover)
      element.removeEventListener('timeupdate', landed)
    }
  }, [backFromGrid, resumeAt, playerNode])
  // And never longer than this from the close, whatever the resume does: one
  // that cannot land must not leave the card black.
  useEffect(() => {
    if (!backFromGrid) return
    const timer = setTimeout(() => {
      setBackFromGrid(false)
    }, UNCOVER_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [backFromGrid])

  useEffect(() => {
    const element = playerNode
    if (element == null || !showAngles || video == null) return
    // Where it had got to, so the re-attach on the way back picks it up. The
    // source itself is detached below — four tiles on a phone should not be
    // sharing the decoder with a fifth player nobody is looking at.
    setResumeAt({
      videoId: video.id,
      sec: lastTime.current,
      playing: viewerWants.current
    })
    element.pause()
    // Only as the overlay opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNode, showAngles])

  useEffect(() => {
    const element = playerNode
    // Nothing attached while the angles are up: the source, its worker and its
    // buffers go with it, and the resume written above brings the position
    // back when it returns.
    if (element == null || playbackUrl == null || showAngles) return
    mappingRef.current = null
    /** The stream has said it carries no dates, or has been given its time. */
    let datesDone = false
    /** And the server's wall timeline has had its time to arrive. */
    let timelineDone = false
    // The server's wall timeline is waited for first, then the stream's
    // dates, each for as long, from when the source is attached.
    const timelineTimer = setTimeout(() => {
      timelineDone = true
      landRef.current?.()
    }, MAPPING_WAIT_MS)
    const noDates = (): void => {
      if (datesDone) return
      datesDone = true
      clearTimeout(datesTimer)
      landRef.current?.()
    }
    const datesTimer = setTimeout(noDates, MAPPING_WAIT_MS)
    const detach = attachHls(
      element,
      playbackUrl,
      () => {
        setAddressAttempt(attempt => attempt + 1)
      },
      {
        wantsToPlay: () => !suspended.current && viewerWants.current,
        onWallMapping: mapping => {
          mappingRef.current = mapping
          if (mapping == null) noDates()
          else landRef.current?.()
        },
        isLive: placeFor.current.isLive,
        startAtLiveEdge:
          !(resumeAtRef.current?.videoId === placeFor.current.videoId) &&
          !(startAtSecRef.current != null && startAtSecRef.current > 0)
      }
    )

    const resume = resumeAtRef.current
    const { videoId, playbackFor: forId } = placeFor.current

    const stop = (): void => {
      clearTimeout(datesTimer)
      clearTimeout(timelineTimer)
      landRef.current = null
    }

    // Picking up where the other angle was, once the new source is attached.
    if (resume != null && resume.videoId === videoId && forId === videoId) {
      const placed = placeFor.current.video
      const wallMs = resume.wallMs
      if (wallMs != null && placed != null) {
        // A wall time: where it falls in this source is known once the source
        // says how it maps onto the wall clock — as `inlineMapping`, the
        // server's wall timeline, or that it has none, then its stream's
        // dates, then its start — and it is sought only once the footage
        // there can be sought to. The angle it came from was placed by its
        // timeline, and a live stream's dates run seconds behind its frames:
        // landing by them put a switch 4.5 s before the moment.
        const events = [
          'loadedmetadata',
          'progress',
          'durationchange',
          'timeupdate'
        ] as const
        const mapping = (): WallMapping | null => {
          const end = (): number | null => seekableEndOf(element)
          // As `inlineMapping`: no start, its own media time.
          if (placed.startAt == null) return fromMedia(end)
          const held = timelineRef.current
          const anchors =
            held?.videoId === placed.id ? (held.timeline?.anchors ?? []) : []
          if (anchors.length > 0) return fromAnchors(anchors, end)
          // A timeline that has answered with no anchors is not waited for.
          const answered = held?.videoId === placed.id && held.timeline != null
          if (!timelineDone && !answered) return null
          if (mappingRef.current != null) return mappingRef.current
          if (!datesDone) return null
          return fromStart(placed, end)
        }
        // Its metadata is in once it says so, whatever `readyState` reads.
        let metadata = element.readyState >= HAVE_METADATA
        const land = (): void => {
          if (!metadata) return
          const by = mapping()
          if (by == null) return
          let target =
            landingSec(placed, by, wallMs, placed.status === 'live') ??
            resumeSecondsAt(placed, wallMs, element.duration)
          // A recording ends where its file does, whatever its row says: a
          // moment past that lands on its last picture, rather than waiting
          // for footage that is never coming with the picture held still.
          if (
            placed.status !== 'live' &&
            Number.isFinite(element.duration) &&
            target > element.duration
          ) {
            target = element.duration
          }
          const seekable = seekableEndOf(element)
          if (seekable != null && target > seekable + SEEKABLE_SLACK_SEC) return
          for (const name of events) element.removeEventListener(name, land)
          element.removeEventListener('loadedmetadata', loaded)
          stop()
          // As the viewer's own seek, so nothing that joins a live stream at
          // its edge takes it back.
          seekTo(element, target)
          if (resume.playing) element.play().catch(() => undefined)
          setResumeAt(undefined)
        }
        const loaded = (): void => {
          metadata = true
          land()
        }
        landRef.current = land
        for (const name of events) element.addEventListener(name, land)
        element.addEventListener('loadedmetadata', loaded)
        land()
        return () => {
          for (const name of events) element.removeEventListener(name, land)
          element.removeEventListener('loadedmetadata', loaded)
          stop()
          detach()
        }
      }
      const apply = (): void => {
        element.currentTime =
          resume.sec ?? resumeSecondsAt(placed, resume.wallMs, element.duration)
        if (resume.playing) element.play().catch(() => undefined)
        setResumeAt(undefined)
      }
      stop()
      if (element.readyState >= HAVE_METADATA) apply()
      else element.addEventListener('loadedmetadata', apply, { once: true })
      return detach
    }
    stop()

    // A link to a moment: start there, and start playing, because that is
    // what the person who sent the link meant by sending it. An explicit
    // paused return from another page keeps that intent instead.
    // This run's own: a play refused after it has been stood down is not
    // this run's to answer.
    let current = true
    // Played as it is set to be heard; a browser that will not start it
    // with its sound (a refusal, not an interruption) gets it silent rather
    // than not at all.
    const play = (): void => {
      Promise.resolve(element.play()).catch((error: unknown) => {
        const refused =
          error instanceof Error && error.name === 'NotAllowedError'
        if (!refused || !current || element.muted) return
        element.muted = true
        setCardSound(false)
        element.play().catch(() => undefined)
      })
    }
    const stand = (): void => {
      current = false
      detach()
    }

    const linkAt = startAtSecRef.current
    if (linkAt != null && linkAt > 0 && !startedFromLink.current) {
      // Started once it has run: a source swapped before its metadata (an
      // address failing over) waits again for the next one's.
      const jump = (): void => {
        startedFromLink.current = true
        // A highlight chosen while it waited is where the viewer wants to
        // be, and lands there itself.
        if (aimedAt.current != null) return
        element.currentTime = linkAt
        if (autoPlayRef.current !== false) play()
      }
      if (element.readyState >= HAVE_METADATA) jump()
      else element.addEventListener('loadedmetadata', jump, { once: true })
      return () => {
        element.removeEventListener('loadedmetadata', jump)
        stand()
      }
    }

    if (autoPlayRef.current === true) {
      // Silent unless a highlight brought it here, which every browser lets
      // start on its own; heard, it falls back to silent if refused. If it
      // will not start at all, a tap opens the player, and saying so would
      // be noise.
      const start = (): void => {
        play()
      }
      element.addEventListener('loadedmetadata', start, { once: true })
      start()
      return () => {
        element.removeEventListener('loadedmetadata', start)
        stand()
      }
    }
    return stand
  }, [playbackUrl, playerNode, showAngles])

  /**
   * The other recording, from the same moment, still playing.
   *
   * Not a copy of `currentTime`: the two recordings do not have to have
   * started at the same instant, so the position is converted through wall
   * clock. The restore waits for `loadedmetadata` because a seek issued
   * before the manifest has loaded is silently ignored by some browsers.
   */
  const switchAngle = (next: VideoSummary): void => {
    const player = playerRef.current
    const current = video
    // The viewer has chosen another camera: a highlight still waiting to open
    // is not for it, nor for its own camera once they come back to it.
    if (props.highlightUntil != null && next.id !== current?.id)
      onAngles?.({ highlightUntil: null })
    if (player == null || current == null || next.id === current.id) {
      setVideo(next)
      // Public previews have no player, but their selected camera still belongs
      // in the address so sign-in can return to it.
      if (next.id !== current?.id) onMoment?.(next.id, 0)
      return
    }
    // Worked out before the swap, and handed to the effect that attaches the
    // new source. Listening for `loadedmetadata` here does not work: changing
    // the video re-runs `attachHls`, which resets the element *after* the
    // listener has fired, so the seek was being undone a moment later.
    // As a wall time, from this source's own mapping: where it falls in the
    // next one is known only once that one is attached. A recording with no
    // start, on either side, copies the position instead.
    const fromMapping = inlineMapping(current)
    const sec = sameMoment(current, next, player.currentTime, {
      from: fromMapping
    })
    const wallMs =
      current.startAt == null || next.startAt == null
        ? null
        : switchTarget(current, fromMapping, player.currentTime)
    setResumeAt(
      wallMs == null
        ? { videoId: next.id, sec, playing: !player.paused }
        : { videoId: next.id, wallMs, playing: !player.paused }
    )
    setVideo(next)
    // The address names the angle, so it has to follow the angle. Without
    // this it went on naming the one you switched away from, and copying the
    // link mid-game handed somebody a different camera.
    onMoment?.(next.id, Math.round(sec))
  }

  /**
   * The full-screen player, with this picture alone, at `sec` into it: the
   * videos page's picture has no controls of its own, and a tap on it is
   * what watching it means.
   */
  const openPlayer = (sec: number, untilSec?: number): void => {
    if (video == null) return
    // Its wall times by its own mapping, which knows where a stream's gaps
    // and discontinuities are, as its start time does not.
    const mapping = inlineMapping(video)
    onAngles?.({
      angles: [video.id],
      audio: video.id,
      zoom: null,
      at: null,
      from: {
        videoId: video.id,
        sec,
        wallMs: mapping.wallAt(sec),
        ...(untilSec == null
          ? {}
          : { untilSec, untilWallMs: mapping.wallAt(untilSec) })
      },
      highlightUntil: null
    })
  }

  const jumpTo = (highlight: Highlight): void => {
    if (nonMemberView) {
      setMembershipWarning(true)
      return
    }
    setActiveEventId(highlight.eventId)
    setChosen(highlight)
    // The address follows, so the moment somebody is looking at is the moment
    // they can send to somebody else.
    if (video != null)
      onMoment?.(video.id, Math.round(highlight.startOffsetSec))
    // The picture goes there too: in the app so it is there on the way back,
    // in a browser because that is where it is watched.
    const player = playerRef.current
    if (player != null) seekTo(player, highlight.startOffsetSec)
    // Only when it can play here at all, as the picture's own tap: otherwise
    // the player opens on a picture that can only say it cannot.
    if (playback?.url == null || !playable) return
    // In the app, watched in the full-screen player from the play on, which
    // closes at the highlight's end. In a browser, in the picture, where it is.
    if (highlightOpensFullScreen()) {
      openPlayer(highlight.startOffsetSec, highlight.endOffsetSec)
      return
    }
    // The viewer has chosen where to be: a re-attach later (an address
    // failing over) is not to send them back to a link's moment, this
    // highlight's included, once they have watched on.
    startedFromLink.current = true
    // Heard, as the full-screen player would have been: the sound goes on
    // inside the tap, the one moment a browser lets it start.
    setCardSound(true)
    if (player == null) return
    player.muted = false
    player.play().catch(() => undefined)
    // A seek made before the stream has said how long it is can be dropped:
    // made again, and played, once it has.
    if (player.readyState < HAVE_METADATA) {
      const at = highlight.startOffsetSec
      aimedAt.current = at
      const land = (): void => {
        if (aimedAt.current !== at) return
        aimedAt.current = null
        player.currentTime = at
        player.play().catch(() => undefined)
      }
      player.addEventListener('loadedmetadata', land, { once: true })
    }
  }

  // A highlight chosen on another page opens here straight into the player in
  // the app, once its video can play: the same open as one chosen in the
  // list. (In a browser the picture plays it from the moment, and it is dropped.)
  // Its end is in the seconds of the video it was chosen on, which is the
  // address's video as the page opened: another camera chosen before it can
  // play is another recording, and the highlight is not opened on it (and is
  // dropped, in `switchAngle`). A video the page itself paints first, from a
  // copy of the game that does not list it yet, only waits.
  const highlightUntil = props.highlightUntil
  const highlightVideo = useRef<string | undefined>(undefined)
  if (highlightUntil == null) highlightVideo.current = undefined
  else highlightVideo.current ??= initialVideoId
  useEffect(() => {
    if (highlightUntil == null || video == null || showAngles) return
    if (video.id !== highlightVideo.current) return
    if (playback?.url == null || !playable) return
    // The web plays it in the picture, which the page already opens at the
    // highlight and plays: there is no full screen to open, only the frame
    // to take it off — once its video is here, as the app's open is, and not
    // while the shell is still putting this page in the history, which an
    // update in place then would overwrite.
    if (!highlightOpensFullScreen()) {
      onAngles?.({ highlightUntil: null })
      return
    }
    openPlayer(startAtSec ?? 0, highlightUntil)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightUntil, video?.id, playback?.url, playable, showAngles])

  // The chosen play's full account clears itself a minute and a half after the
  // moment it seeks to — measured in **played** time, not wall clock. A timer
  // would run down while the video is paused and the description would be gone
  // by the time anybody looked back at it.
  useEffect(() => {
    const player = playerRef.current
    if (player == null || chosen == null) return
    const onTime = (): void => {
      const since = player.currentTime - chosen.startOffsetSec
      if (since < 0 || since > DESCRIPTION_SECONDS) setChosen(undefined)
    }
    player.addEventListener('timeupdate', onTime)
    return () => {
      player.removeEventListener('timeupdate', onTime)
    }
  }, [chosen])

  if (error != null) {
    // A heading and a reason, not a full stop on its own. A deep link to a
    // game that has gone is the commonest way to land here, and `Not found.`
    // centred in an empty screen reads as the app having broken rather than
    // as an answer. The chevron in the header is the way out, so there is no
    // button here to duplicate it.
    return (
      <View style={styles.centre}>
        <Text style={styles.messageHeading}>{error}</Text>
        <Text style={styles.message}>{lstrings.common_not_found_detail}</Text>
      </View>
    )
  }
  if (game == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }

  const pickerNames = angleNames(game.videos)
  /**
   * A side's name and mark answer a press, where there is a page behind them.
   *
   * `undefined` rather than a handler that does nothing, so the card can tell
   * a name that opens something from one that is only a name.
   */
  const openSide = (teamId: string): (() => void) | undefined => {
    const team = openableTeams.get(teamId)
    if (team == null || onOpenTeam == null) return undefined
    return () => {
      onOpenTeam(team)
    }
  }
  const teamOf = (side: Side): string =>
    side === 'home' ? game.homeTeamId : game.awayTeamId
  // Straight to the one team a head coach coaches; a head coach of both
  // picks one.
  const openCoach = (): void => {
    const [only, other] = heroCoachSides(game)
    if (other == null) props.onCoachGame?.(teamOf(only))
    else setChoosingCoach(true)
  }
  const heroActions = gameActions({
    game,
    now: clockNow,
    onRecordGame: recording.open,
    onDjGame: props.onDjGame,
    onCoachGame: props.onCoachGame == null ? undefined : openCoach
  })
  const actionColor = (id: (typeof heroActions)[number]['id']): string =>
    id === 'score'
      ? theme.scoreActionColor
      : id === 'record'
        ? theme.liveColor
        : id === 'dj'
          ? theme.djActionColor
          : theme.pillActiveBackground

  const selectSection = (next: Tab): void => {
    // Leaving the video unmounts it, so where it had got to is written
    // down here and picked up by the attach that follows the remount.
    // Without this you came back to the start of the game, which is a
    // poor reward for having looked at the box score.
    const player = playerRef.current
    if (next !== 'watch' && player != null && video != null) {
      setResumeAt({
        videoId: video.id,
        sec: player.currentTime,
        playing: !player.paused
      })
    }
    explicitSelection.current = true
    selectTab(next)
    setTab(next)
    onTab?.(next)
  }

  const actionShellHeight = theme.rem(1.5)
  const actionButtons =
    heroActions.length === 0 ? undefined : (
      <View testID="game-hero-actions" style={styles.heroActions}>
        {heroActions.map(action => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            disabled={action.id === 'record' && recording.busy === true}
            accessibilityState={{
              disabled: action.id === 'record' && recording.busy === true
            }}
            style={styles.heroAction}
            onPress={() => {
              if (action.id === 'score') {
                const player = playerRef.current
                props.onScoreGame?.(
                  player != null && video != null
                    ? {
                        videoId: video.id,
                        at: player.currentTime,
                        autoPlay: !player.paused
                      }
                    : undefined
                )
                return
              }
              if (action.id === 'dj') {
                props.onDjGame?.()
                return
              }
              if (action.id === 'record') {
                recording.open?.()
                return
              }
              openCoach()
            }}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.heroActionShell,
                  {
                    height: actionShellHeight,
                    borderRadius: actionShellHeight / 2,
                    paddingHorizontal: actionShellHeight / 2,
                    backgroundColor: actionColor(action.id),
                    opacity: pressed ? 0.85 : 1
                  }
                ]}
              >
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.75}
                  style={{
                    color: theme.buttonTextColor,
                    fontFamily: theme.semiBoldTextFont,
                    fontSize: theme.rem(0.875),
                    fontWeight: '600'
                  }}
                >
                  {action.label}
                </Text>
              </View>
            )}
          </Pressable>
        ))}
        {Array.from({ length: 4 - heroActions.length }, (_, index) => (
          <View key={`space-${index}`} style={styles.heroAction} />
        ))}
      </View>
    )

  const scoreboard =
    game.eventKind === 'event' ? (
      <Card testID="event-hero" style={styles.eventHero}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <Text
            accessibilityRole="header"
            style={[styles.eventTitle, { flex: 1 }]}
          >
            {eventName(game)}
          </Text>
          {canManageSchedule && props.onSettings != null && (
            <SettingsGear label="Event settings" onPress={props.onSettings} />
          )}
        </View>
        <Text style={styles.eventHeaderTitle}>{game.homeTeamName}</Text>
        {game.startAt != null &&
          eventHeroLines(
            game.startAt,
            game.endAt,
            game.arrivalTimeDelta,
            localTimezone
          ).map((line, index) => (
            <Text
              key={index}
              testID={index === 0 ? 'event-hero-date' : 'event-hero-time'}
              style={styles.eventTiming}
            >
              {line}
            </Text>
          ))}
        {game.status === 'cancelled' && (
          <Text style={styles.eventHeaderTitle}>Canceled</Text>
        )}
      </Card>
    ) : (
      <GameHeroCard
        testID="event-hero"
        onSettings={canManageSchedule ? props.onSettings : undefined}
        awayName={game.awayTeamName}
        homeName={game.homeTeamName}
        awayScore={game.awayScore}
        homeScore={game.homeScore}
        status={game.status === 'scheduled' ? '' : gameStatusLine(game)}
        live={game.isGameLive === true}
        winner={winnerOf(game)}
        compact
        awayRecord={game.awayRecord}
        homeRecord={game.homeRecord}
        awayLogoUrl={game.awayLogoUrl}
        homeLogoUrl={game.homeLogoUrl}

        dateLines={
          game.startAt == null
            ? undefined
            : eventHeroLines(
                game.startAt,
                game.endAt,
                game.arrivalTimeDelta,
                localTimezone
              )
        }
        dateNumberOfLines={0}
        teamStats={nonMemberView ? null : teamStatsOf(game.linescore)}
        onOpenAwayTeam={openSide(game.awayTeamId)}
        onOpenHomeTeam={openSide(game.homeTeamId)}
        actions={actionButtons}
      />
    )

  const tabs = (
    <PillTabs
      tabs={gameTabs({
        game,
        now: clockNow,
        onReplay: props.onReplay
      })}
      selected={tab}
      onSelect={next => {
        if (next === 'replay') {
          props.onReplay?.()
          return
        }
        if (next !== 'info' && next !== 'boxScore' && next !== 'watch') return
        selectSection(next)
      }}
      size="compact"
      accessibilityLabel="Game sections"
    />
  )

  // Detailed play accounts remain available only to members.
  const description =
    chosen == null ||
    nonMemberView ||
    chosen.description == null ||
    chosen.description === '' ? null : (
      // The same card as the angle names above it, and the same glass: the
      // two belong to the picture and sit under it, and a solid white panel
      // the width of the column read as a different kind of thing entirely.
      <GlassView
        radius={theme.rem(theme.radiusRem)}
        style={[
          styles.description,
          // Beside the picture on a short window it is in the list's column
          // and takes its width; everywhere else it is the picture's own.
          short ? styles.descriptionInList : { width: layout.videoWidth }
        ]}
      >
        <EventTagText
          text={chosen.description}
          tag={chosen.tag}
          style={styles.descriptionText}
        />
      </GlassView>
    )

  // The selected video object is kept across refreshes so playback is not
  // reset. Whether it is live is read from the game just fetched: that copy
  // carries whether bytes are still arriving.
  const playing =
    video == null
      ? undefined
      : (game.videos.find(item => item.id === video.id) ?? video)
  const isLive = showVideoLivePill(playing, game, clockNow)
  const notice = video == null ? lstrings.game_no_video : undefined
  // The game's board over the picture, at the wall time of the frame on
  // screen, where the node's single-camera setting puts it on the picture:
  // the box less any black bars.
  const pictureBoard =
    video == null
      ? undefined
      : {
          client,
          gameId: game.id,
          videoId: video.id,
          live: isLive,
          durationSec: video.durationSec,
          picture: pictureRect(layout.videoWidth, layout.videoHeight, aspect),
          onTimeline: takeTimeline
        }
  const player = (
    <View style={styles.playerBlock}>
      {notice != null ? (
        <View
          testID="gameVideoNotice"
          style={[styles.videoNotice, { width: layout.videoWidth }]}
        >
          <Text accessibilityRole="alert" style={styles.notice}>
            {notice}
          </Text>
        </View>
      ) : nonMemberView ? (
        <Pressable
          testID="gameVideoPreview"
          accessibilityRole="button"
          accessibilityLabel="Play game video"
          onPress={() => {
            setMembershipWarning(true)
          }}
          style={{
            width: layout.videoWidth,
            height: layout.videoHeight,
            overflow: 'hidden'
          }}
        >
          <View pointerEvents="none">
            <VideoPoster
              uri={playing?.posterUrl}
              size="hero"
              showPlay
              time={
                playing?.durationSec == null
                  ? undefined
                  : timecode(playing.durationSec)
              }
            />
          </View>
          {isLive && <LivePill />}
        </Pressable>
      ) : (
        <PlayerSurface
          videoRef={playerRef}
          player={playerNode}
          muted={!cardSound}
          onMutedChange={next => {
            setCardSound(!next)
          }}
          width={layout.videoWidth}
          height={layout.videoHeight}
          active={!showAngles}
          scoreboard={pictureBoard}
          playable={playback?.url != null && playable}
          onOpen={
            playback?.url == null || !playable
              ? undefined
              : () => {
                  openPlayer(playerRef.current?.currentTime ?? lastTime.current)
                }
          }
        >
          {isLive && <LivePill />}
          {playback == null ? (
            <View style={styles.inPlace}>
              <ActivityIndicator color={theme.primaryTextColor} />
            </View>
          ) : playback.url == null ? (
            // The row says there is a video and its files are not there. Saying
            // so beats a player that shows black and never explains itself.
            <View style={styles.inPlace}>
              <Text style={styles.message}>
                {lstrings.game_video_unavailable}
              </Text>
            </View>
          ) : !playable ? (
            // Nothing here can decode it: said, rather than a dead picture,
            // and nothing is fetched for it.
            <View style={styles.inPlace}>
              <Text style={styles.message}>{lstrings.video_not_supported}</Text>
            </View>
          ) : (
            // No controls of its own: the card's press grid is its controls.
            // Silent until its sound square says otherwise, so it leaves the
            // phone's audio session to whatever was playing.
            <>
              <VideoView
                source={playback.url}
                onHandle={takePlayer}
                controls={false}
                muted={!cardSound}
                live={freshStatus === 'live'}
              />
              {/* Black while the full-screen player is up, its source
                  detached, and on its way back to where that player left it:
                  the frame it had before, or the recording's first, is not
                  that moment — and a sheet pulled down shows this card. */}
              {backFromGrid || showAngles ? (
                <View
                  testID="gameVideoLanding"
                  style={styles.landing}
                  pointerEvents="none"
                />
              ) : null}
            </>
          )}
        </PlayerSurface>
      )}

      {/*
        The same strip as everywhere else, rather than a fourth hand-drawn
        version of it. This one had square corners, its own colours and a
        target the size of the pill; as `PillTabs` it takes the one pill size
        Paul chose, fully rounded, and gets a 48px target and a `tab` role
        with it.
      */}
      {game.videos.length > 1 ? (
        // Its own card, the width of the picture, sitting just under it: glass,
        // so the highlights passing beneath the pegged block are blurred rather
        // than hidden or sharp.
        <GlassView
          radius={theme.rem(theme.radiusRem)}
          style={[styles.videoPicker, { width: layout.videoWidth }]}
          onLayout={event => {
            setPickerHeight(event.nativeEvent.layout.height)
          }}
        >
          <PillTabs
            bleed={false}
            tabs={[
              ...game.videos.map(item => {
                const name = pickerNames.get(item.id) ?? item.title
                return {
                  id: item.id,
                  label:
                    item.status === 'ready' || item.status === 'live'
                      ? name
                      : `${name} ${lstrings.game_video_gone_suffix}`
                }
              }),
              // Last, after the angles themselves: it is not another camera,
              // it is all of them at once. Not for a non-member, who is shown
              // no video.
              ...(nonMemberView
                ? []
                : [{ id: ALL_ANGLES, label: lstrings.angles_open }])
            ]}
            selected={video?.id ?? ''}
            onSelect={id => {
              if (id === ALL_ANGLES) {
                if (anglesOffered) setPicking(true)
                else setAnglesUnavailable(true)
                return
              }
              const item = game.videos.find(one => one.id === id)
              if (item != null) switchAngle(item)
            }}
            accessibilityLabel="Camera angles"
          />
        </GlassView>
      ) : null}
    </View>
  )

  const highlightList = (
    <View>
      <Text style={styles.heading}>{lstrings.game_highlights}</Text>
      {withheld === 'scoreMismatch' ? (
        <Text style={styles.warning}>{lstrings.game_score_mismatch}</Text>
      ) : withheld === 'scoredAfterRecording' ? (
        <Text style={styles.message}>{lstrings.highlights_scored_after}</Text>
      ) : withheld === 'noPlayTimes' ? (
        <Text style={styles.message}>{lstrings.highlights_no_play_times}</Text>
      ) : withheld === 'noVideoStart' ? (
        <Text style={styles.message}>{lstrings.highlights_no_video_start}</Text>
      ) : highlights.length === 0 ? (
        <Text style={styles.message}>
          {dropped > 0
            ? lstrings.highlights_none_named
            : lstrings.highlights_none}
        </Text>
      ) : (
        <View style={styles.grid}>
          {highlights.map(highlight => (
            <Pressable
              key={highlight.eventId}
              accessibilityRole="button"
              accessibilityLabel={`Play highlight: ${highlight.title}`}
              style={[
                styles.highlight,
                { width: `${100 / columns}%` },
                highlight.eventId === activeEventId
                  ? styles.highlightActive
                  : undefined
              ]}
              onPress={() => {
                jumpTo(highlight)
              }}
            >
              <VideoPoster
                uri={highlight.stillUrl}
                time={timecode(highlight.startOffsetSec)}
              />
              <EventTagText
                text={highlight.title}
                fillRow
                tag={highlight.tag}
                numberOfLines={2}
                style={[
                  styles.highlightTitle,
                  highlight.isScoringPlay ? styles.scoring : undefined
                ]}
              />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )

  // The full-width section band keeps the same horizontal inset in every
  // layout, above both the picture and the highlight column.
  const headInset = theme.rem(theme.spaceMdRem)
  const sections = (
    <View
      onLayout={event => {
        setTabsHeight(event.nativeEvent.layout.height)
      }}
    >
      <ContentInsetContext.Provider
        value={short ? NO_INSET : { left: headInset, right: headInset }}
      >
        {short && tab === 'watch' ? actionButtons : null}
        <View
          onLayout={event => {
            setSectionPillsHeight(event.nativeEvent.layout.height)
          }}
        >
          {tabs}
        </View>
      </ContentInsetContext.Provider>
    </View>
  )

  // The shared pinned head owns navigation; the watch layout also pegs the picture.
  const anglePicker = picking ? (
    <AnglePickerModal
      videos={game.videos}
      chosen={angles}
      audioId={audioId ?? null}
      onClose={() => {
        setPicking(false)
      }}
      onWatch={(ids, audio) => {
        setPicking(false)
        onAngles?.({
          angles: ids,
          // Chosen here and only here: the view itself has no way to change
          // it, so a tap meant for the pictures cannot move the sound.
          audio,
          zoom: null
        })
      }}
    />
  ) : anglesUnavailable ? (
    <AnglesUnavailableModal
      onClose={() => {
        setAnglesUnavailable(false)
      }}
    />
  ) : null

  /**
   * The take the chosen angles cover, so a moment can be written down.
   *
   * `t` means seconds into the game the angles are of — the same axis the
   * grid's own scrubber is drawn on — rather than seconds into any one file,
   * which is what it means beside `video=`. Only one of the two is ever on an
   * address.
   */
  const takeWindow = showAngles
    ? windowOf(
        placedAlone(
          (angles ?? [])
            .map(id => game.videos.find(one => one.id === id))
            .filter((one): one is VideoSummary => one != null)
        )
      )
    : null
  /**
   * The moment the videos page's picture was at, for the player opened from
   * it: its own wall time there, or its media time for a lone recording with
   * no start. Without it, the address's `t` says where.
   */
  const fromVideo =
    from == null ? undefined : game.videos.find(one => one.id === from.videoId)
  const fromMs =
    from == null || fromVideo == null
      ? null
      : (from.wallMs ?? wallAt(placedAlone([fromVideo])[0], from.sec))
  /**
   * Where a highlight opened in the player stops: its end's wall time by the
   * mapping its start was taken by, or, where that could not say, as far
   * past the start as the highlight runs.
   */
  const endAtMs =
    from?.untilSec == null
      ? null
      : (from.untilWallMs ??
        (fromMs == null ? null : fromMs + (from.untilSec - from.sec) * 1000))

  const multiCam = showAngles ? (
    <MultiCamView
      client={client}
      gameId={game.id}
      videos={game.videos}
      isLive={async videoId => await isStillLive(client, gameId, videoId)}
      order={angles ?? defaultAngles(game.videos)}
      audioId={audioId ?? null}
      // No zoom for now: the double tap that made one tile fill the screen
      // shared the pictures with the taps that play, pause and skip, and
      // fought them. An address that still names one is ignored.
      zoomedId={null}
      endAtMs={endAtMs}
      atMs={
        fromMs ??
        (takeWindow != null && startAtSec != null && startAtSec > 0
          ? takeWindow.fromMs + startAtSec * 1000
          : undefined)
      }
      onMoment={wallMs => {
        if (takeWindow == null) return
        onAngles?.({
          at: Math.max(0, Math.round((wallMs - takeWindow.fromMs) / 1000))
        })
      }}
      onChange={next => {
        onAngles?.({
          angles: next.order,
          audio: next.audioId,
          zoom: next.zoomedId
        })
      }}
      onGone={(atWallMs, playing) => {
        // However it went — the browser's Back takes the angles off the
        // address without a close — the picture goes back to the moment the
        // player had reached, playing or paused as it was, as it does from
        // the ✕. The ✕ has already written its own, exact, resume for this
        // close.
        const closed = closedByX.current
        closedByX.current = false
        if (closed || atWallMs == null || video == null) return
        viewerWants.current = playing
        setBackFromGrid(true)
        const back = { videoId: video.id, wallMs: atWallMs, playing }
        // Into the ref as well: the grid goes in the same commit as the
        // picture's source is attached again, which reads it before the
        // state has rendered.
        resumeAtRef.current = back
        setResumeAt(back)
      }}
      onClose={(atWallMs, playing) => {
        // The videos page's picture goes back to the moment the player had
        // reached, playing if it was playing and paused if it was paused;
        // what recovers a stalled player follows the same wish.
        viewerWants.current = playing
        closedByX.current = true
        // Covered only while a resume is on its way, which needs a moment
        // to go back to.
        if (atWallMs != null || resumeAtRef.current != null)
          setBackFromGrid(true)
        if (video != null)
          setResumeAt(current =>
            atWallMs != null
              ? { videoId: video.id, wallMs: atWallMs, playing }
              : current == null
                ? undefined
                : { ...current, playing }
          )
        onAngles?.({
          angles: [],
          audio: null,
          zoom: null,
          at: null,
          from: null
        })
      }}
    />
  ) : null

  const below = (
    <View style={styles.tabBody}>
      {tab === 'info' ? (
        <EventInfoTab
          key={gameId}
          client={client}
          eventId={gameId}
          event={game}
          umpires={game.umpires}
        />
      ) : (
        <BoxScore
          membershipAccess={
            <MembershipAccess
              key={`${game.id}:${props.signedIn === true}`}
              client={client}
              signedIn={props.signedIn === true}
              teams={[
                { id: game.homeTeamId, name: game.homeTeamName },
                { id: game.awayTeamId, name: game.awayTeamName }
              ]}
              onSignIn={() => props.onSignIn?.()}
            />
          }
          game={game}
          box={box}
          theme={theme}
          sideBySide={sideBySide}
          onOpenPlayer={onOpenPlayer}
        />
      )}
    </View>
  )

  return (
    <>
      <View style={styles.watch}>
        <View style={styles.tabPane} testID="gameSection">
          {tab === 'watch' ? (
            <GameWatchLayout
              pinned={pinned}
              head={scoreboard}
              player={player}
              description={description}
              sections={sections}
              // A game nothing was recorded of has nothing to have
              // highlights of: "No videos." is the whole of the tab.
              highlightList={video == null ? null : highlightList}
              footer={
                <>
                  {/*
                    Under the highlights, and only for the people who run the
                    team: everybody else is answered `404` and sees nothing
                    here at all. A browser lists stream URLs; a phone records
                    with its own camera.
                  */}
                  <StreamFooter
                    client={client}
                    gameId={gameId}
                    onPublishing={setPublishing}
                  />
                </>
              }
              layout={layout}
              short={short}
              sideBySide={sideBySide}
              headerHeight={headerHeight}
              tabsHeight={tabsHeight}
              height={height}
              style={styles.tabPane}
              contentStyle={[
                styles.watchContent,
                styles.watchStacked,
                { paddingBottom: screenBottom }
              ]}
              headStyle={styles.head}
            />
          ) : (
            <Screen {...pinned.screen} wide>
              <CardBand part={pinned.cardBand}>{scoreboard}</CardBand>
              <PillBand part={pinned.pillBand}>{tabs}</PillBand>
              <PinnedContent
                key={tab}
                part={pinned.content}
                testID="eventTabContent"
              >
                {below}
              </PinnedContent>
              <PinnedSpacer part={pinned.spacer} />
            </Screen>
          )}
        </View>
      </View>
      {membershipWarning && (
        <VideoMembershipSheet
          client={client}
          signedIn={props.signedIn === true}
          teams={[
            { id: game.homeTeamId, name: game.homeTeamName },
            { id: game.awayTeamId, name: game.awayTeamName }
          ]}
          onSignIn={() => {
            props.onSignIn?.()
          }}
          onClose={() => {
            setMembershipWarning(false)
          }}
        />
      )}
      {anglePicker}
      {multiCam}
      {recording.screen}
      {recording.error != null && (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.primaryTextColor }}
        >
          {recording.error}
        </Text>
      )}
      {choosingCoach && (
        <ChoiceSheet
          title={lstrings.game_coach_which}
          choices={heroCoachSides(game).map(side => ({
            label: side === 'away' ? game.awayTeamName : game.homeTeamName,
            onPress: () => {
              props.onCoachGame?.(teamOf(side))
            }
          }))}
          onClose={() => {
            setChoosingCoach(false)
          }}
        />
      )}
    </>
  )
}

export function timecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    centre: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.backgroundColor,
      padding: theme.rem(1)
    },
    heroActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(theme.spaceSmRem),
      paddingHorizontal: theme.rem(theme.cardContentInsetRem),
      paddingBottom: theme.rem(theme.cardContentInsetRem)
    },
    heroAction: {
      flex: 1,
      minWidth: 0,
      minHeight: theme.rem(3),
      justifyContent: 'center'
    },
    heroActionShell: {
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: theme.buttonShadowColor,
      shadowOpacity: 1,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3
    },
    scoreboard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.rem(1),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.5)
    },
    side: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: theme.rem(0.75)
    },
    teamName: {
      color: theme.primaryTextColor,
      flexShrink: 1,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.1)
    },
    teamScore: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.6)
    },
    at: {
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    // The video is the tallest thing on the page, so it is capped: a 16:9 box
    // across a desktop window would push the highlights off the bottom.
    // The card, the pills and the player. Fixed, so the list scrolls under it.
    // A flex item shrinks by default, and this one holds a 16:9 box. Without
    // `flexShrink: 0` the scrolling list below took the space it wanted and
    // squeezed the player, which clipped the video to its top third.
    fixed: {
      flexShrink: 0,
      paddingHorizontal: theme.rem(theme.spaceLgRem * 0.8),
      paddingTop: theme.rem(theme.spaceLgRem),
      paddingBottom: theme.rem(theme.spaceSmRem),
      gap: theme.rem(theme.spaceMdRem)
    },
    scroller: { flex: 1 },
    scrolled: {
      paddingHorizontal: theme.rem(theme.spaceLgRem * 0.8),
      paddingTop: theme.rem(theme.spaceSmRem),
      paddingBottom: theme.rem(theme.spaceLgRem),
      gap: theme.rem(theme.spaceMdRem)
    },
    hero: {
      backgroundColor: theme.cardBackgroundColor,
      borderRadius: theme.rem(theme.radiusRem),
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      overflow: 'hidden'
    },
    linescore: {
      borderTopWidth: 1,
      borderTopColor: theme.defaultBorderColor,
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      paddingVertical: theme.rem(theme.spaceSmRem),
      gap: theme.rem(0.125)
    },
    lineText: {
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.8125)
    },
    description: {
      marginTop: theme.rem(theme.spaceXsRem),
      borderRadius: theme.rem(theme.radiusRem),
      borderWidth: 1,
      borderColor: theme.glassBorderColor,
      paddingHorizontal: theme.rem(theme.spaceSmRem),
      paddingVertical: theme.rem(theme.spaceSmRem)
    },
    // In the highlights' column it takes the column, and stands off the
    // picture beside it by the same gap the column's own rows do.
    descriptionInList: {
      width: '100%',
      marginBottom: theme.rem(theme.spaceSmRem)
    },
    descriptionText: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9375)
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap'
    },
    tabs: {
      flexDirection: 'row',
      gap: theme.rem(0.5),
      paddingHorizontal: theme.rem(0.75),
      paddingBottom: theme.rem(0.5)
    },
    videoPicker: {
      marginTop: theme.rem(theme.spaceXsRem),
      paddingHorizontal: theme.rem(theme.spaceSmRem),
      paddingVertical: theme.rem(theme.spaceXsRem),
      borderRadius: theme.rem(theme.radiusRem),
      borderWidth: 1,
      borderColor: theme.glassBorderColor
    },
    // Its height is set from the window; the width follows, so a 16:9 picture
    // is letterboxed inside rather than dictating how tall the box is.
    // The header's copy of the card: away over home, small, and never wider than
    // about seventy per cent of the bar.
    headerScore: {
      width: '100%',
      maxWidth: HEADER_SCORE_WIDTH,
      alignSelf: 'flex-start'
    },
    headerScoreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(theme.spaceSmRem)
    },
    headerScoreName: {
      flexShrink: 1,
      color: theme.headerTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.75),
      fontWeight: '600'
    },
    headerScoreValue: {
      marginLeft: 'auto',
      minWidth: theme.rem(1.25),
      textAlign: 'right',
      color: theme.headerTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(0.75),
      fontWeight: '700'
    },
    eventHero: { padding: theme.rem(1.25), gap: theme.rem(0.5) },
    eventTitle: {
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.75),
      color: theme.primaryTextColor
    },
    eventHeaderTitle: {
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.875),
      color: theme.primaryTextColor
    },
    eventTiming: {
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.875 * 1.25),
      lineHeight: theme.rem(0.875 * 1.25 * 1.4),
      color: '#000000'
    },
    playerBlock: {
      alignItems: 'center'
    },
    watch: {
      flex: 1,
      backgroundColor: theme.backgroundColor
    },
    // The section's own scroller, which the card and the pills scroll in.
    tabPane: {
      flex: 1
    },
    // The same side inset as the hero above it, so a table or a scoring card
    // starts where the card starts.
    tabBody: {
      width: '100%',
      gap: theme.rem(theme.spaceMdRem)
    },
    watchContent: {
      gap: theme.rem(theme.spaceSmRem)
    },
    watchStacked: {
      flexDirection: 'column'
    },
    head: {
      width: '100%',
      // The same inset the card keeps at the sides, so the gap under the
      // header matches the gap at the left and right of the screen.
      paddingTop: theme.rem(theme.spaceMdRem),
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      gap: theme.rem(theme.spaceSmRem)
    },
    // The tables under that card. The same side inset, so they share its
    // edges rather than sitting in a wider column of their own.
    boxSheet: {
      width: '100%',
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      paddingBottom: theme.rem(theme.spaceLgRem),
      gap: theme.rem(theme.spaceLgRem)
    },
    player: {
      alignSelf: 'center',
      backgroundColor: theme.videoBackgroundColor,
      alignItems: 'center',
      justifyContent: 'center'
    },
    heading: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.1),
      paddingHorizontal: theme.rem(0.75),
      paddingTop: theme.rem(0.75)
    },
    // A frame, then the words. The time used to hold open a column of its own
    // between them, which read as a gap because the text in it was drawn in a
    // colour that is transparent.
    highlight: {
      flexDirection: 'row',
      // So a non-member's repeated message goes under the highlight, across
      // its whole width, rather than squeezing its title.
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.rem(0.75),
      paddingHorizontal: theme.rem(0.375),
      paddingVertical: theme.rem(0.375)
    },
    highlightActive: { backgroundColor: theme.highlightRowActiveBackground },

    highlightTitle: {
      color: theme.primaryTextColor,
      flex: 1,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.95)
    },
    scoring: { color: theme.scoringPlayColor },
    footnote: {
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8),
      padding: theme.rem(0.75)
    },
    warning: {
      color: theme.warningColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9),
      padding: theme.rem(0.75)
    },
    messageHeading: {
      color: theme.primaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.25),
      fontWeight: '600',
      textAlign: 'center'
    },
    // A notice the reader has to read, not a hint: the page's own text
    // colour on the page's own background.
    notice: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      lineHeight: theme.rem(1.4),
      textAlign: 'center'
    },
    videoNotice: {
      alignItems: 'center',
      backgroundColor: theme.backgroundColor,
      paddingHorizontal: theme.rem(1),
      paddingVertical: theme.rem(1.25)
    },
    message: {
      color: theme.secondaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      maxWidth: theme.rem(22),
      padding: theme.rem(0.75),
      textAlign: 'center'
    },
    /** Over the picture while it is on its way back from full screen. */
    landing: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: '#000000'
    },
    /**
     * What stands in the picture's place — loading, gone, or not playable
     * here — in the middle of it: at the top it sat under the game's board,
     * which hid the first half of the words.
     */
    inPlace: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center'
    }
  })
)
