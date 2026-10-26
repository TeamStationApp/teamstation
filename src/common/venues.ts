import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from './asLiteral'
import { addDays } from './calendarDates'
import { asCalendarDate, isRecord } from './groupCreation'

/** The field sizes, fixed: base path / pitching distance, in feet. */
export const FIELD_SIZES = ['46/60', '50/70', '55/80', '60/90'] as const
export type FieldSize = (typeof FIELD_SIZES)[number]
export const asFieldSize = asLiteral(...FIELD_SIZES)

/** A size a person chose, with a message that says what is wrong. */
export function asFieldSizeChoice(raw: unknown): FieldSize {
  if (!FIELD_SIZES.includes(raw as FieldSize))
    throw new TypeError(`Choose a field size: ${FIELD_SIZES.join(', ')}`)
  return raw as FieldSize
}

/** How a size reads in the app. */
export function fieldSizeLabel(size: FieldSize): string {
  return size === '46/60' ? 'T-ball 46/60' : size
}

/** The longest a size switch may take, in minutes. */
export const MAX_SIZE_SWITCH_MINUTES = 240

export interface WeekdayHours {
  /** 0 is Sunday. */
  weekday: number
  /** "HH:MM", on a 5-minute step. */
  start: string
  /** "HH:MM", after `start`; "24:00" is midnight at the day's end. */
  end: string
}

/** Minutes after midnight of a wall time, "24:00" being 1440. */
export function wallMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}

/** The wall time `minutes` after midnight, on a 5-minute step. */
export function wallTimeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function asWallTime(allowMidnightEnd: boolean) {
  return (raw: unknown): string => {
    if (typeof raw !== 'string' || !/^\d{2}:\d{2}$/.test(raw))
      throw new TypeError('Choose a time')
    const minutes = wallMinutes(raw)
    const hour = Number(raw.slice(0, 2))
    const minute = Number(raw.slice(3))
    if (
      minute > 59 ||
      (allowMidnightEnd ? minutes > 1440 : hour > 23) ||
      minute % 5 !== 0
    )
      throw new TypeError('Choose a time on a 5-minute step')
    return raw
  }
}

/** A week of opening hours: at most one range per weekday, in weekday order. */
export function asWeeklyHours(raw: unknown): WeekdayHours[] {
  if (!Array.isArray(raw)) throw new TypeError('Choose the weekly hours')
  const seen = new Set<number>()
  const hours = raw.map((entry: unknown): WeekdayHours => {
    if (!isRecord(entry)) throw new TypeError('Choose the weekly hours')
    const weekday = entry.weekday
    if (
      typeof weekday !== 'number' ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6
    )
      throw new TypeError('Choose a day of the week')
    if (seen.has(weekday))
      throw new TypeError('Give each day of the week one range of hours')
    seen.add(weekday)
    const start = asWallTime(false)(entry.start)
    const end = asWallTime(true)(entry.end)
    if (wallMinutes(end) <= wallMinutes(start))
      throw new TypeError('The closing time must be after the opening time')
    return { weekday, start, end }
  })
  return hours.sort((a, b) => a.weekday - b.weekday)
}

/** The most days the blackouts of a season, venue or field can cover. */
export const MAX_BLACKOUT_DAYS = 366

/** The blackout days: distinct calendar dates, earliest first. */
export function asBlackouts(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TypeError('Choose the blackout days')
  if (raw.length > MAX_BLACKOUT_DAYS)
    throw new TypeError(`Choose at most ${MAX_BLACKOUT_DAYS} blackout days`)
  return [...new Set(raw.map(asCalendarDate))].sort()
}

/** A run of blackout days, both ends included. */
export interface DateRange {
  from: string
  to: string
}

/** Blackout days as runs of consecutive days, earliest first. */
export function blackoutRanges(dates: readonly string[]): DateRange[] {
  const ranges: DateRange[] = []
  for (const date of [...new Set(dates)].sort()) {
    const last = ranges[ranges.length - 1]
    if (last !== undefined && addDays(last.to, 1) === date) last.to = date
    else ranges.push({ from: date, to: date })
  }
  return ranges
}

