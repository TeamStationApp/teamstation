import React from 'react'
import { Pressable, Text, View } from 'react-native'
import Svg, { Circle, Line } from 'react-native-svg'

import {
  COMPACT_PILL_LABEL_REM,
  COMPACT_PILL_REM,
  compactPill,
  pillPadding,
  pillShadow
} from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The smallest a finger's target may be, in points. */
const TARGET_MIN = 44

/** The pill's height, in rem: the compact kind pill's 20 points. */
export const LOCATION_PILL_HEIGHT_REM = COMPACT_PILL_REM

/** Where a chosen location pill draws its circle and X, for its height. */
export interface LocationPillGeometry {
  height: number
  /** The circle's radius: 0.3 × the height, so 0.6 of it across. */
  radius: number
  /** The circle's centre in from the pill's right edge: half the height. */
  centreInset: number
  /** The circle's centre down from the pill's top: its vertical midline. */
  centreY: number
  /** The X's width and height: 40% of the circle's diameter. */
  markSpan: number
  /** The X's strokes, round-capped: as asked, and never below 1.5. */
  markStroke: number
  /** The X's tap target, square and centred on the circle. */
  target: number
}

/** A suggested pill's target reaches above and below it to 44 points tall. */
export function suggestedSlop(height: number): { top: number; bottom: number } {
  const reach = Math.max(0, (TARGET_MIN - height) / 2)
  return { top: reach, bottom: reach }
}

export function locationPillGeometry(
  height: number,
  stroke = 2
): LocationPillGeometry {
  const radius = 0.3 * height
  return {
    height,
    radius,
    centreInset: height / 2,
    centreY: height / 2,
    markSpan: 0.4 * radius * 2,
    markStroke: Math.max(1.5, stroke),
    target: Math.max(TARGET_MIN, radius * 2)
  }
}

/**
 * A place a search is narrowed to, as a pill the size, colors and lift of
 * the compact kind pill (`Badge`) on a search result.
 *
 * Chosen (`onRemove`), it sits inside the search field with a gray circle
 * at its right end holding a white X. Only the X removes it, through a
 * target of at least 44 points centred on the circle; a tap anywhere else on
 * the pill does nothing. Suggested (`onPress`), the whole pill chooses it.
 */
export function LocationPill({
  label,
  onRemove,
  onPress
}: {
  label: string
  onRemove?: () => void
  onPress?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const pillHeight = theme.rem(LOCATION_PILL_HEIGHT_REM)
  const geometry = locationPillGeometry(pillHeight, 0.05 * pillHeight)
  const { height, radius, centreInset, centreY, markSpan, markStroke, target } =
    geometry
  const text = (
    <Text style={styles.label} numberOfLines={1}>
      {label}
    </Text>
  )
  if (onRemove == null)
    return (
      <Pressable
        testID="location-pill"
        accessibilityRole="button"
        accessibilityLabel={`Choose ${label}`}
        onPress={onPress}
        // Pills sit side by side in their row, so only up and down reach to
        // a finger's target.
        hitSlop={suggestedSlop(height)}
        style={[styles.pill, styles.shell]}
      >
        {text}
      </Pressable>
    )
  const half = markSpan / 2
  return (
    <View
      testID="location-pill"
      style={[
        styles.pill,
        styles.shell,
        {
          paddingLeft: pillPadding(height),
          // Clear of the circle, with a little air before it.
          paddingRight: centreInset + radius + height / 4
        }
      ]}
    >
      {text}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: centreInset - radius,
          top: centreY - radius,
          width: radius * 2,
          height: radius * 2
        }}
      >
        <Svg
          testID="location-pill-mark"
          width={radius * 2}
          height={radius * 2}
          viewBox={`0 0 ${radius * 2} ${radius * 2}`}
        >
          <Circle
            cx={radius}
            cy={radius}
            r={radius}
            fill={theme.pillCloseColor}
          />
          <Line
            x1={radius - half}
            y1={radius - half}
            x2={radius + half}
            y2={radius + half}
            stroke={theme.pillCloseMarkColor}
            strokeWidth={markStroke}
            strokeLinecap="round"
          />
          <Line
            x1={radius + half}
            y1={radius - half}
            x2={radius - half}
            y2={radius + half}
            stroke={theme.pillCloseMarkColor}
            strokeWidth={markStroke}
            strokeLinecap="round"
          />
        </Svg>
      </View>
      <Pressable
        testID="location-pill-remove"
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label}`}
        onPress={onRemove}
        style={{
          position: 'absolute',
          right: centreInset - target / 2,
          top: centreY - target / 2,
          width: target,
          height: target
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pill: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: theme.neutralBadgeBackground,
    // No border: the circle and its target are placed from inside one, so
    // a border would push them off the pill's midline and in from its end.
    ...pillShadow(theme)
  },
  // The compact pill's height, ends and padding; a chosen pill widens its
  // right padding to clear the circle.
  shell: compactPill(theme),
  // Shrinks, and ellipsizes, when the field is narrow; the pill's height,
  // padding and circle stay as they are.
  label: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.neutralBadgeTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(COMPACT_PILL_LABEL_REM)
  }
}))
