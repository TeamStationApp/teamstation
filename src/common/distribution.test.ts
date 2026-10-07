import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import { asHttpsUrl, readBuildInfo } from './distribution'

describe('distribution metadata and client', () => {
  it('only accepts credential-free HTTPS links and validated metadata', () => {
    expect(asHttpsUrl('https://builds.example.test/')).equals(
      'https://builds.example.test/'
    )
    for (const value of [
      'http://example.test',
      'javascript:alert(1)',
      'https://user:secret@example.test',
      false
    ])
      expect(() => asHttpsUrl(value)).throws()
    expect(readBuildInfo(undefined).version).equals('development')
    expect(() => readBuildInfo('{"app":false}')).throws()
    expect(
      readBuildInfo(
        JSON.stringify({
          app: 'Example',
          version: '1.2',
          buildNumber: '17',
          branch: 'feature/one',
          commit: 'abc',
          builtAt: 'today',
          secret: 'discard'
        })
      )
    ).not.has.property('secret')
  })
  it('reads optional links and sends native decisions using the human session', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const replies = [
      { url: 'https://builds.example.test' },
      {},
      { clientName: 'Builds', scopes: ['openid'] },
      { approved: true }
    ]
    const client = new TeamStationClient({
      baseUrl: 'https://app.example.test/api/v1',
      token: 'fixture',
      fetch: async (url, init) => {
        requests.push({
          url:
            typeof url === 'string'
              ? url
              : url instanceof URL
                ? url.href
                : url.url,
          init
        })
        return new Response(JSON.stringify(replies.shift()))
      }
    })
    expect(await client.buildsLink()).equals('https://builds.example.test')
    expect(await client.buildsLink()).equals(undefined)
    expect((await client.oauthApproval('abc/def')).clientName).equals('Builds')
    await client.decideOAuth('handle', true)
    expect(requests[2].url.endsWith('/oauth/approvals/abc%2Fdef')).equals(true)
    expect(requests[3].init?.body).equals('{"approve":true}')
    expect(new Headers(requests[3].init?.headers).get('authorization')).equals(
      'Bearer fixture'
    )
  })
})
