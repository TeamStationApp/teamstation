import { cleanAction, type ScoringAction } from './actions'
import { scoringFingerprintInput } from './scoringMutation'

/**
 * Who scored what: the server's record of the user whose accepted request
 * added each stored action, and of who removed which actions. It holds no
 * words. Clients describe the plays themselves from the history they sync.
 */
export const SCORING_REMOVAL_LIMIT = 100

/** As stored in `games.scoring_authorship`, user ids interned. */
export interface StoredAuthorship {
  users: string[]
  /** At-bat index → one users index per record action; null unattributed. */
  plays: Record<string, Array<number | null>>
  removals: StoredRemoval[]
}

export interface StoredRemoval {
  id: string
  sequence: number
  user: number
  atBatIndex: number
  actions: ScoringAction[]
}

/** A removal as a client reads it. */
export interface RemovalRecord {
  id: string
  sequence: number
  userId: string
  atBatIndex: number
  actions: ScoringAction[]
}

/** As `GET /games/:gameId/events` and a save's answer carry it. */
export interface ScoringAuthorship {
  plays: Record<string, Array<string | null>>
  removals: RemovalRecord[]
  /** User id → short display name, '' for a name the reader may not read. */
  names: Record<string, string>
}

export function emptyAuthorship(): StoredAuthorship {
  return { users: [], plays: {}, removals: [] }
}

const isObject = (raw: unknown): raw is Record<string, unknown> =>
  raw != null && typeof raw === 'object' && !Array.isArray(raw)
const isIndex = (raw: string): boolean => /^(0|[1-9][0-9]*)$/.test(raw)
const actionsOf = (raw: unknown): ScoringAction[] =>
  Array.isArray(raw)
    ? raw.flatMap(item => {
        const cleaned = cleanAction(item)
        return 'action' in cleaned ? [cleaned.action] : []
      })
    : []

/** What the column holds, or nothing where it holds something else. */
export function storedAuthorship(raw: unknown): StoredAuthorship {
  if (!isObject(raw)) return emptyAuthorship()
  const users = Array.isArray(raw.users)
    ? raw.users.filter((user): user is string => typeof user === 'string')
    : []
  if (users.length !== (Array.isArray(raw.users) ? raw.users.length : 0))
    return emptyAuthorship()
  const known = (user: unknown): user is number =>
    typeof user === 'number' &&
    Number.isInteger(user) &&
    user >= 0 &&
    user < users.length
  const plays: StoredAuthorship['plays'] = {}
  if (isObject(raw.plays))
    for (const [index, authors] of Object.entries(raw.plays)) {
      if (!isIndex(index) || !Array.isArray(authors)) continue
      plays[index] = authors.map(user => (known(user) ? user : null))
    }
  const removals = Array.isArray(raw.removals)
    ? raw.removals.flatMap((removal): StoredRemoval[] =>
        isObject(removal) &&
        typeof removal.id === 'string' &&
        typeof removal.sequence === 'number' &&
        known(removal.user) &&
        typeof removal.atBatIndex === 'number'
          ? [
              {
                id: removal.id,
                sequence: removal.sequence,
                user: removal.user,
                atBatIndex: removal.atBatIndex,
                actions: actionsOf(removal.actions)
              }
            ]
          : []
      )
    : []
  return { users, plays, removals }
}

/**
 * The authorship after one write: per at-bat, the actions both sides share
 * from the start keep their authors, the new tail is `userId`'s (or nobody's
 * for a write no scorer made), and a scorer's write that drops actions past
 * that prefix records who removed them. `before` and `after` map an at-bat
 * to its record's actions, a current play overriding a retained row.
 */
