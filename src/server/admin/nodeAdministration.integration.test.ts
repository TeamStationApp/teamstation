import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
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
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 55 }, (_, i) => ({
        id: 1000 + i,
        legacyId: `usr_node_search_${i}`,
        display_name: `Aaron ${i}`,
        login_enabled: true,
        is_admin: i === 54
      }))
    )
    const matches = await nodeAccounts(f.h.db, actor(105), 'Aaron')
    expect(matches).length(55)
    // No label for a tile: its colour is the account id's.
    expect(
      matches.find(row => row.userId === userIdOfGumbo(1003))
    ).not.have.property('publicName')
    expect(
      (await nodeAccounts(f.h.db, actor(105), 'Aaron', true)).map(
        row => row.userId
      )
    ).deep.equals([1054].map(userIdOfGumbo))
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
      .where('id', '=', userIdOfGumbo(105))
      .execute()
    const pictured = await f.h.request(
      'GET',
      '/users?view=administration&nodeAdmin=true',
      undefined,
      105
    )
    const pictures = (await pictured.json()) as Array<{
      userId: string
      avatarUrl: string | null
    }>
    expect(
      pictures.find(row => row.userId === userIdOfGumbo(105))!.avatarUrl
    ).includes('fixture/avatar')
    const byEmail = await nodeAccounts(f.h.db, actor(105), 'fixture106@')
    expect(byEmail.map(row => row.userId)).deep.equals([106].map(userIdOfGumbo))
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
          '/users/usr_111111111111111111112p/administration',
          { isNodeAdmin: false },
          101
        )
      ).status
    ).equals(403)
    expect(
      (await f.h.request('PATCH', '/users/bad/administration', {}, 105)).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/usr_111111111111111111112q/administration',
          {},
          105
        )
      ).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/usr_11111111111111111111JE/administration',
          { suspended: true },
          105
        )
      ).status
    ).equals(404)
  })
  it('lets only a node administrator set or clear the Jev key, and never says or logs it', async () => {
    const key = 'ts-test-key-never-shown'
    const written: string[] = []
    const keep =
      (write: (...args: any[]) => boolean) =>
      (chunk: unknown, ...rest: any[]): boolean => {
        written.push(String(chunk))
        return write(chunk, ...rest)
      }
    const stdout = process.stdout.write.bind(process.stdout)
    const stderr = process.stderr.write.bind(process.stderr)
    const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const consoles = consoleMethods.map(name => console[name].bind(console))
    process.stdout.write = keep(stdout) as typeof process.stdout.write
    process.stderr.write = keep(stderr) as typeof process.stderr.write
    for (const name of consoleMethods)
      console[name] = (...args: unknown[]) => {
        written.push(args.map(String).join(' '))
      }
    const answers: string[] = []
    try {
      for (const user of [101, 106, null]) {
        for (const [method, body] of [
          ['PUT', { apiKey: key }],
          // A body that does not read is refused for who sent it first.
          ['PUT', { apiKey: 42 }],
          ['PUT', undefined],
          ['DELETE', undefined]
        ] as const) {
          const response = await f.h.request(
            method,
            '/node/jev-key',
            body,
            user
          )
          expect(response.status, `${method} as ${user}`).equals(
            user == null ? 401 : 403
          )
          answers.push(await response.text())
        }
      }
      expect(
        await f.h.db
          .selectFrom('system_settings')
          .select('key')
          .where('key', '=', 'jev.apiKey')
          .executeTakeFirst()
      ).equals(undefined)

      const set = await f.h.request(
        'PUT',
        '/node/jev-key',
        { apiKey: key },
        105
      )
      expect(set.status).equals(200)
      answers.push(await set.text())
      const read = await f.h.request('GET', '/node/settings', undefined, 105)
      expect(read.status).equals(200)
      const readText = await read.text()
      answers.push(readText)
      expect(JSON.parse(readText).jev).deep.equals({ configured: true })
      // The settings are no node administrator's but 105's to read.
      const refused = await f.h.request('GET', '/node/settings', undefined, 101)
      expect(refused.status).equals(403)
      answers.push(await refused.text())
      const cleared = await f.h.request(
        'DELETE',
        '/node/jev-key',
        undefined,
        105
      )
      expect(cleared.status).equals(200)
      answers.push(await cleared.text())
    } finally {
      process.stdout.write = stdout
      process.stderr.write = stderr
      consoleMethods.forEach((name, at) => {
        console[name] = consoles[at]
      })
    }
    for (const answer of answers) expect(answer).not.contains(key)
    expect(written.join('\n')).not.contains(key)
  })
  it('protects the final active node administrator against removal and suspension', async () => {
    for (const change of [{ isNodeAdmin: false }, { suspended: true }]) {
      const response = await f.h.request(
        'PATCH',
        '/users/usr_111111111111111111112p/administration',
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
          .where('id', '=', userIdOfGumbo(105))
          .executeTakeFirstOrThrow()
      ).is_admin
    ).equals(true)
  })
  it('revalidates node privilege instead of trusting an old actor or socket snapshot', async () => {
    await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
      isNodeAdmin: true
    })
    expect(
      (await roleScopes(f.h.db, userIdOfGumbo(106), false)).isAdmin
    ).equals(true)
    await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
      isNodeAdmin: false
    })
    expect((await roleScopes(f.h.db, userIdOfGumbo(106), true)).isAdmin).equals(
      false
    )
    expect(
      (await visibleScopes(f.h.db, userIdOfGumbo(106), true)).isAdmin
    ).equals(false)
  })
  it('suspends and reactivates an ordinary account while preserving identity and revoking every session and machine token', async () => {
    const token = 'fixture-node-machine-token'
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(106),
        token_hash: hashToken(token),
        label: 'fixture',
        scopes: []
      })
      .execute()
    const before = await f.h.db
      .selectFrom('users')
      .select('legacyId')
      .where('id', '=', userIdOfGumbo(106))
      .executeTakeFirstOrThrow()
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/usr_111111111111111111112q/administration',
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
    expect((await roleScopes(f.h.db, userIdOfGumbo(106), true)).isAdmin).equals(
      false
    )
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/usr_111111111111111111112q/administration',
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
          .where('id', '=', userIdOfGumbo(106))
          .executeTakeFirstOrThrow()
      ).legacyId
    ).equals(before.legacyId)
    expect(
      (await f.h.request('GET', '/me/groups', undefined, 106)).status
    ).equals(401)
  })
  it('refuses suspension of a group administrator no other active administrator covers, directly or through a parent; node administrator status does not count', async () => {
    expect(
      (
        await f.h.request(
          'PATCH',
          '/users/usr_111111111111111111112k/administration',
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
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).disabled_at
    ).equals(null)
  })
  it('serializes simultaneous node-role removals and retains at least one active node administrator', async () => {
    await changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(106), {
      isNodeAdmin: true
    })
    const results = await Promise.allSettled([
      changeNodeAccount(f.h.db, actor(105), userIdOfGumbo(105), {
        isNodeAdmin: false
      }),
      changeNodeAccount(f.h.db, actor(106), userIdOfGumbo(106), {
        isNodeAdmin: false
      })
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
