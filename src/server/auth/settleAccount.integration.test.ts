import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { createSession } from './sessions'
import { onboardingFor, settleAccount } from './settleAccount'

describe('verified account settlement', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })
  it('settles concurrent normalized addresses once without any inferred grants', async () => {
    const rows = await Promise.all([
      settleAccount(h.db, 'NEW@example.com'),
      settleAccount(h.db, ' new@example.com ')
    ])
    expect(rows[0].userId).equals(rows[1].userId)
    expect(rows.filter(row => row.createdAccount)).length(1)
    const user = await h.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', rows[0].userId)
      .executeTakeFirstOrThrow()
    expect(user.display_name).equals('New account')
    expect(user.onboarding_step).equals('name')
    expect(user.is_admin).equals(false)
    expect(
      await h.db
        .selectFrom('memberships')
        .selectAll()
        .where('user_id', '=', user.id)
        .execute()
    ).length(0)
    expect(
      await h.db
        .selectFrom('scope_roles')
        .selectAll()
        .where('user_id', '=', user.id)
        .execute()
    ).length(0)
    expect(await onboardingFor(h.db, user.id)).deep.equals({
      step: 'name',
      completedAt: null
    })
    expect((await onboardingFor(h.db, userIdOfGumbo(101))).step).equals(
      'complete'
    )
  })
  it('refuses an address trapped in an unresolved merge cycle and rolls back the new account', async () => {
    await insertFixtureUsers(h.db, [
      { id: 7001, display_name: 'Hank Aaron' },
      { id: 7002, display_name: 'Babe Ruth' }
    ])
    await h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(7002) })
      .where('id', '=', userIdOfGumbo(7001))
      .execute()
    await h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(7001) })
      .where('id', '=', userIdOfGumbo(7002))
      .execute()
    await h.db
      .insertInto('user_emails')
      .values({
        id: 'email_cycle',
        user_id: userIdOfGumbo(7001),
        email: 'cycle@example.test'
      })
      .execute()
    const error = await settleAccount(h.db, 'cycle@example.test', {
      mint: () => userIdOfGumbo(7003)
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(error).property('code', 'conflict')
    expect(
      await h.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', userIdOfGumbo(7003))
        .execute()
    ).length(0)
    expect(
      await h.db
        .selectFrom('gumbo_ids')
        .select('gumbo_id')
        .where('user_id', '=', userIdOfGumbo(7003))
        .execute()
    ).length(0)
  })
  it('verifies only the proved normalized imported address on an existing account', async () => {
    await h.db
      .updateTable('user_emails')
      .set({ verified_at: null, source: 'import' })
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    await h.db
      .insertInto('user_emails')
      .values({
        id: 'email_unproved_alias',
        user_id: userIdOfGumbo(101),
        email: 'unproved@example.com',
        source: 'import',
        verified_at: null
      })
      .execute()
    const settled = await settleAccount(h.db, ' ALEX@EXAMPLE.COM ')
    expect(settled.userId).equals(userIdOfGumbo(101))
    expect(settled.createdAccount).equals(false)
    const addresses = await h.db
      .selectFrom('user_emails')
      .select(['email', 'verified_at'])
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    expect(
      addresses.find(row => row.email === 'alex@example.com')!.verified_at
    ).not.equals(null)
    expect(
      addresses.find(row => row.email === 'unproved@example.com')!.verified_at
    ).equals(null)
  })
  it('retries id collisions without aborting the address transaction', async () => {
    let calls = 0
    const settled = await settleAccount(h.db, 'collision@example.com', {
      displayName: 'Mike Trout',
      mint: () => (++calls === 1 ? userIdOfGumbo(101) : userIdOfGumbo(303))
    })
    expect(settled.userId).equals(userIdOfGumbo(303))
    expect(calls).equals(2)
    expect(settled.displayName).equals('Mike Trout')
    const exhausted = await settleAccount(h.db, 'exhausted@example.com', {
      mint: () => userIdOfGumbo(101)
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(exhausted).property('code', 'unavailable')
    expect(
      await h.db
        .selectFrom('user_emails')
        .selectAll()
        .where('email', '=', 'exhausted@example.com')
        .execute()
    ).length(0)
  })
  it('enables first verified login without reactivating a suspended account', async () => {
    await h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
    expect(await settleAccount(h.db, 'casey@example.com')).property(
      'createdAccount',
      false
    )
    expect((await onboardingFor(h.db, userIdOfGumbo(102))).step).equals('name')
    await h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
    expect(
      await settleAccount(h.db, 'casey@example.com').then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'unauthorized')
    expect(
      await createSession(h.db, userIdOfGumbo(102), 'test').then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'unauthorized')
    await h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(101) })
      .where('id', '=', userIdOfGumbo(303))
      .execute()
    expect(
      await createSession(h.db, userIdOfGumbo(303), 'test').then(
        () => null,
        (error: unknown) => error
      )
    ).property('code', 'unauthorized')
    // A merged account's address settles on the account it was merged into,
    // and creates nobody.
    const before = await h.db.selectFrom('users').select('id').execute()
    expect((await settleAccount(h.db, 'collision@example.com')).userId).equals(
      userIdOfGumbo(101)
    )
    expect(await h.db.selectFrom('users').select('id').execute()).length(
      before.length
    )
  })
})
