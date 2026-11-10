import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

describe('the installed commit gate', function () {
  this.timeout(30000)

  for (const failure of ['lint', 'typecheck', 'test', 'none']) {
    it(`blocks ${failure === 'none' ? 'nothing when every check passes' : `a ${failure} failure`}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'ts-commit-gate-'))
      const source = resolve('.')
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      )
      Object.assign(env, {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HUSKY: '1',
        XDG_CONFIG_HOME: root,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        TEST_GATE_FAILURE: failure
      })
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
      try {
        git('init', '--quiet')
        git('config', 'user.name', 'Demo Developer')
        git('config', 'user.email', 'developer@example.com')
        const packageJson = JSON.parse(
          readFileSync(join(source, 'package.json'), 'utf8')
        ) as { scripts: { precommit: string } }
        writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson))
        execFileSync(
          process.execPath,
          [join(source, 'node_modules/husky/bin.js')],
          { cwd: root, env }
        )
        writeFileSync(
          join(root, '.husky/pre-commit'),
          readFileSync(join(source, '.husky/pre-commit'))
        )
        // Execute the real aggregate script; each expensive check is controlled
        // so every exit path is proven through a real Git commit and Husky.
        writeFileSync(
          join(root, 'npm'),
          `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
if (process.env.GIT_DIR != null || process.env.GIT_WORK_TREE != null || process.env.GIT_INDEX_FILE != null) {
  throw new Error('Hook repository variables leaked into the test process')
}
const name = process.argv[2] === 'run' ? process.argv[3] : process.argv[2]
if (name === 'precommit') {
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts.precommit
  process.exit(spawnSync('sh', ['-c', command], { stdio: 'inherit' }).status ?? 1)
}
appendFileSync('checks.log', name + '\\n')
process.exit(name === process.env.TEST_GATE_FAILURE ? 23 : 0)
`,
          { mode: 0o755 }
        )
        writeFileSync(join(root, 'fixture.txt'), 'synthetic fixture\n')
        git('add', 'fixture.txt')
        env.GIT_DIR = join(root, '.git')
        env.GIT_WORK_TREE = root
        const result = spawnSync('git', ['commit', '-m', 'Exercise the gate'], {
          cwd: root,
          env,
          encoding: 'utf8'
        })
        const expected = ['lint', 'typecheck', 'test']
        const index = expected.indexOf(failure)
        expect(
          readFileSync(join(root, 'checks.log'), 'utf8').trim().split('\n')
        ).deep.equals(index < 0 ? expected : expected.slice(0, index + 1))
        expect(result.status, result.stderr).equals(failure === 'none' ? 0 : 1)
        const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
          cwd: root,
          env
        })
        expect(head.status === 0).equals(failure === 'none')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
