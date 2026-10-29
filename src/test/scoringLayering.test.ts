import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('scoring layering', function () {
  it('holds on the tree and fails on a bad import either way', async function () {
    const { checkLayering } = (await import(
      resolve('scripts/checkScoringLayering.mjs')
    )) as { checkLayering: (root: string) => string[] }
    expect(checkLayering(resolve('.'))).deep.equals([])

    const root = mkdtempSync(join(tmpdir(), 'layering-'))
    mkdirSync(join(root, 'src/common/scoring'), { recursive: true })
    mkdirSync(join(root, 'src/app/scoring'), { recursive: true })
    mkdirSync(join(root, 'src/server'), { recursive: true })
    writeFileSync(
      join(root, 'src/common/scoring/apply.ts'),
      "import { x } from '../../app/scoring/thing'\nimport { y } from '../../server/db'\nimport { z } from 'cleaners'\n"
    )
    writeFileSync(
      join(root, 'src/app/scoring/screen.tsx'),
      "import { applyAction } from '../../common/scoring/apply'\nimport type { GameState } from '../../common/scoring/state'\nconst later = import('../../common/scoring/gumbo')\nimport { documentOf } from '../../common/scoring/document'\n"
    )
    // Fixture setup may construct scoring documents without becoming app code.
    writeFileSync(
      join(root, 'src/app/scoring/fixture.e2e.ts'),
      "import { documentOf } from '../../common/scoring/document'\n"
    )
    expect(checkLayering(root)).deep.equals([
      'src/common/scoring/apply.ts: the scoring library imports ../../app/scoring/thing',
      'src/common/scoring/apply.ts: the scoring library imports ../../server/db',
      'src/app/scoring/screen.tsx: the app may not import scoring/apply',
      'src/app/scoring/screen.tsx: the app may not import scoring/gumbo',
      'src/app/scoring/screen.tsx: the app may not import scoring/document'
    ])
  })
})

describe('scoring read-only import boundary', function () {
  it('allows types and audited readers, but not mutators hidden by import syntax', async () => {
    const { checkLayering, main } = (await import(
      resolve('scripts/checkScoringLayering.mjs')
    )) as {
      checkLayering: (root: string) => string[]
      main: (root: string) => number
    }
    const root = mkdtempSync(join(tmpdir(), 'layering-readers-'))
    mkdirSync(join(root, 'src/common/scoring'), { recursive: true })
    mkdirSync(join(root, 'src/app'), { recursive: true })
    mkdirSync(join(root, 'src/server'), { recursive: true })
    const file = join(root, 'src/app/readers.ts')
    const prefix = '../common/scoring/'
    for (const source of [
      `import { ordinal, begun as started } from '${prefix}lineup'`,
      `import { confirmedSides, revealedSides } from '${prefix}lineupHistory'`,
      `import { namesIn, withNames } from '${prefix}storedNames'`,
      `import type { BoardLine } from '${prefix}boardLineTypes'`,
      `import { type Lineup } from '${prefix}lineupHistory'`,
      `export type { Lineup } from '${prefix}lineupHistory'`,
      `export { ordinal as position } from '${prefix}lineup'`,
      `import type State = require('${prefix}state')`,
      "export { outside } from 'example'; export { local }; const x = import(name)",
      "import { ordinary } from './ordinary'; import React from 'react'"
    ]) {
      writeFileSync(file, source)
      expect(checkLayering(root), source).deep.equals([])
    }
    expect(main(root)).equals(0)
    for (const source of [
      `import { updateDefense as ordinal } from '${prefix}lineup'`,
      `import { ordinal, startAppearance } from '${prefix}lineup'`,
      `import * as lineup from '${prefix}lineup'`,
      `import lineup, { ordinal } from '${prefix}lineup'`,
      `import '${prefix}lineup'`,
      `const x = import('${prefix}lineup')`,
      `const x = require('${prefix}lineup')`,
      `import x = require('${prefix}lineup')`,
      `export * from '${prefix}lineup'`,
      `export { updateDefense as ordinal } from '${prefix}lineup'`,
      `import { documentOf } from '${prefix}document'`,
      `import { withNames, withoutNames } from '${prefix}storedNames'`
    ]) {
      writeFileSync(file, source)
      expect(checkLayering(root), source).has.length(1)
    }
    expect(main(root)).equals(1)
  })
})
