import { expect } from 'chai'
import type { Request } from 'express'
import { describe, it } from 'mocha'

import { TESS_HEADER } from '../middleware/withAuth'
import {
  MAX_CONCURRENT_READS,
  MAX_READS,
  readerHeaders,
  RestError,
  type RestReader,
  restReader
} from './restReader'

const ORIGIN = 'http://127.0.0.1:9100'

/** A fetch that answers from `routes` and remembers what it was asked. */
function fakeFetch(
  routes: Record<string, () => Response | Promise<Response>>
): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fake = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input))
    const key = `${url.pathname}${url.search}`
    asked.push(key)
    const answer = routes[key]
    if (answer == null) return new Response('', { status: 404 })
    return await answer()
  }
  return { fetch: fake, asked }
}

const failure = async (pending: Promise<unknown>): Promise<RestError> => {
  try {
    await pending
  } catch (error) {
    expect(error).instanceOf(RestError)
    return error as RestError
  }
  return expect.fail('The read succeeded')
}

describe('the REST reader behind GraphQL', function () {
  it('reads each path once, with its query', async function () {
    const { fetch, asked } = fakeFetch({
      '/api/v1/teams?season=s1': () => Response.json([{ id: 't1' }]),
      '/api/v1/empty': () => new Response('', { status: 200 })
    })
    const reader = restReader(ORIGIN, {}, { fetch })
    expect(
      await reader.get('/teams', { season: 's1', kind: undefined })
    ).deep.equals([{ id: 't1' }])
    await reader.get('/teams', { season: 's1' })
    expect(await reader.get('/empty')).equals(null)
    expect(asked).deep.equals(['/api/v1/teams?season=s1', '/api/v1/empty'])
  })

  it('follows one redirect on this API, and no other', async function () {
    const moved = (location: string) => () =>
      new Response(null, { status: 303, headers: { location } })
    const { fetch } = fakeFetch({
      '/api/v1/players/old': moved('/api/v1/players/new'),
      '/api/v1/players/new': () => Response.json({ userId: 'new' }),
      '/api/v1/players/away': moved('https://elsewhere.example.test/x'),
      '/api/v1/players/page': moved('/players/new'),
      '/api/v1/players/twice': moved('/api/v1/players/old'),
      '/api/v1/players/nowhere': () => new Response(null, { status: 302 })
    })
    const reader = restReader(ORIGIN, {}, { fetch })
    expect(await reader.get('/players/old')).deep.equals({ userId: 'new' })
    for (const path of [
      '/players/away',
      '/players/page',
      '/players/twice',
      '/players/nowhere'
    ])
      expect((await failure(reader.get(path))).message, path).equals(
        'That read was redirected'
      )
  })

  it('carries the route’s refusal, and says when the server did not answer', async function () {
    const { fetch } = fakeFetch({
      '/api/v1/refused': () =>
        Response.json(
          { code: 'forbidden', message: 'Not yours' },
          { status: 403 }
        ),
      '/api/v1/broken': () => new Response('<html>', { status: 500 }),
      '/api/v1/down': () => {
        throw new Error('connection refused')
      }
    })
    const reader = restReader(ORIGIN, {}, { fetch })
    const refused = await failure(reader.get('/refused'))
    expect([refused.status, refused.message]).deep.equals([403, 'Not yours'])
    const broken = await failure(reader.get('/broken'))
    expect([broken.status, broken.message]).deep.equals([500, 'HTTP 500'])
    const down = await failure(reader.get('/down'))
    expect(down.status).equals(502)
  })

  it(`stops a query at ${MAX_READS} reads`, async function () {
    const reader = restReader(
      ORIGIN,
      {},
      {
        fetch: async () => Response.json({})
      }
    )
    for (let i = 0; i < MAX_READS; i++) await reader.get(`/players/${i}`)
    const over = await failure(reader.get('/players/one-more'))
    expect(over.message).includes('Ask for less')
    // A path already read is still answered.
    expect(await reader.get('/players/0')).deep.equals({})
  })

  it(`has at most ${MAX_CONCURRENT_READS} reads in flight at once`, async function () {
    let inFlight = 0
    let most = 0
    const reader = restReader(
      ORIGIN,
      {},
      {
        fetch: async () => {
          inFlight++
          most = Math.max(most, inFlight)
          await new Promise(resolve => setTimeout(resolve, 5))
          inFlight--
          return Response.json({})
        }
      }
    )
    await Promise.all(
      Array.from({ length: 30 }, async (_, i) => await reader.get(`/p/${i}`))
    )
    expect(most).equals(MAX_CONCURRENT_READS)
  })

  it('gives up on a body that never ends, at the deadline', async function () {
    const reader = restReader(
      ORIGIN,
      {},
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"teams":'))
              }
            }),
            { status: 200 }
          ),
        deadlineMs: 50
      }
    )
    const started = Date.now()
    const late = await failure(reader.get('/teams'))
    expect(late.status).equals(504)
    expect(Date.now() - started).lessThan(1000)
  })

  it('keeps the pool full and never over, however reads start', async function () {
    let inFlight = 0
    let most = 0
    const started: Array<Promise<unknown>> = []
    const reader: RestReader = restReader(
      ORIGIN,
      {},
      {
        fetch: async (input: unknown) => {
          inFlight++
          most = Math.max(most, inFlight)
          await new Promise(resolve => setTimeout(resolve, 2))
          inFlight--
          // Each first-round read starts another as it finishes, racing the
          // reads already waiting for a slot.
          const path = new URL(String(input)).pathname
          if (path.startsWith('/api/v1/a/'))
            started.push(
              reader.get(path.replace('/a/', '/b/').replace('/api/v1', ''))
            )
          return Response.json({})
        }
      }
    )
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => await reader.get(`/a/${i}`))
    )
    await Promise.all(started)
    expect(started).to.have.length(20)
    expect(most).equals(MAX_CONCURRENT_READS)
  })

  it('ends every read of a query once its signal is aborted', async function () {
    const query = new AbortController()
    const asked: string[] = []
    const reader = restReader(
      ORIGIN,
      {},
      {
        fetch: async (input: unknown) => {
          asked.push(new URL(String(input)).pathname)
          // The first read stalls; the query is abandoned while it does.
          await new Promise(resolve => setTimeout(resolve, 10_000))
          return Response.json({})
        },
        signal: query.signal
      }
    )
    const reads = Array.from(
      { length: MAX_CONCURRENT_READS + 4 },
      async (_, i) => await failure(reader.get(`/p/${i}`))
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    query.abort()
    const ended = await Promise.all(reads)
    expect(ended.every(error => error.status === 504)).equals(true)
    // The reads that were waiting were never sent.
    expect(asked).to.have.length(MAX_CONCURRENT_READS)
  })

  it('sends the caller’s credentials, and Tess’s mark only when she sent it', function () {
    const request = (headers: Record<string, string>, ip?: string): Request =>
      ({
        ip,
        header: (name: string) => headers[name.toLowerCase()]
      }) as unknown as Request
    expect(
      readerHeaders(request({ authorization: 'Bearer tok_1' }, '203.0.113.9'))
    ).deep.equals({
      accept: 'application/json',
      authorization: 'Bearer tok_1',
      'x-forwarded-for': '203.0.113.9'
    })
    expect(
      readerHeaders(
        request({ cookie: 'other=1; ts_session=abc', [TESS_HEADER]: '1' })
      )
    ).deep.equals({
      accept: 'application/json',
      cookie: 'ts_session=abc',
      [TESS_HEADER]: '1'
    })
  })
})
