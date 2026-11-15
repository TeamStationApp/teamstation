import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ownerApi } from './ownerApi'

function recorder(status: number): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  return {
    calls,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status })
    }) as typeof fetch
  }
}

describe('the owner API', function () {
  it("ends a camera on the game's end route with the owner's token", async function () {
    const r = recorder(200)
    await ownerApi({
      api: 'https://streamtest.example.test/api/v1/',
      token: 'tok',
      fetch: r.fetch
    }).endCamera('gam_1', 'liv_a/b')
    expect(r.calls).length(1)
    expect(r.calls[0].url).equals(
      'https://streamtest.example.test/api/v1/games/gam_1/live-streams/liv_a%2Fb/end'
    )
    expect(r.calls[0].init?.method).equals('POST')
    expect(r.calls[0].init?.headers).deep.equals({
      authorization: 'Bearer tok'
    })
  })

  it('says which camera the stack would not end, and its status', async function () {
    const r = recorder(404)
    const message = await ownerApi({
      api: 'https://streamtest.example.test/api/v1',
      token: 'tok',
      fetch: r.fetch
    })
      .endCamera('gam_1', 'liv_x')
      .then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    expect(message).equals('the stack would not end camera liv_x: 404')
    expect(message).not.contains('tok')
  })
})
