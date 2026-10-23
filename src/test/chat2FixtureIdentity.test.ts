import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { userIdOfGumbo, userIdOfValue } from '../common/userId'
import {
  asIdentityCompatibility,
  type Chat2Fixture,
  sourceBinding,
  verifyChat2HarnessSource
} from './chat2Fixture.e2e'

describe('identity compatibility driver descriptor', () => {
  const old = userIdOfGumbo(42)
  const full = userIdOfValue((1n << 127n) + 7n)
  const baseline = {
    actor: 'legacy',
    deviceId: 'cdv_legacy',
    identityId: 'cid_legacy',
    identityPublicKey: 'synthetic public key',
    pukGeneration: 2,
    pukPublicKey: 'synthetic public key',
    safetyNumber: '0'.repeat(60),
    text: { id: 'msg_text', seq: 4, body: 'Original text', authorId: old },
    reply: { id: 'msg_reply', seq: 5, body: 'Original reply', authorId: full },
    file: { id: 'msg_file', seq: 6, body: 'Original file', authorId: old },
    textMentions: [old, full],
    replyMentions: [old]
  }
  it('retains exact canonical IDs while message sequences and key generations remain numbers', () => {
    const input = { legacy: { ios: baseline }, fullWidthActors: ['full'] }
    expect(asIdentityCompatibility(input)).deep.equals(input)
  })
  it('rejects stale numeric or malformed account fields instead of coercing descriptor values', () => {
    for (const invalid of [42, '42', 'usr_bad', 0, null]) {
      expect(() =>
        asIdentityCompatibility({
          legacy: {
            ios: { ...baseline, text: { ...baseline.text, authorId: invalid } }
          },
          fullWidthActors: ['full']
        })
      ).throws()
      expect(() =>
        asIdentityCompatibility({
          legacy: { ios: { ...baseline, textMentions: [invalid] } },
          fullWidthActors: ['full']
        })
      ).throws()
    }
  })
})

