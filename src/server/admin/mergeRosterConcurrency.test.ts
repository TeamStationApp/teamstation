import { setTimeout } from 'node:timers/promises'

import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { asTeamAdultsBody, asTeamPlayersBody } from '../../common/teamMembers'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { lockKeys } from '../db/advisoryLocks'
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
        await db.transaction().execute(async trx => {
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
