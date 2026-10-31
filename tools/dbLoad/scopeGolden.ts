import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'kysely'

import { makeId } from '../../src/common/ids'
import { ROLES } from '../../src/common/roles'
import {
  guardedPlayers,
  guardedRows,
  roleScopes,
  type RoleScopes,
  teamsPlayedOnNow,
  type VisibleScopes,
  visibleScopes
} from '../../src/server/access'
import { closeInto, onePerson } from '../../src/server/admin/people'
import {
  type Actor,
  actorForToken,
  createSession,
  USER_API_KEY_PREFIX
} from '../../src/server/auth/sessions'
import { hashToken, makeToken } from '../../src/server/auth/tokens'
import { atomic } from '../../src/server/db/atomic'
import { addToScope } from '../../src/server/invites/people'
import { sealSecret } from '../../src/server/live/secrets'
import { insertUser } from '../../src/server/users/insertUser'
import type { LoadDatabase } from './database'
import { systemOf, taggedIn, type TokensFile } from './fixture'

/**
 * What the single-user permission functions answer for every person of a
 * seeded run, written by fixture label rather than id, since ids are random.
 * A golden copy of this holds those functions to what they answered before
 * they were built on the batched reads.
 */

/** One person's answers, every id a label and every list sorted. */
export interface GoldenPerson {
  survivor: string
  rows: string[]
  teams: string[]
  seasons: string[]
  isAdmin: boolean
  guarded: string[]
  guardedRows: string[]
  guardedPlayers: string[]
  playsOnNow: string[]
  roles: Record<string, { leagues: string[]; seasons: string[]; teams: string[] }>
  rolesAdmin: boolean
}

/** What a credential resolves to, or null when it is refused. */
export type GoldenActor = {
  user: string
  isAdmin: boolean
  via: 'session' | 'apiToken' | 'apiKey'
  scopes: string[]
  permissions: string[]
} | null

export interface Golden {
  people: Record<string, GoldenPerson>
  actors: Record<string, GoldenActor>
}

/** The id `shape.ghost` stands for: nobody has this row. */
export const GHOST_ID = 'ghost-row-that-does-not-exist'

/** The labels of one run's rows. */
export interface Labels {
  users: Map<string, string>
  teams: Map<string, string>
  seasons: Map<string, string>
  leagues: Map<string, string>
}

async function tag(
  db: LoadDatabase,
  runId: string,
  kind: string,
  label: string,
  id: string
): Promise<void> {
  await db
    .insertInto('external_ids')
    .values({
      id: makeId('externalId'),
      entity_type: kind,
      entity_id: id,
      system: systemOf(runId),
      kind,
      external_id: label
    })
    .execute()
}

/**
 * The shapes that decide a permission and that a load fixture has no reason
 * to build: what a merge leaves behind on a closed row, guardian links that
 * name closed rows, chains around the depth limit, a loop, and every way a
 * credential can be refused. Returns the credentials, by label.
 */
