import { badRequest } from '../../common/errors'

/**
 * Where a page of activity ended: the last row's time, to the microsecond
 * Postgres keeps (a JavaScript date keeps the millisecond, and would skip a
 * row a few microseconds older), and its id, which breaks a tie.
 */
export interface ActivityCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, as `ACTIVITY_AT_SQL` writes it. */
  at: string
  id: string
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/** A row's time, written for a cursor, from a column of `timestamptz`. */
export const ACTIVITY_AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

/**
 * Whether the time is one the calendar has: JavaScript reads 30 February as
 * 2 March, so it must write back as the same second it was read from.
 */
function onCalendar(at: string): boolean {
  const ms = Date.parse(at)
  return (
    !Number.isNaN(ms) &&
    new Date(ms).toISOString().slice(0, 19) === at.slice(0, 19)
  )
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url')
}

/** The cursor a page answered, or a 400 for anything else. */
export function decodeActivityCursor(text: string): ActivityCursor {
  const refuse = (): Error =>
    badRequest('cursor is not one a page of this list answered')
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(text)) throw refuse()
  const decoded = Buffer.from(text, 'base64url').toString('utf8')
  const bar = decoded.indexOf('|')
  if (bar < 0) throw refuse()
  const at = decoded.slice(0, bar)
  const id = decoded.slice(bar + 1)
  if (!AT.test(at) || !onCalendar(at)) throw refuse()
  if (id === '' || id.length > 200 || /[|\s]/.test(id)) throw refuse()
  return { at, id }
}
