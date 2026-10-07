import { expect } from 'chai'
import { describe, it } from 'mocha'

import { approvalClient } from './approvalClient'

describe('browser OAuth approval transport', () => {
  it('binds approval to a same-origin interaction and CSRF token', async () => {
    const requests: RequestInit[] = []
    const responses = [
      { clientName: 'Example', scopes: ['openid'], csrfToken: 'proof' },
      { redirectTo: '/oauth/auth/resume' },
      { appUrl: `teamstation:///oauth/native-approval/${'a'.repeat(43)}` },
      { pending: true },
      { redirectTo: '/oauth/auth/resume' }
    ]
    const transport = approvalClient('fixture', async (_url, init) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify(responses.shift()))
    })
    expect((await transport.details()).clientName).equals('Example')
    expect(await transport.decide(true)).equals(
      `${window.location.origin}/oauth/auth/resume`
    )
    expect(await transport.native()).includes('native-approval')
    expect(await transport.resume()).equals(undefined)
    expect(await transport.resume()).includes('/oauth/auth/resume')
    expect(requests[1].credentials).equals('same-origin')
    expect(new Headers(requests[1].headers).get('x-oauth-csrf')).equals('proof')
    expect(requests[1].body).equals('{"approve":true}')
  })
  it('rejects expired requests and unsafe redirects or app links', async () => {
    expect(() => approvalClient('../elsewhere')).throws()
    for (const body of [
      { redirectTo: 'https://evil.example.test/oauth/auth' },
      { redirectTo: '/not-oauth' }
    ]) {
      const transport = approvalClient(
        'fixture',
        async () => new Response(JSON.stringify(body))
      )
      await reject(transport.decide(true))
    }
    await reject(
      approvalClient(
        'fixture',
        async () => new Response('{}', { status: 400 })
      ).details()
    )
    await reject(
      approvalClient(
        'fixture',
        async () => new Response('{"appUrl":"https://evil.example.test"}')
      ).native()
    )
    const noCsrf = approvalClient(
      'fixture',
      async () => new Response('{"clientName":"Example","scopes":[]}')
    )
    expect((await noCsrf.details()).csrfToken).equals(undefined)
  })
})

async function reject(promise: Promise<unknown>): Promise<void> {
  let rejected = false
  try {
    await promise
  } catch {
    rejected = true
  }
  expect(rejected).equals(true)
}
