import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * Chat's cryptography is the Rust core on every platform, with no
 * JavaScript implementation to fall back on: none of the packages that were
 * one is a dependency, and nothing tracked imports them.
 */
const GONE = [
  '@noble/ciphers',
  '@noble/curves',
  '@noble/hashes',
  'react-native-quick-crypto',
  'react-native-nitro-modules',
  'react-native-get-random-values'
]

describe('no JavaScript crypto', function () {
  it('has none of the packages that were chat’s crypto', function () {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies'
    ]) {
      for (const name of GONE) {
        expect(pkg[field] ?? {}, `${field} ${name}`).not.have.property(name)
      }
    }
  })

  it('imports none of them anywhere', function () {
    const pattern = GONE.map(name => name.replace(/[/.]/g, '\\$&')).join('|')
    let found = ''
    try {
      found = execFileSync(
        'git',
        [
          'grep',
          '-n',
          '-E',
          `['"](${pattern})`,
          '--',
          'src',
          'index.js',
          'scripts'
        ],
        { encoding: 'utf8' }
      )
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error
    }
    // This file names them to look for them.
    const lines = found
      .split('\n')
      .filter(
        line => line !== '' && !line.startsWith('src/test/noJsCrypto.test.ts')
      )
    expect(lines).deep.equals([])
  })
})
