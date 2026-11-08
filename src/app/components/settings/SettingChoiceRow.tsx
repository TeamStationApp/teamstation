import React, { useState } from 'react'
import { View } from 'react-native'

import { useTheme } from '../../theme/ThemeContext'
import { ChoiceSheet } from '../ChoiceSheet'
import { ListRow } from '../ListRow'
import { settingRowStyles } from './settingRowStyles'

/**
 * A setting whose choices are too long for one line: its name over the
 * choice it holds, with a chevron that opens the choices as rows.
 */
export function SettingChoiceRow<Id extends string | number>({
  label,
  options,
  selected,
  onSelect,
  disabled = false
}: {
  label: string
  options: ReadonlyArray<{ id: Id; label: string }>
  selected: Id
  onSelect: (id: Id) => void
  disabled?: boolean
}): React.ReactElement {
  const styles = settingRowStyles(useTheme())
  const [open, setOpen] = useState(false)
  const chosen = options.find(option => option.id === selected)
  return (
    <View
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={disabled && styles.gated}
    >
      <ListRow
        title={label}
        titleNumberOfLines={0}
        subtitle={chosen?.label}
        subtitleNumberOfLines={0}
        disabled={disabled}
        onPress={() => {
          setOpen(true)
        }}
      />
      {open && (
        <ChoiceSheet
          title={label}
          choices={options.map(option => ({
            label: option.label,
            selected: option.id === selected,
            onPress: () => {
              if (option.id !== selected) onSelect(option.id)
            }
          }))}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </View>
  )
}
