import React from 'react'
import {
  Pressable,
  type StyleProp,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GlassTabs } from './GlassTabs'

export interface PillTab<Id extends string = string> {
  id: Id
  label: string
  role?: 'tab' | 'button'
  /** Shown after the label, e.g. a count of videos. */
  badge?: string
  /** Something happening now: a red dot before the label. */
  live?: boolean
}

export interface PillTabsProps<Id extends string = string> {
  tabs: Array<PillTab<Id>>
  selected: Id
  onSelect: (id: Id) => void
  /**
   * `compact` is the size, everywhere: a 36px pill in a 48px target, so the
   * target does **not** shrink with the pill. `regular` draws the same; it is
   * kept only so the difference has a name, and nothing uses it.
   *
   * `small` is the Yes / Maybe / No capsule's size, for the filter rows
   * stacked under a screen's tabs: a 32px pill in a 44px target, Apple's
   * minimum, with 4px of the target past the pill on each side and no gap
   * between targets, so each target reaches the midpoint to the next.
   */
  size?: 'regular' | 'compact' | 'small'
  accessibilityLabel?: string
  /**
   * Run past the column's padding to the edges of the screen, with the first
   * pill still on the margin (`ContentInset`). On by default; off for a
   * strip that belongs inside a panel of its own.
   */
  bleed?: boolean
  /**
   * Smaller gaps for a long strip. Label padding and the 48px targets stay
   * the same; a strip scrolls instead of squeezing a label into its arcs.
   */
  dense?: boolean
  /**
   * No padding above or below the strip, for rows stacked under one another:
   * with `small` pills, two rows' targets meet at the midpoint between them.
   */
  stacked?: boolean
  /**
   * The strip's own style, after its bleed: `{ flexGrow: 0 }` keeps it to
   * its pills' width in a row beside something else.
   */
  style?: StyleProp<ViewStyle>
}

/**
 * The pill tab strip: the glass tab strip (`GlassTabs`), bare labels and one
 * pill that slides to the selected tab — Liquid Glass tinted the strip's green
 * on iOS, the filled green pill elsewhere.
 *
 * The designs used this shape in four places and drew it four ways — a filled
 * dark pill on the team hub, an underline on the league hub, a bordered chip
 * for schedule filters, a segmented control on the game screen. Paul asked for
 * one of them, used everywhere, so this is it, on every strip, pinned or not.
 * `PillButton` keeps the filled pill for an action that stands alone.
 *
 * It scrolls sideways rather than wrapping or shrinking. Four tabs fit a phone;
 * a fifth would either wrap to a second line that looks like a mistake, or
 * squeeze the labels until they truncate. Scrolling keeps every tab the same
 * size whatever the window is doing. A strip that has five, such as a player's
 * page, is `dense`, so all five still fit a phone side by side.
 *
 * **One size, everywhere.** Paul picked the videos list's filter on
 * 2026-09-17 and asked for that exact pill on the team and season sections and
 * on a game's two halves. There was a `stretch` that shared a row out across
 * the width; nothing uses it now, so it is gone rather than left to be
 * rediscovered. A row that fills its width is a different control, and having
 * both was how the season page ended up drawing its sections and its filter
 * the same shape.
 */
export function PillTabs<Id extends string = string>(
  props: PillTabsProps<Id>
): React.ReactElement {
  return <GlassTabs {...props} />
}

export interface PillFaceProps {
  label: string
  badge?: string
  live?: boolean
  selected?: boolean
  size?: 'regular' | 'compact' | 'small'
  dense?: boolean
  /** Drawn before the label, inside the pill: a `ButtonIcon` or a vector. */
  icon?: React.ReactNode
}

/**
 * What a pill draws, without its target: `PillButton` wraps it in its own
 * pressable, and a `HeaderMenu` can wrap it as its trigger's face.
 */
