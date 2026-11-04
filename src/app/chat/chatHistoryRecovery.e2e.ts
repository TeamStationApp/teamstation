/** A retained synthetic reset-device profile and its offline key holder. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { executablePath } from 'puppeteer'

import {
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'
import { partialRecovery } from './chatHistoryRecoveryPartial.e2e'

interface Device extends MaestroDevice {
  detach: () => Promise<void>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
}
interface Daemon {
  attach: (options: Record<string, unknown>) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<void>
  close: () => Promise<void>
}
interface Fixture {
  disposable: true
  origin: string
  path: string
  recipientProfile: string
  holderProfile: string
  oldMessages: string[]
  newMessage: string
  credentials: Record<string, { email: string; password: string }>
  artifacts: string
}
async function main(): Promise<void> {
  if (
    process.argv[2] === 'E3' ||
    process.argv[2] === 'E4' ||
    process.argv[2] === 'E5' ||
    process.argv[2] === 'E6' ||
    process.argv[2] === 'E13' ||
    process.argv[2] === 'E7'
  ) {
    await partialRecovery(process.argv[2])
    return
  }
  assert(
    process.argv[2] === 'E1' || process.argv[2] === 'E2',
    'This retained-profile driver supports E1 and E2 only'
  )
  const fixturePath = process.env.CHAT_RECOVERY_FIXTURE
  assert(
    fixturePath != null && fixturePath !== '',
    'CHAT_RECOVERY_FIXTURE is required'
  )
  const f = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  assert.equal(f.disposable, true)
  assert(
    ['localhost', '127.0.0.1'].includes(new URL(f.origin).hostname),
    'Only the owned local test server is allowed'
  )
  assert(f.path.startsWith('/chat/cnv_'))
  assert(f.recipientProfile !== f.holderProfile)
  assert(f.oldMessages.length > 0)
  const name = process.env.MAESTRO_D
  assert(name != null && name !== '', 'An owned MAESTRO_D name is required')
  const daemon = (await maestroClient().MaestroD.connect({
    name,
    bin: process.env.MAESTRO_D_BIN
  })) as unknown as Daemon
  const devices: Device[] = []
  async function attach(profile: string, suffix: string): Promise<Device> {
    const device = await daemon.attach({
      device: name + '-' + suffix,
      platform: 'web',
      driver: 'cdp',
      url: f.origin,
      extra: {
        browser: executablePath(),
        windowSize: '1280x900',
        userDataDir: profile
      }
    })
    devices.push(device)
    await device.openLink({ link: f.origin + f.path })
    const login = f.credentials[profile]
    assert(
      login != null,
      'Synthetic credentials must accompany each retained profile'
    )
    await device.assertVisible({
      css: 'input[aria-label="E-mail address"], [data-testid="chat-message-history"]',
      timeout: 30000
    })
    const signedOut = await device.evalBrowserScript({
      script: `return document.querySelector('input[aria-label="E-mail address"]') != null`
    })
    if (signedOut.data === true || signedOut.data === 'true') {
      await device.tapOn({ css: 'input[aria-label="E-mail address"]' })
      await device.inputText({ text: login.email })
      await device.tapOn({ text: 'Use a password instead' })
      await device.tapOn({ css: 'input[aria-label="Password"]' })
      await device.inputText({ text: login.password })
      await device.tapOn({ text: 'Sign in' })
      await device.assertVisible({ text: 'Account,', timeout: 30000 })
    }
    await device.openLink({ link: f.origin + f.path })
    return device
  }
  async function visible(device: Device, text: string): Promise<void> {
    await device.assertVisible({ text, timeout: 30000 })
  }
  async function messageVisible(device: Device, body: string): Promise<void> {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const result = await device.evalBrowserScript({
        script: `return [...document.querySelectorAll('[data-testid^="chat-message-row-"]')].some(row => row.textContent.includes(${JSON.stringify(body)}))`
      })
      if (result.data === true || result.data === 'true') return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Expected text was not rendered in a message row')
  }
  async function shot(device: Device, file: string): Promise<void> {
    writeFileSync(join(f.artifacts, file), await device.screenshot())
  }
  async function oldLocked(device: Device): Promise<void> {
    await visible(device, 'Locked message')
    const result = await device.evalBrowserScript({
      script: 'return document.body.innerText'
    })
    for (const text of f.oldMessages)
      assert(
        !String(result.data).includes(text),
        'Old plaintext exposed before approval'
      )
  }
  try {
    const recipient = await attach(f.recipientProfile, 'recipient')
    await oldLocked(recipient)
    if (process.argv[2] !== 'E2') {
      await recipient.assertVisible({
        css: 'textarea[aria-label="Message"]:not([readonly])',
        timeout: 30000
      })
      await recipient.tapOn({ css: 'textarea[aria-label="Message"]' })
      await recipient.inputText({ text: f.newMessage })
      await recipient.tapOn({ text: 'Send' })
    }
    await messageVisible(recipient, f.newMessage)
    await oldLocked(recipient)
    await shot(recipient, 'conversation-after.png')
    console.log(
      'PASS E1: holder offline; fresh send succeeds while old plaintext remains locked'
    )
    const holder = await attach(f.holderProfile, 'holder')
    for (const text of f.oldMessages) await messageVisible(holder, text)
    await messageVisible(holder, f.newMessage)
    await oldLocked(recipient)
    await holder.tapOn({ text: 'Review', timeout: 30000 })
    await visible(holder, 'OLD SAFETY WORDS')
    await shot(holder, 'approval-after.png')
    await holder.tapOn({ text: 'Approve', timeout: 30000 })
    for (const text of f.oldMessages) await messageVisible(recipient, text)
    await messageVisible(recipient, f.newMessage)
    await shot(recipient, 'recovered-history.png')
    console.log(
      'PASS E2: holder retains old/new text; explicit approval unlocks recipient in place'
    )
    await recipient.detach()
    const restarted = await attach(f.recipientProfile, 'restarted')
    for (const text of [...f.oldMessages, f.newMessage])
      await messageVisible(restarted, text)
    console.log(
      'PASS restart: recovered keys and message history survive browser restart'
    )
  } finally {
    for (const device of devices) await device.detach().catch(() => {})
    await daemon.shutdown({ wait: true })
    await daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
