import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('default rendered test runner', function () {
  // Each case runs whole bundle builds. Beside the rest of the suite on a CI
  // runner one takes most of a minute, so a minute is not enough to hold them to.
  this.timeout(180000)

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

  it('splits the app tests into bundles of consecutive files by their bytes', () => {
    // Not lib: the run this test is part of may be reading its bundles there.
    const dir = mkdtempSync(join(tmpdir(), 'ts-chunks-'))
    // Few bundles, each built at once beside the others: light enough to run
    // beside the rest of the suite.
    const most = 1_500_000
    try {
      execFileSync(process.execPath, [
        'scripts/build-scoring-tests.mjs',
        `--chunk-bytes=${most}`,
        `--chunk-dir=${dir}`
      ])
      const chunks = JSON.parse(
        readFileSync(join(dir, 'scoring-tests-chunks.json'), 'utf8')
      ) as Array<{ file: string; bytes: number; files: string[] }>
      expect(chunks.map(chunk => chunk.file)).deep.equals(
        chunks.map((_, index) => `${dir}/scoring-tests-chunk-${index}.cjs`)
      )
      // Every unit-tier app test file once, in path order, its bytes counted
      // there; the integration tier's are bundled by `--tier=integration`.
      const files = globSync('src/**/*.test.tsx')
        .filter(file => !file.endsWith('.integration.test.tsx'))
        .sort()
      expect(chunks.flatMap(chunk => chunk.files)).deep.equals(files)
      const size = (file: string): number => statSync(file).size
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.bytes).equals(
          chunk.files.reduce((sum, file) => sum + size(file), 0)
        )
        // Full: the next file would have taken it past the bytes asked for,
        // unless one file alone is more than that.
        if (chunk.files.length > 1) expect(chunk.bytes).most(most)
        const next = chunks[index + 1]?.files[0]
        if (next != null) expect(chunk.bytes + size(next)).greaterThan(most)
        expect(readFileSync(chunk.file, 'utf8')).includes(
          'describe)("", () => {'
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
