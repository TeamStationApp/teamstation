import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  changeEventSchedule,
  type EventScheduleDraft,
  eventScheduleValue
} from '../../common/eventSchedule'
import { nearestFiveMinutes, viewerTimezone } from '../../common/eventTime'
import timezones from '../../common/eventTimezones.json'
import type { CitySuggestion } from '../../common/locality'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { CancelAction } from './CancelAction'
import { Icon } from './Icon'
import { PickerDialog } from './PickerDialog'
import { RadioMark } from './RadioMark'
import { TextField } from './TextField'
import { Wheel } from './Wheel'

type CityClient = Pick<TeamStationClient, 'citySuggestions' | 'location'>

type Picker = 'date' | 'time' | 'endDate' | 'endTime' | 'timezone'

export function EventScheduleFields({
  client,
  value,
  onChange,
  disabled = false
}: {
  client?: CityClient
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
      {picker === 'timezone' && (
        // Hundreds of zones and a search: a scene of its own that slides up.
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => {
            setPicker(undefined)
          }}
        >
          <TimezonePicker
            client={client}
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
        </Modal>
      )}
      {picker != null && picker !== 'timezone' && (
        <PickerDialog
          onClose={() => {
            setPicker(undefined)
          }}
        >
          {picker === 'date' || picker === 'endDate' ? (
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
        </PickerDialog>
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
  const theme = useTheme()
  const styles = getStyles(theme)
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
        // Twelve choices in rows: a grid of plain cells, never pills.
        <View style={styles.months}>
          {months.map((name, index) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={name}
              aria-selected={index === month}
              onPress={() => {
                setMonth(index)
                setChoosingMonth(false)
              }}
              style={({ pressed }) => [
                styles.monthCell,
                index === month && styles.selected,
                pressed && index !== month && styles.cellPressed
              ]}
            >
              <Text
                style={[
                  styles.monthText,
                  index === month && styles.selectedText
                ]}
              >
                {name.slice(0, 3)}
              </Text>
            </Pressable>
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
      <CancelAction
        label="Cancel"
        accessibilityLabel="Cancel date picker"
        onPress={onCancel}
      />
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
  const theme = useTheme()
  const styles = getStyles(theme)
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
          format={option => String(option).padStart(2, '0')}
          testID="event-time-hour-wheel"
          rowTestID="event-time-hour"
          options={Array.from({ length: 12 }, (_, i) => i + 1)}
          value={hours}
          onChange={setHours}
        />
        <Wheel
          label="Minute"
          format={option => String(option).padStart(2, '0')}
          testID="event-time-minute-wheel"
          rowTestID="event-time-minute"
          options={Array.from({ length: 12 }, (_, i) => i * 5)}
          value={minutes}
          onChange={setMinutes}
        />
        <Wheel
          label="Period"
          format={option => (option === 0 ? 'AM' : 'PM')}
          testID="event-time-period-wheel"
          rowTestID="event-time-period"
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
      <CancelAction
        label="Cancel"
        accessibilityLabel="Cancel time picker"
        onPress={onCancel}
      />
    </View>
  )
}

interface ZoneFormatters {
  /** Absent where the engine has no `shortOffset`, as older Hermes. */
  offset?: Intl.DateTimeFormat
  wall: Intl.DateTimeFormat
  time: Intl.DateTimeFormat
}
// One set per zone for as long as the app runs: the picker lists hundreds.
const zoneFormatters = new Map<string, ZoneFormatters | null>()
function formattersFor(zone: string): ZoneFormatters | null {
  if (zoneFormatters.has(zone)) return zoneFormatters.get(zone)!
  let made: ZoneFormatters | null
  try {
    let offset: Intl.DateTimeFormat | undefined
    try {
      offset = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        timeZoneName: 'shortOffset'
      })
    } catch {
      offset = undefined
    }
    made = {
      offset,
      wall: new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
      time: new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit'
      })
    }
  } catch {
    made = null
  }
  zoneFormatters.set(zone, made)
  return made
}

/**
 * A zone's offset as `GMT-7` or `GMT+5:30`, worked out from its wall clock
 * when the engine cannot name it.
 */
export function offsetFromWallClock(
  wall: Intl.DateTimeFormat,
  now: Date
): string {
  const part = (type: string): number =>
    Number(wall.formatToParts(now).find(item => item.type === type)?.value)
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute')
  )
  const minutes = Math.round(
    (local - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000
  )
  if (minutes === 0) return 'GMT'
  const sign = minutes < 0 ? '-' : '+'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const rest = Math.abs(minutes) % 60
  return `GMT${sign}${hours}${rest === 0 ? '' : ':' + String(rest).padStart(2, '0')}`
}

/** A zone's offset from UTC and its time now: `GMT-7 · 2:15 PM now`. */
export function zoneDetail(zone: string, now = new Date()): string {
  const formatters = formattersFor(zone)
  if (formatters == null) return ''
  const offset =
    formatters.offset
      ?.formatToParts(now)
      .find(part => part.type === 'timeZoneName')?.value ??
    offsetFromWallClock(formatters.wall, now)
  return `${offset} · ${formatters.time.format(now)} now`
}

export function TimezonePicker({
  client,
  value,
  savedTimezone,
  onChoose,
  onCancel
}: {
  client?: CityClient
  value: string
  savedTimezone?: string
  onChoose: (zone: string) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<CitySuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [attribution, setAttribution] = useState('')
  const [retry, setRetry] = useState(0)
  const request = useRef(0)
  const selecting = useRef(false)
  const [session] = useState(() =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const n = Math.floor(Math.random() * 16)
      return (c === 'x' ? n : (n & 3) | 8).toString(16)
    })
  )
  const invalidate = (): void => {
    request.current++
    selecting.current = false
  }
  const chooseZone = (zone: string): void => {
    invalidate()
    onChoose(zone)
  }
  useEffect(() => {
    const id = ++request.current
    setCities([])
    setError('')
    setAttribution('')
    setLoading(client != null && query.trim().length >= 2)
    if (client == null || query.trim().length < 2) return
    const timer = setTimeout(() => {
      client
        .citySuggestions(query.trim(), session)
        .then(
          result => {
            if (request.current !== id) return
            setCities(result.suggestions)
            setAttribution(result.attribution)
          },
          () => {
            if (request.current === id)
              setError('City lookup is unavailable. Try again.')
          }
        )
        .finally(() => {
          if (request.current === id) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      request.current++
    }
  }, [client, query, retry, session])
  useEffect(
    () => () => {
      request.current++
    },
    []
  )
  const chooseCity = async (city: CitySuggestion): Promise<void> => {
    if (client == null || selecting.current) return
    selecting.current = true
    const id = ++request.current
    setLoading(true)
    setError('')
    try {
      const location = await client.location(city.id, session)
      if (request.current !== id) return
      new Intl.DateTimeFormat('en', { timeZone: location.timezone }).format()
      chooseZone(location.timezone)
    } catch {
      if (request.current === id)
        setError('The city’s time zone could not load. Tap the city to retry.')
    } finally {
      if (request.current === id) {
        selecting.current = false
        setLoading(false)
      }
    }
  }

  let saved: string[] = []
  if (savedTimezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: savedTimezone }).format()
      saved = [savedTimezone]
    } catch {
      // Invalid legacy metadata never becomes a selectable zone.
    }
  }
  const zones = useMemo(
    () => [
      ...new Set([viewerTimezone(), value, 'UTC', ...saved, ...timezones])
    ],
    // `saved` follows from `savedTimezone`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, savedTimezone]
  )
  // Each zone's line is worked out once while the picker is open, not on
  // every keystroke.
  const [openedAt] = useState(() => new Date())
  const details = useMemo(
    () => new Map(zones.map(zone => [zone, zoneDetail(zone, openedAt)])),
    [zones, openedAt]
  )
  const normalized = query.trim().toLowerCase().replace(/_/g, ' ')
  const matches = zones.filter(zone =>
    zone.toLowerCase().replace(/_/g, ' ').includes(normalized)
  )
  return (
    <View
      style={[
        styles.scene,
        { paddingTop: insets.top, paddingBottom: insets.bottom }
      ]}
      testID="timezone-picker"
    >
      <View style={styles.sceneHeader}>
        <Text accessibilityRole="header" style={styles.sceneTitle}>
          Choose time zone
        </Text>
        <Button
          label="Cancel"
          accessibilityLabel="Cancel time zone picker"
          kind="text"
          textColor={theme.dangerColor}
          onPress={() => {
            invalidate()
            onCancel()
          }}
        />
      </View>
      <View style={styles.sceneSearch}>
        <TextField
          label="Find time zone"
          placeholder="City or time zone"
          autoFocus
          value={query}
          onChangeText={text => {
            invalidate()
            setCities([])
            setError('')
            setQuery(text)
          }}
        />
      </View>
      <ScrollView
        style={styles.zoneList}
        contentContainerStyle={styles.zoneListContent}
        keyboardShouldPersistTaps="handled"
      >
        {loading && <Text style={styles.hint}>Looking up city…</Text>}
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {error !== '' && cities.length === 0 && (
          <Button
            label="Retry city search"
            kind="text"
            onPress={() => {
              invalidate()
              setRetry(n => n + 1)
            }}
          />
        )}
        {cities.map(city => (
          <Pressable
            key={city.id}
            accessibilityRole="button"
            accessibilityLabel={`Use city ${city.primary}, ${city.secondary}`}
            style={styles.zoneRow}
            onPress={async () => {
              await chooseCity(city)
            }}
          >
            <View style={styles.zoneText}>
              <Text style={styles.zoneName}>{city.primary}</Text>
              <Text style={styles.hint}>{city.secondary}</Text>
            </View>
          </Pressable>
        ))}
        {attribution !== '' && <Text style={styles.hint}>{attribution}</Text>}
        {matches.map((zone, index) => (
          <Pressable
            key={zone}
            accessibilityRole="button"
            accessibilityLabel={`Use time zone ${zone}`}
            aria-selected={zone === value}
            onPress={() => {
              chooseZone(zone)
            }}
            style={({ pressed }) => [
              styles.zoneRow,
              index > 0 && styles.zoneDivider,
              pressed && styles.cellPressed
            ]}
          >
            <View style={styles.zoneText}>
              <Text style={styles.zoneName} numberOfLines={1}>
                {zone.replace(/_/g, ' ')}
              </Text>
              <Text style={styles.hint} numberOfLines={1}>
                {details.get(zone)}
              </Text>
            </View>
            <RadioMark on={zone === value} />
          </Pressable>
        ))}
        {matches.length === 0 &&
          cities.length === 0 &&
          !loading &&
          error === '' && (
            <Text style={styles.hint}>No matching cities or time zones</Text>
          )}
      </ScrollView>
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
  months: { flexDirection: 'row', flexWrap: 'wrap' },
  monthCell: {
    width: '33.333333%',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(0.5)
  },
  monthText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  cellPressed: { backgroundColor: theme.highlightRowActiveBackground },
  zoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    minHeight: 56,
    paddingHorizontal: theme.rem(0.25),
    paddingVertical: theme.rem(0.5)
  },
  zoneDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  zoneText: { flex: 1, gap: theme.rem(0.125) },
  zoneName: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  wheels: { flexDirection: 'row', gap: theme.rem(0.5) },
  scene: { flex: 1, backgroundColor: theme.backgroundColor },
  sceneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  sceneTitle: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  sceneSearch: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    padding: theme.rem(1)
  },
  zoneList: { flex: 1 },
  zoneListContent: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    paddingHorizontal: theme.rem(1),
    paddingBottom: theme.rem(1)
  }
}))
