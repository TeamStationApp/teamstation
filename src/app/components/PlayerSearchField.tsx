import React from 'react'
import { Pressable, TextInput, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

/**
 * The floating bottom search field in the app theme (`docs/ui-rules.md`,
 * "A search field floats at the bottom"): a leading search icon, the
 * placeholder naming what it searches, and a clear button while it holds
 * text. Its parent places it at the bottom, above the keyboard.
 */
export function PlayerSearchField({
  value,
  onChangeText,
  disabled = false,
  placeholder = 'Search players'
}: {
  value: string
  onChangeText: (text: string) => void
  disabled?: boolean
  placeholder?: string
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      testID="Player search field"
      style={{
        minHeight: 48,
        paddingLeft: 14,
        paddingRight: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: theme.defaultBorderColor,
        backgroundColor: theme.cardBackgroundColor,
        shadowColor: '#000000',
        shadowOpacity: 0.18,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
        opacity: disabled ? 0.5 : 1
      }}
    >
      <Icon name="search" size={1.25} color={theme.secondaryTextColor} />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholderTextColor}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        autoCorrect={false}
        autoCapitalize="words"
        returnKeyType="search"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 44,
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: 16
        }}
      />
      {value !== '' && !disabled && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => {
            onChangeText('')
          }}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Icon name="close" size={1.125} color={theme.secondaryTextColor} />
        </Pressable>
      )}
    </View>
  )
}
