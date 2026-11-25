import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { ButtonIcon } from '../components/ButtonIcon'
import { CalendarPicker, TimePicker } from '../components/EventScheduleFields'
import { PickerDialog } from '../components/PickerDialog'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { SponsorDateTimeFieldProps } from './sponsorViewProps'

/** Today in the device's zone, `YYYY-MM-DD`. */
function today(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The time chosen before a date is: noon. */
const DEFAULT_TIME = '12:00'

function clock(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

/**
 * The sponsored row's date and time on a phone: a Date and a Time row, each
 * opening the app's calendar or time picker, as an event's schedule does.
 * The value is the same local `YYYY-MM-DDTHH:mm` the web's input gives.
 */
export function SponsorDateTimeField({
  value,
  onChange
}: SponsorDateTimeFieldProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [picker, setPicker] = useState<'date' | 'time' | null>(null)
  const [date, time] = value === '' ? ['', ''] : value.split('T')
  const row = (
    key: 'date' | 'time',
    label: string,
    text: string
  ): React.ReactElement => (
    <Pressable
      testID={`sponsor-starts-${key}`}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${text}`}
      onPress={() => {
        setPicker(key)
      }}
      style={styles.button}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={text === '' ? styles.placeholder : styles.value}>
        {text === '' ? `Choose a ${key}` : text}
      </Text>
      <ButtonIcon name="chevron_right" />
    </Pressable>
  )
  const close = (): void => {
    setPicker(null)
  }
  return (
    <View style={styles.fields}>
      {row('date', 'Date', date)}
      {row('time', 'Time', time === '' ? '' : clock(time))}
      {picker != null && (
        <PickerDialog onClose={close}>
          {picker === 'date' ? (
            <CalendarPicker
              value={date === '' ? today() : date}
              onChoose={chosen => {
                onChange(`${chosen}T${time === '' ? DEFAULT_TIME : time}`)
                close()
              }}
              onCancel={close}
            />
          ) : (
            <TimePicker
              value={time === '' ? DEFAULT_TIME : time}
              onChoose={chosen => {
                onChange(`${date === '' ? today() : date}T${chosen}`)
                close()
              }}
              onCancel={close}
            />
          )}
        </PickerDialog>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fields: { gap: theme.rem(0.5) },
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    paddingHorizontal: theme.rem(0.75),
    borderRadius: theme.rem(0.5),
    borderWidth: 1,
    borderColor: theme.inputBorderColor,
    backgroundColor: theme.inputBackgroundColor
  },
  label: {
    width: theme.rem(3.5),
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875)
  },
  value: {
    flex: 1,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  placeholder: {
    flex: 1,
    color: theme.placeholderTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  }
}))
