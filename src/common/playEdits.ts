import type { PlayEditsData } from './gameSocket'
import {
  asCurrentPlay,
  asGumboPlay,
  type CurrentPlay,
  type GumboPlay
} from './gumboPlay'

/** A game's plays as a screen holds them, with what they were read as. */
export interface HeldPlays {
  plays: GumboPlay[]
  currentPlay: CurrentPlay | null
  playsDigest?: string
  /** The digest of the book the plays were named from (`namesDigest`). */
  namesDigest?: string
  generation?: number
}

/**
 * The held game with a `playEdits` change applied: each put written at its
 * play's `atBatIndex`, in place of whatever was there, each remove taken
 * away, the plays in index order, the at-bat in progress replaced and the
 * digest moved on. Null when the change does not apply to what is held, so
 * the holder reads the game again: when it carries no edits, was made in
 * another generation, starts from a digest other than the held one, or was
 * named from another book than the held plays (`namesDigest`), whose names
 * may since have changed on plays it does not carry, or when a play it
 * carries does not read.
 */
export function applyPlayEdits<T extends HeldPlays>(
  held: T,
  data: PlayEditsData
): T | null {
  if (
    data.edits == null ||
    data.generation !== held.generation ||
    data.fromDigest == null ||
    data.fromDigest !== held.playsDigest ||
    data.namesDigest == null ||
    data.namesDigest !== held.namesDigest
  )
    return null
  try {
    const plays = new Map(held.plays.map(play => [play.about.atBatIndex, play]))
    for (const edit of data.edits) {
      if (edit.op === 'remove') plays.delete(edit.atBatIndex)
      else {
        const play = asGumboPlay(edit.play.gumbo)
        plays.set(play.about.atBatIndex, play)
      }
    }
    const currentPlay =
      data.currentPlay == null ? null : asCurrentPlay(data.currentPlay)
    const next = {
      ...held,
      plays: [...plays.values()].sort(
        (a, b) => a.about.atBatIndex - b.about.atBatIndex
      ),
      currentPlay
    }
    if (data.digest == null) delete next.playsDigest
    else next.playsDigest = data.digest
    return next
  } catch {
    return null
  }
}
