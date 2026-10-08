import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { allocateBuildNumber, packageVersion } from './buildNumber'
import { testRoot } from './config.test'
import { gitFixture } from './source.test'

let root: string, git: string, source: string
const date = new Date(2026, 8, 30, 12, 0)
function entries(): any[] {
  return JSON.parse(readFileSync(path.join(git, 'buildNum.json'), 'utf8'))
}
describe('Shared branch build numbers', () => {
  beforeEach(() => {
    root = testRoot('build-number-')
    source = gitFixture(root)
    git = path.join(source, '.git')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('starts at 00, increments per branch and copies the state into the checkout', () => {
    assert.equal(
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'master',
        date
      ),
      26093000
    )
    assert.equal(
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'master',
        date
      ),
      26093001
    )
    assert.equal(
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'feature/demo',
        date
      ),
      26093000
    )
    assert.equal(
      execFileSync('git', ['check-ignore', 'buildNum.json'], {
        cwd: source,
        encoding: 'utf8'
      }).trim(),
      'buildNum.json'
    )
    assert.equal(entries().length, 2)
    assert.equal(entries()[1].lastBuildDate, date.toISOString())
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(source, 'buildNum.json'), 'utf8')),
      entries()
    )
    assert.equal(
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'master',
        new Date(2026, 9, 1)
      ),
      26100100
    )
  })
  it('allows 99 and then fails without changing either file', () => {
    for (let i = 0; i < 100; i++)
      assert.equal(
        allocateBuildNumber(
          path.join(git, 'buildNum.json'),
          source,
          'master',
          date
        ),
        26093000 + i
      )
    const before = readFileSync(path.join(git, 'buildNum.json'), 'utf8')
    assert.throws(
      () =>
        allocateBuildNumber(
          path.join(git, 'buildNum.json'),
          source,
          'master',
          date
        ),
      /^Error: maximum build number reached$/
    )
    assert.equal(readFileSync(path.join(git, 'buildNum.json'), 'utf8'), before)
    assert.equal(
      readFileSync(path.join(source, 'buildNum.json'), 'utf8'),
      before
    )
  })
  it('shares the primary Git directory across linked worktrees', () => {
    const other = path.join(root, 'other')
    execFileSync('git', ['worktree', 'add', '--detach', other], {
      cwd: source,
      stdio: 'pipe'
    })
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: other, encoding: 'utf8' }
    ).trim()
    assert.equal(
      allocateBuildNumber(
        path.join(common, 'buildNum.json'),
        other,
        'master',
        date
      ),
      26093000
    )
    assert.equal(
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'master',
        date
      ),
      26093001
    )
    assert(existsSync(path.join(other, 'buildNum.json')))
  })
  it('uses local calendar date even when the UTC timestamp is a different day', () => {
    const old = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const instant = new Date('2026-10-01T01:00:00.000Z')
      assert.equal(
        allocateBuildNumber(
          path.join(git, 'buildNum.json'),
          source,
          'master',
          instant
        ),
        26093000
      )
      assert.equal(entries()[0].lastBuildDate, instant.toISOString())
    } finally {
      if (old == null) delete process.env.TZ
      else process.env.TZ = old
    }
  })
  it('rejects corrupt state and reads the parent package version', () => {
    assert.equal(packageVersion(source), '1.0.0')
    mkdirSync(path.join(source, 'nested'))
    writeFileSync(path.join(source, 'package.json'), '{"version":"2.3.4"}')
    assert.equal(packageVersion(source), '2.3.4')
    writeFileSync(path.join(source, 'package.json'), '{"version":"oops"}')
    assert.throws(() => packageVersion(source))
    writeFileSync(path.join(git, 'buildNum.json'), 'broken')
    assert.throws(() =>
      allocateBuildNumber(
        path.join(git, 'buildNum.json'),
        source,
        'master',
        date
      )
    )
    assert.equal(
      readFileSync(path.join(git, 'buildNum.json'), 'utf8'),
      'broken'
    )
  })
})
