import { expect } from 'chai'
import { describe, it } from 'mocha'

import { GameStationClient } from './api'
import { HttpError } from './errors'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** A stand-in for `fetch` that records what it was asked and answers to order. */
function stubFetch(
  status: number,
  body: unknown,
  calls: Call[] = []
): { fetch: typeof fetch; calls: Call[] } {
  const fake = async (
    url: unknown,
    init?: { method?: string; headers?: unknown; body?: string }
  ): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body
    })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // A real Response rather than a stand-in, so `ok` and `text()` behave as
    // they will in the app instead of as this test imagines they might.
    return new Response(text, { status })
  }
  return { fetch: fake as unknown as typeof fetch, calls }
}

describe('api client', function () {
  it('cleans a team list', async function () {
    const { fetch } = stubFetch(200, [
      { id: 'tem_1', name: 'Bandits', shortName: null, logoPath: null }
    ])
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const teams = await client.teams()
    expect(teams.length).equals(1)
    expect(teams[0].name).equals('Bandits')
    expect(teams[0].shortName).equals(null)
  })

  it('refuses a response of the wrong shape rather than passing it on', async function () {
    const { fetch } = stubFetch(200, [{ id: 'tem_1' }])
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    let threw = false
    try {
      await client.teams()
    } catch {
      threw = true
    }
    expect(threw).equals(true)
  })

  it('turns an error body back into the same error the server threw', async function () {
    const { fetch } = stubFetch(404, { code: 'notFound', message: 'Not found' })
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    try {
      await client.game('gam_missing')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).is.instanceOf(HttpError)
      expect((error as HttpError).code).equals('notFound')
      expect((error as HttpError).status).equals(404)
    }
  })

  it('does not choke on an error body that is not our shape', async function () {
    const { fetch } = stubFetch(502, '<html>gateway</html>')
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    try {
      await client.teams()
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as HttpError).code).equals('internal')
    }
  })

  it('carries the token once signed in, and drops it on sign-out', async function () {
    const session = {
      token: 'tok_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { id: 'usr_1', displayName: 'Robin', isAdmin: false }
    }
    const { fetch, calls } = stubFetch(200, session)
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.signInWithPassword('a@b.c', 'hunter2')
    expect(client.token).equals('tok_abc')

    await client.teams().catch(() => undefined)
    const last = calls[calls.length - 1]
    expect(last.headers.authorization).equals('Bearer tok_abc')
  })

  it('sends a JSON body only when there is one', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.teams()
    expect(calls[0].body).equals(undefined)
    expect(calls[0].headers['content-type']).equals(undefined)
  })

  it('escapes an id rather than pasting it into the path', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.teamGames('a/b?c')
    expect(calls[0].url).equals('http://x/api/v1/teams/a%2Fb%3Fc/games')
  })

  it('trims a trailing slash off the base so paths do not double up', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new GameStationClient({ baseUrl: 'http://x/api/v1/', fetch })
    await client.teams()
    expect(calls[0].url).equals('http://x/api/v1/teams')
  })
})
