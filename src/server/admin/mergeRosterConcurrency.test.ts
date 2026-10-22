import { setTimeout } from 'node:timers/promises'

import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { asTeamAdultsBody, asTeamPlayersBody } from '../../common/teamMembers'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import { playerRoutes } from '../routes/players'
import { addAdults } from '../teams/addAdults'
import { addPlayers } from '../teams/addPlayers'
import { mergeTeams } from './mergeTeams'
import { closeInto } from './people'

describe('roster writes concurrent with an account merge', function () {
  this.timeout(15000)
  let fixture: AccountHarness
  const closing = userIdOfGumbo(101)
  const keeping = userIdOfGumbo(102)
  const externalId = { system: 'example', kind: 'person', id: 'ruth' }

  beforeEach(async () => {
    fixture = await accountHarness()
    await fixture.db
      .insertInto('external_ids')
      .values({
        id: 'ext_merge_roster',
        entity_type: 'user',
        entity_id: closing,
        system: externalId.system,
        kind: externalId.kind,
        external_id: externalId.id
      })
      .execute()
  })
  afterEach(async () => {
    await fixture?.close()
  })

  for (const sharedTeam of [false, true])
    it(`finishes opposite-order adult/player imports on ${sharedTeam ? 'one team' : 'different teams'}`, async () => {
      const playerTeam = sharedTeam ? 'tem_adults' : 'tem_players'
      const { db } = fixture
      const users = [closing, keeping].sort()
      await db
        .insertInto('teams')
        .values([
          { id: 'tem_adults', name: 'Adults', kind: 'external' },
          { id: 'tem_players', name: 'Players', kind: 'external' }
        ])
        .execute()
      await db
        .insertInto('external_ids')
        .values(
          ['adult', 'player'].flatMap(batch =>
            users.map((userId, index) => ({
              id: `ext_${batch}_${index}`,
              entity_type: 'user',
              entity_id: userId,
              system: 'example',
              kind: 'person',
              external_id: `${batch}_${index}`
            }))
          )
        )
        .execute()
      let release = (): void => {}
      let reached = (): void => {}
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const paused = new Promise<void>(resolve => {
        reached = resolve
      })
      const inserts = new Set<unknown>()
      let first = true
      const adultDb = db.withPlugin({
        transformQuery(args) {
          if (
            args.node.kind === 'InsertQueryNode' &&
            JSON.stringify(args.node.into).includes('"memberships"')
          )
            inserts.add(args.queryId)
          return args.node
        },
        async transformResult(args) {
          if (first && inserts.has(args.queryId)) {
            first = false
            reached()
            await barrier
          }
          return args.result
        }
      })
      const adults = addAdults(
        adultDb,
        'tem_adults',
        asTeamAdultsBody({
          adults: [1, 0].map(index => ({
            externalId: {
              system: 'example',
              kind: 'person',
              id: `adult_${index}`
            }
          }))
        }).adults,
        { userId: closing, isAdmin: true }
      )
      adults.catch(() => undefined)
      let players: ReturnType<typeof addPlayers> | undefined
      try {
        await Promise.race([
          paused,
          setTimeout(5000).then(() => {
            throw new Error('Adult import did not pause')
          })
        ])
        players = addPlayers(
          db,
          playerTeam,
          asTeamPlayersBody({
            players: [0, 1].map(index => ({
              externalId: {
                system: 'example',
                kind: 'person',
                id: `player_${index}`
              },
              jersey: String(index + 1)
            }))
          }).players
        )
        players.catch(() => undefined)
        if (sharedTeam) {
          let waiting = false
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const locks = await sql<{ waiting: boolean }>`
            select exists(select 1 from pg_locks
              where locktype = 'advisory' and not granted
              and database = (select oid from pg_database where datname = current_database())
            ) as waiting`.execute(db)
            if (locks.rows[0].waiting) {
              waiting = true
              break
            }
            await setTimeout(10)
          }
          expect(
            waiting,
            'player import waits before locking any account'
          ).equals(true)
          release()
        }
        const result = await Promise.race([
          players,
          setTimeout(5000).then(() => {
            throw new Error('Player import blocked on an adult foreign key')
          })
        ])
        expect(result.counts).includes({ joined: 2, error: 0 })
        release()
        expect((await adults).counts).includes({ matched: 2, error: 0 })
        const memberships = await db
          .selectFrom('memberships')
          .select(['team_id', 'user_id', 'is_player'])
          .where('team_id', 'in', ['tem_adults', 'tem_players'])
          .orderBy('team_id')
          .orderBy('user_id')
          .execute()
        expect(memberships).deep.equals(
          (sharedTeam ? ['tem_adults'] : ['tem_adults', 'tem_players']).flatMap(
            teamId =>
              users.map(userId => ({
                team_id: teamId,
                user_id: userId,
                is_player: teamId === playerTeam
              }))
          )
        )
      } finally {
        release()
        await Promise.allSettled([adults, players])
      }
    })

  it('finishes settings before an import locks the same membership', async () => {
    await fixture.close()
    let release = (): void => {}
    let reached = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const paused = new Promise<void>(resolve => {
      reached = resolve
    })
    const updates = new Set<unknown>()
    let first = true
    fixture = await accountHarness(undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        playerRoutes(
          db.withPlugin({
            transformQuery(args) {
              if (
                args.node.kind === 'UpdateQueryNode' &&
                JSON.stringify(args.node.table).includes('"memberships"')
              )
                updates.add(args.queryId)
              return args.node
            },
            async transformResult(args) {
              if (first && updates.has(args.queryId)) {
                first = false
                reached()
                await barrier
              }
              return args.result
            }
          }),
          media
        )
      )
    })
    const { db } = fixture
    await db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', keeping)
      .execute()
    await db
      .insertInto('external_ids')
      .values({
        id: 'ext_settings',
        entity_type: 'user',
        entity_id: closing,
        system: externalId.system,
        kind: externalId.kind,
        external_id: externalId.id
      })
      .execute()
    const settings = fixture.request(
      'PUT',
      `/teams/tem_account/players/${closing}/settings`,
      { jersey: '12', bats: 'left' },
      102
    )
    settings.catch(() => undefined)
    let imported: ReturnType<typeof addPlayers> | undefined
    try {
      await Promise.race([
        paused,
        setTimeout(5000).then(() => {
          throw new Error('Settings did not reach its membership update')
        })
      ])
      imported = addPlayers(
        db,
        'tem_account',
        asTeamPlayersBody({
          players: [{ externalId, jersey: '9' }]
        }).players
      )
      imported.catch(() => undefined)
      let waiting = false
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const locks = await sql<{ waiting: boolean }>`
          select exists(select 1 from pg_locks
            where locktype = 'transactionid' and not granted
            and pid in (select pid from pg_stat_activity where datname = current_database())
          ) as waiting`.execute(db)
        if (locks.rows[0].waiting) {
          waiting = true
          break
        }
        await setTimeout(10)
      }
      expect(waiting, 'import waits before taking the membership lock').equals(
        true
      )
      release()
      expect((await settings).status).equals(200)
      expect((await imported).counts.error).equals(0)
      expect(
        await db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select(['jersey', 'bats', 'bats_source'])
          .where('team_id', '=', 'tem_account')
          .where('user_id', '=', closing)
          .executeTakeFirstOrThrow()
      ).deep.equals({ jersey: '12', bats: 'left', bats_source: 'manual' })
    } finally {
      release()
      await Promise.allSettled([settings, imported])
    }
  })

  it('serializes opposite-order imports through distinct aliases of the same accounts', async () => {
    const { db } = fixture
    const teams = ['tem_import_one', 'tem_import_two']
    await db
      .insertInto('teams')
      .values(
        teams.map(id => ({ id, name: 'Import', kind: 'external' as const }))
      )
      .execute()
    await db
      .insertInto('external_ids')
      .values(
        teams.flatMap((team, batch) =>
          [closing, keeping].map((userId, index) => ({
            id: `ext_import_${batch}_${index}`,
            entity_type: 'user',
            entity_id: userId,
            system: 'example',
            kind: 'person',
            external_id: `${team}_${index}`
          }))
        )
      )
      .execute()
    let release = (): void => {}
    let reached = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const paused = new Promise<void>(resolve => {
      reached = resolve
    })
    const inserts = new Set<unknown>()
    let first = true
    const importer = db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'InsertQueryNode' &&
          JSON.stringify(args.node.into).includes('"memberships"')
        )
          inserts.add(args.queryId)
        return args.node
      },
      async transformResult(args) {
        if (first && inserts.has(args.queryId)) {
          first = false
          reached()
          await barrier
        }
        return args.result
      }
    })
    const rows = (
      batch: number
    ): ReturnType<typeof asTeamPlayersBody>['players'] =>
      asTeamPlayersBody({
        players: (batch === 0 ? [0, 1] : [1, 0]).map(index => ({
          externalId: {
            system: 'example',
            kind: 'person',
            id: `${teams[batch]}_${index}`
          },
          jersey: String(index + 1)
        }))
      }).players
    const one = addPlayers(importer, teams[0], rows(0))
    one.catch(() => undefined)
    let two: ReturnType<typeof addPlayers> | undefined
    try {
      await Promise.race([
        paused,
        setTimeout(5000).then(() => {
          throw new Error('Import did not pause')
        })
      ])
      two = addPlayers(db, teams[1], rows(1))
      two.catch(() => undefined)
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline) {
        const locks = await sql<{ waiting: boolean }>`
          select exists(select 1 from pg_locks
            where locktype = 'transactionid' and not granted
            and pid in (select pid from pg_stat_activity where datname = current_database())
          ) as waiting`.execute(db)
        if (locks.rows[0].waiting) {
          waiting = true
          break
        }
        await setTimeout(10)
      }
      expect(
        waiting,
        'second import waits on the ordered account locks'
      ).equals(true)
      release()
      expect((await one).counts).includes({ joined: 2, error: 0 })
      expect((await two).counts).includes({ joined: 2, error: 0 })
      const members = await db
        .selectFrom('memberships')
        .select(['team_id', 'user_id', 'jersey'])
        .where('team_id', 'in', teams)
        .orderBy('team_id')
        .orderBy('user_id')
        .execute()
      expect(members).deep.equals(
        teams.flatMap(teamId =>
          [
            { team_id: teamId, user_id: closing, jersey: '1' },
            { team_id: teamId, user_id: keeping, jersey: '2' }
          ].sort((a, b) => a.user_id.localeCompare(b.user_id))
        )
      )
    } finally {
      release()
      await Promise.allSettled([one, two])
    }
  })

  it('finishes a player import before a team merge locks the same membership', async () => {
    const { db } = fixture
    await db.updateTable('teams').set({ kind: 'external' }).execute()
    await db
      .insertInto('teams')
      .values({ id: 'tem_duplicate', name: 'Duplicate', kind: 'external' })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_duplicate',
        team_id: 'tem_duplicate',
        user_id: closing,
        is_player: true
      })
      .execute()
    let release = (): void => {}
    let reached = (): void => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const paused = new Promise<void>(resolve => {
      reached = resolve
    })
    const updates = new Set<unknown>()
    const importer = db.withPlugin({
      transformQuery(args) {
        if (
          args.node.kind === 'UpdateQueryNode' &&
          JSON.stringify(args.node.table).includes('"users"')
        )
          updates.add(args.queryId)
        return args.node
      },
      async transformResult(args) {
        if (updates.has(args.queryId)) {
          reached()
          await barrier
        }
        return args.result
      }
    })
    const imported = addPlayers(
      importer,
      'tem_account',
      asTeamPlayersBody({
        players: [{ externalId, bats: 'left', jersey: '12' }]
      }).players
    )
    imported.catch(() => undefined)
    let merged: ReturnType<typeof mergeTeams> | undefined
    try {
      await Promise.race([
        paused,
        setTimeout(5000).then(() => {
          throw new Error('Import did not reach its user update')
        })
      ])
      merged = mergeTeams(db, {
        fromTeamId: 'tem_duplicate',
        intoTeamId: 'tem_account',
        apply: true
      })
      merged.catch(() => undefined)
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline) {
        const locks = await sql<{ waiting: boolean }>`
          select exists(select 1 from pg_locks
            where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())
          ) as waiting`.execute(db)
        if (locks.rows[0].waiting) {
          waiting = true
          break
        }
        await setTimeout(10)
      }
      expect(waiting, 'team merge waits before taking membership locks').equals(
        true
      )
      release()
      expect((await imported).counts.error).equals(0)
      expect((await merged).applied).equals(true)
      const memberships = await db
        .selectFrom('memberships')
        .select(['team_id', 'jersey', 'is_player'])
        .where('user_id', '=', closing)
        .execute()
      expect(memberships).deep.equals([
        { team_id: 'tem_account', jersey: '12', is_player: true }
      ])
      expect(
        (
          await db
            .selectFrom('users')
            .select('bats')
            .where('id', '=', closing)
            .executeTakeFirstOrThrow()
        ).bats
      ).equals('left')
    } finally {
      release()
      await Promise.allSettled([imported, merged])
    }
  })

  for (const operation of ['player', 'promotion', 'adult', 'settings'] as const)
    it(`finishes a merge before the ${operation} writer locks membership rows`, async () => {
      const { db } = fixture
      if (operation === 'promotion')
        await db.updateTable('memberships').set({ is_player: false }).execute()
      const write = async (): Promise<unknown> => {
        if (operation === 'settings')
          return await fixture.request(
            'PUT',
            `/teams/tem_account/players/${closing}/settings`,
            { jersey: '12', bats: 'left' }
          )
        if (operation === 'adult')
          return await addAdults(
            db,
            'tem_account',
            asTeamAdultsBody({ adults: [{ externalId }] }).adults,
            { userId: keeping, isAdmin: true }
          )
        return await addPlayers(
          db,
          'tem_account',
          asTeamPlayersBody({ players: [{ externalId, jersey: '12' }] }).players
        )
      }
      let pending: Promise<unknown> | undefined
      try {
        // `atomic`, as a caller of `closeInto` opens its transaction.
        await atomic(db, async trx => {
          // Pause the real merge at its user-row barrier, after acquiring
          // exactly the advisory locks it takes before reaching that barrier.
          await lockKeys(trx, [
            'creation:parent-graph',
            'node:administration',
            'users.closeInto'
          ])
          await trx
            .selectFrom('users')
            .select('id')
            .where('id', 'in', [closing, keeping])
            .orderBy('id')
            .forUpdate()
            .execute()
          pending = write()
          // Attach rejection handling while checking the database lock state.
          pending.catch(() => undefined)
          const deadline = Date.now() + 5000
          let waiting = false
          while (Date.now() < deadline) {
            const locks = await sql<{ waiting: boolean }>`
              select exists(select 1 from pg_locks
                where locktype = 'advisory' and not granted
                and database = (select oid from pg_database where datname = current_database())
              ) as waiting`.execute(db)
            if (locks.rows[0].waiting) {
              waiting = true
              break
            }
            await setTimeout(10)
          }
          expect(waiting, 'writer waits before locking membership rows').equals(
            true
          )
          expect((await closeInto(trx, closing, keeping)).closed).equals(true)
        })
        const result = await pending
        if (operation === 'settings') {
          expect((result as Response).status).equals(404)
          expect(
            (
              await db
                .selectFrom('users')
                .select('bats')
                .where('id', '=', keeping)
                .executeTakeFirstOrThrow()
            ).bats
          ).equals(null)
        } else {
          expect(
            (result as { results: Array<{ userId: string }> }).results[0].userId
          ).equals(keeping)
          const membership = await db
            .selectFrom('memberships')
            .selectAll()
            .where('team_id', '=', 'tem_account')
            .execute()
          expect(membership).length(1)
          expect(membership[0].user_id).equals(keeping)
          if (operation !== 'adult')
            expect(membership[0]).includes({ jersey: '12', is_player: true })
        }
      } finally {
        await pending?.catch(() => undefined)
      }
    })
})
