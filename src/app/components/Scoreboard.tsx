import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface ScoreboardProps {
  awayName: string
  homeName: string
  awayScore: number | null
  homeScore: number | null
  /** `FINAL (6)`, `TOP 3RD`, `SAT 10:00 AM`. */
  status: string
  /** Which side won, so the winner can be marked. */
  winner?: 'away' | 'home'
}

/**
 * The dark panel a game's score is set on.
 *
 * Dark because it is the one thing on the screen that must be readable from
 * arm's length, and because everything around it is pale — inverting it is
 * cheaper than making the numerals enormous. The numerals are Space Grotesk at
 * weight 700, whose figures are near enough to monospaced that a column of
 * them lines up without a second font.
 *
 * A game with no score yet shows a dash rather than a zero, because 0–0 is a
 * real score and a game that has not started does not have one.
 */
export function Scoreboard(props: ScoreboardProps): React.ReactElement {
  const { awayName, homeName, awayScore, homeScore, status, winner } = props
  const styles = getStyles(useTheme())

  return (
    <View style={styles.board}>
      <Side
        name={awayName}
        score={awayScore}
        role="Away"
        won={winner === 'away'}
      />
      <View style={styles.middle}>
        <Text style={styles.status} numberOfLines={2}>
          {status}
        </Text>
      </View>
      <Side
        name={homeName}
        score={homeScore}
        role="Home"
        won={winner === 'home'}
        alignEnd
      />
    </View>
  )
}

function Side(props: {
  name: string
  score: number | null
  role: string
  won: boolean
  alignEnd?: boolean
}): React.ReactElement {
  const { name, score, role, won, alignEnd = false } = props
  const styles = getStyles(useTheme())
  return (
    <View style={[styles.side, alignEnd && styles.sideEnd]}>
      <Text style={styles.teamName} numberOfLines={2}>
        {name}
      </Text>
      <Text style={styles.score}>{score == null ? '–' : String(score)}</Text>
      <Text style={styles.role}>{won ? `${role} · Winner ★` : role}</Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  board: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    backgroundColor: theme.scoreboardBackground,
    borderRadius: theme.rem(theme.radiusRem),
    padding: theme.rem(theme.spaceLgRem)
  },
  side: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  sideEnd: {
    alignItems: 'flex-end'
  },
  middle: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  teamName: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.scoreboardAccentColor
  },
  score: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(2.25),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.scoreboardTextColor
  },
  role: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.scoreboardMutedTextColor
  },
  status: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04),
    textAlign: 'center',
    color: theme.scoreboardMutedTextColor
  }
}))