export async function seedAgreementShapes(
  db: LoadDatabase,
  runId: string
): Promise<Map<string, string>> {
  const person = async (label: string): Promise<string> => {
    const id = await db.transaction().execute(async trx => {
      return await insertUser(trx, {
        display_name: `Load ${label.replace(/[^a-zA-Z0-9]+/g, ' ')}`,
        first_name: 'Load',
        last_name: label.replace(/[^a-zA-Z0-9]+/g, ' '),
        birth_year: 1985,
        birth_month: 6,
        login_enabled: true
      })
    })
    await tag(db, runId, 'user', label, id)
    return id
  }
  const league = async (label: string): Promise<string> => {
    const id = makeId('league')
    await db
      .insertInto('leagues')
      .values({ id, name: `Load ${label}`, short_name: 'LOAD' })
      .execute()
    await tag(db, runId, 'league', label, id)
    return id
  }
  const season = async (
    label: string,
    leagueId: string | null
  ): Promise<string> => {
    const id = makeId('season')
    await db
      .insertInto('seasons')
      .values({
        id,
        league_id: leagueId,
        name: `Load ${label}`,
        year: 2026,
        term: 'Spring',
        starts_on: '2026-03-01',
        ends_on: '2026-05-31'
      })
      .execute()
    await tag(db, runId, 'season', label, id)
    return id
  }
  const team = async (
    label: string,
    links: { seasonId?: string; leagueId?: string } = {}
  ): Promise<string> => {
    const id = makeId('team')
    await db
      .insertInto('teams')
      .values({
        id,
        name: `Load ${label}`,
        kind: 'full',
        league_id: links.leagueId ?? null
      })
      .execute()
    if (links.seasonId != null)
      await db
        .insertInto('season_teams')
        .values({ season_id: links.seasonId, team_id: id })
        .execute()
    await tag(db, runId, 'team', label, id)
    return id
  }
  const join = async (
    kind: 'team' | 'season' | 'league',
    scopeId: string,
    userId: string
  ): Promise<void> => {
    await atomic(db, async trx => {
      await addToScope(trx, kind, scopeId, userId)
    })
  }
  const plays = async (
    userId: string,
    teamId: string,
    isPlayer = true,
    role = 'member'
  ): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role,
        is_player: isPlayer
      })
      .execute()
  }
  const link = async (
    userId: string,
    relatedId: string,
    kind = 'guardian'
  ): Promise<void> => {
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userId,
        related_user_id: relatedId,
        kind
      })
      .execute()
  }
  const chain = async (label: string, depth: number): Promise<string[]> => {
    const rows: string[] = []
    for (let i = 0; i <= depth; i++) rows.push(await person(`${label}.row${i}`))
    for (let i = 0; i < depth; i++)
      await db
        .updateTable('users')
        .set({ merged_into: rows[i + 1] })
        .where('id', '=', rows[i])
        .execute()
    return rows
  }

  const homeLeague = await league('shape.league')
  const homeSeason = await season('shape.season', homeLeague)
  const looseSeason = await season('shape.looseSeason', null)
  const seasonTeam = await team('shape.seasonTeam', { seasonId: homeSeason })
  const leagueTeam = await team('shape.leagueTeam', { leagueId: homeLeague })
  const looseTeam = await team('shape.looseTeam', { seasonId: looseSeason })
  const childTeam = await team('shape.childTeam')
  const goneTeam = await team('shape.goneTeam')
  await db
    .updateTable('teams')
    .set({ merged_into: childTeam })
    .where('id', '=', goneTeam)
    .execute()
  // A team reached only through the explicit parent link, once it is ready.
  const parentTeam = await team('shape.parentTeam')
  await db
    .insertInto('season_team_parents')
    .values({ season_id: looseSeason, team_id: parentTeam })
    .execute()

  // A closed row keeps the season, league and scope role written on it.
  const keptScopes = await person('shape.keptScopes')
  const closedScopes = await person('shape.closedScopes')
  await join('season', looseSeason, closedScopes)
  await join('league', homeLeague, closedScopes)
  await plays(closedScopes, looseTeam)
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: closedScopes,
      scope_type: 'team',
      scope_id: seasonTeam,
      role: 'coach'
    })
    .execute()
  await closeInto(db, closedScopes, keptScopes)

  // A link from a closed row of the guardian, to a closed row of the child.
  const keptGuardian = await person('shape.keptGuardian')
  const closedGuardian = await person('shape.closedGuardian')
  const keptChild = await person('shape.keptChild')
  const closedChild = await person('shape.closedChild')
  await plays(closedChild, childTeam)
  await plays(keptChild, goneTeam)
  await link(closedGuardian, closedChild)
  await closeInto(db, closedGuardian, keptGuardian)
  await closeInto(db, closedChild, keptChild)

  // Somebody closed into the asker is the asker, not their child.
  const selfGuardian = await person('shape.selfGuardian')
  const selfRow = await person('shape.selfRow')
  await plays(selfRow, seasonTeam)
  await closeInto(db, selfRow, selfGuardian)
  await link(selfGuardian, selfRow, 'family')

  // Two people who share a child, and a child on no team as a player.
  const firstParent = await person('shape.firstParent')
  const secondParent = await person('shape.secondParent')
  const sharedChild = await person('shape.sharedChild')
  const benchChild = await person('shape.benchChild')
  await plays(sharedChild, leagueTeam)
  await plays(benchChild, looseTeam, false)
  await link(firstParent, sharedChild)
  await link(secondParent, sharedChild, 'family')
  await link(firstParent, benchChild)
  // A link that grants nothing, and a guardian and a child who are disabled.
  const otherLink = await person('shape.otherLink')
  await link(otherLink, sharedChild, 'other')
  const disabledGuardian = await person('shape.disabledGuardian')
  const disabledChild = await person('shape.disabledChild')
  const carer = await person('shape.carerOfDisabled')
  await plays(disabledChild, seasonTeam)
  await link(disabledGuardian, sharedChild)
  await link(carer, disabledChild)
  await db
    .updateTable('users')
    .set({ disabled_at: new Date() })
    .where('id', 'in', [disabledGuardian, disabledChild])
    .execute()

  // A team's owner and manager, and every level of a role and a membership.
  const owner = await person('shape.owner')
  await plays(owner, looseTeam, false, 'owner')
  const manager = await person('shape.manager')
  await plays(manager, childTeam, false, 'manager')
  const bothLevels = await person('shape.bothLevels')
  await join('team', looseTeam, bothLevels)
  await join('season', homeSeason, bothLevels)
  await db
    .insertInto('scope_roles')
    .values([
      {
        id: makeId('scopeRole'),
        user_id: bothLevels,
        scope_type: 'league',
        scope_id: homeLeague,
        role: 'scorekeeper'
      },
      {
        id: makeId('scopeRole'),
        user_id: bothLevels,
        scope_type: 'season',
        scope_id: looseSeason,
        role: 'admin'
      }
    ])
    .execute()

  // Chains around the limit, each with a season at its far end, and a guardian
  // whose child is the far end of one.
  for (const depth of [15, 16, 17]) {
    const rows = await chain(`shape.chain${depth}`, depth)
    await join('season', homeSeason, rows[0])
    await join('league', homeLeague, rows[rows.length - 1])
    const carerOf = await person(`shape.carerOfChain${depth}`)
    await plays(rows[0], childTeam)
    await link(carerOf, rows[rows.length - 1])
    const carerOfFar = await person(`shape.carerOfFarEnd${depth}`)
    await link(carerOfFar, rows[0])
    await plays(rows[rows.length - 1], looseTeam)
  }

  // A loop no writer should make, and a row at the side of it.
  const loopA = await person('shape.loopA')
  const loopB = await person('shape.loopB')
  const loopC = await person('shape.loopC')
  const loopTail = await person('shape.loopTail')
  await db.updateTable('users').set({ merged_into: loopB }).where('id', '=', loopA).execute()
  await db.updateTable('users').set({ merged_into: loopC }).where('id', '=', loopB).execute()
  await db.updateTable('users').set({ merged_into: loopA }).where('id', '=', loopC).execute()
  await db.updateTable('users').set({ merged_into: loopA }).where('id', '=', loopTail).execute()
  const carerOfLoop = await person('shape.carerOfLoop')
  await link(carerOfLoop, loopTail)
  await plays(loopB, seasonTeam)
  await tag(db, runId, 'user', 'shape.ghost', GHOST_ID)

  // Credentials: each kind good, and each way of being refused.
  const credentials = new Map<string, string>()
  const holder = await person('shape.holder')
  const session = async (
    label: string,
    userId: string,
    days?: number
  ): Promise<string> => {
    const made = await createSession(db, userId, 'scope golden', { days })
    credentials.set(label, made.token)
    return made.token
  }
  const apiToken = async (
    label: string,
    userId: string,
    values: { revoked_at?: Date; expires_at?: Date; scopes?: string[] } = {}
  ): Promise<void> => {
    const token = makeToken()
    await db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userId,
        label: 'golden',
        token_hash: hashToken(token),
        ...values
      })
      .execute()
    credentials.set(label, token)
  }
  const apiKey = async (
    label: string,
    userId: string,
    values: { revoked_at?: Date } = {}
  ): Promise<void> => {
    const token = `${USER_API_KEY_PREFIX}${makeToken()}`
    await db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: userId,
        name: 'golden',
        token_hash: hashToken(token),
        secret_sealed: sealSecret('0'.repeat(64), token),
        permissions: ['games:read', 'games:write'],
        ...values
      })
      .execute()
    credentials.set(label, token)
  }
  const past = new Date(Date.now() - 86_400_000)
  const future = new Date(Date.now() + 86_400_000)
  await session('session.good', holder)
  await session('session.expired', holder, -1)
  const revoked = await session('session.revoked', holder)
  await db
    .updateTable('auth_sessions')
    .set({ revoked_at: past })
    .where('token_hash', '=', hashToken(revoked))
    .execute()
  await apiToken('token.good', holder, { scopes: ['read', 'write'] })
  await apiToken('token.neverExpires', holder)
  await apiToken('token.notYetExpired', holder, { expires_at: future })
  await apiToken('token.expired', holder, { expires_at: past })
  await apiToken('token.revoked', holder, { revoked_at: past })
  await apiKey('key.good', holder)
  await apiKey('key.revoked', holder, { revoked_at: past })
  // A session whose token happens to read as a key is still a session.
  const keyShaped = `${USER_API_KEY_PREFIX}${makeToken()}`
  await db
    .insertInto('auth_sessions')
    .values({
      id: makeId('authSession'),
      user_id: holder,
      token_hash: hashToken(keyShaped),
      user_agent: 'scope golden',
      expires_at: future
    })
    .execute()
  credentials.set('session.keyShaped', keyShaped)

  // One secret held under more than one table, which only chance could write:
  // the order they are asked in is what decides.
  const under = async (
    label: string,
    token: string,
    tables: {
      key?: { revoked_at?: Date }
      session?: { revoked_at?: Date }
      apiToken?: boolean
    }
  ): Promise<void> => {
    const tokenHash = hashToken(token)
    if (tables.key != null)
      await db
        .insertInto('user_api_keys')
        .values({
          id: makeId('userApiKey'),
          user_id: keyHolder,
          name: 'golden',
          token_hash: tokenHash,
          secret_sealed: sealSecret('0'.repeat(64), token),
          permissions: ['games:read'],
          ...tables.key
        })
        .execute()
    if (tables.session != null)
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: sessionHolder,
          token_hash: tokenHash,
          user_agent: 'scope golden',
          expires_at: future,
          ...tables.session
        })
        .execute()
    if (tables.apiToken === true)
      await db
        .insertInto('api_tokens')
        .values({
          id: makeId('apiToken'),
          user_id: tokenHolder,
          label: 'golden',
          token_hash: tokenHash
        })
        .execute()
    credentials.set(label, token)
  }
  const keyHolder = await person('shape.keyHolder')
  const sessionHolder = await person('shape.sessionHolder')
  const tokenHolder = await person('shape.tokenHolder')
  const shaped = (): string => `${USER_API_KEY_PREFIX}${makeToken()}`
  // A good key comes before a session; a refused one gives way to it.
  await under('both.goodKeyAndSession', shaped(), { key: {}, session: {} })
  await under('both.revokedKeyAndSession', shaped(), {
    key: { revoked_at: past },
    session: {}
  })
  await under('both.revokedKeyAndToken', shaped(), {
    key: { revoked_at: past },
    apiToken: true
  })
  // A session found decides, even when it refuses and a token would not.
  await under('both.goodSessionAndToken', makeToken(), {
    session: {},
    apiToken: true
  })
  await under('both.revokedSessionAndToken', makeToken(), {
    session: { revoked_at: past },
    apiToken: true
  })
  // Only a token that reads as a key is looked for among the keys.
  await under('both.plainTokenOnlyAKey', makeToken(), { key: {} })

  // Each of the above for an account that has since been disabled or closed.
  const offUser = await person('shape.offHolder')
  await session('session.disabled', offUser)
  await apiToken('token.disabled', offUser)
  await apiKey('key.disabled', offUser)
  await db
    .updateTable('users')
    .set({ disabled_at: past })
    .where('id', '=', offUser)
    .execute()
  const closedUser = await person('shape.closedHolder')
  const keptUser = await person('shape.keptHolder')
  await session('session.closed', closedUser)
  await apiToken('token.closed', closedUser)
  await apiKey('key.closed', closedUser)
  // By hand rather than `closeInto`, which would revoke them: this is the
  // second lock on the same door.
  await db
    .updateTable('users')
    .set({ merged_into: keptUser })
    .where('id', '=', closedUser)
    .execute()
  credentials.set('unknown.plain', makeToken())
  credentials.set('unknown.keyShaped', `${USER_API_KEY_PREFIX}${makeToken()}`)
  return credentials
}

