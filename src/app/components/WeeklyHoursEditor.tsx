import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { WeekdayHours } from '../../common/venues'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { CancelAction } from './CancelAction'
import { TimePicker } from './EventScheduleFields'
import { Icon } from './Icon'
import { ListCard } from './ListCard'
import { PickerDialog } from './PickerDialog'
import { SegmentedPill } from './SegmentedPill'

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

/** "17:00" as "5:00 PM"; "24:00" is midnight. */
export function clockLabel(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  const h = hour % 24
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** A day's hours as a row reads them. */
export function hoursLabel(entry: WeekdayHours | undefined): string {
  return entry == null
    ? 'Closed'
    : `${clockLabel(entry.start)} – ${clockLabel(entry.end)}`
}

/** The hours a closed day takes when it is turned open, by default. */
export interface OpenDefault {
  /** "HH:MM". */
  start: string
  /** "HH:MM", after `start`. */
  end: string
}

/** A venue's or a field's day turned open: 9:00 AM to 5:00 PM. */
export const VENUE_OPEN_DEFAULT: OpenDefault = { start: '09:00', end: '17:00' }

/** A season's game window turned open: 5:00 PM to 9:00 PM. */
export const WINDOW_OPEN_DEFAULT: OpenDefault = { start: '17:00', end: '21:00' }

/**
 * A week of hours, one row per day. Tapping a day opens it: open or closed,
 * and when, in the 5-minute steps every time picker uses. A closed day turned
 * open starts at `openDefault`, a game window's 5:00 PM to 9:00 PM unless
 * it is given.
 */
export function WeeklyHoursEditor({
  value,
  onChange,
  disabled = false,
  label = 'Hours',
  openDefault = WINDOW_OPEN_DEFAULT
}: {
  value: WeekdayHours[]
  onChange: (hours: WeekdayHours[]) => void
  disabled?: boolean
  label?: string
  openDefault?: OpenDefault
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [day, setDay] = useState<number>()
  return (
    <View>
      <ListCard>
        {WEEKDAYS.map((name, weekday) => {
          const entry = value.find(item => item.weekday === weekday)
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${name}, ${hoursLabel(entry)}`}
              disabled={disabled}
              onPress={() => {
                setDay(weekday)
              }}
              style={styles.row}
            >
              <Text style={styles.day}>{name}</Text>
              <Text style={entry == null ? styles.closed : styles.hours}>
                {hoursLabel(entry)}
              </Text>
              {!disabled && <Icon name="chevron_right" size={1.25} />}
            </Pressable>
          )
        })}
      </ListCard>
      {day != null && (
        <DayHoursSheet
          weekday={day}
          entry={value.find(item => item.weekday === day)}
          openDefault={openDefault}
          onChoose={entry => {
            onChange(
              [
                ...value.filter(item => item.weekday !== day),
                ...(entry == null ? [] : [entry])
              ].sort((a, b) => a.weekday - b.weekday)
            )
            setDay(undefined)
          }}
          onCancel={() => {
            setDay(undefined)
          }}
        />
      )}
    </View>
  )
}

function DayHoursSheet({
  weekday,
  entry,
  openDefault,
  onChoose,
  onCancel
}: {
  weekday: number
  entry: WeekdayHours | undefined
  openDefault: OpenDefault
  onChoose: (entry: WeekdayHours | undefined) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [open, setOpen] = useState(entry != null)
  const [start, setStart] = useState(entry?.start ?? openDefault.start)
  const [end, setEnd] = useState(entry?.end ?? openDefault.end)
  const [picking, setPicking] = useState<'start' | 'end'>()
  const valid = !open || end === '24:00' || start < end
  if (picking != null)
    return (
      <PickerDialog onClose={onCancel}>
        <TimePicker
          value={picking === 'start' ? start : end === '24:00' ? '23:55' : end}
          onChoose={time => {
            if (picking === 'start') setStart(time)
            else setEnd(time)
            setPicking(undefined)
          }}
          onCancel={() => {
            setPicking(undefined)
          }}
        />
      </PickerDialog>
    )
  return (
    <PickerDialog onClose={onCancel}>
      <View style={styles.sheet}>
        <Text accessibilityRole="header" style={styles.title}>
          {WEEKDAYS[weekday]}
        </Text>
        <SegmentedPill
          options={[
            { id: 'open', label: 'Open' },
            { id: 'closed', label: 'Closed' }
          ]}
          selected={open ? 'open' : 'closed'}
          onSelect={id => {
            setOpen(id === 'open')
          }}
          accessibilityLabel={`${WEEKDAYS[weekday]} open or closed`}
        />
        {open && (
          <ListCard>
            {(['start', 'end'] as const).map(which => (
              <Pressable
                key={which}
                accessibilityRole="button"
                accessibilityLabel={`${which === 'start' ? 'Opens' : 'Closes'} ${clockLabel(which === 'start' ? start : end)}`}
                onPress={() => {
                  setPicking(which)
                }}
                style={styles.row}
              >
                <Text style={styles.day}>
                  {which === 'start' ? 'Opens' : 'Closes'}
                </Text>
                <Text style={styles.hours}>
                  {clockLabel(which === 'start' ? start : end)}
                </Text>
                <Icon name="chevron_right" size={1.25} />
              </Pressable>
            ))}
          </ListCard>
        )}
        {!valid && (
          <Text accessibilityRole="alert" style={styles.error}>
            The closing time must be after the opening time.
          </Text>
        )}
        <Button
          label="Done"
          disabled={!valid}
          onPress={() => {
            onChoose(open ? { weekday, start, end } : undefined)
          }}
        />
        <CancelAction onPress={onCancel} />
      </View>
    </PickerDialog>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(1),
    gap: theme.rem(0.5)
  },
  day: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  hours: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  closed: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  sheet: { gap: theme.rem(1) },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
