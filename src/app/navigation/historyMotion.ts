import type { Direction } from './stackScene'

/**
 * Which way the last history move went, from the code that saw it to the
 * shell that draws it.
 *
 * The address bars see a Back or a Forward (a `popstate`, Android's Back, a
 * link) before the shell's route handler runs, and only they can tell which
 * way it went. They note it here; the handler reads it once.
 */
export interface HistoryMove {
  direction: Direction | 'none'
  /** The browser already played its own back-swipe preview. */
  drawn: boolean
}

let noted: HistoryMove | undefined

export function noteHistoryMove(move: HistoryMove): void {
  noted = move
}

/** The noted move, once. */
export function takeHistoryMove(): HistoryMove | undefined {
  const move = noted
  noted = undefined
  return move
}
