import childProcess from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mock } from 'node:test'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sourceIndexFixture } from '../../../test/sourceIndexFixture'
import { buildSourceIndex, sourceCommit } from './build'
import { MAX_SOURCE_BYTES } from './files'

describe('building the source index', function () {
  this.timeout(120000)
  it('prefers build metadata and falls back to the Git revision or unknown', () => {
    const previous = process.env.TS_BUILD_INFO
    const git = mock.method(childProcess, 'execFileSync', () => 'fixture-git\n')
    try {
      process.env.TS_BUILD_INFO = '{"commit":"fixture-build"}'
      expect(sourceCommit('.')).equals('fixture-build')
      expect(git.mock.callCount()).equals(0)
      process.env.TS_BUILD_INFO = '{}'
      expect(sourceCommit('.')).equals('fixture-git')
      delete process.env.TS_BUILD_INFO
      git.mock.mockImplementation(() => {
        throw new Error('no checkout')
      })
      expect(sourceCommit('.')).equals('unknown')
      process.env.TS_BUILD_INFO = '{'
      expect(() => sourceCommit('.')).throws()
    } finally {
      git.mock.restore()
      if (previous == null) delete process.env.TS_BUILD_INFO
      else process.env.TS_BUILD_INFO = previous
    }
  })
  it('stores content, roles, metadata, line counts, folder entries, FTS and symbols', () => {
    const f = sourceIndexFixture({
      'src/empty.ts': '',
      'src/a/b/no-newline.ts': 'export const marker = "CaseSensitive"',
      'src/binary': Buffer.from([0]),
      'src/invalid': Buffer.from([0xff]),
      'src/large': Buffer.alloc(MAX_SOURCE_BYTES + 1)
    })
    try {
      symlinkSync(
        join(f.root, 'src/common/api.ts'),
        join(f.root, 'src/link.ts')
      )
      const built = f.build()
      const db = new DatabaseSync(f.index, { readOnly: true })
      try {
        expect(built.roles).deep.equals({ code: 5, test: 1, fixture: 1 })
        expect(built.files).equals(7)
        expect(built.skipped).length(4)
        expect(built.symbols).greaterThan(3)
        expect(built.bytes).greaterThan(0)
        expect(
          db
            .prepare('select lines,bytes,directory from files where path=?')
            .get('src/empty.ts')
        ).deep.equals({ lines: 0, bytes: 0, directory: 'src' })
        expect(
          db
            .prepare('select lines from files where path=?')
            .get('src/a/b/no-newline.ts')
        ).deep.equals({ lines: 1 })
        expect(
          db
            .prepare('select name,kind from entries where parent=?')
            .all('src/a')
        ).deep.equals([{ name: 'b', kind: 'directory' }])
        expect(
          db
            .prepare('select count(*) as n from search where content glob ?')
            .get('*CaseSensitive*')
        ).deep.equals({ n: 1 })
        expect(
          db
            .prepare('select count(*) as n from search where content glob ?')
            .get('*casesensitive*')
        ).deep.equals({ n: 0 })
        const meta = Object.fromEntries(
          db
            .prepare('select key,value from meta')
            .all()
            .map(row => [row.key, row.value])
        )
        expect(meta).includes({
          commit: 'fixture-release',
          files: '7',
          schema_version: '1'
        })
        expect(Number.isNaN(Date.parse(String(meta.built_at)))).equals(false)
        expect(JSON.parse(String(meta.skipped))).deep.equals(built.skipped)
      } finally {
        db.close()
      }
    } finally {
      f.close()
    }
  })
  it('preserves the previous index on failure and cleans temporary files', () => {
    const f = sourceIndexFixture()
    try {
      f.build()
      const original = readFileSync(f.index)
      rmSync(join(f.root, 'src/DIRECTORY_MAP.md'))
      expect(() => f.build()).throws('needs source text')
      expect(readFileSync(f.index)).deep.equals(original)
      expect(existsSync(f.index + '.tmp')).equals(false)
      rmSync(join(f.root, 'src'), { recursive: true })
      mkdirSync(join(f.root, 'src'))
      expect(() =>
        buildSourceIndex({ root: f.root, out: join(f.root, 'empty.db') })
      ).throws()
      expect(existsSync(join(f.root, 'empty.db'))).equals(false)
    } finally {
      f.close()
    }
  })
})
