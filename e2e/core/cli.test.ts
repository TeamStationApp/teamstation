import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { STACKS, writeStackEntry } from './attach'
import { main } from './cli'
import { HarnessError } from './result'

describe('the CLI', function () {
  it('refuses a stack named for a fault run, which always has its own', async function () {
    const id = `cli-test-${process.pid}`
    const file = join(STACKS, `${id}.json`)
    writeStackEntry(
      STACKS,
      file,
      JSON.stringify({ id, origin: 'http://127.0.0.1:1', pid: 1 })
    )
    try {
      let failure: unknown
      try {
        await main([
          'detect',
          'streaming/basic/four-synthetic#scrub',
          '--fault',
          'app-crash',
          '--surface',
          'web-chromium',
          '--stack',
          id
        ])
      } catch (error) {
        failure = error
      }
      expect(failure).instanceOf(HarnessError)
      expect(String(failure)).includes('leave out --stack')
    } finally {
      rmSync(file, { force: true })
    }
  })
})