/** Sets which of a team's two season links carries roles down. */
export async function setHierarchyReady(
  db: LoadDatabase,
  ready: boolean
): Promise<void> {
  await db
    .deleteFrom('system_settings')
    .where('key', '=', 'creation.hierarchyReady')
    .execute()
  if (ready)
    await sql`insert into system_settings (key, value)
      values ('creation.hierarchyReady', 'true')`.execute(db)
}

/** Every label of a run, by kind. */
export async function labelsOf(
  db: LoadDatabase,
  runId: string
): Promise<Labels> {
  return {
    users: await taggedIn(db, runId, 'user'),
    teams: await taggedIn(db, runId, 'team'),
    seasons: await taggedIn(db, runId, 'season'),
    leagues: await taggedIn(db, runId, 'league')
  }
}

function namer(
  labels: Map<string, string>,
  what: string
): (ids: Iterable<string>) => string[] {
  const byId = new Map([...labels].map(([label, id]) => [id, label]))
  return ids =>
    [...ids]
      .map(id => {
        const label = byId.get(id)
        if (label == null) throw new Error(`An untagged ${what}: ${id}`)
        return label
      })
      .sort()
}

/** One person's visible scopes, by label, for comparing or for the snapshot. */
export function namedScopes(
  labels: Labels,
  scopes: VisibleScopes
): Pick<GoldenPerson, 'teams' | 'seasons' | 'isAdmin' | 'guarded'> {
  return {
    teams: namer(labels.teams, 'team')(scopes.teamIds),
    seasons: namer(labels.seasons, 'season')(scopes.seasonIds),
    isAdmin: scopes.isAdmin,
    guarded: namer(labels.users, 'user')(scopes.guardedIds ?? [])
  }
}

