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
import Animated from 'react-native-reanimated'

import type {
  BattingRow,
  BoxScore as BoxScoreData,
  GameDetail,
  GameStationClient,
  Highlight,
  LineScoreSide,
  PitchingRow,
  Playback,
  VideoSummary
} from '../../common/api'
import {
  GameHeroCard,
  glassStyle,
  HandoffView,
  PillTabs,
  Screen,
  type TeamStatLine,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
  VideoPoster,
  webStyle
} from '../components'
import { highlightColumnsFor } from '../layout/grid'
import { PHONE_MARGIN, watchLayout, type WatchMode } from '../layout/watch'
import { lstrings } from '../locales/strings'
import { sameMoment } from '../player/angleSwitch'
import { attachHls } from '../player/attachHls'
import { PlayerSurface } from '../player/PlayerSurface'
import { useVideoAspect } from '../player/useVideoAspect'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { gameStatusLine, shortDate, winnerOf } from './format'

export interface GameScreenProps {
  client: GameStationClient
  gameId: string
  /** Which half to open on. A `Box Score` button means the box score. */
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
}

type Tab = 'watch' | 'boxScore'

/**
 * What a video is called on the picker.
 *
 * Never its file name. `2026-05-16 Hawks vs Black Sox raw` is a file on a
 * disk, not a thing a parent would say. What matters to somebody choosing is
 * whether they are about to see one view or several.
 */
function angleName(video: VideoSummary): string {
  return video.numCameras > 1
    ? lstrings.video_multi_angle
    : lstrings.video_primary
}

/**
 * Names for the picker, numbered only where they would otherwise repeat.
 *
 * Until a recording has been looked at it counts as one camera, so a game with
 * three of them offered `Video`, `Video` and `Video` — three buttons
 * that all claim to be the same thing. Numbering them says what is true: we
 * have three and do not yet know what they are.
 */
function angleNames(videos: VideoSummary[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const video of videos) {
    const name = angleName(video)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const video of videos) {
    const name = angleName(video)
    if ((counts.get(name) ?? 0) < 2) {
      out.set(video.id, name)
      continue
    }
    const nth = (seen.get(name) ?? 0) + 1
    seen.set(name, nth)
    out.set(video.id, `${name} ${nth}`)
  }
  return out
}

