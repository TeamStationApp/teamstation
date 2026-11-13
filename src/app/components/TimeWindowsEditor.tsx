import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { monthDay } from '../../common/calendarDates'
import { addDays } from '../../common/fieldAvailability'
import { calendarDateText } from '../../common/groupCreation'
import { addWindowPeriod } from '../../common/seasonScheduling'
import {
  asWindowPeriods,
  LEGACY_WINDOW_START,
  type WindowPeriod
} from '../../common/windowPeriods'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ActionList, ActionRow } from './ActionRow'
import { dateLabel } from './BlackoutDatesEditor'
import { Button } from './Button'
import { DangerText } from './DangerText'
import { CalendarPicker } from './EventScheduleFields'
import { PickerDialog } from './PickerDialog'
import { VENUE_OPEN_DEFAULT, WeeklyHoursEditor } from './WeeklyHoursEditor'

type Choosing = { index: number; end: 'from' | 'until' } | 'add'

/** Dated weekly availability shared by venues, fields and seasons. */
export function TimeWindowsEditor({
  value,
  onChange,
  disabled = false,
  today = calendarDateText(new Date())!,
  endDate,
  label = 'Time Windows',
  openDefault = VENUE_OPEN_DEFAULT
}: {
  value: WindowPeriod[]
  onChange: (windows: WindowPeriod[]) => void
  disabled?: boolean
  today?: string
  endDate?: string
  label?: string
  openDefault?: { start: string; end: string }
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [choosing, setChoosing] = useState<Choosing | null>(null)
  const [error, setError] = useState('')
  const change = (windows: WindowPeriod[]): void => {
    try {
      asWindowPeriods(windows)
      setError('')
      onChange(windows)
    } catch (failure) {
      setError(`${(failure as Error).message}.`)
    }
  }
  const dateName = (day: string): string =>
    day === LEGACY_WINDOW_START ? 'Existing hours' : dateLabel(day)
  const chosen =
    choosing == null || choosing === 'add' ? undefined : value[choosing.index]
  const initial =
    choosing === 'add'
      ? value.at(-1)?.from
      : choosing?.end === 'from'
        ? chosen?.from
        : (chosen?.until ??
          (choosing != null && value[choosing.index + 1] != null
            ? addDays(value[choosing.index + 1].from, -1)
            : (endDate ?? today)))
  return (
    <View style={styles.editor}>
      {value.length === 0 && (
        <Text style={styles.meta}>
          No time windows. No games can be scheduled.
        </Text>
      )}
      {value.map((period, index) => (
        <View key={period.from} style={styles.editor}>
          <View style={styles.heading}>
            <Text style={styles.title}>
              {period.from === LEGACY_WINDOW_START
                ? 'Existing hours'
                : period.until == null
                  ? `From ${monthDay(period.from, period.from.slice(0, 4) !== today.slice(0, 4))}`
                  : `${monthDay(period.from, period.from.slice(0, 4) !== today.slice(0, 4))} – ${monthDay(period.until, period.until.slice(0, 4) !== today.slice(0, 4))}`}
            </Text>
            <DangerText
              label="Remove"
              accessibilityLabel={`Remove ${label} from ${dateName(period.from)}`}
              disabled={disabled}
              onPress={() => {
                change(value.filter((_, i) => i !== index))
              }}
            />
          </View>
          <ActionList bounded>
            <ActionRow
              title="Starts"
              detail={dateName(period.from)}
              openLabel={`Change the start of ${label} from ${dateName(period.from)}`}
              onOpen={
                disabled
                  ? undefined
                  : () => {
                      setChoosing({ index, end: 'from' })
                    }
              }
            />
            <ActionRow
              title="Ends"
              detail={
                period.until != null
                  ? dateName(period.until)
                  : index < value.length - 1
                    ? 'When the next period begins'
                    : endDate == null
                      ? 'No end date'
                      : 'End of season'
              }
              openLabel={`Change the end of ${label} from ${dateName(period.from)}`}
              onOpen={
                disabled
                  ? undefined
                  : () => {
                      setChoosing({ index, end: 'until' })
                    }
              }
            />
          </ActionList>
          <WeeklyHoursEditor
            label={`${label} from ${dateName(period.from)}`}
            value={period.hours}
            disabled={disabled}
            openDefault={openDefault}
            onChange={hours => {
              change(
                value.map((each, i) =>
                  i === index ? { ...each, hours } : each
                )
              )
            }}
          />
        </View>
      ))}
      {error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        label="Add another time window"
        kind="secondary"
        disabled={disabled}
        onPress={() => {
          if (value.length === 0) change([{ from: today, hours: [] }])
          else setChoosing('add')
        }}
      />
      {choosing != null && (
        <PickerDialog
          onClose={() => {
            setChoosing(null)
          }}
        >
          <CalendarPicker
            value={
              initial == null || initial === LEGACY_WINDOW_START
                ? today
                : initial
            }
            onCancel={() => {
              setChoosing(null)
            }}
            onChoose={date => {
              setChoosing(null)
              if (choosing === 'add') {
                if (value.some(period => period.from === date)) {
                  setError('A period already starts on that date.')
                  return
                }
                change(addWindowPeriod(value, date))
              } else
                change(
                  value
                    .map((period, i) =>
                      i === choosing.index
                        ? { ...period, [choosing.end]: date }
                        : period
                    )
                    .sort((a, b) => a.from.localeCompare(b.from))
                )
            }}
            other={
              choosing !== 'add' && choosing.end === 'until'
                ? {
                    label: 'No end date',
                    onPress: () => {
                      setChoosing(null)
                      change(
                        value.map((period, i) =>
                          i === choosing.index
                            ? { from: period.from, hours: period.hours }
                            : period
                        )
                      )
                    }
                  }
                : undefined
            }
          />
        </PickerDialog>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  editor: { gap: theme.rem(0.75) },
  heading: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  meta: { fontSize: theme.rem(0.9375), color: theme.secondaryTextColor },
  error: { fontSize: theme.rem(0.9375), color: theme.dangerColor }
}))
