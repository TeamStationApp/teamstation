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
