import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import ts from 'typescript'

import {
  asIdentityCompatibility,
  CHAT2_APPLICATION_TEST_FILES,
  CHAT2_SURFACES,
  type Chat2Fixture,
  isChat2HarnessPath,
  requireAfterArchive,
  sourceBinding,
  verifyChat2HarnessSource
} from '../../e2e/fixtures/chat2Fixture'
import { userIdOfGumbo, userIdOfValue } from '../common/userId'

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
    expect(asIdentityCompatibility(input)).deep.equals({
      ...input,
      i2Target: undefined
    })
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
  const harnessPath = 'e2e/rigs/chat2Maestro.ts'
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
  for (const path of [
    'src/app/index.tsx',
    'src/server/chat/titles.ts',
    'src/test/legacyChatKeyRecord.json',
    'src/app/scoring/scoringModals.preview.tsx',
    'scripts/chat-e2e-reset.sh',
    'scripts/e2e/scoreboardLog/e5Browser.ts'
  ])
    it('rejects an application delta: ' + path, () => {
      const repo = repository()
      repo.write(path, '// unauthorized delta\n')
      const harness = repo.commit(path)
      expect(() =>
        verifyChat2HarnessSource(repo.root, repo.application, harness)
      ).throws('new build and capture archive')
    })
  for (const path of [
    'src/test/unexpected.e2e.ts',
    'src/app/chat/chat.e2e.ts',
    'src/app/chat/chatPhones.e2e.ts',
    'src/app/chat/chatUi.test.tsx',
    'src/server/chat/chat2Identity.test.ts',
    'src/test/chatRows.ts',
    'scripts/e2e/scoreboardLog/e5Browser.e2e.ts',
    'scripts/chatBench.e2e.mjs'
  ])
    it('accepts a delta no application build takes in: ' + path, () => {
      const repo = repository()
      const text = '// harness-only delta\n'
      repo.write(path, text)
      const harness = repo.commit(path)
      const result = verifyChat2HarnessSource(
        repo.root,
        repo.application,
        harness
      )
      expect(result.applicationSource).equals(repo.application)
      expect(result.changedTestFiles).deep.equals([
        { path, sha256: createHash('sha256').update(text).digest('hex') }
      ])
    })
  it('rejects a harness delta that carries an application change with it', () => {
    const repo = repository()
    repo.write('src/app/chat/chat.e2e.ts', '// harness\n')
    repo.write('src/app/chat/ChatListScreen.tsx', '// application\n')
    repo.git('add', 'src/app/chat/chat.e2e.ts')
    const harness = repo.commit('src/app/chat/ChatListScreen.tsx')
    expect(() =>
      verifyChat2HarnessSource(repo.root, repo.application, harness)
    ).throws('new build and capture archive')
  })
  it('names the harness by test paths, keeping its six named files', () => {
    for (const path of [
      'src/app/chat/chat2.e2e.ts',
      'e2e/rigs/chat2Maestro.ts',
      'e2e/fixtures/chat2Fixture.ts',
      'e2e/core/run.ts',
      'e2e/tests/chat/any.e2e.ts',
      'src/app/chat/chat2Actions.test.ts',
      'src/test/chat2FixtureIdentity.test.ts',
      'src/app/chat/engine/dmTitle.test.ts',
      'src/test/fixtures/anything.json',
      'scripts/socket.e2e.ts'
    ])
      expect(isChat2HarnessPath(path), path).equals(true)
    for (const path of [
      'src/app/chat/chat2.ts',
      'src/app/chat/test.ts',
      'src/app/chat/e2e.ts',
      'src/app/chat/chat.e2e.ts.orig',
      'src/app/chat/chat.testing.ts',
      'src/app/scoring/scoringRosterEdit.fixture.ts',
      'src/apptest/x.ts',
      'scripts/socket.e2e/x.ts',
      'scripts/chat-socket-listen.mjs',
      'test/src/x.ts',
      ...CHAT2_APPLICATION_TEST_FILES
    ])
      expect(isChat2HarnessPath(path), path).equals(false)
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

/**
 * Every file an application build can take in: the web bundle's entries
 * (`src/build.mjs`), the native one (`index.js`, through Metro), and the
 * server's (`npm start`) with the stats builder it forks. Each relative
 * `import`, `require` and `import()` is followed into every platform twin
 * that exists (`.web`, `.native`, `.ios`, `.android`) as well as the plain
 * file, so the set covers every bundler and platform at once.
 */
function applicationFiles(root: string): string[] {
  const entries = [
    'src/app/web/index.tsx',
    'src/app/platform/passwordWorker.ts',
    'index.js',
    'src/server/index.ts',
    'src/server/statsBuilder/start.ts'
  ]
  const twins = ['.web', '.native', '.ios', '.android', '']
  const extensions = ['.tsx', '.ts', '.jsx', '.js', '.cjs', '.mjs', '.json']
  const isFile = (path: string): boolean =>
    existsSync(path) && statSync(path).isFile()
  const resolveAll = (from: string, specifier: string): string[] => {
    const base = resolve(dirname(from), specifier)
    const found = isFile(base) ? [base] : []
    // An image, which Metro reads at the scales beside it (`name@2x.png`).
    const image = /^(.*)(\.(?:png|jpe?g|gif|webp))$/.exec(base)
    if (image != null)
      for (const scale of ['@1x', '@2x', '@3x'])
        if (isFile(image[1] + scale + image[2]))
          found.push(image[1] + scale + image[2])
    for (const stem of [base, join(base, 'index')])
      for (const twin of twins)
        for (const extension of extensions)
          if (isFile(stem + twin + extension))
            found.push(stem + twin + extension)
    return found
  }
  const seen = new Set<string>()
  const pending = entries.map(entry => join(root, entry))
  for (let file = pending.pop(); file != null; file = pending.pop()) {
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const { importedFiles } = ts.preProcessFile(
      readFileSync(file, 'utf8'),
      true,
      true
    )
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith('.')) continue
      const targets = resolveAll(file, fileName)
      expect(
        targets.length,
        `${relative(root, file)} imports ${fileName}`
      ).greaterThan(0)
      pending.push(...targets)
    }
  }
  return [...seen].map(file => relative(root, file)).sort()
}

