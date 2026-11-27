import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'mocha'

import { markdownOf, writeReport } from './report'

describe('playback probe: report', function () {
  it('writes the report as JSON and as a table that leads with its command', function () {
    const dir = mkdtempSync(join(tmpdir(), 'pbr-report-'))
    try {
      const report = {
        target: 'web-safari-ios',
        content: 'tp+',
        command:
          'npm run e2e -- run playback/reliability/recorded-angles.e2e.ts',
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
      assert.equal(md, join(dir, 'out', 'report-web-safari-ios-tpplus.md'))
      assert.equal(
        JSON.parse(
          readFileSync(
            join(dir, 'out', 'report-web-safari-ios-tpplus.json'),
            'utf8'
          )
        ).steps.length,
        2
      )
      const text = markdownOf(report)
      assert.match(text, /^\$ npm run e2e -- run/m)
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
