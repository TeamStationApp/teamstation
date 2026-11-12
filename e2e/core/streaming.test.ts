import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { disabledFor, STREAMING } from './streaming'

describe('streaming scripts', function () {
  it('are disabled from the sweep unless E2E_STREAMING=1 asks for them', function () {
    const file = 'src/app/player/liveOutage.e2e.ts'
    expect(disabledFor(file, {})).includes('streaming')
    expect(disabledFor(file, { E2E_STREAMING: '1' })).equals(null)
    expect(disabledFor('src/app/scoring/scoring.e2e.ts', {})).equals(null)
  })

  it('name only scripts the suite lists', function () {
    const { modules } = JSON.parse(
      readFileSync(join(__dirname, '../legacy.json'), 'utf8')
    ) as { modules: Record<string, string> }
    expect(STREAMING.filter(file => modules[file] == null)).deep.equals([])
  })
})
