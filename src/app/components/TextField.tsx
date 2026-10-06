import React, { useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

export interface TextFieldProps {
  label: string
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  secure?: boolean
  autoFocus?: boolean
  keyboardType?: 'default' | 'email-address' | 'number-pad'
  autoComplete?:
    'email' | 'current-password' | 'new-password' | 'one-time-code' | 'off'
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
 *
 * A field with something in it carries a × to empty it. It appears only when
 * there is something to clear, so an empty form is not a row of buttons that
 * do nothing, and it is a disc rather than a bare glyph because a bare × over
 * a typed address reads as part of the text.
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
      <View style={styles.inputRow}>
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
          // `one-time-code` is iOS's name for it and Android's is `sms-otp`;
          // give Android the wrong one and the code it has just received is
          // not offered above the keyboard, which is the whole point of
          // saying what the field is for.
          autoComplete={
            autoComplete === 'one-time-code'
              ? Platform.select({
                  ios: 'one-time-code',
                  default: 'sms-otp' as const
                })
              : autoComplete
          }
          // A field with somewhere to submit to says so on the key. The
          // default is a return arrow, which on a sign-in form looks like it
          // will add a line to a single-line field.
          returnKeyType={onSubmitEditing == null ? 'done' : 'go'}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => {
            setFocused(true)
          }}
          onBlur={() => {
            setFocused(false)
          }}
          style={[
            styles.input,
            value !== '' && styles.inputWithClear,
            focused && styles.inputFocused,
            error != null && styles.inputError
          ]}
        />
        {value !== '' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            onPress={() => {
              onChangeText('')
            }}
            style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
          >
            <Icon name="close" size={0.875} color={theme.clearIconColor} />
          </Pressable>
        )}
      </View>
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
  inputRow: {
    justifyContent: 'center'
  },
  clear: {
    position: 'absolute',
    right: theme.rem(theme.spaceSmRem),
    width: theme.rem(1.375),
    height: theme.rem(1.375),
    borderRadius: theme.rem(0.6875),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.clearIconBackgroundColor
  },
  pressed: {
    opacity: 0.6
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
  inputWithClear: {
    // Room for the disc, so a long address does not run under it.
    paddingRight: theme.rem(2.5)
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
