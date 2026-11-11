import type { Kysely } from 'kysely'

import { badRequest } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { fullName, type NamedPerson, shortName } from '../../common/names'
import { asUserId } from '../../common/userId'
import {
  fullNameReach,
  mayViewFullName,
  mayViewFullNames,
  type VisibleScopes,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { currentActor, requireGroupAdmin } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { personAffiliations } from './personAffiliations'
import { readerOf } from './readerNames'

export interface PeopleCandidate {
  userId: string
  displayName: string
  avatarUrl: string | null
  affiliations: string
}

export function peopleQueryOf(query: Record<string, unknown>): {
  group: GroupRef
  q: string
  exclude: string[]
} {
  const allowed = new Set(['forGroupKind', 'forGroupId', 'q', 'exclude'])
  if (Object.keys(query).some(key => !allowed.has(key)))
    throw badRequest('Ask for group accounts without other user filters')
  const kind = query.forGroupKind
  const id = query.forGroupId
  const q = query.q ?? ''
  if (kind !== 'team' && kind !== 'season' && kind !== 'league')
    throw badRequest('forGroupKind must be team, season or league')
  if (typeof id !== 'string' || id.trim() === '')
    throw badRequest('forGroupId is required')
  if (typeof q !== 'string' || q.length > 100)
    throw badRequest('q must be a string of at most 100 characters')
  const excluded =
    query.exclude == null
      ? []
      : Array.isArray(query.exclude)
        ? query.exclude
        : [query.exclude]
  if (excluded.length > 100) throw badRequest('Exclude at most 100 accounts')
  let exclude: string[]
  try {
    exclude = excluded.map(value => asUserId(value))
  } catch {
    throw badRequest('exclude must contain canonical user ids')
  }
  return { group: { kind, id }, q: q.trim().toLowerCase(), exclude }
}

/**
 * The name used for both matching and display, in full for a reader who may
 * see it (`mayViewFullName`); public team formats do not apply.
 */
export async function accountName(
  db: Kysely<Database>,
  actor: Actor,
  person: NamedPerson & { id: string }
): Promise<string> {
  return (await mayViewFullName(db, actor.userId, person.id, actor))
    ? fullName(person)
    : shortName(person)
}

/** How many candidates a search answers with. */
const CANDIDATE_LIMIT = 5
/** How many matches name authority is asked about at a time, best first. */
export const FULL_NAME_BATCH = 20
/** The most matches name authority is asked about in one search. */
export const FULL_NAME_ASKED = 100

/** A matched person and the name they are ranked by. */
interface Ranked {
  id: string
  name: string
}

export async function peopleCandidates(
  db: Kysely<Database>,
  actor: Actor,
  ask: ReturnType<typeof peopleQueryOf>,
  space?: SpaceSettings,
  /** What the reader may see, when the route has read it already. */
  scopes?: VisibleScopes
): Promise<PeopleCandidate[]> {
  const fresh = await currentActor(db, actor)
  await requireGroupAdmin(db, fresh, ask.group)
  if (ask.q === '') return []
  let query = db
    .selectFrom('users')
    .select([
      'id',
      'avatar_path',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName'
    ])
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .where('merged_into', 'is', null)
  if (ask.exclude.length > 0) query = query.where('id', 'not in', ask.exclude)
  const rows = await query.execute()
  const holds = (name: string): boolean => name.toLowerCase().includes(ask.q)
  const ranked = (a: Ranked, b: Ranked): number => {
    const prefix =
      Number(b.name.toLowerCase().startsWith(ask.q)) -
      Number(a.name.toLowerCase().startsWith(ask.q))
    if (prefix !== 0) return prefix
    const name = a.name.localeCompare(b.name)
    return name !== 0 ? name : a.id.localeCompare(b.id)
  }
  // Name authority (`mayViewFullNames`) is asked only about the matches
  // the reader might read in full (`fullNameReach`, narrowed to the matches
  // in its query): the rest read short, and so are found by the short name
  // alone. Somebody the reader reads in full is found by a surname however
  // many accounts site-wide sort ahead of him.
  const byId = new Map(rows.map(row => [row.id, row]))
  const matched = rows.filter(
    row => holds(shortName(row)) || holds(fullName(row))
  )
  if (matched.length === 0) return []
  const reach = await fullNameReach(
    db,
    fresh.userId,
    fresh,
    matched.map(row => row.id)
  )
  // Each is ranked by the name it may be shown: in full where the reader
  // might read it so and it is found by it, short otherwise. One found by
  // neither is never listed.
  const ordered = matched
    .map(row => {
      const may = reach == null || reach.has(row.id)
      return {
        row,
        may,
        id: row.id,
        name: may && holds(fullName(row)) ? fullName(row) : shortName(row)
      }
    })
    .filter(each => holds(each.name))
    .sort(ranked)
  // Read best first, asking name authority `FULL_NAME_BATCH` at a time
  // until five are kept, and about `FULL_NAME_ASKED` at most: a site admin
  // reaches everybody, and one letter matches a league. One not asked about
  // reads short. Each is matched by the name it is shown, before it is
  // kept, so one dropped is replaced.
  const readsFull = new Set<string>()
  const asked = new Set<string>()
  const kept: Ranked[] = []
  for (
    let index = 0;
    index < ordered.length && kept.length < CANDIDATE_LIMIT;
    index++
  ) {
    const each = ordered[index]
    if (each.may && !asked.has(each.id) && asked.size < FULL_NAME_ASKED) {
      const batch = ordered
        .slice(index)
        .filter(next => next.may && !asked.has(next.id))
        .slice(0, Math.min(FULL_NAME_BATCH, FULL_NAME_ASKED - asked.size))
        .map(next => next.id)
      for (const id of batch) asked.add(id)
      for (const id of await mayViewFullNames(db, fresh.userId, batch, fresh))
        readsFull.add(id)
    }
    const name = readsFull.has(each.id)
      ? fullName(each.row)
      : shortName(each.row)
    if (holds(name)) kept.push({ id: each.id, name })
  }
  const limited = kept
    .sort(ranked)
    .map(({ id, name }) => ({ userId: id, displayName: name }))
  const affiliations = await personAffiliations(
    db,
    limited.map(row => row.userId),
    {
      reader: readerOf(fresh),
      scopes: scopes ?? (await visibleScopes(db, fresh.userId, fresh.isAdmin)),
      readsFull
    }
  )
  return limited.map(row => ({
    ...row,
    avatarUrl:
      space == null
        ? null
        : imageUrl(space, byId.get(row.userId)?.avatar_path ?? null),
    affiliations: affiliations.get(row.userId) ?? ''
  }))
}
