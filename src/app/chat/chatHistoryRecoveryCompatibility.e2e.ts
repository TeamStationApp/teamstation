/** Real pinned browser builds share an upgraded API and retained key stores. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'

import express from 'express'
import { executablePath } from 'puppeteer'

import { TeamStationClient } from '../../common/api'
import { passwordBytes } from '../../common/passwordProtocol'
import { nativeArgon } from '../../server/auth/passwords'
import {
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'
import { readSeedTable } from '../../test/chatSeedTable'

interface Device extends MaestroDevice {
  detach: () => Promise<void>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
}
interface Daemon {
  attach: (options: Record<string, unknown>) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<void>
  close: () => Promise<void>
}
interface Build {
  source: string
  directory: string
  files: Record<string, string>
}

export async function mixedVersionRecovery(): Promise<void> {
  const fixtureFile = process.env.CHAT_RECOVERY_FIXTURE
  const buildsFile = process.env.CHAT_RECOVERY_BUILDS
  assert(fixtureFile != null && buildsFile != null)
  const f = JSON.parse(readFileSync(fixtureFile, 'utf8')) as {
    disposable: true
    source: string
    origin: string
    apiUrl: string
    seedFile: string
    artifacts: string
  }
  const builds = JSON.parse(readFileSync(buildsFile, 'utf8')) as {
    disposable: true
    baseline: Build
    current: Build
  }
  assert.equal(f.disposable, true)
  assert.equal(builds.disposable, true)
  assert.equal(builds.current.source, f.source)
  assert.notEqual(builds.baseline.source, f.source)
  for (const build of [builds.baseline, builds.current]) {
    assert(/^[a-f0-9]{40}$/.test(build.source))
    assert(isAbsolute(build.directory))
    for (const required of ['index.html', 'app.js', 'chat-crypto.wasm'])
      assert(build.files[required] != null)
    for (const [file, digest] of Object.entries(build.files)) {
      assert(!file.includes('..') && !isAbsolute(file))
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(build.directory, file)))
          .digest('hex'),
        digest
      )
    }
  }
  for (const value of [f.origin, f.apiUrl]) {
    const url = new URL(value)
    assert.equal(url.protocol, 'http:')
    assert(['localhost', '127.0.0.1'].includes(url.hostname))
  }
  const people = readSeedTable(readFileSync(f.seedFile, 'utf8'))
  for (const key of ['Ha', 'Hs'])
    assert(people[key].email.endsWith('@chat.example.com'))
  const name = process.env.MAESTRO_D
  assert(name != null)
  // A switch replaces only static app assets. The live API and each browser's
  // origin/key store stay unchanged, exactly as with an application upgrade.
  // Already-loaded clients keep their original JavaScript until restarted.
  let served = builds.baseline
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use((req, res, next) => express.static(served.directory)(req, res, next))
  app.get(/.*/, (_req, res) => {
    res.sendFile(join(served.directory, 'index.html'))
  })
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(new URL(f.origin).port), '127.0.0.1', resolve)
  })
  const devices = new Set<Device>()
  let daemon: Daemon | undefined
  async function attach(
    key: string,
    profile: string,
    build: Build
  ): Promise<Device> {
    served = build
    assert(daemon != null)
    const m = await daemon.attach({
      device: name + '-' + profile,
      platform: 'web',
      driver: 'cdp',
      url: f.origin,
      extra: {
        browser: executablePath(),
        windowSize: '1280x900',
        userDataDir: join(f.artifacts, 'profiles', profile)
      }
    })
    devices.add(m)
    await m.openLink({ link: f.origin })
    await m.assertVisible({
      css: 'input[aria-label="E-mail address"], [aria-label^="Account,"]',
      timeout: 30000
    })
    const signedOut = await m.evalBrowserScript({
      script:
        'return !!document.querySelector(\'input[aria-label="E-mail address"]\')'
    })
    if (signedOut.data === true || signedOut.data === 'true') {
      await m.tapOn({ css: 'input[aria-label="E-mail address"]' })
      await m.inputText({ text: people[key].email })
      await m.tapOn({ text: 'Use a password instead' })
      await m.tapOn({ css: 'input[aria-label="Password"]' })
      await m.inputText({ text: people[key].password })
      await m.tapOn({ text: 'Sign in' })
      await m.assertVisible({ text: 'Account,', timeout: 30000 })
    }
    await m.openLink({ link: f.origin + '/chat' })
    return m
  }
  async function close(m: Device): Promise<void> {
    await m.detach()
    devices.delete(m)
  }
  async function open(m: Device, id: string): Promise<void> {
    await m.openLink({ link: f.origin + '/chat/' + id })
    await m.assertVisible({
      css: '[data-testid="chat-message-history"]',
      timeout: 30000
    })
  }
  async function message(m: Device, text: string): Promise<void> {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const found = await m.evalBrowserScript({
        script: `return [...document.querySelectorAll('[data-testid^="chat-message-row-"]')].some(row => row.textContent.includes(${JSON.stringify(text)}))`
      })
      if (found.data === true || found.data === 'true') return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Expected retained message is absent from history')
  }
  async function send(m: Device, text: string): Promise<void> {
    await m.assertVisible({
      css: 'textarea[aria-label="Message"]:not([readonly])',
      timeout: 30000
    })
    await m.tapOn({ css: 'textarea[aria-label="Message"]' })
    await m.inputText({ text })
    await m.tapOn({ text: 'Send' })
    await message(m, text)
  }
  async function locked(m: Device, texts: string[]): Promise<void> {
    await m.assertVisible({ text: 'Locked message', timeout: 30000 })
    const body = String(
      (await m.evalBrowserScript({ script: 'return document.body.innerText' }))
        .data
    )
    for (const text of texts) assert(!body.includes(text))
  }
  const first = 'Earlier practice details from the retained client'
  const second = 'Earlier reply from the original recipient'
  const fresh = 'Fresh message from the replacement identity'
  const reply = 'Older client replies to the fresh message'
  try {
    daemon = (await maestroClient().MaestroD.connect({
      name,
      bin: process.env.MAESTRO_D_BIN
    })) as unknown as Daemon
    console.log(
      'E8: recording history with both clients on the pinned baseline build'
    )
    const holder = await attach('Ha', 'holder', builds.baseline)
    const original = await attach('Hs', 'original', builds.baseline)
    for (const m of [holder, original])
      await m.assertVisible({
        css: '[data-testid="chat-conversation-list"]',
        timeout: 30000
      })
    const client = new TeamStationClient({
      baseUrl: f.apiUrl,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await client.signInWithPassword(people.Ha.email, people.Ha.password)
    const dm = await client.createDm([people.Hs.userId])
    await open(holder, dm.id)
    await send(holder, first)
    await open(original, dm.id)
    await message(original, first)
    await send(original, second)
    await message(holder, second)
    const before = await client.chatEpochs(dm.id, 0)
    assert.equal(before.epochs.length, 1)
    await close(holder)
    await close(original)

    const recipient = await attach('Hs', 'replacement', builds.current)
    await recipient.assertVisible({ text: 'Link this device', timeout: 30000 })
    await recipient.tapOn({ text: 'I can’t reach my other devices' })
    await recipient.tapOn({ text: 'Reset chat on this device' })
    await recipient.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 30000
    })
    await open(recipient, dm.id)
    await send(recipient, fresh)
    await locked(recipient, [first, second])

    console.log(
      'E8: returning the older client without replacing its installed app or keys'
    )
    const legacy = await attach('Ha', 'holder', builds.baseline)
    await open(legacy, dm.id)
    for (const text of [first, second, fresh]) await message(legacy, text)
    await send(legacy, reply)
    await message(recipient, reply)
    await locked(recipient, [first, second])
    writeFileSync(
      join(f.artifacts, 'legacy-retains-history.png'),
      await legacy.screenshot()
    )
    await close(legacy)

    console.log(
      'E8: upgrading the retained holder and approving historical recovery'
    )
    const upgraded = await attach('Ha', 'holder', builds.current)
    await open(upgraded, dm.id)
    for (const text of [first, second, fresh, reply])
      await message(upgraded, text)
    await locked(recipient, [first, second])
    await upgraded.tapOn({ text: 'Review', timeout: 30000 })
    await upgraded.assertVisible({ text: 'OLD SAFETY WORDS', timeout: 30000 })
    await upgraded.tapOn({ text: 'Approve', timeout: 30000 })
    for (const text of [first, second, fresh, reply])
      await message(recipient, text)
    writeFileSync(
      join(f.artifacts, 'mixed-version-recovered.png'),
      await recipient.screenshot()
    )
    await close(recipient)
    const restarted = await attach('Hs', 'replacement', builds.current)
    await open(restarted, dm.id)
    for (const text of [first, second, fresh, reply])
      await message(restarted, text)
    const after = await client.chatEpochs(dm.id, 0)
    assert.deepEqual(after.epochs[0], before.epochs[0])
    assert.deepEqual(
      after.epochs.map(row => row.chainBreak),
      [false, true]
    )
    assert.equal(
      (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
        .length,
      4
    )
    writeFileSync(
      join(f.artifacts, 'mixed-build-results.json'),
      JSON.stringify(
        {
          baseline: builds.baseline,
          current: builds.current,
          retainedOrigin: f.origin,
          retainedStore: true,
          posts: 4,
          approvalRequired: true,
          restartReadable: true
        },
        null,
        2
      )
    )
    console.log(
      'PASS E8 web: pinned old client retains and replies to old/new history; upgrading the same profile enables approval and durable recipient recovery'
    )
  } finally {
    try {
      for (const m of devices) await m.detach().catch(() => {})
      await daemon?.shutdown({ wait: true })
      await daemon?.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
      )
    }
  }
}
