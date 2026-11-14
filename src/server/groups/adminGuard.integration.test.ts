import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { removeFromScope, setScopeRoles } from '../invites/people'
import { directAdminIds } from './adminGuard'

describe('active direct administrator replacement', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  async function fails(work: Promise<unknown>, code: string): Promise<void> {
    let error: unknown
    try {
      await work
    } catch (caught) {
      error = caught
    }
    expect(error).property('code', code)
  }
  it('refuses the last direct admin even with inherited administrators or a pending replacement', async () => {
    await fails(
      setScopeRoles(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(101),
        { admin: false, flags: [] },
        userIdOfGumbo(101)
      ),
      'conflict'
    )
    expect(
      await directAdminIds(f.h.db, { kind: 'team', id: f.teamA })
    ).deep.equals([101].map(userIdOfGumbo))
    await fails(
      removeFromScope(
        f.h.db,
        'league',
        f.leagueA,
        userIdOfGumbo(101),
        userIdOfGumbo(101)
      ),
      'conflict'
    )
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', userIdOfGumbo(104))
      .execute()
    await fails(
      setScopeRoles(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(104),
        { admin: true, flags: [] },
        userIdOfGumbo(101)
      ),
      'conflict'
    )
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: true, disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(104))
      .execute()
    await fails(
      setScopeRoles(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(104),
        { admin: true, flags: [] },
        userIdOfGumbo(101)
      ),
      'conflict'
    )
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: null })
      .where('id', '=', userIdOfGumbo(104))
      .execute()
  })
  it('allows accepted replacement, serializes competing removals and preserves at least one direct admin', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(103),
      { admin: true, flags: ['scorekeeper'] },
      userIdOfGumbo(101)
    )
    const removals = await Promise.allSettled([
      removeFromScope(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(101),
        userIdOfGumbo(105)
      ),
      removeFromScope(
        f.h.db,
        'team',
        f.teamA,
        userIdOfGumbo(103),
        userIdOfGumbo(105)
      )
    ])
    expect(removals.filter(row => row.status === 'fulfilled')).length(1)
    expect(removals.filter(row => row.status === 'rejected')).length(1)
    expect(await directAdminIds(f.h.db, { kind: 'team', id: f.teamA })).length(
      1
    )
  })
  it('counts active owner/manager memberships and protects node accounts from lower administrators', async () => {
    expect(
      await directAdminIds(f.h.db, { kind: 'team', id: 'tem_account' })
    ).deep.equals([101].map(userIdOfGumbo))
    await fails(
      removeFromScope(
        f.h.db,
        'team',
        'tem_account',
        userIdOfGumbo(101),
        userIdOfGumbo(101)
      ),
      'conflict'
    )
    await fails(
      setScopeRoles(
        f.h.db,
        'season',
        f.seasonA,
        userIdOfGumbo(105),
        { admin: false, flags: [] },
        userIdOfGumbo(101)
      ),
      'forbidden'
    )
    await fails(
      setScopeRoles(
        f.h.db,
        'season',
        f.seasonA,
        userIdOfGumbo(103),
        { admin: true, flags: [] },
        userIdOfGumbo(106)
      ),
      'forbidden'
    )
    await fails(
      setScopeRoles(
        f.h.db,
        'season',
        f.seasonA,
        userIdOfGumbo(9999),
        { admin: true, flags: [] },
        userIdOfGumbo(101)
      ),
      'notFound'
    )
  })
})
