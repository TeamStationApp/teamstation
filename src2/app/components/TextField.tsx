import React, { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface TextFieldProps {
  label: string
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  secure?: boolean
  autoFocus?: boolean
  keyboardType?: 'default' | 'email-address' | 'number-pad'
  autoComplete?: 'email' | 'current-password' | 'one-time-code' | 'off'
  /** Shown at the right of the label, e.g. "Forgot?". */
  action?: { label: string; onPress: () => void }
  error?: string
  onSubmitEditing?: () => void
}

/**
 * A labelled field.
 *
 * The label sits above rather than floating inside: a placeholder that doubles
 * as a label disappears exactly when somebody needs it, which on a sign-in form
 * being filled in one-handed at a ball field is most of the time.
 */
export function TextField(props: TextFieldProps): React.ReactElement {
  const {
    label,
    value,
    onChangeText,
    placeholder,
    secure = false,
    autoFocus = false,
    keyboardType = 'default',
    autoComplete = 'off',
    action,
    error,
    onSubmitEditing
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [focused, setFocused] = useState(false)

  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label.toUpperCase()}</Text>
        {action != null && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              action.onPress()
            }}
          >
            <Text style={styles.action}>{action.label}</Text>
          </Pressable>
        )}
      </View>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholderTextColor}
        secureTextEntry={secure}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => {
          setFocused(true)
        }}
        onBlur={() => {
          setFocused(false)
        }}
        style={[
          styles.input,
          focused && styles.inputFocused,
          error != null && styles.inputError
        ]}
      />
      {error != null && <Text style={styles.error}>{error}</Text>}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  field: {
    gap: theme.rem(theme.spaceSmRem)
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04),
    color: theme.primaryTextColor
  },
  action: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.activeColor
  },
  input: {
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  inputFocused: {
    borderWidth: 2,
    borderColor: theme.inputFocusBorderColor
  },
  inputError: {
    borderColor: theme.dangerColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.dangerColor
  }
}))
