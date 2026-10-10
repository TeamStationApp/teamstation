import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { changeNodeAccount } from '../admin/nodeAdministration'
import { closeInto } from '../admin/people'
import { setScopeRoles } from '../invites/people'
import { directAdminIds } from './adminGuard'

describe('person merges preserve active administrators', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('refuses merging the sole direct administrator and rolls back memberships and identity', async () => {
    const before = await f.h.db
      .selectFrom('memberships')
      .selectAll()
      .where('user_id', '=', 101)
      .execute()
    const result = await closeInto(f.h.db, 101, 106).catch(
      (error: unknown) => error
    )
    expect(result).property('code', 'conflict')
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('merged_into')
          .where('id', '=', 101)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
    expect(
      await f.h.db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', '=', 101)
        .execute()
    ).deep.equals(before)
    for (const ref of [
      { kind: 'league' as const, id: f.leagueA },
      { kind: 'season' as const, id: f.seasonA },
      { kind: 'team' as const, id: f.teamA }
    ])
      expect(await directAdminIds(f.h.db, ref)).deep.equals([101])
  })
  it('permits a merge after active replacements cover the affected groups', async () => {
    for (const ref of [
      { kind: 'league' as const, id: f.leagueA },
      { kind: 'season' as const, id: f.seasonA },
      { kind: 'season' as const, id: f.playoffs },
      { kind: 'team' as const, id: f.teamA }
    ])
      await setScopeRoles(
        f.h.db,
        ref.kind,
        ref.id,
        106,
        { admin: true, flags: [] },
        105
      )
    expect((await closeInto(f.h.db, 101, 106)).closed).equals(true)
    expect(
      await directAdminIds(f.h.db, { kind: 'team', id: f.teamA })
    ).deep.equals([106])
    expect(
      await directAdminIds(f.h.db, { kind: 'team', id: 'tem_account' })
    ).deep.equals([106])
  })
  it('refuses merging the final active node administrator and permits it after an active node replacement', async () => {
    expect(
      await closeInto(f.h.db, 105, 106).catch((error: unknown) => error)
    ).property('code', 'conflict')
    await changeNodeAccount(f.h.db, actor(105), 106, { isNodeAdmin: true })
    expect((await closeInto(f.h.db, 105, 106)).closed).equals(true)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('merged_into')
          .where('id', '=', 105)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(106)
  })
  it('leaves the identity open when a caller catches a refusal and commits its outer transaction', async () => {
    await f.h.db.transaction().execute(async trx => {
      expect(
        await closeInto(trx, 101, 106).catch((error: unknown) => error)
      ).property('code', 'conflict')
    })
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('merged_into')
          .where('id', '=', 101)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
    expect(
      await directAdminIds(f.h.db, { kind: 'team', id: f.teamA })
    ).deep.equals([101])
  })
})
