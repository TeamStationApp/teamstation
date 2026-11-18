import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  buildInfoJson,
  sourceIndexFixture as makeFixture
} from '../../../test/sourceIndexFixture'
import { buildSourceIndex, sourceCommit } from './build'

const sourceIndexFixture = (
  extra: Record<string, string | Buffer> = {}
): ReturnType<typeof makeFixture> => makeFixture(extra, true)

describe('building the source index through Git and the CLI', function () {
  this.timeout(120000)
  it('builds identical tracked content from a checkout and its release archive', () => {
    const f = sourceIndexFixture({
      'src/maestro/deep/omit.ts': 'no',
      'src/tools/omit.ts': 'no',
      'src/omit.ts': 'no',
      'src/a.ts': 'export const keep = 1'
    })
    try {
      f.git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'Fixture'
      )
      const release = join(f.root, 'release')
      mkdirSync(release)
      const archive = execFileSync('git', ['archive', 'HEAD', 'src'], {
        cwd: f.root
      })
      execFileSync('tar', ['-x', '-C', release], { input: archive })
      const a = f.build()
      const out = join(release, 'source.db')
      const b = buildSourceIndex({
        root: release,
        out,
        commit: 'fixture-release'
      })
      expect(b.files).equals(a.files)
      const first = new DatabaseSync(f.index)
      const second = new DatabaseSync(out)
      try {
        expect(second.prepare('select * from files').all()).deep.equals(
          first.prepare('select * from files').all()
        )
      } finally {
        first.close()
        second.close()
      }
    } finally {
      f.close()
    }
  })
  it('uses build metadata, then git, then unknown and runs the actual CLI', () => {
    const f = sourceIndexFixture()
    const previous = process.env.TS_BUILD_INFO
    try {
      process.env.TS_BUILD_INFO = buildInfoJson('metadata-release')
      expect(sourceCommit(f.root)).equals('metadata-release')
      process.env.TS_BUILD_INFO = '{}'
      expect(sourceCommit(f.root)).equals('unknown')
      delete process.env.TS_BUILD_INFO
      f.git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'Fixture'
      )
      const head = f.git('rev-parse', 'HEAD').trim()
      expect(sourceCommit(f.root)).equals(head)
      // A tree without its own .git never takes an enclosing checkout's HEAD.
      expect(sourceCommit(join(f.root, 'src'))).equals('unknown')
      // An untracked file is not indexed, so it does not dirty the label.
      f.write('src/untracked.ts', 'export const u = 1\n')
      expect(sourceCommit(f.root)).equals(head)
      f.write('src/DIRECTORY_MAP.md', '# Edited map\n')
      expect(sourceCommit(f.root)).equals(`${head}-dirty`)
      f.git('checkout', '--', 'src/DIRECTORY_MAP.md')
      const cli = resolve('src/server/tess/sourceIndex/cli.ts')
      const run = (...args: string[]): ReturnType<typeof spawnSync> =>
        spawnSync(process.execPath, ['-r', 'sucrase/register', cli, ...args], {
          encoding: 'utf8'
        })
      expect(run('build', '--root', f.root).status).equals(0)
      expect(existsSync(f.index)).equals(true)
      expect(
        run('build', '--root', f.root, '--out', join(f.root, 'other.db')).status
      ).equals(0)
      expect(run('wrong').status).equals(1)
      expect(run('build', '--unknown').status).equals(1)
    } finally {
      if (previous == null) delete process.env.TS_BUILD_INFO
      else process.env.TS_BUILD_INFO = previous
      f.close()
    }
  })
})
