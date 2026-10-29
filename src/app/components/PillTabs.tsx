import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useContentInset } from './contentInset'

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
   * `compact` is the size, everywhere. It does **not** shrink the target: the
   * pressable keeps its 48px height and the pill is drawn inside it.
   *
   * `regular` is kept only so the difference has a name; nothing uses it.
   *
   * `small` is the Yes / Maybe / No capsule's size, for the filter rows
   * stacked under a screen's tabs: a 32px pill in a 44px target, Apple's
   * minimum, with 4px of the target on each side and no gap between pills,
   * so each target reaches the midpoint to the next.
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
}

/**
 * The pill tab strip.
 *
 * The designs used this shape in four places and drew it four ways — a filled
 * dark pill on the team hub, an underline on the league hub, a bordered chip
 * for schedule filters, a segmented control on the game screen. Paul asked for
 * one of them, used everywhere, so this is it: the team hub's, because that is
 * the screen the palette came from.
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
  const {
    tabs,
    selected,
    onSelect,
    size = 'compact',
    bleed = true,
    dense = false,
    stacked = false
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const inset = useContentInset()
  // Drawn into the column's padding, the strip reaches the screen's edges and
  // a swiped pill goes all the way out; padded by the same amount inside, its
  // first pill still starts on the margin with everything else.
  const reach =
    bleed && (inset.left > 0 || inset.right > 0)
      ? {
          strip: { marginLeft: -inset.left, marginRight: -inset.right },
          content: { paddingLeft: inset.left, paddingRight: inset.right }
        }
      : undefined

  const row = (
    <View
      style={[
        styles.row,
        dense && styles.rowDense,
        size === 'small' && styles.rowSmall
      ]}
    >
      {tabs.map(tab => (
        <PillButton
          key={tab.id}
          label={tab.label}
          badge={tab.badge}
          live={tab.live}
          role={tab.role ?? 'tab'}
          selected={tab.id === selected}
          size={size}
          dense={dense}
          onPress={() => {
            onSelect(tab.id)
          }}
        />
      ))}
    </View>
  )

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={props.accessibilityLabel}
      style={reach?.strip}
      contentContainerStyle={[
        styles.scrollContent,
        stacked && styles.scrollStacked,
        reach?.content
      ]}
    >
      {row}
    </ScrollView>
  )
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
  accessibilityLabel = label
}: {
  label: string
  badge?: string
  live?: boolean
  selected?: boolean
  size?: 'regular' | 'compact' | 'small'
  dense?: boolean
  role?: 'tab' | 'button'
  onPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const compact = size === 'compact'
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
      style={({ pressed }) => [
        styles.target,
        small && styles.targetSmall,
        pressed && !selected && styles.targetPressed,
        disabled && styles.disabled
      ]}
    >
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
  scrollContent: {
    paddingHorizontal: theme.rem(theme.spaceXsRem),
    // Room for the shadow. Without it the strip's own overflow cuts the lift
    // off square, which looks like a rendering fault rather than a shadow.
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  rowDense: {
    gap: theme.rem(theme.spaceXsRem)
  },
  // Small pills carry their spacing in their targets: no gap, so a tap
  // between two pills lands on the nearer one. The row is pulled out by a
  // target's side, so the first pill, not its target, starts on the margin.
  rowSmall: {
    gap: 0,
    marginHorizontal: theme.rem(-0.25)
  },
  scrollStacked: {
    paddingVertical: 0
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
