import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { browserFor } from './browserCdp'
import { mergeCoverage } from './coverage'

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

it('replaces stale raw counters when an empty browser run is merged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-coverage-'))
  try {
    const output = join(dir, 'merged')
    writeFileSync(output + '.v8', '[{"asset":"previous"}]')
    expect(mergeCoverage(dir, output)).equals(0)
    expect(JSON.parse(readFileSync(output + '.v8', 'utf8'))).deep.equals([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
