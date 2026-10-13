import React, { useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import {
  changeEventSchedule,
  type EventScheduleDraft,
  eventScheduleValue
} from '../../common/eventSchedule'
import { nearestFiveMinutes, viewerTimezone } from '../../common/eventTime'
import timezones from '../../common/eventTimezones.json'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Icon } from './Icon'
import { TextField } from './TextField'

type Picker = 'date' | 'time' | 'endDate' | 'endTime' | 'timezone'

export function EventScheduleFields({
  value,
  onChange,
  disabled = false
}: {
  value: EventScheduleDraft
  onChange: (value: EventScheduleDraft) => void
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [picker, setPicker] = useState<Picker>()
  const update = (change: Parameters<typeof changeEventSchedule>[1]): void => {
    onChange(changeEventSchedule(value, change))
  }
  const field = (
    key: Picker,
    label: string,
    text: string
  ): React.ReactElement => (
    <View style={styles.field}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <Pressable
        testID={`event-schedule-${key}`}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${text}`}
        disabled={disabled}
        onPress={() => {
          setPicker(key)
        }}
        style={styles.fieldButton}
      >
        <Text style={styles.value}>{text}</Text>
        <Icon name="chevron_right" />
      </Pressable>
    </View>
  )
  const toggle = (label: string, action: () => void): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={action}
      style={styles.link}
    >
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  )
  let error = ''
  try {
    eventScheduleValue(value)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Choose a valid schedule'
  }
  return (
    <View style={styles.fields}>
      {field('date', 'Date', value.date)}
      {value.hasEndDate ? (
        <>
          {field('endDate', 'End date', value.endDate)}
          {toggle('Remove end date', () => {
            update({ hasEndDate: false })
          })}
        </>
      ) : (
        toggle('Set end date', () => {
          update({ hasEndDate: true })
        })
      )}
      {field('time', 'Start time', displayClock(value.time))}
      {value.hasEndTime ? (
        <>
          {field('endTime', 'End time', displayClock(value.endTime))}
          {toggle('Remove end time', () => {
            update({ hasEndTime: false })
          })}
        </>
      ) : (
        toggle('Set end time', () => {
          update({ hasEndTime: true })
        })
      )}
      {!value.hasEndTime && !value.hasEndDate && (
        <Text style={styles.hint}>Ends three hours after the start.</Text>
      )}
      {field('timezone', 'Time zone', value.timezone.replace(/_/g, ' '))}
      {error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {picker != null && (
        <Modal
          transparent
          animationType="fade"
          visible
          onRequestClose={() => {
            setPicker(undefined)
          }}
        >
          <KeyboardAvoidingView
            style={styles.backdrop}
            behavior={
              Platform.OS === 'ios'
                ? 'padding'
                : Platform.OS === 'android'
                  ? 'height'
                  : undefined
            }
          >
            <View accessibilityViewIsModal style={styles.dialog}>
              <ScrollView
                style={{ flexShrink: 1 }}
                keyboardShouldPersistTaps="handled"
              >
                {picker === 'timezone' ? (
                  <TimezonePicker
                    value={value.timezone}
                    savedTimezone={value.savedTimezone}
                    onChoose={timezone => {
                      update({ timezone })
                      setPicker(undefined)
                    }}
                    onCancel={() => {
                      setPicker(undefined)
                    }}
                  />
                ) : picker === 'date' || picker === 'endDate' ? (
                  <CalendarPicker
                    value={value[picker]}
                    onChoose={date => {
                      update({ [picker]: date })
                      setPicker(undefined)
                    }}
                    onCancel={() => {
                      setPicker(undefined)
                    }}
                  />
                ) : (
                  <TimePicker
                    value={value[picker]}
                    onChoose={(time, dayOffset) => {
                      if (dayOffset === 0) update({ [picker]: time })
                      else {
                        const key = picker === 'time' ? 'date' : 'endDate'
                        const date = new Date(`${value[key]}T12:00:00Z`)
                        date.setUTCDate(date.getUTCDate() + dayOffset)
                        update({
                          [picker]: time,
                          [key]: date.toISOString().slice(0, 10),
                          ...(picker === 'endTime' ? { hasEndDate: true } : {})
                        })
                      }
                      setPicker(undefined)
                    }}
                    onCancel={() => {
                      setPicker(undefined)
                    }}
                  />
                )}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}
    </View>
  )
}

function displayClock(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

export function CalendarPicker({
  value,
  onChoose,
  onCancel
}: {
  value: string
  onChoose: (date: string) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [yearText, setYearText] = useState(value.slice(0, 4))
  const [month, setMonth] = useState(Number(value.slice(5, 7)) - 1)
  const [choosingMonth, setChoosingMonth] = useState(false)
  const [selected, setSelected] = useState(value)
  const validYear =
    /^\d{4}$/.test(yearText) &&
    Number(yearText) >= 1900 &&
    Number(yearText) <= 9999
  const year = validYear ? Number(yearText) : Number(value.slice(0, 4))
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const blanks = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const step = (delta: number): void => {
    const next = new Date(Date.UTC(year, month + delta, 1))
    if (next.getUTCFullYear() < 1900 || next.getUTCFullYear() > 9999) return
    setMonth(next.getUTCMonth())
    setYearText(String(next.getUTCFullYear()))
  }
  return (
    <View style={styles.fields}>
      <Text accessibilityRole="header" style={styles.title}>
        Choose date
      </Text>
      <View style={styles.calendarControls}>
        <Button
          label="Previous"
          accessibilityLabel="Previous month"
          compact
          kind="secondary"
          onPress={() => {
            step(-1)
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Choose month: ${months[month]}`}
          onPress={() => {
            setChoosingMonth(held => !held)
          }}
        >
          <Text style={styles.value}>{months[month]}</Text>
        </Pressable>
        <Button
          label="Next"
          accessibilityLabel="Next month"
          compact
          kind="secondary"
          onPress={() => {
            step(1)
          }}
        />
      </View>
      <TextField
        label="Year"
        keyboardType="number-pad"
        value={yearText}
        onChangeText={setYearText}
      />
      {choosingMonth ? (
        <View style={styles.months}>
          {months.map((name, index) => (
            <Button
              key={name}
              label={name}
              kind="secondary"
              compact
              onPress={() => {
                setMonth(index)
                setChoosingMonth(false)
              }}
            />
          ))}
        </View>
      ) : (
        <View style={styles.grid}>
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(name => (
            <Text key={name} style={styles.weekday}>
              {name}
            </Text>
          ))}
          {Array.from({ length: blanks }, (_, index) => (
            <View key={`blank-${index}`} style={styles.day} />
          ))}
          {Array.from({ length: days }, (_, index) => {
            const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
            return (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityLabel={`Choose ${date}`}
                accessibilityState={{ selected: date === selected }}
                disabled={!validYear}
                onPress={() => {
                  setSelected(date)
                }}
                style={[styles.day, date === selected && styles.selected]}
              >
                <Text
                  style={[
                    styles.value,
                    date === selected && styles.selectedText
                  ]}
                >
                  {index + 1}
                </Text>
              </Pressable>
            )
          })}
        </View>
      )}
      {!validYear && (
        <Text accessibilityRole="alert" style={styles.error}>
          Enter a year from 1900 to 9999.
        </Text>
      )}
      <Button
        label="Use date"
        disabled={!validYear}
        onPress={() => {
          onChoose(selected)
        }}
      />
      <Button label="Cancel date picker" kind="secondary" onPress={onCancel} />
    </View>
  )
}

