import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { lockKeys } from '../db/advisoryLocks'
import { setScopeRoles } from '../invites/people'
import { applyParents, previewParents } from './relationships'

describe('competition removal uses current authority under the shared lock', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('season_teams')
      .values({ team_id: f.teamA, season_id: f.seasonB, active: true })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  for (const loss of ['role', 'suspension', 'parent'] as const) {
    it(`rejects a queued removal after ${loss} commits and preserves competition membership`, async () => {
      await setScopeRoles(
        f.h.db,
        loss === 'parent' ? 'season' : 'team',
        loss === 'parent' ? f.seasonA : f.teamA,
        userIdOfGumbo(106),
        { admin: true, flags: [] },
        userIdOfGumbo(101)
      )
      let releaseRow!: () => void
      let releaseAuthority!: () => void
      let rowReady!: () => void
      let authorityReady!: () => void
      const rowWait = new Promise<void>(resolve => {
        releaseRow = resolve
      })
      const authorityWait = new Promise<void>(resolve => {
        releaseAuthority = resolve
      })
      const rowHeld = new Promise<void>(resolve => {
        rowReady = resolve
      })
      const authorityHeld = new Promise<void>(resolve => {
        authorityReady = resolve
      })
      const holder = f.h.db.transaction().execute(async trx => {
        await trx
          .selectFrom('season_teams')
          .select('team_id')
          .where('team_id', '=', f.teamA)
          .where('season_id', '=', f.seasonB)
          .forUpdate()
          .execute()
        rowReady()
        await rowWait
      })
      await rowHeld
      const revocation = f.h.db.transaction().execute(async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        authorityReady()
        await authorityWait
        if (loss === 'suspension')
          await changeNodeAccount(trx, actor(105), userIdOfGumbo(106), {
            suspended: true
          })
        else if (loss === 'parent')
          await applyParents(
            trx,
            [actor(101)],
            await previewParents(trx, [
              {
                operation: 'detach',
                parent: { kind: 'season', id: f.seasonA },
                child: { kind: 'team', id: f.teamA }
              }
            ])
          )
        else
          await setScopeRoles(
            trx,
            'team',
            f.teamA,
            userIdOfGumbo(106),
            { admin: false, flags: [] },
            userIdOfGumbo(101)
          )
      })
      await authorityHeld
      let removal: Promise<Response> | undefined
      try {
        removal = f.h.request(
          'DELETE',
          `/seasons/${f.seasonB}/memberships/${f.teamA}`,
          undefined,
          106
        )
        const deadline = Date.now() + 5000
        while (true) {
          const waiting = await sql<{
            n: number
          }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
            f.h.db
          )
          if (waiting.rows[0].n > 0) break
          if (Date.now() > deadline)
            throw new Error('Removal did not reach its authority/row wait')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        releaseAuthority()
        await revocation
        releaseRow()
        await holder
        expect((await removal).status).equals(loss === 'suspension' ? 401 : 403)
        expect(
          (
            await f.h.db
              .selectFrom('season_teams')
              .select('active')
              .where('season_id', '=', f.seasonB)
              .where('team_id', '=', f.teamA)
              .executeTakeFirstOrThrow()
          ).active
        ).equals(true)
        expect(
          (
            await f.h.request(
              'DELETE',
              `/seasons/${f.seasonB}/memberships/${f.teamA}`,
              undefined,
              102
            )
          ).status
        ).equals(200)
      } finally {
        releaseAuthority()
        releaseRow()
        await holder
        await revocation
        await removal
      }
    })
  }
})