/**
 * The card's two stat lines, from the line score the plays produced.
 *
 * A side's defensive strikeouts are the other side's batters struck out, so
 * they are read across rather than counted again — the two lines of the card
 * check each other, and there is nothing new to store.
 *
 * `null` on a side means the plays were never counted. That is not none, and
 * the card draws nothing for it rather than a row of zeroes.
 */
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
    onTab
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { height, width } = useWindowDimensions()
  // One measured number: the header overlays the content, so the card clears
  // it with padding and the pegged player sticks below it.
  const { headerHeight } = useHeaderSlot()

  const [tab, setTab] = useState<Tab>(initialTab ?? 'watch')
  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [video, setVideo] = useState<VideoSummary | undefined>(undefined)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [withheld, setWithheld] = useState<string | null>(null)
  const [dropped, setDropped] = useState(0)
  const [box, setBox] = useState<BoxScoreData | undefined>(undefined)
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

  // The card's own content goes up into the header as the card scrolls away:
  // the away team over the home team, small, with their scores beside them.
  // The header carries nothing for this screen otherwise — the card says it
  // all while it is on the screen.
  // Half way down the card, because that is where the names and the scores
  // are: anchored at its bottom the copy arrived in the header well after the
  // words it copies had gone under it.
  const handoff = useHandoff(headerHeight, 0.5)
  /**
   * The highlights column runs to the bottom of the window, wherever it starts.
   *
   * A fixed height cut it off at the picture's lower edge while the card was
   * still on screen, so the rows ended in mid-air and the last of them could
   * not be reached until the card had gone. Its height is set from where it
   * actually is, on every scroll, which is cheap next to what the browser is
   * already doing to scroll.
   */
  const listRef = useRef<HTMLElement | null>(null)
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
  const fitList = useCallback(() => {
    const node = listRef.current
    if (node == null || typeof node.getBoundingClientRect !== 'function') return
    const room = window.innerHeight - node.getBoundingClientRect().top
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`
  }, [])
  const handleWatchScroll = useCallback(() => {
    handoff.handleScroll()
    fitList()
  }, [fitList, handoff])
  const progress = handoff.progress
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

  const playerRef = useRef<HTMLVideoElement | null>(null)

  // The box takes the video's own shape, read from the file, so there is
  // nothing left over for a black bar to fill. Until the browser knows, 16:9.
  const aspect = useVideoAspect(playerRef, video?.id)
  const mode = useRef<WatchMode>('stacked')
  const layout = watchLayout({
    width,
    height,
    // The header, the card and the pills all sit above the picture.
    chromeHeight: headerHeight + 180,
    aspect,
    previous: mode.current
  })
  mode.current = layout.mode
  const sideBySide = layout.mode === 'sideBySide'
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
   * player: coming back mounted a fresh `<video>` with the same chosen video,
   * so the attach effect — which fires only when the source changes — never
   * ran and the new element was never handed a manifest. It sat at
   * `readyState 0` with no source, and a highlight tap moved its timecode and
   * reported itself playing, so nothing on screen said anything was wrong.
   *
   * Attaching when the element is new *as well as* when the source is keeps
   * both halves: the narrow rule that stopped the restarts, and a player that
   * works after every mount.
   */
  const [playerNode, setPlayerNode] = useState<HTMLVideoElement | null>(null)
  const takePlayer = useCallback((node: HTMLVideoElement | null): void => {
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
  }, [client, video])

  // The app never builds a media URL: the server knows where the video is and
  // checks membership while it looks, so asking is the only way to find out.
  useEffect(() => {
    if (video == null) return
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
  }, [client, video])

  // Fetched when the tab is first opened, not with the game: most people come
  // here to watch, and the box score is a second query against every play.
  useEffect(() => {
    if (tab !== 'boxScore' || box != null) return
    let live = true
    client
      .boxScore(gameId)
      .then(rows => {
        if (live) setBox(rows)
      })
      .catch(() => {
        if (live) setBox({ batting: [], pitching: [] })
      })
    return () => {
      live = false
    }
  }, [box, client, gameId, tab])

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

  useEffect(() => {
    const element = playerNode
    if (element == null || playbackUrl == null) return
    const detach = attachHls(element, playbackUrl)

    const resume = resumeAtRef.current
    const { videoId, playbackFor: forId } = placeFor.current

    // Picking up where the other angle was, once the new source is attached.
    if (resume != null && resume.videoId === videoId && forId === videoId) {
      const apply = (): void => {
        element.currentTime = resume.sec
        if (resume.playing) element.play().catch(() => undefined)
        setResumeAt(undefined)
      }
      if (element.readyState >= 1) apply()
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
      if (element.readyState >= 1) jump()
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
  }, [playbackUrl, playerNode])

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
      playing: player.paused === false
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
  const scoreboard = (
    <GameHeroCard
      awayName={game.awayTeamName}
      homeName={game.homeTeamName}
      awayScore={game.awayScore}
      homeScore={game.homeScore}
      status={gameStatusLine(game)}
      winner={winnerOf(game)}
      compact
      awayRecord={game.awayRecord}
      homeRecord={game.homeRecord}
      awayLogoUrl={game.awayLogoUrl}
      homeLogoUrl={game.homeLogoUrl}
      date={shortDate(game.startAt)}
      venue={game.venue ?? undefined}
      teamStats={teamStatsOf(game.linescore)}
    />
  )

  const tabs = (
    <PillTabs
      tabs={[
        { id: 'watch', label: lstrings.game_videos },
        { id: 'boxScore', label: lstrings.game_box_score }
      ]}
      selected={tab}
      onSelect={next => {
        // Leaving the video unmounts it, so where it had got to is written
        // down here and picked up by the attach that follows the remount.
        // Without this you came back to the start of the game, which is a
        // poor reward for having looked at the box score.
        const player = playerRef.current
        if (next !== 'watch' && player != null && video != null) {
          setResumeAt({
            videoId: video.id,
            sec: player.currentTime,
            playing: player.paused === false
          })
        }
        setTab(next)
        onTab?.(next)
      }}
      size="compact"
      accessibilityLabel="Game sections"
    />
  )

  const description =
    chosen?.description == null || chosen.description === '' ? null : (
      // The same card as the angle names above it, and the same glass: the
      // two belong to the picture and sit under it, and a solid white panel
      // the width of the column read as a different kind of thing entirely.
      <View
        style={[
          styles.description,
          glassStyle(theme),
          { width: layout.videoWidth }
        ]}
      >
        <Text style={styles.descriptionText}>{chosen.description}</Text>
      </View>
    )

  const player = (
    <View style={styles.playerBlock}>
      <PlayerSurface
        videoRef={playerRef}
        width={layout.videoWidth}
        height={layout.videoHeight}
      >
        {video == null ? (
          <Text style={styles.message}>{lstrings.game_no_video}</Text>
        ) : playback == null ? (
          <ActivityIndicator color={theme.primaryTextColor} />
        ) : playback.url == null ? (
          // The row says there is a video and its files are not there. Saying
          // so beats a player that shows black and never explains itself.
          <Text style={styles.message}>{lstrings.game_video_unavailable}</Text>
        ) : (
          // Web only for now. A raw video element is right here: react-native-web
          // renders to the DOM, and the browser's own player is what gives us
          // hardware decoding for HEVC and H.264 alike.
          // The browser's own controls stay: they scrub, mute and go
          // fullscreen well, and the gesture layer is cut around them rather
          // than replacing them.
          <video
            ref={takePlayer}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
            controls
            playsInline
          />
        )}
      </PlayerSurface>

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
        <View
          style={[
            styles.videoPicker,
            glassStyle(theme),
            { width: layout.videoWidth }
          ]}
        >
          <PillTabs
            tabs={game.videos.map(item => {
              const name = pickerNames.get(item.id) ?? angleName(item)
              return {
                id: item.id,
                label:
                  item.status === 'ready'
                    ? name
                    : `${name} ${lstrings.game_video_gone_suffix}`
              }
            })}
            selected={video?.id ?? ''}
            onSelect={id => {
              const item = game.videos.find(one => one.id === id)
              if (item != null) switchAngle(item)
            }}
            accessibilityLabel="Camera angles"
          />
        </View>
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
              <Text
                style={[
                  styles.highlightTitle,
                  highlight.isScoringPlay ? styles.scoring : undefined
                ]}
                // Two lines in a grid cell: `Ground out: Benjamin W (2B) to
                // Isaac D (1B)` needs more than twice the width a quarter of a
                // desktop gives it, and a cut label names nobody.
                numberOfLines={2}
              >
                {highlight.title}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )

  // Two regions, not one scroll view: the card, the pills and the player are
  // fixed, and the highlights scroll underneath them. Reading to the bottom of
  // a long game must not take the video off the screen.
  if (tab === 'watch') {
    // One container, three children, always in this order. Stacked it is a
    // column that scrolls, with the player pegged under the header once the
    // card has gone by; side by side it is a wrapping row, where the card
    // takes the full width and the player and the list share the line below.
    //
    // The same parent and the same children in both, because the `<video>`
    // must not move in the tree: a layout that swapped one structure for
    // another would remount it and stop playback dead the moment a window
    // crossed the boundary.
    return (
      <Animated.ScrollView
        style={styles.watch}
        onScroll={handleWatchScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.watchContent,
          sideBySide ? styles.watchSplit : styles.watchStacked
        ]}
      >
        <View style={[styles.head, { paddingTop: headerHeight }]}>
          {/*
            The card alone is what hands its score up, not the block it shares
            with the pills: measured across both, the score only arrived once
            the pills had gone under too, which is long after the thing it is a
            copy of has left the screen.
          */}
          <View ref={handoff.ref}>{scoreboard}</View>
          <View
            onLayout={event => {
              setTabsHeight(event.nativeEvent.layout.height)
            }}
          >
            {tabs}
          </View>
        </View>

        {/*
          A plain div, not a `View`: `position: sticky` is a web value React
          Native has no name for, and react-native-web drops it on the way
          through style validation — the block simply scrolled away, which
          looks like a working peg right up until the card has gone. The app
          already renders DOM where it must, and this is the same seam.
        */}
        <div
          style={{
            // A raw div is content-box by default, unlike everything React
            // Native renders: without this the padding is added to the width
            // and the block runs past the edge of the screen.
            boxSizing: 'border-box',
            position: 'sticky',
            top: headerHeight,
            zIndex: 2,
            alignSelf: 'flex-start',
            display: 'flex',
            flexDirection: 'column',
            alignItems: sideBySide ? 'flex-start' : 'center',
            paddingLeft: sideBySide ? theme.rem(theme.spaceMdRem) : 0,
            width: sideBySide ? undefined : '100%'
            // Nothing painted here. The picture is opaque on its own and the
            // card below it is the glass; a tint on this block as well stacked
            // with the card's and turned it solid.
          }}
        >
          {player}
          {description}
        </div>

        {/*
          Its own scroller beside the video, bounded by the window: the page
          stops scrolling once the card has gone, and the list carries on
          against a video that has stopped moving.
        */}
        <div
          ref={node => {
            listRef.current = node
            // Once it exists, and again whenever the layout changes under it.
            if (node != null) requestAnimationFrame(fitList)
          }}
          style={{
            boxSizing: 'border-box',
            flexGrow: sideBySide ? 0 : 1,
            width: sideBySide ? layout.sideWidth : '100%',
            // The same inset as the picture, so a row and the picture share
            // their left and right edges and nothing appears beside the card
            // that is pegged over them.
            paddingLeft: sideBySide ? 0 : PHONE_MARGIN,
            paddingRight: sideBySide
              ? theme.rem(theme.spaceMdRem)
              : PHONE_MARGIN,
            // A starting value only; `fitList` measures the real one.
            maxHeight: sideBySide ? height - headerHeight : undefined,
            marginTop: sideBySide
              ? -(tabsHeight + theme.rem(theme.spaceSmRem))
              : 0,
            overflowY: sideBySide ? 'auto' : 'visible'
          }}
        >
          {highlightList}
        </div>
      </Animated.ScrollView>
    )
  }

  return (
    <ScrollView style={styles.screen}>
      <Screen wide scroll={false}>
        {scoreboard}
        {tabs}
        <BoxScore game={game} box={box} theme={theme} sideBySide={sideBySide} />
      </Screen>
    </ScrollView>
  )
}

