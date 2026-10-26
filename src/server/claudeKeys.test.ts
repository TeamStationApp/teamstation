import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  chatTestAnthropic,
  CLAUDE_TEST_ITEM,
  claudeTestKey,
  installProcessClaudeKeys,
  requireScoringTestKey,
  scoringTestAnthropic
} from './claudeKeys'

const repo = join(__dirname, '..', '..')

describe('Claude test keys', function () {
  const root = mkdtempSync(join(tmpdir(), 'claude-keys-'))

  after(function () {
    rmSync(root, { recursive: true })
  })

  it('reads the test item for that product', function () {
    const seen: string[] = []
    const run = (_command: string, args: readonly string[]): string => {
      seen.push(args.join(' '))
      return '  test-key-value \n'
    }
    expect(claudeTestKey('scoring', {}, run)).equals('test-key-value')
    expect(claudeTestKey('chat', { OP_CLI: 'custom-op' }, run)).equals(
      'test-key-value'
    )
    expect(seen).deep.equals([
      `read op://Teamstation/${CLAUDE_TEST_ITEM.scoring}/credential`,
      `read op://Teamstation/${CLAUDE_TEST_ITEM.chat}/credential`
    ])
    expect(claudeTestKey('scoring', {}, () => '   ')).equals(undefined)
    expect(
      claudeTestKey('scoring', {}, () => {
        throw new Error('unavailable')
      })
    ).equals(undefined)
  })

  it('runs the CLI named by OP_CLI', function () {
    const direct = join(root, 'direct.mjs')
    writeFileSync(
      direct,
      '#!/usr/bin/env node\n' +
        'const url = process.argv[2] === "read" ? process.argv[3] : ""\n' +
        'if (!url.endsWith("Claude API key - chat - test/credential")) process.exit(3)\n' +
        'console.log("chat-test-placeholder\\n")\n',
      { mode: 0o700 }
    )
    chmodSync(direct, 0o700)
    expect(claudeTestKey('chat', { OP_CLI: direct })).equals(
      'chat-test-placeholder'
    )
  })

  it('takes the test key and the config base URL, never the config key', function () {
    const file = join(root, 'server.json')
    writeFileSync(
      file,
      JSON.stringify({
        dictation: {
          anthropic: {
            apiKey: 'production-scoring-key',
            baseUrl: 'https://scoring.example.test/v1'
          }
        },
        tess: {
          apiKey: 'production-chat-key',
          baseUrl: 'https://chat.example.test/v1'
        }
      })
    )
    const env = { TS_DICTATION_CONFIG: file, TS_TESS_CONFIG: file }
    expect(
      scoringTestAnthropic(env, () => 'scoring-test-placeholder')
    ).deep.equals({
      apiKey: 'scoring-test-placeholder',
      baseUrl: 'https://scoring.example.test/v1'
    })
    expect(chatTestAnthropic(env, () => 'chat-test-placeholder')).deep.equals({
      apiKey: 'chat-test-placeholder',
      baseUrl: 'https://chat.example.test/v1'
    })
    expect(
      scoringTestAnthropic(
        { TS_DICTATION_CONFIG: join(root, 'missing.json') },
        () => 'scoring-test-placeholder'
      )
    ).deep.equals({
      apiKey: 'scoring-test-placeholder',
      baseUrl: 'https://api.anthropic.com/v1'
    })
    expect(scoringTestAnthropic(env, () => '')).equals(undefined)
    expect(() => requireScoringTestKey(env, () => '')).throws(
      /scoring test key/
    )
  })

  it('leaves production keys in place until a test process asks', function () {
    const config = {
      dictation: { anthropic: { apiKey: 'scoring-prod-placeholder' } },
      tess: { apiKey: 'chat-prod-placeholder' }
    }
    let reads = 0
    installProcessClaudeKeys(config, {}, () => {
      reads += 1
      return 'unused'
    })
    expect(reads).equals(0)
    expect(config.dictation.anthropic.apiKey).equals('scoring-prod-placeholder')
    expect(config.tess.apiKey).equals('chat-prod-placeholder')

    installProcessClaudeKeys(config, { TS_CLAUDE_KEYS: 'test' }, product =>
      product === 'scoring'
        ? 'scoring-test-placeholder'
        : 'chat-test-placeholder'
    )
    expect(config.dictation.anthropic.apiKey).equals('scoring-test-placeholder')
    expect(config.tess.apiKey).equals('chat-test-placeholder')
  })

  it('refuses to keep a configured key when the test key is missing', function () {
    const config = {
      dictation: { anthropic: { apiKey: 'scoring-prod-placeholder' } },
      tess: { apiKey: 'chat-prod-placeholder' }
    }
    expect(() => {
      installProcessClaudeKeys(
        config,
        { TS_CLAUDE_KEYS: 'test' },
        () => undefined
      )
    }).throws(/scoring test key/)
    expect(config.dictation.anthropic.apiKey).equals('scoring-prod-placeholder')
  })

  it('skips a product the server is not configured for', function () {
    const config: { tess?: { apiKey?: string } } = { tess: { apiKey: '' } }
    installProcessClaudeKeys(config, { TS_CLAUDE_KEYS: 'test' }, () => {
      throw new Error('should not be read')
    })
    expect(config.tess?.apiKey).equals('')
  })
})