/** Every day from `from` through `to`; none when `to` comes first. */
export function rangeDates(from: string, to: string): string[] {
  const dates: string[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
  return dates
}

/** A pin's coordinates, both or neither. */
export interface Pin {
  latitude: number
  longitude: number
}
export function asPin(raw: unknown): Pin {
  if (!isRecord(raw)) throw new TypeError('Drop the pin on the map')
  const { latitude, longitude } = raw
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new TypeError('Drop the pin on the map')
  return { latitude, longitude }
}

function asName(label: string, max: number) {
  return (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim() === '')
      throw new TypeError(`Enter the ${label}`)
    const name = raw.trim()
    if (name.length > max)
      throw new TypeError(`Keep the ${label} to ${max} characters`)
    return name
  }
}

/** A picture upload: the same body as a group picture's. */
export interface PhotoUpload {
  contentType: string
  base64: string
}

/** What `PUT /venues/:venueId` changes; a missing key keeps its value. */
export interface VenueChanges {
  name?: string
  sizeSwitchMinutes?: number
  defaultHours?: WeekdayHours[]
  defaultBlackouts?: string[]
  photo?: PhotoUpload
}
export function asVenueChanges(raw: unknown): VenueChanges {
  if (!isRecord(raw)) throw new TypeError('Enter the venue details')
  const changes: VenueChanges = {}
  if (raw.name !== undefined) changes.name = asName('venue name', 200)(raw.name)
  if (raw.sizeSwitchMinutes !== undefined) {
    const minutes = raw.sizeSwitchMinutes
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      minutes > MAX_SIZE_SWITCH_MINUTES
    )
      throw new TypeError(
        `Choose a size switch time from 0 to ${MAX_SIZE_SWITCH_MINUTES} minutes`
      )
    changes.sizeSwitchMinutes = minutes
  }
  if (raw.defaultHours !== undefined)
    changes.defaultHours = asWeeklyHours(raw.defaultHours)
  if (raw.defaultBlackouts !== undefined)
    changes.defaultBlackouts = asBlackouts(raw.defaultBlackouts)
  if (raw.photo !== undefined) changes.photo = asPhotoUpload(raw.photo)
  return changes
}

export function asPhotoUpload(raw: unknown): PhotoUpload {
  if (
    !isRecord(raw) ||
    typeof raw.contentType !== 'string' ||
    typeof raw.base64 !== 'string'
  )
    throw new TypeError('Choose a photo')
  return { contentType: raw.contentType, base64: raw.base64 }
}

/**
 * What creating or changing a field sets. On a change a missing key keeps its
 * value; `hours: null` returns the field to the venue's hours, and
 * `pin: null` or `dates: null` clears them.
 */
export interface FieldChanges {
  name?: string
  sizes?: FieldSize[]
  pin?: Pin | null
  dates?: { startsOn: string; endsOn: string } | null
  hours?: WeekdayHours[] | null
  blackouts?: string[]
  photo?: PhotoUpload
}
export function asFieldChanges(raw: unknown, creating: boolean): FieldChanges {
  if (!isRecord(raw)) throw new TypeError('Enter the field details')
  const changes: FieldChanges = {}
  if (raw.name !== undefined || creating)
    changes.name = asName('field name', 100)(raw.name)
  if (raw.sizes !== undefined || creating) {
    if (!Array.isArray(raw.sizes) || raw.sizes.length === 0)
      throw new TypeError('Choose at least one field size')
    const sizes = new Set(raw.sizes.map(asFieldSizeChoice))
    changes.sizes = FIELD_SIZES.filter(size => sizes.has(size))
  }
  if (raw.pin !== undefined)
    changes.pin = raw.pin === null ? null : asPin(raw.pin)
  if (raw.startsOn !== undefined || raw.endsOn !== undefined) {
    if (raw.startsOn === null && raw.endsOn === null) changes.dates = null
    else {
      const startsOn = asCalendarDate(raw.startsOn)
      const endsOn = asCalendarDate(raw.endsOn)
      if (endsOn < startsOn)
        throw new TypeError('The end date must be on or after the start date')
      changes.dates = { startsOn, endsOn }
    }
  }
  if (raw.hours !== undefined)
    changes.hours = raw.hours === null ? null : asWeeklyHours(raw.hours)
  if (raw.blackouts !== undefined)
    changes.blackouts = asBlackouts(raw.blackouts)
  if (raw.photo !== undefined) changes.photo = asPhotoUpload(raw.photo)
  return changes
}

