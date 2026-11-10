import { execFileSync } from 'node:child_process'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  transformFileSync
}: {
  transformFileSync: (file: string, options: object) => unknown
} = require('@babel/core')

/**
 * Every file the phone bundle can hold goes through the app's own Babel
 * configuration, worklets plugin included. Typecheck, ESLint and the mocha
 * suites never run that plugin, and it refuses some code they all accept
 * (a spread in a gesture hook's options once broke both phone builds), so
 * this is the one test that sees what Metro will.
 */
describe('the phone bundle’s Babel transform', function () {
  this.timeout(120000)

  it('takes every app and common file', function () {
    const files = execFileSync(
      'git',
      ['ls-files', 'src/app/*.ts', 'src/app/*.tsx', 'src/common/*.ts'],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      // The web twins and the tests never reach a phone.
      .filter(file => !/\.(test|e2e)\.tsx?$|\.web\.tsx?$/.test(file))
    expect(files.length).greaterThan(100)
    const refused: string[] = []
    for (const file of files) {
      try {
        transformFileSync(file, {
          cwd: process.cwd(),
          configFile: './babel.config.js',
          babelrc: false
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        refused.push(`${file}: ${message.split('\n')[0]}`)
      }
    }
    expect(refused).deep.equals([])
  })
})
