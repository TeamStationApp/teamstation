import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { TextField } from './TextField'

export function EventArrivalField({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View style={{ gap: theme.rem(0.5) }}>
      <TextField
        label="Arrival minutes (optional)"
        value={value}
        onChangeText={onChange}
        keyboardType="number-pad"
        disabled={disabled}
        placeholder="Leave blank to omit arrival time"
      />
      <Text
        style={{
          color: theme.secondaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: theme.rem(0.875)
        }}
      >
        Minutes prior to the event start time
      </Text>
    </View>
  )
}
