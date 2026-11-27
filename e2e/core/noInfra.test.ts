import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { noInfraProblems } from './lint'
import {
  computeFreeze,
  freezeProblems,
  importClosure,
  importsOf,
  legacyOnlyRigs,
  readFreeze,
  renderFreeze
} from './modules'
import { askProblems, infraProblems, oldVocabularyProblems } from './validate'

const SPEC = 'e2e/tests/a/b/c.e2e.ts'
const RIG = 'e2e/rigs/thing.ts'

function details(file: string, text: string): string[] {
  return noInfraProblems(file, text).map(problem => {
    expect(problem.rule).equals('no-infra')
    expect(problem.file).equals(file)
    return problem.detail
  })
}

describe('the no-infra rule', function () {
  const banned: Array<[string, string]> = [
    ["import { spawn } from 'node:child_process'", 'imports child_process'],
    ["import { execFile } from 'child_process'", 'imports child_process'],
    ["import { isIPv4 } from 'node:net'", 'imports net'],
    ["import { createServer } from 'node:http'", 'imports http'],
    ["import { request } from 'node:https'", 'imports https'],
    ["import { tmpdir } from 'node:os'", 'imports os'],
    ["import puppeteer from 'puppeteer'", 'imports puppeteer'],
    ["const os = require('node:os')", 'imports os'],
    [
      "const { spawn } = await import('node:child_process')",
      'imports child_process'
    ]
  ]
  for (const [line, detail] of banned) {
    it(`reports ${detail} (${line})`, function () {
      expect(details(SPEC, `${line}\n`)).deep.equals([`line 1: ${detail}`])
    })
  }

  it('reports a type-only puppeteer import in a rig', function () {
    expect(
      details(RIG, "\nimport type { Page } from 'puppeteer'\n")
    ).deep.equals(['line 2: imports puppeteer'])
  })

  it('reports a node:http server in a spec, and each line it reads the environment', function () {
    const text = [
      "import { createServer } from 'node:http'",
      'const port = process.env.PORT',
      "createServer(() => undefined).listen(Number(port), '127.0.0.1')"
    ].join('\n')
    expect(details(SPEC, text)).deep.equals([
      'line 1: imports http',
      'line 2: reads process.env',
      "line 3: IP address in '127.0.0.1'"
    ])
  })

  it('reads an .mjs helper server too', function () {
    expect(
      details(
        'e2e/rigs/chat/page.mjs',
        "import { createServer } from 'node:http'\n"
      )
    ).deep.equals(['line 1: imports http'])
  })

  it('reports each literal shape infrastructure knows', function () {
    const cases: Array<[string, string]> = [
      [
        "const a = 'https://e2e-03.teamstation.app/x'",
        'hostname e2e-03.teamstation.app'
      ],
      [
        "const a = 'http://localhost:8081'",
        "port literal in 'http://localhost:8081'"
      ],
      ["const a = 'localhost'", 'hostname localhost'],
      ["const a = '10.0.0.4'", "IP address in '10.0.0.4'"],
      ['const a = { port: 8100 }', 'port literal port: 8100'],
      [
        "const a = 'app.teamstation.develop.app'",
        'hostname app.teamstation.develop.app'
      ],
      ["const a = 'emulator-5554'", "device serial shape in 'emulator-5554'"],
      ["const a = 'R5CT1234ABCD'", "device serial shape in 'R5CT1234ABCD'"],
      ["const a = '/home/someone/run'", "home path in '/home/someone/run'"],
      ["const a = '~/.cursor/keys'", "home path in '~/.cursor/keys'"],
      ['const a = homedir()', 'reads the home directory'],
      [
        "const a = 'postgres://db.internal:5433/x'",
        "port literal in 'postgres://db.internal:5433/x'"
      ]
    ]
    for (const [line, detail] of cases) {
      expect(details(SPEC, line), line).deep.equals([`line 1: ${detail}`])
    }
  })

  it('reads a Swift helper for the environment and a spawned process', function () {
    expect(
      details(
        'e2e/rigs/app/tool.swift',
        'let env = ProcessInfo.processInfo.environment\nlet p = Process()\n'
      )
    ).deep.equals([
      'line 1: ProcessInfo.processInfo.environment reaches past maestro-d',
      'line 2: Process() reaches past maestro-d'
    ])
  })

  it('passes a clean spec, its comments, reserved names and the pages origin', function () {
    const text = [
      "import { defineHarness } from '../../../core/spec'",
      '// It once read process.env and talked to localhost:8081.',
      '/* https://e2e-03.teamstation.app */',
      'const link = `' + '$' + '{ctx.stack.pagesOrigin}/opened?x=1#frag`',
      "const mail = 'coach+one@example.test'",
      "const page = 'https://www.example.org/'",
      "const text = 'See www.example.org and example.technology.'",
      "const ns = 'http://www.w3.org/2000/svg'",
      "const store = 'https://apps.apple.com/app/id1'",
      "const deep = 'teamstation-develop://games/1'",
      "await ctx.checkpoint('home', { expect: [{ text: 'Home' }] })"
    ].join('\n')
    expect(details(SPEC, text)).deep.equals([])
  })
})

