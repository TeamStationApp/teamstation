import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/** The worded stream's names, as whole words. */
const NAMES =
  /\b(?:scoringUpdateLines|ScoringUpdate|scoringUpdates|scoringActionLine|isStandaloneScoringUpdateLine)\b/

/** Dependencies and build output, never sources. */
const SKIPPED = new Set([
  'node_modules',
  'lib',
  'dist',
  'build',
  'coverage',
  'Pods',
  'DerivedData'
])

/**
 * Every source file under `dir`, skipping dependencies, build output and
 * hidden folders (`.git`, and local tool and agent folders no checkout
 * shares). A unit test starts no child process, so this reads the tree
 * itself rather than asking `git grep`.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      return SKIPPED.has(entry.name) || entry.name.startsWith('.')
        ? []
        : sources(path)
    return /\.(?:ts|tsx|mjs|cjs|js|swift|kt|m|mm|md)$/.test(entry.name)
      ? [path]
      : []
  })
}

/**
 * The server records who scored what and never words it: the scoring log's
 * text is the client's, so it can be translated. Nothing may bring back the
 * server-worded update stream.
 */
describe('scoring log text', () => {
  it('is never generated, stored or sent by the server', function () {
    this.timeout(20000)
    const found = sources('.')
      .filter(path => !path.endsWith('noServerLogText.test.ts'))
      .filter(path => NAMES.test(readFileSync(path, 'utf8')))
    expect(found).deep.equals([])
  })
})
