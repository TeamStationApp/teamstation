import type { PostEventsBody } from '../../common/gumboPlay'
import { recordOf } from '../../common/scoring/gumbo'
import {
  recordBySide,
  recordByTeam,
  type SideTeams
} from '../../common/scoring/teamRecord'

/**
 * Records as they travel. TeamStation stores a play's record by team
 * (version 3); the API carries it by side (version 2), under the game's
 * teams as they stand, so an app that reads only version 2 still reads every
 * play, and what it posts by side is stored by team.
 */

/** A play's record object, if it has one. */
export function recordIn(play: unknown): Record<string, unknown> | null {
  if (play == null || typeof play !== 'object') return null
  const raw = (play as { teamStation?: unknown }).teamStation
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/** A stored play or at-bat as the API answers it: its record by side. */
export function playForWire<T>(play: T, teams: SideTeams): T {
  const raw = recordIn(play)
  if (raw?.version !== 3) return play
  try {
    return { ...play, teamStation: recordBySide(raw, teams) }
  } catch {
    // A record naming another game's team reads as no record, as it would
    // when stored; it goes out as it is.
    return play
  }
}

/** A posted play or at-bat as it is stored: its record by team. */
export function playFromWire<T>(play: T, teams: SideTeams): T {
  const raw = recordIn(play)
  if (raw == null || raw.version === 3) return play
  const record = recordOf(play, teams)
  if (record == null) return play
  return { ...play, teamStation: { ...raw, ...recordByTeam(record, teams) } }
}

/** A post's plays and at-bat in progress, as they are stored. */
export function bodyFromWire(
  body: PostEventsBody,
  teams: SideTeams
): PostEventsBody {
  return {
    ...body,
    plays: body.plays.map(play => playFromWire(play, teams)),
    ...(body.currentPlay == null
      ? {}
      : { currentPlay: playFromWire(body.currentPlay, teams) })
  }
}