export function stampAuthorship(
  prior: StoredAuthorship,
  before: ReadonlyMap<number, readonly ScoringAction[]>,
  after: ReadonlyMap<number, readonly ScoringAction[]>,
  userId: string | undefined,
  newId: () => string
): StoredAuthorship {
  const users = [...prior.users]
  const userIndex = (id: string): number => {
    const at = users.indexOf(id)
    if (at >= 0) return at
    users.push(id)
    return users.length - 1
  }
  const by = userId == null ? null : userIndex(userId)
  const plays: StoredAuthorship['plays'] = {}
  const removals = [...prior.removals]
  let sequence = prior.removals.at(-1)?.sequence ?? 0
  const remove = (atBatIndex: number, actions: ScoringAction[]): void => {
    if (by == null || actions.length === 0) return
    removals.push({
      id: newId(),
      sequence: ++sequence,
      user: by,
      atBatIndex,
      actions
    })
  }
  for (const [atBatIndex, next] of after) {
    const old = before.get(atBatIndex) ?? []
    const oldAuthors = prior.plays[String(atBatIndex)] ?? []
    let shared = 0
    while (
      shared < old.length &&
      shared < next.length &&
      scoringFingerprintInput(old[shared]) ===
        scoringFingerprintInput(next[shared])
    )
      shared++
    plays[String(atBatIndex)] = next.map((_, i) =>
      i < shared ? (oldAuthors[i] ?? null) : by
    )
    remove(atBatIndex, old.slice(shared))
  }
  for (const [atBatIndex, old] of before)
    if (!after.has(atBatIndex)) remove(atBatIndex, [...old])
  // Interned users nothing names any longer are dropped.
  const used = new Set<number>()
  for (const authors of Object.values(plays))
    for (const author of authors) if (author != null) used.add(author)
  const kept = removals.slice(-SCORING_REMOVAL_LIMIT)
  for (const removal of kept) used.add(removal.user)
  const renumber = new Map<number, number>()
  const compact: string[] = []
  users.forEach((user, index) => {
    if (!used.has(index)) return
    renumber.set(index, compact.length)
    compact.push(user)
  })
  const map = (index: number | null): number | null =>
    index == null ? null : (renumber.get(index) ?? null)
  return {
    users: compact,
    plays: Object.fromEntries(
      Object.entries(plays).map(([index, authors]) => [index, authors.map(map)])
    ),
    removals: kept.map(removal => ({ ...removal, user: map(removal.user)! }))
  }
}

/** The client's form, with user ids mapped through `survivor`. */
export function authorshipForWire(
  stored: StoredAuthorship,
  survivor: (userId: string) => string,
  names: ReadonlyMap<string, string>
): ScoringAuthorship {
  const ids = stored.users.map(survivor)
  return {
    plays: Object.fromEntries(
      Object.entries(stored.plays).map(([index, authors]) => [
        index,
        authors.map(author => (author == null ? null : ids[author]))
      ])
    ),
    removals: stored.removals.map(removal => ({
      id: removal.id,
      sequence: removal.sequence,
      userId: ids[removal.user],
      atBatIndex: removal.atBatIndex,
      actions: removal.actions
    })),
    names: Object.fromEntries(ids.map(id => [id, names.get(id) ?? '']))
  }
}

export function isEmptyAuthorship(authorship: StoredAuthorship): boolean {
  return (
    authorship.removals.length === 0 &&
    Object.values(authorship.plays).every(authors =>
      authors.every(author => author == null)
    )
  )
}

/** A client's tolerant read of the wire form. */
export function asScoringAuthorship(raw: unknown): ScoringAuthorship {
  if (!isObject(raw)) throw new TypeError('Expected scoring authorship')
  const plays: ScoringAuthorship['plays'] = {}
  if (isObject(raw.plays))
    for (const [index, authors] of Object.entries(raw.plays))
      if (isIndex(index) && Array.isArray(authors))
        plays[index] = authors.map(author =>
          typeof author === 'string' ? author : null
        )
  const removals = Array.isArray(raw.removals)
    ? raw.removals.flatMap((removal): RemovalRecord[] =>
        isObject(removal) &&
        typeof removal.id === 'string' &&
        typeof removal.sequence === 'number' &&
        typeof removal.userId === 'string' &&
        typeof removal.atBatIndex === 'number'
          ? [
              {
                id: removal.id,
                sequence: removal.sequence,
                userId: removal.userId,
                atBatIndex: removal.atBatIndex,
                actions: actionsOf(removal.actions)
              }
            ]
          : []
      )
    : []
  const names: Record<string, string> = {}
  if (isObject(raw.names))
    for (const [id, name] of Object.entries(raw.names))
      if (typeof name === 'string') names[id] = name
  return { plays, removals, names }
}

/**
 * One author per log action: each replayed segment's actions take that
 * at-bat's authors in order; anything past the segments (a reconciliation
 * the server has not stored) has none.
 */
export function alignAuthors(
  segments: ReadonlyArray<{ atBatIndex: number; count: number }>,
  plays: ScoringAuthorship['plays'] | undefined,
  total: number
): Array<string | null> {
  const authors: Array<string | null> = []
  for (const { atBatIndex, count } of segments) {
    const known = plays?.[String(atBatIndex)] ?? []
    for (let i = 0; i < count; i++) authors.push(known[i] ?? null)
  }
  while (authors.length < total) authors.push(null)
  return authors.slice(0, total)
}
