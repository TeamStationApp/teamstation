import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { main } from './cli'
import { readLegacy } from './legacy'
import { ROOT } from './manifest'
import { computeFreeze } from './modules'
import { trackedFiles } from './validate'

// Both read the checkout's tracked files through git.
describe('freeze and validate --strict', function () {
  this.timeout(120000)

  it('writes the freeze its roots compute, where --out says', async function () {
    const out = join(mkdtempSync(join(tmpdir(), 'e2e-freeze-')), 'freeze.json')
    const log = console.log
    const printed: string[] = []
    console.log = (line: string) => printed.push(line)
    try {
      expect(await main(['freeze', '--out', out])).equals(0)
    } finally {
      console.log = log
    }
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written).deep.equals(
      computeFreeze(trackedFiles(ROOT), readLegacy(ROOT), ROOT)
    )
    expect(JSON.parse(printed.join('\n'))).deep.equals({
      files: written.files.length,
      written: out
    })
  })

  it('prints how many rigs wait on their legacy category', async function () {
    const log = console.log
    const error = console.error
    const said: string[] = []
    console.log = () => undefined
    console.error = (line: string) => said.push(line)
    try {
      await main(['validate', '--strict'])
    } finally {
      console.log = log
      console.error = error
    }
    expect(said.join('\n')).matches(
      /^validate: \d+ rig\(s\) wait for their legacy category before the lint reads them$/
    )
  })
})
