import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  MODEL_TESTS,
  modelConfig,
  runModels,
  settingsSecret
} from './testModels.mjs'

describe('testModels', function () {
  let dir: string

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'test-models-'))
  })

  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports every model file skipped when there is no key, and exits 2', function () {
    const ran: string[] = []
    const result = runModels(
      {},
      () => null,
      () => {
        ran.push('ran')
        return { status: 0 }
      }
    )
    expect(result.code).equals(2)
    expect(ran).deep.equals([])
    expect(result.lines).lengthOf(MODEL_TESTS.length)
    for (const line of result.lines) expect(line).match(/^skipped\t/)
  })

  it('runs each file with the config the environment names', function () {
    const seen: Array<{ file: string; env: Record<string, string> }> = []
    const result = runModels(
      { TS_DICTATION_CONFIG: '/keys/dictation.json' },
      () => {
        throw new Error('not asked when the environment names a config')
      },
      (
        _node: string,
        args: string[],
        options: { env: Record<string, string> }
      ) => {
        seen.push({ file: args.at(-1) ?? '', env: options.env })
        const file = args.at(-1) ?? ''
        // promptCases fails both times; dictatedDefense fails once, then passes.
        if (file.includes('promptCases')) return { status: 1 }
        if (file.includes('dictatedDefense'))
          return {
            status: seen.filter(run => run.file === file).length === 1 ? 1 : 0
          }
        return { status: 0 }
      }
    )
    // Each failed file ran a second time, right after the first.
    expect(seen.map(run => run.file)).deep.equals(
      MODEL_TESTS.flatMap(({ file }) =>
        file.includes('promptCases') || file.includes('dictatedDefense')
          ? [file, file]
          : [file]
      )
    )
    expect(seen.at(-1)?.env.TS_TESS_CONFIG).equals('/keys/dictation.json')
    expect(result.code).equals(1)
    expect(result.lines.filter(line => line.startsWith('failed\t'))).lengthOf(1)
    expect(
      result.lines.filter(line => line.startsWith('passed-on-retry\t'))
    ).lengthOf(1)
  })

  it('writes the secret into a private config for the run and removes it', function () {
    const config = modelConfig({}, () => 'sk-test')
    expect(config).not.equals(null)
    const written = config!.file
    config!.cleanup()
    const result = runModels(
      {},
      () => 'sk-test',
      () => ({ status: 0 })
    )
    expect(result.code).equals(0)
    expect(written).match(/dictation\.json$/)
  })

  it('reads the anthropic secret through the end-to-end settings', function () {
    const secrets = join(dir, 'secrets.json')
    const settings = join(dir, 'local.json')
    expect(settingsSecret({ E2E_LOCAL_SETTINGS: settings })).equals(null)
    writeFileSync(settings, JSON.stringify({ secretsFile: secrets }))
    expect(settingsSecret({ E2E_LOCAL_SETTINGS: settings })).equals(null)
    writeFileSync(secrets, JSON.stringify({ anthropic: '' }))
    expect(settingsSecret({ E2E_LOCAL_SETTINGS: settings })).equals(null)
    writeFileSync(secrets, JSON.stringify({ anthropic: 'sk-test' }))
    expect(settingsSecret({ E2E_LOCAL_SETTINGS: settings })).equals('sk-test')
    mkdirSync(join(dir, 'empty'))
    writeFileSync(join(dir, 'empty', 'local.json'), '{}')
    expect(
      settingsSecret({ E2E_LOCAL_SETTINGS: join(dir, 'empty', 'local.json') })
    ).equals(null)
  })
})
