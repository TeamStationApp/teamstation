import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { browserFor } from './browserCdp'

describe('the browser a scenario opens', function () {
  const was = process.env.TS_E2E_H264_CHROME
  afterEach(() => {
    if (was === undefined) delete process.env.TS_E2E_H264_CHROME
    else process.env.TS_E2E_H264_CHROME = was
  })

  it('opens the Chrome TS_E2E_H264_CHROME names for H.264, and Chromium otherwise', async function () {
    process.env.TS_E2E_H264_CHROME = __filename
    expect(await browserFor({ h264: true })).equals(__filename)
    expect(await browserFor({})).equals('chromium')
  })
})
