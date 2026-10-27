import { addDays } from './calendarDates'
import {
  effectiveEventEnd,
  eventLocalFields,
  viewerTimezone
} from './eventTime'
import { asGameTimezone } from './gameApprovals'
import { gameTime } from './gameTime'

export interface EventScheduleDraft {
  date: string
  time: string
  timezone: string
  endDate: string
  endTime: string
  hasEndTime: boolean
  hasEndDate: boolean
  customEnd: boolean
  startTimeSelected: boolean
  endTimeSelected: boolean
  originalStart?: string
  originalEnd?: string | null
  originalStartKey: string
  originalEndKey: string
  inferredEnd: string
  inferredEndKey: string
  savedTimezone?: string
}
const startKey = (
  draft: Pick<EventScheduleDraft, 'date' | 'time' | 'timezone'>
): string =>
  `${draft.date}/${draft.time}/${new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).resolvedOptions().timeZone}`
const endKey = (
  draft: Pick<EventScheduleDraft, 'endDate' | 'endTime' | 'timezone'>
): string =>
  `${draft.endDate}/${draft.endTime}/${new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).resolvedOptions().timeZone}`

export function newEventSchedule(
  startAt?: string | null,
  endAt?: string | null,
  timezone = viewerTimezone(),
  savedTimezone?: string
): EventScheduleDraft {
  const starting = eventLocalFields(
    startAt ?? new Date().toISOString(),
    timezone
  )
  if (startAt == null) starting.time = '18:00'
  const instant = startAt ?? gameTime(starting.date, starting.time, timezone)
  const inferredEnd = effectiveEventEnd(instant, endAt)
  const end = eventLocalFields(inferredEnd, timezone)
  const draft = {
    ...starting,
    timezone,
    endDate: end.date,
    endTime: end.time,
    hasEndTime: endAt != null,
    hasEndDate: endAt != null && end.date !== starting.date,
    customEnd: endAt != null,
    startTimeSelected: false,
    endTimeSelected: false,
    originalStart: startAt ?? undefined,
    originalEnd: endAt,
    originalStartKey: '',
    originalEndKey: '',
    inferredEnd,
    inferredEndKey: '',
    savedTimezone
  }
  return {
    ...draft,
    originalStartKey: startKey(draft),
    originalEndKey: endKey(draft),
    inferredEndKey: endKey(draft)
  }
}

export function scheduleStart(draft: EventScheduleDraft): string {
  return (
    retainedClock(
      draft.originalStart,
      draft.originalStartKey,
      draft.date,
      draft.time,
      draft.timezone,
      draft.startTimeSelected
    ) ?? gameTime(draft.date, draft.time, asGameTimezone(draft.timezone))
  )
}

/** Prefer the loaded offset when a new clock still exists at that offset. */
function retainedClock(
  reference: string | null | undefined,
  key: string,
  date: string,
  time: string,
  timezone: string,
  selected: boolean
): string | undefined {
  if (reference == null) return undefined
  const local = eventLocalFields(reference, timezone)
  if (startKey({ date, time: local.time, timezone }) !== key) return undefined
  if (time === local.time) return selectedInstant(reference, selected)
  const delta =
    Date.parse(gameTime(date, time, 'UTC')) -
    Date.parse(gameTime(local.date, local.time, 'UTC'))
  const candidate = selectedInstant(
    new Date(Date.parse(reference) + delta).toISOString(),
    true
  )
  const resolved = eventLocalFields(candidate, timezone)
  return resolved.date === date && resolved.time === time
    ? candidate
    : undefined
}

function retainedEnd(draft: EventScheduleDraft): string | undefined {
  return (
    retainedClock(
      draft.inferredEnd,
      draft.inferredEndKey,
      draft.endDate,
      draft.endTime,
      draft.timezone,
      draft.endTimeSelected
    ) ??
    retainedClock(
      draft.originalEnd,
      draft.originalEndKey,
      draft.endDate,
      draft.endTime,
      draft.timezone,
      draft.endTimeSelected
    )
  )
}

/** Reconfirming a clock drops hidden seconds while retaining a DST-fold offset. */
function selectedInstant(instant: string, selected: boolean): string {
  if (!selected) return instant
  const date = new Date(instant)
  date.setUTCSeconds(0, 0)
  return date.toISOString()
}

/** Draft updates remain recoverable even during an invalid wall-time edit. */
export function changeEventSchedule(
  draft: EventScheduleDraft,
  change: Partial<
    Pick<
      EventScheduleDraft,
      | 'date'
      | 'time'
      | 'timezone'
      | 'endDate'
      | 'endTime'
      | 'hasEndTime'
      | 'hasEndDate'
    >
  >
): EventScheduleDraft {
  let next = { ...draft, ...change }
  if (change.time !== undefined) next.startTimeSelected = true
  if (change.endTime !== undefined) next.endTimeSelected = true
  if (change.hasEndTime === false)
    next = {
      ...next,
      hasEndDate: false,
      customEnd: false,
      endTimeSelected: false
    }
  else if (change.endTime !== undefined || change.endDate !== undefined)
    next.customEnd = true
  try {
    if (!next.customEnd) {
      next.inferredEnd = effectiveEventEnd(scheduleStart(next))
      const end = eventLocalFields(next.inferredEnd, next.timezone)
      next.endDate = end.date
      next.endTime = end.time
      next.inferredEndKey = endKey(next)
    } else if (
      !next.hasEndDate &&
      (change.endTime !== undefined || change.hasEndDate === false) &&
      !(
        change.endTime === draft.endTime &&
        change.hasEndDate !== false &&
        change.endDate === undefined
      )
    ) {
      const sameDay = { ...next, endDate: next.date }
      const retained = retainedEnd(sameDay)
      next.endDate =
        retained != null &&
        Date.parse(retained) > Date.parse(scheduleStart(next))
          ? next.date
          : next.endTime <= next.time
            ? addDays(next.date, 1)
            : next.date
    }
  } catch {
    // The shared form presents validation; a partial draft never crashes it.
  }
  return next
}

export function eventScheduleValue(draft: EventScheduleDraft): {
  startAt: string
  endAt: string | null
  timezone: string
} {
  const timezone = asGameTimezone(draft.timezone)
  const startAt = scheduleStart(draft)
  const endAt =
    !draft.hasEndTime && !draft.hasEndDate
      ? null
      : !draft.customEnd
        ? effectiveEventEnd(startAt)
        : (retainedEnd(draft) ??
          gameTime(draft.endDate, draft.endTime, timezone))
  if (endAt != null && Date.parse(endAt) <= Date.parse(startAt))
    throw new TypeError('End time must be after start time')
  return { startAt, endAt, timezone }
}