describe('the ask rule', function () {
  it('reports an ask checkpoint, by line', function () {
    expect(
      askProblems("a()\nawait ctx.checkpoint('x', { ask: 'Is it?' })")
    ).deep.equals(["line 2: ask is the frozen judge: use compare: 'ai'"])
  })

  it('passes compare: ai with a prompt', function () {
    expect(
      askProblems(
        "await ctx.checkpoint('x', { compare: 'ai', prompt: 'It is.', task: 1 })"
      )
    ).deep.equals([])
  })
})

describe('the old vocabulary outside the freeze', function () {
  it('names hardware, a seat stack, old services and a role without simulator', function () {
    expect(
      oldVocabularyProblems({
        stack: 'seat',
        services: ['api', 'mail-capture', 'tess-model'],
        surfaces: {
          'ios-app': {
            devices: [
              { role: 'phone', needs: ['ios-phone'], hardware: 'none' },
              { role: 'pad', needs: ['ipad'], simulator: 'allowed' }
            ]
          }
        }
      })
    ).deep.equals([
      "stack 'seat' is gone: use 'isolated' with a world",
      'service "api" is an old name',
      'service "tess-model" is an old name',
      'ios-app: role "phone" says hardware: say simulator',
      `ios-app: role "phone" must say simulator: 'allowed' or 'never'`
    ])
  })

  it('passes the new words', function () {
    expect(
      oldVocabularyProblems({
        stack: 'isolated',
        services: ['mail-capture'],
        surfaces: {
          'ios-app': {
            devices: [{ role: 'p', needs: ['ios-phone'], simulator: 'never' }]
          },
          'web-chromium': { devices: [] }
        }
      })
    ).deep.equals([])
  })
})

