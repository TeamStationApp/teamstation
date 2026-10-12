import React, { useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { EventInfo, TeamEventInput } from '../../common/eventInfo'
import { asGameTimezone } from '../../common/gameApprovals'
import { gameCalendarDay, gameTime } from '../../common/gameTime'
import { Button, Card, TextField } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(iso))
}

export function EventDetailsForm({
  client,
  teamId,
  info,
  onSaved,
  onCancel
}: {
  client: TeamStationClient
  teamId?: string
  info?: EventInfo
  onSaved: (id: string, info?: EventInfo) => void
  onCancel: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const game = info?.eventKind === 'game'
  const [title, setTitle] = useState(info?.title ?? '')
  const [timezone, setTimezone] = useState(
    info?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )
  const starting = info?.startAt ?? new Date().toISOString()
  const [date, setDate] = useState(() => gameCalendarDay(starting, timezone))
  const [time, setTime] = useState(() =>
    info == null ? '18:00' : localTime(starting, timezone)
  )
  const [endDate, setEndDate] = useState(() =>
    gameCalendarDay(info?.endAt ?? starting, timezone)
  )
  const [endTime, setEndTime] = useState(() =>
    info?.endAt == null ? '20:00' : localTime(info.endAt, timezone)
  )
  const [hasEnd, setHasEnd] = useState(info?.endAt != null)
  const [venue, setVenue] = useState(info?.venue ?? '')
  const [address, setAddress] = useState(info?.address ?? '')
  const [cancelled, setCancelled] = useState(info?.status === 'cancelled')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const writing = useRef(false)
  const retry = useRef<{ body: string; key: string } | undefined>(undefined)
  const save = async (): Promise<void> => {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    try {
      const checkedTimezone = asGameTimezone(timezone)
      const startAt = game
        ? info.startAt!
        : gameTime(date, time, checkedTimezone)
      const endAt = hasEnd ? gameTime(endDate, endTime, checkedTimezone) : null
      if (endAt != null && Date.parse(endAt) <= Date.parse(startAt))
        throw new Error('End time must be after start time')
      const fields = {
        address: address.trim() === '' ? null : address.trim(),
        endAt,
        ...(!game
          ? {
              title: title.trim(),
              startAt,
              timezone: checkedTimezone,
              venue: venue.trim() === '' ? null : venue.trim(),
              status: cancelled
                ? ('cancelled' as const)
                : ('scheduled' as const)
            }
          : {})
      }
      if (info != null) {
        const saved = await client.updateEventInfo(info.id, fields)
        onSaved(info.id, saved)
      } else {
        const serialized = JSON.stringify(fields)
        if (retry.current?.body !== serialized)
          retry.current = {
            body: serialized,
            key: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`
          }
        const body: TeamEventInput = {
          teamId: teamId!,
          title: title.trim(),
          startAt,
          timezone: checkedTimezone,
          venue: venue.trim() === '' ? null : venue.trim(),
          status: 'scheduled',
          address: fields.address,
          endAt,
          idempotencyKey: retry.current.key
        }
        const result = await client.createTeamEvent(body)
        onSaved(result.id)
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'The event could not be saved. Try again.'
      )
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  return (
    <Card style={styles.form}>
      <Text style={styles.title}>
        {info == null ? 'Create Event' : 'Edit event details'}
      </Text>
      {!game && (
        <>
          <TextField
            label="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="Practice, team dinner…"
          />
          <TextField
            label="Date"
            value={date}
            onChangeText={value => {
              if (endDate === date) setEndDate(value)
              setDate(value)
            }}
            placeholder="YYYY-MM-DD"
          />
          <TextField
            label="Start time"
            value={time}
            onChangeText={setTime}
            placeholder="18:00"
          />
          <TextField
            label="Time zone"
            value={timezone}
            onChangeText={setTimezone}
          />
          <TextField
            label="Venue (optional)"
            value={venue}
            onChangeText={setVenue}
          />
        </>
      )}
      <TextField
        label="Address (optional)"
        value={address}
        onChangeText={setAddress}
      />
      <Button
        label={hasEnd ? 'End time: Set' : 'End time: Not set'}
        kind="secondary"
        disabled={busy}
        onPress={() => {
          setHasEnd(value => !value)
        }}
      />
      {hasEnd && (
        <View style={styles.fields}>
          <TextField
            label="End date"
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
          />
          <TextField
            label="End time"
            value={endTime}
            onChangeText={setEndTime}
            placeholder="20:00"
          />
        </View>
      )}
      {!game && info != null && (
        <Button
          label={cancelled ? 'Canceled' : 'Cancel event'}
          kind="secondary"
          disabled={busy}
          onPress={() => {
            setCancelled(value => !value)
          }}
        />
      )}
      {error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        label={info == null ? 'Create event' : 'Save event details'}
        busy={busy}
        disabled={busy || (info == null && title.trim() === '')}
        onPress={() => {
          save().catch(() => undefined)
        }}
      />
      <Button
        label="Back"
        kind="secondary"
        disabled={busy}
        onPress={onCancel}
      />
    </Card>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  form: { gap: theme.rem(1), padding: theme.rem(1), width: '100%' },
  fields: { gap: theme.rem(0.75) },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  error: { fontFamily: theme.regularTextFont, color: theme.dangerColor }
}))
