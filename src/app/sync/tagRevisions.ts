/**
 * The revisions a tag save is answered with, and which answer of one target
 * is the newest.
 *
 * The server's revisions are its commit order, digits compared as numbers.
 * A tag the phone queued is answered at once with a revision of its own,
 * `local:<digits>`, in the phone's own order. The two are never compared
 * with each other: between a server answer and a phone answer, the save the
 * screen made later is the newer, whichever answer came first.
 */

const LOCAL = 'local:'

/**
 * The number of the phone's next queued tag at `now`, after `last`: later
 * than the last whatever the clock does (a correction can set it back), and
 * from the clock where it is ahead, so a restarted queue still counts on.
 */
export function nextLocalTagRevision(now: number, last: number): number {
  return Math.max(last + 1, now * 1000)
}

/** The phone's revision numbered `value` (`nextLocalTagRevision`). */
export function localTagRevision(value: number): string {
  return `${LOCAL}${value}`
}

export function isLocalTagRevision(revision: string): boolean {
  return revision.startsWith(LOCAL)
}

/** What the screen last took for a target: its revision, and its save's place. */
export interface TagAcknowledgment {
  revision: string
  /** The screen's count of tag saves when this one was made. */
  order: number
}

/** Whether `a` is earlier than `b`, both digits, as numbers. */
function earlier(a: string, b: string): boolean {
  return a.length < b.length || (a.length === b.length && a < b)
}

/**
 * Whether `answer` is older than what the screen already took for its
 * target, and so is dropped.
 */
export function supersededTag(
  acknowledged: TagAcknowledgment | undefined,
  answer: TagAcknowledgment
): boolean {
  if (acknowledged == null) return false
  const local = isLocalTagRevision(answer.revision)
  if (local !== isLocalTagRevision(acknowledged.revision))
    return answer.order < acknowledged.order
  const strip = (revision: string): string =>
    local ? revision.slice(LOCAL.length) : revision
  return earlier(strip(answer.revision), strip(acknowledged.revision))
}
