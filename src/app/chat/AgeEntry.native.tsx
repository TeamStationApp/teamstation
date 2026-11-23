import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { ageOn, EARLIEST_BIRTH_YEAR } from '../../common/age'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { Wheel } from '../components/Wheel'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { birthOf } from './birthMonth'
import { type AppleAge, withinAppleRange } from './declaredAge'

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/** Whether `year` and `month` are a birth month the modal may save today. */
function allowed(
  apple: AppleAge,
  year: number,
  month: number,
  today: Date
): boolean {
  const birth = birthOf(String(year), String(month), today)
  return birth != null && withinAppleRange(apple, birth, today)
}

/**
 * The years the year wheel offers: from `EARLIEST_BIRTH_YEAR` to this one,
 * or under Apple's 13 to 17 only those with a month whose age today could
 * lie in its range.
 */
export function birthYears(apple: AppleAge, today: Date): number[] {
  const years: number[] = []
  for (let y = EARLIEST_BIRTH_YEAR; y <= today.getUTCFullYear(); y++) {
    if (MONTHS.some(m => allowed(apple, y, m, today))) years.push(y)
  }
  return years
}

/** The option of `options` nearest `value`; `value` when there are none. */
function nearest(options: number[], value: number): number {
  return options.reduce(
    (best, option) =>
      Math.abs(option - value) < Math.abs(best - value) ? option : best,
    options[0] ?? value
  )
}

/**
 * The birth month the wheels first show: 10 years before this local year,
 * in this local month, or under Apple's 13 to 17 the nearest one in range
 * whose age the server gives (`ageOn`, which takes a birth month as not yet
 * come) is at least the range's lower bound. `years` are the year wheel's,
 * from `birthYears`.
 */
export function startingBirth(
  apple: AppleAge,
  today: Date,
  years: number[] = birthYears(apple, today)
): { year: number; month: number } {
  const lowest =
    typeof apple !== 'string' && apple.kind === 'minor' ? apple.lowerBound : 0
  const answer = (year: number, month: number): boolean =>
    allowed(apple, year, month, today) && ageOn(year, month, today) >= lowest
  const answering = years.filter(y => MONTHS.some(m => answer(y, m)))
  const year = nearest(
    answering.length > 0 ? answering : years,
    today.getFullYear() - 10
  )
  const month = nearest(
    MONTHS.filter(m => answer(year, m)),
    today.getMonth() + 1
  )
  return { year, month }
}

/**
 * The age modal's year and month of birth in the native app: two wheels,
 * year first, the system's spinning wheel on iOS and a scrolling column on
 * Android (`Wheel`), starting at `startingBirth`. The year wheel offers only
 * years Apple's range allows; the month wheel keeps all twelve, so its
 * column never changes under a scroll, and Save is offered only for a month
 * not in the future and inside the range. Without Apple's 13 to 17, Save
 * stays off until a wheel has been turned: that start (10 years ago) is
 * under 13, a place to turn from rather than an answer, and an answer under
 * 13 closes chat for good. Inside Apple's range the start is an answer
 * the server ages inside it too.
 */
export function AgeEntry(props: {
  apple: AppleAge
  busy: boolean
  onSave: (birth: { year: number; month: number }) => void
  onBack: () => void
  today?: Date
}): React.ReactElement {
  const { apple, busy, onSave, onBack, today = new Date() } = props
  const styles = getStyles(useTheme())
  const [years] = useState(() => birthYears(apple, today))
  const [birth, setBirth] = useState(() => startingBirth(apple, today, years))
  const ranged = typeof apple !== 'string' && apple.kind === 'minor'
  const [turned, setTurned] = useState(ranged)
  const valid = allowed(apple, birth.year, birth.month, today)
  const monthName = (month: number): string =>
    new Date(2000, month - 1, 1).toLocaleString(undefined, { month: 'long' })
  return (
    <View style={styles.entry}>
      <View style={styles.wheels} testID="chat-age-wheels">
        <Wheel
          label={lstrings.chat_age_year}
          testID="chat-age-year"
          options={years}
          value={birth.year}
          width={96}
          onChange={year => {
            // A wheel can report the row it already shows (a tap on it, a
            // drag let go where it began): only a change is an answer.
            if (year !== birth.year) setTurned(true)
            setBirth(({ month }) => ({ year, month }))
          }}
        />
        <Wheel
          label={lstrings.chat_age_month}
          testID="chat-age-month"
          options={MONTHS}
          value={birth.month}
          format={monthName}
          width={140}
          onChange={month => {
            if (month !== birth.month) setTurned(true)
            setBirth(({ year }) => ({ year, month }))
          }}
        />
      </View>
      <Text style={styles.chosen} testID="chat-age-chosen">
        {`${monthName(birth.month)} ${birth.year}`}
      </Text>
      {!valid && (
        <Text style={styles.invalid} accessibilityRole="alert">
          {lstrings.chat_age_invalid}
        </Text>
      )}
      <Button
        label={lstrings.chat_age_save}
        block
        busy={busy}
        disabled={busy || !valid || !turned}
        testID="chat-age-save"
        onPress={() => {
          if (valid && turned) onSave(birth)
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
  wheels: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  chosen: {
    alignSelf: 'center',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  invalid: {
    alignSelf: 'center',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
