import React, { useEffect, useRef, useState } from 'react'
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
  BattingRow,
  GameDetail,
  GameStationClient,
  Highlight,
  Playback,
  VideoSummary
} from '../../common/api'
import { GameHeroCard, PillTabs, Screen, VideoPoster } from '../components'
import { highlightColumnsFor } from '../layout/grid'
import { lstrings } from '../locales/strings'
import { sameMoment } from '../player/angleSwitch'
import { attachHls } from '../player/attachHls'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { gameStatusLine, winnerOf } from './format'

export interface GameScreenProps {
  client: GameStationClient
  gameId: string
}

type Tab = 'watch' | 'boxScore'

/**
 * What a video is called on the picker.
 *
 * Never its file name. `2026-05-16 Hawks vs Bay Stars raw` is a file on a
 * disk, not a thing a parent would say. What matters to somebody choosing is
 * whether they are about to see one view or several.
 */
function angleName(video: VideoSummary): string {
  return video.numCameras > 1
    ? lstrings.video_multi_angle
    : lstrings.video_primary
}

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
  const { client, gameId } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { height, width } = useWindowDimensions()
  const columns = highlightColumnsFor(width)
  // Six tenths of the window: enough that the video is the screen, and little
  // enough that the highlights under it are visibly a list.
  const playerMaxHeight = Math.round(height * 0.6)

  const [tab, setTab] = useState<Tab>('watch')
  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [video, setVideo] = useState<VideoSummary | undefined>(undefined)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [withheld, setWithheld] = useState<string | null>(null)
  const [batting, setBatting] = useState<BattingRow[] | undefined>(undefined)
  const [playback, setPlayback] = useState<Playback | undefined>(undefined)
  const [activeEventId, setActiveEventId] = useState<string | undefined>()
  const [chosen, setChosen] = useState<Highlight | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const playerRef = useRef<HTMLVideoElement | null>(null)

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
        setVideo(
          found.videos.find(item => item.status === 'ready') ?? found.videos[0]
        )
      })
      .catch(() => {
        if (live) setError(lstrings.common_not_found)
      })
    return () => {
      live = false
    }
  }, [client, gameId])

  useEffect(() => {
    if (video == null) return
    let live = true
    client
      .highlights(video.id)
      .then(found => {
        if (!live) return
        setHighlights(found.highlights)
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
    let live = true
    setPlayback(undefined)
    client
      .playback(video.id)
      .then(found => {
        if (live) setPlayback(found)
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
    if (tab !== 'boxScore' || batting != null) return
    let live = true
    client
      .boxScore(gameId)
      .then(rows => {
        if (live) setBatting(rows)
      })
      .catch(() => {
        if (live) setBatting([])
      })
    return () => {
      live = false
    }
  }, [batting, client, gameId, tab])

  const playbackUrl = playback?.url ?? null
  useEffect(() => {
    const element = playerRef.current
    if (element == null || playbackUrl == null) return
    return attachHls(element, playbackUrl)
  }, [playbackUrl])

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
    const target = sameMoment(current, next, player.currentTime)
    const wasPlaying = player.paused === false
    setVideo(next)
    const restore = (): void => {
      player.removeEventListener('loadedmetadata', restore)
      player.currentTime = target
      if (wasPlaying) player.play().catch(() => undefined)
    }
    player.addEventListener('loadedmetadata', restore)
  }

  const jumpTo = (highlight: Highlight): void => {
    setActiveEventId(highlight.eventId)
    setChosen(highlight)
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
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>{error}</Text>
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

  const scoreboard = (
    <GameHeroCard
      awayName={game.awayTeamName}
      homeName={game.homeTeamName}
      awayScore={game.awayScore}
      homeScore={game.homeScore}
      status={gameStatusLine(game)}
      winner={winnerOf(game)}
      compact
      linescore={game.linescore}
      onPlay={() => {
        playerRef.current?.play().catch(() => undefined)
      }}
    />
  )

  const tabs = (
    <PillTabs
      tabs={[
        { id: 'watch', label: lstrings.game_videos },
        { id: 'boxScore', label: lstrings.game_box_score }
      ]}
      selected={tab}
      onSelect={setTab}
      stretch
      accessibilityLabel="Game sections"
    />
  )

  const description =
    chosen?.description == null || chosen.description === '' ? null : (
      <View style={styles.description}>
        <Text style={styles.descriptionText}>{chosen.description}</Text>
      </View>
    )

  const player = (
    <View>
      <View style={[styles.player, { maxHeight: playerMaxHeight }]}>
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
          <video
            ref={playerRef}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
            controls
            playsInline
          />
        )}
      </View>

      {game.videos.length > 1 ? (
        <View style={styles.videoPicker}>
          {game.videos.map(item => (
            <Pressable
              key={item.id}
              style={[
                styles.tab,
                item.id === video?.id ? styles.tabActive : undefined
              ]}
              onPress={() => {
                switchAngle(item)
              }}
            >
              <Text style={styles.tabText}>
                {item.status === 'ready'
                  ? angleName(item)
                  : `${angleName(item)} ${lstrings.game_video_gone_suffix}`}
              </Text>
            </Pressable>
          ))}
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
        <Text style={styles.message}>{lstrings.highlights_none}</Text>
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
                numberOfLines={1}
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
    return (
      <View style={styles.screen}>
        {/*
          A plain View, not a `Screen`: `Screen` fills whatever it is given,
          and two of them in a column each took half the height — which
          squeezed the 16:9 player into a strip across the top. This one is
          sized by its contents, and the list below takes what is left.
        */}
        <View style={styles.fixed}>
          {scoreboard}
          {tabs}
          {player}
          {description}
        </View>
        <ScrollView style={styles.scroller}>
          <View style={styles.scrolled}>{highlightList}</View>
        </ScrollView>
      </View>
    )
  }

  return (
    <ScrollView style={styles.screen}>
      <Screen wide scroll={false}>
        {scoreboard}
        {tabs}
        <BoxScore game={game} rows={batting} theme={theme} />
      </Screen>
    </ScrollView>
  )
}

interface BoxScoreProps {
  game: GameDetail
  /** `undefined` while it is still loading. */
  rows: BattingRow[] | undefined
  theme: Theme
}

/**
 * Batting, one table per side.
 *
 * There is no runs column and no line score: a run cannot be worked out from
 * the plays alone, so showing one would mean inventing it. Only what the plays
 * actually say is here.
 */
function BoxScore(props: BoxScoreProps): React.ReactElement {
  const { game, rows, theme } = props
  const styles = getStyles(theme)

  if (rows == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }
  if (rows.length === 0) {
    return <Text style={styles.message}>{lstrings.game_box_score_empty}</Text>
  }

  const sides = [
    { teamId: game.awayTeamId, name: game.awayTeamName },
    { teamId: game.homeTeamId, name: game.homeTeamName }
  ]

  return (
    <View style={styles.boxScore}>
      {sides.map(side => {
        // Best day first, which is who somebody is looking for.
        const lines = rows
          .filter(row => row.teamId === side.teamId)
          .sort((a, b) => (b.h !== a.h ? b.h - a.h : b.pa - a.pa))
        if (lines.length === 0) return null
        return (
          <View key={side.teamId} style={styles.table}>
            <Text style={styles.heading}>
              {lstrings.game_batting} — {side.name}
            </Text>
            <View style={[styles.tableRow, styles.tableHead]}>
              <Text style={[styles.cellName, styles.cellHead]}>
                {lstrings.stats_player}
              </Text>
              {statColumns.map(column => (
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
                {statColumns.map(column => (
                  <Text key={column.label} style={styles.cell}>
                    {column.value(line)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )
      })}
      <Text style={styles.footnote}>{lstrings.stats_runs_not_counted}</Text>
    </View>
  )
}

const statColumns: Array<{
  label: string
  value: (row: BattingRow) => string
}> = [
  { label: lstrings.stats_at_bats, value: row => String(row.ab) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
  { label: lstrings.stats_runs_batted_in, value: row => String(row.rbi) },
  { label: lstrings.stats_walks, value: row => String(row.bb) },
  { label: lstrings.stats_strikeouts, value: row => String(row.k) },
  { label: lstrings.stats_average, value: row => average(row.rates.avg) }
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
      paddingBottom: theme.rem(theme.spaceLgRem)
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
      backgroundColor: theme.highlightRowBackground,
      borderRadius: theme.rem(theme.radiusRem),
      padding: theme.rem(theme.spaceMdRem)
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
      flexDirection: 'row',
      gap: theme.rem(0.5),
      padding: theme.rem(0.5)
    },
    // Capped against the window, so a short one still shows some list to
    // scroll rather than one video and nothing else.
    player: {
      width: '100%',
      aspectRatio: 16 / 9,
      alignSelf: 'center',
      backgroundColor: theme.videoBackgroundColor,
      alignItems: 'center',
      justifyContent: 'center'
    },
    tab: {
      backgroundColor: theme.inactiveBackgroundColor,
      borderRadius: theme.rem(0.3),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.35)
    },
    tabActive: { backgroundColor: theme.primaryButtonColor },
    tabText: {
      color: theme.buttonTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
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
    boxScore: { maxWidth: theme.rem(34), paddingBottom: theme.rem(1) },
    table: { paddingBottom: theme.rem(0.5) },
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
      flex: 1,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    cell: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9),
      minWidth: theme.rem(2.6),
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
    message: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      padding: theme.rem(0.75),
      textAlign: 'center'
    }
  })
)
