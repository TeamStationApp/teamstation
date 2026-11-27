import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  ask,
  endLiveStream,
  liveCamera,
  pause,
  sessionOnBrowser,
  until
} from './liveCamera'

const API = 'https://stack.example.test/api/v1'

function fakeFetch(answers: Array<{ status: number; body: string }>): {
  fetchFn: typeof fetch
  calls: Array<{ url: string; init: any }>
} {
  const calls: Array<{ url: string; init: any }> = []
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, init })
    const next = answers.shift()!
    return new Response(next.body === '' ? null : next.body, {
      status: next.status
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

describe('a live camera on the stack', function () {
  it('asks the API with the bearer token and reads its answer', async function () {
    const { fetchFn, calls } = fakeFetch([
      { status: 200, body: '{"a":1}' },
      { status: 204, body: '' }
    ])
    expect(await ask(API, 't', '/x', {}, fetchFn)).deep.equals({
      status: 200,
      json: { a: 1 }
    })
    expect(calls[0].url).equals(`${API}/x`)
    expect(calls[0].init.headers.authorization).equals('Bearer t')
    expect((await ask(API, 't', '/y', {}, fetchFn)).json).equals(null)
  })

  it('makes a camera, refuses one the API did not make, and ends it', async function () {
    const { fetchFn, calls } = fakeFetch([
      {
        status: 201,
        body: '{"id":"s1","videoId":"v1","url":"rtmp://h:1936/live/k"}'
      },
      { status: 403, body: '{}' },
      { status: 200, body: '{}' }
    ])
    expect(await liveCamera(API, 't', 'g1', 'Tail', fetchFn)).deep.equals({
      streamId: 's1',
      videoId: 'v1',
      url: 'rtmp://h:1936/live/k'
    })
    expect(calls[0].init.method).equals('POST')
    expect(JSON.parse(calls[0].init.body)).deep.equals({ label: 'Tail' })
    let refused = ''
    try {
      await liveCamera(API, 't', 'g1', 'Tail', fetchFn)
    } catch (error) {
      refused = String(error)
    }
    expect(refused).contains('403')
    expect(
      await endLiveStream(API, 't', 'g1', { streamId: 's1' }, fetchFn)
    ).equals(200)
    expect(calls[2].url).equals(`${API}/games/g1/live-streams/s1/end`)
  })

  it('puts the session cookie on the browser for the stack’s host', async function () {
    const steps: unknown[] = []
    await sessionOnBrowser(
      {
        setCookies: async options => steps.push(options)
      },
      'https://e2e-06.example.test',
      'a b'
    )
    expect(steps[0]).deep.equals({
      cookies: [
        {
          name: 'ts_session',
          value: 'a%20b',
          domain: 'e2e-06.example.test',
          path: '/'
        }
      ]
    })
  })

  it('waits for a check, and names what never came', async function () {
    let n = 0
    await until('three', () => ++n >= 3, 1000, 1)
    expect(n).equals(3)
    let failed = ''
    try {
      await until('never', () => false, 5, 1)
    } catch (error) {
      failed = String(error)
    }
    expect(failed).contains('never')
    await pause(-5)
  })
})
