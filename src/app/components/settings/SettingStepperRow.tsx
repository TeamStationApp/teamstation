import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../../theme/ThemeContext'
import { settingRowStyles } from './settingRowStyles'

/**
 * A setting that is one of a run of values, stepped through with − and +:
 * `Max Sits Per Game  − 1 +`. The steps are in order, so a run can end in a
 * word, as 2 to 6 then Unlimited does, or start with one, as Off, 1, 2 does.
 * Each button stops at its end of the run.
 */
export function SettingStepperRow<Value extends string | number>({
  label,
  steps,
  value,
  format = String,
  onChange,
  disabled = false
}: {
  /** The name, which may carry the value: `When ≥ 15 players present`. */
  label: string
  steps: readonly Value[]
  value: Value
  format?: (value: Value) => string
  onChange: (value: Value) => void
  disabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const row = settingRowStyles(theme)
  const styles = getStyles(theme)
  const at = steps.indexOf(value)
  const step = (by: number, word: string): React.ReactElement => {
    const next = steps[at + by]
    const inert = disabled || next == null
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sprintf(word, label)}
        accessibilityState={{ disabled: inert }}
        aria-disabled={inert}
        disabled={inert}
        onPress={() => {
          if (next != null) onChange(next)
        }}
        style={({ pressed }) => [
          styles.button,
          next == null && styles.end,
          pressed && styles.pressed
        ]}
      >
        <Text selectable={false} style={styles.sign}>
          {by < 0 ? '−' : '+'}
        </Text>
      </Pressable>
    )
  }
  return (
    <View
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={[row.row, disabled && row.gated]}
    >
      <View style={row.text}>
        <Text style={row.title}>{label}</Text>
      </View>
      <View style={styles.stepper}>
        {step(-1, lstrings.setting_stepper_decrease)}
        <Text
          accessibilityLabel={sprintf(
            lstrings.setting_stepper_value,
            label,
            format(value)
          )}
          style={styles.value}
        >
          {format(value)}
        </Text>
        {step(1, lstrings.setting_stepper_increase)}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  stepper: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.25)
  },
  button: {
    width: theme.rem(3),
    height: theme.rem(3),
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  end: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
  sign: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.375),
    color: theme.linkTextColor
  },
  value: {
    minWidth: theme.rem(2.5),
    textAlign: 'center' as const,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  }
}))