function Wheel({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: number[]
  value: number
  onChange: (value: number) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const height = 44
  const initialOffset = useRef(options.indexOf(value) * height)
  const initialized = useRef(false)
  useEffect(() => {
    if (Platform.OS === 'web') {
      scroll.current?.scrollTo({ y: initialOffset.current, animated: false })
      initialized.current = true
    }
  }, [])
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current)
    },
    []
  )
  const selectOffset = (offset: number): void => {
    const index = Math.min(
      options.length - 1,
      Math.max(0, Math.round(offset / height))
    )
    onChange(options[index])
  }
  return (
    <View style={styles.wheelColumn}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={styles.wheelViewport}
        accessibilityRole="adjustable"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityValue={{
          min: options[0],
          max: options[options.length - 1],
          now: value
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          const index = Math.min(
            options.length - 1,
            Math.max(
              0,
              options.indexOf(value) +
                (event.nativeEvent.actionName === 'increment' ? 1 : -1)
            )
          )
          onChange(options[index])
          scroll.current?.scrollTo({ y: index * height, animated: false })
        }}
      >
        <View pointerEvents="none" style={styles.wheelSelection} />
        <ScrollView
          ref={scroll}
          testID={`event-time-${label.toLowerCase()}-wheel`}
          style={styles.wheel}
          contentContainerStyle={{ paddingVertical: height }}
          contentOffset={{ x: 0, y: initialOffset.current }}
          onContentSizeChange={() => {
            // Fabric can lay out a modal's content after applying contentOffset.
            // Position once after content layout, without fighting later drags.
            if (!initialized.current) {
              initialized.current = true
              scroll.current?.scrollTo({
                y: initialOffset.current,
                animated: false
              })
            }
          }}
          snapToInterval={height}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={event => {
            selectOffset(event.nativeEvent.contentOffset.y)
          }}
          onScrollEndDrag={event => {
            selectOffset(event.nativeEvent.contentOffset.y)
          }}
          scrollEventThrottle={16}
          onScroll={
            Platform.OS === 'web'
              ? event => {
                  const offset = event.nativeEvent.contentOffset.y
                  if (timer.current != null) clearTimeout(timer.current)
                  timer.current = setTimeout(() => {
                    selectOffset(offset)
                  }, 120)
                }
              : undefined
          }
        >
          {options.map(option => (
            <Pressable
              key={option}
              testID={`event-time-${label.toLowerCase()}-${option}`}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${label === 'Period' ? (option === 0 ? 'AM' : 'PM') : String(option).padStart(2, '0')}`}
              accessibilityState={{ selected: option === value }}
              onPress={() => {
                onChange(option)
                scroll.current?.scrollTo({
                  y: options.indexOf(option) * height,
                  animated: false
                })
              }}
              style={styles.wheelItem}
            >
              <Text
                style={[styles.value, option === value && styles.wheelText]}
              >
                {label === 'Period'
                  ? option === 0
                    ? 'AM'
                    : 'PM'
                  : String(option).padStart(2, '0')}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  )
}

export function TimePicker({
  value,
  onChoose,
  onCancel
}: {
  value: string
  onChoose: (time: string, dayOffset: number) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [hour, minute] = nearestFiveMinutes(value).split(':').map(Number)
  const [hours, setHours] = useState(hour % 12 === 0 ? 12 : hour % 12)
  const [minutes, setMinutes] = useState(minute)
  const [period, setPeriod] = useState(hour < 12 ? 0 : 1)
  const chosen = `${String((hours % 12) + period * 12).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  const dayOffset =
    value.startsWith('23:') &&
    nearestFiveMinutes(value) === '00:00' &&
    chosen === '00:00'
      ? 1
      : 0
  return (
    <View style={styles.fields}>
      <Text accessibilityRole="header" style={styles.title}>
        Choose time
      </Text>
      <View style={styles.wheels}>
        <Wheel
          label="Hour"
          options={Array.from({ length: 12 }, (_, i) => i + 1)}
          value={hours}
          onChange={setHours}
        />
        <Wheel
          label="Minute"
          options={Array.from({ length: 12 }, (_, i) => i * 5)}
          value={minutes}
          onChange={setMinutes}
        />
        <Wheel
          label="Period"
          options={[0, 1]}
          value={period}
          onChange={setPeriod}
        />
      </View>
      <Text style={styles.hint}>
        {displayClock(chosen)}
        {dayOffset === 1 ? ' · Next day' : ''}
      </Text>
      <Button
        label="Use time"
        onPress={() => {
          onChoose(chosen, dayOffset)
        }}
      />
      <Button label="Cancel time picker" kind="secondary" onPress={onCancel} />
    </View>
  )
}

export function TimezonePicker({
  value,
  savedTimezone,
  onChoose,
  onCancel
}: {
  value: string
  savedTimezone?: string
  onChoose: (zone: string) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [query, setQuery] = useState('')
  let saved: string[] = []
  if (savedTimezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: savedTimezone }).format()
      saved = [savedTimezone]
    } catch {
      // Invalid legacy metadata never becomes a selectable zone.
    }
  }
  const zones = [
    ...new Set([viewerTimezone(), value, 'UTC', ...saved, ...timezones])
  ]
  const normalized = query.trim().toLowerCase().replace(/_/g, ' ')
  const matches = zones.filter(zone =>
    zone.toLowerCase().replace(/_/g, ' ').includes(normalized)
  )
  return (
    <View style={styles.fields}>
      <Text accessibilityRole="header" style={styles.title}>
        Choose time zone
      </Text>
      <TextField
        label="Find time zone"
        placeholder="City or time zone"
        autoFocus
        value={query}
        onChangeText={setQuery}
      />
      <ScrollView style={styles.zoneList} keyboardShouldPersistTaps="handled">
        {matches.map(zone => (
          <Button
            key={zone}
            label={zone.replace(/_/g, ' ')}
            accessibilityLabel={`Use time zone ${zone}`}
            kind={zone === value ? 'primary' : 'secondary'}
            onPress={() => {
              onChoose(zone)
            }}
          />
        ))}
        {matches.length === 0 && (
          <Text style={styles.hint}>No matching time zones</Text>
        )}
      </ScrollView>
      <Button
        label="Cancel time zone picker"
        kind="secondary"
        onPress={onCancel}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fields: { gap: theme.rem(0.75) },
  field: { gap: theme.rem(0.375) },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: theme.rem(theme.radiusRem),
    padding: theme.rem(0.75),
    minHeight: 44
  },
  value: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  hint: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  error: { fontFamily: theme.regularTextFont, color: theme.dangerColor },
  link: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  linkText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.activeColor
  },
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(1)
  },
  dialog: {
    backgroundColor: theme.backgroundColor,
    padding: theme.rem(1),
    borderRadius: theme.rem(theme.radiusRem),
    width: '100%',
    maxWidth: theme.rem(28),
    maxHeight: '95%'
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  calendarControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(0.25)
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekday: {
    width: '14.285714%',
    textAlign: 'center',
    color: theme.secondaryTextColor
  },
  day: {
    width: '14.285714%',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(0.5)
  },
  selected: { backgroundColor: theme.activeColor },
  selectedText: { color: '#ffffff' },
  months: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.rem(0.5) },
  wheels: { flexDirection: 'row', gap: theme.rem(0.5) },
  wheelColumn: { flex: 1, gap: theme.rem(0.5), alignItems: 'center' },
  // Nested native ScrollViews need a bounded viewport rather than growing to content.
  wheelViewport: { height: 132, width: 80, overflow: 'hidden' },
  wheel: { height: 132, width: 80, flexGrow: 0, flexShrink: 0 },
  wheelItem: { height: 44, alignItems: 'center', justifyContent: 'center' },
  wheelSelection: {
    position: 'absolute',
    top: 44,
    height: 44,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.containerBackgroundColor
  },
  wheelText: { fontFamily: theme.semiBoldTextFont, color: theme.activeColor },
  zoneList: { maxHeight: 260 }
}))
