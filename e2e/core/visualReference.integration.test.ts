import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { reference } from './visual'

// It starts the checkout's renderer, a child process.
describe('visual.reference with its own renderer', function () {
  it('runs the checkout’s renderer by default, and says why it made nothing', function () {
    const dir = join(
      mkdtempSync(join(tmpdir(), 'reference-test-')),
      'reference'
    )
    try {
      // A size the renderer refuses before it starts a browser.
      expect(() => reference({ dir, size: 'not-a-size', t: 0 })).throws(
        /no reference frame/
      )
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true })
    }
  })
})
