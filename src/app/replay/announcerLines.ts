/** One sentence the play card's words area holds, keyed for React. */
export interface AnnouncerEntry {
  key: number
  text: string
}

/** What the play card's words area holds: its last few sentences. */
export interface AnnouncerLines {
  entries: AnnouncerEntry[]
  /** The rewind the entries were said since. */
  rewinds: number
  /** The step the newest entry was said for, or null for none. */
  step: string | null
  /** The only entry is a rewind's words. */
  notice: boolean
  /** The next entry's key. */
  next: number
}

/** How many sentences the area keeps: twice what it shows. */
export const KEPT_LINES = 6

/** An empty area, before anything is said. */
export const NO_LINES: AnnouncerLines = {
  entries: [],
  rewinds: 0,
  step: null,
  notice: false,
  next: 0
}

/**
 * The area once the card says `card.line`, for `card.step`: the shown step
 * whose own sentence the line is, or null when it is not one, such as "Play
 * ball!" or, while the shown step's sentence is not yet in, the one before
 * it said again. A new step's line is added even when its words are the
 * newest entry's, as two two-strike fouls in a row say the same sentence. A
 * line equal to the newest entry is not added for the same step drawn again,
 * nor for no step. A line that ends with the newest, for the same step or
 * no step, such as the scorer's correction of it, replaces it; a new step's
 * line is always a line of its own, whatever its words end with. A rewind starts the history afresh; a
 * rewind's words stand alone until they go, and the next sentence starts the
 * history again. Returns `previous` itself when nothing changes.
 */
export function nextLines(
  previous: AnnouncerLines,
  card: { line: string; step: string | null; notice: boolean; rewinds: number }
): AnnouncerLines {
  let lines = previous
  // A rewind, or a rewind's words that have gone: start again.
  if (card.rewinds !== lines.rewinds || (lines.notice && !card.notice))
    lines = {
      ...lines,
      entries: [],
      rewinds: card.rewinds,
      step: null,
      notice: false
    }
  const { entries } = lines
  const newest = entries.at(-1)
  if (card.notice) {
    if (lines.notice && newest?.text === card.line) return lines
    return {
      ...lines,
      entries: [{ key: lines.next, text: card.line }],
      notice: true,
      next: lines.next + 1
    }
  }
  if (card.line === '') return lines
  const step = card.step ?? lines.step
  const fresh = card.step != null && card.step !== lines.step
  if (newest?.text === card.line && !fresh) return lines
  if (
    !fresh &&
    newest != null &&
    newest.text !== card.line &&
    card.line.endsWith(newest.text)
  )
    return {
      ...lines,
      step,
      entries: [...entries.slice(0, -1), { key: newest.key, text: card.line }]
    }
  return {
    ...lines,
    step,
    entries: [...entries, { key: lines.next, text: card.line }].slice(
      -KEPT_LINES
    ),
    next: lines.next + 1
  }
}
