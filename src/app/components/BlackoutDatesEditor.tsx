import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ActionList, ActionRow } from './ActionRow'
import { Button } from './Button'
import { DangerText } from './DangerText'
import { CalendarPicker } from './EventScheduleFields'
import { PickerDialog } from './PickerDialog'

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

/**
 * Blackout days: a list of dates, each removable, and a calendar to add one.
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
  return (
    <View style={styles.list}>
      {value.length === 0 ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : (
        <ActionList bounded>
          {value.map(date => (
            <ActionRow
              key={date}
              title={dateLabel(date)}
              end={
                disabled ? undefined : (
                  <DangerText
                    label="Remove"
                    accessibilityLabel={`Remove blackout ${dateLabel(date)}`}
                    onPress={() => {
                      onChange(value.filter(item => item !== date))
                    }}
                  />
                )
              }
            />
          ))}
        </ActionList>
      )}
      {!disabled && (
        <Button
          label="Add blackout day"
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
          <CalendarPicker
            value={today ?? new Date().toISOString().slice(0, 10)}
            onChoose={date => {
              onChange([...new Set([...value, date])].sort())
              setAdding(false)
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
  }
}))
