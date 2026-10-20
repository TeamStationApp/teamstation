import { userIdOfGumbo } from '../../common/userId'
import {
  canonical,
  identityKey,
  type Json,
  type JsonObject,
  type UserIdSnapshot
} from './userIdSnapshot'

function object(value: Json): JsonObject {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an ordering object')
  return value
}

function text(value: Json): string {
  if (typeof value !== 'string') throw new Error('Expected an ordering string')
  return value
}

function count(value: Json): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected an ordering number')
  return value
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * The approved B→C ordering change, calculated solely from B. Never sort C,
 * same-schema comparisons, box-score batting, or undeclared nested collections.
 */
export function expectedStableApiOrder(
  before: UserIdSnapshot,
  manifest: string[]
): void {
  orderApiTies(before, manifest, true)
}

/**
 * Old numeric-schema aggregate and roster queries did not define tie order.
 * Compare exact tied-row multisets only for the explicit A→B transition.
 * Final-schema responses and restore comparisons must never use this adapter.
 */
export function normalizeLegacyApiTies(
  snapshot: UserIdSnapshot,
  manifest: string[]
): void {
  if (snapshot.userIdType !== 'bigint')
    throw new Error('Legacy tie comparison requires numeric user ids')
  orderApiTies(snapshot, manifest, false)
}

function orderApiTies(
  before: UserIdSnapshot,
  manifest: string[],
  includePlays: boolean
): void {
  const games = new Map(
    (before.tables.games?.rows ?? []).map(row => [identityKey(row.id), row])
  )
  const gameStart = (row: JsonObject): string | null => {
    const game = games.get(text(row.gameId))
    if (game == null || !Object.hasOwn(game, 'start_at'))
      throw new Error('Missing captured game start for play ordering')
    return game.start_at === null ? null : text(game.start_at)
  }
  const user = (row: JsonObject): string =>
    userIdOfGumbo(Number(identityKey(row.userId)))
  const byUser = (a: JsonObject, b: JsonObject): number =>
    compareText(user(a), user(b))
  const itemId = (row: JsonObject): string =>
    row.eventId == null
      ? identityKey(row.userId)
      : `${text(row.eventId)}:${text(row.role)}`

  const reorder = (
    path: string,
    suffix: string,
    value: Json,
    tied: (a: JsonObject, b: JsonObject) => boolean,
    compare: (a: JsonObject, b: JsonObject) => number
  ): void => {
    if (!Array.isArray(value)) throw new Error('Expected an ordering array')
    const rows = value.map(object)
    const ids = rows.map(itemId)
    const inventory = suffix === '' ? before.apiInventory?.[path] : undefined
    if (inventory != null && canonical(inventory.itemIds) !== canonical(ids))
      throw new Error('Ordering inventory does not match the captured array')
    // Preserve the order of every distinct primary rank. Only contiguous
    // groups tied under the old contract can gain a secondary order.
    for (let start = 0; start < rows.length;) {
      let end = start + 1
      while (end < rows.length && tied(rows[start], rows[end])) end++
      rows.splice(start, end - start, ...rows.slice(start, end).sort(compare))
      start = end
    }
    const orderedIds = rows.map(itemId)
    if (canonical(ids) !== canonical(orderedIds)) {
      value.splice(0, value.length, ...rows)
      if (inventory != null) inventory.itemIds = orderedIds
      manifest.push(
        `${includePlays ? 'ordering' : 'legacy-ties'} api:${path}${suffix}: ${ids.join(',')} -> ${orderedIds.join(',')}`
      )
    }
  }
  const stats = (
    path: string,
    suffix: string,
    value: Json,
    rank: string
  ): void => {
    reorder(
      path,
      suffix,
      value,
      (a, b) => count(a[rank]) === count(b[rank]),
      byUser
    )
  }

  for (const [path, body] of Object.entries(before.api)) {
    if (/^\/teams\/[^/]+\/stats(?:\?kind=pitching)?$/.test(path)) {
      stats(path, '', body, path.endsWith('?kind=pitching') ? 'outs' : 'pa')
    } else if (/^\/seasons\/[^/]+\/stats(?:\?kind=pitching)?$/.test(path)) {
      const held = object(body)
      stats(path, '.batting', held.batting, 'pa')
      stats(path, '.pitching', held.pitching, 'outs')
    } else if (/^\/games\/[^/]+\/box-score$/.test(path)) {
      // Pitchers use ranked workloads; batting has meaningful appearance order.
      stats(path, '.pitching', object(body).pitching, 'outs')
    } else if (/^\/teams\/[^/]+\/roster$/.test(path)) {
      reorder(
        path,
        '',
        body,
        (a, b) =>
          text(a.section) === text(b.section) &&
          (a.inheritedFrom != null) === (b.inheritedFrom != null) &&
          text(a.shortName).localeCompare(text(b.shortName)) === 0,
        byUser
      )
    } else if (includePlays && /^\/players\/[^/]+\/plays$/.test(path)) {
      reorder(
        path,
        '',
        body,
        (a, b) => gameStart(a) === gameStart(b),
        (a, b) => {
          const byGame = compareText(text(a.gameId), text(b.gameId))
          if (byGame !== 0) return byGame
          const byAtBat = count(a.atBatIndex) - count(b.atBatIndex)
          if (byAtBat !== 0) return byAtBat
          const byEvent = compareText(text(a.eventId), text(b.eventId))
          if (byEvent !== 0) return byEvent
          return compareText(text(a.role), text(b.role))
        }
      )
    }
  }
}
