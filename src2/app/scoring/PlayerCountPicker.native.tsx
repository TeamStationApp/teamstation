import { Picker } from '@react-native-picker/picker'
import React from 'react'
import { Platform, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  clampPlayerCount,
  PLAYER_COUNTS,
  type PlayerCountPickerProps
} from './playerCount'
import { PlayerCountWheel } from './PlayerCountWheel'

export function PlayerCountPicker(
  props: PlayerCountPickerProps
): React.ReactElement {
  const theme = useTheme()
  if (Platform.OS !== 'ios') return <PlayerCountWheel {...props} />
  return (
    <View style={{ alignSelf: 'center', width: 180 }}>
      <Picker
        accessibilityLabel="Number of placeholder players"
        selectedValue={props.value}
        onValueChange={value => {
          props.onChange(clampPlayerCount(Number(value)))
        }}
        itemStyle={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: 22
        }}
      >
        {PLAYER_COUNTS.map(count => (
          <Picker.Item key={count} label={String(count)} value={count} />
        ))}
      </Picker>
    </View>
  )
}
