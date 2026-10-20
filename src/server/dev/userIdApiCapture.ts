import {
  canonical,
  identityKey,
  type Json,
  type JsonObject
} from './userIdSnapshot'

export interface ApiInventory {
  status: number
  pages: number
  total: number | null
  itemIds: string[]
}

function object(value: Json): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
function itemId(value: Json): string {
  if (!object(value)) throw new Error('Expected an identified collection item')
  if (value.eventId != null && value.role != null)
    return `${identityKey(value.eventId)}:${identityKey(value.role)}`
  if (value.id != null) return identityKey(value.id)
  if (value.userId != null) return identityKey(value.userId)
  if (value.teamId != null) return identityKey(value.teamId)
  throw new Error('Collection item has no declared identity')
}

/** Current array endpoints and an explicit cursor envelope; unknown pagination fails closed. */
export async function captureEndpoint(
  path: string,
  origin: string,
  token: string,
  request: typeof fetch
): Promise<{ body: Json; inventory: ApiInventory }> {
  const endpoint = origin.replace(/\/$/, '') + path
  let url = endpoint
  const cursors = new Set<string>()
  const ids = new Set<string>()
  const items: Json[] = []
  let first: JsonObject | undefined, metadata: string | undefined
  for (let pages = 1; pages <= 10000; pages++) {
    const response = await request(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    })
    if (response.status !== 200)
      throw new Error(`Snapshot endpoint failed: ${path} (${response.status})`)
    const body = (await response.json()) as Json
    if (
      object(body) &&
      ('nextPage' in body || 'hasMore' in body || 'nextBefore' in body)
    )
      throw new Error(`Pagination needs an explicit adapter: ${path}`)
    if (!object(body) || !('nextCursor' in body)) {
      if (pages !== 1) throw new Error(`Pagination envelope changed: ${path}`)
      const itemIds = Array.isArray(body) ? body.map(itemId) : []
      if (new Set(itemIds).size !== itemIds.length)
        throw new Error(`Duplicate collection identity: ${path}`)
      return {
        body,
        inventory: {
          status: response.status,
          pages,
          total: Array.isArray(body) ? body.length : null,
          itemIds
        }
      }
    }
    if (
      !Array.isArray(body.items) ||
      typeof body.total !== 'number' ||
      !Number.isSafeInteger(body.total) ||
      body.total < 0 ||
      (body.nextCursor !== null && typeof body.nextCursor !== 'string')
    )
      throw new Error(`Invalid pagination envelope: ${path}`)
    const { items: pageItems, nextCursor, ...stable } = body
    const encoded = canonical(stable)
    if (metadata != null && metadata !== encoded)
      throw new Error(`Pagination metadata changed: ${path}`)
    metadata = encoded
    first ??= body
    for (const item of pageItems) {
      const id = itemId(item)
      if (ids.has(id)) throw new Error(`Duplicate collection identity: ${path}`)
      ids.add(id)
      items.push(item)
    }
    if (nextCursor === null) {
      if (items.length !== body.total)
        throw new Error(`Truncated collection: ${path}`)
      return {
        body: { ...first, items, nextCursor: null },
        inventory: { status: 200, pages, total: body.total, itemIds: [...ids] }
      }
    }
    if (nextCursor === '' || cursors.has(nextCursor))
      throw new Error(`Repeated pagination cursor: ${path}`)
    cursors.add(nextCursor)
    const next = new URL(endpoint)
    next.searchParams.set('cursor', nextCursor)
    url = next.toString()
  }
  throw new Error(`Pagination did not terminate: ${path}`)
}
