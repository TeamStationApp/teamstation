import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sourceIndexFixture as makeFixture } from '../../../test/sourceIndexFixture'
import { isPrivateName, sourcePaths } from './files'

const sourceIndexFixture = (
  extra: Record<string, string | Buffer> = {}
): ReturnType<typeof makeFixture> => makeFixture(extra, true)

describe('tracked source index enumeration', () => {
  it('lists only tracked paths and respects file and ancestor export-ignore', () => {
    const f = sourceIndexFixture({
      'src/maestro/deep/a.ts': 'omit',
      'src/tools/a.ts': 'omit',
      'src/omit.ts': 'omit',
      'src/kept.ts': 'keep'
    })
    try {
      f.write('src/untracked.ts', 'no')
      f.write('src/serverConfig.json', '{}')
      const paths = sourcePaths(f.root)
      expect(paths).includes('src/kept.ts')
      expect(
        paths.some(path =>
          /maestro|tools|omit|untracked|serverConfig/.test(path)
        )
      ).equals(false)
    } finally {
      f.close()
    }
  })
  it('keeps secrets, build output and export-ignored paths out of a copied checkout without git', () => {
    const root = mkdtempSync(join(tmpdir(), 'tess-copied-checkout-'))
    try {
      for (const [path, text] of Object.entries({
        '.gitattributes':
          '# comment\nsrc/maestro export-ignore\n/src/tools/ export-ignore\n*.png export-ignore\n',
        'src/DIRECTORY_MAP.md': '# Map\n',
        'src/server/kept.ts': 'export const kept = 1\n',
        'src/serverConfig.json': '{"secret":"x"}',
        'src/server/ServerConfig.JSON': '{"secret":"x"}',
        'src/clientConfig.json': '{"secret":"x"}',
        'src/.env': 'SECRET=x',
        'src/app/release.keystore': 'x',
        'src/android/local.properties': 'sdk.dir=x',
        'src/node_modules/pkg/index.js': 'x',
        'src/lib/server/index.js': 'x',
        'src/.cache/state': 'x',
        'src/maestro/flow.yaml': 'x',
        'src/tools/make.ts': 'x',
        'src/libraries.ts': 'export const libraries = 1\n'
      })) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
      }
      expect(sourcePaths(root)).deep.equals([
        'src/DIRECTORY_MAP.md',
        'src/libraries.ts',
        'src/server/kept.ts'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('names private files in any case', () => {
    for (const name of [
      'serverConfig.json',
      'CLIENTCONFIG.JSON',
      '.env',
      'a.Keystore',
      'Pods',
      'x.xcuserdatad'
    ])
      expect(isPrivateName(name), name).equals(true)
    for (const name of ['libraries.ts', 'builder.ts', 'server.ts'])
      expect(isPrivateName(name), name).equals(false)
  })
})