function namedRoles(
  labels: Labels,
  scopes: RoleScopes
): GoldenPerson['roles'] {
  const roles: GoldenPerson['roles'] = {}
  for (const role of ROLES) {
    const set = scopes[role]
    if (set.leagueIds.size + set.seasonIds.size + set.teamIds.size === 0)
      continue
    roles[role] = {
      leagues: namer(labels.leagues, 'league')(set.leagueIds),
      seasons: namer(labels.seasons, 'season')(set.seasonIds),
      teams: namer(labels.teams, 'team')(set.teamIds)
    }
  }
  return roles
}

/** One actor, by label, without the ids that differ from run to run. */
export function namedActor(
  labels: Labels,
  actor: Actor | undefined
): GoldenActor {
  if (actor == null) return null
  return {
    user: namer(labels.users, 'user')([actor.userId])[0],
    isAdmin: actor.isAdmin,
    via:
      actor.sessionId != null
        ? 'session'
        : actor.apiTokenId != null
          ? 'apiToken'
          : 'apiKey',
    scopes: [...actor.scopes].sort(),
    permissions: [...(actor.apiKey?.permissions ?? [])].sort()
  }
}

/** Reads every person and credential through the single-user functions. */
export async function captureGolden(
  db: LoadDatabase,
  runId: string,
  tokens: Pick<TokensFile, 'accounts'>,
  credentials: ReadonlyMap<string, string>
): Promise<Golden> {
  const labels = await labelsOf(db, runId)
  const names = namer(labels.users, 'user')
  const people: Golden['people'] = {}
  for (const label of [...labels.users.keys()].sort()) {
    const id = labels.users.get(label) as string
    const one = await onePerson(db, id)
    const roles = await roleScopes(db, id, false)
    people[label] = {
      survivor: names([one.userId])[0],
      rows: names(one.userIds),
      ...namedScopes(labels, await visibleScopes(db, id, false)),
      guardedRows: names(await guardedRows(db, id)),
      guardedPlayers: names(await guardedPlayers(db, id)),
      playsOnNow: namer(
        labels.teams,
        'team'
      )(await teamsPlayedOnNow(db, one.userIds)),
      roles: namedRoles(labels, roles),
      rolesAdmin: roles.isAdmin
    }
  }
  const actors: Golden['actors'] = {}
  const all: Array<[string, string]> = [
    ...tokens.accounts.map(
      account => [`account:${account.label}`, account.token] as [string, string]
    ),
    ...credentials
  ]
  for (const [label, token] of all.sort(([a], [b]) => (a < b ? -1 : 1)))
    actors[label] = namedActor(
      labels,
      await actorForToken(db, token, { recordUse: false })
    )
  return { people, actors }
}

