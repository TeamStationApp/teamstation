import childProcess from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'node:test'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sourceIndexFixture } from '../../../test/sourceIndexFixture'
import {
  MAX_SOURCE_BYTES,
  sourceLines,
  sourcePaths,
  sourceRole,
  sourceText
} from './files'

describe('source index files', () => {
  it('filters tracked files using their own and ancestor export attributes', () => {
    const f = sourceIndexFixture()
    f.write('.git', 'fixture marker')
    let tracked = 'src/kept.ts\0src/omit.ts\0src/tools/deep/omit.ts\0'
    const git = mock.method(
      childProcess,
      'execFileSync',
      (_command: string, args: string[], options: { input?: string }) => {
        if (args[0] === 'ls-files') return tracked
        expect(options.input?.split('\0')).includes('src/tools')
        expect(options.input?.split('\0')).includes('src/tools/deep')
        return 'src/kept.ts\0export-ignore\0unspecified\0src/omit.ts\0export-ignore\0set\0src/tools\0export-ignore\0set\0'
      }
    )
    try {
      expect(sourcePaths(f.root)).deep.equals(['src/kept.ts'])
      tracked = ''
      expect(sourcePaths(f.root)).deep.equals([])
      expect(git.mock.callCount()).equals(3)
    } finally {
      git.mock.restore()
      f.close()
    }
  })
  it('classifies tests before fixtures and avoids partial-name false positives', () => {
    for (const path of [
      'a.test.ts',
      'a.spec.tsx',
      'a.integration.test.ts',
      'a.integration.ts',
      'a.e2e.ts'
    ])
      expect(sourceRole(`src/test/${path}`)).equals('test')
    for (const path of [
      'src/test/a.ts',
      'src/a/fixtures/a.ts',
      'src/a/fixture/a.ts',
      'src/reference/a.ts',
      'src/__snapshots__/a.snap'
    ])
      expect(sourceRole(path)).equals('fixture')
    for (const path of ['src/latest.ts', 'src/testing.ts', 'src/contest/a.ts'])
      expect(sourceRole(path)).equals('code')
  })
  it('preserves UTF-8 including BOM and distinguishes skipped content', () => {
    const f = sourceIndexFixture({
      'src/bom.ts': '\ufeffexport const x = "🦊"\n',
      'src/empty.ts': '',
      'src/binary': Buffer.from([1, 0]),
      'src/bad': Buffer.from([0xff]),
      'src/big': Buffer.alloc(MAX_SOURCE_BYTES + 1, 65)
    })
    try {
      expect(sourceText(f.root, 'src/bom.ts')).deep.equals({
        content: '\ufeffexport const x = "🦊"\n',
        bytes: Buffer.byteLength('\ufeffexport const x = "🦊"\n')
      })
      expect(sourceText(f.root, 'src/empty.ts')).deep.equals({
        content: '',
        bytes: 0
      })
      for (const [path, reason] of [
        ['binary', 'binary (NUL)'],
        ['bad', 'invalid UTF-8'],
        ['big', 'over 1 MiB'],
        ['missing', 'unreadable']
      ])
        expect(sourceText(f.root, `src/${path}`)).deep.equals({ reason })
      symlinkSync(
        join(f.root, 'src/common/api.ts'),
        join(f.root, 'src/link.ts')
      )
      symlinkSync(join(f.root, 'src/common'), join(f.root, 'src/linked'))
      expect(sourceText(f.root, 'src/link.ts')).deep.equals({
        reason: 'symbolic link'
      })
      expect(sourceText(f.root, 'src/linked/api.ts')).deep.equals({
        reason: 'symbolic link'
      })
      mkdirSync(join(f.root, 'src/dir'))
      expect(sourceText(f.root, 'src/dir')).deep.equals({
        reason: 'not a regular file'
      })
    } finally {
      f.close()
    }
    expect(sourceLines('')).deep.equals([])
    expect(sourceLines('a')).deep.equals(['a'])
    expect(sourceLines('a\n\n')).deep.equals(['a', ''])
  })
})