interface BoxScoreProps {
  game: GameDetail
  /** `undefined` while it is still loading. */
  box: BoxScoreData | undefined
  theme: Theme
  /** Away and home side by side, rather than one at a time. */
  sideBySide: boolean
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
 * A side whose players were never imported has no lines to show. That is
 * common: an opponent invented from a name on somebody else's schedule has no
 * roster here, and its plays name nobody. The totals from the plays are still
 * true, so the line score above stands, and the table says plainly why it is
 * empty rather than showing nothing at all.
 */
function BoxScore(props: BoxScoreProps): React.ReactElement {
  const { game, box, theme, sideBySide } = props
  const styles = getStyles(theme)

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
    return (
      <View style={styles.boxSide}>
        <BattingTable name={side.name} rows={batting} theme={theme} />
        <PitchingTable name={side.name} rows={pitching} theme={theme} />
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
  // line and the batter's, not up here beside the innings.
  const totals = ['R', 'H', 'E', 'HR']

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
        <Text style={[styles.cellName, styles.cellHead]} numberOfLines={1} />
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
          <Text style={styles.cellName} numberOfLines={1}>
            {name}
          </Text>
          {Array.from({ length: innings }, (unused, index) => (
            <Text key={index} style={styles.cell}>
              {side.runs[index] ?? '–'}
            </Text>
          ))}
          <Text style={[styles.cell, styles.cellStrong]}>{side.r}</Text>
          <Text style={styles.cell}>{side.h ?? '–'}</Text>
          <Text style={styles.cell}>{side.e ?? '–'}</Text>
          <Text style={styles.cell}>{side.hr ?? '–'}</Text>
        </View>
      ))}
    </ScrollView>
  )
}

