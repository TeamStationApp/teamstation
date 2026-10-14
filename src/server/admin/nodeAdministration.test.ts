import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { roleScopes, visibleScopes } from '../access'
import { hashToken } from '../auth/tokens'
import { changeNodeAccount, nodeAccounts } from './nodeAdministration'

describe('protected node account administration', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('returns all name/email matches and filters current admins only when requested', async () => {
    await f.h.db
      .insertInto('users')
      .values(
        Array.from({ length: 55 }, (_, i) => ({
          id: 1000 + i,
          legacyId: `usr_node_search_${i}`,
          display_name: `Aaron ${i}`,
          login_enabled: true,
          is_admin: i === 54
        }))
      )
      .execute()
    const matches = await nodeAccounts(f.h.db, actor(105), 'Aaron')
    expect(matches).length(55)
    expect(
      (await nodeAccounts(f.h.db, actor(105), 'Aaron', true)).map(
        row => row.userId
      )
    ).deep.equals([1054])
    const all = await f.h.request(
      'GET',
      '/users?view=administration&nodeAdmin=true',
      undefined,
      105
    )
    const rows = (await all.json()) as Array<{ isNodeAdmin: boolean }>
    expect(rows.length).greaterThan(0)
    expect(rows.every(row => row.isNodeAdmin)).equals(true)
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'fixture/avatar' })
      .where('id', '=', 105)
      .execute()
    const pictured = await f.h.request(
      'GET',
      '/users?view=administration&nodeAdmin=true',
      undefined,
      105
    )
    const pictures = (await pictured.json()) as Array<{
      userId: number
      avatarUrl: string | null
    }>
    expect(pictures.find(row => row.userId === 105)!.avatarUrl).includes(
      'fixture/avatar'
    )
    const byEmail = await nodeAccounts(f.h.db, actor(105), 'fixture106@')
    expect(byEmail.map(row => row.userId)).deep.equals([106])
    expect(await nodeAccounts(f.h.db, actor(105), '%')).length(0)
    for (const value of ['yes', 'true&nodeAdmin=false'])
      expect(
        (
          await f.h.request(
            'GET',
            `/users?view=administration&nodeAdmin=${value}`,
            undefined,
            105
          )
        ).status
      ).equals(400)
    expect(
      (
        await f.h.request(
          'GET',
          '/users?view=administration&nodeAdmin=false',
          undefined,
          105
        )
      ).status
    ).equals(200)
    for (const value of ['true', 'false', 'yes']) {
      const missingView = await f.h.request(
        'GET',
        `/users?guardedBy=me&nodeAdmin=${value}`,
        undefined,
        105
      )
      expect(missingView.status).equals(400)
      expect(await missingView.text()).includes(
        'nodeAdmin requires view=administration'
      )
    }
    expect(
      (await f.h.request('GET', '/users?guardedBy=me', undefined, 105)).status
    ).equals(200)
  })
  it('requires a signed-in node administrator for account lookup and every global role or suspension change', async () => {
    for (const user of [101, 106, null])
      expect(
        (
          await f.h.request(
            'GET',
            '/users?view=administration',
            undefined,
            user
          )
        ).status
      ).equals(user == null ? 401 : 403)
    expect(
      (
        await f.h.request(
          'GET',
          '/users?view=administration&query=fixture106%40example.com',
          undefined,
          105
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/105/administration',
          { isNodeAdmin: false },
          101
        )
      ).status
    ).equals(403)
    expect(
      (await f.h.request('PATCH', '/users/bad/administration', {}, 105)).status
    ).equals(400)
    expect(
      (await f.h.request('PATCH', '/users/106/administration', {}, 105)).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/999/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(404)
  })
  it('protects the final active node administrator against removal and suspension', async () => {
    for (const change of [{ isNodeAdmin: false }, { suspended: true }]) {
      const response = await f.h.request(
        'PATCH',
        '/users/105/administration',
        change,
        105
      )
      expect(response.status).equals(409)
    }
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', 105)
          .executeTakeFirstOrThrow()
      ).is_admin
    ).equals(true)
  })
  it('revalidates node privilege instead of trusting an old actor or socket snapshot', async () => {
    await changeNodeAccount(f.h.db, actor(105), 106, { isNodeAdmin: true })
    expect((await roleScopes(f.h.db, 106, false)).isAdmin).equals(true)
    await changeNodeAccount(f.h.db, actor(105), 106, { isNodeAdmin: false })
    expect((await roleScopes(f.h.db, 106, true)).isAdmin).equals(false)
    expect((await visibleScopes(f.h.db, 106, true)).isAdmin).equals(false)
  })
  it('suspends and reactivates an ordinary account while preserving identity and revoking every session and machine token', async () => {
    const token = 'fixture-node-machine-token'
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: 106,
        token_hash: hashToken(token),
        label: 'fixture',
        scopes: []
      })
      .execute()
    const before = await f.h.db
      .selectFrom('users')
      .select('legacyId')
      .where('id', '=', 106)
      .executeTakeFirstOrThrow()
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/106/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, token)).status
    ).equals(401)
    expect((await roleScopes(f.h.db, 106, true)).isAdmin).equals(false)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/106/administration',
          { suspended: false },
          105
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('legacyId')
          .where('id', '=', 106)
          .executeTakeFirstOrThrow()
      ).legacyId
    ).equals(before.legacyId)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
  })
  it('refuses suspension of the sole direct group administrator even if a parent or node administrator remains', async () => {
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/101/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(409)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('disabled_at')
          .where('id', '=', 101)
          .executeTakeFirstOrThrow()
      ).disabled_at
    ).equals(null)
  })
  it('serializes simultaneous node-role removals and retains at least one active node administrator', async () => {
    await changeNodeAccount(f.h.db, actor(105), 106, { isNodeAdmin: true })
    const results = await Promise.allSettled([
      changeNodeAccount(f.h.db, actor(105), 105, { isNodeAdmin: false }),
      changeNodeAccount(f.h.db, actor(106), 106, { isNodeAdmin: false })
    ])
    expect(results.filter(r => r.status === 'fulfilled')).length(1)
    expect(
      await f.h.db
        .selectFrom('users')
        .select('id')
        .where('is_admin', '=', true)
        .where('disabled_at', 'is', null)
        .execute()
    ).length(1)
  })
})