describe('the import graph, the freeze and the rigs the lint waits on', function () {
  const root = mkdtempSync(join(tmpdir(), 'e2e-graph-'))
  after(function () {
    rmSync(root, { recursive: true, force: true })
  })
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  write('e2e/core/run.ts', "import { x } from './shared'\n")
  write('e2e/core/shared.ts', 'export const x = 1\n')
  write('e2e/core/shared.test.ts', "import { x } from './shared'\n")
  write('e2e/core/legacySweep.ts', '')
  write('e2e/core/runLegacy.ts', '')
  write(
    'e2e/tests/streaming/a/b.e2e.ts',
    "import '../../../rigs/streaming/r'\n"
  )
  write('e2e/rigs/streaming/r.ts', "export * from '../frozenRig'\n")
  write('e2e/rigs/streaming/r.test.ts', '')
  write('e2e/rigs/frozenRig.ts', "import { createServer } from 'node:http'\n")
  write(
    'src/app/stream/old.e2e.ts',
    "import '../../../e2e/rigs/frozenRig'\nimport '../screen'\n"
  )
  write('src/app/screen.ts', '')
  write(
    'src/app/chat/old.e2e.ts',
    "import { a } from '../../../e2e/rigs/legacyRig.ts'\n"
  )
  write('e2e/rigs/legacyRig.ts', "import { spawn } from 'node:child_process'\n")
  write('e2e/rigs/legacyRig.test.ts', "import { tmpdir } from 'node:os'\n")
  write('e2e/rigs/orphan.ts', 'const a = process.env.A\n')
  write('e2e/tests/x/y/z.e2e.ts', "import './helper'\n// import './not-real'\n")
  write('e2e/tests/x/y/helper.ts', '')
  const list = {
    tests: ['src/app/stream/old.e2e.ts', 'src/app/chat/old.e2e.ts'],
    helpers: [],
    parked: [],
    modules: {
      'src/app/stream/old.e2e.ts': 'streaming',
      'src/app/chat/old.e2e.ts': 'messaging'
    }
  }
  const tracked = [
    'e2e/core/run.ts',
    'e2e/core/shared.ts',
    'e2e/core/shared.test.ts',
    'e2e/core/legacySweep.ts',
    'e2e/core/runLegacy.ts',
    'e2e/tests/streaming/a/b.e2e.ts',
    'e2e/rigs/streaming/r.ts',
    'e2e/rigs/streaming/r.test.ts',
    'e2e/rigs/frozenRig.ts',
    'src/app/stream/old.e2e.ts',
    'src/app/screen.ts',
    'src/app/chat/old.e2e.ts',
    'e2e/rigs/legacyRig.ts',
    'e2e/rigs/legacyRig.test.ts',
    'e2e/rigs/orphan.ts',
    'e2e/tests/x/y/z.e2e.ts',
    'e2e/tests/x/y/helper.ts'
  ]

  it('resolves relative imports, ignoring commented ones and missing files', function () {
    expect(importsOf('e2e/tests/x/y/z.e2e.ts', root)).deep.equals([
      'e2e/tests/x/y/helper.ts'
    ])
    expect(importsOf('e2e/tests/x/y/missing.ts', root)).deep.equals([])
    expect(
      [...importClosure(['src/app/stream/old.e2e.ts'], root)].sort()
    ).deep.equals([
      'e2e/rigs/frozenRig.ts',
      'src/app/screen.ts',
      'src/app/stream/old.e2e.ts'
    ])
  })

  it('computes the freeze from its roots: test-side files and their tests, not app code', function () {
    const freeze = computeFreeze(tracked, list, root)
    expect(freeze.roots.runners).deep.equals([
      'e2e/core/run.ts',
      'e2e/core/legacySweep.ts',
      'e2e/core/runLegacy.ts'
    ])
    expect(freeze.files).deep.equals([
      'e2e/core/legacySweep.ts',
      'e2e/core/run.ts',
      'e2e/core/runLegacy.ts',
      'e2e/core/shared.test.ts',
      'e2e/core/shared.ts',
      'e2e/rigs/frozenRig.ts',
      'e2e/rigs/streaming/r.test.ts',
      'e2e/rigs/streaming/r.ts',
      'e2e/tests/streaming/a/b.e2e.ts',
      'src/app/stream/old.e2e.ts'
    ])
  })

  it('fails a missing or stale committed freeze, and passes a fresh one', function () {
    expect(freezeProblems(tracked, list, root)).deep.equals([
      'e2e/streamingFreeze.json is missing: run `e2e freeze`'
    ])
    const freeze = computeFreeze(tracked, list, root)
    write(
      'e2e/streamingFreeze.json',
      renderFreeze({
        ...freeze,
        files: [...freeze.files.slice(1), 'e2e/old.ts']
      })
    )
    expect(freezeProblems(tracked, list, root)).deep.equals([
      'e2e/streamingFreeze.json differs from its roots (+e2e/core/legacySweep.ts, -e2e/old.ts): run `e2e freeze`'
    ])
    write('e2e/streamingFreeze.json', renderFreeze(freeze))
    expect(freezeProblems(tracked, list, root)).deep.equals([])
    expect(readFreeze(root)?.files).deep.equals(freeze.files)
  })

  it('skips a rig only a legacy module reaches, the freeze and unit tests, and reads the rest', function () {
    const frozen = new Set(computeFreeze(tracked, list, root).files)
    const waiting = legacyOnlyRigs(tracked, list, root)
    expect([...waiting]).deep.equals(['e2e/rigs/legacyRig.ts'])
    expect(infraProblems(root, tracked, frozen, waiting)).deep.equals([
      'e2e/rigs/orphan.ts: no-infra: line 1: reads process.env'
    ])
  })

  it('reads the same rig once a spec imports it', function () {
    write('e2e/tests/x/y/z.e2e.ts', "import '../../../rigs/legacyRig'\n")
    const frozen = new Set(computeFreeze(tracked, list, root).files)
    const waiting = legacyOnlyRigs(tracked, list, root)
    expect([...waiting]).deep.equals([])
    expect(infraProblems(root, tracked, frozen, waiting)).deep.equals([
      'e2e/rigs/legacyRig.ts: no-infra: line 1: imports child_process',
      'e2e/rigs/orphan.ts: no-infra: line 1: reads process.env'
    ])
  })
})
