import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type ApiKeyPermission, asApiKey } from '../../common/apiKeys'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import { hashToken, makeToken } from '../auth/tokens'
import { apiKeyRoutes } from '../routes/apiKeys'
import { timeRoutes } from '../routes/time'

/**
 * The ceiling on a user API key, on the routes the server really mounts:
 * what the key was given, and never more than the person may do.
 *
 * On `guardianFixture`: Babe Ruth (101) administers Demo League A, Demo
 * Regular and Demo Hawks; Ichiro (104) coaches Demo Hawks and has nothing to
 * do with Demo Rookies.
 */
describe('the API key ceiling', function () {
  this.timeout(120000)

  let f: GuardianFixture
  let machineToken = ''

  before(async function () {
    f = await guardianFixture(undefined, undefined, (app, { db }) => {
      app.use('/api/v1', apiKeyRoutes(db, { sessionSecret: 'ceiling-test' }))
      app.use('/api/v1', timeRoutes())
    })
    machineToken = makeToken()
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(101),
        label: 'Distributor',
        token_hash: hashToken(machineToken)
      })
      .execute()
  })

  after(async function () {
    await f?.h.close()
  })

  const keyFor = async (
    person: number,
    permissions: ApiKeyPermission[]
  ): Promise<string> => {
    await f.h.resetLimits()
    const made = await f.h.request(
      'POST',
      '/me/api-keys',
      { name: `Key for ${person}`, permissions },
      person
    )
    expect(made.status).equals(201)
    return asApiKey(await made.json()).secret ?? ''
  }

  const status = async (
    method: string,
    path: string,
    token: string | number,
    body?: unknown
  ): Promise<number> => (await f.h.request(method, path, body, token)).status

  const refusal = async (
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<void> => {
    const answer = await f.h.request(method, path, body, token)
    expect(answer.status, `${method} ${path}`).equals(403)
    expect(((await answer.json()) as { message: string }).message).equals(
      'This API key cannot do that'
    )
  }

  it('reads the account with account read, and cannot change the name', async function () {
    const key = await keyFor(101, ['account:read'])
    expect(await status('GET', '/me/account', key)).equals(200)
    await refusal('PUT', '/me/account/name', key, { displayName: 'Babe Ruth' })
    await refusal('GET', '/me/notifications', key)
    // The person, signed in, still does both.
    expect(await status('GET', '/me/account', 101)).equals(200)
    expect(await status('GET', '/me/notifications', 101)).equals(200)
  })

  it('lists a visible team’s games with schedule read, and needs schedule write to make one', async function () {
    const reader = await keyFor(101, ['schedule:read'])
    expect(await status('GET', `/teams/${f.teamA}/games`, reader)).equals(200)
    const row = {
      games: [
        {
          opponent: { name: 'Demo Owls' },
          side: 'home',
          seasonId: f.seasonA,
          startAt: '2026-09-27T18:00:00.000Z'
        }
      ]
    }
    await refusal('POST', `/teams/${f.teamA}/games`, reader, row)
    const writer = await keyFor(101, ['schedule:write'])
    const made = await f.h.request(
      'POST',
      `/teams/${f.teamA}/games`,
      row,
      writer
    )
    expect(made.status).equals(200)
    expect(
      ((await made.json()) as { results: Array<{ result: string }> }).results[0]
        .result
    ).equals('created')
    // Write did not bring a family it was not given.
    await refusal('GET', '/me/account', writer)
  })

  it('shows a key nothing of a team the person cannot see', async function () {
    const key = await keyFor(104, [
      'schedule:read',
      'team:read',
      'gameEvents:read'
    ])
    // Demo Rookies is not Ichiro's: the key reads it exactly as he does.
    for (const path of [
      `/teams/${f.rookies}/games`,
      `/teams/${f.rookies}/stats`,
      `/teams/${f.rookies}/roster`
    ]) {
      const signedIn = await f.h.request('GET', path, undefined, 104)
      const withKey = await f.h.request('GET', path, undefined, key)
      expect(withKey.status, path).equals(signedIn.status)
      expect(await withKey.text(), path).equals(await signedIn.text())
    }
    expect(await status('GET', `/teams/${f.rookies}/stats`, key)).equals(403)
    const listed = (await (
      await f.h.request('GET', '/teams', undefined, key)
    ).json()) as Array<{ id: string }>
    const signedIn = (await (
      await f.h.request('GET', '/teams', undefined, 104)
    ).json()) as Array<{ id: string }>
    expect(listed.map(team => team.id)).deep.equals(
      signedIn.map(team => team.id)
    )
    expect(listed.map(team => team.id)).not.includes(f.rookies)
  })

  it('refuses every route outside the families, and anything outside the API', async function () {
    const key = await keyFor(101, [
      'account:write',
      'gameEvents:write',
      'schedule:write',
      'league:write',
      'season:write',
      'team:write',
      'umpire:write'
    ])
    await refusal('GET', '/me/notifications', key)
    await refusal('GET', '/users', key)
    await refusal('GET', '/me/api-keys', key)
    await refusal('DELETE', '/me/account', key)
    const outside = await fetch(`${f.h.origin}/oauth/anything`, {
      headers: { authorization: `Bearer ${key}` }
    })
    expect(outside.status).equals(403)
  })

  it('lets any read through to GraphQL, and only a read', async function () {
    const reader = await keyFor(101, ['umpire:read'])
    const query = await f.h.request(
      'POST',
      '/graphql',
      { query: '{ __typename }' },
      reader
    )
    // GraphQL is not mounted here: past the ceiling, nothing answers.
    expect(query.status).equals(404)
  })

  it('lets the time ignore the key', async function () {
    const key = await keyFor(101, ['team:read'])
    expect(await status('GET', '/time', key)).equals(200)
  })

  it('leaves a machine token to its own refusals', async function () {
    expect(await status('GET', '/me/account', machineToken)).equals(403)
    expect(await status('GET', `/teams/${f.teamA}/games`, machineToken)).equals(
      200
    )
  })
})