/**
 * The golden copy: every answer with the season links as they stand before the
 * hierarchy is ready, and those that differ once it is.
 */
export interface GoldenFile {
  legacy: Golden
  ready: Golden
}

const GOLDEN_PATH = join(__dirname, 'scopeSnapshot.json')

export function readGolden(): GoldenFile {
  const file = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile
  return {
    legacy: file.legacy,
    ready: {
      people: { ...file.legacy.people, ...file.ready.people },
      actors: { ...file.legacy.actors, ...file.ready.actors }
    }
  }
}

/** One person or credential to a line, so a change reads as a small diff. */
export function writeGolden({ legacy, ready }: GoldenFile): void {
  const differing = <T>(
    all: Record<string, T>,
    base: Record<string, T>
  ): Record<string, T> =>
    Object.fromEntries(
      Object.entries(all).filter(
        ([label, value]) =>
          JSON.stringify(value) !== JSON.stringify(base[label])
      )
    )
  const lines = (section: Record<string, unknown>): string =>
    Object.entries(section)
      .map(
        ([label, value]) =>
          `    ${JSON.stringify(label)}: ${JSON.stringify(value)}`
      )
      .join(',\n')
  const mode = (golden: Golden): string =>
    `{\n  "people": {\n${lines(golden.people)}\n  },\n  "actors": {\n${lines(golden.actors)}\n  }\n}`
  writeFileSync(
    GOLDEN_PATH,
    `{\n"legacy": ${mode(legacy)},\n"ready": ${mode({
      people: differing(ready.people, legacy.people),
      actors: differing(ready.actors, legacy.actors)
    })}\n}\n`
  )
}
