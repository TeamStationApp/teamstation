import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { reference, type RenderReference } from './visual'

describe('visual.reference', function () {
  it('renders a size’s splash reference once, from the checkout, and answers its path', function () {
    const dir = join(
      mkdtempSync(join(tmpdir(), 'reference-test-')),
      'reference'
    )
    try {
      const calls: Array<{ args: string[]; cwd: string }> = []
      const render: RenderReference = (_file, args, options) => {
        calls.push({ args, cwd: options.cwd })
        writeFileSync(join(dir, 'reference-402x874@3-t0.7.png'), '')
        return { status: 0, stderr: '' }
      }
      const file = reference({ dir, size: '402x874@3', t: 0.7 }, render)
      expect(file).equals(join(dir, 'reference-402x874@3-t0.7.png'))
      expect(calls[0].args).deep.equals([
        'scripts/splash/buildSplashAssets.mjs',
        '--frames',
        dir,
        '--sizes',
        '402x874@3'
      ])
      expect(calls[0].cwd).equals(join(__dirname, '..', '..'))
      // Rendered once: the next ask reads the file already there.
      expect(reference({ dir, size: '402x874@3', t: 0.7 }, render)).equals(file)
      expect(calls).length(1)
      // A render that fails, or writes no such frame, says so.
      const failed: RenderReference = () => ({
        status: 1,
        stderr: 'no Chrome\n'
      })
      expect(() => reference({ dir, size: '820x1180@2', t: 0 }, failed)).throws(
        /no reference frame .*: no Chrome/
      )
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true })
    }
  })
})
