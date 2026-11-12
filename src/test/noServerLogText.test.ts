import { spawnSync } from 'node:child_process'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/** The worded stream's names, matched as whole words. */
const NAMES = [
  'scoringUpdateLines',
  'ScoringUpdate',
  'scoringUpdates',
  'scoringActionLine',
  'isStandaloneScoringUpdateLine'
]

/**
 * The server records who scored what and never words it: the scoring log's
 * text is the client's, so it can be translated. Nothing may bring back the
 * server-worded update stream.
 */
describe('scoring log text', () => {
  it('is never generated, stored or sent by the server', () => {
    // Every tracked file; whole words leave `RemoteScoringUpdates` alone.
    const grep = spawnSync(
      'git',
      [
        'grep',
        '-n',
        '-w',
        ...NAMES.flatMap(name => ['-e', name]),
        '--',
        '.',
        ':!src/test/noServerLogText.test.ts'
      ],
      { encoding: 'utf8' }
    )
    expect(grep.stdout).equals('')
    // Status 1 is "no match"; anything else means git grep did not run.
    expect(grep.status).equals(1)
  })
})
