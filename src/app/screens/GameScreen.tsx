import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  BoxScore as BoxScoreData,
  GameDetail,
  Highlight,
  LineScoreSide,
  Playback,
  TeamStationClient,
  TeamSummary,
  VideoSummary
} from '../../common/api'
import { eventName } from '../../common/eventInfo'
import { eventHeroLines, viewerTimezone } from '../../common/eventTime'
import type { GameSocket } from '../../common/gameSocket'
import type { Side } from '../../common/scoring/state'
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
  StreamPanel,
  type TeamStatLine,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
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
import { highlightColumnsFor } from '../layout/grid'
import { watchLayout, type WatchMode } from '../layout/watch'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { sameMoment } from '../player/angleSwitch'
import { attachHls } from '../player/attachHls'
import { playerEngine } from '../player/engine'
import { multiAngleSupported } from '../player/multiCam/support'
import { angleLabels, defaultAngles } from '../player/multiCam/takes'
import { MultiCamView } from '../player/MultiCamView'
import { PlayerSurface } from '../player/PlayerSurface'
import { useVideoAspect } from '../player/useVideoAspect'
import { HAVE_METADATA, type VideoHandle } from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import { windowOf } from '../player/wallClock'
import { ScoreGameOptions } from '../scoreboard/ScoreGameScreen'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { BoxScore } from './BoxScore'
import { EventInfoTab } from './EventInfoTab'
import { defaultEventTab, eventEndTime } from './eventTabPolicy'
import { gameStatusLine, winnerOf } from './format'
import { gameTabs } from './gameTabs'
import { GameWatchLayout } from './GameWatchLayout'
import { watchHandoff } from './gameWatchLayoutProps'
import { openableTeams as teamsWithAPage } from './openableTeams'

export interface GameScreenProps {
  client: TeamStationClient
  gameId: string
  socket?: Pick<GameSocket, 'subscribe'>
  /** Opens the full scorer from the Score Game tab. */
  onFullScoring?: () => void
  /** Opens the simplified scoreboard from the Score Game tab. */
  onScoreboard?: () => void
  /**
   * An explicit section. Bare addresses use the event's current default.
   */
  /** Opens DJ Game, for a songkeeper of either team. */
  onDjGame?: () => void
  /**
   * Opens Coach Game on a team the viewer head-coaches. A head coach of both
   * teams picks one first.
   */
  onCoachGame?: (teamId: string) => void
  /** Opens a separate scheduling settings screen for a participating team admin. */
  onSettings?: () => void
  /**
   * The phone's music. DJ Game plays songs, and is offered only on an
   * iPhone: never on the web or Android.
   */
  music?: { djSupported: boolean }
  initialTab?: Tab
  /** Start the video. Arriving here by pressing `Watch Replay` is a gesture a
   * browser accepts, which is what makes an unmuted autoplay legal. */
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
  }) => void
  /** Opens one of the two teams, from its name or its mark on the card. */
  onOpenTeam?: (team: TeamSummary) => void
  /** Opens one player, from their line in the box score. */
  onOpenPlayer?: (
    userId: number,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
}

