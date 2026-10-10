import { asCalendarDate } from './groupCreation'

/** Interpret a calendar date and wall time in an explicit IANA zone, never server-local time. */
export function gameTime(date: string, time: string, timezone: string): string {
  asCalendarDate(date)
  if (
    !/^\d{2}:\d{2}$/.test(time) ||
    Number(time.slice(0, 2)) > 23 ||
    Number(time.slice(3)) > 59
  )
    throw new TypeError('Choose a valid time')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  const parts = (instant: number): number => {
    const values = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .map(part => [part.type, part.value])
    )
    return Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute)
    )
  }
  let instant = wanted
  for (let pass = 0; pass < 3; pass++) instant += wanted - parts(instant)
  if (parts(instant) !== wanted)
    throw new TypeError(
      'That time does not exist in this time zone. Choose another time.'
    )
  return new Date(instant).toISOString()
}
export function gameCalendarDay(startAt: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(new Date(startAt))
      .map(part => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}
