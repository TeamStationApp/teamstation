import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { caughtByLayer, detectFault } from './detect'
import { caughtByLayer as fromRow } from './detectRow'

describe('detect, on the row detectRow.ts builds', function () {
  this.timeout(60000)
  let scratch: string
  before(function () {
    scratch = mkdtempSync(join(tmpdir(), 'detect-test-'))
  })
  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('still exports caughtByLayer, now from detectRow.ts', function () {
    expect(caughtByLayer).equals(fromRow)
  })

  it('writes no ledger row for a run that could not start, and exits as the run did', async function () {
    const ledger = join(scratch, 'ledger.jsonl')
    const outcome = await detectFault(
      {
        id: 'no/such/scenario#at-all',
        surface: 'web-chromium',
        fault: 'api-500',
        runDir: join(scratch, 'run'),
        settings: {}
      },
      ledger
    )
    expect(outcome.row).deep.include({
      kind: 'detect',
      scenario: 'no/such/scenario#at-all',
      fault: 'api-500',
      caught: false,
      caughtBy: 'none',
      status: 'harness-error'
    })
    expect(outcome.exitCode).equals(3)
    expect(existsSync(ledger)).equals(false)
  })
})
