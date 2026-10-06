import React from 'react'
import { Text, View } from 'react-native'

import { newPasswordRequirements } from '../../common/passwordProtocol'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { TextField } from './TextField'

export interface NewPasswordFieldsProps {
  password: string
  confirmation: string
  onPassword: (value: string) => void
  onConfirmation: (value: string) => void
}

/** Shared by every flow that creates a new password; login uses saved policy. */
export function NewPasswordFields(
  props: NewPasswordFieldsProps
): React.ReactElement {
  const { password, confirmation, onPassword, onConfirmation } = props
  const styles = getStyles(useTheme())
  const requirements = newPasswordRequirements(password)
  const rows = [
    { label: 'At least 8 characters', met: requirements.length, waived: false },
    {
      label: 'An uppercase letter',
      met: requirements.uppercase,
      waived: requirements.long
    },
    {
      label: 'A lowercase letter',
      met: requirements.lowercase,
      waived: requirements.long
    },
    { label: 'A number', met: requirements.number, waived: requirements.long }
  ]
  return (
    <>
      <TextField
        label="New password"
        value={password}
        onChangeText={onPassword}
        secure
        autoComplete="new-password"
      />
      <View style={styles.requirements}>
        {rows.map(row => {
          const done = row.met || row.waived
          const status = row.waived
            ? 'Not required with 17 or more characters'
            : row.met
              ? 'Complete'
              : 'Required'
          return (
            <Text
              key={row.label}
              accessibilityLabel={`${row.label}: ${status}`}
              style={[styles.requirement, done && styles.complete]}
            >
              {done ? '✓' : '•'} {row.label}
              {row.waived ? ' — not required' : ''}
            </Text>
          )
        })}
        <Text style={styles.hint}>
          With 17 or more characters, only length matters. No special character
          is needed.
        </Text>
        {requirements.tooLong && (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            Use at most 1024 UTF-8 bytes.
          </Text>
        )}
      </View>
      <TextField
        label="Confirm new password"
        value={confirmation}
        onChangeText={onConfirmation}
        secure
        autoComplete="new-password"
      />
      {confirmation !== '' && (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            styles.requirement,
            password === confirmation ? styles.complete : styles.error
          ]}
        >
          {password === confirmation
            ? '✓ Passwords match'
            : 'Passwords do not match'}
        </Text>
      )}
    </>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  requirements: { gap: 4 },
  requirement: {
    fontFamily: theme.regularTextFont,
    fontSize: 14,
    color: theme.secondaryTextColor
  },
  hint: {
    fontFamily: theme.regularTextFont,
    fontSize: 13,
    color: theme.secondaryTextColor,
    marginTop: 4
  },
  complete: { color: theme.successColor },
  error: { color: theme.dangerColor }
}))