describe('what an application build is made of', () => {
  it('takes in no harness path from the web, native or server entries', function () {
    this.timeout(60000)
    const files = applicationFiles(join(__dirname, '..', '..'))
    expect(files).includes('src/app/App.tsx')
    expect(files).includes('src/server/chat/listing.ts')
    expect(files.filter(isChat2HarnessPath)).deep.equals([])
    // Each exception is one a build really takes in, or it is stale.
    for (const path of CHAT2_APPLICATION_TEST_FILES)
      expect(files, path).includes(path)
  })
})

describe('matched AFTER archive before an account switch', () => {
  const kinds = [
    'chat-list',
    'conversation',
    'floating-pins',
    'message-actions',
    'reply-keyboard',
    'info',
    'info-members',
    'mentions',
    'mention-composer',
    'attention'
  ]
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1])
  const current = 'a'.repeat(40)
  const earlier = 'b'.repeat(40)
  const roots: string[] = []
  const previous = process.env.CHAT2_SOURCE
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
    if (previous == null) delete process.env.CHAT2_SOURCE
    else process.env.CHAT2_SOURCE = previous
  })
  function archive(sourceOf: (file: string) => string): {
    fixture: Chat2Fixture
    root: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'chat2-after-archive-'))
    roots.push(root)
    const files = CHAT2_SURFACES.filter(s => s !== 'web-320')
      .flatMap(s => kinds.map(k => s + '-' + k + '-after.png'))
      .concat([
        'ios-keyboard-pins-after.png',
        'android-keyboard-pins-after.png',
        'web-320-composer-after.png'
      ])
    const entries = files.map(file => {
      const path = join(root, file)
      writeFileSync(path, png, { mode: 0o600 })
      return {
        file,
        path,
        source: sourceOf(file),
        sha256: createHash('sha256').update(png).digest('hex')
      }
    })
    const index = join(root, 'proof-index.json')
    writeFileSync(index, JSON.stringify({ entries }), { mode: 0o600 })
    process.env.CHAT2_SOURCE = current
    return {
      fixture: { afterArchive: index } as unknown as Chat2Fixture,
      root
    }
  }

  it('requires every frame at the current source for an ordinary switch', () => {
    const { fixture } = archive(file =>
      file.startsWith('android-') ? earlier : current
    )
    expect(() => {
      requireAfterArchive(fixture)
    }).throws('Archived AFTER source differs')
    expect(() => {
      requireAfterArchive(fixture, 'ios')
    }).throws('Archived AFTER source differs')
  })

  it('lets a capture of one surface switch while its own intact frames are older', () => {
    const { fixture, root } = archive(file =>
      file.startsWith('android-') ? earlier : current
    )
    requireAfterArchive(fixture, 'android')
    writeFileSync(
      join(root, 'android-chat-list-after.png'),
      Buffer.from(png).fill(2, 9)
    )
    expect(() => {
      requireAfterArchive(fixture, 'android')
    }).throws('Archived AFTER image changed')
  })

  it('keeps an owner-excluded surface at its archived frames, and only that one', () => {
    const saved = process.env.CHAT2_OUT_OF_SCOPE_SURFACES
    try {
      process.env.CHAT2_OUT_OF_SCOPE_SURFACES = 'android,unknown'
      const { fixture, root } = archive(file =>
        file.startsWith('android-') ? earlier : current
      )
      requireAfterArchive(fixture)
      const other = archive(file =>
        file.startsWith('ios-') ? earlier : current
      )
      expect(() => {
        requireAfterArchive(other.fixture)
      }).throws('Archived AFTER source differs')
      writeFileSync(
        join(root, 'android-chat-list-after.png'),
        Buffer.from(png).fill(2, 9)
      )
      expect(() => {
        requireAfterArchive(fixture)
      }).throws('Archived AFTER image changed')
    } finally {
      if (saved == null) delete process.env.CHAT2_OUT_OF_SCOPE_SURFACES
      else process.env.CHAT2_OUT_OF_SCOPE_SURFACES = saved
    }
  })
})
