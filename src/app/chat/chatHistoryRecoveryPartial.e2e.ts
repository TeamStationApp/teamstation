/** Three independent browser key stores prove recovery across two breaks. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export async function partialRecovery(): Promise<void> {
  const file = process.env.CHAT_RECOVERY_FIXTURE
  assert(file != null)
  const f = JSON.parse(readFileSync(file, 'utf8')) as {
    disposable: true
    origin: string
    apiUrl: string
    seedFile: string
    artifacts: string
  }
  assert.equal(f.disposable, true)
  for (const value of [f.origin, f.apiUrl]) {
    const url = new URL(value)
    assert.equal(url.protocol, 'http:')
    assert(['127.0.0.1', 'localhost'].includes(url.hostname))
  }
  const people = readSeedTable(readFileSync(f.seedFile, 'utf8'))
  for (const key of ['Ha', 'Hs', 'Hk'])
    assert(people[key].email.endsWith('@chat.example.com'))
  const name = process.env.MAESTRO_D
  const deviceId = process.env.CHAT_RECOVERY_DEVICE
  assert(name != null && deviceId != null)
  assert.equal(process.env.CHAT_RECOVERY_SURFACE, 'web')
  const daemon = (await maestroClient().MaestroD.connect({
    name
  })) as unknown as Daemon
  const devices = new Set<Device>()
  async function attach(key: string, profile: string): Promise<Device> {
    const m = await daemon.attach({
      device: deviceId + '-' + profile,
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
        'return document.querySelector(\'input[aria-label="E-mail address"]\') != null'
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
  async function body(m: Device): Promise<string> {
    return String(
      (await m.evalBrowserScript({ script: 'return document.body.innerText' }))
        .data
    )
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
    throw new Error('Expected recovered message is absent from history')
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
  const first = 'History from the first segment'
  const second = 'History from the second segment'
  const third = 'Current conversation after reset'
  const during = 'Sending while part of history remains locked'
  try {
    console.log('E4: enrolling original recipient and first holder')
    const old = await attach('Ha', 'recipient-old')
    const holderOne = await attach('Hs', 'first-holder')
    await holderOne.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 30000
    })
    await old.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 30000
    })
    // Fixture creation uses the normal authorized API. Every message and
    // recovery observation below goes through the running application's UI.
    const client = new TeamStationClient({
      baseUrl: f.apiUrl,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await client.signInWithPassword(people.Ha.email, people.Ha.password)
    const dm = await client.createDm([people.Hs.userId, people.Hk.userId])
    await open(old, dm.id)
    await send(old, first)
    await open(holderOne, dm.id)
    await message(holderOne, first)
    await close(old)
    await close(holderOne)

    console.log('E4: creating second segment with first holder offline')
    const holderTwo = await attach('Hk', 'second-holder')
    await open(holderTwo, dm.id)
    await holderTwo.assertVisible({ text: 'Locked message', timeout: 30000 })
    await send(holderTwo, second)
    assert(!(await body(holderTwo)).includes(first))
    await close(holderTwo)

    console.log('E4: resetting recipient and creating third segment')
    const recipient = await attach('Ha', 'recipient-reset')
    await recipient.assertVisible({ text: 'Link this device', timeout: 30000 })
    await recipient.tapOn({ text: 'I can’t reach my other devices' })
    await recipient.tapOn({ text: 'Reset chat on this device' })
    await recipient.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 30000
    })
    await open(recipient, dm.id)
    await send(recipient, third)
    assert(!(await body(recipient)).includes(first))
    assert(!(await body(recipient)).includes(second))

    console.log('E4: returning only the second-segment holder')
    const secondBack = await attach('Hk', 'second-holder')
    await open(secondBack, dm.id)
    await message(secondBack, second)
    await message(secondBack, third)
    await secondBack.tapOn({ text: 'Review', timeout: 30000 })
    await secondBack.assertVisible({ text: 'OLD SAFETY WORDS', timeout: 30000 })
    await secondBack.tapOn({ text: 'Approve', timeout: 30000 })
    await message(recipient, second)
    assert(!(await body(recipient)).includes(first))
    await recipient.assertVisible({ text: 'Locked message', timeout: 30000 })
    await recipient.assertVisible({
      text: 'Some older messages have been recovered.',
      timeout: 30000
    })
    await send(recipient, during)
    writeFileSync(
      join(f.artifacts, 'partial-history.png'),
      await recipient.screenshot()
    )
    await close(secondBack)

    console.log('E4: returning the first-segment holder')
    const firstBack = await attach('Hs', 'first-holder')
    await open(firstBack, dm.id)
    for (const text of [first, second, third, during])
      await message(recipient, text)
    assert(!(await body(recipient)).includes('Locked message'))
    writeFileSync(
      join(f.artifacts, 'complete-history.png'),
      await recipient.screenshot()
    )
    const epochs = await client.chatEpochs(dm.id, 0)
    assert.deepEqual(
      epochs.epochs.map(epoch => epoch.epoch),
      [1, 2, 3]
    )
    assert.deepEqual(
      epochs.epochs.map(epoch => epoch.chainBreak),
      [false, true, true]
    )
    assert.equal(
      (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
        .length,
      4
    )
    console.log(
      'PASS E4: partial history remains locked; sending continues; second holder completes recovery without another epoch or duplicate message'
    )
  } catch (error) {
    let index = 0
    for (const m of devices) {
      const bytes = await m.screenshot().catch(() => undefined)
      if (bytes != null)
        writeFileSync(join(f.artifacts, `failed-partial-${index++}.png`), bytes)
    }
    throw error
  } finally {
    for (const m of devices) await m.detach().catch(() => {})
    await daemon.shutdown({ wait: true })
    await daemon.close()
  }
}
