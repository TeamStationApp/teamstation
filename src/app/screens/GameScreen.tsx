import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  BattingRow,
  BoxScore as BoxScoreData,
  GameDetail,
  Highlight,
  LineScoreSide,
  PitchingRow,
  Playback,
  TeamStationClient,
  TeamSummary,
  VideoSummary
} from '../../common/api'
import {
  AnglePickerModal,
  AnglesUnavailableModal,
  FLOATING_BOTTOM_REM,
  GameHeroCard,
  GlassView,
  HandoffView,
  LivePill,
  NAV_CLEARANCE_REM,
  PillTabs,
  type TeamStatLine,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
  VideoPoster,
  webStyle,
  WideTable
} from '../components'
import { ContentInsetContext, NO_INSET } from '../components/contentInset'
import { EventTagText } from '../components/EventTagText'
import { navClearanceAboveInset } from '../components/navClearance'
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
import { isStillLive } from '../player/stillLive'
import { useVideoAspect } from '../player/useVideoAspect'
import { HAVE_METADATA, type VideoHandle } from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import { windowOf } from '../player/wallClock'
import { ScoreGameOptions } from '../scoreboard/ScoreGameScreen'
import { StreamFooter } from '../stream/StreamFooter'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { gameStatusLine, shortDate, winnerOf } from './format'
import { gameTabs } from './gameTabs'
import { GameWatchLayout } from './GameWatchLayout'
import { openableTeams as teamsWithAPage } from './openableTeams'
import {
  STAT_COLUMN_GAP_REM,
  type StatColumn,
  statColumnWidths
} from './statColumns'

export interface GameScreenProps {
  client: TeamStationClient
  gameId: string
  /** Opens the full scorer from the Score Game tab. */
  onFullScoring?: () => void
  /** Opens the simplified scoreboard from the Score Game tab. */
  onScoreboard?: () => void
  /**
   * Which section to open on. A bare address is Videos. Box score and Score
   * Game are the other two pills.
   */
  /** Opens DJ Game, for a songkeeper of either team. */
  onDjGame?: () => void
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

type Tab = 'boxScore' | 'watch' | 'score'

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

