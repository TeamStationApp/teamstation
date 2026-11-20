import React from 'react'
import { Pressable, TextInput, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ButtonIcon } from './ButtonIcon'
import { LocationPill } from './LocationPill'

/** The field's height before it is measured. */
export const SEARCH_FIELD_HEIGHT = 48

/**
 * The search field Search and Add Player share (`docs/ui-rules.md`, "A
 * search field floats at the bottom"): a leading search icon, a chosen
 * place's pill when there is one, the input, and a clear button while it
 * holds text. Its parent places it: at the top in a browser, in a
 * `SearchFieldDock` riding the keyboard on a phone or tablet.
 */
export function SearchField({
  testID,
  placeholder,
  value,
  onChangeText,
  place,
  disabled = false,
  autoCapitalize = 'none'
}: {
  testID: string
  /** Also the input's accessibility label. */
  placeholder: string
  value: string
  onChangeText: (text: string) => void
  /** A chosen place, drawn as a pill before the input, and how to take it out. */
  place?: { label: string; onRemove: () => void } | null
  disabled?: boolean
  autoCapitalize?: 'none' | 'words'
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const handleRemove = place?.onRemove
  return (
    <View testID={testID} style={[styles.field, disabled && styles.disabled]}>
      <ButtonIcon name="search" size={1.25} color={theme.secondaryTextColor} />
      {place != null && (
        <LocationPill label={place.label} onRemove={handleRemove} />
      )}
      <TextInput
        testID="search-field-input"
        accessibilityLabel={placeholder}
        placeholder={place == null ? placeholder : undefined}
        placeholderTextColor={theme.placeholderTextColor}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        // Backspace with nothing typed takes out the place before the
        // caret, as it would a character. The key arrives before the text
        // changes, so a press that deletes the last letter keeps the place.
        onKeyPress={event => {
          if (event.nativeEvent.key === 'Backspace' && value === '')
            handleRemove?.()
        }}
        autoCorrect={false}
        autoCapitalize={autoCapitalize}
        returnKeyType="search"
        style={styles.input}
      />
      {value !== '' && !disabled && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => {
            onChangeText('')
          }}
          style={styles.clear}
        >
          <ButtonIcon
            name="close"
            size={1.125}
            color={theme.secondaryTextColor}
          />
        </Pressable>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  field: {
    minHeight: SEARCH_FIELD_HEIGHT,
    paddingLeft: 14,
    paddingRight: 4,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    borderRadius: SEARCH_FIELD_HEIGHT / 2,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    shadowColor: theme.shadowColor,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5
  },
  disabled: { opacity: 0.5 },
  // The input takes all the width the pill leaves, up to the clear button,
  // and never less than 25% of the field: past that the pill's label
  // ellipsizes instead. Longer text scrolls to the caret.
  input: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 0,
    minWidth: '25%' as const,
    paddingHorizontal: 0,
    minHeight: 44,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 16
  },
  clear: {
    width: 44,
    height: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  }
}))
