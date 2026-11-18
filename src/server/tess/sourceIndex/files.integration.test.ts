import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sourceIndexFixture as makeFixture } from '../../../test/sourceIndexFixture'
import { sourcePaths } from './files'

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
})