describe('claudeKeys.mjs', function () {
  const root = mkdtempSync(join(tmpdir(), 'claude-keys-script-'))
  const op = join(root, 'op.mjs')
  const wrapper = join(root, 'wrap.mjs')
  const reads = join(root, 'reads.txt')

  after(function () {
    rmSync(root, { recursive: true })
  })

  function writeOp(): void {
    writeFileSync(
      op,
      [
        'import { appendFileSync } from "node:fs"',
        `const log = ${JSON.stringify(reads)}`,
        'const args = process.argv.slice(2)',
        'if (args[0] === "item") {',
        '  console.log(JSON.stringify([',
        '    { id: "scoring-prod", title: "Claude API key - scoring " },',
        '    { id: "scoring-test", title: "Claude API key - scoring - test" },',
        '    { id: "chat-prod", title: "Claude API key - chat " },',
        '    { id: "chat-test", title: "Claude API key - chat - test" },',
        '    { id: "recap-prod", title: "Claude API key - recap " },',
        '    { id: "recap-test", title: "Claude API key - recap - test" }',
        '  ]))',
        '  process.exit(0)',
        '}',
        'appendFileSync(log, String(args[1]) + "\\n")',
        'const id = String(args[1]).split("/")[3]',
        'if (id.includes("recap")) process.exit(3)',
        'console.log("key-" + id)'
      ].join('\n')
    )
    writeFileSync(
      wrapper,
      '#!/usr/bin/env node\n' +
        'import { spawnSync } from "node:child_process"\n' +
        `const child = spawnSync(process.execPath, [${JSON.stringify(op)}, ...process.argv.slice(2)], { encoding: "utf8" })\n` +
        'process.stdout.write(child.stdout ?? "")\n' +
        'process.stderr.write(child.stderr ?? "")\n' +
        'process.exit(child.status ?? 1)\n',
      { mode: 0o700 }
    )
    chmodSync(wrapper, 0o700)
  }

  function apply(
    mode: string,
    body: unknown
  ): {
    status: number | null
    stderr: string
    json: Record<string, unknown>
    asked: string
  } {
    writeOp()
    writeFileSync(reads, '')
    const file = join(root, `cfg-${mode}.json`)
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
    const result = spawnSync(
      process.execPath,
      ['scripts/claudeKeys.mjs', mode, file],
      {
        cwd: repo,
        env: { ...process.env, OP_CLI: wrapper },
        encoding: 'utf8'
      }
    )
    return {
      status: result.status,
      stderr: result.stderr,
      json: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
      asked: readFileSync(reads, 'utf8')
    }
  }

  it('writes the production pair, and the test chat key for interactive use', function () {
    const prod = apply('production', {
      dictation: { apiKey: 'xai-placeholder' },
      keep: 'yes'
    })
    expect(prod.status, prod.stderr).equals(0)
    const written = prod.json as {
      dictation: { apiKey: string; anthropic: { apiKey: string } }
      tess: { apiKey: string }
      keep: string
    }
    expect(written.dictation.apiKey).equals('xai-placeholder')
    expect(written.dictation.anthropic.apiKey).equals('key-scoring-prod')
    expect(written.tess.apiKey).equals('key-chat-prod')
    expect(written.keep).equals('yes')
    expect(prod.asked.includes('recap')).equals(false)
    expect(prod.asked.includes('scoring-prod')).equals(true)
    expect(prod.asked.includes('chat-prod')).equals(true)

    const interactive = apply('interactive', {
      dictation: { apiKey: 'xai-placeholder', anthropic: { apiKey: 'old' } }
    })
    expect(interactive.status, interactive.stderr).equals(0)
    const seated = interactive.json as {
      dictation: { apiKey: string; anthropic: { apiKey: string } }
      tess: { apiKey: string }
    }
    expect(seated.dictation.apiKey).equals('xai-placeholder')
    expect(seated.dictation.anthropic.apiKey).equals('key-scoring-prod')
    expect(seated.tess.apiKey).equals('key-chat-test')

    const tests = apply('test', {
      dictation: { apiKey: 'xai-placeholder' }
    })
    expect(tests.status, tests.stderr).equals(0)
    const tested = tests.json as {
      dictation: { anthropic: { apiKey: string } }
      tess: { apiKey: string }
    }
    expect(tested.dictation.anthropic.apiKey).equals('key-scoring-test')
    expect(tested.tess.apiKey).equals('key-chat-test')
    expect(tests.asked.includes('recap')).equals(false)
  })

  it('sets the chat test key when an interactive server has no dictation', function () {
    const result = apply('interactive', { listenPort: 9100 })
    expect(result.status, result.stderr).equals(0)
    expect(result.stderr).matches(/no dictation/)
    const written = result.json as {
      tess: { apiKey: string }
      listenPort: number
    }
    expect(written.tess.apiKey).equals('key-chat-test')
    expect(written.listenPort).equals(9100)
    expect(result.asked.includes('scoring')).equals(false)
  })

  it('rewrites a full server config into the form the server accepts', function () {
    this.timeout(20000)
    const result = apply('production', {
      databaseUrl: 'postgres://db.example.test/app',
      dictation: { apiKey: 'xai-placeholder' }
    })
    expect(result.status, result.stderr).equals(0)
    const written = result.json as {
      databaseUrl: string
      dictation: {
        apiKey: string
        anthropic: { apiKey: string; baseUrl: string }
      }
      tess: { apiKey: string; baseUrl: string; model: string }
    }
    expect(written.databaseUrl).equals('postgres://db.example.test/app')
    expect(written.dictation.apiKey).equals('xai-placeholder')
    expect(written.dictation.anthropic.apiKey).equals('key-scoring-prod')
    expect(written.dictation.anthropic.baseUrl).equals(
      'https://api.anthropic.com/v1'
    )
    expect(written.tess).deep.equals({
      apiKey: 'key-chat-prod',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5-5'
    })
  })

  it('refuses a full config the server would reject', function () {
    this.timeout(20000)
    const result = apply('production', {
      databaseUrl: 'postgres://db.example.test/app',
      listenPort: 'nope',
      dictation: { apiKey: 'xai-placeholder' }
    })
    expect(result.status).equals(1)
    expect(result.stderr).matches(/could not be rewritten/)
    const written = result.json as {
      dictation: { anthropic: { apiKey: string } }
    }
    expect(written.dictation.anthropic.apiKey).equals('key-scoring-prod')
  })

  it('refuses a production file with no dictation section', function () {
    const file = join(root, 'nodict.json')
    writeFileSync(file, '{}\n')
    writeOp()
    const result = spawnSync(
      process.execPath,
      ['scripts/claudeKeys.mjs', 'production', file],
      {
        cwd: repo,
        env: { ...process.env, OP_CLI: wrapper },
        encoding: 'utf8'
      }
    )
    expect(result.status).equals(1)
    expect(result.stderr).matches(/no dictation/)
    expect(readFileSync(file, 'utf8')).equals('{}\n')
  })
})
