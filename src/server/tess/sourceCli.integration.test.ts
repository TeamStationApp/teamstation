import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { it } from 'mocha'

import { sourceIndexFixture } from '../../test/sourceIndexFixture'
it('runs the real call CLI, including malformed calls and an unavailable index', () => {
  const f = sourceIndexFixture()
  f.build()
  try {
    const cli = resolve('src/server/tess/sourceIndex/cli.ts')
    const run = (...args: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, ['-r', 'sucrase/register', cli, ...args], {
        encoding: 'utf8'
      })
    const result = run(
      'call',
      'source_find_definition',
      '{"name":"contextLimits"}',
      '--index',
      f.index
    )
    expect(result.status, String(result.stderr)).equals(0)
    expect(String(result.stdout)).includes('contextLimits')
    expect(
      run(
        'call',
        'source_outline',
        '{"path":"src"}',
        '--index',
        join(f.root, 'missing.db')
      ).status
    ).equals(1)
    expect(run('call', 'unknown', '{}').status).equals(1)
    expect(run('call', 'source_outline', '{').status).equals(1)
    // CLI source reads never change the index.
    const before = readFileSync(f.index)
    execFileSync(process.execPath, [
      '-r',
      'sucrase/register',
      cli,
      'call',
      'source_read_file',
      '{"path":"src/common/api.ts"}',
      '--index',
      f.index
    ])
    expect(readFileSync(f.index)).deep.equals(before)
  } finally {
    f.close()
  }
})