  const [tab, setTab] = useState<Tab>(initialTab ?? 'watch')
  /**
   * The address is allowed to change this, not only to start it.
   *
   * Seeded once, the two disagreed the moment anything but a tap moved the
   * address: Back from the box score wrote `/games/g1` and left the box score
   * on the screen — on a phone, where Back is how people leave things, a
   * button that does nothing reads as a hang. Both ends of the app gain the
   * same thing, because it is the same code.
   *
   * The default is repeated rather than guarded against. An address that names
   * no section means **Videos**, which is what `parseRoute` says and what the
   * initialiser above says; treating it as "leave things alone" is how Back
   * from the box score went on showing the box score even once the address
   * had been put right.
   */
  useEffect(() => {
    setTab(initialTab ?? 'watch')
  }, [initialTab])

  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [canManageSchedule, setCanManageSchedule] = useState(false)
  useEffect(() => {
    let active = true
    setCanManageSchedule(false)
    client.gameScheduling(gameId).then(
      state => {
        if (active) setCanManageSchedule(state.withdrawTeamIds.length > 0)
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
   * How far the section pills push the highlights down.
   *
   * Beside the video the list should be clipped by the bottom of the card, not
   * by the top of the picture: rows that vanish at the picture's top edge look
   * cut off, because there is nothing there to be cut off *by*. The pills sit
   * between the two and are only as wide as the left column, so the list is
   * pulled up past them into the empty space beside them.
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
  const handleWatchScroll = useCallback(() => {
    // Short, the card is never drawn, so there is nothing to hand over and
    // nothing to measure: the header simply holds the score.
    if (shortWindow.current) progress.value = 1
    else handoff.handleScroll()
  }, [handoff, progress])
  const headerScore = useMemo(
    () =>
      game == null ? null : (
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
    [game, progress, styles.headerScore, theme]
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
    // The header alone: the card and the pills scroll away above the picture,
    // which then pegs under the header with the whole window below it.
    chromeHeight: headerHeight,
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
    let live = true
    client
      .game(gameId)
      .then(found => {
        if (!live) return
        setGame(found)
        // A video whose file has gone is still listed — it is part of the
        // game's record and saying so is better than pretending it never
        // existed — but it is never the one opened by default.
        onTitle?.(`${found.awayTeamName} @ ${found.homeTeamName}`)
        setVideo(
          // The address names one, when somebody followed a link to a moment.
          found.videos.find(item => item.id === initialVideoId) ??
            // A game being played right now opens on the game being played
            // right now, ahead of anything already recorded of it.
            found.videos.find(item => item.status === 'live') ??
            found.videos.find(item => item.status === 'ready') ??
            found.videos[0]
        )
      })
      .catch(() => {
        if (live) setError(lstrings.common_not_found)
      })
    return () => {
      live = false
    }
    // `onTitle` is a fresh closure on each render of the shell, so including
    // it here would refetch the game in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, gameId])

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
  const placeFor = useRef<{
    videoId?: string
    playbackFor?: string
    /** Asks the server, for a video that was live when it was opened. */
    isLive?: () => Promise<boolean>
  }>({})
  placeFor.current = {
    videoId: video?.id,
    playbackFor,
    isLive:
      video?.status === 'live'
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
      {
        wantsToPlay: () => !suspended.current && viewerWants.current,
        isLive: placeFor.current.isLive
      }
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

  const scoreboard = (
    <GameHeroCard
      awayName={game.awayTeamName}
      homeName={game.homeTeamName}
      awayScore={game.awayScore}
      homeScore={game.homeScore}
      status={gameStatusLine(game)}
      live={game.status === 'inProgress'}
      winner={winnerOf(game)}
      compact
      awayRecord={game.awayRecord}
      homeRecord={game.homeRecord}
      awayLogoUrl={game.awayLogoUrl}
      homeLogoUrl={game.homeLogoUrl}
      awayTeamId={game.awayTeamId}
      homeTeamId={game.homeTeamId}
      date={shortDate(game.startAt)}
      venue={game.venue ?? undefined}
      teamStats={nonMemberView ? null : teamStatsOf(game.linescore)}
      onOpenAwayTeam={openSide(game.awayTeamId)}
      onOpenHomeTeam={openSide(game.homeTeamId)}
    />
  )

  const tabs = (
    <PillTabs
      tabs={gameTabs({
        game,
        music: props.music,
        onDjGame: props.onDjGame,
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

  // Stacked, the pills sit in the head's padding and run back out through
  // it to the screen's edges. In the short layout they share a column with
  // the picture beside them, so they stay inside it.
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
  const head = (
    <>
      {/*
        The card alone is what hands its score up, not the block it shares
        with the pills: measured across both, the score only arrived once the
        pills had gone under too, which is long after the thing it is a copy
        of has left the screen.
      */}
      <View collapsable={false} ref={handoff.ref}>
        {scoreboard}
      </View>
      {sections}
    </>
  )

  // Two regions, not one scroll view: the card, the pills and the player are
  // fixed, and the highlights scroll underneath them. Reading to the bottom of
  // a long game must not take the video off the screen.
  //
  // How those three are arranged is the one piece of this app that exists
  // twice — `position: sticky` and a nested scroller have no React Native
  // equivalent that is a style — so it lives in `GameWatchLayout`, which takes
  // what to draw and knows nothing about a game.
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
      isLive={async videoId => await isStillLive(client, gameId, videoId)}
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
      {tab === 'score' ? (
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
      {/*
        The card and the pills scroll with every section, from the same place
        at the top of each, so switching sections does not move them. On
        Videos they scroll away above the picture, which pegs under the
        header while the highlights scroll on under it and its angle buttons.
      */}
      <View style={styles.watch}>
        <View style={styles.tabPane} testID="gameSection">
          {tab === 'watch' ? (
            <GameWatchLayout
              head={head}
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
                  <StreamFooter client={client} gameId={gameId} />
                </>
              }
              layout={layout}
              short={short}
              sideBySide={sideBySide}
              headerHeight={headerHeight}
              tabsHeight={tabsHeight}
              height={height}
              onScroll={handleWatchScroll}
              style={styles.tabPane}
              contentStyle={[
                styles.watchContent,
                sideBySide ? styles.watchSplit : styles.watchStacked,
                short && styles.watchSplitShort
              ]}
              headStyle={styles.head}
              columnHeadStyle={styles.columnHead}
            />
          ) : (
            <ScrollView
              style={styles.tabPane}
              onScroll={handleWatchScroll}
              scrollEventThrottle={16}
              contentContainerStyle={{ paddingTop: headerHeight }}
            >
              <View style={styles.head}>{head}</View>
              {below}
            </ScrollView>
          )}
        </View>
      </View>
      {anglePicker}
      {multiCam}
    </>
  )
}

interface BoxScoreProps {
  game: GameDetail
  /** `undefined` while it is still loading. */
  box: BoxScoreData | undefined
  theme: Theme
  /** Away and home side by side, rather than one at a time. */
  sideBySide: boolean
  /**
   * Opening a line. The game's season and the side that line belongs to go
   * with it, so the player's stats open on the season being read rather than
   * on a career total nobody asked for. The side goes again as `onTeam`, the
   * team a coach's Settings tab edits the player on.
   */
  onOpenPlayer?: (
    userId: number,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
}

/**
 * The box score: the innings across the top, then each side's batting and
 * pitching.
 *
 * Away on the left and home on the right, the same way round as the card above
 * — and the same way round as every scoreboard ever printed. On a phone there
 * is no room for two columns, so the four tables run one under another, home
 * first, which is a scroll rather than four decisions.
 *
 * A side with no batting lines, or no pitching lines, leaves that section
 * out. The totals are still in the line score above.
 */
function BoxScore(props: BoxScoreProps): React.ReactElement {
  const { game, box, theme, sideBySide, onOpenPlayer } = props
  const styles = getStyles(theme)

  // The innings and the runs are a non-member's; each side's lines are not.
  if (game.nonMemberView) {
    return (
      <View style={styles.boxScore}>
        <LineScore game={game} theme={theme} />
        <Text accessibilityRole="alert" style={styles.notice}>
          {lstrings.box_score_members_only}
        </Text>
      </View>
    )
  }

  if (box == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }

  const sides = [
    { key: 'away', teamId: game.awayTeamId, name: game.awayTeamName },
    { key: 'home', teamId: game.homeTeamId, name: game.homeTeamName }
  ] as const

  const tables = (side: (typeof sides)[number]): React.ReactElement => {
    const batting = box.batting.filter(row => row.teamId === side.teamId)
    const pitching = box.pitching.filter(row => row.teamId === side.teamId)
    const open =
      onOpenPlayer == null
        ? undefined
        : (userId: number, name: string) => {
            onOpenPlayer(userId, name, {
              seasonId: game.seasonId ?? undefined,
              teamId: side.teamId,
              onTeam: side.teamId
            })
          }
    return (
      <View style={styles.boxSide}>
        <BattingTable
          name={side.name}
          rows={batting}
          theme={theme}
          onOpenPlayer={open}
        />
        <PitchingTable
          name={side.name}
          rows={pitching}
          theme={theme}
          onOpenPlayer={open}
        />
      </View>
    )
  }

  return (
    <View style={styles.boxScore}>
      <LineScore game={game} theme={theme} />

      {sideBySide ? (
        <View style={styles.boxColumns}>
          {sides.map(side => (
            <View key={side.key} style={styles.boxColumn}>
              {tables(side)}
            </View>
          ))}
        </View>
      ) : (
        // One long column rather than a row of pills. Four tables of nine
        // rows is a scroll, not a decision, and a pill for each is four taps
        // to read what one thumb can.
        <View style={styles.boxSide}>
          {[...sides].reverse().map(side => (
            <View key={side.key}>{tables(side)}</View>
          ))}
        </View>
      )}
    </View>
  )
}

/**
 * Runs by inning, the way a scoreboard draws them, with the totals at the end.
 *
 * Hits and errors sit beside the runs because that is where fifty years of
 * scoreboards have put them; home runs and hit batters follow, since both are
 * counted from the plays and neither fits in a batting table without crowding
 * the columns that matter.
 */
function LineScore(props: {
  game: GameDetail
  theme: Theme
}): React.ReactElement | null {
  const { game, theme } = props
  const styles = getStyles(theme)
  const line = game.linescore
  if (line == null) return null

  const innings = Math.max(line.away.runs.length, line.home.runs.length)
  const sides = [
    { name: game.awayTeamName, side: line.away },
    { name: game.homeTeamName, side: line.home }
  ]
  // Runs, hits, errors and home runs. A hit batter belongs in the pitcher's
  // line and the batter's, not up here beside the innings. A non-member is sent
  // the runs alone.
  const counted = !game.nonMemberView
  const totals = counted ? ['R', 'H', 'E', 'HR'] : ['R']

  return (
    // Seven innings and five totals is wider than a phone. It scrolls sideways
    // rather than being cut off at the runs column, which is the half somebody
    // opened the box score for.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.lineScore}
      contentContainerStyle={styles.lineScoreContent}
    >
      <View style={[styles.tableRow, styles.tableHead]}>
        <Text
          style={[styles.cellName, styles.cellHead, styles.lineScoreName]}
          numberOfLines={1}
        />
        {Array.from({ length: innings }, (unused, index) => (
          <Text key={index} style={[styles.cell, styles.cellHead]}>
            {index + 1}
          </Text>
        ))}
        {totals.map(label => (
          <Text key={label} style={[styles.cell, styles.cellHead]}>
            {label}
          </Text>
        ))}
      </View>
      {sides.map(({ name, side }) => (
        <View key={name} style={styles.tableRow}>
          <Text
            style={[styles.cellName, styles.lineScoreName]}
            numberOfLines={1}
          >
            {name}
          </Text>
          {Array.from({ length: innings }, (unused, index) => (
            <Text key={index} style={styles.cell}>
              {side.runs[index] ?? '–'}
            </Text>
          ))}
          <Text style={[styles.cell, styles.cellStrong]}>{side.r}</Text>
          {counted && (
            <>
              <Text style={styles.cell}>{side.h ?? '–'}</Text>
              <Text style={styles.cell}>{side.e ?? '–'}</Text>
              <Text style={styles.cell}>{side.hr ?? '–'}</Text>
            </>
          )}
        </View>
      ))}
    </ScrollView>
  )
}

function statCellSize(
  theme: Theme,
  width: number,
  index: number
): { width: number; paddingLeft: number; fontVariant: Array<'tabular-nums'> } {
  const gap = index === 0 ? 0 : STAT_COLUMN_GAP_REM
  return {
    width: theme.rem(width + gap),
    paddingLeft: theme.rem(gap),
    fontVariant: ['tabular-nums']
  }
}

/**
 * One person's line, in any of the four tables.
 *
 * The whole row is the target rather than the name: a name is a few characters
 * at one end of a row read on a phone at the edge of a field, and the rest of
 * the row is the part the thumb actually lands on.
 */
function StatRow(props: {
  name: string
  cells: string[]
  widths: number[]
  theme: Theme
  onPress?: () => void
}): React.ReactElement {
  const { name, cells, widths, theme, onPress } = props
  const styles = getStyles(theme)
  const content = (
    <>
      <Text style={[styles.cellName, styles.statName]} numberOfLines={1}>
        {name}
      </Text>
      {cells.map((value, index) => (
        <Text
          key={index}
          style={[styles.cell, statCellSize(theme, widths[index], index)]}
          // A figure is one line. Whatever it measures, it must not be
          // allowed to make its row taller than the row above.
          numberOfLines={1}
        >
          {value}
        </Text>
      ))}
    </>
  )
  if (onPress == null) {
    return <View style={[styles.tableRow, styles.playerRow]}>{content}</View>
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tableRow,
        styles.playerRow,
        pressed && styles.playerRowPressed
      ]}
    >
      {content}
    </Pressable>
  )
}

function BattingTable(props: {
  name: string
  rows: BattingRow[]
  theme: Theme
  onOpenPlayer?: (userId: number, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  const { fontScale } = useWindowDimensions()
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  // The server preserves each side’s first plate-appearance order.
  const lines = rows
  const widths = statColumnWidths(
    battingColumns,
    rows,
    0.8125,
    0.8125,
    0,
    fontScale
  )
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_batting} — {name}
      </Text>
      <WideTable>
        <View style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellName, styles.statName, styles.cellHead]}>
            {lstrings.stats_player}
          </Text>
          {battingColumns.map((column, index) => (
            <Text
              key={column.label}
              style={[
                styles.cell,
                styles.cellHead,
                statCellSize(theme, widths[index], index)
              ]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {lines.map(line => (
          <StatRow
            key={line.userId}
            name={line.shortName ?? ''}
            cells={battingColumns.map(column => column.value(line))}
            widths={widths}
            theme={theme}
            onPress={
              onOpenPlayer == null
                ? undefined
                : () => {
                    onOpenPlayer(line.userId, line.shortName ?? '')
                  }
            }
          />
        ))}
      </WideTable>
    </View>
  )
}

function PitchingTable(props: {
  name: string
  rows: PitchingRow[]
  theme: Theme
  onOpenPlayer?: (userId: number, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  const { fontScale } = useWindowDimensions()
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  const widths = statColumnWidths(
    pitchingColumns,
    rows,
    0.8125,
    0.8125,
    0,
    fontScale
  )
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_pitching} — {name}
      </Text>
      <WideTable>
        <View style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellName, styles.statName, styles.cellHead]}>
            {lstrings.stats_player}
          </Text>
          {pitchingColumns.map((column, index) => (
            <Text
              key={column.label}
              style={[
                styles.cell,
                styles.cellHead,
                statCellSize(theme, widths[index], index)
              ]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {rows.map(line => (
          <StatRow
            key={line.userId}
            name={line.shortName ?? ''}
            cells={pitchingColumns.map(column => column.value(line))}
            widths={widths}
            theme={theme}
            onPress={
              onOpenPlayer == null
                ? undefined
                : () => {
                    onOpenPlayer(line.userId, line.shortName ?? '')
                  }
            }
          />
        ))}
      </WideTable>
    </View>
  )
}

const pitchingColumns: Array<StatColumn<PitchingRow>> = [
  { label: lstrings.stats_innings, sample: '9.2', value: row => row.ip },
  { label: 'BF', value: row => String(row.bf) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
  { label: lstrings.stats_runs, value: row => String(row.r) },
  // Earned runs, worked out by replaying the inning the way a scorebook
  // does — the one figure on this line that a play-by-play cannot produce.
  { label: lstrings.stats_earned_runs, value: row => String(row.er) },
  { label: lstrings.stats_walks, value: row => String(row.bb) },
  { label: lstrings.stats_strikeouts, value: row => String(row.k) },
  { label: 'HR', value: row => String(row.hr) },
  { label: 'HBP', value: row => String(row.hbp) }
]

const battingColumns: Array<StatColumn<BattingRow>> = [
  { label: lstrings.stats_at_bats, value: row => String(row.ab) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
  { label: lstrings.stats_runs, value: row => String(row.r) },
  { label: lstrings.stats_runs_batted_in, value: row => String(row.rbi) },
  { label: lstrings.stats_walks, value: row => String(row.bb) },
  { label: lstrings.stats_strikeouts, value: row => String(row.k) },
  { label: 'HR', value: row => String(row.hr) },
  { label: 'HBP', value: row => String(row.hbp) },
  {
    // The season's, not the afternoon's: three at-bats say nothing about a
    // hitter, and the number beside a name is read as what kind of hitter
    // they are.
    label: lstrings.stats_average,
    value: row => (row.seasonAvg == null ? '–' : average(row.seasonAvg)),
    sample: '1.000'
  }
]

/** `.667`, in the way a box score writes it: no leading zero. */
export function average(value: number | undefined): string {
  if (value == null) return lstrings.stats_no_average
  return value.toFixed(3).replace(/^0/, '')
}

/** `M:SS`, or `H:MM:SS` once a game runs past the hour. */
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
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      paddingBottom: theme.rem(NAV_CLEARANCE_REM),
      gap: theme.rem(theme.spaceMdRem)
    },
    watchContent: {
      // No padding here: the picture is edge to edge on a phone, so the
      // margins belong to the pieces either side of it rather than to the
      // column they share.
      paddingBottom: navClearanceAboveInset(
        Platform.OS,
        theme.rem(NAV_CLEARANCE_REM),
        theme.rem(FLOATING_BOTTOM_REM)
      ),
      gap: theme.rem(theme.spaceSmRem)
    },
    watchStacked: {
      flexDirection: 'column'
    },
    // A wrapping row: the card takes the whole width and forces the wrap, then
    // the player and the list share the line under it.
    watchSplit: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      columnGap: theme.rem(1.5)
    },
    // A phone on its side never wraps. The card that forces the wrap above is
    // not drawn on a short window at all, so there is nothing legitimate for a
    // second line to hold — and if the two columns are ever a few points too
    // wide for the glass, wrapping is the worst of the available answers: the
    // list goes *under* the pegged picture, where it reads as an empty column
    // beside the video rather than as a layout that did not fit. Refusing to
    // wrap keeps the mistake visible instead of hiding it.
    watchSplitShort: {
      flexWrap: 'nowrap'
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
    // The same pieces, stacked in the column on the right on a short window.
    columnHead: {
      gap: theme.rem(theme.spaceSmRem),
      marginBottom: theme.rem(theme.spaceSmRem)
    },

    // Pegged under the header in both layouts, once the card and the pills
    // have gone by. `sticky` is a web position React Native has no name for;
    // this app renders to the DOM, and `webStyle` is the one place that cast
    // lives.

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
    boxSide: {
      gap: theme.rem(theme.spaceMdRem)
    },
    boxColumns: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.rem(theme.spaceLgRem)
    },
    boxColumn: {
      flex: 1,
      // Or the wider of the two tables spills over the other.
      overflow: 'hidden',
      // Zero basis in a row measures the width, which is what is wanted here:
      // two even columns, away on the left and home on the right, the same way
      // round as the card above them.
      flexBasis: 0,
      minWidth: 0
    },
    lineScore: {
      flexGrow: 0,
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      borderRadius: theme.rem(theme.radiusRem),
      backgroundColor: theme.cardBackgroundColor,
      paddingHorizontal: theme.rem(theme.spaceSmRem),
      paddingVertical: theme.rem(theme.spaceXsRem)
    },
    lineScoreContent: {
      flexDirection: 'column'
    },
    // The line score is a white card, so its pinned names are white too. The
    // page colour `cellName` paints is for the tables that sit on the page.
    lineScoreName: {
      backgroundColor: theme.cardBackgroundColor
    },
    cellStrong: {
      fontFamily: theme.boldTextFont,
      fontWeight: '700',
      color: theme.primaryTextColor
    },
    boxScore: {
      // No cap: the whole point of a wide window here is two sides at once,
      // and a reading-width cap made for a line of text held both tables to
      // half of one column.
      width: '100%',
      gap: theme.rem(theme.spaceMdRem),
      paddingBottom: theme.rem(1)
    },
    table: { paddingBottom: theme.rem(0.5), overflow: 'hidden' },
    tableRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.3)
    },
    tableHead: {
      borderBottomColor: theme.defaultBorderColor,
      borderBottomWidth: 1
    },
    // A line about a person, which opens their page. The head row and the
    // line score keep the tighter `tableRow`: neither is a target, and
    // growing them would spend the height these rows just took.
    playerRow: {
      minHeight: theme.rem(2.75),
      paddingVertical: theme.rem(theme.spaceSmRem)
    },
    playerRowPressed: {
      backgroundColor: theme.highlightRowActiveBackground
    },
    cellName: {
      color: theme.primaryTextColor,
      // Wide enough for a name before anything else gets a say, and greedy
      // for whatever a wide window has left over. It never gives any back:
      // inside a horizontal scroll a shrinking name is a column of ellipses
      // where there was room to scroll instead.
      flexBasis: theme.rem(6.5),
      flexGrow: 1,
      flexShrink: 0,
      // And pinned, so a row scrolled to its last column is still somebody's.
      // `sticky` is a position React Native has no name for; this app renders
      // to the DOM, where it does. The background is what the numbers pass
      // under rather than through.
      ...webStyle({ position: 'sticky', left: 0, zIndex: 1 }),
      backgroundColor: theme.backgroundColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    statName: { minWidth: theme.rem(6.5) },
    cell: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8125),
      // Fixed, so the columns of two tables beside each other line up and
      // neither can push the other out of its half.
      width: theme.rem(2),
      flexGrow: 0,
      flexShrink: 0,
      textAlign: 'right'
    },
    cellHead: {
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont
    },
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
