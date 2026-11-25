import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('password links in a web build', () => {
  it('includes the handler only for explicit development provenance and a relative API', async () => {
    const { developmentPasswordLinks } =
      await import('../../../scripts/web-build-settings.mjs')
    const originalInfo = process.env.TS_BUILD_INFO
    const originalSeat = process.env.TS_SEAT_BRANCH
    try {
      for (const [branch, seat, api, enabled] of [
        [undefined, undefined, '/api/v1', false],
        ['master', 'master', '/api/v1', false],
        ['release', 'release', '/api/v1', false],
        ['develop', undefined, '/api/v1', true],
        ['develop', 'develop', '/api/v1', true],
        ['develop', 'master', '/api/v1', false],
        ['paul/example', 'paul/example', '/api/v1', true],
        ['paul/example', 'paul/other', '/api/v1', false],
        ['develop', undefined, 'https://example.test/api/v1', false]
      ] as const) {
        if (branch === undefined) delete process.env.TS_BUILD_INFO
        else process.env.TS_BUILD_INFO = JSON.stringify({ branch })
        if (seat === undefined) delete process.env.TS_SEAT_BRANCH
        else process.env.TS_SEAT_BRANCH = seat
        const define: Record<string, string> = {
          TS_API_BASE_URL: JSON.stringify(api)
        }
        developmentPasswordLinks.setup({ initialOptions: { define } })
        expect(define.TS_PASSWORD_LINK_BUILD).equals(String(enabled))
      }
    } finally {
      if (originalInfo === undefined) delete process.env.TS_BUILD_INFO
      else process.env.TS_BUILD_INFO = originalInfo
      if (originalSeat === undefined) delete process.env.TS_SEAT_BRANCH
      else process.env.TS_SEAT_BRANCH = originalSeat
    }
  })
})
