import React, { useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { selectAllAfterFocus } from './GridNumberCell'

/** A blue number becomes a selected, outlined cell while it is edited. */
export function SpreadsheetNumber({
  label,
  value,
  maximum,
  disabled = false,
  onSave
}: {
  label: string
  value: number
  maximum: number
  disabled?: boolean
  onSave: (value: number) => Promise<void>
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const saving = useRef(false)
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const commit = async (): Promise<void> => {
    if (saving.current) return
    if (!/^\d+$/.test(draft.trim()) || Number(draft) > maximum) {
      setError(`Choose a maximum from 0 to ${maximum}.`)
      return
    }
    saving.current = true
    try {
      if (Number(draft) !== value) await onSave(Number(draft))
      setEditing(false)
      setError('')
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not save. Try again.'
      )
    } finally {
      saving.current = false
    }
  }
  return (
    <View>
      {editing ? (
        <TextInput
          ref={input}
          accessibilityLabel={label}
          value={draft}
          // As in GridNumberCell: selected a tick later as well for iOS.
          onFocus={() => {
            const chars = draft.length
            selectAllAfterFocus(input.current, () => chars)
          }}
          onChangeText={setDraft}
          autoFocus
          selectTextOnFocus
          keyboardType="number-pad"
          returnKeyType="done"
          editable={!disabled}
          style={[styles.target, styles.input]}
          onSubmitEditing={() => {
            commit().catch(() => undefined)
          }}
          onBlur={() => {
            commit().catch(() => undefined)
          }}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value}`}
          disabled={disabled}
          style={styles.target}
          onPress={() => {
            setDraft(String(value))
            setEditing(true)
          }}
        >
          <Text style={styles.value}>{value}</Text>
        </Pressable>
      )}
      {error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  target: {
    width: theme.rem(5),
    minHeight: theme.rem(3),
    justifyContent: 'center' as const,
    paddingHorizontal: theme.rem(0.5)
  },
  value: {
    color: theme.linkTextColor,
    fontSize: theme.rem(1),
    textAlign: 'right' as const
  },
  input: {
    borderWidth: 1,
    borderColor: theme.linkTextColor,
    borderRadius: theme.rem(0.25),
    color: theme.primaryTextColor,
    fontSize: theme.rem(1),
    textAlign: 'right' as const
  },
  error: {
    color: theme.dangerColor,
    maxWidth: theme.rem(12),
    fontSize: theme.rem(0.8125)
  }
}))
