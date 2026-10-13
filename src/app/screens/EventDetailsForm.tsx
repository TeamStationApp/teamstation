import React, { type RefObject, useRef, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  arrivalMinutesInput,
  type EventInfo,
  type EventType,
  type TeamEventInput
} from '../../common/eventInfo'
import type { EventScheduleDraft } from '../../common/eventSchedule'
import {
  eventScheduleValue,
  newEventSchedule
} from '../../common/eventSchedule'
import { Button, Card, TextField } from '../components'
import { EventArrivalField } from '../components/EventArrivalField'
import { EventScheduleFields } from '../components/EventScheduleFields'
import { EventTypeRow } from '../components/EventTypeRow'
import {
  type EventVenueDraft,
  EventVenueFields
} from '../components/EventVenueFields'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface EventFormDraft extends EventVenueDraft {
  title: string
  schedule: EventScheduleDraft
  arrival: string
}

export interface EventCreationRetry {
  body: string
  key: string
}

export function EventDetailsForm({
  client,
  teamId,
  info,
  onSaved,
  onCancel,
  draft: suppliedDraft,
  onDraftChange,
  eventType: suppliedType,
  onTypeChange,
  creationRetry,
  onBusyChange,
  hideType = false,
  hideTitle = false
}: {
  client: TeamStationClient
  teamId?: string
  info?: EventInfo
  onSaved: (id: string, info?: EventInfo) => void
  onCancel: () => void
  draft?: EventFormDraft
  onDraftChange?: (draft: EventFormDraft) => void
  eventType?: EventType
  onTypeChange?: (type: EventType) => void
  creationRetry?: RefObject<EventCreationRetry | undefined>
  onBusyChange?: (busy: boolean) => void
  hideType?: boolean
  /** For a scene that names itself above the form. */
  hideTitle?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [localDraft, setLocalDraft] = useState<EventFormDraft>(() => ({
    title: info?.title ?? '',
    schedule: newEventSchedule(
      info?.startAt,
      info?.endAt,
      undefined,
      info?.timezone
    ),
    venue: info?.venue ?? '',
    address: info?.address ?? '',
    notes: info?.notes ?? '',
    arrival:
      info == null
        ? '0'
        : info.arrivalTimeDelta == null
          ? ''
          : String(info.arrivalTimeDelta)
  }))
  const draft = suppliedDraft ?? localDraft
  const changeDraft = onDraftChange ?? setLocalDraft
  const { title, schedule, venue, address, notes, arrival } = draft
  const [localType, setLocalType] = useState<EventType>(
    info?.eventType ?? 'other'
  )
  const eventType = suppliedType ?? localType
  const [cancelled, setCancelled] = useState(info?.status === 'cancelled')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const writing = useRef(false)
  const localRetry = useRef<EventCreationRetry | undefined>(undefined)
  const retry = creationRetry ?? localRetry
  const save = async (): Promise<void> => {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    try {
      const {
        startAt,
        endAt,
        timezone: checkedTimezone
      } = eventScheduleValue(schedule)
      const fields = {
        notes: notes.trim() === '' ? null : notes.trim(),
        arrivalTimeDelta: arrivalMinutesInput(arrival),
        eventType:
          eventType === 'practice' ? ('practice' as const) : ('other' as const),
        address: address.trim() === '' ? null : address.trim(),
        endAt,
        title: title.trim(),
        startAt,
        timezone: checkedTimezone,
        venue: venue.trim() === '' ? null : venue.trim(),
        status: cancelled ? ('cancelled' as const) : ('scheduled' as const)
      }
      if (info != null) {
        const saved = await client.updateEventInfo(info.id, fields)
        onSaved(info.id, saved)
      } else {
        const serialized = JSON.stringify({ teamId, ...fields })
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
          notes: fields.notes,
          arrivalTimeDelta: fields.arrivalTimeDelta,
          eventType: fields.eventType,
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
      onBusyChange?.(false)
    }
  }
  return (
    <Card style={styles.form}>
      {!hideTitle && (
        <Text style={styles.title}>
          {info == null ? 'Create Event' : 'Event Settings'}
        </Text>
      )}
      {!hideType && (
        <EventTypeRow
          value={eventType}
          gameAvailable={onTypeChange != null}
          onChange={type => {
            if (onTypeChange != null) onTypeChange(type)
            else if (type !== 'game') setLocalType(type)
          }}
          disabled={busy}
        />
      )}
      <>
        <TextField
          label="Title"
          value={title}
          disabled={busy}
          onChangeText={title => {
            changeDraft({ ...draft, title })
          }}
          placeholder="Practice, team dinner…"
        />
        <EventScheduleFields
          value={schedule}
          onChange={schedule => {
            changeDraft({ ...draft, schedule })
          }}
          disabled={busy}
        />
        <EventArrivalField
          value={arrival}
          onChange={arrival => {
            changeDraft({ ...draft, arrival })
          }}
          disabled={busy}
        />
      </>
      <EventVenueFields
        client={client}
        value={{ venue, address, notes }}
        onChange={value => {
          changeDraft({ ...draft, ...value })
        }}
        disabled={busy}
      />
      {info != null && (
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
