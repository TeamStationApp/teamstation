import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../../theme/ThemeContext'
import { SegmentedChoice, type SegmentedChoiceOption } from './SegmentedChoice'
import { settingRowStyles } from './settingRowStyles'

/**
 * A setting that is one of two to four short choices: its name, and the
 * choices on one line beneath it, the full width of the card.
 */
export function SettingSegmentRow<Id extends string | number>({
  label,
  options,
  selected,
  onSelect,
  disabled = false
}: {
  label: string
  options: ReadonlyArray<SegmentedChoiceOption<Id>>
  selected: Id
  onSelect: (id: Id) => void
  disabled?: boolean
}): React.ReactElement {
  const styles = settingRowStyles(useTheme())
  return (
    <View
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={[styles.stacked, disabled && styles.gated]}
    >
      <Text style={styles.title}>{label}</Text>
      <SegmentedChoice
        accessibilityLabel={label}
        options={options}
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
      />
    </View>
  )
}
