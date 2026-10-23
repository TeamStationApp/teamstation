import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { asCalendarDate, isRecord } from './groupCreation'
import { asRoles, type Role } from './roles'
import { asUserId } from './userId'

export type Rsvp = 'yes' | 'maybe' | 'no'
export type RsvpChoice = Rsvp | null
export const RSVP_ORDER: readonly RsvpChoice[] = ['yes', 'maybe', 'no', null]
export const RSVP_LABELS = ['Going', 'Maybe', 'Not going', 'No reply'] as const
export const asRsvp = asLiteral('yes', 'maybe', 'no')
export const asEventType = asLiteral('game', 'practice', 'other')
export type EventType = ReturnType<typeof asEventType>

/** What a practice is called when nobody titled it. */
export const PRACTICE_TITLE = 'Practice'

/**
 * What a schedule calls an event in place of its teams: `Practice` for a
 * practice, the title of any other event, and nothing for a game. A row with
 * no `eventType` is a game.
 */
export function eventName(event: {
  eventKind?: 'game' | 'event'
  eventType?: string | null
  title?: string | null
}): string | undefined {
  if (
    event.eventKind !== 'event' &&
    event.eventType !== 'practice' &&
    event.eventType !== 'other'
  )
    return undefined
  if (event.eventType === 'practice') return PRACTICE_TITLE
  const title = event.title?.trim() ?? ''
  return title === '' ? 'Event' : title
}

const asCount = (raw: unknown): number => {
  const value = asNumber(raw)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid player RSVP count')
  return value
}
export const asPlayerRsvpCounts = asObject({
  yes: asCount,
  unknown: asCount,
  no: asCount
})
export type PlayerRsvpCounts = ReturnType<typeof asPlayerRsvpCounts>
export function playerRsvpCounts(attendees: EventAttendee[]): PlayerRsvpCounts {
  const counts = { yes: 0, unknown: 0, no: 0 }
  for (const row of attendees) {
    if (row.isPlayer !== true || row.isTeamParticipant !== true) continue
    counts[
      row.response === 'yes' ? 'yes' : row.response === 'no' ? 'no' : 'unknown'
    ]++
  }
  return counts
}

export function arrivalMinutes(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 10080
  )
    throw new TypeError(
      'Arrival minutes must be a whole number from 0 to 10080'
    )
  return raw
}

export function arrivalMinutesInput(text: string): number | null {
  if (text.trim() === '') return null
  if (!/^\d+$/.test(text.trim()))
    throw new TypeError('Enter whole minutes prior to the event start')
  return arrivalMinutes(Number(text))
}
const nullableText = (raw: unknown): string | null =>
  raw == null ? null : asString(raw)
const nullableNumber = (raw: unknown): number | null =>
  raw == null ? null : asNumber(raw)

export interface EventMetadata {
  playerRsvps?: PlayerRsvpCounts
  notes?: string | null
  arrivalTimeDelta?: number | null
  eventType?: EventType
  eventKind?: 'game' | 'event'
  title?: string | null
  endAt?: string | null
  address?: string | null
  latitude?: number | null
  longitude?: number | null
  hasScoringEvents?: boolean
  /** Server-authoritative game LIVE eligibility; distinct from a live camera. */
  isGameLive?: boolean
  /** The authenticated viewer holds an umpire assignment on this game. */
  isUmpire?: boolean
}

/** Preserve older answer shapes while decoding event fields when supplied. */
export function withEventMetadata<T>(
  cleaner: Cleaner<T>
): Cleaner<T & EventMetadata> {
  return raw => {
    const answer = cleaner(raw)
    const fields: EventMetadata = {}
    if (isRecord(raw)) {
      if (raw.playerRsvps !== undefined)
        fields.playerRsvps = asPlayerRsvpCounts(raw.playerRsvps)
      if (raw.notes !== undefined) fields.notes = nullableText(raw.notes)
      if (raw.arrivalTimeDelta !== undefined)
        fields.arrivalTimeDelta = arrivalMinutes(raw.arrivalTimeDelta)
      if (raw.eventType !== undefined)
        fields.eventType = asEventType(raw.eventType)
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
      if (raw.isGameLive !== undefined)
        fields.isGameLive = asBoolean(raw.isGameLive)
      if (raw.isUmpire !== undefined) fields.isUmpire = asBoolean(raw.isUmpire)
    }
    return { ...answer, ...fields }
  }
}

