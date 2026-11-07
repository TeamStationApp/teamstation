import type { Kysely } from 'kysely'

import { badRequest } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { fullName, type NamedPerson, shortName } from '../../common/names'
import { asUserId } from '../../common/userId'
import { mayEditName, mayEditNames } from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { currentActor, requireGroupAdmin } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { personAffiliations } from './personAffiliations'

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

/** The name used for both matching and display; public team formats do not apply. */
export async function accountName(
  db: Kysely<Database>,
  actor: Actor,
  person: NamedPerson & { id: string }
): Promise<string> {
  return (await mayEditName(db, actor.userId, person.id, actor))
    ? fullName(person)
    : shortName(person)
}

export async function peopleCandidates(
  db: Kysely<Database>,
  actor: Actor,
  ask: ReturnType<typeof peopleQueryOf>,
  space?: SpaceSettings
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
  const rows = (await query.execute()).filter(row =>
    [fullName(row), shortName(row)].some(name =>
      name.toLowerCase().includes(ask.q)
    )
  )
  const full = await mayEditNames(
    db,
    fresh.userId,
    rows.map(row => row.id),
    fresh
  )
  const matches: Array<Pick<PeopleCandidate, 'userId' | 'displayName'>> = []
  for (const row of rows) {
    const displayName = full.has(row.id) ? fullName(row) : shortName(row)
    if (displayName.toLowerCase().includes(ask.q))
      matches.push({ userId: row.id, displayName })
  }
  const limited = matches
    .sort((a, b) => {
      const prefix =
        Number(b.displayName.toLowerCase().startsWith(ask.q)) -
        Number(a.displayName.toLowerCase().startsWith(ask.q))
      if (prefix !== 0) return prefix
      const name = a.displayName.localeCompare(b.displayName)
      return name !== 0 ? name : a.userId.localeCompare(b.userId)
    })
    .slice(0, 5)
  const affiliations = await personAffiliations(
    db,
    limited.map(row => row.userId)
  )
  const avatars = new Map(rows.map(row => [row.id, row.avatar_path]))
  return limited.map(row => ({
    ...row,
    avatarUrl:
      space == null ? null : imageUrl(space, avatars.get(row.userId) ?? null),
    affiliations: affiliations.get(row.userId) ?? ''
  }))
}
