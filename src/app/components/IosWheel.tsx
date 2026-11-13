import { Picker } from '@react-native-picker/picker'
import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { WheelProps } from './wheelProps'

/**
 * The wheel on iOS: the system's spinning wheel (`UIPickerView`). It reports
 * the row once the wheel has settled on it, so the value it stops on is the
 * value the dialog holds. VoiceOver reads and adjusts it as the system's own.
 */
export function IosWheel({
  label,
  options,
  value,
  onChange,
  format = String,
  testID
}: WheelProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View style={styles.column}>
      <Text style={styles.label}>{label}</Text>
      <Picker
        testID={testID}
        accessibilityLabel={label}
        selectedValue={value}
        onValueChange={next => {
          onChange(Number(next))
        }}
        style={styles.picker}
        itemStyle={styles.item}
      >
        {options.map(option => (
          <Picker.Item key={option} label={format(option)} value={option} />
        ))}
      </Picker>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  column: { flex: 1, alignSelf: 'stretch' as const, gap: theme.rem(0.5) },
  // As wide as its column, which the dialog shares between its wheels: the
  // picker insets every row's label by 20 points each side, so a picker only
  // as wide as its longest option would cut every label to an ellipsis.
  picker: { alignSelf: 'stretch' as const },
  label: {
    alignSelf: 'center' as const,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  item: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor
  }
}))
