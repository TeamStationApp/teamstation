import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { blackoutRanges, type DateRange, rangeDates } from '../../common/venues'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ActionList, ActionRow } from './ActionRow'
import { Button } from './Button'
import { DangerText } from './DangerText'
import { DateRangePicker } from './DateRangePicker'
import { PickerDialog } from './PickerDialog'

/** The most days the blackouts of a season, venue or field can cover. */
const MOST_BLACKOUT_DAYS = 366

/** "2027-07-04" as "Sunday, July 4, 2027". */
export function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(`${date}T12:00:00Z`))
}

/** "2027-12-20" as "Dec 20". */
function monthDay(date: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  }).format(new Date(`${date}T12:00:00Z`))
}

/**
 * How a range of blackout days reads: "Dec 20 – Jan 2 · 14 days", or
 * "Apr 10" for one day, with its year, or years, beside it.
 */
export function blackoutRangeLabel({ from, to }: DateRange): {
  title: string
  detail: string
  spoken: string
} {
  if (from === to)
    return {
      title: monthDay(from),
      detail: from.slice(0, 4),
      spoken: dateLabel(from)
    }
  const days = rangeDates(from, to).length
  return {
    title: `${monthDay(from)} – ${monthDay(to)} · ${days} days`,
    detail:
      from.slice(0, 4) === to.slice(0, 4)
        ? from.slice(0, 4)
        : `${from.slice(0, 4)} – ${to.slice(0, 4)}`,
    spoken: `${dateLabel(from)} – ${dateLabel(to)}`
  }
}

/**
 * Blackout days listed as ranges of consecutive days, each removable when
 * `onRemove` is given.
 */
export function BlackoutRangeList({
  dates,
  onRemove
}: {
  dates: readonly string[]
  onRemove?: (range: DateRange) => void
}): React.ReactElement {
  return (
    <ActionList bounded>
      {blackoutRanges(dates).map(range => {
        const label = blackoutRangeLabel(range)
        return (
          <ActionRow
            key={range.from}
            title={label.title}
            detail={label.detail}
            end={
              onRemove == null ? undefined : (
                <DangerText
                  label="Remove"
                  accessibilityLabel={`Remove blackout ${label.spoken}`}
                  onPress={() => {
                    onRemove(range)
                  }}
                />
              )
            }
          />
        )
      })}
    </ActionList>
  )
}

/**
 * Blackout days, kept as a list of dates and shown as ranges: each range
 * removable as a whole, and a calendar that adds a range, or one day, at a
 * time. Ranges that touch or overlap join into one.
 */
export function BlackoutDatesEditor({
  value,
  onChange,
  disabled = false,
  empty = 'No blackout days.',
  today
}: {
  value: string[]
  onChange: (dates: string[]) => void
  disabled?: boolean
  empty?: string
  /** Where the calendar opens; today when left out. */
  today?: string
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [adding, setAdding] = useState(false)
  const [refused, setRefused] = useState(false)
  return (
    <View style={styles.list}>
      {value.length === 0 ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : (
        <BlackoutRangeList
          dates={value}
          onRemove={
            disabled
              ? undefined
              : ({ from, to }) => {
                  setRefused(false)
                  onChange(value.filter(date => date < from || date > to))
                }
          }
        />
      )}
      {refused && (
        <Text accessibilityRole="alert" style={styles.error}>
          Blackouts can cover at most {MOST_BLACKOUT_DAYS} days.
        </Text>
      )}
      {!disabled && (
        <Button
          label="Add blackout dates"
          kind="secondary"
          onPress={() => {
            setAdding(true)
          }}
        />
      )}
      {adding && (
        <PickerDialog
          onClose={() => {
            setAdding(false)
          }}
        >
          <DateRangePicker
            now={today == null ? undefined : new Date(`${today}T12:00:00`)}
            onChoose={({ startsOn, endsOn }) => {
              setAdding(false)
              const next = [
                ...new Set([...value, ...rangeDates(startsOn, endsOn)])
              ].sort()
              setRefused(next.length > MOST_BLACKOUT_DAYS)
              if (next.length <= MOST_BLACKOUT_DAYS) onChange(next)
            }}
            onCancel={() => {
              setAdding(false)
            }}
          />
        </PickerDialog>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  list: { gap: theme.rem(0.75) },
  empty: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  }
}))
