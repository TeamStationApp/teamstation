import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect } from 'chai'
import express from 'express'
import {
  Kysely,
  type KyselyPlugin,
  PostgresDialect,
  type RawBuilder,
  sql
} from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'
import { createClient } from 'redis'

import { seedFixture, type TokensFile } from '../../../tools/dbLoad/fixture'
import {
  type Labels,
  labelsOf,
  seedAgreementShapes,
  setHierarchyReady
} from '../../../tools/dbLoad/scopeGolden'
import { TEST_AMOUNTS } from '../../../tools/dbLoad/testAmounts'
import { openScratch, type Scratch } from '../../../tools/dbLoad/testSupport'
import type { RosterEntry } from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateDown, migrateUp } from '../../migrate/runner'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  dropPrefix,
  requireRedis,
  scratchDatabase,
  testRedisUrl
} from '../../test/scoreboardKit'
import { silentValkey, untilAsked } from '../../test/silentValkey'
import { mergeTeams } from '../admin/mergeTeams'
import { closeInto } from '../admin/people'
import { createSession } from '../auth/sessions'
import { makeValkeyCache, type ValkeyCache } from '../cache/valkeyCache'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import type { SpaceSettings } from '../media/spacesHls'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { accountRoutes } from '../routes/account'
import { playerRoutes } from '../routes/players'
import { runSpoken } from '../users/readerNames'
import {
  CORE_FORMAT,
  CORE_MAX_BYTES,
  pruneRosterBumps,
  ROSTER_USER_COLUMNS,
  rosterCacheOn,
  type RosterCore,
  startRosterBumpPrune,
  teamRosterCore
} from './rosterCore'
import { onPeopleList, peopleAt, teamRoster } from './teamRoster'

const SPACE: SpaceSettings = {
  endpoint: 'https://space.example.test',
  region: 'us-east-1',
  bucket: 'pictures',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret'
}

type Viewer = { userId: string; isAdmin: boolean } | undefined

/** A cache that counts what it is asked and what it answers. */
interface Counted extends ValkeyCache {
  gets: number
  hits: number
  sets: number
}

function counted(cache: ValkeyCache): Counted {
  const counts: Counted = {
    gets: 0,
    hits: 0,
    sets: 0,
    get: async key => {
      counts.gets += 1
      const held = await cache.get(key)
      if (held != null) counts.hits += 1
      return held
    },
    set: async (key, value, ttlMs) => {
      counts.sets += 1
      await cache.set(key, value, ttlMs)
    },
    close: async () => {
      await cache.close()
    }
  }
  return counts
}