function BattingTable(props: {
  name: string
  rows: BattingRow[]
  theme: Theme
}): React.ReactElement {
  const { name, rows, theme } = props
  const styles = getStyles(theme)
  // Best day first, which is who somebody is looking for.
  const lines = [...rows].sort((a, b) =>
    b.h !== a.h ? b.h - a.h : b.pa - a.pa
  )
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_batting} — {name}
      </Text>
      {lines.length === 0 ? (
        <Text style={styles.message}>{lstrings.box_no_roster}</Text>
      ) : (
        <>
          <View style={[styles.tableRow, styles.tableHead]}>
            <Text style={[styles.cellName, styles.cellHead]}>
              {lstrings.stats_player}
            </Text>
            {battingColumns.map(column => (
              <Text key={column.label} style={[styles.cell, styles.cellHead]}>
                {column.label}
              </Text>
            ))}
          </View>
          {lines.map(line => (
            <View key={line.userId} style={styles.tableRow}>
              <Text style={styles.cellName} numberOfLines={1}>
                {line.shortName ?? ''}
              </Text>
              {battingColumns.map(column => (
                <Text key={column.label} style={styles.cell}>
                  {column.value(line)}
                </Text>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  )
}

function PitchingTable(props: {
  name: string
  rows: PitchingRow[]
  theme: Theme
}): React.ReactElement {
  const { name, rows, theme } = props
  const styles = getStyles(theme)
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_pitching} — {name}
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.message}>{lstrings.box_no_roster}</Text>
      ) : (
        <>
          <View style={[styles.tableRow, styles.tableHead]}>
            <Text style={[styles.cellName, styles.cellHead]}>
              {lstrings.stats_player}
            </Text>
            {pitchingColumns.map(column => (
              <Text key={column.label} style={[styles.cell, styles.cellHead]}>
                {column.label}
              </Text>
            ))}
          </View>
          {rows.map(line => (
            <View key={line.userId} style={styles.tableRow}>
              <Text style={styles.cellName} numberOfLines={1}>
                {line.shortName ?? ''}
              </Text>
              {pitchingColumns.map(column => (
                <Text key={column.label} style={styles.cell}>
                  {column.value(line)}
                </Text>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  )
}

const pitchingColumns: Array<{
  label: string
  value: (row: PitchingRow) => string
}> = [
  { label: 'IP', value: row => row.ip },
  { label: 'BF', value: row => String(row.bf) },
  { label: 'H', value: row => String(row.h) },
  { label: 'R', value: row => String(row.r) },
  { label: 'BB', value: row => String(row.bb) },
  { label: 'K', value: row => String(row.k) },
  { label: 'HR', value: row => String(row.hr) },
  { label: 'HBP', value: row => String(row.hbp) }
]

const battingColumns: Array<{
  label: string
  value: (row: BattingRow) => string
}> = [
  { label: lstrings.stats_at_bats, value: row => String(row.ab) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
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
    value: row => (row.seasonAvg == null ? '–' : average(row.seasonAvg))
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
    screen: { flex: 1, backgroundColor: theme.backgroundColor },
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
    watchContent: {
      // No padding here: the picture is edge to edge on a phone, so the
      // margins belong to the pieces either side of it rather than to the
      // column they share.
      paddingBottom: theme.rem(4.5),
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
    head: {
      width: '100%',
      paddingHorizontal: theme.rem(theme.spaceMdRem),
      gap: theme.rem(theme.spaceSmRem)
    },
    playerColumn: {
      gap: theme.rem(theme.spaceSmRem)
    },
    // Pegged under the header in both layouts, once the card and the pills
    // have gone by. `sticky` is a web position React Native has no name for;
    // this app renders to the DOM, and `webStyle` is the one place that cast
    // lives.
    pegged: {
      ...webStyle({ position: 'sticky' }),
      zIndex: 2,
      // Opaque, or the highlights show through as they pass underneath.
      backgroundColor: theme.backgroundColor
    },
    playerColumnStacked: {
      width: '100%',
      alignItems: 'center'
    },
    playerColumnSplit: {
      flexShrink: 1,
      paddingLeft: theme.rem(theme.spaceMdRem)
    },
    listColumn: {
      flexGrow: 1
    },
    listColumnStacked: {
      width: '100%',
      paddingHorizontal: theme.rem(theme.spaceMdRem)
    },
    listColumnSplit: {
      flexGrow: 0,
      paddingRight: theme.rem(theme.spaceMdRem),
      // Its own scroller: the highlights move beside a video that does not.
      ...webStyle({ overflowY: 'auto' })
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
    cellName: {
      color: theme.primaryTextColor,
      // Takes what is left and gives it up first: eight stat columns beside a
      // long name is what ran one table over the top of the next.
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: theme.rem(3.5),
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    cell: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8125),
      // Fixed, so the columns of two tables beside each other line up and
      // neither can push the other out of its half.
      width: theme.rem(2.1),
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
