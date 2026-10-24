import { asArray, asObject } from 'cleaners'

import type { SideTeams } from './scoring/teamRecord'
import { listsBySide } from './teamLists'
import { asGumboId } from './userId'

function uniqueIds(raw: unknown): number[] {
  const ids = asArray(asGumboId)(raw)
  if (new Set(ids).size !== ids.length)
    throw new Error('Duplicate unrostered player')
  return ids
}
const clean = asObject({ away: uniqueIds, home: uniqueIds })
export type Unrostered = ReturnType<typeof clean>
export function asUnrostered(raw: unknown): Unrostered {
  return raw === undefined ? { away: [], home: [] } : clean(raw)
}

/** A game's players left off, by side, as stored under its teams. */
export function storedUnrostered(raw: unknown, teams: SideTeams): Unrostered {
  return asUnrostered(raw === undefined ? raw : listsBySide(raw, teams))
}
