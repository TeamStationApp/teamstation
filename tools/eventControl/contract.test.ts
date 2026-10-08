import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { FIXTURE_FILES, FIXTURES_DIR } from './fixtures'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const contract = require('../../scripts/checkEventControlContract.cjs') as {
  main: (options?: {
    root?: string
    copies?: string[]
    log?: (line: string) => void
  }) => number
  FILES: string[]
  CANONICAL: string
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const boundary = require('../../scripts/checkEventControlBoundary.cjs') as {
  main: (options?: {
    root?: string
    base?: string
    forbidden?: Array<{ length: number; sha256: string }>
    log?: (line: string) => void
  }) => number
}

const ROOT = join(__dirname, '../..')
// An invented word, handed to the check as its length and hash the way the
// check holds its own list.
const word = 'Quillbeck'
const forbidden = [
  {
    length: word.length,
    sha256: createHash('sha256').update(word.toLowerCase(), 'utf8').digest('hex')
  }
]

describe('the contract and boundary checks', function () {
  this.timeout(30000)

  it('agree with the fixtures the Node reference reads', function () {
    expect(FIXTURE_FILES).deep.equals(contract.FILES)
    expect(FIXTURES_DIR).equals(join(ROOT, contract.CANONICAL))
    const lines: string[] = []
    expect(contract.main({ log: line => lines.push(line) })).equals(0)
    expect(lines.filter(line => /^[0-9a-f]{64} {2}mobile\//.test(line))).has.length(5)
  })

  it('fail on a differing copy, a missing one and a stray file', function () {
    const root = mkdtempSync(join(tmpdir(), 'contract-'))
    cpSync(FIXTURES_DIR, join(root, contract.CANONICAL), { recursive: true })
    mkdirSync(join(root, 'tools/eventControl'), { recursive: true })
    cpSync(
      join(ROOT, 'tools/eventControl/fixtures.ts'),
      join(root, 'tools/eventControl/fixtures.ts')
    )
    cpSync(FIXTURES_DIR, join(root, 'copy'), { recursive: true })
    const lines: string[] = []
    expect(contract.main({ root, copies: ['copy'], log: line => lines.push(line) })).equals(0)
    writeFileSync(join(root, 'copy/keys.json'), '{}\n')
    expect(contract.main({ root, copies: ['copy', 'absent'], log: line => lines.push(line) })).equals(1)
    expect(lines.some(line => /copy\/keys.json differs/.test(line))).equals(true)
    expect(lines.some(line => /absent\/frames.json is missing/.test(line))).equals(true)
    writeFileSync(join(root, contract.CANONICAL, 'extra.json'), '{}')
    writeFileSync(join(root, 'tools/eventControl/fixtures.ts'), '')
    lines.length = 0
    expect(contract.main({ root, copies: [], log: line => lines.push(line) })).equals(1)
    expect(lines.some(line => /extra.json is not a known fixture/.test(line))).equals(true)
    expect(lines.some(line => /does not read/.test(line))).equals(true)
    const empty = mkdtempSync(join(tmpdir(), 'contract-'))
    expect(contract.main({ root: empty, log: () => undefined })).equals(1)
  })

  it('finds this branch clean', function () {
    const lines: string[] = []
    expect(boundary.main({ log: line => lines.push(line) })).equals(0)
    expect(lines[lines.length - 1]).matches(/clean$/)
  })

  it('catches the name in a neutral file and in an added line', function () {
    const root = mkdtempSync(join(tmpdir(), 'boundary-'))
    const run = (...args: string[]): string =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    run('init', '-q', '-b', 'master')
    run('config', 'user.email', 'dev@example.test')
    run('config', 'user.name', 'Dev')
    mkdirSync(join(root, 'mobile/apps/tsDirector'), { recursive: true })
    writeFileSync(join(root, 'mobile/apps/tsDirector/Old.swift'), `// ${word} was here before\n`)
    run('add', '.')
    run('commit', '-q', '-m', 'base')
    run('branch', 'base')
    writeFileSync(
      join(root, 'mobile/apps/tsDirector/New.swift'),
      `let fine = 1\nlet peer = "${word}"\n`
    )
    mkdirSync(join(root, 'mobile/apps/common/EventControl'), { recursive: true })
    writeFileSync(join(root, 'mobile/apps/common/EventControl/A.swift'), `// ${word.toLowerCase()}\n`)
    mkdirSync(join(root, `mobile/apps/tsCameramanAndroid/app/eventcontrol`), { recursive: true })
    writeFileSync(join(root, `mobile/apps/tsCameramanAndroid/app/eventcontrol/${word}.kt`), 'x\n')
    writeFileSync(join(root, 'mobile/apps/tsCameramanAndroid/app/Other.kt'), 'fine\n')
    run('add', '.')
    run('commit', '-q', '-m', 'branch')
    const lines: string[] = []
    expect(
      boundary.main({ root, base: 'base', forbidden, log: line => lines.push(line) })
    ).equals(1)
    const failures = lines.filter(line => line.startsWith('FAIL'))
    expect(failures).deep.equals([
      `FAIL mobile/apps/common/EventControl/A.swift:1: // ${word.toLowerCase()}`,
      `FAIL mobile/apps/tsCameramanAndroid/app/eventcontrol/${word}.kt: in its path`,
      `FAIL mobile/apps/common/EventControl/A.swift:1: // ${word.toLowerCase()}`,
      `FAIL mobile/apps/tsDirector/New.swift:2: let peer = "${word}"`
    ])
  })
})
