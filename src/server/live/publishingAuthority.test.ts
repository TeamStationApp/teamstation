import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { openScratch, type Scratch } from '../../../tools/dbLoad/testSupport'
import { makeId } from '../../common/ids'
import { canFilm, roleScopes } from '../access'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { insertUser } from '../users/insertUser'
import {
  type LiveControllerOptions,
  publishingAuthority,
  resolveKey,
  sync
} from './controller'
import { sealSecret } from './secrets'
import { configureIngest, resetForTest } from './splitter'

const SECRET = 's'.repeat(32)
const FAR_FUTURE = new Date(Date.now() + 86_400_000)

/**
 * Who may publish, asked of every open stream once a second. The answer ends a
 * publisher's stream or lets it run, so each kind of row is held to the reads
 * it was asked one at a time with, and the reads to not growing with the rows.
 */
describe('publishingAuthority', function () {
  this.timeout(60_000)

  let scratch: Scratch
  let counting: Kysely<Database>
  let mediaRoot: string
  let options: LiveControllerOptions
  const statements: string[] = []
  let streams = 0
  const people = new Map<string, string>()

  /** The id of the person called `label`, or the label if nobody is. */
  const idOf = (label: string): string => people.get(label) ?? label

  async function person(
    label: string,
    values: {
      is_admin?: boolean
      login_enabled?: boolean
      disabled_at?: Date
    } = {}
  ): Promise<string> {
    const id = await scratch.db.transaction().execute(async trx => {
      return await insertUser(trx, {
        display_name: `Load ${label}`,
        first_name: 'Load',
        last_name: label,
        birth_year: 1985,
        birth_month: 6,
        login_enabled: true
      })
    })
    if (Object.keys(values).length > 0)
      await scratch.db
        .updateTable('users')
        .set(values)
        .where('id', '=', id)
        .execute()
    people.set(label, id)
    return id
  }

  async function grant(
    userId: string,
    scopeType: 'team' | 'season' | 'league',
    scopeId: string,
    role: 'videographer' | 'scorekeeper' | 'admin' = 'videographer'
  ): Promise<void> {
    await scratch.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: scopeType,
        scope_id: scopeId,
        role
      })
      .execute()
  }

  /** A stream with no video, so that a pass looks at its authority and no more. */
  async function stream(userId: string, teamId = 'tem_home'): Promise<string> {
    streams += 1
    const id = `liv_${streams}`
    const key = `ts_${id}_${'k'.repeat(20)}`
    await scratch.db
      .insertInto('live_streams')
      .values({
        id,
        game_id: 'gam_1',
        team_id: teamId,
        user_id: userId,
        key_hash: hashToken(key),
        key_prefix: key.slice(0, 8),
        key_cipher: sealSecret(SECRET, key),
        state: 'idle',
        opens_at: new Date(Date.now() - 3_600_000),
        closes_at: FAR_FUTURE
      })
      .execute()
    return id
  }

  /** The reads as they were one row at a time, kept as the measure. */
  async function alone(row: {
    userId: string
    gameId: string
    teamId: string
  }): Promise<boolean> {
    const user = await scratch.db
      .selectFrom('users')
      .select(['is_admin', 'disabled_at', 'merged_into', 'login_enabled'])
      .where('id', '=', row.userId)
      .executeTakeFirst()
    if (
      user == null ||
      user.disabled_at != null ||
      user.merged_into != null ||
      !user.login_enabled
    )
      return false
    const game = await scratch.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', '=', row.gameId)
      .executeTakeFirst()
    if (
      game == null ||
      ![game.home_team_id, game.away_team_id].includes(row.teamId)
    )
      return false
    return canFilm(
      await roleScopes(scratch.db, row.userId, user.is_admin),
      row.teamId
    )
  }

  const asks = (
    userId: string,
    teamId = 'tem_home',
    gameId = 'gam_1'
  ): { id: string; userId: string; gameId: string; teamId: string } => ({
    id: `${userId} ${teamId} ${gameId}`,
    userId: idOf(userId),
    gameId,
    teamId
  })

  const authorityStatements = (): string[] =>
    statements.filter(text => !text.includes('"live_streams"'))

  before(async function () {
    scratch = await openScratch('authority')
    counting = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: scratch.url, max: 2 })
      }),
      log: event => {
        statements.push(event.query.sql)
      }
    })
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsAuthority-'))
    configureIngest({
      ffmpegPath: '/does/not/matter',
      bindHost: '127.0.0.1',
      port: 19_363,
      app: 'live',
      segmentSeconds: 4,
      log: () => undefined,
      onEvent: () => undefined
    })
    options = {
      db: counting,
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 19_363,
        app: 'live',
        segmentSeconds: 4,
        freeDiskFloorGb: 1
      },
      ffmpegPath: '/does/not/matter',
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: SECRET,
      log: () => undefined,
      freeBytes: async () => 1_000_000_000_000
    }

    const { db } = scratch
    await db
      .insertInto('leagues')
      .values({ id: 'lea_1', name: 'Demo League', short_name: 'DL' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: 'sea_1',
        league_id: 'lea_1',
        name: 'Demo Season',
        year: 2026,
        term: 'Spring',
        starts_on: '2026-03-01',
        ends_on: '2026-05-31'
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: 'tem_home', name: 'Demo Home', kind: 'full' },
        { id: 'tem_away', name: 'Demo Away', kind: 'full' },
        { id: 'tem_other', name: 'Demo Other', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: 'sea_1', team_id: 'tem_home' })
      .execute()
    await db
      .insertInto('games')
      .values({
        id: 'gam_1',
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        start_at: new Date()
      })
      .execute()

    await grant(await person('usr_home'), 'team', 'tem_home')
    await grant(await person('usr_away'), 'team', 'tem_away')
    await grant(await person('usr_elsewhere'), 'team', 'tem_other')
    await grant(await person('usr_season'), 'season', 'sea_1')
    await grant(await person('usr_league'), 'league', 'lea_1')
    await grant(await person('usr_teamAdmin'), 'team', 'tem_home', 'admin')
    await grant(await person('usr_scorer'), 'team', 'tem_home', 'scorekeeper')
    await person('usr_nothing')
    await person('usr_siteAdmin', { is_admin: true })
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: await person('usr_owner'),
        team_id: 'tem_home',
        role: 'owner'
      })
      .execute()
    await grant(
      await person('usr_disabled', { disabled_at: new Date() }),
      'team',
      'tem_home'
    )
    await grant(
      await person('usr_noLogin', { login_enabled: false }),
      'team',
      'tem_home'
    )
    await grant(await person('usr_merged'), 'team', 'tem_home')
    await person('usr_kept')
    await db
      .updateTable('users')
      .set({ merged_into: idOf('usr_kept') })
      .where('id', '=', idOf('usr_merged'))
      .execute()
    await person('usr_disabledAdmin', {
      is_admin: true,
      disabled_at: new Date()
    })
    await person('usr_noLoginAdmin', { is_admin: true, login_enabled: false })
  })

  after(async function () {
    resetForTest()
    await counting.destroy()
    await rm(mediaRoot, { recursive: true, force: true })
    await scratch.drop()
  })

  beforeEach(function () {
    statements.length = 0
  })

  const everyKind: Array<[string, Parameters<typeof asks>, boolean]> = [
    ['a videographer of the home side', ['usr_home'], true],
    ['a videographer of the away side', ['usr_away', 'tem_away'], true],
    ['one of the other side', ['usr_home', 'tem_away'], false],
    ['one of a team not in the game', ['usr_elsewhere', 'tem_other'], false],
    ['one of another team, asking for this one', ['usr_elsewhere'], false],
    ['a videographer through the season', ['usr_season'], true],
    ['a videographer through the league', ['usr_league'], true],
    ['a team administrator', ['usr_teamAdmin'], true],
    ['a team owner', ['usr_owner'], true],
    ['a site administrator', ['usr_siteAdmin'], true],
    [
      'a site administrator, for a side of no game',
      ['usr_siteAdmin', 'tem_other'],
      false
    ],
    ['a scorekeeper, who does not film', ['usr_scorer'], false],
    ['somebody with no role', ['usr_nothing'], false],
    ['a disabled account', ['usr_disabled'], false],
    ['a disabled site administrator', ['usr_disabledAdmin'], false],
    ['an account that may not sign in', ['usr_noLogin'], false],
    ['a site administrator who may not sign in', ['usr_noLoginAdmin'], false],
    ['a row closed by a merge', ['usr_merged'], false],
    ['the row it closed into, which held no role', ['usr_kept'], false],
    ['nobody at all', ['usr_ghost'], false],
    ['a game nobody has', ['usr_home', 'tem_home', 'gam_ghost'], false]
  ]

  for (const [name, args, expected] of everyKind)
    it(`answers ${name} as alone: ${String(expected)}`, async function () {
      const row = asks(...args)
      expect(await alone(row)).equals(expected)
      expect(await publishingAuthority(scratch.db, [row])).deep.equals(
        new Set(expected ? [row.id] : [])
      )
    })

  it('answers each kind the same among all the others', async function () {
    const rows = everyKind.map(([, args]) => asks(...args))
    const expected = everyKind
      .filter(([, , may]) => may)
      .map(([, args]) => asks(...args).id)
    for (const company of [rows, [...rows].reverse()])
      expect(
        [...(await publishingAuthority(scratch.db, company))].sort()
      ).deep.equals([...expected].sort())
  })

  it('answers each row of one person by its own side', async function () {
    const home = { ...asks('usr_home'), id: 'one' }
    const away = { ...asks('usr_home', 'tem_away'), id: 'two' }
    const again = { ...asks('usr_home'), id: 'three' }
    expect(
      [...(await publishingAuthority(scratch.db, [home, away, again]))].sort()
    ).deep.equals(['one', 'three'])
  })

  it('reads nothing for no rows, and no further than a row got', async function () {
    expect((await publishingAuthority(counting, [])).size).equals(0)
    expect(statements).deep.equals([])
    await publishingAuthority(counting, [asks('usr_disabled')])
    expect(statements).to.have.length(1)
    statements.length = 0
    await publishingAuthority(counting, [
      asks('usr_home', 'tem_home', 'gam_ghost')
    ])
    expect(statements).to.have.length(2)
  })

  it('reads the same statements for a pass of 2 rows as of 20', async function () {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const userId = await person(`usr_count${i}`)
      await grant(userId, 'team', 'tem_home')
      ids.push(await stream(userId))
    }
    try {
      const pass = async (keep: string[]): Promise<string[]> => {
        await scratch.db
          .updateTable('live_streams')
          .set({ state: 'ended' })
          .where('id', 'like', 'liv_%')
          .execute()
        await scratch.db
          .updateTable('live_streams')
          .set({ state: 'idle' })
          .where('id', 'in', keep)
          .execute()
        statements.length = 0
        await sync(options)
        return authorityStatements()
      }
      const forTwo = await pass(ids.slice(0, 2))
      const forTwenty = await pass(ids)
      expect(forTwo.length).above(3)
      expect(forTwenty).deep.equals(forTwo)
      for (const table of ['users', 'games', 'scope_roles', 'memberships'])
        expect(
          forTwenty.filter(text => text.includes(`"${table}"`)).length,
          table
        ).above(0)
      const left = await scratch.db
        .selectFrom('live_streams')
        .select('state')
        .where('id', 'in', ids)
        .execute()
      expect(left.every(row => row.state === 'idle')).equals(true)
    } finally {
      await scratch.db
        .updateTable('live_streams')
        .set({ state: 'ended', ended_at: new Date() })
        .where('id', 'in', ids)
        .execute()
    }
  })

  it('asks nothing about a stream already revoked', async function () {
    const id = await stream(idOf('usr_home'))
    await scratch.db
      .updateTable('live_streams')
      .set({ state: 'revoked', last_error: 'gone' })
      .where('id', '=', id)
      .execute()
    await sync(options)
    expect(
      statements.filter(text => text.includes('"login_enabled" ='))
    ).deep.equals([])
  })

  it('revokes on the next pass the stream of whoever lost it, and only theirs', async function () {
    const keeps = await person('usr_keeps')
    const loses = await person('usr_loses')
    const demoted = await person('usr_demoted')
    await grant(keeps, 'team', 'tem_home')
    await grant(loses, 'team', 'tem_home')
    await grant(demoted, 'team', 'tem_home')
    const kept = await stream(keeps)
    const lost = await stream(loses)
    const lostRole = await stream(demoted)
    await sync(options)
    const stateOf = async (id: string): Promise<string> => {
      const row = await scratch.db
        .selectFrom('live_streams')
        .select('state')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return row.state
    }
    expect(await stateOf(lost)).equals('idle')

    await scratch.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', loses)
      .execute()
    await scratch.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', demoted)
      .execute()
    await sync(options)
    expect(await stateOf(kept)).equals('idle')
    expect(await stateOf(lost)).not.equals('idle')
    expect(await stateOf(lostRole)).not.equals('idle')
    const row = await scratch.db
      .selectFrom('live_streams')
      .select(['last_error'])
      .where('id', '=', lost)
      .executeTakeFirstOrThrow()
    expect(row.last_error).contains('permission')
  })

  it('refuses a connecting key whose account has lost it, by the same read', async function () {
    const userId = await person('usr_connects')
    await grant(userId, 'team', 'tem_home')
    const key = `ts_connects_${'k'.repeat(20)}`
    await scratch.db
      .insertInto('live_streams')
      .values({
        id: 'liv_connects',
        game_id: 'gam_1',
        team_id: 'tem_home',
        user_id: userId,
        key_hash: hashToken(key),
        key_prefix: key.slice(0, 8),
        key_cipher: sealSecret(SECRET, key),
        state: 'idle',
        opens_at: new Date(Date.now() - 3_600_000),
        closes_at: FAR_FUTURE
      })
      .execute()
    // No video yet, so the key is not one to run, but nor is it refused.
    expect(await resolveKey(key, options)).equals(undefined)
    await scratch.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userId)
      .execute()
    expect(await resolveKey(key, options)).contains('permission')
    const row = await scratch.db
      .selectFrom('live_streams')
      .select('state')
      .where('id', '=', 'liv_connects')
      .executeTakeFirstOrThrow()
    expect(row.state).equals('revoked')
  })
})
