import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { safetyGroups } from './chatModel'

/** Comparison order is row by row, left to right, on every platform. */
export function SafetyWordsGrid(props: {
  words: string | null | undefined
  label?: string
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      testID="chat-safety-number"
      accessibilityLabel={props.label}
      style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: theme.rem(0.5) }}
    >
      {safetyGroups(props.words ?? '—').map((word, index) => (
        <Text
          key={index}
          testID={'chat-safety-group-' + index}
          style={{
            width: '25%',
            textAlign: 'center',
            fontFamily: theme.semiBoldTextFont,
            fontSize: theme.rem(0.875),
            color: theme.primaryTextColor
          }}
        >
          {word}
        </Text>
      ))}
    </View>
  )
}
