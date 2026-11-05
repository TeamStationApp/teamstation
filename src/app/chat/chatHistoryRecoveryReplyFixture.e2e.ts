/** Normal browser enrollment and isolated reply fixtures for recovery regressions. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { executablePath } from 'puppeteer'

import { readSeedTable } from '../../test/chatSeedTable'

interface Device {
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (options: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  assertVisible: (options: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
  screenshot: () => Promise<Uint8Array>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<unknown>
}
interface Setup {
  synthetic: true
  source: string
  origin: string
  apiUrl: string
  seedFile: string
  artifacts: string
  protectedConversation: string
  profiles: Record<string, string>
  incoming: string
  small: string
}
let privateErrorFile: string | undefined
function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', name + ' is required')
  return value
}
async function read<T>(device: Device, script: string): Promise<T> {
  const result = await device.evalBrowserScript({ script })
  return (
    typeof result.data === 'string' ? JSON.parse(result.data) : result.data
  ) as T
}
async function main(): Promise<void> {
  const setup = JSON.parse(
    readFileSync(required('CHAT_RECOVERY_REPLY_SETUP'), 'utf8')
  ) as Setup
  assert.equal(setup.synthetic, true)
  assert.equal(
    setup.source,
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  )
  for (const url of [setup.origin, setup.apiUrl])
    assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  for (const path of [
    setup.seedFile,
    setup.incoming,
    setup.small,
    ...Object.values(setup.profiles)
  ])
    assert(resolve(path).startsWith(resolve(setup.artifacts) + '/'))
  const mode = process.argv[2]
  assert(['enroll', 'incoming', 'paging-target'].includes(mode))
  privateErrorFile = join(setup.artifacts, mode + '-setup-error.log')
  const people = readSeedTable(readFileSync(setup.seedFile, 'utf8'))
  const origin = setup.origin.replace(/\/+$/, '')
  const { MaestroD } = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )('maestro-d') as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    bin: required('MAESTRO_D_BIN'),
    idleTimeout: 0
  })
  const active = new Set<Device>()
  const attach = async (key: string): Promise<Device> => {
    const person = people[key]
    assert(person?.email.endsWith('@chat.example.com'))
    assert(setup.profiles[key] != null)
    const m = await daemon.attach({
      device: 'recovery-reply-fixture-' + key,
      platform: 'web',
      driver: 'cdp',
      url: origin,
      artifacts: 'none',
      extra: {
        browser: executablePath(),
        windowSize: '1440x1000',
        userDataDir: setup.profiles[key]
      }
    })
    active.add(m)
    await m.openLink({ link: origin })
    const auth = await read<string | null>(
      m,
      `const r=await fetch(${JSON.stringify(setup.apiUrl + '/auth/me')},{credentials:'include'});return JSON.stringify(r.ok?(await r.json()).id:null)`
    )
    if (auth == null) {
      await m.assertVisible({ text: 'Use a password instead', timeout: 30000 })
      await m.tapOn({ css: 'input[aria-label="E-mail address"]' })
      await m.inputText({ text: person.email })
      await m.tapOn({ text: 'Use a password instead' })
      await m.tapOn({ css: 'input[aria-label="Password"]' })
      await m.inputText({ text: person.password })
      await m.tapOn({ text: 'Sign in' })
    } else
      assert.equal(auth, person.userId, 'The profile belongs to another actor')
    await m.assertVisible({ text: 'Account,', timeout: 30000 })
    await m.openLink({ link: origin + '/chat' })
    // Give the cold crypto module a rendering interval before the driver's
    // accessibility polling. The readiness assertion remains authoritative.
    await m.evalBrowserScript({
      script: 'await new Promise(r=>setTimeout(r,8000));return true'
    })
    await m.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 60000
    })
    assert.equal(
      await read(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/auth/me')},{credentials:'include'});if(!r.ok)throw new Error('Fixture session unavailable');return JSON.stringify((await r.json()).id)`
      ),
      person.userId
    )
    return m
  }
  const close = async (m: Device): Promise<void> => {
    await m.detach()
    active.delete(m)
  }
  const save = (path: string, data: object): void => {
    assert(!existsSync(path), 'Do not overwrite an existing fixture receipt')
    writeFileSync(path, JSON.stringify(data, null, 2), {
      flag: 'wx',
      mode: 0o600
    })
  }
  try {
    if (mode === 'enroll') {
      for (const key of ['Hc', 'Hs', 'Ha']) {
        await close(await attach(key))
        console.log('Normal browser enrollment ready: ' + key)
      }
      save(join(setup.artifacts, 'enrollment.json'), {
        source: setup.source,
        actors: ['Hc', 'Hs', 'Ha'],
        normalUi: true
      })
      return
    }
    const enrollment = JSON.parse(
      readFileSync(join(setup.artifacts, 'enrollment.json'), 'utf8')
    )
    assert.equal(enrollment.source, setup.source)
    assert.equal(enrollment.normalUi, true)
    const m = await attach('Hc')
    const candidate = await read<{ shortName: string } | null>(
      m,
      `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/dm-candidates')},{credentials:'include'});if(!r.ok)throw new Error('Candidate list unavailable');return JSON.stringify((await r.json()).find(p=>p.userId===${JSON.stringify(people.Hs.userId)})??null)`
    )
    assert(candidate != null)
    await m.tapOn({ text: 'New message' })
    await m.tapOn({
      css:
        '[role="button"][aria-label=' +
        JSON.stringify('Pick ' + candidate.shortName) +
        ']'
    })
    await m.tapOn({ text: 'Start conversation' })
    await m.assertVisible({
      css: '[data-testid="chat-composer"]',
      timeout: 30000
    })
    const conversationId = await read<string>(
      m,
      'return JSON.stringify(location.pathname.split("/")[2])'
    )
    assert(conversationId.startsWith('cnv_'))
    assert.notEqual(conversationId, setup.protectedConversation)
    const posts = async (): Promise<Array<{ id: string }>> =>
      await read(
        m,
        `const r=await fetch(${JSON.stringify(setup.apiUrl + '/chat/conversations/' + conversationId + '/messages')},{credentials:'include'});if(!r.ok)throw new Error('Fixture posts unavailable');return JSON.stringify((await r.json()).filter(x=>x.kind==='post').map(x=>({id:x.id})))`
      )
    assert.equal((await posts()).length, 0, 'A fresh isolated DM is required')
    const send = async (body: string): Promise<string> => {
      const before = await posts()
      await m.tapOn({ css: '[data-testid="chat-composer"]' })
      await m.inputText({ text: body })
      await m.tapOn({ text: 'Send' })
      for (let n = 0; n < 120; n++) {
        const added = (await posts()).filter(
          x => !before.some(old => old.id === x.id)
        )
        if (added.length > 0) {
          assert.equal(added.length, 1, 'Exactly one encrypted post per Send')
          await m.assertVisible({
            css: '[data-testid="chat-message-' + added[0].id + '"]',
            timeout: 15000
          })
          await m.assertVisible({ text: body })
          return added[0].id
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Fixture message was not acknowledged')
    }
    const earlier = 'Earlier original for incoming reply'
    const originalId = await send(earlier)
    if (mode === 'paging-target') {
      save(setup.small, {
        conversationId,
        originalId,
        originalBody: earlier,
        peerLabel: candidate.shortName
      })
    } else {
      await m.tapOn({ css: '[data-testid="chat-message-' + originalId + '"]' })
      await m.tapOn({
        css:
          '[data-testid="chat-message-' + originalId + '"] [aria-label="Reply"]'
      })
      await m.assertVisible({ text: 'Cancel reply' })
      const targetBody = 'Receiving actor replies to the original'
      const targetId = await send(targetBody)
      await m.assertVisible({
        css:
          '[data-testid="chat-message-' +
          targetId +
          '"] [aria-label=' +
          JSON.stringify('Jump to message from You: ' + earlier) +
          ']'
      })
      save(setup.incoming, {
        conversationId,
        targetId,
        targetBody,
        targetEarlierBody: earlier,
        senderUserId: people.Hs.userId,
        receiverUserId: people.Hc.userId,
        outgoingSenderName: candidate.shortName
      })
    }
    writeFileSync(
      join(setup.artifacts, mode + '-fixture.png'),
      await m.screenshot()
    )
    console.log('Normal encrypted reply fixture ready: ' + mode)
  } finally {
    for (const m of active) await m.detach().catch(() => undefined)
    await daemon.shutdown({ wait: true })
  }
}
main().catch((error: unknown) => {
  // A driver error can echo the last input, including a synthetic password.
  if (privateErrorFile != null)
    writeFileSync(
      privateErrorFile,
      error instanceof Error ? error.stack ?? error.message : String(error),
      { mode: 0o600 }
    )
  console.error(
    'Reply fixture setup failed; inspect the private runner artifacts.'
  )
  process.exitCode = 1
})
