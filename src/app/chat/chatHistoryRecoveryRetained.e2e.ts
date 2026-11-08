/**
 * Produces the retained browser profiles that recovery E1 and E2 start from:
 * a holder and a recipient who both read the same history, then the
 * recipient's reset on a fresh profile while the holder is offline. Every
 * message goes through the running application's composer; only the
 * conversation itself is created through the normal authorized API.
 *
 *   CHAT_RECOVERY_FIXTURE=<fixture.json> CHAT_RECOVERY_RETAINED=<out.json> \
 *     MAESTRO_D=<name> node -r sucrase/register \
 *     src/app/chat/chatHistoryRecoveryRetained.e2e.ts E1|E2
 *
 * For E2 the reset recipient has also sent its new message, as E1 leaves it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { executablePath } from 'puppeteer'

import { TeamStationClient } from '../../common/api'
import { passwordBytes } from '../../common/passwordProtocol'
import { nativeArgon } from '../../server/auth/passwords'
import { privateJson } from '../../test/chat2Fixture.e2e'
import { maestroClient } from '../../test/chat117Maestro.e2e'
import { readSeedTable } from '../../test/chatSeedTable'

interface Device {
  openLink: (input: { link: string }) => Promise<unknown>
  assertVisible: (input: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  tapOn: (input: { text?: string; css?: string }) => Promise<unknown>
  inputText: (input: { text: string }) => Promise<unknown>
  evalBrowserScript: (input: { script: string }) => Promise<{ data: unknown }>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (input: Record<string, unknown>) => Promise<Device>
  shutdown: (input: { wait: number }) => Promise<unknown>
  close: () => Promise<unknown>
}

async function main(): Promise<void> {
  const scenario = process.argv[2]
  assert(scenario === 'E1' || scenario === 'E2', 'E1 or E2 only')
  const file = process.env.CHAT_RECOVERY_FIXTURE
  const target = process.env.CHAT_RECOVERY_RETAINED
  const name = process.env.MAESTRO_D
  assert(file != null && target != null && name != null)
  const f = JSON.parse(readFileSync(file, 'utf8')) as {
    disposable: true
    origin: string
    apiUrl: string
    seedFile: string
    artifacts: string
  }
  assert.equal(f.disposable, true)
  for (const value of [f.origin, f.apiUrl])
    assert(['127.0.0.1', 'localhost'].includes(new URL(value).hostname))
  const people = readSeedTable(readFileSync(f.seedFile, 'utf8'))
  const holderKey = 'Ec'
  const recipientKey = 'D2'
  for (const key of [holderKey, recipientKey])
    assert(people[key].email.endsWith('@chat.example.com'))
  const profiles = {
    holder: join(f.artifacts, 'profiles', 'holder'),
    recipientOld: join(f.artifacts, 'profiles', 'recipient-old'),
    recipient: join(f.artifacts, 'profiles', 'recipient')
  }
  const daemon = (await maestroClient().MaestroD.connect({
    name,
    bin: process.env.MAESTRO_D_BIN
  })) as unknown as Daemon
  const devices = new Set<Device>()
  async function attach(key: string, profile: string): Promise<Device> {
    const m = await daemon.attach({
      device: name + '-' + profile.split('/').at(-1),
      platform: 'web',
      driver: 'cdp',
      url: f.origin,
      extra: {
        browser: executablePath(),
        windowSize: '1280x900',
        userDataDir: profile
      }
    })
    devices.add(m)
    await m.openLink({ link: f.origin })
    await m.assertVisible({
      css: 'input[aria-label="E-mail address"], [aria-label^="Account,"]',
      timeout: 30000
    })
    await m.tapOn({ css: 'input[aria-label="E-mail address"]' })
    await m.inputText({ text: people[key].email })
    await m.tapOn({ text: 'Use a password instead' })
    await m.tapOn({ css: 'input[aria-label="Password"]' })
    await m.inputText({ text: people[key].password })
    await m.tapOn({ text: 'Sign in' })
    await m.assertVisible({ text: 'Account,', timeout: 30000 })
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
    throw new Error('Expected message is absent from history')
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
  const oldMessages = ['Practice begins at six', 'See you there']
  const newMessage = 'Sent after resetting chat on this device'
  try {
    const holder = await attach(holderKey, profiles.holder)
    const old = await attach(recipientKey, profiles.recipientOld)
    for (const m of [holder, old])
      await m.assertVisible({
        css: '[data-testid="chat-conversation-list"]',
        timeout: 30000
      })
    const client = new TeamStationClient({
      baseUrl: f.apiUrl,
      passwordKdf: async (password, parameters) =>
        await nativeArgon(passwordBytes(password), parameters)
    })
    await client.signInWithPassword(
      people[holderKey].email,
      people[holderKey].password
    )
    const dm = await client.createDm([people[recipientKey].userId])
    await open(holder, dm.id)
    await send(holder, oldMessages[0])
    await open(old, dm.id)
    await message(old, oldMessages[0])
    await send(old, oldMessages[1])
    await message(holder, oldMessages[1])
    // The holder goes offline; the recipient's only device is replaced.
    await close(holder)
    await close(old)
    const recipient = await attach(recipientKey, profiles.recipient)
    await recipient.assertVisible({ text: 'Link this device', timeout: 30000 })
    await recipient.tapOn({ text: 'I can’t reach my other devices' })
    await recipient.tapOn({ text: 'Reset chat on this device' })
    await recipient.assertVisible({
      css: '[data-testid="chat-conversation-list"]',
      timeout: 30000
    })
    await open(recipient, dm.id)
    await recipient.assertVisible({ text: 'Locked message', timeout: 30000 })
    if (scenario === 'E2') await send(recipient, newMessage)
    await close(recipient)
    privateJson(target, {
      disposable: true,
      origin: f.origin,
      path: '/chat/' + dm.id,
      recipientProfile: profiles.recipient,
      holderProfile: profiles.holder,
      oldMessages,
      newMessage,
      credentials: {
        [profiles.recipient]: {
          email: people[recipientKey].email,
          password: people[recipientKey].password
        },
        [profiles.holder]: {
          email: people[holderKey].email,
          password: people[holderKey].password
        }
      },
      artifacts: f.artifacts
    })
    console.log(
      `${scenario} retained profiles produced: holder offline, recipient reset`
    )
  } finally {
    for (const m of devices) await m.detach().catch(() => {})
    await daemon.shutdown({ wait: 15000 })
    await daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
