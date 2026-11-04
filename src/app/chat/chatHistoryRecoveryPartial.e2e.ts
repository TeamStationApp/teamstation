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
import { recoveryFixtureEnvironment } from '../../test/chatRecoveryFixtureContract'
import { recoveryServerControl } from '../../test/chatRecoveryServerControl'
import { readSeedTable } from '../../test/chatSeedTable'
import {
  draftRecovery,
  type RecoveryDraftDevice
} from './chatHistoryRecoveryDraft.e2e'
import { dmTitle } from './engine/engine'

interface Device extends MaestroDevice {
  uploadFile: RecoveryDraftDevice['uploadFile']
  scrollUntilVisible: RecoveryDraftDevice['scrollUntilVisible']
  detach: () => Promise<void>
  evalBrowserScript: (options: { script: string }) => Promise<{ data: unknown }>
}
interface Daemon {
  attach: (options: Record<string, unknown>) => Promise<Device>
  shutdown: (options: { wait: number }) => Promise<void>
  close: () => Promise<void>
}

export async function partialRecovery(
  scenario:
    'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E9' | 'E11' | 'E12' | 'E13' = 'E4'
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
  const nativePreparation = process.env.CHAT_RECOVERY_PREPARE_NATIVE
  if (nativePreparation != null) {
    assert(['ios', 'android'].includes(nativePreparation))
    assert(['E5', 'E6', 'E7'].includes(scenario))
  }
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
  const serverControl = scenario === 'E9' ? recoveryServerControl(f) : undefined
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
        browser: await executablePath(),
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
    if (serverControl != null) await serverControl('baseline')
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
      ...(scenario === 'E12' || scenario === 'E9' ? [people.Hc.userId] : []),
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

    if (scenario === 'E9') {
      assert(serverControl != null)
      const before = await client.chatEpochs(dm.id, 0)
      assert.equal(before.historyRecoveryVersion, undefined)
      const recipient = await attach('Hk', 'legacy-server-recipient')
      await open(recipient, dm.id)
      await recipient.assertVisible({
        text: 'This server requires the current chat key before you can send.',
        timeout: 30000
      })
      await recipient.assertVisible({
        text: 'History is locked — it unlocks when another member opens TeamStation',
        timeout: 10000
      })
      // The send banner alone names the server limitation.
      const shown = await recipient.evalBrowserScript({
        script:
          "return document.body.innerText.split('This server requires the current chat key before you can send.').length - 1"
      })
      assert.equal(Number(shown.data), 1, 'Server limitation shown once')
      const writable = await recipient.evalBrowserScript({
        script:
          'return !!document.querySelector(\'textarea[aria-label="Message"]:not([readonly]):not([disabled])\')'
      })
      assert(writable.data === false || writable.data === 'false')
      const requests = await recipient.evalBrowserScript({
        script:
          'return JSON.stringify(performance.getEntriesByType("resource").map(row => row.name))'
      })
      const paths = JSON.parse(String(requests.data)) as string[]
      assert(paths.some(path => path.includes('/epochs')))
      assert(
        !paths.some(
          path => path.includes('scope=history') || path.includes('boxesAfter=')
        ),
        'An unsupported server must never receive recovery-only requests'
      )
      assert.deepEqual(
        (await client.chatEpochs(dm.id, 0)).epochs,
        before.epochs
      )
      writeFileSync(
        join(f.artifacts, 'baseline-server-limitation.png'),
        await recipient.screenshot()
      )
      await close(recipient)
      console.log(
        'E9: baseline server limitation is visible and no recovery-only requests were made'
      )

      await serverControl('enabled')
      const enabled = await attach('Hk', 'legacy-server-recipient')
      await open(enabled, dm.id)
      await send(enabled, second)
      assert(!(await body(enabled)).includes(first))
      const boundary = await client.chatEpochs(dm.id, 0)
      assert.equal(boundary.historyRecoveryVersion, 1)
      assert.equal(boundary.freshEpochsEnabled, true)
      assert.deepEqual(
        boundary.epochs.map(row => row.chainBreak),
        [false, true]
      )
      await close(enabled)
      await serverControl('disabled')
      const disabled = await client.chatEpochs(dm.id, 0)
      assert.equal(disabled.historyRecoveryVersion, 1)
      assert.equal(disabled.freshEpochsEnabled, false)
      const recovering = await attach('Hk', 'legacy-server-recipient')
      await open(recovering, dm.id)
      await message(recovering, second)
      await send(recovering, during)
      const holder = await attach('Hs', 'first-holder')
      await open(holder, dm.id)
      for (const text of [first, second, during]) await message(holder, text)
      await message(recovering, first)
      const heldReply =
        'Reply with a retained key while fresh starts are disabled'
      await send(holder, heldReply)
      await message(recovering, heldReply)
      writeFileSync(
        join(f.artifacts, 'disabled-fresh-recovered-history.png'),
        await recovering.screenshot()
      )
      await close(holder)
      await close(recovering)
      const missing = await attach('Hc', 'disabled-fresh-recipient')
      await open(missing, dm.id)
      await missing.assertVisible({
        text: 'New messages need the current chat key while fresh messaging is unavailable.',
        timeout: 30000
      })
      const blocked = await missing.evalBrowserScript({
        script:
          'return !!document.querySelector(\'textarea[aria-label="Message"]:not([readonly]):not([disabled])\')'
      })
      assert(blocked.data === false || blocked.data === 'false')
      assert(!(await body(missing)).includes(first))
      // A linked caller bypassing the disabled composer must still meet the
      // server's rollout gate before any publication can be accepted.
      const refused = await missing.evalBrowserScript({
        script: `return (async () => { const response = await fetch(${JSON.stringify(f.apiUrl + '/chat/conversations/' + dm.id + '/epochs')}, {method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:JSON.stringify({mode:'fresh', epoch:3, previousKeyBox:null, signature:${JSON.stringify(Buffer.alloc(64).toString('base64url'))}, boxes:[]})}); return JSON.stringify({status:response.status, body:await response.json()}) })()`
      })
      const rejection = JSON.parse(String(refused.data)) as {
        status: number
        body: { details?: { reason?: string } }
      }
      assert.equal(rejection.status, 409)
      assert.equal(rejection.body.details?.reason, 'freshDisabled')
      assert.deepEqual(
        (await client.chatEpochs(dm.id, 0)).epochs,
        boundary.epochs
      )
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        4
      )
      writeFileSync(
        join(f.artifacts, 'disabled-fresh-blocked.png'),
        await missing.screenshot()
      )
      writeFileSync(
        join(f.artifacts, 'server-compatibility-results.json'),
        JSON.stringify(
          {
            source: f.source,
            unsupportedRecoveryRequests: 0,
            recoverySurvivesDisable: true,
            heldKeySends: true,
            missingKeySendBlocked: true,
            freshPublicationRejected: true,
            epochs: 2,
            posts: 4
          },
          null,
          2
        )
      )
      console.log(
        'PASS E9 web: baseline server fallback is explicit; disabling fresh starts preserves recovery and held-key sending while blocking another fresh start'
      )
      return
    }

    if (scenario === 'E12') {
      const relayFile = process.env.CHAT_RECOVERY_RELAY
      const apiLog = process.env.CHAT_RECOVERY_API_LOG
      assert(relayFile != null && apiLog != null)
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
          one: { userId: people.Hk.userId, conversationId: dm.id },
          two: { userId: people.Hc.userId, conversationId: dm.id }
        }
      }
      const one = await attach('Hk', 'racing-one')
      const two = await attach('Hc', 'racing-two')
      for (const m of [one, two]) {
        await open(m, dm.id)
        await m.assertVisible({ text: 'Locked message', timeout: 30000 })
      }
      async function claimed(ids: string[]): Promise<void> {
        const until = Date.now() + 30000
        while (Date.now() < until) {
          const rows = readFileSync(relay.audit, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { gateId: string; event?: string })
          if (
            ids.every(id =>
              rows.some(row => row.gateId === id && row.event == null)
            )
          )
            return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw Error(
          'Both application requests must reach the deterministic barrier'
        )
      }
      for (const actor of ['one', 'two'])
        await controlRecovery(faultControl, [
          actor,
          'epoch-delay',
          'epoch-' + actor,
          '60000'
        ])
      const raceOne = 'First simultaneous fresh message'
      const raceTwo = 'Second simultaneous fresh message'
      console.log(
        'E12: holding both actual fresh epoch publications before releasing them together'
      )
      const publication = Promise.all([send(one, raceOne), send(two, raceTwo)])
      publication.catch(() => {})
      await claimed(['epoch-one', 'epoch-two'])
      assert.equal((await client.chatEpochs(dm.id, 0)).epochs.length, 1)
      await controlRecovery(faultControl, ['clear'])
      await publication
      for (const m of [one, two]) {
        await message(m, raceOne)
        await message(m, raceTwo)
        assert(!(await body(m)).includes(first))
      }
      const won = await client.chatEpochs(dm.id, 0)
      assert.deepEqual(
        won.epochs.map(row => row.chainBreak),
        [false, true]
      )
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        3
      )
      writeFileSync(
        join(f.artifacts, 'concurrent-fresh-messages.png'),
        await one.screenshot()
      )

      for (const actor of ['one', 'two'])
        await controlRecovery(faultControl, [
          actor,
          'history-delay',
          'history-' + actor,
          '60000'
        ])
      const reopen = Promise.all([open(one, dm.id), open(two, dm.id)])
      reopen.catch(() => {})
      await claimed(['history-one', 'history-two'])
      console.log(
        'E12: returning history holder while current sends and recovery deliveries are pending'
      )
      const holder = await attach('Hs', 'first-holder')
      await open(holder, dm.id)
      for (const text of [first, raceOne, raceTwo]) await message(holder, text)
      const duringOne = 'Current message during first recovery delivery'
      const duringTwo = 'Current message during second recovery delivery'
      for (const actor of ['one', 'two'])
        await controlRecovery(faultControl, [
          actor,
          'pending-success',
          'send-' + actor,
          '60000'
        ])
      const sends = Promise.all([send(one, duringOne), send(two, duringTwo)])
      sends.catch(() => {})
      await claimed(['send-one', 'send-two'])
      const heldAudit = readFileSync(relay.audit, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { gateId: string; event?: string })
      assert(
        !heldAudit.some(
          row =>
            ['history-one', 'history-two', 'send-one', 'send-two'].includes(
              row.gateId
            ) && row.event === 'delay-released'
        ),
        'Recovery and send barriers must still be held together'
      )
      await controlRecovery(faultControl, ['clear'])
      await Promise.all([reopen, sends])
      const texts = [first, raceOne, raceTwo, duringOne, duringTwo]
      for (const m of [one, two, holder])
        for (const text of texts) await message(m, text)
      assert.deepEqual((await client.chatEpochs(dm.id, 0)).epochs, won.epochs)
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        5
      )
      for (const m of [one, two]) {
        const counts = await m.evalBrowserScript({
          script: `return JSON.stringify(${JSON.stringify(texts)}.map(text => [...document.querySelectorAll('[data-testid^="chat-message-row-"]')].filter(row => row.textContent.includes(text)).length))`
        })
        assert.deepEqual(JSON.parse(String(counts.data)), [1, 1, 1, 1, 1])
      }
      for (const text of texts) {
        assert(
          !readFileSync(apiLog, 'utf8').includes(text),
          'Server log must not include message plaintext'
        )
        assert(
          !readFileSync(relay.audit, 'utf8').includes(text),
          'Fault audit must remain metadata only'
        )
      }
      writeFileSync(
        join(f.artifacts, 'concurrent-recovered-history.png'),
        await one.screenshot()
      )
      writeFileSync(
        join(f.artifacts, 'race-results.json'),
        JSON.stringify(
          {
            source: f.source,
            simultaneousPublications: 2,
            freshEpochs: 1,
            posts: 5,
            duplicateRows: false,
            historyRecovered: true,
            plaintextLogged: false
          },
          null,
          2
        )
      )
      console.log(
        'PASS E12 web: simultaneous fresh publications yield one epoch; both sends survive; concurrent history recovery preserves every message without duplicates or plaintext logs'
      )
      return
    }

    console.log(
      `${scenario}: creating second segment with first holder offline`
    )
    const holderTwo = await attach('Hk', 'second-holder')
    await open(holderTwo, dm.id)
    await holderTwo.assertVisible({ text: 'Locked message', timeout: 30000 })
    await send(holderTwo, second)
    assert(!(await body(holderTwo)).includes(first))
    if (nativePreparation != null) {
      const readOnly =
        scenario === 'E6'
          ? (await (await asPerson('Hk')).chatConversations()).find(
              row =>
                row.kind === 'seasonAnnouncements' &&
                !row.canPost &&
                !row.closed
            )
          : undefined
      if (scenario === 'E6')
        assert(
          readOnly != null,
          'Native permission fixture needs a real read-only scope'
        )
      const posts = (await client.chatMessages(dm.id)).filter(
        row => row.kind === 'post'
      )
      assert.equal(posts.length, olderBodies.length + 2)
      const current = posts.at(-1)!
      const oldPosts = posts.slice(0, -1).map((post, index) => ({
        id: post.id,
        body: [first, ...olderBodies][index]
      }))
      const nativeFile = join(f.artifacts, 'native-fixture.json')
      const recoveryFile = join(f.artifacts, 'native-recovery.json')
      const linkFile = join(f.artifacts, 'native-link-request.json')
      writeFileSync(
        nativeFile,
        JSON.stringify(
          {
            synthetic: true,
            disposable: true,
            appId: 'app.teamstation.app',
            scheme: 'teamstation',
            apiUrl: f.apiUrl,
            actor: people.Hk,
            conversationId: dm.id,
            conversationLabel: dmTitle(
              people.Hk.userId,
              undefined,
              dm.people ?? []
            ),
            scopeName: 'Direct message',
            scopePill: 'Direct message',
            targetText: second,
            replyText: second,
            originalMessageIds: [current.id],
            draft: 'Keep this draft while older history is recovered',
            probePost: 'Current native message during history recovery',
            orientationPolicy: 'portrait-only'
          },
          null,
          2
        ),
        { mode: 0o600, flag: 'wx' }
      )
      writeFileSync(
        recoveryFile,
        JSON.stringify(
          {
            synthetic: true,
            source: f.source,
            scenario,
            platform: nativePreparation,
            actorUserId: people.Hk.userId,
            conversationId: dm.id,
            oldPosts,
            current: { id: current.id, body: second },
            anchor: oldPosts[Math.floor(oldPosts.length / 2)],
            ...(scenario === 'E6'
              ? { departing: [people.Ha, people.Hs], readOnlyId: readOnly!.id }
              : {}),
            origin: f.origin,
            holder: {
              profile: join(f.artifacts, 'profiles', 'first-holder'),
              email: people.Hs.email,
              password: people.Hs.password
            }
          },
          null,
          2
        ),
        { mode: 0o600, flag: 'wx' }
      )
      writeFileSync(
        join(f.artifacts, 'native-env.sh'),
        recoveryFixtureEnvironment({
          TS_CHAT_WEB_URL: f.origin,
          TS_CHAT_API_URL: f.apiUrl,
          CHAT_UI_SEED_FILE: f.seedFile,
          CHAT_UI_ARTIFACTS: f.artifacts,
          CHAT_UI_NATIVE_FIXTURE_FILE: nativeFile,
          CHAT_UI_NATIVE_RECOVERY_FIXTURE: recoveryFile,
          CHAT_UI_NATIVE_RESULTS: join(f.artifacts, 'native-results'),
          CHAT_UI_NATIVE_OBSERVER_CACHE: join(
            f.artifacts,
            'native-observer.json'
          ),
          CHAT_UI_NATIVE_LINK_REQUEST: linkFile,
          CHAT_RECOVERY_NATIVE_LINK_RECEIPT: join(
            f.artifacts,
            'link-results',
            `${nativePreparation}-m4-locked-link-results.json`
          ),
          CHAT_UI_LOCKED_LINK_REQUEST: linkFile,
          CHAT_UI_NATIVE_STAGE: 'M4',
          CHAT_UI_NATIVE_DISPOSABLE: '1',
          CHAT_PLATFORM: nativePreparation,
          CHAT_UI_LOCKED_ACTOR: 'Hk',
          CHAT_UI_LOCKED_CONVERSATION: dm.id,
          CHAT_UI_LOCKED_ORIGINAL: current.id,
          CHAT_UI_LOCKED_ORIGINAL_BODY: second,
          CHAT_UI_PROFILE_DIR: join(f.artifacts, 'profiles', 'second-holder'),
          CHAT_RECOVERY_FIXTURE_SOURCE: f.source
        }),
        { mode: 0o600, flag: 'wx' }
      )
      console.log(
        `${scenario}: native fixture prepared with old holders offline and current access independent of history`
      )
      return
    }
    if (scenario === 'E11') {
      const recipientApi = await asPerson('Hk')
      const beforeDevices = await recipientApi.chatDevices()
      const originalDevice = beforeDevices.find(row => row.revokedAt == null)
      assert(originalDevice != null)
      const pending = (await client.chatHistoryGrants()).requests.find(
        row => row.conversationId === dm.id && row.userId === people.Hk.userId
      )
      assert(pending != null, 'Recovery must be pending before removal')
      await recipientApi.leaveDm(dm.id)
      await holderTwo.openLink({ link: f.origin + '/chat/' + dm.id })
      await holderTwo.assertVisible({
        text: 'Chat could not be opened.',
        timeout: 30000
      })
      await assert.rejects(
        async () => await recipientApi.chatEpochs(dm.id, 0),
        {
          code: 'notFound'
        }
      )
      const retained = await attach('Ha', 'recipient-old')
      await open(retained, dm.id)
      for (const text of [first, second]) await message(retained, text)
      assert(
        !(await client.chatHistoryGrants()).requests.some(
          row => row.conversationId === dm.id && row.userId === people.Hk.userId
        ),
        'A removed recipient must have no fulfillable history request'
      )
      assert(!(await body(holderTwo)).includes(first))
      writeFileSync(
        join(f.artifacts, 'removed-during-recovery.png'),
        await holderTwo.screenshot()
      )
      await close(retained)
      await close(holderTwo)
      await client.addDmMembers(dm.id, [people.Hk.userId])

      console.log(
        'E11: resetting the rejoined recipient before any holder returns'
      )
      const replacement = await attach('Hk', 'replacement-identity')
      await replacement.assertVisible({
        text: 'Link this device',
        timeout: 30000
      })
      await replacement.tapOn({ text: 'I can’t reach my other devices' })
      await replacement.tapOn({ text: 'Reset chat on this device' })
      await replacement.assertVisible({
        css: '[data-testid="chat-conversation-list"]',
        timeout: 30000
      })
      await open(replacement, dm.id)
      await send(replacement, third)
      for (const text of [first, second])
        assert(!(await body(replacement)).includes(text))
      const devicesAfterReset = await recipientApi.chatDevices()
      assert(
        devicesAfterReset.find(row => row.id === originalDevice.id)
          ?.revokedAt != null
      )
      const replacementDevice = devicesAfterReset.find(
        row => row.revokedAt == null
      )
      assert(replacementDevice != null)
      const replacementRequest = (
        await client.chatHistoryGrants()
      ).requests.find(
        row => row.conversationId === dm.id && row.userId === people.Hk.userId
      )
      assert(replacementRequest != null)
      assert.notEqual(replacementRequest.identityId, pending.identityId)

      const returning = await attach('Ha', 'recipient-old')
      await open(returning, dm.id)
      for (const text of [first, second, third]) await message(returning, text)
      for (const text of [first, second])
        assert(!(await body(replacement)).includes(text))
      await replacement.assertVisible({ text: 'Locked message' })
      writeFileSync(
        join(f.artifacts, 'reset-awaiting-approval.png'),
        await replacement.screenshot()
      )
      await returning.tapOn({ text: 'Review', timeout: 30000 })
      await returning.assertVisible({
        text: 'OLD SAFETY WORDS',
        timeout: 30000
      })
      await returning.tapOn({ text: 'Approve', timeout: 30000 })
      for (const text of [first, second, third])
        await message(replacement, text)
      const revoked = await attach('Hk', 'second-holder')
      await revoked.assertVisible({ text: 'Link this device', timeout: 30000 })
      assert(!(await body(revoked)).includes(first))
      writeFileSync(
        join(f.artifacts, 'revoked-device-blocked.png'),
        await revoked.screenshot()
      )
      const otherHolder = await attach('Hs', 'first-holder')
      await open(otherHolder, dm.id)
      for (const text of [first, second, third])
        await message(otherHolder, text)
      const epochs = await client.chatEpochs(dm.id, 0)
      assert.deepEqual(
        epochs.epochs.map(row => row.chainBreak),
        [false, true, true]
      )
      assert.equal(
        (await client.chatMessages(dm.id)).filter(row => row.kind === 'post')
          .length,
        3
      )
      writeFileSync(
        join(f.artifacts, 'authorization-results.json'),
        JSON.stringify(
          {
            source: f.source,
            removedRequestId: pending.id,
            oldIdentityId: pending.identityId,
            currentIdentityId: replacementRequest.identityId,
            removedReadDenied: true,
            oldDeviceRevoked: true,
            replacementRequiredApproval: true,
            retainedHoldersReadable: true,
            posts: 3
          },
          null,
          2
        )
      )
      console.log(
        'PASS E11 web: removal cancels pending recovery; reset revokes the old device; replacement history requires approval; remaining holders retain all messages'
      )
      return
    }
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
      try {
        for (const m of devices) await m.detach().catch(() => {})
        await daemon.shutdown({ wait: 15000 })
        await daemon.close()
      } finally {
        if (serverControl != null) await serverControl('enabled')
      }
    }
  }
}
