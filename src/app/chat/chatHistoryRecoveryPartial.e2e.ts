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
import {
  controlRecovery,
  type RecoveryControl
} from '../../test/chatRecoveryControl'
import { readSeedTable } from '../../test/chatSeedTable'
import {
  draftRecovery,
  type RecoveryDraftDevice
} from './chatHistoryRecoveryDraft.e2e'

interface Device extends MaestroDevice {
  uploadFile: RecoveryDraftDevice['uploadFile']
  scrollUntilVisible: RecoveryDraftDevice['scrollUntilVisible']
  detach: () => Promise<void>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
}
interface Daemon {
  attach: (options: Record<string, unknown>) => Promise<Device>
  shutdown: (options: { wait: boolean }) => Promise<void>
  close: () => Promise<void>
}

export async function partialRecovery(
  scenario: 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E13' = 'E4'
): Promise<void> {
  const file = process.env.CHAT_RECOVERY_FIXTURE
  assert(file != null)
  const f = JSON.parse(readFileSync(file, 'utf8')) as {
    disposable: true
    source: string
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
  let faultControl: RecoveryControl | undefined
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
  const olderBodies =
    scenario === 'E5'
      ? Array.from(
          { length: 24 },
          (_, index) =>
            `Older practice note ${index + 1}: ` +
            'Keep the earlier practice details available while the conversation continues. '
              .repeat(4)
              .trimEnd()
        )
      : []
  try {
    console.log(`${scenario}: enrolling original recipient and first holder`)
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
    async function asPerson(key: string): Promise<TeamStationClient> {
      const actor = new TeamStationClient({
        baseUrl: f.apiUrl,
        passwordKdf: async (password, parameters) =>
          await nativeArgon(passwordBytes(password), parameters)
      })
      await actor.signInWithPassword(people[key].email, people[key].password)
      return actor
    }
    if (scenario === 'E6') {
      const league = /^QPLL (\S+)/m.exec(readFileSync(f.seedFile, 'utf8'))?.[1]
      assert(league != null, 'The disposable fixture must name its league')
      await (await asPerson('L')).setSafesport(league, true)
    }
    const dm = await client.createDm([
      people.Hs.userId,
      people.Hk.userId,
      ...(scenario === 'E6' ? [people.P.userId] : [])
    ])
    await open(old, dm.id)
    await send(old, first)
    for (const text of olderBodies) await send(old, text)
    await open(holderOne, dm.id)
    await message(holderOne, olderBodies.at(-1) ?? first)
    if (scenario === 'E13') {
      await close(holderOne)
      await (await asPerson('Hs')).leaveDm(dm.id)
      const later = 'Later history in the original encryption segment'
      await send(old, later)
      await close(old)
      await client.addDmMembers(dm.id, [people.Hs.userId])
      const recipient = await attach('Hk', 'missing-original-segment')
      await open(recipient, dm.id)
      await send(recipient, third)
      const before = await client.chatEpochs(dm.id, 0)
      assert.deepEqual(
        before.epochs.map(epoch => epoch.chainBreak),
        [false, false, true]
      )
      assert(!(await body(recipient)).includes(first))
      assert(!(await body(recipient)).includes(later))
      console.log(
        'E13: returning a rejoined holder with only the earlier segment key'
      )
      const prefixHolder = await attach('Hs', 'first-holder')
      await open(prefixHolder, dm.id)
      await message(recipient, first)
      await message(recipient, third)
      assert(!(await body(recipient)).includes(later))
      await recipient.assertVisible({
        text: 'Some older messages have been recovered.',
        timeout: 30000
      })
      await recipient.assertVisible({ text: 'Locked message' })
      assert(!(await body(prefixHolder)).includes('OLD SAFETY WORDS'))
      const outstanding = (await client.chatHistoryGrants()).requests.find(
        request =>
          request.conversationId === dm.id &&
          request.userId === people.Hk.userId
      )
      assert(outstanding != null, 'A missing suffix must remain requested')
      assert.equal(outstanding.targetEpoch, 2)
      assert.equal(outstanding.coveredThroughEpoch, 1)
      writeFileSync(
        join(f.artifacts, 'prefix-only-history.png'),
        await recipient.screenshot()
      )
      await close(prefixHolder)
      console.log('E13: returning the segment tip holder')
      const tipHolder = await attach('Ha', 'recipient-old')
      await open(tipHolder, dm.id)
      for (const text of [first, later, third]) await message(recipient, text)
      assert(!(await body(recipient)).includes('Locked message'))
      assert(!(await body(tipHolder)).includes('OLD SAFETY WORDS'))
      const after = await client.chatEpochs(dm.id, 0)
      assert.deepEqual(after.epochs, before.epochs)
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        3
      )
      const counts = await recipient.evalBrowserScript({
        script: `return JSON.stringify(${JSON.stringify([first, later, third])}.map(text=>[...document.querySelectorAll('[data-testid^="chat-message-row-"]')].filter(row=>row.textContent.includes(text)).length))`
      })
      assert.deepEqual(JSON.parse(String(counts.data)), [1, 1, 1])
      writeFileSync(
        join(f.artifacts, 'prefix-complete-history.png'),
        await recipient.screenshot()
      )
      writeFileSync(
        join(f.artifacts, 'prefix-results.json'),
        JSON.stringify(
          {
            source: f.source,
            targetEpoch: outstanding.targetEpoch,
            prefix: outstanding.coveredThroughEpoch,
            epochs: after.epochs.map(epoch => ({
              epoch: epoch.epoch,
              chainBreak: epoch.chainBreak
            })),
            duplicateRows: false,
            manualApproval: false
          },
          null,
          2
        )
      )
      console.log(
        'PASS E13 web: rejoined prefix holder unlocks only its known prefix; tip holder completes recovery with no new epoch, duplicate row or approval'
      )
      return
    }
    await close(old)
    await close(holderOne)

    console.log(
      `${scenario}: creating second segment with first holder offline`
    )
    const holderTwo = await attach('Hk', 'second-holder')
    await open(holderTwo, dm.id)
    await holderTwo.assertVisible({ text: 'Locked message', timeout: 30000 })
    await send(holderTwo, second)
    assert(!(await body(holderTwo)).includes(first))
    if (scenario === 'E6') {
      const recipientApi = await asPerson('Hk')
      const posts = (await recipientApi.chatMessages(dm.id)).filter(
        row => row.kind === 'post'
      )
      const current = posts.at(-1)!
      const row = `[data-testid="chat-message-row-${current.id}"]`
      await holderTwo.evalBrowserScript({
        script: `const row=document.querySelector(${JSON.stringify(row)});if(!row)throw Error('Readable message required');row.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}));return true`
      })
      await holderTwo.tapOn({ css: `${row} [aria-label="Reply"]` })
      await holderTwo.assertVisible({ text: 'Cancel reply', timeout: 10000 })
      await holderTwo.tapOn({ text: 'Cancel reply' })
      await holderTwo.assertVisible({ text: 'Locked message' })
      writeFileSync(
        join(f.artifacts, 'readable-actions-with-locked-history.png'),
        await holderTwo.screenshot()
      )
      async function blocked(
        m: Device,
        reason: string,
        shot: string
      ): Promise<void> {
        await m.assertVisible({ text: reason, timeout: 30000 })
        const state = await m.evalBrowserScript({
          script: `return JSON.stringify({writable:!!document.querySelector('textarea[aria-label="Message"]:not([readonly]):not([disabled])'),send:!!document.querySelector('[aria-label="Send"]:not([aria-disabled="true"])')})`
        })
        assert.deepEqual(JSON.parse(String(state.data)), {
          writable: false,
          send: false
        })
        writeFileSync(join(f.artifacts, shot), await m.screenshot())
      }
      const unlinked = await attach('Hk', 'unlinked-recipient')
      await blocked(unlinked, 'Link this device', 'unlinked-blocked.png')
      await close(unlinked)
      const readerApi = await asPerson('B')
      const readOnly = (await readerApi.chatConversations()).find(
        chat =>
          chat.kind === 'seasonAnnouncements' && !chat.canPost && !chat.closed
      )
      assert(readOnly != null, 'A genuinely read-only audience is required')
      const reader = await attach('B', 'read-only-recipient')
      await open(reader, readOnly.id)
      await blocked(
        reader,
        'Only season staff post here. You can react.',
        'read-only-blocked.png'
      )
      await close(reader)
      await client.leaveDm(dm.id)
      const closed = await (await asPerson('Hs')).leaveDm(dm.id)
      assert(
        closed.closed,
        'Removing the last included adult must close this DM'
      )
      await open(holderTwo, dm.id)
      await blocked(
        holderTwo,
        'This chat is closed. You can read it, but not post.',
        'closed-blocked.png'
      )
      await message(holderTwo, second)
      await holderTwo.assertVisible({ text: 'Locked message' })
      const closedMetadata = (await recipientApi.chatConversations()).find(
        chat => chat.id === dm.id
      )
      assert(closedMetadata?.closed === true && !closedMetadata.canPost)
      assert.equal(
        (await recipientApi.chatMessages(dm.id)).filter(
          row => row.kind === 'post'
        ).length,
        posts.length
      )
      assert.equal((await recipientApi.chatEpochs(dm.id, 0)).epochs.length, 2)
      await recipientApi.leaveDm(dm.id)
      await holderTwo.openLink({ link: f.origin + '/chat/' + dm.id })
      await blocked(
        holderTwo,
        'Chat could not be opened.',
        'removed-blocked.png'
      )
      await assert.rejects(async () => await recipientApi.chatMessages(dm.id), {
        code: 'notFound'
      })
      writeFileSync(
        join(f.artifacts, 'restricted-results.json'),
        JSON.stringify(
          {
            source: f.source,
            surface: 'web',
            unlinked: true,
            readOnly: true,
            closed: true,
            removed: true,
            readableReplyAction: true,
            epochs: 2,
            posts: posts.length
          },
          null,
          2
        )
      )
      console.log(
        'PASS E6 web: readable reply action works alongside placeholders; unlinked, read-only, closed and removed clients cannot compose'
      )
      return
    }
    if (scenario === 'E5') {
      const posts = (await client.chatMessages(dm.id)).filter(
        row => row.kind === 'post'
      )
      assert.equal(posts.length, 26)
      const anchor = posts[12]
      const anchorBody = olderBodies[11]
      await draftRecovery({
        fixture: f,
        recipient: holderTwo,
        userId: people.Hk.userId,
        conversationId: dm.id,
        anchorId: anchor.id,
        anchorBody,
        returnHolder: async () => {
          const holder = await attach('Hs', 'first-holder')
          await open(holder, dm.id)
          await message(holder, second)
        },
        recovered: async () => {
          await message(holderTwo, anchorBody)
        }
      })
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        posts.length
      )
      assert.equal((await client.chatEpochs(dm.id, 0)).epochs.length, 2)
      return
    }
    if (scenario === 'E3' || scenario === 'E7') {
      let recovering = holderTwo
      if (scenario === 'E7') {
        const relayFile = process.env.CHAT_RECOVERY_RELAY
        assert(relayFile != null, 'E7 requires the owned relay settings')
        const relay = JSON.parse(readFileSync(relayFile, 'utf8')) as {
          disposable: true
          source: string
          upstream: string
          endpoint: string
          token: string
          audit: string
        }
        assert.equal(relay.disposable, true)
        assert.equal(relay.source, f.source)
        assert.equal(relay.upstream, f.apiUrl)
        faultControl = {
          disposable: true,
          endpoint: relay.endpoint,
          token: relay.token,
          actors: {
            recipient: { userId: people.Hk.userId, conversationId: dm.id }
          }
        }
        await controlRecovery(faultControl, [
          'recipient',
          'history-outage',
          'history-retry'
        ])
        await open(holderTwo, dm.id)
        await holderTwo.assertVisible({
          text: 'Older messages could not be recovered yet.',
          timeout: 30000
        })
        const audit = readFileSync(relay.audit, 'utf8')
          .trim()
          .split('\n')
          .map(
            line =>
              JSON.parse(line) as {
                gateId: string
                remaining: number
                event?: string
              }
          )
        assert(
          audit.filter(
            row =>
              row.gateId === 'history-retry' &&
              row.remaining < 100 &&
              row.event == null
          ).length > 0
        )
        writeFileSync(
          join(f.artifacts, 'history-fetch-error.png'),
          await holderTwo.screenshot()
        )
        await holderTwo.tapOn({ text: 'Try again' })
        await controlRecovery(faultControl, ['clear'])
        await send(holderTwo, during)
        await close(holderTwo)
        console.log(
          'E7: retry used; current send succeeded; recipient offline for recovery hints'
        )
      }
      console.log(
        `${scenario}: returning an authorized holder for automatic recovery`
      )
      const holder = await attach('Hs', 'first-holder')
      await open(holder, dm.id)
      await message(holder, second)
      if (scenario === 'E7') {
        recovering = await attach('Hk', 'second-holder')
        await open(recovering, dm.id)
      }
      await message(recovering, first)
      assert(!(await body(recovering)).includes('Locked message'))
      assert(!(await body(holder)).includes('OLD SAFETY WORDS'))
      if (scenario === 'E3') await send(recovering, during)
      await message(holder, during)
      writeFileSync(
        join(f.artifacts, 'automatic-history.png'),
        await recovering.screenshot()
      )
      await close(recovering)
      const restarted = await attach('Hk', 'second-holder')
      await open(restarted, dm.id)
      for (const text of [first, second, during]) await message(restarted, text)
      const counts = await restarted.evalBrowserScript({
        script: `return JSON.stringify(${JSON.stringify([first, second, during])}.map(text => [...document.querySelectorAll('[data-testid^="chat-message-row-"]')].filter(row => row.textContent.includes(text)).length))`
      })
      assert.deepEqual(
        typeof counts.data === 'string' ? JSON.parse(counts.data) : counts.data,
        [1, 1, 1]
      )
      const epochs = await client.chatEpochs(dm.id, 0)
      assert.deepEqual(
        epochs.epochs.map(epoch => epoch.epoch),
        [1, 2]
      )
      assert.deepEqual(
        epochs.epochs.map(epoch => epoch.chainBreak),
        [false, true]
      )
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        3
      )
      console.log(
        `PASS ${scenario}: first enrollment sends fresh; returning holder restores history without manual approval; restart retains all messages`
      )
      return
    }
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
    try {
      if (faultControl != null) await controlRecovery(faultControl, ['clear'])
    } finally {
      for (const m of devices) await m.detach().catch(() => {})
      await daemon.shutdown({ wait: true })
      await daemon.close()
    }
  }
}
