import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { asCalendarDate, isRecord } from './groupCreation'

export type Rsvp = 'yes' | 'maybe' | 'no'
export type RsvpChoice = Rsvp | null
export const RSVP_ORDER: readonly RsvpChoice[] = ['yes', 'maybe', 'no', null]
export const RSVP_LABELS = ['Going', 'Maybe', 'Not going', 'No reply'] as const
export const asRsvp = asLiteral('yes', 'maybe', 'no')
const nullableText = (raw: unknown): string | null =>
  raw == null ? null : asString(raw)
const nullableNumber = (raw: unknown): number | null =>
  raw == null ? null : asNumber(raw)

export interface EventMetadata {
  eventKind?: 'game' | 'event'
  title?: string | null
  endAt?: string | null
  address?: string | null
  latitude?: number | null
  longitude?: number | null
  hasScoringEvents?: boolean
}

/** Preserve older answer shapes while decoding event fields when supplied. */
export function withEventMetadata<T>(
  cleaner: Cleaner<T>
): Cleaner<T & EventMetadata> {
  return raw => {
    const answer = cleaner(raw)
    const fields: EventMetadata = {}
    if (isRecord(raw)) {
      if (raw.eventKind !== undefined)
        fields.eventKind = asLiteral('game', 'event')(raw.eventKind)
      if (raw.title !== undefined) fields.title = nullableText(raw.title)
      if (raw.endAt !== undefined) fields.endAt = nullableText(raw.endAt)
      if (raw.address !== undefined) fields.address = nullableText(raw.address)
      if (raw.latitude !== undefined)
        fields.latitude = nullableNumber(raw.latitude)
      if (raw.longitude !== undefined)
        fields.longitude = nullableNumber(raw.longitude)
      if (raw.hasScoringEvents !== undefined)
        fields.hasScoringEvents = asBoolean(raw.hasScoringEvents)
    }
    return { ...answer, ...fields }
  }
}

export interface EventLocationFields {
  endAt?: string | null
  address?: string | null
  latitude?: number | null
  longitude?: number | null
}

export function eventDate(raw: unknown, label: string): string {
  if (
    typeof raw !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(
      raw
    ) ||
    !Number.isFinite(Date.parse(raw))
  )
    throw new TypeError(`${label} must be a valid date and time with timezone`)
  asCalendarDate(raw.slice(0, 10))
  return new Date(raw).toISOString()
}

export function eventText(
  raw: unknown,
  label: string,
  max: number,
  required = false
): string | null {
  if (raw == null || raw === '') {
    if (required) throw new TypeError(`${label} is required`)
    return null
  }
  if (
    typeof raw !== 'string' ||
    raw.trim().length > max ||
    (required && raw.trim() === '')
  )
    throw new TypeError(
      `${label} must be ${required ? '1–' : 'at most '}${max} characters`
    )
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/** Presence matters on edits and on legacy proposal retry hashes. */
export function asEventLocationFields(
  raw: Record<string, unknown>,
  startAt?: string
): EventLocationFields {
  const out: EventLocationFields = {}
  if (raw.endAt !== undefined) {
    out.endAt = raw.endAt == null ? null : eventDate(raw.endAt, 'End time')
    if (
      out.endAt != null &&
      startAt != null &&
      Date.parse(out.endAt) <= Date.parse(startAt)
    )
      throw new TypeError('End time must be after start time')
  }
  if (raw.address !== undefined)
    out.address = eventText(raw.address, 'Address', 500)
  const coordinates = ['latitude', 'longitude'] as const
  if (coordinates.some(key => raw[key] !== undefined)) {
    for (const key of coordinates) {
      const value = raw[key]
      const bound = key === 'latitude' ? 90 : 180
      if (
        value != null &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          Math.abs(value) > bound)
      )
        throw new TypeError(`Choose a valid ${key}`)
      out[key] = value ?? null
    }
    if ((out.latitude == null) !== (out.longitude == null))
      throw new TypeError('Latitude and longitude must be supplied together')
  }
  return out
}

export interface TeamEventInput extends EventLocationFields {
  teamId: string
  title: string
  startAt: string
  timezone: string
  venue: string | null
  status: 'scheduled' | 'cancelled'
  idempotencyKey: string
}

export function asTeamEventInput(raw: unknown): TeamEventInput {
  if (!isRecord(raw)) throw new TypeError('Enter event details')
  if (
    typeof raw.teamId !== 'string' ||
    raw.teamId.length < 1 ||
    raw.teamId.length > 100
  )
    throw new TypeError('Choose a team')
  const title = eventText(raw.title, 'Title', 200, true)!
  const startAt = eventDate(raw.startAt, 'Start time')
  const timezone = raw.timezone ?? 'UTC'
  if (typeof timezone !== 'string' || timezone.length > 100)
    throw new TypeError('Choose a valid timezone')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new TypeError('Choose a valid timezone')
  }
  if (
    raw.status != null &&
    raw.status !== 'scheduled' &&
    raw.status !== 'cancelled'
  )
    throw new TypeError('Choose scheduled or cancelled')
  if (
    typeof raw.idempotencyKey !== 'string' ||
    raw.idempotencyKey.length < 8 ||
    raw.idempotencyKey.length > 120
  )
    throw new TypeError('Saving needs a retry key')
  return {
    teamId: raw.teamId,
    title,
    startAt,
    timezone,
    venue: eventText(raw.venue, 'Venue', 200),
    status: raw.status === 'cancelled' ? 'cancelled' : 'scheduled',
    idempotencyKey: raw.idempotencyKey,
    ...asEventLocationFields(raw, startAt)
  }
}

export const asEventAttendee = asObject({
  userId: asNumber,
  name: asString,
  avatarUrl: nullableText,
  response: (raw: unknown): RsvpChoice => (raw == null ? null : asRsvp(raw)),
  canReply: asBoolean
})
export type EventAttendee = ReturnType<typeof asEventAttendee>
export const asEventInfo = asObject({
  id: asString,
  eventKind: asLiteral('game', 'event'),
  title: nullableText,
  teamId: asString,
  teamName: asString,
  startAt: nullableText,
  endAt: nullableText,
  timezone: asString,
  venue: nullableText,
  address: nullableText,
  latitude: nullableNumber,
  longitude: nullableNumber,
  status: asString,
  canManage: asBoolean,
  attendees: asArray(asEventAttendee),
  replyUserIds: asArray(asNumber)
})
export type EventInfo = ReturnType<typeof asEventInfo>
export const asEventLocation = asObject({
  latitude: nullableNumber,
  longitude: nullableNumber,
  tileUrl: asString
})
export type EventLocation = ReturnType<typeof asEventLocation>

export function sortedAttendees(rows: EventAttendee[]): EventAttendee[] {
  return [...rows].sort((a, b) => {
    const response =
      RSVP_ORDER.indexOf(a.response) - RSVP_ORDER.indexOf(b.response)
    if (response !== 0) return response
    const name = a.name.localeCompare(b.name)
    return name !== 0 ? name : a.userId - b.userId
  })
}
