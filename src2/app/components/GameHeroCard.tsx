import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'
import { useBreakpoint } from './useBreakpoint'
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
    away: { r: number; h: number | null; e: number | null }
    home: { r: number; h: number | null; e: number | null }
  } | null
  /** `VEEH FIELD · WED, MAY 13`, above the score. */
  meta?: string
  /** `12–3`, under each team's name. */
  awayRecord?: string | null
  homeRecord?: string | null
  /** Each side's mark, beside its name. */
  awayLogoUrl?: string | null
  homeLogoUrl?: string | null
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
    linescore,
    meta,
    awayRecord,
    homeRecord,
    awayLogoUrl,
    homeLogoUrl
  } = props
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'

  const line =
    linescore == null ? null : (
      <View style={styles.line}>
        <Text style={styles.lineText}>{lineFor(awayName, linescore.away)}</Text>
        <Text style={styles.lineText}>{lineFor(homeName, linescore.home)}</Text>
      </View>
    )

  if (compact || posterUrl == null || posterUrl === '') {
    // A light card, not the dark panel: the panel was drawn for a screen with
    // nothing else on it, and against a pale background it reads as a hole.
    return (
      <View style={styles.card}>
        {meta != null && meta !== '' && (
          <View style={styles.meta}>
            <Text style={styles.metaText} numberOfLines={1}>
              {meta.toUpperCase()}
            </Text>
            <View style={styles.statusChip}>
              <Text style={styles.statusChipText}>{status}</Text>
            </View>
          </View>
        )}
        <View style={[styles.plain, narrow && styles.plainStacked]}>
          <ScoreLine
            name={awayName}
            score={awayScore}
            record={awayRecord}
            logoUrl={awayLogoUrl}
            note="Away"
            won={winner === 'away'}
            stacked={narrow}
          />
          {meta == null && <Text style={styles.plainStatus}>{status}</Text>}
          <ScoreLine
            name={homeName}
            score={homeScore}
            record={homeRecord}
            logoUrl={homeLogoUrl}
            note="Home"
            won={winner === 'home'}
            alignEnd={!narrow}
            stacked={narrow}
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

/**
 * `Hawks  4R · 7H · 1E`, leaving out what the plays cannot say.
 *
 * A game with only a final score on it has no hits *recorded*, which is not
 * the same as no hits. Printing `0H` there would be a claim about the game
 * rather than about our records.
 */
function lineFor(
  name: string,
  side: { r: number; h: number | null; e: number | null }
): string {
  const parts = [`${side.r}R`]
  if (side.h != null) parts.push(`${side.h}H`)
  if (side.e != null) parts.push(`${side.e}E`)
  return `${name}  ${parts.join(' · ')}`
}

function ScoreLine(props: {
  name: string
  score: number | null
  record?: string | null
  logoUrl?: string | null
  note: string
  won: boolean
  alignEnd?: boolean
  /** One side per line rather than two across, on a phone. */
  stacked?: boolean
}): React.ReactElement {
  const {
    name,
    score,
    record,
    logoUrl,
    note,
    won,
    alignEnd = false,
    stacked = false
  } = props
  const styles = getStyles(useTheme())
  const mark = <Emblem uri={logoUrl} fallback={initialsOf(name)} size={2} />
  return (
    <View
      style={[
        styles.side,
        alignEnd && styles.sideEnd,
        // `flex: 1` is flex-basis 0 as well, which in a column measures the
        // *height* — the two sides would collapse. Stacked, each is simply
        // as tall as it is.
        stacked && styles.sideStacked
      ]}
    >
      {!alignEnd && mark}
      <View
        style={[
          styles.sideText,
          alignEnd && styles.sideTextEnd,
          stacked && styles.sideTextStacked
        ]}
      >
        <Text style={styles.sideName} numberOfLines={1}>
          {name}
          {won ? ' ★' : ''}
        </Text>
        <Text style={styles.sideNote} numberOfLines={1}>
          {record == null || record === '' ? note : `${note} · ${record}`}
        </Text>
      </View>
      <Text style={[styles.sideScore, won && styles.sideScoreWon]}>
        {score ?? '–'}
      </Text>
      {alignEnd && mark}
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
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingTop: theme.rem(theme.spaceMdRem)
  },
  metaText: {
    flexShrink: 1,
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625)
  },
  statusChip: {
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125)
  },
  statusChipText: {
    color: theme.activeColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04)
  },
  // Two sides across a 390px phone left `Lake Mu…` against `Bandits (…` —
  // both names cut, and the full ones legible in the line score directly
  // below. Stacked they each get the whole width, away over home, which is
  // the order every other list on the screen uses.
  plainStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: theme.rem(theme.spaceSmRem)
  },
  plain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
  },
  sideText: {
    flexShrink: 1,
    gap: theme.rem(0.0625)
  },
  sideTextEnd: {
    alignItems: 'flex-end'
  },
  sideNote: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75)
  },
  sideScoreWon: {
    color: theme.activeColor
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
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  sideEnd: {
    justifyContent: 'flex-end'
  },
  sideStacked: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto'
  },
  sideTextStacked: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0
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
