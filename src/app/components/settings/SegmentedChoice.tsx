import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { pillPadding } from '../../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../../theme/ThemeContext'

/** The capsule's height in rem: 36 points. */
const HEIGHT_REM = 2.25
/** Points the target reaches above and below the capsule, to 48. */
const HIT_SLOP = 6

export interface SegmentedChoiceOption<Id> {
  id: Id
  label: string
}

/**
 * Two to four short choices on one line, one of them chosen: `3 · 6 · 9`,
 * `Always · Local Option · Never`. A radio group drawn as a capsule.
 *
 * `SegmentedPill` takes exactly two and slides between them; this takes up to
 * four, each as wide as its label needs and the spare width shared out, so a
 * longer label is never cut while a shorter one has room to give.
 */
export function SegmentedChoice<Id extends string | number>({
  options,
  selected,
  onSelect,
  accessibilityLabel,
  disabled = false
}: {
  options: ReadonlyArray<SegmentedChoiceOption<Id>>
  selected: Id
  onSelect: (id: Id) => void
  accessibilityLabel: string
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={styles.track}
    >
      {options.map(option => {
        const active = option.id === selected
        return (
          <Pressable
            key={String(option.id)}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: active, disabled }}
            aria-checked={active}
            disabled={disabled}
            hitSlop={{ top: HIT_SLOP, bottom: HIT_SLOP }}
            onPress={() => {
              if (!active) onSelect(option.id)
            }}
            style={[styles.option, active && styles.active]}
          >
            <Text
              numberOfLines={1}
              selectable={false}
              style={[styles.label, active && styles.activeLabel]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  track: {
    flexDirection: 'row' as const,
    alignSelf: 'stretch' as const,
    borderRadius: theme.radiusPill,
    backgroundColor: theme.sliderTrackBackground
  },
  option: {
    flexGrow: 1,
    height: theme.rem(HEIGHT_REM),
    paddingHorizontal: pillPadding(theme.rem(HEIGHT_REM)),
    borderRadius: theme.radiusPill,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  active: { backgroundColor: theme.pillActiveBackground },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.pillTextColor
  },
  activeLabel: { color: theme.pillActiveTextColor }
}))
