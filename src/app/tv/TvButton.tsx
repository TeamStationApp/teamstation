import React, { useState } from 'react'
import { Pressable, Text } from 'react-native'
export function TvButton({
  label,
  onPress,
  testID,
  preferred = false,
  onFocus
}: {
  label: string
  onPress: () => void
  testID?: string
  preferred?: boolean
  onFocus?: () => void
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...{ hasTVPreferredFocus: preferred }}
      onPress={onPress}
      onFocus={() => {
        setFocused(true)
        onFocus?.()
      }}
      onBlur={() => {
        setFocused(false)
      }}
      style={{
        minHeight: 64,
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 32,
        backgroundColor: focused ? '#fff' : '#34473c',
        borderWidth: 3,
        borderColor: focused ? '#b596ff' : 'transparent'
      }}
    >
      <Text
        style={{
          fontSize: 25,
          color: focused ? '#102318' : '#fff',
          fontWeight: '600'
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
