import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { formatDateRange } from '../../common/seasonTimeFrames'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface DateRangePickerProps {
  initial?: { startsOn: string; endsOn: string }
  now?: Date
  onChoose: (range: { startsOn: string; endsOn: string }) => void
  onCancel: () => void
}

/** Two calendar taps select an inclusive range, including a single day. */
export function DateRangePicker({
  initial,
  now = new Date(),
  onChoose,
  onCancel
}: DateRangePickerProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const anchor =
    initial == null ? now : new Date(initial.startsOn + 'T12:00:00')
  const [month, setMonth] = useState(
    new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  )
  const [start, setStart] = useState<string | undefined>(initial?.startsOn)
  const [end, setEnd] = useState<string | undefined>(initial?.endsOn)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const blanks = month.getDay()
  const choose = (day: string): void => {
    if (start == null || end != null || day < start) {
      setStart(day)
      setEnd(undefined)
    } else setEnd(day)
  }
  return (
    <View style={styles.calendar}>
      <Text style={styles.title}>
        {end == null
          ? start == null
            ? 'Choose the first day'
            : 'Choose the last day'
          : formatDateRange(start!, end)}
      </Text>
      <View style={styles.controls}>
        <Button
          label="Previous"
          accessibilityLabel="Previous month"
          compact
          kind="secondary"
          onPress={() => {
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }}
        />
        <Text style={styles.month}>
          {month.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric'
          })}
        </Text>
        <Button
          label="Next"
          accessibilityLabel="Next month"
          compact
          kind="secondary"
          onPress={() => {
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }}
        />
      </View>
      <View style={styles.grid}>
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
          <Text key={day} style={styles.weekday}>
            {day}
          </Text>
        ))}
        {Array.from({ length: blanks }, (_, index) => (
          <View key={`blank-${index}`} style={styles.day} />
        ))}
        {Array.from({ length: days }, (_, index) => {
          const day = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
          const selected =
            day === start ||
            day === end ||
            (start != null && end != null && day > start && day < end)
          return (
            <Pressable
              key={day}
              accessibilityRole="button"
              accessibilityLabel={day}
              accessibilityState={{ selected }}
              onPress={() => {
                choose(day)
              }}
              style={[
                styles.day,
                selected && styles.selected,
                day === start && styles.rangeStart,
                (day === end || (day === start && end == null)) &&
                  styles.rangeEnd
              ]}
            >
              <Text style={[styles.dayText, selected && styles.selectedText]}>
                {index + 1}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <Text style={styles.hint}>Both the first and last day are included.</Text>
      <Button
        label="Use this range"
        disabled={start == null || end == null}
        onPress={() => {
          if (start != null && end != null)
            onChoose({ startsOn: start, endsOn: end })
        }}
      />
      <Button label="Cancel" kind="secondary" onPress={onCancel} />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  calendar: {
    gap: theme.rem(1),
    maxWidth: 420,
    width: '100%' as const,
    alignSelf: 'center' as const
  },
  controls: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.5)
  },
  month: { fontSize: theme.rem(1), color: theme.primaryTextColor },
  title: {
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const },
  weekday: {
    width: '14.285714%' as const,
    textAlign: 'center' as const,
    color: theme.secondaryTextColor,
    padding: theme.rem(0.25)
  },
  day: {
    width: '14.285714%' as const,
    aspectRatio: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginVertical: theme.rem(0.125)
  },
  selected: {
    backgroundColor: '#1769d2'
  },
  rangeStart: {
    borderTopLeftRadius: theme.radiusPill,
    borderBottomLeftRadius: theme.radiusPill
  },
  rangeEnd: {
    borderTopRightRadius: theme.radiusPill,
    borderBottomRightRadius: theme.radiusPill
  },
  selectedText: { color: '#ffffff' },
  dayText: { fontSize: theme.rem(1), color: theme.primaryTextColor },
  hint: { fontSize: theme.rem(0.875), color: theme.secondaryTextColor }
}))
