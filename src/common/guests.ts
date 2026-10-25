import { asArray, asObject } from 'cleaners'

import type { SideTeams } from './scoring/teamRecord'
import { listsBySide } from './teamLists'
import { asGumboId } from './userId'

function uniqueIds(raw: unknown): number[] {
  const ids = asArray(asGumboId)(raw)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate game player')
  return ids
}
const clean = asObject({ away: uniqueIds, home: uniqueIds })
export type Guests = ReturnType<typeof clean>
export function asGuests(raw: unknown): Guests {
  return raw === undefined ? { away: [], home: [] } : clean(raw)
}

/** A game's guests by side, as stored under its teams (`teamLists`). */
export function storedGuests(raw: unknown, teams: SideTeams): Guests {
  return asGuests(raw === undefined ? raw : listsBySide(raw, teams))
}
