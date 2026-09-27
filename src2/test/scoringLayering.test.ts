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
    mkdirSync(join(root, 'src2/common/scoring'), { recursive: true })
    mkdirSync(join(root, 'src2/app/scoring'), { recursive: true })
    mkdirSync(join(root, 'src2/server'), { recursive: true })
    writeFileSync(
      join(root, 'src2/common/scoring/apply.ts'),
      "import { x } from '../../app/scoring/thing'\nimport { y } from '../../server/db'\nimport { z } from 'cleaners'\n"
    )
    writeFileSync(
      join(root, 'src2/app/scoring/screen.tsx'),
      "import { applyAction } from '../../common/scoring/apply'\nimport type { GameState } from '../../common/scoring/state'\nconst later = import('../../common/scoring/gumbo')\nimport { documentOf } from '../../common/scoring/document'\n"
    )
    expect(checkLayering(root)).deep.equals([
      'src2/common/scoring/apply.ts: the scoring library imports ../../app/scoring/thing',
      'src2/common/scoring/apply.ts: the scoring library imports ../../server/db',
      'src2/app/scoring/screen.tsx: the app may not import scoring/apply',
      'src2/app/scoring/screen.tsx: the app may not import scoring/gumbo',
      'src2/app/scoring/screen.tsx: the app may not import scoring/document'
    ])
  })
})