const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asNull, cleaner)
const asWeekdayHours = asObject({
  weekday: asNumber,
  start: asString,
  end: asString
})

export const asVenueOwner = asObject({
  claimId: asString,
  leagueId: asString,
  name: asString
})
export type VenueOwner = ReturnType<typeof asVenueOwner>

export const asVenueClaim = asObject({
  id: asString,
  leagueId: asString,
  leagueName: asString,
  kind: asLiteral('claim', 'coOwner'),
  status: asLiteral('pending', 'approved', 'rejected', 'left', 'removed'),
  requestedAt: asString,
  approvesAt: asString
})
export type VenueClaim = ReturnType<typeof asVenueClaim>

export const asVenueField = asObject({
  id: asString,
  name: asString,
  sizes: asArray(asFieldSize),
  pin: asNullable(asObject({ latitude: asNumber, longitude: asNumber })),
  startsOn: asNullable(asString),
  endsOn: asNullable(asString),
  /** Null takes the venue's default hours. */
  hours: asNullable(asArray(asWeekdayHours)),
  blackouts: asArray(asString),
  photoUrl: asNullable(asString),
  photoLargeUrl: asNullable(asString)
})
export type VenueField = ReturnType<typeof asVenueField>

/** One venue in the Field Manager's list; `id` is null for a Google place. */
export const asVenueSummary = asObject({
  id: asNullable(asString),
  placeId: asString,
  name: asString,
  address: asString,
  owners: asArray(asVenueOwner),
  pendingClaim: asBoolean,
  claimed: asBoolean,
  /**
   * Where it sorts: one of the person's leagues owns or is claiming it,
   * another league owns it, or nobody does.
   */
  group: asLiteral('yours', 'claimed', 'unclaimed'),
  /** Kilometres from `near`, when the list was asked for one. */
  distanceKm: asOptional(asNullable(asNumber), null)
})
export type VenueSummary = ReturnType<typeof asVenueSummary>

export const asVenueMap = asObject({
  latitude: asNumber,
  longitude: asNumber,
  tileUrl: asString,
  googleMapsApiKey: asOptional(asString)
})
export type VenueMap = ReturnType<typeof asVenueMap>

export const asVenueRights = asObject({
  canEdit: asBoolean,
  /** The caller's leagues that may claim it, or ask to co-own it. */
  claimLeagues: asArray(asObject({ id: asString, name: asString })),
  canClaim: asBoolean,
  canRequest: asBoolean,
  /** Why neither is offered, when the caller administers a league. */
  claimBlocked: asOptional(asNullable(asString), null),
  leaveClaimIds: asArray(asString),
  canRemoveOwners: asBoolean,
  decidableClaimIds: asArray(asString)
})
export type VenueRights = ReturnType<typeof asVenueRights>

export const asVenueDetail = asObject({
  id: asNullable(asString),
  placeId: asString,
  name: asString,
  address: asString,
  timezone: asNullable(asString),
  sizeSwitchMinutes: asNumber,
  defaultHours: asArray(asWeekdayHours),
  defaultBlackouts: asArray(asString),
  photoUrl: asNullable(asString),
  photoLargeUrl: asNullable(asString),
  owners: asArray(asVenueOwner),
  claims: asArray(asVenueClaim),
  fields: asArray(asVenueField),
  rights: asVenueRights,
  map: asVenueMap
})
export type VenueDetail = ReturnType<typeof asVenueDetail>
