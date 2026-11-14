import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'

interface Call {
  url: string
  method?: string
  body?: Record<string, unknown>
}

/** A client whose every request is written down and answered with `answer`. */
function recording(
  answer: (call: Call) => unknown,
  deviceModel?: string
): { client: TeamStationClient; calls: Call[] } {
  const calls: Call[] = []
  const client = new TeamStationClient({
    baseUrl: 'https://api.example.test/api/v1',
    token: 'tok',
    deviceModel,
    fetch: async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url).replace('https://api.example.test/api/v1', ''),
        method: init?.method,
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined
      }
      calls.push(call)
      return Response.json(answer(call))
    }
  })
  return { client, calls }
}

const session = {
  token: 'tok2',
  expiresAt: '2027-01-01T00:00:00.000Z',
  user: {
    id: 'usr_1111111111111111111112',
    displayName: 'Babe Ruth',
    isAdmin: false
  }
}
const row = {
  id: 'ses_1',
  at: '2026-11-01T12:00:00.000Z',
  userId: 'usr_1111111111111111111112',
  displayName: 'Babe Ruth',
  email: null,
  avatarUrl: null,
  lastActiveAt: null,
  device: 'iPhone',
  appType: 'iOS'
}
const account = {
  user: {
    id: 'usr_1111111111111111111113',
    displayName: 'Lou Gehrig',
    isAdmin: false,
    avatarUrl: null
  },
  hasPassword: false,
  passwordParameters: null,
  emails: []
}

describe('the client: user management', function () {
  it('reads logins and sessions a page at a time, with their cursor', async function () {
    const { client, calls } = recording(call => ({
      items: [row],
      nextCursor: 'next+/',
      prevCursor: null,
      anchorId: null,
      counts: null,
      ...(call.url.startsWith('/node/sessions')
        ? { recordedSince: '2026-11-01T00:00:00.000Z' }
        : {})
    }))
    const logins = await client.recentLogins()
    expect(logins.items[0].device).equals('iPhone')
    expect(logins.recordedSince).equals(undefined)
    await client.recentLogins('next+/')
    const sessions = await client.recentSessions(null)
    expect(sessions.recordedSince).equals('2026-11-01T00:00:00.000Z')
    await client.recentSessions('a b')
    expect(calls.map(call => call.url)).deep.equals([
      '/node/logins',
      '/node/logins?cursor=next%2B%2F',
      '/node/sessions',
      '/node/sessions?cursor=a%20b'
    ])
  })

  it('refuses a row whose app it does not know', async function () {
    const { client } = recording(() => ({
      items: [{ ...row, appType: 'Symbian' }],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null
    }))
    let refused = false
    await client.recentLogins().catch(() => {
      refused = true
    })
    expect(refused).equals(true)
  })

  it('searches the directory and opens a person', async function () {
    const { client, calls } = recording(call =>
      call.url.startsWith('/users?')
        ? [
            {
              userId: row.userId,
              displayName: 'Babe Ruth',
              avatarUrl: null,
              email: 'ruth@example.com',
              affiliations: 'Demo Hawks'
            }
          ]
        : {
            userId: row.userId,
            displayName: 'Babe Ruth',
            avatarUrl: null,
            emails: [
              { email: 'ruth@example.com', isPrimary: true, isVerified: true }
            ],
            lastActiveAt: null,
            affiliations: [
              {
                kind: 'team',
                id: 'tem_1',
                name: 'Demo Hawks',
                roles: ['head coach', 'following']
              }
            ]
          }
    )
    expect((await client.directory('ruth & co'))[0].email).equals(
      'ruth@example.com'
    )
    const person = await client.personAdministration(row.userId)
    expect(person.affiliations[0].roles).deep.equals([
      'head coach',
      'following'
    ])
    expect(calls.map(call => call.url)).deep.equals([
      '/users?view=directory&q=ruth%20%26%20co',
      `/users/${row.userId}/administration`
    ])
  })

  it('changes another person’s name and photo through their own account path', async function () {
    const { client, calls } = recording(call =>
      call.url.endsWith('catalog-picture') ? { ok: true } : account
    )
    const theirs = client.accountOf(account.user.id)
    expect((await theirs.accountSettings()).user.displayName).equals(
      'Lou Gehrig'
    )
    await theirs.setAccountName('Henry Gehrig')
    await theirs.setAccountPhoto({ contentType: 'image/png', base64: 'AA==' })
    await theirs.clearAccountPhoto()
    await theirs.chooseCatalogPicture('cat_1')
    const base = `/users/${account.user.id}/account`
    expect(calls.map(call => [call.method, call.url, call.body])).deep.equals([
      ['GET', base, undefined],
      ['PUT', `${base}/name`, { displayName: 'Henry Gehrig' }],
      [
        'PUT',
        `${base}/photo`,
        { image: { contentType: 'image/png', base64: 'AA==' } }
      ],
      ['DELETE', `${base}/photo`, undefined],
      ['PUT', `${base}/catalog-picture`, { catalogId: 'cat_1' }]
    ])
  })

  it('sends the device model with every sign-in, and only when it has one', async function () {
    const answer = (): unknown => session
    for (const deviceModel of ['iPhone', undefined]) {
      const { client, calls } = recording(answer, deviceModel)
      await client.signInWithCode('ruth@example.com', '123456')
      await client.signInWithLink('link-token')
      await client.claimSignIn({ requestId: 'req_1', clientSecret: 'secret' })
      for (const call of calls)
        if (deviceModel == null)
          expect(call.body).not.to.have.property('deviceModel')
        else expect(call.body?.deviceModel).equals('iPhone')
      expect(calls.map(call => call.url)).deep.equals([
        '/auth/email-code/verify',
        '/auth/link/verify',
        '/auth/request/claim'
      ])
    }
  })
})
