import React from 'react'
import { Switch, Text, View } from 'react-native'

import { useTheme } from '../../theme/ThemeContext'
import { settingRowStyles } from './settingRowStyles'

/**
 * A setting that is on or off: its name, an optional quieter line under it,
 * and a switch at the right. A row that cannot be changed is faint.
 */
export function SettingToggleRow({
  label,
  subtitle,
  accessibilityLabel = label,
  value,
  onChange,
  disabled = false,
  testID
}: {
  label: string
  subtitle?: string
  /** The switch's name, where the row's alone would repeat another row's. */
  accessibilityLabel?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  testID?: string
}): React.ReactElement {
  const styles = settingRowStyles(useTheme())
  return (
    <View
      testID={testID}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={[styles.row, disabled && styles.gated]}
    >
      <View style={styles.text}>
        <Text style={styles.title}>{label}</Text>
        {subtitle != null && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      <Switch
        accessibilityLabel={accessibilityLabel}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      />
    </View>
  )
}