export function PillFace({
  label,
  badge,
  live = false,
  selected = true,
  size = 'compact',
  dense = false,
  icon
}: PillFaceProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const compact = size === 'compact'
  const small = size === 'small'
  return (
    <View
      testID="settings-pill-tab"
      style={[
        styles.pill,
        compact && styles.pillCompact,
        small && styles.pillSmall,
        dense && styles.pillDense,
        selected ? styles.pillActive : styles.pillIdle
      ]}
    >
      {live && <View testID="pill-live-dot" style={styles.liveDot} />}
      {icon}
      <Text
        selectable={false}
        numberOfLines={1}
        style={[
          styles.label,
          compact && styles.labelCompact,
          small && styles.labelSmall,
          selected ? styles.labelActive : styles.labelIdle
        ]}
      >
        {label}
      </Text>
      {badge != null && (
        <Text
          style={[
            styles.badge,
            selected ? styles.labelActive : styles.badgeIdle
          ]}
        >
          {badge}
        </Text>
      )}
    </View>
  )
}

/** The colour a pill's label takes, for an icon drawn beside it. */
export function usePillLabelColor(selected = true): string {
  const theme = useTheme()
  return selected ? theme.pillActiveTextColor : theme.pillTextColor
}

/** The shared pill used by camera-angle tabs and standalone actions. */
export function PillButton({
  label,
  badge,
  live = false,
  selected = true,
  size = 'compact',
  dense = false,
  role = 'button',
  onPress,
  disabled = false,
  accessibilityLabel = label,
  testID,
  icon,
  hitSlop
}: PillFaceProps & {
  role?: 'tab' | 'button'
  onPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
  /** The pressable's own test id, for a pill that stands alone. */
  testID?: string
  /**
   * Draws the target only as tall as the pill, reaching this many points past
   * it, for a pill in a row of shorter buttons that must not grow the row.
   */
  hitSlop?: number
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const small = size === 'small'
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={
        role === 'tab' ? { selected, disabled } : { disabled }
      }
      aria-selected={role === 'tab' ? selected : undefined}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        styles.target,
        small && styles.targetSmall,
        hitSlop != null && styles.targetFlush,
        pressed && !selected && styles.targetPressed,
        disabled && styles.disabled
      ]}
    >
      <PillFace
        label={label}
        badge={badge}
        live={live}
        selected={selected}
        size={size}
        dense={dense}
        icon={icon}
      />
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  liveDot: {
    width: theme.rem(0.5),
    height: theme.rem(0.5),
    borderRadius: theme.rem(0.25),
    backgroundColor: theme.liveColor
  },
  // What the finger gets: 48 tall, which the spec asks for so a tab can be hit
  // one-handed while somebody is also holding a scorebook. It is transparent —
  // shrinking the pill is a drawing decision and must not shrink this.
  target: {
    minHeight: theme.rem(3),
    justifyContent: 'center'
  },
  // 44 tall, Apple's minimum, and 4 either side: half of the 8 between two
  // small pills, so neighbouring targets meet in the middle.
  targetSmall: {
    minHeight: theme.rem(2.75),
    paddingHorizontal: theme.rem(0.25)
  },
  // As tall as the pill; the target reaches past it by its hit slop instead.
  targetFlush: {
    minHeight: 0
  },
  disabled: {
    opacity: 0.5
  },
  targetPressed: {
    opacity: 0.85
  },
  // What the eye gets.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3),
    height: theme.rem(3),
    paddingHorizontal: pillPadding(theme.rem(3)),
    borderRadius: theme.radiusPill,
    // The same lift a button has, smaller to match the smaller shape: these
    // are buttons too, and a flat one beside a raised one reads as disabled.
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  pillCompact: {
    minHeight: theme.rem(2.25),
    height: theme.rem(2.25),
    paddingHorizontal: pillPadding(theme.rem(2.25))
  },
  // The RSVP capsule's: 32 tall, its 0.75rem label and 1.125rem sides.
  pillSmall: {
    minHeight: theme.rem(2),
    height: theme.rem(2),
    paddingHorizontal: theme.rem(1.125)
  },
  pillDense: {
    // Dense strips reduce their gaps, never the clearance around a label.
  },
  pillIdle: {
    backgroundColor: theme.pillBackground
  },
  pillPressed: {
    backgroundColor: theme.pillPressedBackground
  },
  pillActive: {
    backgroundColor: theme.pillActiveBackground
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  labelCompact: {
    fontSize: theme.rem(0.875)
  },
  labelSmall: {
    fontSize: theme.rem(0.75)
  },
  labelIdle: {
    color: theme.pillTextColor
  },
  labelActive: {
    color: theme.pillActiveTextColor
  },
  badge: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700'
  },
  badgeIdle: {
    color: theme.secondaryTextColor
  }
}))