export interface EventLocationFields {
  notes?: string | null
  arrivalTimeDelta?: number | null
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
  if (raw.notes !== undefined) out.notes = eventText(raw.notes, 'Notes', 2000)
  if (raw.arrivalTimeDelta !== undefined)
    out.arrivalTimeDelta = arrivalMinutes(raw.arrivalTimeDelta)
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
  eventType?: 'practice' | 'other'
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
  const eventType =
    raw.eventType === undefined
      ? undefined
      : asLiteral('practice', 'other')(raw.eventType)
  // A practice is called Practice; any other event needs its own title.
  const title =
    eventType === 'practice'
      ? (eventText(raw.title, 'Title', 200) ?? PRACTICE_TITLE)
      : eventText(raw.title, 'Title', 200, true)!
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
    ...(eventType === undefined ? {} : { eventType }),
    title,
    startAt,
    timezone,
    venue: eventText(raw.venue, 'Venue', 200),
    status: raw.status === 'cancelled' ? 'cancelled' : 'scheduled',
    idempotencyKey: raw.idempotencyKey,
    ...asEventLocationFields(raw, startAt)
  }
}

const asAttendee = asObject({
  userId: asUserId,
  name: asString,
  avatarUrl: nullableText,
  response: (raw: unknown): RsvpChoice => (raw == null ? null : asRsvp(raw)),
  canReply: asBoolean
})
export interface EventAttendee extends ReturnType<typeof asAttendee> {
  isTeamParticipant?: boolean
  isPlayer?: boolean
  staffRoles?: Role[]
  bats?: 'left' | 'right' | 'switch' | null
  throws?: 'left' | 'right' | null
  positions?: string[]
  guardianOf?: string[]
}
export const asEventAttendee: Cleaner<EventAttendee> = raw => {
  const answer: EventAttendee = asAttendee(raw)
  if (isRecord(raw)) {
    if (raw.isTeamParticipant !== undefined)
      answer.isTeamParticipant = asBoolean(raw.isTeamParticipant)
    if (raw.isPlayer !== undefined) answer.isPlayer = asBoolean(raw.isPlayer)
    if (raw.staffRoles !== undefined)
      answer.staffRoles = asRoles(raw.staffRoles)
    if (raw.bats !== undefined)
      answer.bats =
        raw.bats == null ? null : asLiteral('left', 'right', 'switch')(raw.bats)
    if (raw.throws !== undefined)
      answer.throws =
        raw.throws == null ? null : asLiteral('left', 'right')(raw.throws)
    if (raw.positions !== undefined)
      answer.positions = asArray(asString)(raw.positions)
    if (raw.guardianOf !== undefined)
      answer.guardianOf = asArray(asString)(raw.guardianOf)
  }
  return answer
}
const asInfo = asObject({
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
  canViewAttendance: asOptional(asBoolean, true),
  attendees: asArray(asEventAttendee),
  replyUserIds: asArray(asUserId)
})
/** Something wrong with a game's field, for its Info tab. */
export interface EventFieldWarning {
  kind: 'conflict' | 'outsideAvailability' | 'fieldDeleted' | 'sizeRemoved'
  message: string
}
export interface EventInfo extends ReturnType<typeof asInfo> {
  /** On a game linked to a registry field: what is wrong with it. */
  fieldWarnings?: EventFieldWarning[]
  notes?: string | null
  arrivalTimeDelta?: number | null
  eventType?: EventType
  attendanceTeams?: Array<{ id: string; name: string; isParticipant?: boolean }>
}
export const asEventInfo: Cleaner<EventInfo> = raw => {
  const answer: EventInfo = asInfo(raw)
  if (isRecord(raw)) {
    if (raw.notes !== undefined) answer.notes = nullableText(raw.notes)
    if (raw.arrivalTimeDelta !== undefined)
      answer.arrivalTimeDelta = arrivalMinutes(raw.arrivalTimeDelta)
    if (raw.eventType !== undefined)
      answer.eventType = asEventType(raw.eventType)
  }
  if (isRecord(raw) && raw.fieldWarnings !== undefined)
    answer.fieldWarnings = asArray(
      asObject({
        kind: asLiteral(
          'conflict',
          'outsideAvailability',
          'fieldDeleted',
          'sizeRemoved'
        ),
        message: asString
      })
    )(raw.fieldWarnings)
  if (isRecord(raw) && raw.attendanceTeams !== undefined)
    answer.attendanceTeams = asArray(
      asObject({
        id: asString,
        name: asString,
        isParticipant: asOptional(asBoolean, false)
      })
    )(raw.attendanceTeams)
  return answer
}
const asLocation = asObject({
  latitude: nullableNumber,
  longitude: nullableNumber,
  tileUrl: asString
})
export interface EventLocation extends ReturnType<typeof asLocation> {
  googleMapsApiKey?: string
}
export const asEventLocation: Cleaner<EventLocation> = raw => {
  const answer: EventLocation = asLocation(raw)
  if (isRecord(raw) && raw.googleMapsApiKey !== undefined)
    answer.googleMapsApiKey = asString(raw.googleMapsApiKey)
  return answer
}

export function sortedAttendees(rows: EventAttendee[]): EventAttendee[] {
  return [...rows].sort((a, b) => {
    const response =
      RSVP_ORDER.indexOf(a.response) - RSVP_ORDER.indexOf(b.response)
    if (response !== 0) return response
    const name = a.name.localeCompare(b.name)
    return name !== 0 ? name : a.userId.localeCompare(b.userId)
  })
}
