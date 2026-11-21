import React, { useState } from 'react'
import { Platform, Text, TextInput, View } from 'react-native'

import { EARLIEST_BIRTH_YEAR } from '../../common/age'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type AppleAge, withinAppleRange } from './declaredAge'

/** A year and a month of birth, or undefined while they are not both valid. */
export function birthOf(
  year: string,
  month: string,
  today: Date
): { year: number; month: number } | undefined {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month)) return undefined
  const y = Number(year)
  const m = Number(month)
  if (m < 1 || m > 12 || y < EARLIEST_BIRTH_YEAR) return undefined
  const now = today.getUTCFullYear() * 12 + today.getUTCMonth()
  if (y * 12 + m - 1 > now) return undefined
  return { year: y, month: m }
}

/** Puts `pattern` on a web field, so a phone's browser shows digits only. */
function digitsPattern(node: unknown): void {
  if (Platform.OS !== 'web') return
  ;(
    node as { setAttribute?: (name: string, value: string) => void } | null
  )?.setAttribute?.('pattern', '[0-9]*')
}

/**
 * The age modal's year and month of birth: two number fields, year first,
 * each asking a phone for its number keyboard (`inputMode="numeric"`) and
 * never `type="number"`, which adds arrows, takes `e`, and changes when
 * scrolled over. Save is offered only for a four-digit year, a month of 1 to
 * 12, a date not in the future, and one inside Apple's range when it gave
 * one. The native app's spinner (`AgeEntry.native.tsx`) takes its place.
 */
export function AgeEntry(props: {
  apple: AppleAge
  busy: boolean
  onSave: (birth: { year: number; month: number }) => void
  onBack: () => void
  today?: Date
}): React.ReactElement {
  const { apple, busy, onSave, onBack, today = new Date() } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [year, setYear] = useState('')
  const [month, setMonth] = useState('')
  const birth = birthOf(year, month, today)
  const valid = birth != null && withinAppleRange(apple, birth, today)
  const typed = year.length === 4 && month !== ''
  const digits = (text: string, most: number): string =>
    text.replace(/\D/g, '').slice(0, most)
  return (
    <View style={styles.entry}>
      <View style={styles.fields}>
        <View style={styles.field}>
          <Text style={styles.label}>{lstrings.chat_age_year}</Text>
          <TextInput
            ref={digitsPattern}
            testID="chat-age-year"
            accessibilityLabel={lstrings.chat_age_year}
            style={styles.input}
            value={year}
            inputMode="numeric"
            maxLength={4}
            placeholder="2010"
            placeholderTextColor={theme.secondaryTextColor}
            onChangeText={text => {
              setYear(digits(text, 4))
            }}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>{lstrings.chat_age_month}</Text>
          <TextInput
            ref={digitsPattern}
            testID="chat-age-month"
            accessibilityLabel={lstrings.chat_age_month}
            style={styles.input}
            value={month}
            inputMode="numeric"
            maxLength={2}
            placeholder="6"
            placeholderTextColor={theme.secondaryTextColor}
            onChangeText={text => {
              setMonth(digits(text, 2))
            }}
          />
        </View>
      </View>
      {typed && !valid && (
        <Text style={styles.invalid} accessibilityRole="alert">
          {lstrings.chat_age_invalid}
        </Text>
      )}
      <Button
        label={lstrings.chat_age_save}
        block
        busy={busy}
        disabled={!valid || busy}
        testID="chat-age-save"
        onPress={() => {
          if (birth != null && valid) onSave(birth)
        }}
      />
      <CancelAction
        label={lstrings.chat_age_back}
        testID="chat-age-back"
        onPress={onBack}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  entry: { gap: theme.rem(theme.spaceMdRem) },
  fields: { flexDirection: 'row', gap: theme.rem(theme.spaceMdRem) },
  field: { flex: 1, gap: theme.rem(0.25) },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  input: {
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    // 16 px or more, or Safari zooms the page when the field takes focus.
    fontSize: 16,
    color: theme.primaryTextColor
  },
  invalid: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
