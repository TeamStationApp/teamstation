import { asArray, asObject } from 'cleaners'

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
