import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'mocha'

import { markdownOf, writeReport } from './report'
import { settingsFrom, TARGETS } from './targets'

const DEVICE = '00000000-0000-4000-8000-000000000001'

describe('playback probe: targets and report', function () {
  it('names every phone surface once', function () {
    assert.deepEqual(
      TARGETS.map(target => target.name),
      [
        'iphone-safari',
        'iphone-brave',
        'pixel8-chrome',
        'pixel10-chrome',
        'iphone-app',
        'pixel8-app',
        'pixel10-app'
      ]
    )
    assert.equal(
      TARGETS.find(target => target.name === 'iphone-brave')?.typesAddress,
      true
    )
  })

  it('reads a run from the environment', function () {
    const settings = settingsFrom({
      TS_TARGET: 'pixel8-chrome',
      TS_DEVICE: DEVICE,
      TS_APP: 'https://seat.example.test/',
      TS_ARTIFACTS: '/Users/dev/artifacts'
    })
    assert.equal(settings.target.appId, 'com.android.chrome')
    assert.equal(settings.app, 'https://seat.example.test')
    assert.equal(settings.daemon, 'pbr-pixel8-chrome')
    assert.equal(settings.artifacts, '/Users/dev/artifacts')
    assert.equal(
      settingsFrom({
        TS_TARGET: 'pixel8-app',
        TS_DEVICE: DEVICE,
        TS_APP: 'x',
        MAESTRO_D: 'mine'
      }).daemon,
      'mine'
    )
  })

  it('refuses a run that is missing what it needs', function () {
    assert.throws(() => settingsFrom({}), /TS_TARGET is required/)
    assert.throws(
      () => settingsFrom({ TS_TARGET: 'mac-brave' }),
      /is not one of/
    )
    assert.throws(
      () =>
        settingsFrom({
          TS_TARGET: 'iphone-safari',
          TS_DEVICE: DEVICE,
          TS_APP: 'x'
        }),
      /MAESTRO_D_TEAM_ID/
    )
    assert.throws(
      () => settingsFrom({ TS_TARGET: 'pixel8-app', TS_DEVICE: DEVICE }),
      /TS_APP is required/
    )
  })

  it('writes the report as JSON and as a table that leads with its command', function () {
    const dir = mkdtempSync(join(tmpdir(), 'pbr-report-'))
    try {
      const report = {
        target: 'iphone-brave',
        content: 'tp+',
        command: 'TS_TARGET=iphone-brave npx mocha playbackReliability.e2e.ts',
        startedAt: '2026-10-27T05:00:00Z',
        finishedAt: '2026-10-27T05:10:00Z',
        steps: [
          { step: 'Watch', pass: true, startMs: 1200, reasons: [], notes: [] },
          {
            step: 'scrub 2 | back',
            pass: false,
            startMs: null,
            reasons: ['angle 1 never started moving'],
            notes: ['webcam and screenshots disagree about a freeze']
          }
        ]
      }
      const md = writeReport(join(dir, 'out'), report)
      assert.equal(md, join(dir, 'out', 'report-iphone-brave-tpplus.md'))
      assert.equal(
        JSON.parse(
          readFileSync(
            join(dir, 'out', 'report-iphone-brave-tpplus.json'),
            'utf8'
          )
        ).steps.length,
        2
      )
      const text = markdownOf(report)
      assert.match(text, /^\$ TS_TARGET=iphone-brave/m)
      assert.match(text, /1 of 2 steps passed/)
      assert.match(text, /\| Watch \| pass \| 1200 ms \| {2}\|/)
      assert.match(
        text,
        /scrub 2 \| back \| \*\*FAIL\*\* \| — \| angle 1 never started moving; note: webcam/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
