import { asArray, asObject } from 'cleaners'

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
