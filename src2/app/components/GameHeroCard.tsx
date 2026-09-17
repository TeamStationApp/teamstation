import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Scoreboard } from './Scoreboard'
import { VideoPoster } from './VideoPoster'

export interface GameHeroCardProps {
  awayName: string
  homeName: string
  awayScore: number | null
  homeScore: number | null
  /** `FINAL`, `TOP 3RD`, `SAT 10:00 AM`. */
  status: string
  winner?: 'away' | 'home'
  /** A frame of the game's video. Absent until one has been cut. */
  posterUrl?: string | null
  onPlay?: () => void
  /** Runs, hits and errors per side, when they have been counted. */
  linescore?: {
    away: { r: number; h: number; e: number }
    home: { r: number; h: number; e: number }
  } | null
}

/**
 * The card that stands for a game: its own picture, with the score on it.
 *
 * One component in both places it appears — the recent game on the home
 * screen and the top of a game — because they are the same card. What differs
 * is only what sits under it, which is the caller's business.
 *
 * A game that was never filmed keeps the dark panel. That is not a fallback
 * but a designed state: plenty of games are scored and never recorded, and a
 * panel says the score plainly where an empty grey rectangle would say
 * nothing at all.
 */
export function GameHeroCard(props: GameHeroCardProps): React.ReactElement {
  const {
    awayName,
    homeName,
    awayScore,
    homeScore,
    status,
    winner,
    posterUrl,
    onPlay,
    linescore
  } = props
  const styles = getStyles(useTheme())

  const line =
    linescore == null ? null : (
      <View style={styles.line}>
        <Text style={styles.lineText}>
          {`${awayName}  ${linescore.away.r}R · ${linescore.away.h}H · ${linescore.away.e}E`}
        </Text>
        <Text style={styles.lineText}>
          {`${homeName}  ${linescore.home.r}R · ${linescore.home.h}H · ${linescore.home.e}E`}
        </Text>
      </View>
    )

  if (posterUrl == null || posterUrl === '') {
    return (
      <View style={styles.card}>
        <Scoreboard
          awayName={awayName}
          homeName={homeName}
          awayScore={awayScore}
          homeScore={homeScore}
          status={status}
          winner={winner}
        />
        {line}
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <VideoPoster uri={posterUrl} size="hero" showPlay onPlay={onPlay}>
        <View style={styles.over}>
          <Text style={styles.team} numberOfLines={1}>
            {`${awayName} ${awayScore ?? ''}`.trim()}
          </Text>
          <Text style={styles.team} numberOfLines={1}>
            {`${homeName} ${homeScore ?? ''}`.trim()}
          </Text>
          <Text style={styles.status}>{status}</Text>
        </View>
      </VideoPoster>
      {line}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    overflow: 'hidden'
  },
  over: {
    gap: theme.rem(0.0625)
  },
  team: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700'
  },
  status: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04),
    opacity: 0.85
  },
  line: {
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
  }
}))
