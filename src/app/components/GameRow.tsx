import React, { useState } from 'react'
import { type LayoutChangeEvent, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { Icon } from './Icon'
import { thumbBox } from './thumbBox'
import { useBreakpoint } from './useBreakpoint'
import { VideoPoster } from './VideoPoster'

export interface GameRowProps {
  /** The away team, or the team whose page this is. */
  first: string
  /** `@ Black Sox` or `vs Tsunamis`. */
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
 * `NPLL 10U All Stars 2026 at MTLL 8-1…` told you nothing you did not already
 * know.
 *
 * The ground gets a fourth line when there is one, quieter than the rest. It
 * is not part of the height the picture is sized from. The 4:3 frame is
 * already taller than the three lines every row has, and the ground sits in
 * that space, so a row with a location is the same height as a row without one.
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
  // A phone has about 300px for the whole row. The picture keeps the width a
  // 16:9 frame of this text would have, and grows to 4:3, so the words stay
  // and the row gets taller.
  const narrow = useBreakpoint() === 'phone'
  // Two team lines, the detail line, and the two gaps, each line as tall as
  // its font, until the column reports its own height.
  const fallbackTextHeight =
    2 * theme.rem(1) + theme.rem(0.875) + 2 * theme.rem(0.0625)
  const [textHeight, setTextHeight] = useState(fallbackTextHeight)
  const frame = thumbBox(textHeight > 0 ? textHeight : fallbackTextHeight)
  const measureText = (event: LayoutChangeEvent): void => {
    const next = event.nativeEvent.layout.height
    if (next > 0) setTextHeight(next)
  }

  const content = (
    <>
      <VideoPoster
        uri={posterUrl}
        time={length}
        showPlay={posterUrl != null}
        aspect="4:3"
        frameWidth={frame.width}
      />
      <View style={styles.text}>
        <View style={styles.lines} onLayout={measureText}>
          <View style={styles.first}>
            <Text style={[styles.team, styles.firstName]} numberOfLines={1}>
              {first}
            </Text>
            {badgeLabel != null && (
              <Badge label={badgeLabel} tone={badgeTone} />
            )}
            {/*
              No chevron on a phone. The whole row is the target, the thumbnail
              already says it opens something, and those twenty pixels are the
              difference between reading the opponent's name and reading half of it.
            */}
            {onPress != null && !narrow && (
              <Icon name="chevron_right" color={theme.secondaryTextColor} />
            )}
          </View>
          <Text style={styles.team} numberOfLines={1}>
            {second}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
        {venue != null && venue !== '' && (
          <Text style={styles.venue} numberOfLines={1}>
            {venue}
          </Text>
        )}
      </View>
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
    // The column's height is its own text. A taller picture must not stretch
    // it, or the next measurement would chase the picture. Its width runs to
    // the card's trailing edge; the result shares only the first line.
    alignSelf: 'flex-start',
    gap: theme.rem(0.0625)
  },
  lines: {
    // This is the height the picture follows. The venue is a sibling, so a
    // ground does not make the thumbnail — or the row — any taller.
    gap: theme.rem(0.0625)
  },
  first: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  firstName: {
    flex: 1,
    minWidth: 0
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
