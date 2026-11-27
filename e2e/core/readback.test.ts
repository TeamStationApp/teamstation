import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../src/common/scoring/teamRecord'
import { readJson } from './readback'

describe('readJson', () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
  })

  /** Answers `status` with `{ ok: true }`, keeping what each request sent. */
  function answering(status: number): Array<{ url: string; headers: Headers }> {
    const seen: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) })
      return new Response(JSON.stringify({ ok: true }), { status })
    }) as typeof fetch
    return seen
  }

  it("reads as this checkout's app, naming the scoring records it reads", async function () {
    const seen = answering(200)
    expect(
      await readJson('https://stack.example.test', '/api/v1/games/g1/events', {
        headers: { authorization: 'Bearer t' }
      })
    ).deep.equals({ ok: true })
    expect(seen[0].url).equals(
      'https://stack.example.test/api/v1/games/g1/events'
    )
    expect(seen[0].headers.get(SCORING_FEATURE_HEADER)).equals(SCORING_FEATURES)
    expect(seen[0].headers.get('authorization')).equals('Bearer t')
  })

  it('keeps a feature list the caller names, and fails on a refusal', async function () {
    const seen = answering(409)
    let failed: unknown
    try {
      await readJson('https://stack.example.test', '/x', {
        headers: { [SCORING_FEATURE_HEADER]: 'old' }
      })
    } catch (error) {
      failed = error
    }
    expect(String(failed)).includes('answered 409, not the stored state')
    expect(seen[0].headers.get(SCORING_FEATURE_HEADER)).equals('old')
  })
})
