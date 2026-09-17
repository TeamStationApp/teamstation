import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
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
  /**
   * Draw the score plainly instead of over a picture.
   *
   * The game screen has the video itself a few pixels below, and a 16:9 frame
   * above a 16:9 player is two large pictures of the same game with the thing
   * you came for pushed off the bottom of the window.
   */
  compact?: boolean
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
    compact = false,
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

  if (compact || posterUrl == null || posterUrl === '') {
    // A light card, not the dark panel: the panel was drawn for a screen with
    // nothing else on it, and against a pale background it reads as a hole.
    return (
      <View style={styles.card}>
        <View style={styles.plain}>
          <ScoreLine
            name={awayName}
            score={awayScore}
            won={winner === 'away'}
          />
          <Text style={styles.plainStatus}>{status}</Text>
          <ScoreLine
            name={homeName}
            score={homeScore}
            won={winner === 'home'}
            alignEnd
          />
        </View>
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

function ScoreLine(props: {
  name: string
  score: number | null
  won: boolean
  alignEnd?: boolean
}): React.ReactElement {
  const { name, score, won, alignEnd = false } = props
  const styles = getStyles(useTheme())
  return (
    <View style={[styles.side, alignEnd && styles.sideEnd]}>
      <Text style={styles.sideName} numberOfLines={1}>
        {name}
        {won ? ' ★' : ''}
      </Text>
      <Text style={styles.sideScore}>{score ?? '–'}</Text>
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
  plain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
  },
  plainStatus: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04)
  },
  side: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.rem(theme.spaceSmRem)
  },
  sideEnd: {
    justifyContent: 'flex-end'
  },
  sideName: {
    color: theme.primaryTextColor,
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600'
  },
  sideScore: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.75),
    fontWeight: '700'
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
