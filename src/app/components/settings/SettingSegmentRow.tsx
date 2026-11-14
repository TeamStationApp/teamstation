import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../../theme/ThemeContext'
import { SegmentedPill, type SegmentedPillOption } from '../SegmentedPill'
import { settingRowStyles } from './settingRowStyles'

/**
 * A setting that is one of two to four short choices: its name, and an
 * optional quieter line under it, on the left, and the sliding pill at the
 * right, only as wide as its choices. A long name wraps; the pill never does.
 * Where the pill would leave the name less than `SETTING_NAME_MIN_REM`, as on
 * a 320- or 375-point screen, the pill takes its own line under the name,
 * still at the right, rather than break the name's words or take three lines.
 */
export function SettingSegmentRow<Id extends string | number>({
  label,
  subtitle,
  accessibilityLabel = label,
  options,
  selected,
  onSelect,
  disabled = false
}: {
  label: string
  subtitle?: string
  /** The pill's name, where the row's alone would repeat another row's. */
  accessibilityLabel?: string
  options: ReadonlyArray<SegmentedPillOption<Id>>
  selected: Id
  onSelect: (id: Id) => void
  disabled?: boolean
}): React.ReactElement {
  const styles = settingRowStyles(useTheme())
  return (
    <View
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={[styles.row, styles.wrapping, disabled && styles.gated]}
    >
      <View style={styles.wrappingText}>
        <Text style={styles.title}>{label}</Text>
        {subtitle != null && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      <SegmentedPill
        fit="content"
        accessibilityLabel={accessibilityLabel}
        options={options}
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
      />
    </View>
  )
}
