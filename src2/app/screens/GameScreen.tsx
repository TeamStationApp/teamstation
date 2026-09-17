import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
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
import { PillTabs, Scoreboard } from '../components'
import { lstrings } from '../locales/strings'
import { attachHls } from '../player/attachHls'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { gameStatusLine, winnerOf } from './format'

export interface GameScreenProps {
  client: GameStationClient
  gameId: string
}

/** Wide enough for the highlight list to sit beside the video instead of under it. */
const SIDE_BY_SIDE_WIDTH = 900

type Tab = 'watch' | 'boxScore'

/**
 * One game: its videos, the highlights beside them, and the box score.
 *
 * A highlight is a **timestamp into the full video**, never a separate clip.
 * Pressing one seeks the player and keeps it playing, which is why the player
 * stays mounted while the list scrolls next to it.
 */
export function GameScreen(props: GameScreenProps): React.ReactElement {
  const { client, gameId } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  const sideBySide = width >= SIDE_BY_SIDE_WIDTH

  const [tab, setTab] = useState<Tab>('watch')
  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [video, setVideo] = useState<VideoSummary | undefined>(undefined)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [withheld, setWithheld] = useState<string | null>(null)
  const [batting, setBatting] = useState<BattingRow[] | undefined>(undefined)
  const [playback, setPlayback] = useState<Playback | undefined>(undefined)
  const [activeEventId, setActiveEventId] = useState<string | undefined>()
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

  const jumpTo = (highlight: Highlight): void => {
    setActiveEventId(highlight.eventId)
    const player = playerRef.current
    if (player == null) return
    // Seek and keep playing: the point is to watch on from here, not to show
    // a clip.
    player.currentTime = highlight.startOffsetSec
    // A browser may refuse to start playing without a gesture it recognises;
    // the seek has already happened, so that refusal is not worth reporting.
    player.play().catch(() => undefined)
  }

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
    <Scoreboard
      awayName={game.awayTeamName}
      homeName={game.homeTeamName}
      awayScore={game.awayScore}
      homeScore={game.homeScore}
      status={gameStatusLine(game)}
      winner={winnerOf(game)}
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

  const player = (
    <View style={styles.playerColumn}>
      <View style={styles.player}>
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
                setVideo(item)
              }}
            >
              <Text style={styles.tabText}>
                {item.status === 'ready'
                  ? item.title
                  : `${item.title} ${lstrings.game_video_gone_suffix}`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )

  const highlightList = (
    <View style={sideBySide ? styles.listColumn : undefined}>
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
        highlights.map(highlight => (
          <Pressable
            key={highlight.eventId}
            style={[
              styles.highlight,
              highlight.eventId === activeEventId
                ? styles.highlightActive
                : undefined
            ]}
            onPress={() => {
              jumpTo(highlight)
            }}
          >
            <Image
              // One frame of the play. It may not be cut yet the first time a
              // game is opened, in which case nothing is drawn and the row is
              // otherwise unchanged.
              source={{ uri: highlight.stillUrl }}
              style={styles.still}
            />
            <Text style={styles.timecode}>
              {timecode(highlight.startOffsetSec)}
            </Text>
            <Text
              style={[
                styles.highlightTitle,
                highlight.isScoringPlay ? styles.scoring : undefined
              ]}
              numberOfLines={2}
            >
              {highlight.title}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  )

  return (
    <ScrollView style={styles.screen}>
      {scoreboard}
      {tabs}
      {tab === 'watch' ? (
        <View style={sideBySide ? styles.watchWide : undefined}>
          {player}
          {highlightList}
        </View>
      ) : (
        <BoxScore game={game} rows={batting} theme={theme} />
      )}
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
                  {line.displayName ?? ''}
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
    watchWide: { flexDirection: 'row', alignItems: 'flex-start' },
    playerColumn: { flex: 2, maxWidth: theme.rem(45) },
    listColumn: { flex: 1, minWidth: theme.rem(16) },
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
    player: {
      width: '100%',
      aspectRatio: 16 / 9,
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
    highlight: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.highlightRowBackground,
      borderRadius: theme.rem(0.3),
      gap: theme.rem(0.75),
      marginHorizontal: theme.rem(0.75),
      marginTop: theme.rem(0.35),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.5)
    },
    highlightActive: { backgroundColor: theme.highlightRowActiveBackground },
    still: {
      aspectRatio: 16 / 9,
      backgroundColor: theme.videoBackgroundColor,
      borderRadius: theme.rem(0.2),
      width: theme.rem(5)
    },
    timecode: {
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.85),
      minWidth: theme.rem(3)
    },
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
