import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('default rendered test runner', function () {
  this.timeout(60000)

  it('builds native navigation and native text measurement with the default suites', () => {
    execFileSync(process.execPath, ['scripts/checkScoringLayering.mjs'])
    execFileSync(process.execPath, ['scripts/build-scoring-tests.mjs'])
    const output = execFileSync(
      process.execPath,
      [
        'node_modules/mocha/bin/mocha.js',
        '-r',
        'sucrase/register',
        '-r',
        './src/test/scoringDomSetup.cjs',
        '--exit',
        '--timeout',
        '20000',
        'lib/scoring-tests.cjs',
        '--grep',
        'native initials|closing the full-screen player|clearing a navbar'
      ],
      { encoding: 'utf8' }
    )
    expect(output).includes('3 passing')
    expect(output).not.includes('failing')
    const sources = JSON.parse(
      readFileSync('lib/scoring-tests.cjs.map', 'utf8')
    ) as { sources: string[] }
    expect(
      sources.sources.some(name => name.endsWith('stepBackNative.test.tsx'))
    ).equals(true)
  })

  it('retains the focused setup and independent roster-edit bundles', () => {
    execFileSync(process.execPath, [
      'scripts/build-scoring-tests.mjs',
      '--current-setup',
      '--roster-edit'
    ])
    for (const file of [
      'lib/current-setup-tests.cjs.map',
      'lib/roster-edit-0-tests.cjs.map'
    ]) {
      const map = JSON.parse(readFileSync(file, 'utf8')) as {
        sources: string[]
      }
      expect(map.sources.some(source => source.endsWith('.test.tsx'))).equals(
        true
      )
    }
  })
})
