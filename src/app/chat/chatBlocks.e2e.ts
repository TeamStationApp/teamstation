/**
 * Synthetic-fixture journey. Run with node -r sucrase/register <this file> web|ios|android.
 * Required: CHAT_BLOCKS_SEED (chat-seed table), CHAT_BLOCKS_API, CHAT_BLOCKS_WEB,
 * CHAT_BLOCKS_STATE (private key storage), CHAT_BLOCKS_ARTIFACTS, CHAT_BLOCKS_DEVICE,
 * MAESTRO_D. Both surfaces are already signed in and linked as fixture Hc.
 * CHAT_BLOCKS_SECOND_DEVICE is the second browser; CHAT_BLOCKS_WEB_DAEMON
 * selects its daemon on native runs. Only task-owned devices may be supplied.
 * MAESTRO_D_CLIENT_ROOT/MAESTRO_D_BIN select the installed TypeScript driver.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TeamStationClient } from '../../common/api'
import {
  maestroClient,
  type MaestroDevice
} from '../../test/chat117Maestro.e2e'
import { readSeedTable } from '../../test/chatSeedTable'
import { testPasswordKdf } from '../../test/passwordFixtures'
import { ChatEngine } from './engine/engine'
import { recordFromJson, recordToJson } from './keyRecord'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
interface Browser extends MaestroDevice {
  assertNotVisible: (options: Record<string, unknown>) => Promise<unknown>
  waitForAnimationToEnd: (options: Record<string, unknown>) => Promise<unknown>
  scrollUntilVisible: (options: Record<string, unknown>) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  longPressOn: (options: Record<string, unknown>) => Promise<unknown>
  launchApp: (options: Record<string, unknown>) => Promise<unknown>
  stopApp: (options: Record<string, unknown>) => Promise<unknown>
}
async function main(): Promise<void> {
  const platform = process.argv[2]
  assert(platform === 'web' || platform === 'ios' || platform === 'android')
  const native = platform !== 'web'
  const output = required('CHAT_BLOCKS_ARTIFACTS')
  const state = required('CHAT_BLOCKS_STATE')
  mkdirSync(output, { recursive: true })
  mkdirSync(state, { recursive: true })
  const seed = readSeedTable(readFileSync(required('CHAT_BLOCKS_SEED'), 'utf8'))
  const clients: TeamStationClient[] = []
  const engines: ChatEngine[] = []
  let recording: ChildProcess | undefined
  const stopRecording = async (): Promise<void> => {
    if (recording == null) return
    const recorder = recording
    recording = undefined
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.once('exit', () => {
        resolve()
      })
      recorder.once('error', reject)
    })
    recorder.kill('SIGINT')
    await stopped
  }
  const people = [seed.Hc, seed.Hs, seed.N]
  for (const person of people) {
    const client = new TeamStationClient({
      baseUrl: required('CHAT_BLOCKS_API'),
      passwordKdf: testPasswordKdf
    })
    await client.signInWithPassword(person.email, person.password)
    clients.push(client)
  }
  console.log('Fixture sign-ins complete')
  await clients[0].setChatBlock(people[1].userId, false)
  try {
    for (const index of [1, 2]) {
      const file = join(state, `peer-${index}.json`)
      const engine = new ChatEngine({
        client: clients[index],
        userId: people[index].userId,
        device: { name: 'Blocking fixture', platform: 'web' },
        store: {
          load: async () =>
            existsSync(file)
              ? recordFromJson(readFileSync(file, 'utf8'))
              : undefined,
          exists: async () => existsSync(file),
          save: async record => {
            writeFileSync(file, recordToJson(record))
          },
          wipe: async () => {
            throw new Error('Fixture must not reset keys')
          }
        }
      })
      assert.equal(await engine.start(), 'ready')
      engines.push(engine)
    }
    console.log('Fixture engines ready')
    const group = engines[0]
      .conversations()
      .find(chat => chat.kind === 'teamMembers')!.id
    await engines[0].open(group)
    await engines[0].fillGrants()
    await engines[1].open(group)
    const stamp = Date.now().toString(36)
    const old = `Blocking fixture old ${stamp}`
    const future = `Blocking fixture future ${stamp}`
    const other = `Visible teammate ${stamp}`
    const fileName = `Hidden attachment ${stamp}.png`
    const oldPost = (await engines[0].attach(
      group,
      [
        {
          fileName,
          contentType: 'image/png',
          width: 1,
          height: 1,
          bytes: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lK8AAAAASUVORK5CYII=',
            'base64'
          )
        }
      ],
      old
    ))!
    const peerName = (await clients[0].chatMembers(group)).find(
      member => member.userId === people[1].userId
    )!.shortName
    await engines[1].sendText(group, other)
    const dm = await clients[1].createDm([people[0].userId])
    await engines[0].refresh()
    await engines[0].open(dm.id)
    await engines[0].sendText(dm.id, `Existing DM ${stamp}`)
    console.log('Fixture messages ready')
    const daemon = await maestroClient().MaestroD.connect({
      name: required('MAESTRO_D'),
      signal: AbortSignal.timeout(420000),
      bin: process.env.MAESTRO_D_BIN
    })
    const browser = (await daemon.attach({
      device: required('CHAT_BLOCKS_DEVICE'),
      platform,
      ...(native ? { appId: 'app.teamstation.app' } : {})
    })) as Browser
    const webOrigin = required('CHAT_BLOCKS_WEB')
    const web = native ? 'teamstation:/' : webOrigin
    const visible = async (text: string): Promise<void> => {
      await browser.assertVisible({ text, timeout: 30000 })
    }
    const hidden = async (device: Browser, text: string): Promise<void> => {
      const deadline = Date.now() + 15000
      for (;;) {
        try {
          await device.assertNotVisible({ text })
          return
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    const tap = async (text: string): Promise<void> => {
      await browser.tapOn({
        text: platform === 'android' ? `^${text}$` : text,
        timeout: 15000
      })
    }
    const shot = async (name: string): Promise<void> => {
      await browser.waitForAnimationToEnd({ timeout: 3000 })
      writeFileSync(
        join(output, `${native ? platform + '-' : ''}${name}.png`),
        await browser.screenshot()
      )
    }
    const menu = async (): Promise<void> => {
      if (native) {
        await browser.hideKeyboard()
        await browser.tapOn({
          text: 'Go to latest message',
          optional: true,
          timeout: 2000
        })
        await browser.longPressOn({ text: old, timeout: 15000 })
        return
      }
      await browser.tapOn({
        text: 'Go to latest message',
        optional: true,
        timeout: 2000
      })
      await browser.tapOn({
        css: `[data-testid="chat-message-${oldPost.id}"] [aria-label="More message actions"]`
      })
    }
    await browser.openLink({ link: `${web}/chat/${group}` })
    await visible(old)
    const secondDaemon = native
      ? await maestroClient().MaestroD.connect({
          name: required('CHAT_BLOCKS_WEB_DAEMON'),
          bin: process.env.MAESTRO_D_BIN
        })
      : daemon
    const second = (await secondDaemon.attach({
      device: required('CHAT_BLOCKS_SECOND_DEVICE'),
      platform: 'web'
    })) as Browser
    await second.openLink({ link: `${webOrigin}/chat/${group}` })
    await second.assertVisible({ text: old, timeout: 30000 })
    console.log('Browser conversation opened')
    await visible(old)
    await visible(other)
    await visible(fileName)
    await menu()
    await visible('Report and Block')
    await shot('message-actions-after')
    await tap('Block')
    await visible('.*They will not be notified.*')
    await browser.tapOn({ id: 'chat-safety-cancel' })
    await visible(old)
    // The iOS driver does not implement startRecording; capture the owned simulator.
    if (platform === 'ios') {
      recording = spawn(
        'xcrun',
        [
          'simctl',
          'io',
          required('CHAT_BLOCKS_DEVICE'),
          'recordVideo',
          '--force',
          join(output, 'report-and-block.mp4')
        ],
        { stdio: 'ignore' }
      )
      await new Promise<void>((resolve, reject) => {
        recording!.once('spawn', resolve)
        recording!.once('error', reject)
      })
    }
    await menu()
    await tap('Report and Block')
    await visible('.*Nothing else in this chat is shared.*')
    await browser.tapOn({ id: 'chat-safety-confirm' })
    await hidden(browser, old)
    await visible(other)
    await hidden(browser, fileName)
    await assert.rejects(clients[0].chatAttachment(oldPost.attachments[0].id))
    await hidden(second, old)
    await second.assertVisible({ text: other, timeout: 15000 })
    assert(
      (await clients[0].chatBlocks()).some(row =>
        row.userIds.includes(people[1].userId)
      )
    )
    await engines[0].sendText(group, future)
    await hidden(browser, future)
    await assert.rejects(
      clients[1].createDm([people[0].userId]),
      /unavailable/i
    )
    await assert.rejects(
      engines[0].sendText(dm.id, 'Refused direct message'),
      /unavailable/i
    )
    await shot('blocked-history')
    if (native) {
      await stopRecording()
      await browser.stopApp({ appId: 'app.teamstation.app' })
      await browser.launchApp({
        appId: 'app.teamstation.app',
        environment: { TS_DECLARED_AGE_LOWER: '13' }
      })
      await browser.assertVisible({ text: 'Account, .*', timeout: 60000 })
    }
    await browser.openLink({ link: `${web}/chat/${group}` })
    await visible(other)
    await hidden(browser, old)
    await browser.openLink({ link: `${web}/account` })
    if (native)
      await browser.scrollUntilVisible({
        element: { text: 'Blocked people.*' },
        direction: 'DOWN',
        centerElement: true,
        timeout: 20000
      })
    await visible('Blocked people')
    await tap('Blocked people')
    await visible(peerName)
    await shot('account-after')
    await tap(`Unblock ${peerName}`)
    await browser.tapOn({ id: 'chat-safety-confirm' })
    await visible('You have not blocked anyone.')
    await tap('Done')
    await browser.openLink({ link: `${web}/chat/${group}` })
    await visible(old)
    await visible(future)
    await browser.openLink({ link: `${web}/chat/${dm.id}/info` })
    await browser.tapOn({ id: `chat-info-member-${people[1].userId}` })
    await visible(`Block ${peerName}`)
    await shot('chat-person-after')
    await tap(`Block ${peerName}`)
    await browser.tapOn({ id: 'chat-safety-confirm' })
    await visible(`Unblock ${peerName}`)
    assert((await clients[0].chatBlocks()).length > 0)
    await tap(`Unblock ${peerName}`)
    await browser.tapOn({ id: 'chat-safety-confirm' })
    console.log(
      `PASS ${platform}: cancel, Report and Block, attachment/history/future filtering, live second-client sync, DM refusal, reload, Account unblock and person controls`
    )
  } finally {
    await stopRecording()
    for (const engine of engines) engine.stop()
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
