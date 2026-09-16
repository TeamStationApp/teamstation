import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'

import type {
  GameDetail,
  GameStationClient,
  Highlight,
  VideoSummary
} from '../../common/api'
import { lstrings } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface GameScreenProps {
  client: GameStationClient
  gameId: string
  /** Where this server serves HLS from, e.g. `https://tube2.…/media`. */
  mediaBaseUrl: string
}

/**
 * One game: its videos, and the highlights underneath them.
 *
 * A highlight is a **timestamp into the full video**, never a separate clip.
 * Pressing one seeks the player and keeps it playing, which is why the player
 * stays mounted above the list instead of being replaced.
 */
export function GameScreen(props: GameScreenProps): React.ReactElement {
  const { client, gameId, mediaBaseUrl } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [game, setGame] = useState<GameDetail | undefined>(undefined)
  const [video, setVideo] = useState<VideoSummary | undefined>(undefined)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [withheld, setWithheld] = useState<string | null>(null)
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
        setVideo(found.videos[0])
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

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.player}>
        {video == null ? (
          <Text style={styles.message}>{lstrings.game_no_video}</Text>
        ) : (
          // Web only for now. A raw video element is right here: react-native-web
          // renders to the DOM, and the browser's own player is what gives us
          // hardware decoding for HEVC and H.264 alike.
          <video
            ref={playerRef}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
            controls
            playsInline
            src={`${mediaBaseUrl}/${video.id}/master.m3u8`}
          />
        )}
      </View>

      {game.videos.length > 1 ? (
        <View style={styles.tabs}>
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
              <Text style={styles.tabText}>{item.kind}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Text style={styles.heading}>{lstrings.game_highlights}</Text>

      {withheld === 'scoreMismatch' ? (
        <Text style={styles.warning}>{lstrings.game_score_mismatch}</Text>
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
    </ScrollView>
  )
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
    player: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: theme.videoBackgroundColor,
      alignItems: 'center',
      justifyContent: 'center'
    },
    tabs: {
      flexDirection: 'row',
      gap: theme.rem(0.5),
      padding: theme.rem(0.5)
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
    timecode: {
      color: theme.clearButtonColor,
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
