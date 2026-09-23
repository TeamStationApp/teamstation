export interface PlayerIdentityMap {
  sourceToSession: Record<string, number>
  sessionToSource: Record<number, string | number | null>
  nextId: number
}
export function createIdentityMap(): PlayerIdentityMap {
  return { sourceToSession: {}, sessionToSource: {}, nextId: 1 }
}
/** Type-prefixed keys preserve "123" and 123 as distinct source identities. */
export function allocatePlayer(
  map: PlayerIdentityMap,
  source: string | number | null
): number {
  const key = `${typeof source}:${String(source)}`
  if (source != null && map.sourceToSession[key] != null)
    return map.sourceToSession[key]
  while (Object.hasOwn(map.sessionToSource, map.nextId)) map.nextId++
  if (!Number.isSafeInteger(map.nextId))
    throw new Error('Local player identifiers exhausted')
  const id = map.nextId++
  map.sessionToSource[id] = source
  if (source != null) map.sourceToSession[key] = id
  return id
}