type Tab = 'info' | 'boxScore' | 'watch' | 'score'

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
    onOpenTeam,
    onOpenPlayer
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { height, width } = useWindowDimensions()
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
  const videoHints = useRef({ onTitle, initialVideoId })
  videoHints.current = { onTitle, initialVideoId }
  const refreshGame = useCallback(async (): Promise<void> => {
    if (live.current && currentGameId.current === gameId)
      setLocalTimezone(viewerTimezone())
    const request = ++gameRequest.current
    try {
      const found = await client.game(gameId)
      if (
        !live.current ||
        currentGameId.current !== gameId ||
        request !== gameRequest.current
      )
        return
      setGame(found)
      setError(undefined)
      videoHints.current.onTitle?.(
        eventName(found) ?? `${found.awayTeamName} @ ${found.homeTeamName}`
      )
      setVideo(current =>
        current != null && found.videos.some(item => item.id === current.id)
          ? current
          : (found.videos.find(
              item => item.id === videoHints.current.initialVideoId
            ) ??
            found.videos.find(item => item.status === 'live') ??
            found.videos.find(item => item.status === 'ready') ??
            found.videos[0])
      )
    } catch (error) {
      if (
        live.current &&
        currentGameId.current === gameId &&
        request === gameRequest.current
      )
        throw error
    }
  }, [client, gameId])
  useForegroundRefresh(refreshGame)
  useEffect(() => {
    if (game == null) return
    if (game.eventKind === 'event') setTab('info')
    else if (!explicitSelection.current) setTab(defaultEventTab(game, clockNow))
  }, [game, clockNow, requestedTab])
  useEffect(() => {
    if (game == null) return
    const end = eventEndTime(game)
    if (end == null) return
    if (end <= Date.now()) {
      if (clockNow < end) setClockNow(Date.now())
      return
    }
    const timer = setTimeout(
      () => {
        setClockNow(Date.now())
      },
      Math.min(2147483647, end - Date.now() + 1)
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
          refreshGame().catch(() => undefined)
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
    { videoId: string; sec: number; playing: boolean } | undefined
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
  const anglesOffered = useMemo(() => multiAngleSupported(playerEngine()), [])
  /**
   * Somebody signed in who is a member of neither team: the score, the line
   * score and the highlights' pictures, and not the video, the box score's
   * tables or the summary under the card, which are kept for members.
   * Nothing kept is asked for, so the page never meets the server's refusal.
   */
  const nonMemberView = game?.nonMemberView === true
  const showAngles =
    anglesOffered && !nonMemberView && angles != null && angles.length > 0

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
  /**
   * Whether the player is currently drawing its own controls over the picture.
   *
   * `true` to begin with, and a browser never changes it: it has no way to
   * say, and its control rectangles were measured rather than guessed at. A
   * phone tells us, and while the bar is faded away the gesture squares get
   * the whole picture back.
   */
  const [controlsVisible, setControlsVisible] = useState(true)

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
    let active = true
    setGame(undefined)
    setVideo(undefined)
    setBox(undefined)
    setError(undefined)
    startedFromLink.current = false
    refreshGame().catch(() => {
      if (active) setError(lstrings.common_not_found)
    })
    return () => {
      active = false
      gameRequest.current++
    }
  }, [refreshGame])

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

  useEffect(() => {
    if (video == null) return
    let live = true
    client
      .highlights(video.id)
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
  }, [client, video, addressAttempt])

  // The app never builds a media URL: the server knows where the video is and
  // checks membership while it looks, so asking is the only way to find out.
  useEffect(() => {
    if (video == null || nonMemberView) return
    const forVideoId = video.id
    let live = true
    setPlayback(undefined)
    setPlaybackFor(undefined)
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
  }, [client, video, nonMemberView])

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
  const startAtSecRef = useRef(startAtSec)
  startAtSecRef.current = startAtSec
  const autoPlayRef = useRef(autoPlay)
  autoPlayRef.current = autoPlay
  const placeFor = useRef<{ videoId?: string; playbackFor?: string }>({})
  placeFor.current = { videoId: video?.id, playbackFor }

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
    const detach = attachHls(
      element,
      playbackUrl,
      () => {
        setAddressAttempt(attempt => attempt + 1)
      },
      { wantsToPlay: () => !suspended.current && viewerWants.current }
    )

    const resume = resumeAtRef.current
    const { videoId, playbackFor: forId } = placeFor.current

    // Picking up where the other angle was, once the new source is attached.
    if (resume != null && resume.videoId === videoId && forId === videoId) {
      const apply = (): void => {
        element.currentTime = resume.sec
        if (resume.playing) element.play().catch(() => undefined)
        setResumeAt(undefined)
      }
      if (element.readyState >= HAVE_METADATA) apply()
      else element.addEventListener('loadedmetadata', apply, { once: true })
      return detach
    }

    // A link to a moment: start there, and start playing, because that is
    // what the person who sent the link meant by sending it.
    const linkAt = startAtSecRef.current
    if (linkAt != null && linkAt > 0 && !startedFromLink.current) {
      startedFromLink.current = true
      const jump = (): void => {
        element.currentTime = linkAt
        element.play().catch(() => undefined)
      }
      if (element.readyState >= HAVE_METADATA) jump()
      else element.addEventListener('loadedmetadata', jump, { once: true })
      return detach
    }

    if (autoPlayRef.current) {
      // The tap that opened this screen is a gesture the browser counts, so an
      // unmuted start is allowed. If it refuses anyway the controls are right
      // there, and saying so would be noise.
      const start = (): void => {
        element.play().catch(() => undefined)
      }
      element.addEventListener('loadedmetadata', start, { once: true })
      start()
    }
    return detach
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
    if (player == null || current == null || next.id === current.id) {
      setVideo(next)
      return
    }
    // Worked out before the swap, and handed to the effect that attaches the
    // new source. Listening for `loadedmetadata` here does not work: changing
    // the video re-runs `attachHls`, which resets the element *after* the
    // listener has fired, so the seek was being undone a moment later.
    const sec = sameMoment(current, next, player.currentTime)
    setResumeAt({
      videoId: next.id,
      sec,
      playing: !player.paused
    })
    setVideo(next)
    // The address names the angle, so it has to follow the angle. Without
    // this it went on naming the one you switched away from, and copying the
    // link mid-game handed somebody a different camera.
    onMoment?.(next.id, Math.round(sec))
  }

  const jumpTo = (highlight: Highlight): void => {
    setActiveEventId(highlight.eventId)
    setChosen(highlight)
    // There is no video to seek for a non-member, and no moment to link to:
    // the notice in the player's place says why.
    if (nonMemberView) return
    // The address follows, so the moment somebody is looking at is the moment
    // they can send to somebody else.
    if (video != null)
      onMoment?.(video.id, Math.round(highlight.startOffsetSec))
    const player = playerRef.current
    if (player == null) return
    // Seek and keep playing: the point is to watch on from here, not to show
    // a clip.
    player.currentTime = highlight.startOffsetSec
    // A browser may refuse to start playing without a gesture it recognises;
    // the seek has already happened, so that refusal is not worth reporting.
    player.play().catch(() => undefined)
  }

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

  const scoreboard =
    game.eventKind === 'event' ? (
      <Card testID="event-hero" style={styles.eventHero}>
        <Text accessibilityRole="header" style={styles.eventTitle}>
          {eventName(game)}
        </Text>
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
        awayName={game.awayTeamName}
        homeName={game.homeTeamName}
        awayScore={game.awayScore}
        homeScore={game.homeScore}
        status={game.status === 'scheduled' ? '' : gameStatusLine(game)}
        live={game.status === 'inProgress'}
        winner={winnerOf(game)}
        compact
        awayRecord={game.awayRecord}
        homeRecord={game.homeRecord}
        awayLogoUrl={game.awayLogoUrl}
        homeLogoUrl={game.homeLogoUrl}
        awayTeamId={game.awayTeamId}
        homeTeamId={game.homeTeamId}
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
      />
    )

  const teamOf = (side: Side): string =>
    side === 'home' ? game.homeTeamId : game.awayTeamId
  // Straight to the one team a head coach coaches; a head coach of both
  // picks one.
  const openCoach = (): void => {
    const [only, other] = game.coachSides
    if (other == null) props.onCoachGame?.(teamOf(only))
    else setChoosingCoach(true)
  }
  const tabs = (
    <PillTabs
      tabs={gameTabs({
        game,
        now: clockNow,
        music: props.music,
        onDjGame: props.onDjGame,
        onCoachGame: props.onCoachGame == null ? undefined : openCoach,
        canManage: canManageSchedule,
        onSettings: props.onSettings
      })}
      selected={tab}
      onSelect={next => {
        if (next === 'settings') {
          props.onSettings?.()
          return
        }
        if (next === 'dj') {
          props.onDjGame?.()
          return
        }
        if (next === 'coach') {
          openCoach()
          return
        }
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
      }}
      size="compact"
      accessibilityLabel="Game sections"
    />
  )

  // A non-member's tap gets no play's account: the members-only message is
  // repeated under the tapped highlight instead (see `highlightList`).
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

  const isLive = video?.status === 'live'
  /**
   * What stands in the player's place when there is nothing to play: a game
   * nothing was recorded of, or a non-member, whose video is kept for
   * members. Words on the page, not a black box with nothing in it. Painted
   * the page's own colour, since the highlights scroll up under it.
   */
  const notice =
    video == null
      ? lstrings.game_no_video
      : nonMemberView
        ? lstrings.game_videos_members_only
        : undefined
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
      ) : (
        <PlayerSurface
          videoRef={playerRef}
          width={layout.videoWidth}
          height={layout.videoHeight}
          controlsVisible={controlsVisible}
          active={!showAngles}
        >
          {isLive && <LivePill />}
          {playback == null ? (
            <ActivityIndicator color={theme.primaryTextColor} />
          ) : playback.url == null ? (
            // The row says there is a video and its files are not there. Saying
            // so beats a player that shows black and never explains itself.
            <Text style={styles.message}>
              {lstrings.game_video_unavailable}
            </Text>
          ) : (
            // The platform's own controls stay: they scrub, mute and go
            // fullscreen well, and the gesture layer is cut around them rather
            // than replacing them — `controlGeometry.ts` knows where each
            // platform puts them.
            <VideoView
              source={playback.url}
              onHandle={takePlayer}
              controls
              onControlsVisible={setControlsVisible}
            />
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
              {/*
                The message in the player's place may be scrolled out of
                sight by now, so a non-member's tap is answered where they
                tapped, too.
              */}
              {nonMemberView && highlight.eventId === activeEventId ? (
                <Text
                  testID="highlightMembersOnly"
                  accessibilityRole="alert"
                  style={[styles.notice, styles.highlightNotice]}
                >
                  {lstrings.game_videos_members_only}
                </Text>
              ) : null}
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
        {tabs}
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
        (angles ?? [])
          .map(id => game.videos.find(one => one.id === id))
          .filter((one): one is VideoSummary => one != null)
      )
    : null

  const multiCam = showAngles ? (
    <MultiCamView
      client={client}
      videos={game.videos}
      order={angles ?? defaultAngles(game.videos)}
      audioId={audioId ?? null}
      // No zoom for now: the double tap that made one tile fill the screen
      // shared the pictures with the taps that play, pause and skip, and
      // fought them. An address that still names one is ignored.
      zoomedId={null}
      atMs={
        takeWindow != null && startAtSec != null && startAtSec > 0
          ? takeWindow.fromMs + startAtSec * 1000
          : undefined
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
      onClose={() => {
        onAngles?.({ angles: [], audio: null, zoom: null, at: null })
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
        />
      ) : tab === 'score' ? (
        <ScoreGameOptions
          game={game}
          onFullScoring={props.onFullScoring}
          onScoreboard={props.onScoreboard}
        />
      ) : (
        <BoxScore
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
                    here at all.
                  */}
                  <StreamPanel key={gameId} client={client} gameId={gameId} />
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
      {anglePicker}
      {multiCam}
      {choosingCoach && (
        <ChoiceSheet
          title={lstrings.game_coach_which}
          choices={(['away', 'home'] as const).map(side => ({
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
    highlightNotice: { width: '100%', paddingTop: theme.rem(0.25) },
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
    }
  })
)
