import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { Icon } from './Icon'
import { useBreakpoint } from './useBreakpoint'
import { VideoPoster } from './VideoPoster'

export interface GameRowProps {
  /** The away team, or the team whose page this is. */
  first: string
  /** `@ Bay Stars` or `vs Cyclones`. */
  second: string
  /** `Mon, Jun 22 · 4:45 PM · 2 videos`. */
  detail: string
  /** The ground, when it is known. Quieter, and on its own line. */
  venue?: string | null
  posterUrl?: string | null
  /** The video's whole length, `1:24:10`. */
  length?: string
  badgeLabel?: string
  badgeTone?: BadgeTone
  onPress?: () => void
}

/**
 * One game in a list of them.
 *
 * Three lines rather than the two a `ListRow` gives, because the two teams were
 * being crammed onto one with an `at` between them and truncated — and the half
 * that got cut was the opponent, which is the thing the reader is looking for.
 * `QPLL 10U All Stars 2026 at QPLL 8-1…` told you nothing you did not already
 * know.
 *
 * The ground gets a fourth line when there is one, quieter than the rest, and
 * reserves no space when there is not: rows of different heights are ordinary,
 * a row with a blank gap in it looks broken.
 */
export function GameRow(props: GameRowProps): React.ReactElement {
  const {
    first,
    second,
    detail,
    venue,
    posterUrl,
    length,
    badgeLabel,
    badgeTone,
    onPress
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  // A phone has about 300px for the whole row. A 7rem thumbnail left the words
  // roughly a hundred, which truncated the opponent and the date together —
  // the thing three lines were meant to stop.
  const narrow = useBreakpoint() === 'phone'

  const content = (
    <>
      <VideoPoster
        uri={posterUrl}
        time={length}
        showPlay={posterUrl != null}
        fillHeight
      />
      <View style={styles.text}>
        <Text style={styles.team} numberOfLines={1}>
          {first}
        </Text>
        <Text style={styles.team} numberOfLines={1}>
          {second}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
        {venue != null && venue !== '' && (
          <Text style={styles.venue} numberOfLines={1}>
            {venue}
          </Text>
        )}
      </View>
      {badgeLabel != null && <Badge label={badgeLabel} tone={badgeTone} />}
      {/*
        No chevron on a phone. The whole row is the target, the thumbnail
        already says it opens something, and those twenty pixels are the
        difference between reading the opponent's name and reading half of it.
      */}
      {onPress != null && !narrow && (
        <Icon name="chevron_right" color={theme.secondaryTextColor} />
      )}
    </>
  )

  if (onPress == null) return <View style={styles.row}>{content}</View>

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${first} ${second}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    // Stretch, so the picture takes the height of the row rather than being
    // sized by its width and leaving the rest of the row empty beside it.
    alignItems: 'stretch',
    gap: theme.rem(theme.spaceSmRem)
    // No padding of its own. Every row of this kind sits in a `Card`, whose
    // padding is already the margin on all four sides; adding more here made
    // the space above and below twice the space to the left, which is the
    // thing the eye notices.
  },
  pressed: {
    backgroundColor: theme.highlightRowActiveBackground
  },
  text: {
    flex: 1,
    gap: theme.rem(0.0625)
  },
  team: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  venue: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor,
    opacity: 0.8
  }
}))