describe('committed chat harness and application provenance', () => {
  const directories: string[] = []
  const harnessPath = 'src/test/chat2Maestro.e2e.ts'
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })
  function repository(): {
    root: string
    application: string
    git: (...args: string[]) => string
    write: (path: string, text: string) => void
    commit: (path: string) => string
  } {
    const root = mkdtempSync(join(tmpdir(), 'chat-harness-source-'))
    directories.push(root)
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    git('init', '--quiet')
    git('config', 'user.name', 'Fixture Author')
    git('config', 'user.email', 'fixture@example.test')
    write('src/app/index.tsx', 'export const application = 1\n')
    write(harnessPath, '// original test harness\n')
    git('add', 'src/app/index.tsx', harnessPath)
    git('commit', '--quiet', '-m', 'Application fixture')
    return {
      root,
      application: git('rev-parse', 'HEAD'),
      git,
      write,
      commit: path => {
        git('add', path)
        git('commit', '--quiet', '-m', 'Harness fixture')
        return git('rev-parse', 'HEAD')
      }
    }
  }
  function withSources<T>(
    application: string,
    harness: string | undefined,
    work: () => T
  ): T {
    const before = [process.env.CHAT2_SOURCE, process.env.CHAT2_HARNESS_SOURCE]
    process.env.CHAT2_SOURCE = application
    if (harness == null) delete process.env.CHAT2_HARNESS_SOURCE
    else process.env.CHAT2_HARNESS_SOURCE = harness
    try {
      return work()
    } finally {
      for (const [index, key] of [
        'CHAT2_SOURCE',
        'CHAT2_HARNESS_SOURCE'
      ].entries()) {
        if (before[index] == null) Reflect.deleteProperty(process.env, key)
        else process.env[key] = before[index]
      }
    }
  }
  function builtFixture(repo: ReturnType<typeof repository>): {
    fixture: Chat2Fixture
    artifact: string
    receipt: string
  } {
    const artifact = join(repo.root, '.git', 'application.js')
    const receipt = join(repo.root, '.git', 'build.json')
    const bytes = 'synthetic built application bytes\n'
    writeFileSync(artifact, bytes)
    const origin = 'http://localhost'
    const binding = {
      source: repo.application,
      artifact,
      receipt,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      apiUrl: origin,
      mediaOrigin: origin
    }
    writeFileSync(
      receipt,
      JSON.stringify({
        source: repo.application,
        apiUrl: origin,
        mediaOrigin: origin
      })
    )
    return {
      artifact,
      receipt,
      fixture: {
        allowedOrigins: [origin],
        bindings: { 'web-narrow': binding }
      } as unknown as Chat2Fixture
    }
  }
  it('retains strict default HEAD binding and records an explicit committed test-only delta without retagging the build', () => {
    const repo = repository()
    const { fixture } = builtFixture(repo)
    withSources(repo.application, undefined, () => {
      expect(
        sourceBinding(repo.root, fixture, 'web-narrow').harnessSource
      ).equals(repo.application)
    })
    repo.write(harnessPath, '// corrected test harness\n')
    const harness = repo.commit(harnessPath)
    withSources(repo.application, undefined, () => {
      expect(() => sourceBinding(repo.root, fixture, 'web-narrow')).throws(
        'harness source differ'
      )
    })
    withSources(repo.application, harness, () => {
      const result = sourceBinding(repo.root, fixture, 'web-narrow')
      expect(result.source).equals(repo.application)
      expect(result.applicationSource).equals(repo.application)
      expect(result.harnessSource).equals(harness)
      expect(result.binding.source).equals(repo.application)
      expect(result.changedTestFiles).deep.equals([
        {
          path: harnessPath,
          sha256: createHash('sha256')
            .update('// corrected test harness\n')
            .digest('hex')
        }
      ])
      const diff = execFileSync(
        'git',
        [
          'diff',
          '--no-ext-diff',
          '--binary',
          '--full-index',
          repo.application,
          harness,
          '--'
        ],
        { cwd: repo.root }
      )
      expect(result.harnessDiffSha256).equals(
        createHash('sha256').update(diff).digest('hex')
      )
    })
  })
  it('permits only the exact isolated DM-summary spec while retaining original application binding', () => {
    const repo = repository()
    const { fixture } = builtFixture(repo)
    const path = 'src/app/chat/engine/dmTitle.test.ts'
    const text = '// isolated public engine summary regression\n'
    repo.write(path, text)
    const harness = repo.commit(path)
    withSources(repo.application, harness, () => {
      const result = sourceBinding(repo.root, fixture, 'web-narrow')
      expect(result.source).equals(repo.application)
      expect(result.harnessSource).equals(harness)
      expect(result.binding.source).equals(repo.application)
      expect(result.changedTestFiles).deep.equals([
        { path, sha256: createHash('sha256').update(text).digest('hex') }
      ])
    })
    repo.write(
      'src/app/chat/engine/engine.ts',
      '// changed production engine\n'
    )
    const changed = repo.commit('src/app/chat/engine/engine.ts')
    expect(() =>
      verifyChat2HarnessSource(repo.root, repo.application, changed)
    ).throws('new build and capture archive')
  })
  it('rejects wrong revisions, dirty tracked bytes and unrelated history', () => {
    const repo = repository()
    expect(() =>
      verifyChat2HarnessSource(repo.root, repo.application, '0'.repeat(40))
    ).throws('harness source differ')
    repo.write(harnessPath, '// uncommitted\n')
    expect(() =>
      verifyChat2HarnessSource(repo.root, repo.application, repo.application)
    ).throws('frozen tracked source')
    const harness = repo.commit(harnessPath)
    expect(() => verifyChat2HarnessSource(repo.root, 'short', harness)).throws(
      'application source SHA'
    )
    repo.git('checkout', '--orphan', 'unrelated')
    repo.git('commit', '--quiet', '-m', 'Unrelated history')
    expect(() =>
      verifyChat2HarnessSource(
        repo.root,
        repo.application,
        repo.git('rev-parse', 'HEAD')
      )
    ).throws('ancestor')
  })
  for (const path of ['src/app/index.tsx', 'src/test/unexpected.e2e.ts'])
    it('rejects an application or unlisted test delta: ' + path, () => {
      const repo = repository()
      repo.write(path, '// unauthorized delta\n')
      const harness = repo.commit(path)
      expect(() =>
        verifyChat2HarnessSource(repo.root, repo.application, harness)
      ).throws('new build and capture archive')
    })
  it('keeps original artifact and receipt verification after an allowed harness edit', () => {
    const repo = repository()
    const { fixture, artifact, receipt } = builtFixture(repo)
    repo.write(harnessPath, '// corrected test harness\n')
    const harness = repo.commit(harnessPath)
    withSources(repo.application, harness, () => {
      writeFileSync(artifact, 'changed built bytes')
      expect(() => sourceBinding(repo.root, fixture, 'web-narrow')).throws(
        'artifact changed'
      )
      const original = 'synthetic built application bytes\n'
      writeFileSync(artifact, original)
      writeFileSync(receipt, JSON.stringify({ source: harness }))
      expect(() => sourceBinding(repo.root, fixture, 'web-narrow')).throws(
        'receipt source differs'
      )
    })
  })
})