/** A cache on the test Valkey, once its client answers. */
async function readyCache(
  prefix: string,
  databaseUrl: string,
  log: (message: string) => void = () => undefined,
  now?: () => number
): Promise<ValkeyCache> {
  const cache = makeValkeyCache({
    redis: { url: testRedisUrl, prefix },
    databaseUrl,
    log,
    now
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await cache.set('ready', '1', 60_000)
    if ((await cache.get('ready')) === '1') return cache
    await sleep(20)
  }
  throw new Error('The roster cache did not connect')
}

/** A presigned URL without its signature, which carries the time. */
function unsigned(roster: RosterEntry[]): RosterEntry[] {
  return roster.map(entry => ({
    ...entry,
    avatarUrl: entry.avatarUrl == null ? null : entry.avatarUrl.split('?')[0]
  }))
}

async function keysUnder(prefix: string): Promise<string[]> {
  const client = createClient({ url: testRedisUrl })
  await client.connect()
  const keys: string[] = []
  for await (const batch of client.scanIterator({ MATCH: `${prefix}:*` }))
    keys.push(...batch)
  await client.close()
  return keys.filter(key => !key.endsWith(':ready')).sort()
}

/**
 * A key prefix of this run's own, outside `ts-test:`. The scoreboard suites
 * drop every `ts-test:` key when they finish, and another checkout's run on
 * the same Valkey does that in the middle of these cases, so an entry stored
 * here would go before the read that should hit it and be stored again.
 */
function testPrefix(): string {
  return `ts-roster-test:${randomBytes(6).toString('hex')}`
}

/** The team's version: its newest bump. */
async function versionOf(
  db: Kysely<Database>,
  teamId: string
): Promise<number | undefined> {
  const row = await db
    .selectFrom('team_roster_bumps')
    .select('version')
    .where('team_id', '=', teamId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row == null ? undefined : Number(row.version)
}

describe('team rosters through the Valkey cache', function () {
  this.timeout(600_000)

  before(async function () {
    await requireRedis()
  })

  describe('agreement with the uncached roster, on the scope agreement fixture', function () {
    const RUN = 'rosterCache'
    let scratch: Scratch
    let labels: Labels
    let prefix: string
    let cache: Counted
    let heldTeam: string
    let heldGuardian: string

    before(async function () {
      scratch = await openScratch('rostercache')
      const tokens: TokensFile = await seedFixture(scratch.db, {
        runId: RUN,
        scale: 'small',
        overrides: TEST_AMOUNTS,
        log: () => undefined
      })
      expect(tokens.accounts.length).above(0)
      await seedAgreementShapes(scratch.db, RUN)
      labels = await labelsOf(scratch.db, RUN)
      const { db } = scratch
      // Faces for some, so a space set presigns from the cached path.
      await sql`update users set avatar_path = 'avatars/' || id
        where id in (select user_id from memberships order by id limit 40)`.execute(
        db
      )
      // A player held by an open add, with a guardian to read it as.
      const held = await sql<{
        teamId: string
        userId: string
        membershipId: string
        guardianId: string
      }>`
        select memberships.team_id as "teamId", memberships.user_id as "userId",
          memberships.id as "membershipId", user_links.user_id as "guardianId"
        from memberships
        inner join user_links on user_links.related_user_id = memberships.user_id
          and user_links.kind = 'guardian'
        inner join users on users.id = memberships.user_id
        where memberships.is_player and users.merged_into is null
        order by memberships.team_id, memberships.user_id
        limit 1
      `.execute(db)
      expect(held.rows).length(1)
      const [row] = held.rows
      heldTeam = row.teamId
      heldGuardian = row.guardianId
      await db
        .insertInto('group_requests')
        .values({
          id: makeId('invite'),
          kind: 'playerAdd',
          sender_id: row.guardianId,
          sender_scope_type: 'team',
          sender_scope_id: row.teamId,
          terms: JSON.stringify({
            kind: 'playerAdd',
            mode: 'roster',
            userId: row.userId,
            teamId: row.teamId,
            membershipId: row.membershipId,
            createdMembership: true,
            jersey: null,
            positions: [],
            teamName: 'Held'
          }),
          status: 'applied',
          sent_at: new Date(),
          expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          initiating_team_id: row.teamId
        })
        .execute()
      prefix = testPrefix()
      cache = counted(await readyCache(prefix, scratch.url))
    })

    after(async function () {
      await cache?.close()
      if (prefix != null) await dropPrefix(prefix)
      if (scratch != null) {
        await setHierarchyReady(scratch.db, false)
        await scratch.drop()
      }
    })

    /** Each kind of reader the plan names, for one team, where it has one. */
    async function viewersOf(
      db: Kysely<Database>,
      teamId: string
    ): Promise<Array<[string, Viewer]>> {
      const first = async (
        query: RawBuilder<{ id: string }>
      ): Promise<string | undefined> => (await query.execute(db)).rows[0]?.id
      const siteAdmin = await first(
        sql`select id from users where is_admin and merged_into is null order by id limit 1`
      )
      const teamAdmin = await first(sql`
        select user_id as id from memberships
          where team_id = ${teamId} and role in ('owner', 'manager')
        union all
        select user_id from scope_roles
          where scope_type = 'team' and scope_id = ${teamId} and role = 'admin'
        order by id limit 1`)
      const staff = await first(sql`
        select user_id as id from scope_roles
          where scope_type = 'team' and scope_id = ${teamId}
            and role in ('coach', 'assistant', 'scorekeeper')
        order by id limit 1`)
      const guardian =
        teamId === heldTeam
          ? heldGuardian
          : await first(sql`
        select user_links.user_id as id from user_links
          inner join memberships on memberships.user_id = user_links.related_user_id
          where memberships.team_id = ${teamId} and memberships.is_player
            and user_links.kind = 'guardian'
          order by id limit 1`)
      const player = await first(sql`
        select user_id as id from memberships
          where team_id = ${teamId} and is_player order by id limit 1`)
      const stranger = await first(sql`
        select id from users
          where not is_admin and merged_into is null
            and id not in (select user_id from memberships where team_id = ${teamId})
            and id not in (select user_id from scope_roles)
            and id not in (select user_id from user_links)
            and id not in (select related_user_id from user_links)
          order by id limit 1`)
      const viewers: Array<[string, Viewer]> = [['none', undefined]]
      if (siteAdmin != null)
        viewers.push(['siteAdmin', { userId: siteAdmin, isAdmin: true }])
      for (const [kind, id] of [
        ['teamAdmin', teamAdmin],
        ['staff', staff],
        ['guardian', guardian],
        ['player', player],
        ['stranger', stranger]
      ] as const)
        if (id != null) viewers.push([kind, { userId: id, isAdmin: false }])
      return viewers
    }

    for (const mode of ['legacy', 'ready'] as const)
      it(`answers every reader of every team as uncached, cold then warm, with ${mode === 'ready' ? 'a ready hierarchy' : 'the season links as they stand before one'}`, async function () {
        const { db } = scratch
        await setHierarchyReady(db, mode === 'ready')
        const seen = new Set<string>()
        let heldShown = false
        let compared = 0
        let withVersions = 0
        for (const [label, teamId] of [...labels.teams].sort(([a], [b]) =>
          a.localeCompare(b)
        )) {
          await dropPrefix(prefix)
          const viewers = await viewersOf(db, teamId)
          const hitsBefore = cache.hits
          const setsBefore = cache.sets
          for (const [kind, viewer] of viewers) {
            seen.add(kind)
            for (const includeFullNames of [false, true])
              for (const space of [undefined, SPACE])
                for (const spoken of [false, true]) {
                  const read = async (
                    through?: ValkeyCache
                  ): Promise<RosterEntry[]> => {
                    const run = async (): Promise<RosterEntry[]> =>
                      await teamRoster(
                        db,
                        space,
                        teamId,
                        includeFullNames,
                        viewer,
                        through
                      )
                    return unsigned(spoken ? await runSpoken(run) : await run())
                  }
                  const uncached = await read()
                  const where = `${label} ${kind} full=${String(includeFullNames)} space=${String(space != null)} spoken=${String(spoken)}`
                  expect(await read(cache), `${where} cold`).deep.equals(
                    uncached
                  )
                  expect(await read(cache), `${where} warm`).deep.equals(
                    uncached
                  )
                  if (
                    teamId === heldTeam &&
                    uncached.some(entry => entry.ownIdentity === true)
                  )
                    heldShown = true
                  compared += 1
                }
          }
          // One entry per team with a version, stored once and read by
          // everybody after; a team with none (no membership yet) is read
          // directly.
          const versioned = (await versionOf(db, teamId)) != null
          if (versioned) withVersions += 1
          expect(cache.sets - setsBefore, label).equals(versioned ? 1 : 0)
          expect(cache.hits - hitsBefore, label).equals(
            versioned ? viewers.length * 16 - 1 : 0
          )
        }
        expect([...seen].sort()).deep.equals(
          [
            'guardian',
            'none',
            'player',
            'siteAdmin',
            'staff',
            'stranger',
            'teamAdmin'
          ].sort()
        )
        expect(
          heldShown,
          'a held player, as the readers it is held from see it'
        ).equals(true)
        expect(compared).above(100)
        expect(withVersions).above(5)
      })

    it('answers a level’s people list through the cache as without it, and finds a member it lists by the membership check', async function () {
      const { db } = scratch
      const teamId = heldTeam
      const viewer = (await viewersOf(db, teamId))[1][1]
      const listed = await peopleAt(db, undefined, { kind: 'team', id: teamId })
      expect(
        await peopleAt(
          db,
          undefined,
          { kind: 'team', id: teamId },
          viewer,
          cache
        )
      ).deep.equals(
        await peopleAt(db, undefined, { kind: 'team', id: teamId }, viewer)
      )
      const member = listed![0].userId
      expect(
        await onPeopleList(db, { kind: 'team', id: teamId }, member, viewer)
      ).equals(true)
    })
  })

  describe('the version and what moves it', function () {
    let db: Kysely<Database>
    let url: string
    let drop: () => Promise<void>
    let prefix: string
    let cache: Counted
    const TEAM_A = 'tem_rc_a'
    const TEAM_B = 'tem_rc_b'
    const TEAM_C = 'tem_rc_c'
    const person = (n: number): string => userIdOfGumbo(7_100_000 + n)

    before(async function () {
      ;({ db, url, drop } = await scratchDatabase('rostercache'))
      prefix = testPrefix()
      cache = counted(await readyCache(prefix, url))
    })

    after(async function () {
      await cache?.close()
      if (prefix != null) await dropPrefix(prefix)
      await drop?.()
    })

    beforeEach(async function () {
      await sql`delete from walk_up_songs`.execute(db)
      await sql`delete from memberships`.execute(db)
      await sql`delete from group_requests where initiating_team_id like 'tem_rc_%'`.execute(
        db
      )
      await sql`delete from teams where id like 'tem_rc_%'`.execute(db)
      await db
        .insertInto('teams')
        .values([
          { id: TEAM_A, name: 'Alders' },
          { id: TEAM_B, name: 'Birches' },
          { id: TEAM_C, name: 'Cedars' }
        ])
        .execute()
      const existing = new Set(
        (await db.selectFrom('users').select('id').execute()).map(row => row.id)
      )
      const users = [1, 2, 3, 4, 5, 6]
        .filter(n => !existing.has(person(n)))
        .map(n => ({ id: 7_100_000 + n, display_name: `Person ${n}` }))
      if (users.length > 0) await insertFixtureUsers(db, users)
      for (const n of [1, 2, 3, 4, 5, 6])
        await db
          .updateTable('users')
          .set({
            merged_into: null,
            display_name: `Person ${n}`,
            avatar_path: n === 1 ? 'avatars/one' : null
          })
          .where('id', '=', person(n))
          .execute()
      await db
        .insertInto('memberships')
        .values([
          {
            id: 'mem_rc_a1',
            team_id: TEAM_A,
            user_id: person(1),
            is_player: true,
            jersey: '1'
          },
          {
            id: 'mem_rc_a2',
            team_id: TEAM_A,
            user_id: person(2),
            is_player: true,
            jersey: '2'
          },
          {
            id: 'mem_rc_b2',
            team_id: TEAM_B,
            user_id: person(2),
            is_player: true,
            jersey: '12'
          },
          {
            id: 'mem_rc_b3',
            team_id: TEAM_B,
            user_id: person(3),
            is_player: true,
            jersey: '3'
          },
          {
            id: 'mem_rc_c4',
            team_id: TEAM_C,
            user_id: person(4),
            is_player: true,
            jersey: '4'
          },
          {
            id: 'mem_rc_a5',
            team_id: TEAM_A,
            user_id: person(5),
            role: 'manager'
          }
        ])
        .execute()
    })

    /** The cached read of each team equals the uncached one. */
    async function agrees(...teamIds: string[]): Promise<void> {
      for (const teamId of teamIds)
        expect(
          unsigned(await teamRoster(db, SPACE, teamId, true, undefined, cache)),
          teamId
        ).deep.equals(unsigned(await teamRoster(db, SPACE, teamId, true)))
    }

    /** Runs `write` and says which of the three teams' versions moved. */
    async function moved(write: () => Promise<unknown>): Promise<string[]> {
      await agrees(TEAM_A, TEAM_B, TEAM_C)
      const before = new Map<string, number | undefined>()
      for (const teamId of [TEAM_A, TEAM_B, TEAM_C])
        before.set(teamId, await versionOf(db, teamId))
      await write()
      const changed: string[] = []
      for (const teamId of [TEAM_A, TEAM_B, TEAM_C]) {
        const after = await versionOf(db, teamId)
        if (after !== before.get(teamId)) {
          expect(after!, teamId).above(before.get(teamId) ?? 0)
          changed.push(teamId)
        }
      }
      await agrees(TEAM_A, TEAM_B, TEAM_C)
      return changed
    }

    /** A team's bump versions, in order. */
    async function bumpsOf(teamId: string): Promise<number[]> {
      return (
        await db
          .selectFrom('team_roster_bumps')
          .select('version')
          .where('team_id', '=', teamId)
          .orderBy('version')
          .execute()
      ).map(row => Number(row.version))
    }

    it('gives every team a version, and a new team one with its first membership', async function () {
      expect(await versionOf(db, TEAM_A)).above(0)
      await db
        .insertInto('teams')
        .values({ id: 'tem_rc_new', name: 'New' })
        .execute()
      expect(await versionOf(db, 'tem_rc_new')).equals(undefined)
      await db
        .insertInto('memberships')
        .values({ id: 'mem_rc_new', team_id: 'tem_rc_new', user_id: person(1) })
        .execute()
      expect(await versionOf(db, 'tem_rc_new')).above(
        (await versionOf(db, TEAM_A))!
      )
      await sql`delete from teams where id = 'tem_rc_new'`.execute(db)
    })

    it('moves the version of the teams a membership insert, update or delete touches', async function () {
      expect(
        await moved(async () => {
          await db
            .insertInto('memberships')
            .values({
              id: 'mem_rc_a3',
              team_id: TEAM_A,
              user_id: person(3),
              is_player: true
            })
            .execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        await moved(async () => {
          await db
            .updateTable('memberships')
            .set({ jersey: '99' })
            .where('id', 'in', ['mem_rc_a1', 'mem_rc_b3'])
            .execute()
        })
      ).deep.equals([TEAM_A, TEAM_B])
      expect(
        await moved(async () => {
          await db
            .deleteFrom('memberships')
            .where('id', '=', 'mem_rc_a3')
            .execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        await moved(async () => {
          await db
            .updateTable('memberships')
            .set({ team_id: TEAM_C })
            .where('id', '=', 'mem_rc_b3')
            .execute()
        })
      ).deep.equals([TEAM_B, TEAM_C])
    })

    for (const column of ROSTER_USER_COLUMNS)
      it(`moves every team of a person whose ${column} changes`, async function () {
        const value: Record<(typeof ROSTER_USER_COLUMNS)[number], unknown> = {
          display_name: 'Renamed',
          first_name: 'Ren',
          last_name: 'Amed',
          bats: 'left',
          throws: 'left',
          avatar_path: 'avatars/renamed',
          merged_into: person(6)
        }
        expect(
          await moved(async () => {
            await sql`update users set ${sql.ref(column)} = ${value[column]}
              where id = ${person(2)}`.execute(db)
          })
        ).deep.equals([TEAM_A, TEAM_B])
      })

    it('leaves the version alone when a column the roster does not read changes, or a value is written unchanged', async function () {
      expect(
        await moved(async () => {
          await sql`update users set birth_year = 2014, birth_month = 5, updated_at = now()
            where id = ${person(2)}`.execute(db)
          await sql`update users set display_name = display_name where id = ${person(2)}`.execute(
            db
          )
        })
      ).deep.equals([])
    })

    it('moves the team of a walk-up song put, replaced and deleted', async function () {
      const song = {
        team_id: TEAM_A,
        user_id: person(1),
        provider: 'appleMusic' as const,
        provider_id: 'song-1',
        title: 'Walk On',
        artist: 'Band',
        duration_ms: 200_000,
        start_ms: 0,
        end_ms: 15_000,
        set_by: person(5)
      }
      expect(
        await moved(async () => {
          await db.insertInto('walk_up_songs').values(song).execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        await moved(async () => {
          await db
            .insertInto('walk_up_songs')
            .values({ ...song, title: 'Walk Off' })
            .onConflict(oc =>
              oc
                .columns(['team_id', 'user_id'])
                .doUpdateSet({ title: 'Walk Off' })
            )
            .execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        (await teamRoster(db, undefined, TEAM_A, false, undefined, cache)).find(
          entry => entry.userId === person(1)
        )?.walkUpSong?.title
      ).equals('Walk Off')
      expect(
        await moved(async () => {
          await db
            .deleteFrom('walk_up_songs')
            .where('team_id', '=', TEAM_A)
            .execute()
        })
      ).deep.equals([TEAM_A])
    })

    it('moves the teams of a person given a gumbo id, or whose gumbo id changes', async function () {
      await db
        .deleteFrom('gumbo_ids')
        .where('user_id', '=', person(5))
        .execute()
      expect(
        await moved(async () => {
          await db
            .insertInto('gumbo_ids')
            .values({ gumbo_id: 8_100_005, user_id: person(5) })
            .execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        await moved(async () => {
          await db
            .updateTable('gumbo_ids')
            .set({ gumbo_id: 8_100_006 })
            .where('user_id', '=', person(5))
            .execute()
        })
      ).deep.equals([TEAM_A])
      expect(
        (await teamRoster(db, undefined, TEAM_A, false, undefined, cache)).find(
          entry => entry.userId === person(5)
        )?.gumboId
      ).equals(8_100_006)
    })

    it('moves the closed person’s team when they are merged into a person on another team', async function () {
      expect(
        await moved(async () => {
          await closeInto(db, person(3), person(1))
        })
      ).deep.equals([TEAM_B])
    })

    it('moves both teams of a team merge', async function () {
      expect(
        await moved(async () => {
          await mergeTeams(db, {
            fromTeamId: TEAM_C,
            intoTeamId: TEAM_B,
            apply: true
          })
        })
      ).deep.equals([TEAM_B, TEAM_C])
      expect(
        (await teamRoster(db, undefined, TEAM_B, false, undefined, cache)).map(
          entry => entry.userId
        )
      ).includes(person(4))
    })

    it('shows a hold that expires with no write gone from the cached roster at once', async function () {
      const expiresAt = new Date(Date.now() + 1500)
      await db
        .insertInto('group_requests')
        .values({
          id: makeId('invite'),
          kind: 'playerAdd',
          sender_id: person(5),
          sender_scope_type: 'team',
          sender_scope_id: TEAM_A,
          terms: JSON.stringify({
            kind: 'playerAdd',
            mode: 'roster',
            userId: person(1),
            teamId: TEAM_A,
            membershipId: 'mem_rc_a1',
            createdMembership: true,
            jersey: null,
            positions: [],
            teamName: 'Alders'
          }),
          status: 'applied',
          sent_at: new Date(),
          expires_at: expiresAt,
          initiating_team_id: TEAM_A
        })
        .execute()
      const stranger = { userId: person(4), isAdmin: false }
      const read = async (): Promise<RosterEntry | undefined> =>
        (await teamRoster(db, undefined, TEAM_A, false, stranger, cache)).find(
          entry => entry.userId === person(1)
        )
      expect((await read())?.ownIdentity).equals(true)
      const version = await versionOf(db, TEAM_A)
      await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50)
      const hits = cache.hits
      expect((await read())?.ownIdentity).equals(undefined)
      expect(cache.hits).equals(hits + 1)
      expect(await versionOf(db, TEAM_A)).equals(version)
      expect(
        await teamRoster(db, undefined, TEAM_A, false, stranger, cache)
      ).deep.equals(await teamRoster(db, undefined, TEAM_A, false, stranger))
    })

    it('stores nothing from a write transaction, which passes no cache', async function () {
      await dropPrefix(prefix)
      const sets = cache.sets
      await atomic(db, async trx => {
        await trx
          .updateTable('memberships')
          .set({ jersey: '77' })
          .where('id', '=', 'mem_rc_a1')
          .execute()
        const core = await teamRosterCore(trx, TEAM_A)
        expect(
          core.members.find(row => row.userId === person(1))?.jersey
        ).equals('77')
        await teamRoster(trx, undefined, TEAM_A)
      })
      expect(cache.sets).equals(sets)
      expect(await keysUnder(prefix)).deep.equals([])
    })

    it('reads the version before the rows, so a write between them leaves no older rows under the newer version', async function () {
      await dropPrefix(prefix)
      const before = await versionOf(db, TEAM_A)
      let release = (): void => {}
      let reached = (): void => {}
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const paused = new Promise<void>(resolve => {
        reached = resolve
      })
      const stamps = new Set<unknown>()
      const plugin: KyselyPlugin = {
        transformQuery(args) {
          if (JSON.stringify(args.node).includes('roster_cache_epoch'))
            stamps.add(args.queryId)
          return args.node
        },
        async transformResult(args) {
          if (stamps.has(args.queryId)) {
            reached()
            await barrier
          }
          return args.result
        }
      }
      const reading = teamRosterCore(db.withPlugin(plugin), TEAM_A, cache)
      reading.catch(() => undefined)
      await paused
      // Another connection commits a write while the reader holds its version.
      await db
        .updateTable('memberships')
        .set({ jersey: '42' })
        .where('id', '=', 'mem_rc_a1')
        .execute()
      const after = await versionOf(db, TEAM_A)
      expect(after).above(before!)
      release()
      const core = await reading
      // Newer rows under the older version, which no later reader asks for.
      expect(core.members.find(row => row.userId === person(1))?.jersey).equals(
        '42'
      )
      const keys = await keysUnder(prefix)
      expect(keys).length(1)
      expect(keys[0].endsWith(`:${TEAM_A}:${before}`)).equals(true)
      // The newer version has no entry yet; the next read builds it from the
      // committed rows.
      const hits = cache.hits
      const next = await teamRosterCore(db, TEAM_A, cache)
      expect(cache.hits).equals(hits)
      expect(next).deep.equals(await teamRosterCore(db, TEAM_A))
      expect(
        (await keysUnder(prefix)).some(key =>
          key.endsWith(`:${TEAM_A}:${after}`)
        )
      ).equals(true)
    })

    it('stores nothing while a bump under a lower version is still open, so its commit is read after', async function () {
      await dropPrefix(prefix)
      const pool = new Pool({ connectionString: url })
      const late = await pool.connect()
      try {
        // A takes the lower version and stays open; a second write takes a
        // higher one and commits first.
        await late.query('begin')
        await late.query(
          `update memberships set jersey = 'late' where id = 'mem_rc_a1'`
        )
        await db
          .updateTable('memberships')
          .set({ jersey: 'early' })
          .where('id', '=', 'mem_rc_a2')
          .execute()
        const sets = cache.sets
        const open = await teamRosterCore(db, TEAM_A, cache)
        expect(
          open.members.find(row => row.userId === person(2))?.jersey
        ).equals('early')
        expect(cache.sets).equals(sets)
        await late.query('commit')
        // The newest version is still the early write's; the late one is
        // read, and stored now nothing is open.
        const read = await teamRosterCore(db, TEAM_A, cache)
        expect(
          read.members.find(row => row.userId === person(1))?.jersey
        ).equals('late')
        expect(cache.sets).equals(sets + 1)
        const hits = cache.hits
        expect(await teamRosterCore(db, TEAM_A, cache)).deep.equals(read)
        expect(cache.hits).equals(hits + 1)
      } finally {
        late.release()
        await pool.end()
      }
    })

    /** Runs `read` in a repeatable-read transaction, as a roster GET does. */
    async function snapshot<T>(
      read: (trx: Kysely<Database>) => Promise<T>
    ): Promise<T> {
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(read)
    }

    /**
     * A database for refreshes whose one connection the test holds until it
     * calls `release`, so a refresh waits for it as one may for a pool's.
     */
    async function heldOutside(): Promise<{
      outside: Kysely<Database>
      release: () => void
      close: () => Promise<void>
    }> {
      const pool = new Pool({ connectionString: url, max: 1 })
      const held = await pool.connect()
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        held.release()
      }
      const outside = new Kysely<Database>({
        dialect: new PostgresDialect({ pool })
      })
      return {
        outside,
        release,
        close: async () => {
          release()
          await outside.destroy()
        }
      }
    }

    /** Waits up to five seconds for `done`. */
    async function until(done: () => boolean): Promise<void> {
      const deadline = Date.now() + 5000
      while (!done() && Date.now() < deadline) await sleep(10)
    }

    it('answers a snapshot’s miss from its own rows and stores the team’s from outside it, without waiting', async function () {
      await dropPrefix(prefix)
      const sets = cache.sets
      // Without a refresh, nothing is stored.
      expect(
        await snapshot(async trx => await teamRosterCore(trx, TEAM_A, cache))
      ).deep.equals(await teamRosterCore(db, TEAM_A))
      await sleep(100)
      expect(cache.sets).equals(sets)
      // With one, the team is stored after the read, which does not wait.
      const checked = rosterCacheOn(cache, db)
      const read = await snapshot(
        async trx => await teamRosterCore(trx, TEAM_A, checked)
      )
      await until(() => cache.sets > sets)
      expect(cache.sets).equals(sets + 1)
      const hits = cache.hits
      expect(
        await snapshot(async trx => await teamRosterCore(trx, TEAM_A, checked))
      ).deep.equals(read)
      expect(cache.hits).equals(hits + 1)
    })

    it('stores the rows a bump committed after a snapshot that missed them, never the snapshot’s', async function () {
      await dropPrefix(prefix)
      const stored: string[] = []
      const recorded: ValkeyCache = {
        ...cache,
        set: async (key, value, ttlMs) => {
          stored.push(value)
          await cache.set(key, value, ttlMs)
        }
      }
      const checked = rosterCacheOn(recorded, db)
      const pool = new Pool({ connectionString: url })
      const late = await pool.connect()
      try {
        // The late write takes the lower version and stays open; another
        // takes a higher one and commits before the snapshot.
        await late.query('begin')
        await late.query(
          `update memberships set jersey = 'late' where id = 'mem_rc_a1'`
        )
        await db
          .updateTable('memberships')
          .set({ jersey: 'early' })
          .where('id', '=', 'mem_rc_a2')
          .execute()
        await snapshot(async trx => {
          await sql`select 1`.execute(trx)
          // Committed after the snapshot, before the read: not held, and
          // not seen.
          await late.query('commit')
          const core = await teamRosterCore(trx, TEAM_A, checked)
          expect(
            core.members.find(row => row.userId === person(1))?.jersey
          ).equals('1')
        })
        await until(() => stored.length > 0)
        expect(stored).length(1)
        const read = await teamRosterCore(db, TEAM_A, cache)
        expect(
          read.members.find(row => row.userId === person(1))?.jersey
        ).equals('late')
        expect(JSON.parse(stored[0])).deep.equals(read)
      } finally {
        late.release()
        await pool.end()
      }
    })

    it('stores no stale core when a snapshot that missed a late bump commits, and a prune runs, before its refresh', async function () {
      await dropPrefix(prefix)
      const stored: string[] = []
      const recorded: ValkeyCache = {
        ...cache,
        set: async (key, value, ttlMs) => {
          stored.push(value)
          await cache.set(key, value, ttlMs)
        }
      }
      const held = await heldOutside()
      const pool = new Pool({ connectionString: url })
      const late = await pool.connect()
      try {
        // A writer W takes the lower version and stays open, its row made
        // older than BUMP_KEEP_MS; another writer takes a higher version
        // and commits.
        await late.query('begin')
        await late.query(
          `update memberships set jersey = 'late' where id = 'mem_rc_a1'`
        )
        const lateVersion = Number(
          (
            await late.query<{ version: string }>(
              `select max(version)::text as version from team_roster_bumps
                where team_id = $1`,
              [TEAM_A]
            )
          ).rows[0].version
        )
        await late.query(
          `update team_roster_bumps
            set bumped_at = clock_timestamp() - interval '11 minutes'
            where team_id = $1 and version = $2`,
          [TEAM_A, lateVersion]
        )
        await db
          .updateTable('memberships')
          .set({ jersey: 'early' })
          .where('id', '=', 'mem_rc_a2')
          .execute()
        // Snapshot S begins, W commits, and S reads and commits; its
        // refresh waits for a connection.
        const core = await snapshot(async trx => {
          await sql`select 1`.execute(trx)
          await late.query('commit')
          return await teamRosterCore(
            trx,
            TEAM_A,
            rosterCacheOn(recorded, held.outside)
          )
        })
        expect(
          core.members.find(row => row.userId === person(1))?.jersey
        ).equals('1')
        // With S gone, the prune takes W's row: old, and not the newest.
        await pruneRosterBumps(db)
        expect(await bumpsOf(TEAM_A)).not.includes(lateVersion)
        held.release()
        await until(() => stored.length > 0)
        await sleep(100)
        expect(stored).length(1)
        for (const value of stored)
          expect(
            (JSON.parse(value) as RosterCore).members.find(
              row => row.userId === person(1)
            )?.jersey
          ).equals('late')
        const hits = cache.hits
        const read = await teamRosterCore(db, TEAM_A, cache)
        expect(cache.hits).equals(hits + 1)
        expect(read).deep.equals(await teamRosterCore(db, TEAM_A))
      } finally {
        late.release()
        await pool.end()
        await held.close()
      }
    })

    it('starts one refresh per team for a burst of snapshot misses', async function () {
      await dropPrefix(prefix)
      const inner = counted(cache)
      const held = await heldOutside()
      const checked = rosterCacheOn(inner, held.outside)
      try {
        for (let read = 0; read < 5; read += 1)
          for (const teamId of [TEAM_A, TEAM_B])
            await snapshot(
              async trx => await teamRosterCore(trx, teamId, checked)
            )
        // Ten misses, and their refreshes still wait for a connection.
        expect(inner.gets).equals(10)
        expect(inner.hits).equals(0)
        expect(inner.sets).equals(0)
        held.release()
        await until(() => inner.sets >= 2)
        await sleep(200)
        // One refresh for each team, a get and a set apiece.
        expect(inner.gets).equals(12)
        expect(inner.sets).equals(2)
        // A snapshot after hits, and starts none.
        for (const teamId of [TEAM_A, TEAM_B])
          expect(
            await snapshot(
              async trx => await teamRosterCore(trx, teamId, checked)
            )
          ).deep.equals(await teamRosterCore(db, teamId))
        await sleep(100)
        expect(inner.hits).equals(2)
        expect(inner.gets).equals(14)
        expect(inner.sets).equals(2)
      } finally {
        await held.close()
      }
    })

    it('starts another refresh once the last has failed', async function () {
      await dropPrefix(prefix)
      let failing = true
      const flaky: ValkeyCache = {
        ...cache,
        get: async key => {
          if (failing) throw new Error('Valkey is away')
          return await cache.get(key)
        }
      }
      const checked = rosterCacheOn(flaky, db)
      let error: unknown
      await checked.refresh!(TEAM_A).catch((thrown: unknown) => {
        error = thrown
      })
      expect(String(error)).equals('Error: Valkey is away')
      failing = false
      const sets = cache.sets
      await checked.refresh!(TEAM_A)
      expect(cache.sets).equals(sets + 1)
    })

    it('says a refresh whose read fails once a minute with its team, apart from the cache’s own failures, and still answers the read', async function () {
      const logs: string[] = []
      let clock = 2_000_000
      const ownPrefix = testPrefix()
      const valkey = await readyCache(
        ownPrefix,
        url,
        message => logs.push(message),
        () => clock
      )
      const failure = 'canceling statement due to statement timeout'
      const outside = db.withPlugin({
        transformQuery: args => args.node,
        transformResult: async () => {
          throw new Error(failure)
        }
      })
      const checked = rosterCacheOn(valkey, outside, {
        log: message => logs.push(message),
        now: () => clock
      })
      const read = async (teamId: string): Promise<void> => {
        expect(
          unsigned(
            await snapshot(
              async trx =>
                await teamRoster(trx, SPACE, teamId, true, undefined, checked)
            )
          )
        ).deep.equals(unsigned(await teamRoster(db, SPACE, teamId, true)))
      }
      try {
        await read(TEAM_A)
        await until(() => logs.length > 0)
        expect(logs).deep.equals([
          `roster refresh of team ${TEAM_A}: ${failure}`
        ])
        // Another within the minute, of another team too, says nothing.
        await read(TEAM_A)
        await read(TEAM_B)
        await sleep(200)
        expect(logs).length(1)
        // A command failure in the same minute is still said.
        await valkey.set('broken', 'value', -5)
        expect(logs).length(2)
        expect(logs[1]).matches(/^redis cache: /)
        // A minute on, a command failure first does not keep a refresh's out.
        clock += 60_000
        await valkey.set('broken', 'value', -5)
        await valkey.set('mended', 'value', 60_000)
        expect(logs).length(3)
        expect(logs[2]).matches(/^redis cache: /)
        await read(TEAM_B)
        await until(() => logs.length > 3)
        expect(logs.slice(3)).deep.equals([
          `roster refresh of team ${TEAM_B}: ${failure}`
        ])
      } finally {
        await valkey.close()
        await dropPrefix(ownPrefix)
      }
    })

    it('stores nothing from a snapshot while a bump of the team is open', async function () {
      await dropPrefix(prefix)
      const sets = cache.sets
      const pool = new Pool({ connectionString: url })
      const open = await pool.connect()
      try {
        await open.query('begin')
        await open.query(
          `update memberships set jersey = 'open' where id = 'mem_rc_a1'`
        )
        await snapshot(async trx => {
          await teamRosterCore(trx, TEAM_A, rosterCacheOn(cache, db))
        })
        await sleep(200)
        expect(cache.sets).equals(sets)
        await open.query('rollback')
        // Once it is gone, the same read is stored.
        await snapshot(async trx => {
          await teamRosterCore(trx, TEAM_A, rosterCacheOn(cache, db))
        })
        await until(() => cache.sets > sets)
        expect(cache.sets).equals(sets + 1)
      } finally {
        open.release()
        await pool.end()
      }
    })

    it('prunes only bumps that are old and not their team’s newest, and a read after still hits', async function () {
      for (const jersey of ['p1', 'p2', 'p3'])
        await db
          .updateTable('memberships')
          .set({ jersey })
          .where('id', '=', 'mem_rc_a1')
          .execute()
      await db
        .updateTable('memberships')
        .set({ jersey: 'q1' })
        .where('id', '=', 'mem_rc_b3')
        .execute()
      const bumps = bumpsOf
      const newestA = await versionOf(db, TEAM_A)
      const before = { a: await bumps(TEAM_A), b: await bumps(TEAM_B) }
      expect(before.a.length).above(2)
      await agrees(TEAM_A)
      // Every row but A's newest two is old; one of B's is old, but it is
      // B's newest only if B has no other.
      const recentA = before.a.slice(-2)
      await sql`update team_roster_bumps set bumped_at = now() - interval '11 minutes'
        where not (team_id = ${TEAM_A} and version = any(${recentA}::bigint[]))`.execute(
        db
      )
      const gone = await pruneRosterBumps(db)
      expect(await bumps(TEAM_A)).deep.equals(recentA)
      expect(await bumps(TEAM_B)).deep.equals(before.b.slice(-1))
      expect(await versionOf(db, TEAM_C)).not.equals(undefined)
      expect(gone).equals(
        before.a.length - recentA.length + before.b.length - 1
      )
      expect(await versionOf(db, TEAM_A)).equals(newestA)
      const hits = cache.hits
      await agrees(TEAM_A)
      expect(cache.hits).equals(hits + 1)
      // Nothing left to prune.
      expect(await pruneRosterBumps(db)).equals(0)
    })

    it('prunes as a background job on start and on its interval, logging what went and what failed', async function () {
      for (const jersey of ['j1', 'j2'])
        await db
          .updateTable('memberships')
          .set({ jersey })
          .where('id', '=', 'mem_rc_a1')
          .execute()
      await sql`update team_roster_bumps set bumped_at = now() - interval '11 minutes'`.execute(
        db
      )
      const said: string[] = []
      const stop = startRosterBumpPrune(db, message => said.push(message), 20)
      try {
        const deadline = Date.now() + 10_000
        while ((await bumpsOf(TEAM_A)).length > 1 && Date.now() < deadline)
          await sleep(10)
        expect(await bumpsOf(TEAM_A)).length(1)
        expect(said).length.above(0)
        for (const line of said)
          expect(line).match(/^pruned \d+ roster version bump\(s\)$/)
        const spoken = said.length
        await sleep(100)
        // Later rounds found nothing, and said nothing.
        expect(said).length(spoken)
      } finally {
        stop()
      }
      const failing = db.withPlugin({
        transformQuery() {
          throw new Error('the database is away')
        },
        transformResult: async args => args.result
      })
      const failed: string[] = []
      const stopFailing = startRosterBumpPrune(failing, message =>
        failed.push(message)
      )
      try {
        const deadline = Date.now() + 5000
        while (failed.length === 0 && Date.now() < deadline) await sleep(10)
        expect(failed).deep.equals([
          'pruning roster version bumps: Error: the database is away'
        ])
      } finally {
        stopFailing()
      }
    })

    it('completes two players’ settings puts on two shared teams and a self-rename at once, with no deadlock', async function () {
      // Person 8, who signs in, and person 3 are both on A and B.
      const existing = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', [person(8), person(9)])
        .execute()
      if (existing.length === 0)
        await insertFixtureUsers(db, [
          { id: 7_100_008, display_name: 'Self Renamer', login_enabled: true },
          {
            id: 7_100_009,
            display_name: 'Site Admin',
            login_enabled: true,
            is_admin: true
          }
        ])
      await db
        .insertInto('memberships')
        .values([
          {
            id: 'mem_rc_a3',
            team_id: TEAM_A,
            user_id: person(3),
            is_player: true
          },
          {
            id: 'mem_rc_a8',
            team_id: TEAM_A,
            user_id: person(8),
            is_player: true
          },
          {
            id: 'mem_rc_b8',
            team_id: TEAM_B,
            user_id: person(8),
            is_player: true
          }
        ])
        .execute()
      const adminToken = (await createSession(db, person(9), 'roster-cache'))
        .token
      const selfToken = (await createSession(db, person(8), 'roster-cache'))
        .token
      const media: MediaContext = {
        mediaRoot: mkdtempSync(join(tmpdir(), 'tsRosterCache-')),
        ffmpegPath: 'ffmpeg',
        mediaSecret: 'secret',
        publicUrl: 'http://127.0.0.1',
        space: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: '',
          pathStyle: true
        }
      }
      const app = express()
      app.use(withActor(db))
      app.use(jsonBody)
      app.use('/api/v1', playerRoutes(db, media, cache))
      app.use(
        '/api/v1',
        accountRoutes(db, {
          ffmpegPath: media.ffmpegPath,
          space: media.space,
          sendCode: async () => undefined,
          publicUrl: 'http://127.0.0.1'
        })
      )
      app.use(errorHandler)
      const server = app.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => server.once('listening', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
      const put = async (
        token: string,
        path: string,
        body: unknown
      ): Promise<string> => {
        const response = await fetch(`${base}${path}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        })
        return response.status === 200
          ? 'ok'
          : `${response.status} ${await response.text()}`
      }
      try {
        for (let round = 0; round < 20; round += 1)
          expect(
            await Promise.all([
              put(
                adminToken,
                `/teams/${TEAM_A}/players/${person(8)}/settings`,
                {
                  jersey: `a${round}`,
                  name: { firstName: 'Ann', lastName: `Round${round}` }
                }
              ),
              put(
                adminToken,
                `/teams/${TEAM_B}/players/${person(3)}/settings`,
                {
                  jersey: `b${round}`,
                  name: { firstName: 'Bea', lastName: `Round${round}` }
                }
              ),
              put(selfToken, '/me/account/name', {
                displayName: `Self Round${round}`
              })
            ]),
            `round ${round}`
          ).deep.equals(['ok', 'ok', 'ok'])
      } finally {
        await new Promise(resolve => server.close(resolve))
      }
      await agrees(TEAM_A, TEAM_B)
    })

    it('holds no connection while it asks Valkey', async function () {
      // One connection in all: a read that kept it across the cache's calls
      // would leave none for the statement each call runs here.
      const one = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: url, max: 1 })
        })
      })
      const spare = async (): Promise<void> => {
        await Promise.race([
          sql`select 1`.execute(one),
          sleep(2000).then(() => {
            throw new Error('the roster read held the only connection')
          })
        ])
      }
      const asking: ValkeyCache = {
        get: async key => {
          await spare()
          return await cache.get(key)
        },
        set: async (key, value, ttlMs) => {
          await spare()
          await cache.set(key, value, ttlMs)
        },
        close: async () => undefined
      }
      try {
        await dropPrefix(prefix)
        // Cold, then warm.
        for (let read = 0; read < 2; read += 1)
          expect(await teamRosterCore(one, TEAM_A, asking)).deep.equals(
            await teamRosterCore(db, TEAM_A)
          )
        expect(await keysUnder(prefix)).length(1)
      } finally {
        await one.destroy()
      }
    })

    it('answers the uncached roster in good time when Valkey stops answering', async function () {
      const valkey = await silentValkey()
      const logs: string[] = []
      const silent = makeValkeyCache({
        redis: { url: valkey.url, prefix },
        databaseUrl: url,
        log: message => logs.push(message)
      })
      try {
        await untilAsked(silent, valkey)
        valkey.silence()
        const uncached = unsigned(await teamRoster(db, SPACE, TEAM_A, true))
        for (let read = 0; read < 2; read += 1) {
          const startedAt = Date.now()
          // A miss, read from the rows, and its set given up on as well.
          expect(
            unsigned(
              await teamRoster(db, SPACE, TEAM_A, true, undefined, silent)
            )
          ).deep.equals(uncached)
          expect(Date.now() - startedAt).below(1000)
        }
        expect(logs).length(1)
        expect(logs[0]).matches(/^redis cache: no answer in /)
      } finally {
        await silent.close()
        await valkey.close()
      }
    })

    it('answers the uncached roster when Valkey is away, saying so once', async function () {
      const logs: string[] = []
      const away = makeValkeyCache({
        redis: { url: 'redis://127.0.0.1:1', prefix },
        databaseUrl: url,
        log: message => logs.push(message)
      })
      try {
        const deadline = Date.now() + 5000
        while (logs.length === 0 && Date.now() < deadline) await sleep(20)
        for (let read = 0; read < 3; read += 1)
          expect(
            unsigned(await teamRoster(db, SPACE, TEAM_A, true, undefined, away))
          ).deep.equals(unsigned(await teamRoster(db, SPACE, TEAM_A, true)))
        await sleep(300)
        expect(logs).length(1)
        expect(logs[0]).matches(/^redis cache: /)
      } finally {
        await away.close()
      }
      // And with its client closed.
      const closed = await readyCache(testPrefix(), url)
      await closed.close()
      expect(
        unsigned(await teamRoster(db, SPACE, TEAM_A, true, undefined, closed))
      ).deep.equals(unsigned(await teamRoster(db, SPACE, TEAM_A, true)))
    })

    it('reads nothing more for a snapshot’s miss while Valkey is away, and refreshes once it answers', async function () {
      let asked = 0
      const outside = db.withPlugin({
        transformQuery(args) {
          asked += 1
          return args.node
        },
        transformResult: async args => args.result
      })
      const away = makeValkeyCache({
        redis: { url: 'redis://127.0.0.1:1', prefix },
        databaseUrl: url,
        log: () => undefined
      })
      try {
        expect(away.answering!()).equals(false)
        const checked = rosterCacheOn(away, outside)
        expect(checked.answering!()).equals(false)
        expect(
          await snapshot(
            async trx => await teamRosterCore(trx, TEAM_A, checked)
          )
        ).deep.equals(await teamRosterCore(db, TEAM_A))
        await checked.refresh!(TEAM_A)
        await sleep(100)
        expect(asked).equals(0)
      } finally {
        await away.close()
      }
      const ownPrefix = testPrefix()
      const ready = await readyCache(ownPrefix, url)
      try {
        expect(ready.answering!()).equals(true)
        await rosterCacheOn(ready, outside).refresh!(TEAM_A)
        expect(asked).above(0)
      } finally {
        await ready.close()
        await dropPrefix(ownPrefix)
      }
    })

    it('answers the uncached roster when a command fails, and logs at most once a minute', async function () {
      const logs: string[] = []
      let clock = 1_000_000
      const ownPrefix = testPrefix()
      const failing = await readyCache(
        ownPrefix,
        url,
        message => logs.push(message),
        () => clock
      )
      try {
        const epoch = (
          await db
            .selectFrom('roster_cache_epoch')
            .select('epoch')
            .executeTakeFirstOrThrow()
        ).epoch
        const client = createClient({ url: testRedisUrl })
        await client.connect()
        // A key of the wrong type makes the GET fail.
        await client.hSet(
          `${ownPrefix}:roster:${CORE_FORMAT}:${epoch}:${TEAM_A}:${await versionOf(db, TEAM_A)}`,
          'field',
          'value'
        )
        await client.close()
        expect(failing.answering!()).equals(true)
        expect(
          unsigned(
            await teamRoster(db, SPACE, TEAM_A, true, undefined, failing)
          )
        ).deep.equals(unsigned(await teamRoster(db, SPACE, TEAM_A, true)))
        expect(
          unsigned(
            await teamRoster(db, SPACE, TEAM_A, true, undefined, failing)
          )
        ).deep.equals(unsigned(await teamRoster(db, SPACE, TEAM_A, true)))
        expect(logs).length(1)
        expect(logs[0]).matches(/WRONGTYPE/)
        // A set that fails, a minute later, is said again.
        clock += 60_000
        await failing.set('broken', 'value', -5)
        expect(logs).length(2)
        // Not answering, until a command is answered again.
        expect(failing.answering!()).equals(false)
        await failing.set('mended', 'value', 60_000)
        expect(failing.answering!()).equals(true)
      } finally {
        await failing.close()
        await dropPrefix(ownPrefix)
      }
    })

    it('reads an entry that does not parse or is not a core as a miss, logs it at most once a minute, and replaces it', async function () {
      const logs: string[] = []
      let clock = 1_000_000
      const ownPrefix = testPrefix()
      const held = await readyCache(
        ownPrefix,
        url,
        message => logs.push(message),
        () => clock
      )
      const client = createClient({ url: testRedisUrl })
      await client.connect()
      try {
        const { epoch } = await db
          .selectFrom('roster_cache_epoch')
          .select('epoch')
          .executeTakeFirstOrThrow()
        const key = `${ownPrefix}:roster:${CORE_FORMAT}:${epoch}:${TEAM_A}:${await versionOf(db, TEAM_A)}`
        const uncached = unsigned(await teamRoster(db, SPACE, TEAM_A, true))
        const garbage = [
          'not json {',
          JSON.stringify({ members: 'nobody', songs: [], gumboIds: [] }),
          JSON.stringify({
            members: [{ userId: person(6), displayName: 'Stranger' }],
            songs: [],
            gumboIds: []
          })
        ]
        for (const [n, value] of garbage.entries()) {
          await client.set(key, value)
          expect(
            unsigned(
              await teamRoster(
                db,
                SPACE,
                TEAM_A,
                true,
                undefined,
                rosterCacheOn(held, db)
              )
            ),
            value
          ).deep.equals(uncached)
          const stored = await client.get(key)
          expect(stored, value).not.equals(value)
          expect(JSON.parse(stored!)).deep.equals(
            await teamRosterCore(db, TEAM_A)
          )
          if (n === 0) {
            expect(logs).length(1)
            expect(logs[0]).matches(
              /^redis cache: roster entry .* is unreadable/
            )
          }
        }
        // The two after the first were within the minute.
        expect(logs).length(1)
        clock += 60_000
        await client.set(key, 'not json {')
        await teamRoster(db, SPACE, TEAM_A, true, undefined, held)
        expect(logs).length(2)
      } finally {
        await client.close()
        await held.close()
        await dropPrefix(ownPrefix)
      }
    })

    it('replaces an unreadable entry a snapshot read finds through its refresh, so the next read hits', async function () {
      const logs: string[] = []
      const ownPrefix = testPrefix()
      const held = await readyCache(ownPrefix, url, message =>
        logs.push(message)
      )
      const inner = counted(held)
      inner.report = held.report
      inner.answering = held.answering
      const checked = rosterCacheOn(inner, db)
      const client = createClient({ url: testRedisUrl })
      await client.connect()
      try {
        const { epoch } = await db
          .selectFrom('roster_cache_epoch')
          .select('epoch')
          .executeTakeFirstOrThrow()
        const key = `${ownPrefix}:roster:${CORE_FORMAT}:${epoch}:${TEAM_A}:${await versionOf(db, TEAM_A)}`
        const uncached = unsigned(await teamRoster(db, SPACE, TEAM_A, true))
        await client.set(key, 'not json {')
        // Read only as the roster GET reads, inside its snapshot.
        expect(
          unsigned(
            await snapshot(
              async trx =>
                await teamRoster(trx, SPACE, TEAM_A, true, undefined, checked)
            )
          )
        ).deep.equals(uncached)
        expect(logs).length(1)
        expect(logs[0]).matches(/^redis cache: roster entry .* is unreadable/)
        // Saying so is not a failed command: the refresh still runs.
        expect(checked.answering!()).equals(true)
        await until(() => inner.sets > 0)
        expect(inner.sets).equals(1)
        const stored = await client.get(key)
        expect(JSON.parse(stored!)).deep.equals(
          await teamRosterCore(db, TEAM_A)
        )
        const hits = inner.hits
        expect(
          unsigned(
            await snapshot(
              async trx =>
                await teamRoster(trx, SPACE, TEAM_A, true, undefined, checked)
            )
          )
        ).deep.equals(uncached)
        await sleep(100)
        expect(inner.hits).equals(hits + 1)
        expect(inner.sets).equals(1)
        expect(logs).length(1)
      } finally {
        await client.close()
        await held.close()
        await dropPrefix(ownPrefix)
      }
    })

    it('does not store a core over 512 KB', async function () {
      const big = Array.from({ length: 130 }, (_, n) => 7_200_000 + n)
      const existing = new Set(
        (await db.selectFrom('users').select('id').execute()).map(row => row.id)
      )
      const fresh = big.filter(n => !existing.has(userIdOfGumbo(n)))
      if (fresh.length > 0)
        await insertFixtureUsers(
          db,
          fresh.map(n => ({ id: n, display_name: `${n} ${'x'.repeat(4096)}` }))
        )
      await db
        .insertInto('memberships')
        .values(
          big.map(n => ({
            id: `mem_rc_big_${n}`,
            team_id: TEAM_C,
            user_id: userIdOfGumbo(n),
            is_player: true
          }))
        )
        .execute()
      const core = await teamRosterCore(db, TEAM_C)
      expect(Buffer.byteLength(JSON.stringify(core))).above(CORE_MAX_BYTES)
      const sets = cache.sets
      expect(
        await teamRoster(db, undefined, TEAM_C, false, undefined, cache)
      ).deep.equals(await teamRoster(db, undefined, TEAM_C))
      expect(cache.sets).equals(sets)
    })

    it('deletes a team with members and a song, then reads it recreated directly until its first membership gives it a version never used', async function () {
      await db
        .insertInto('walk_up_songs')
        .values({
          team_id: TEAM_C,
          user_id: person(4),
          provider: 'appleMusic',
          provider_id: 'song-4',
          title: 'Gone',
          artist: 'Band',
          duration_ms: 200_000,
          start_ms: 0,
          end_ms: 15_000,
          set_by: person(4)
        })
        .execute()
      await agrees(TEAM_C)
      const used = (await keysUnder(prefix)).map(key =>
        Number(key.split(':').pop())
      )
      const earlier = await versionOf(db, TEAM_C)
      await sql`delete from teams where id = ${TEAM_C}`.execute(db)
      expect(await versionOf(db, TEAM_C)).equals(undefined)
      await db
        .insertInto('teams')
        .values({ id: TEAM_C, name: 'Cedars again' })
        .execute()
      const sets = cache.sets
      const gets = cache.gets
      expect(
        await teamRoster(db, undefined, TEAM_C, false, undefined, cache)
      ).deep.equals([])
      expect(cache.sets).equals(sets)
      expect(cache.gets).equals(gets)
      await db
        .insertInto('memberships')
        .values({
          id: 'mem_rc_c1',
          team_id: TEAM_C,
          user_id: person(1),
          is_player: true
        })
        .execute()
      const version = await versionOf(db, TEAM_C)
      expect(version).above(earlier!)
      expect(used).not.includes(version)
      await agrees(TEAM_C)
      expect(cache.sets).equals(sets + 1)
      expect(
        (await teamRoster(db, undefined, TEAM_C, false, undefined, cache)).map(
          entry => entry.userId
        )
      ).deep.equals([person(1)])
    })

    it('never reuses an entry after the versions are emptied and a team recreated with the same id', async function () {
      await agrees(TEAM_A)
      const used = new Set(
        (await keysUnder(prefix)).map(key => Number(key.split(':').pop()))
      )
      await sql`delete from team_roster_bumps`.execute(db)
      await sql`delete from teams where id = ${TEAM_A}`.execute(db)
      await db
        .insertInto('teams')
        .values({ id: TEAM_A, name: 'Alders again' })
        .execute()
      const sets = cache.sets
      expect(
        await teamRoster(db, undefined, TEAM_A, false, undefined, cache)
      ).deep.equals([])
      expect(cache.sets).equals(sets)
      await db
        .insertInto('memberships')
        .values({ id: 'mem_rc_a9', team_id: TEAM_A, user_id: person(3) })
        .execute()
      expect(used.has((await versionOf(db, TEAM_A))!)).equals(false)
      const hits = cache.hits
      expect(
        (await teamRoster(db, undefined, TEAM_A, false, undefined, cache)).map(
          entry => entry.userId
        )
      ).deep.equals([person(3)])
      expect(cache.hits).equals(hits)
      expect(cache.sets).equals(sets + 1)
    })

    it('reads no entry stored under another format of the core', async function () {
      await agrees(TEAM_A)
      const { epoch } = await db
        .selectFrom('roster_cache_epoch')
        .select('epoch')
        .executeTakeFirstOrThrow()
      const stored = async (key: string): Promise<boolean> =>
        (await keysUnder(prefix)).some(held => held.endsWith(`:${key}`))
      expect(
        await stored(
          `roster:${CORE_FORMAT}:${epoch}:${TEAM_A}:${await versionOf(db, TEAM_A)}`
        )
      ).equals(true)
      // A new version, with an entry in another shape already under it: one
      // a later format would store, and one from before formats were named.
      await db
        .updateTable('users')
        .set({ display_name: 'Person One' })
        .where('id', '=', person(1))
        .execute()
      const version = await versionOf(db, TEAM_A)
      const stranger = JSON.stringify({
        members: [{ userId: person(6), displayName: 'Stranger' }],
        songs: [],
        gumboIds: []
      })
      for (const key of [
        `roster:${CORE_FORMAT + 1}:${epoch}:${TEAM_A}:${version}`,
        `roster:${epoch}:${TEAM_A}:${version}`
      ])
        await cache.set(key, stranger, 60_000)
      const hits = cache.hits
      const sets = cache.sets
      const read = await teamRoster(
        db,
        undefined,
        TEAM_A,
        false,
        undefined,
        cache
      )
      expect(read).deep.equals(await teamRoster(db, undefined, TEAM_A))
      expect(read.map(entry => entry.userId)).not.includes(person(6))
      expect(cache.hits).equals(hits)
      expect(cache.sets).equals(sets + 1)
      expect(
        await stored(`roster:${CORE_FORMAT}:${epoch}:${TEAM_A}:${version}`)
      ).equals(true)
    })

    it('never reads another database’s entry for the same team id under one prefix', async function () {
      const other = await scratchDatabase('rostercache2')
      const shared = testPrefix()
      const here = counted(await readyCache(shared, url))
      const there = counted(await readyCache(shared, other.url))
      try {
        await insertFixtureUsers(other.db, [
          { id: 7_300_001, display_name: 'Elsewhere' }
        ])
        await other.db
          .insertInto('teams')
          .values({ id: TEAM_A, name: 'Other Alders' })
          .execute()
        await other.db
          .insertInto('memberships')
          .values({
            id: 'mem_rc_other',
            team_id: TEAM_A,
            user_id: userIdOfGumbo(7_300_001)
          })
          .execute()
        // Make the two versions equal, so only the epoch tells them apart.
        const ours = (await versionOf(db, TEAM_A))!
        await sql`update team_roster_bumps set version = ${ours} where team_id = ${TEAM_A}`.execute(
          other.db
        )
        const mine = await teamRoster(
          db,
          undefined,
          TEAM_A,
          false,
          undefined,
          here
        )
        const theirs = await teamRoster(
          other.db,
          undefined,
          TEAM_A,
          false,
          undefined,
          there
        )
        expect(there.hits).equals(0)
        expect(theirs).deep.equals(
          await teamRoster(other.db, undefined, TEAM_A)
        )
        expect(theirs.map(entry => entry.userId)).deep.equals([
          userIdOfGumbo(7_300_001)
        ])
        expect(mine.map(entry => entry.userId)).not.includes(
          userIdOfGumbo(7_300_001)
        )
        expect(await keysUnder(shared)).length(2)
      } finally {
        await here.close()
        await there.close()
        await dropPrefix(shared)
        await other.drop()
      }
    })

    it('completes two statements over the same teams in opposite row order', async function () {
      // Held open: the second waits for the first, then completes.
      const pool = new Pool({ connectionString: url })
      const first = await pool.connect()
      const second = await pool.connect()
      try {
        await first.query('begin')
        await first.query(
          `update memberships set jersey = 'x' where id in ('mem_rc_a1', 'mem_rc_b3')`
        )
        await second.query('begin')
        const waiting = second.query(
          `update memberships set jersey = 'y' where id in ('mem_rc_b2', 'mem_rc_a2')`
        )
        await sleep(200)
        await first.query('commit')
        await waiting
        await second.query('commit')
        // At once, many times: never a deadlock.
        for (let round = 0; round < 30; round += 1)
          await Promise.all([
            pool.query(
              `update memberships set jersey = $1
                from (values ('mem_rc_a1', 1), ('mem_rc_b3', 2)) as o(id, n)
                where memberships.id = o.id`,
              [String(round)]
            ),
            pool.query(
              `update memberships set jersey = $1
                from (values ('mem_rc_b2', 1), ('mem_rc_a2', 2)) as o(id, n)
                where memberships.id = o.id`,
              [String(round)]
            ),
            pool.query(
              `update users set display_name = display_name || '.' where id in ($1, $2)`,
              [person(2), person(4)]
            )
          ])
      } finally {
        first.release()
        second.release()
        await pool.end()
      }
      await agrees(TEAM_A, TEAM_B, TEAM_C)
    })

    it('runs a users update for a person on both teams of a merge while the merge moves memberships, in either order', async function () {
      // Person 2 is on A and B. First the merge of A into B, paused after its
      // first move, then the rename: the merge's move took the person's row
      // (the gumbo id allocation trigger), so the rename waits for it.
      let release = (): void => {}
      let reached = (): void => {}
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const paused = new Promise<void>(resolve => {
        reached = resolve
      })
      const moves = new Set<unknown>()
      let first = true
      const merging = mergeTeams(
        db.withPlugin({
          transformQuery(args) {
            if (JSON.stringify(args.node).includes('update memberships target'))
              moves.add(args.queryId)
            return args.node
          },
          async transformResult(args) {
            if (first && moves.has(args.queryId)) {
              first = false
              reached()
              await barrier
            }
            return args.result
          }
        }),
        { fromTeamId: TEAM_A, intoTeamId: TEAM_B, apply: true }
      )
      merging.catch(() => undefined)
      try {
        await paused
        const renaming = db
          .updateTable('users')
          .set({ display_name: 'Moved Person' })
          .where('id', '=', person(2))
          .execute()
        renaming.catch(() => undefined)
        await sleep(200)
        release()
        await Promise.all([merging, renaming])
      } finally {
        release()
        await Promise.allSettled([merging])
      }
      await agrees(TEAM_A, TEAM_B)

      // Then the rename first, held open with both teams' versions taken,
      // and a merge of B into C, which waits for it.
      await db
        .insertInto('memberships')
        .values({
          id: 'mem_rc_c2',
          team_id: TEAM_C,
          user_id: person(2),
          is_player: true
        })
        .execute()
      const pool = new Pool({ connectionString: url })
      const renamer = await pool.connect()
      try {
        await renamer.query('begin')
        await renamer.query(
          `update users set display_name = 'Held Person' where id = $1`,
          [person(2)]
        )
        const merged = mergeTeams(db, {
          fromTeamId: TEAM_B,
          intoTeamId: TEAM_C,
          apply: true
        })
        merged.catch(() => undefined)
        await sleep(200)
        await renamer.query('commit')
        await merged
      } finally {
        renamer.release()
        await pool.end()
      }
      await agrees(TEAM_B, TEAM_C)
    })

    /**
     * Whether `statement`, running on the backend `pid`, is done or waiting
     * for a lock, whichever is seen first: the barrier the races below hold
     * their second statement at.
     */
    async function doneOrWaiting(
      statement: Promise<unknown>,
      pid: number
    ): Promise<'done' | 'waiting'> {
      let done = false
      statement.then(
        () => {
          done = true
        },
        () => {
          done = true
        }
      )
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (done) return 'done'
        const { rows } = await sql<{ wait: string | null }>`
          select wait_event_type as wait from pg_stat_activity
          where pid = ${pid}`.execute(db)
        if (rows[0]?.wait === 'Lock') return 'waiting'
        await sleep(10)
      }
      throw new Error('The second statement neither finished nor waited')
    }

    /**
     * A write of person 6 that changes what Cedars' roster shows of them,
     * and a membership of person 6 on Cedars, in two transactions held open,
     * `first` started first. Once the second statement waits for the first
     * on the person's row, the membership commits unless it is the one
     * waiting, a cached read of
     * Cedars runs while the person write is still open, then that commits.
     * Answers Cedars' core read through the cache after both, checked
     * against an uncached read.
     */
    async function raced(
      first: 'person' | 'membership',
      personWrite: string
    ): Promise<RosterCore> {
      const pool = new Pool({ connectionString: url })
      const member = await pool.connect()
      const writer = await pool.connect()
      const pidOf = async (client: typeof member): Promise<number> =>
        (await client.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0].pid
      try {
        // Asked before either is busy: a query waits for the one before it.
        const memberPid = await pidOf(member)
        const writerPid = await pidOf(writer)
        await member.query('begin')
        await writer.query('begin')
        const join = async (): Promise<unknown> =>
          await member.query(
            `insert into memberships (id, team_id, user_id, role)
              values ('mem_rc_c6', $1, $2, 'manager')`,
            [TEAM_C, person(6)]
          )
        const write = async (): Promise<unknown> =>
          await writer.query(personWrite, [person(6)])
        let joined: Promise<unknown>
        let written: Promise<unknown>
        let second: 'done' | 'waiting'
        if (first === 'membership') {
          await join()
          joined = Promise.resolve()
          written = write()
          second = await doneOrWaiting(written, writerPid)
        } else {
          await write()
          written = Promise.resolve()
          joined = join()
          second = await doneOrWaiting(joined, memberPid)
        }
        // Each waits for the other on the person's row.
        expect(second).equals('waiting')
        written.catch(() => undefined)
        const committed = (async () => {
          await joined
          await member.query('commit')
        })()
        committed.catch(() => undefined)
        if (first === 'membership' || second === 'done') await committed
        await teamRosterCore(db, TEAM_C, cache)
        await written
        await writer.query('commit')
        await committed
      } finally {
        member.release()
        writer.release()
        await pool.end()
      }
      const core = await teamRosterCore(db, TEAM_C, cache)
      expect(core).deep.equals(await teamRosterCore(db, TEAM_C))
      await agrees(TEAM_C)
      return core
    }

    for (const first of ['membership', 'person'] as const)
      it(`shows a rename made while a membership of the person is written, ${first === 'membership' ? 'the membership' : 'the rename'} first, in the cached roster`, async function () {
        await dropPrefix(prefix)
        const core = await raced(
          first,
          `update users set display_name = 'Renamed Six' where id = $1`
        )
        expect(
          core.members.find(row => row.userId === person(6))?.displayName
        ).equals('Renamed Six')
      })

    for (const first of ['membership', 'person'] as const)
      it(`shows a gumbo id given while a membership of the person is written, ${first === 'membership' ? 'the membership' : 'the gumbo id'} first, in the cached roster`, async function () {
        await dropPrefix(prefix)
        await db
          .deleteFrom('gumbo_ids')
          .where('user_id', '=', person(6))
          .execute()
        const gumboId = first === 'membership' ? 8_200_001 : 8_200_002
        const core = await raced(
          first,
          `insert into gumbo_ids (gumbo_id, user_id) values (${gumboId}, $1)`
        )
        expect(core.gumboIds).deep.includes([person(6), gumboId])
      })

    it('lets two membership writes of one person run at once, each holding the person shared', async function () {
      const pool = new Pool({ connectionString: url })
      const one = await pool.connect()
      const two = await pool.connect()
      try {
        await one.query('begin')
        await two.query('begin')
        await one.query(
          `insert into memberships (id, team_id, user_id, role)
            values ('mem_rc_c6', $1, $2, 'manager')`,
          [TEAM_C, person(6)]
        )
        const second = two.query(
          `insert into memberships (id, team_id, user_id, role)
            values ('mem_rc_b6', $1, $2, 'manager')`,
          [TEAM_B, person(6)]
        )
        second.catch(() => undefined)
        expect(
          await Promise.race([second.then(() => 'done'), sleep(2000)])
        ).equals('done')
        await one.query('commit')
        await two.query('commit')
      } finally {
        one.release()
        two.release()
        await pool.end()
      }
      await agrees(TEAM_B, TEAM_C)
    })

    it('lets a jersey edit and a removal of a person’s memberships run beside an open rename of them', async function () {
      const pool = new Pool({ connectionString: url })
      const renamer = await pool.connect()
      try {
        await renamer.query('begin')
        await renamer.query(
          `update users set display_name = 'Open Rename' where id = $1`,
          [person(2)]
        )
        // Both rows already name the person on their team, so the rename's
        // trigger bumped both teams: neither write needs to wait.
        await Promise.race([
          (async () => {
            await db
              .updateTable('memberships')
              .set({ jersey: '22' })
              .where('id', '=', 'mem_rc_a2')
              .execute()
            await db
              .deleteFrom('memberships')
              .where('id', '=', 'mem_rc_b2')
              .execute()
          })(),
          sleep(2000).then(() => {
            throw new Error('A membership write waited for the rename')
          })
        ])
        await teamRosterCore(db, TEAM_A, cache)
        await renamer.query('commit')
      } finally {
        renamer.release()
        await pool.end()
      }
      await agrees(TEAM_A, TEAM_B)
      const core = await teamRosterCore(db, TEAM_A, cache)
      expect(core.members.find(row => row.userId === person(2))).includes({
        displayName: 'Open Rename',
        jersey: '22'
      })
    })

    it('makes a repeatable read membership write wait for an open rename of the person, and shows the new name', async function () {
      const pool = new Pool({ connectionString: url })
      const renamer = await pool.connect()
      const member = await pool.connect()
      try {
        const memberPid = (
          await member.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0].pid
        await renamer.query('begin')
        await renamer.query(
          `update users set display_name = 'Serial Six' where id = $1`,
          [person(6)]
        )
        await member.query('begin isolation level repeatable read')
        const joining = member.query(
          `insert into memberships (id, team_id, user_id, role)
            values ('mem_rc_c6', $1, $2, 'manager')`,
          [TEAM_C, person(6)]
        )
        joining.catch(() => undefined)
        expect(await doneOrWaiting(joining, memberPid)).equals('waiting')
        await renamer.query('commit')
        await joining
        await member.query('commit')
      } finally {
        renamer.release()
        member.release()
        await pool.end()
      }
      await agrees(TEAM_C)
      expect(
        (await teamRosterCore(db, TEAM_C, cache)).members.find(
          row => row.userId === person(6)
        )?.displayName
      ).equals('Serial Six')
    })

    it('misses a membership written while a repeatable read rename of the person runs, which no writer makes', async function () {
      // The rename waits for the membership, then its trigger reads
      // `memberships` with the snapshot its transaction began with.
      const pool = new Pool({ connectionString: url })
      const renamer = await pool.connect()
      const member = await pool.connect()
      try {
        await member.query('begin')
        await member.query(
          `insert into memberships (id, team_id, user_id, role)
            values ('mem_rc_c6', $1, $2, 'manager')`,
          [TEAM_C, person(6)]
        )
        await renamer.query('begin isolation level repeatable read')
        await renamer.query('select 1')
        const renaming = renamer.query(
          `update users set display_name = 'Repeatable Six' where id = $1`,
          [person(6)]
        )
        renaming.catch(() => undefined)
        await sleep(200)
        await member.query('commit')
        const joined = await versionOf(db, TEAM_C)
        await renaming
        await renamer.query('commit')
        expect(await versionOf(db, TEAM_C)).equals(joined)
      } finally {
        renamer.release()
        member.release()
        await pool.end()
      }
    })

    it('takes no lock table slot per person for 70,000 people written in one transaction', async function () {
      this.timeout(120_000)
      const { db: bulk, drop: dropBulk } =
        await scratchDatabase('rostercachebulk')
      try {
        const ids = Array.from({ length: 70_000 }, (_, n) =>
          userIdOfGumbo(7_500_000 + n)
        )
        await bulk
          .insertInto('teams')
          .values({ id: 'tem_rc_bulk', name: 'Bulk' })
          .execute()
        const slots = await bulk.transaction().execute(async trx => {
          await sql`insert into users (id, display_name)
            select id, 'Bulk ' || id from unnest(${ids}::text[]) id`.execute(
            trx
          )
          await sql`insert into gumbo_ids (user_id, gumbo_id)
            select id, 7500000 + n
            from unnest(${ids}::text[]) with ordinality as asked(id, n)`.execute(
            trx
          )
          await sql`insert into memberships (id, team_id, user_id, role)
            select 'mem_rc_bulk_' || id, 'tem_rc_bulk', id, 'member'
            from unnest(${ids}::text[]) id`.execute(trx)
          await sql`update users set display_name = display_name || '!'
            where id = any(${ids}::text[])`.execute(trx)
          await sql`update gumbo_ids set gumbo_id = gumbo_id + 100000
            where user_id = any(${ids}::text[])`.execute(trx)
          const { rows } = await sql<{ n: string }>`
            select count(*)::text as n from pg_locks
            where pid = pg_backend_pid()`.execute(trx)
          return Number(rows[0].n)
        })
        expect(slots).below(100)
        const { rows } = await sql<{ n: string }>`
          select count(*)::text as n from memberships
          join users on users.id = memberships.user_id
          where memberships.team_id = 'tem_rc_bulk'
            and users.display_name like '%!'`.execute(bulk)
        expect(Number(rows[0].n)).equals(70_000)
      } finally {
        await dropBulk()
      }
    })
  })

  describe('migration 109', function () {
    it('goes up and down on a scratch database, writing a new epoch each time', async function () {
      const { db, url, drop } = await scratchDatabase('rostercachemigrate')
      const pool = new Pool({ connectionString: url })
      try {
        await db
          .insertInto('teams')
          .values({ id: 'tem_rc_m', name: 'Maples' })
          .execute()
        const epoch = async (): Promise<string> =>
          (
            await db
              .selectFrom('roster_cache_epoch')
              .select('epoch')
              .executeTakeFirstOrThrow()
          ).epoch
        const first = await epoch()
        // 109, and every migration after it first.
        const through = migrations.filter(
          m => m.name >= '109teamRosterVersions'
        ).length
        expect((await migrateDown(pool, migrations, through)).at(-1)).equals(
          '109teamRosterVersions'
        )
        const tables = async (): Promise<string[]> =>
          (
            await sql<{ name: string }>`
              select relname as name from pg_class
              where relname in ('team_roster_bumps', 'roster_cache_epoch', 'team_roster_version_seq')
              order by relname`.execute(db)
          ).rows.map(row => row.name)
        expect(await tables()).deep.equals([])
        const triggers = await sql<{ n: string }>`
          select count(*)::text as n from pg_trigger where tgname like '%roster%'`.execute(
          db
        )
        expect(triggers.rows[0].n).equals('0')
        // Writes go on as before with no triggers.
        await insertFixtureUsers(db, [{ id: 7_400_001, display_name: 'Down' }])
        await db
          .insertInto('memberships')
          .values({
            id: 'mem_rc_m',
            team_id: 'tem_rc_m',
            user_id: userIdOfGumbo(7_400_001)
          })
          .execute()
        await migrateUp(pool, migrations)
        expect(await tables()).deep.equals([
          'roster_cache_epoch',
          'team_roster_bumps',
          'team_roster_version_seq'
        ])
        expect(await epoch()).not.equals(first)
        expect(await versionOf(db, 'tem_rc_m')).above(0)
        await expectRejection(
          sql`insert into roster_cache_epoch (epoch) values ('second')`.execute(
            db
          )
        )
      } finally {
        await pool.end()
        await drop()
      }
    })
  })
})

async function expectRejection(promise: Promise<unknown>): Promise<void> {
  let failed = false
  try {
    await promise
  } catch {
    failed = true
  }
  expect(failed).equals(true)
}
