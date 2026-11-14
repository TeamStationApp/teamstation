import { createECDH, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page
} from 'puppeteer'

import { TeamStationClient } from '../common/api'
import { makeId } from '../common/ids'
import type { ChatRead, ChatWake, EventReminder } from '../common/push'
import { createSession } from '../server/auth/sessions'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { makeDatabase } from '../server/db/database'
import type { PushLogRecord } from '../server/push/log'
import { makePushEnqueuer } from '../server/push/queue'
import { dueReminders } from '../server/push/rsvpReminders'
import type { ServerConfig } from '../server/serverConfig'
import { readSeedTable, type SeedTablePerson } from '../test/chatSeedTable'
import { ChatEngine } from './chat/engine/engine'
import type { ChatKeyRecord } from './chat/keyRecord'
import {
  browserLaunchOptions,
  type WebCoverage,
  webCoverage
} from './push/webCoverage.e2e'

/**
 * Notifications in the finished web app, against a running API and web app
 * with the chat fixture in their database:
 *
 *   scripts/chat-e2e-reset.sh <run>       # the fixture, and <run>/seed.txt
 *   npm start                             # with push.logFile and webPush set
 *   TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 npm run start.web
 *   TS_NOTIFY_ARTIFACTS=<dir> TS_NOTIFY_SEED=<run>/seed.txt \
 *     TS_NOTIFY_CONFIG=serverConfig.json \
 *     npx mocha -r sucrase/register --timeout 600000 src/app/notifications.e2e.ts
 *
 * `scripts/push-coverage.mjs run web` starts all of it on ports of its own
 * and measures it. `TS_NOTIFY_CONFIG` is the API's `serverConfig.json`: its
 * database is where these checks read and what the reminder sweep runs on,
 * its `push.logFile` is where every push its push sender sends is written,
 * and its `redis` is the push queue the reminder sweep's requests go on. `TS_NOTIFY_WEB` and `TS_NOTIFY_API` are the two
 * addresses (the defaults above). With `TS_NOTIFY_COVERAGE` set, the pages'
 * and the service worker's V8 coverage is written there, mapped through the
 * maps in `TS_NOTIFY_SERVED` (the web app's served directory).
 *
 * People are the fixture's: P1 is Eagles admin Ea, P2 coach Ec and P3
 * scorekeeper Ek. Each browser is one device, signed in with a session made
 * for it. A push the server sends is delivered to the browser twice over:
 * by Chrome's push service (the server sends real Web Push), and by replaying
 * its `push.jsonl` record into the service worker through CDP
 * (`ServiceWorker.deliverPushMessage`), which needs no network. Only
 * notifications tagged `chat:` or `event:` are TeamStation's; the browser may
 * add its own when a push shows nothing.
 */
const artifacts = required('TS_NOTIFY_ARTIFACTS')
const WEB = (process.env.TS_NOTIFY_WEB ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const API = (
  process.env.TS_NOTIFY_API ?? 'http://127.0.0.1:9100/api/v1'
).replace(/\/+$/, '')
const MESSAGES = 'Notify for direct messages and mentions'
const RSVP_EVENTS = 'Notify for RSVPed events'
const BLOCKED = 'Notifications are blocked by this device'
const ALLOW = 'Allow notifications on this device'
const WITHIN_MS = 5000

const LOGS = {
  n1: 'settings-two-devices.log',
  n3: 'web-dm-mention-notifications.log',
  /** N3 steps 8–9, the seen-message steps, on their own. */
  seen: 'web-seen-guard-and-clear.log',
  n4: 'web-reminder-tap.log'
}

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Set ${name}`)
  return value
}

async function line(log: keyof typeof LOGS, text: string): Promise<void> {
  await appendFile(path.join(artifacts, LOGS[log]), text + '\n')
}

async function until<T>(
  what: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs = 30000
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

let config: ServerConfig
let db: ReturnType<typeof makeDatabase>
let seed: Record<string, SeedTablePerson>
let browser: Browser
let coverage: WebCoverage
const pages: Page[] = []

/** The records the server's log transport has written, in order. */
async function records(): Promise<PushLogRecord[]> {
  const file = config.push?.logFile ?? ''
  const text = await readFile(file, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(row => row !== '')
    .map(row => JSON.parse(row) as PushLogRecord)
}

/** A signed-in API client for `person`, as a phone would hold one. */
async function clientOf(person: SeedTablePerson): Promise<TeamStationClient> {
  const { token } = await createSession(db, person.userId, 'notifications-e2e')
  return new TeamStationClient({ baseUrl: API, token })
}

interface Device {
  name: string
  context: BrowserContext
  page: Page
  sessionId: string
}

/**
 * A browser of its own for `person`, signed in, at phone width. Chrome has
 * no Push API in a context of its own (incognito), so the one device that is
 * pushed to is the browser's own profile.
 */
async function open(
  name: string,
  person: SeedTablePerson,
  notifications: 'granted' | 'denied' | 'prompt' = 'prompt',
  pushed = false
): Promise<Device> {
  const { token, sessionId } = await createSession(
    db,
    person.userId,
    'notifications-e2e'
  )
  const context = pushed
    ? browser.defaultBrowserContext()
    : await browser.createBrowserContext()
  await allow(context, notifications)
  await context.setCookie({
    name: SESSION_COOKIE,
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true
  })
  const page = await context.newPage()
  page.on('pageerror', error => {
    console.error(`${name}: browser error:`, error)
  })
  page.on('console', message => {
    if (message.type() === 'error')
      console.error(`${name}: console: ${message.text()}`)
  })
  await coverage.track(page)
  pages.push(page)
  await page.setViewport({ width: 390, height: 3000, deviceScaleFactor: 2 })
  return { name, context, page, sessionId }
}

/** Sets the page origin's notification (and push) permission. */
async function allow(
  context: BrowserContext,
  state: 'granted' | 'denied' | 'prompt'
): Promise<void> {
  await context.setPermission(
    WEB,
    { permission: { name: 'notifications' }, state },
    { permission: { name: 'push', userVisibleOnly: true }, state }
  )
}

async function account(device: Device): Promise<void> {
  await device.page.goto(`${WEB}/account`, { waitUntil: 'networkidle0' })
  await device.page.waitForSelector(`input[aria-label="${MESSAGES}"]`, {
    timeout: 60000
  })
}

const checked = async (device: Device, label: string): Promise<boolean> =>
  await device.page.$eval(
    `input[aria-label="${label}"]`,
    input => input.checked
  )

async function flip(device: Device, label: string): Promise<void> {
  await device.page.$eval(`input[aria-label="${label}"]`, input => {
    input.click()
  })
}

/** Waits for `device` to show `on`, without a reload: ms since `started`. */
async function follows(
  device: Device,
  label: string,
  on: boolean,
  started = Date.now()
): Promise<number> {
  // A string, not a function: sucrase rewrites `?.` in a function into a
  // helper the page does not have.
  await device.page.waitForFunction(
    `document.querySelector('input[aria-label="${label}"]')?.checked === ${on}`,
    { timeout: WITHIN_MS }
  )
  return Date.now() - started
}

/** A button by the words it shows. */
async function pressText(device: Device, words: string): Promise<void> {
  const node = await until(`a button saying ${words}`, async () => {
    for (const handle of await device.page.$$('[role="button"]')) {
      const said = await handle.evaluate(node => node.textContent)
      if (said?.endsWith(words) === true) return handle
    }
    return undefined
  })
  await node.click()
}

const text = async (device: Device): Promise<string> =>
  await device.page.evaluate(() => document.body.innerText)

/** Each section header's place on the page, top to bottom. */
async function sections(device: Device): Promise<string[]> {
  return await device.page.evaluate(() =>
    [...document.querySelectorAll('div')]
      .filter(node => node.childElementCount === 0)
      .map(node => String(node.textContent))
      .filter(title =>
        ['CHAT', 'NOTIFICATIONS', 'WALK-UP SONGS', 'API KEYS'].includes(title)
      )
  )
}

/** Account from Chat down to Sign out, as `account-web-before.png` frames it. */
async function frame(device: Device, file: string): Promise<void> {
  await device.page.screenshot({
    path: path.join(artifacts, file),
    clip: await device.page.evaluate(() => {
      const find = (words: string): Element =>
        [...document.querySelectorAll('div')].find(
          node => node.childElementCount === 0 && node.textContent === words
        )!
      const top = find('CHAT').getBoundingClientRect().top
      const bottom = find('Sign out').getBoundingClientRect().top
      return { x: 0, y: top - 16, width: 390, height: bottom - top + 8 }
    })
  })
}

/** What the page's service worker registration is showing now. */
async function shown(
  device: Device
): Promise<Array<{ title: string; body: string; tag: string }>> {
  return await device.page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications()).map(note => ({
      title: note.title,
      body: note.body,
      tag: note.tag
    }))
  })
}

async function closeShown(device: Device): Promise<number> {
  return await device.page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const all = await registration.getNotifications()
    for (const note of all) note.close()
    return all.length
  })
}

const ours = (
  notes: Array<{ title: string; body: string; tag: string }>
): typeof notes =>
  notes.filter(
    note => note.tag.startsWith('chat:') || note.tag.startsWith('event:')
  )

/** The page's CDP session, with its service worker registration's id. */
async function workerControl(
  device: Device
): Promise<{ cdp: CDPSession; registrationId: () => string }> {
  const cdp = await device.page.createCDPSession()
  let id: string | undefined
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
    for (const registration of event.registrations)
      if (!registration.isDeleted && registration.scopeURL === `${WEB}/`)
        id = registration.registrationId
  })
  await cdp.send('ServiceWorker.enable')
  await until('the service worker registration', async () => id)
  return { cdp, registrationId: () => id! }
}

/**
 * Restarts the page's service worker until it was measured from its start
 * (`webCoverage`). A restarted worker runs its script again, and nothing
 * else changes for the page.
 */
async function measuredWorker(control: { cdp: CDPSession }): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await coverage.counted(`${WEB}/sw.js`)) return
    await control.cdp.send('ServiceWorker.stopAllWorkers')
    await control.cdp.send('ServiceWorker.startWorker', { scopeURL: `${WEB}/` })
    await pause(500)
  }
  throw new Error('The service worker could not be measured from its start')
}

/** Replays a logged web push into the page's service worker. */
async function deliver(
  control: { cdp: CDPSession; registrationId: () => string },
  record: PushLogRecord
): Promise<void> {
  if (record.message.platform !== 'web')
    throw new Error('Only a web push replays into a browser')
  await control.cdp.send('ServiceWorker.deliverPushMessage', {
    origin: WEB,
    registrationId: control.registrationId(),
    data: record.message.payload
  })
}

/**
 * A tap on the notification tagged `tag`: the browser has no way to click
 * one from a test, so the worker is handed the `notificationclick` the
 * browser would fire, through the worker's own debugger session.
 */
async function tap(tag: string): Promise<void> {
  const workers = coverage.workers()
  if (workers.length === 0) throw new Error('No service worker is running')
  const answer = await workers.at(-1)!.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const notes = await self.registration.getNotifications({ tag: ${JSON.stringify(tag)} })
      if (notes.length === 0) return 'no notification tagged ${tag}'
      const click = new NotificationEvent('notificationclick', { notification: notes[0] })
      // A script's own event may not wait; the browser's would.
      Object.defineProperty(click, 'waitUntil', { value: () => undefined })
      self.dispatchEvent(click)
      return 'clicked'
    })()`
  })
  if (answer.result.value !== 'clicked')
    throw new Error(
      String(answer.result.value ?? answer.exceptionDetails?.text)
    )
}

/** A chat engine for `person` on a device of its own, keys held in memory. */
async function engineOf(
  person: SeedTablePerson,
  client: TeamStationClient
): Promise<ChatEngine> {
  let held: ChatKeyRecord | undefined
  const engine = new ChatEngine({
    client,
    userId: person.userId,
    device: { name: 'Notifications e2e', platform: 'web' },
    store: {
      load: async () => held,
      exists: async () => held != null,
      save: async record => {
        held = record
      },
      wipe: async () => {
        held = undefined
      }
    }
  })
  expect(await engine.start()).equals('ready')
  return engine
}

/** A browser subscription's shape, for an address nobody will ever push to. */
function unusedSubscription(): string {
  const keys = createECDH('prime256v1')
  keys.generateKeys()
  return JSON.stringify({
    endpoint: `https://fcm.googleapis.com/fcm/send/notify-e2e-${randomBytes(8).toString('hex')}`,
    keys: {
      p256dh: keys.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    }
  })
}

describe('notifications in the finished web app', function () {
  this.timeout(600000)
  let p1: SeedTablePerson
  let p2: SeedTablePerson
  let p3: SeedTablePerson
  /** P2's browser, from N2 on. */
  let phone: Device
  let control: Awaited<ReturnType<typeof workerControl>>
  /** Where P2's browser is subscribed: its push service. */
  let endpointHost: string
  let dmId: string
  let dmText: string

  before(async () => {
    config = JSON.parse(
      await readFile(required('TS_NOTIFY_CONFIG'), 'utf8')
    ) as ServerConfig
    if (config.push?.logFile == null || config.push.logFile === '')
      throw new Error('The API must log its pushes: set push.logFile')
    if (
      !/^postgres(ql)?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(
        config.databaseUrl
      )
    )
      throw new Error('TS_NOTIFY_CONFIG does not name a local database')
    db = makeDatabase(config.databaseUrl)
    seed = readSeedTable(await readFile(required('TS_NOTIFY_SEED'), 'utf8'))
    p1 = seed.Ea
    p2 = seed.Ec
    p3 = seed.Ek
    await mkdir(artifacts, { recursive: true })
    for (const log of Object.values(LOGS))
      await writeFile(path.join(artifacts, log), '')
    browser = await puppeteer.launch({
      headless: true,
      ...browserLaunchOptions
    })
    coverage = await webCoverage(browser, {
      origin: WEB,
      served: path.resolve(process.env.TS_NOTIFY_SERVED ?? 'dist'),
      measure: process.env.TS_NOTIFY_COVERAGE != null
    })
  })
  after(async () => {
    const output = process.env.TS_NOTIFY_COVERAGE
    if (output != null && browser != null) await coverage.record(output)
    await browser?.close()
    await db?.destroy()
  })

  it('N1: a switch saved on one device shows on the other at once, and stays', async () => {
    await line(
      'n1',
      '$ TS_NOTIFY_ARTIFACTS=<dir> npx mocha -r sucrase/register --timeout 600000 src/app/notifications.e2e.ts'
    )
    const a = await open('A', p1)
    const b = await open('B', p1)
    const state = async (device: Device, when: string): Promise<void> => {
      await line(
        'n1',
        `$ ${device.name} ${when}: ${MESSAGES} ${(await checked(device, MESSAGES)) ? 'on' : 'off'}`
      )
    }
    for (const device of [a, b]) {
      // What it sends, and the hints the socket brings it.
      device.page.on('request', request => {
        if (
          request.url().endsWith('/api/v1/me/account/notifications') &&
          request.method() === 'PUT'
        )
          request
            .fetchPostData()
            .then(async body => {
              await line(
                'n1',
                `${device.name}: PUT /me/account/notifications ${body}`
              )
            })
            .catch(() => undefined)
      })
      const cdp = await device.page.createCDPSession()
      await cdp.send('Network.enable')
      cdp.on('Network.webSocketFrameReceived', event => {
        const data = event.response.payloadData
        if (data.includes('"chatUser"'))
          line('n1', `${device.name}: socket frame ${data}`).catch(
            () => undefined
          )
      })
      await account(device)
    }
    // Notifications sits after Chat and before API keys.
    const order = await sections(a)
    expect(order.indexOf('NOTIFICATIONS')).equals(order.indexOf('CHAT') + 1)
    expect(order.indexOf('API KEYS')).greaterThan(
      order.indexOf('NOTIFICATIONS')
    )
    await line('n1', `$ A sections: ${order.join(' > ')}`)
    await state(a, 'opened')
    await state(b, 'opened')

    let started = Date.now()
    await flip(a, MESSAGES)
    await follows(a, MESSAGES, true)
    const on = await follows(b, MESSAGES, true, started)
    await state(a, 'after A turned it on')
    await state(b, `${on} ms after A's tap, no reload`)
    await frame(b, 'settings-device-b-follows.png')

    started = Date.now()
    await flip(b, MESSAGES)
    await follows(b, MESSAGES, false)
    const off = await follows(a, MESSAGES, false, started)
    await state(b, 'after B turned it off')
    await state(a, `${off} ms after B's tap, no reload`)

    // Kept for the account: a reload reads what was saved.
    await flip(a, MESSAGES)
    await follows(b, MESSAGES, true)
    for (const device of [a, b]) {
      await account(device)
      expect(await checked(device, MESSAGES)).equals(true)
      await state(device, 'after a reload')
    }
    const saved = await db
      .selectFrom('user_notification_settings')
      .select(['messages', 'rsvp_events'])
      .where('user_id', '=', p1.userId)
      .executeTakeFirstOrThrow()
    expect(saved).deep.equals({ messages: true, rsvp_events: false })
    await line('n1', `$ stored: ${JSON.stringify(saved)}`)
    for (const device of [a, b]) await device.page.close()
  })

  it('N2: a refused browser keeps the switch on, says so, and registers once allowed', async () => {
    const say = (words: string): void => {
      console.log(`      ${words}`)
    }
    phone = await open('P2', p2, 'denied', true)
    await account(phone)
    say(`$ P2 (${p2.name}) opens Account with notifications denied`)
    await flip(phone, RSVP_EVENTS)
    await follows(phone, RSVP_EVENTS, true)
    await until('the blocked line', async () =>
      (await text(phone)).includes(BLOCKED)
    )
    expect(await checked(phone, RSVP_EVENTS)).equals(true)
    expect(await text(phone)).not.contains(ALLOW)
    say(`$ ${RSVP_EVENTS} on; "${BLOCKED}" shown`)
    await frame(phone, 'account-web-blocked.png')
    const count = async (): Promise<number> =>
      Number(
        (
          await db
            .selectFrom('push_registrations')
            .select(eb => eb.fn.countAll().as('n'))
            .where('session_id', '=', phone.sessionId)
            .executeTakeFirstOrThrow()
        ).n
      )
    expect(await count()).equals(0)
    say(
      `$ select count(*) from push_registrations where session_id = <P2's>: 0`
    )

    // Asked again later: the browser offers to ask, and the person allows.
    await allow(phone.context, 'prompt')
    await account(phone)
    await until('the allow button', async () =>
      (await text(phone)).includes(ALLOW)
    )
    await allow(phone.context, 'granted')
    await pressText(phone, ALLOW)
    const row = await until(
      'a registration for this session',
      async () =>
        await db
          .selectFrom('push_registrations')
          .select(['id', 'platform', 'address_key'])
          .where('session_id', '=', phone.sessionId)
          .executeTakeFirst(),
      30000
    )
    expect(row.platform).equals('web')
    endpointHost = new URL(row.address_key).host
    say(
      `$ allowed, then ${ALLOW}: registration ${row.platform} at ${new URL(row.address_key).host}`
    )
    await until(
      'the blocked line to go',
      async () => !(await text(phone)).includes(BLOCKED)
    )
    control = await workerControl(phone)
    await measuredWorker(control)
  })

  it('N3: a DM and a mention notify the browser, and nothing else does', async () => {
    await line('n3', '$ P2 browser: chat set up, messages switch on')
    // P2's browser sets itself up for chat before anybody writes, so the
    // chats' keys are boxed for it.
    await phone.page.goto(`${WEB}/chat`, { waitUntil: 'networkidle2' })
    await until(
      'the chat list',
      async () =>
        (await phone.page.$('[data-testid="chat-conversation-list"]')) != null,
      60000
    )
    await account(phone)
    await flip(phone, MESSAGES)
    await follows(phone, MESSAGES, true)

    const sender = await clientOf(p1)
    const engine = await engineOf(p1, sender)
    const dm = await sender.createDm([p2.userId])
    dmId = dm.id
    const group = await until('Eagles Members in P1’s chats', async () => {
      const list = await engine.refresh()
      return list.find(
        chat => chat.kind === 'teamMembers' && chat.title === 'Eagles Members'
      )?.id
    })
    const stamp = Date.now().toString(36)
    dmText = `Bring the cones, ${stamp}`
    const mentionText = `@${p2.name} has the scorebook, ${stamp}`
    const plainText = `Practice moved inside, ${stamp}`
    const before = (await records()).length
    await engine.open(dmId)
    const sentDm = await engine.sendText(dmId, dmText)
    await engine.open(group)
    await engine.sendText(group, mentionText, { mentions: [p2.userId] })
    await engine.sendText(group, plainText)
    await line(
      'n3',
      `$ P1 (${p1.name}) sends P2 a DM "${dmText}", "${mentionText}" mentioning P2 in Eagles Members, and "${plainText}" there`
    )
    const toP2 = async (): Promise<PushLogRecord[]> =>
      (await records())
        .slice(before)
        .filter(
          record => record.userId === p2.userId && record.platform === 'web'
        )
    const sent = await until('three wakes for P2', async () => {
      const found = await toP2()
      return found.length >= 3 ? found : undefined
    })
    expect(sent).lengthOf(3)
    for (const record of sent) {
      const wake = JSON.parse(
        record.message.platform === 'web' ? record.message.payload : '{}'
      ) as ChatWake
      expect(wake.t).equals('chat')
      expect(wake.u).equals(p2.userId)
      await line(
        'n3',
        `push.jsonl: ${record.platform} ${record.registrationId} wake c=${wake.c} seq=${wake.seq} dm=${wake.dm} from="${wake.from}" title=${JSON.stringify(wake.title)} env=${wake.env == null ? 'fetched' : 'inline'}`
      )
    }
    const wakes = sent.map(
      record =>
        JSON.parse(
          record.message.platform === 'web' ? record.message.payload : '{}'
        ) as ChatWake
    )

    // The live push service may have shown them already; start clean.
    await pause(3000)
    await line(
      'n3',
      `live push service showed ${await closeShown(phone)} before the replay; closed`
    )
    for (const record of sent) {
      await deliver(control, record)
      await line(
        'n3',
        `$ CDP ServiceWorker.deliverPushMessage ${record.registrationId}`
      )
    }
    const notes = await until('two notifications', async () => {
      const found = ours(await shown(phone))
      return found.length >= 2 ? found : undefined
    })
    await pause(1500)
    const all = await shown(phone)
    await line(
      'n3',
      `$ registration.getNotifications(): ${JSON.stringify(all)}`
    )
    const chat = all.filter(note => note.tag.startsWith('chat:'))
    expect(chat).lengthOf(2)
    expect(notes).lengthOf(2)
    const dmWake = wakes.find(wake => wake.dm)!
    const groupWake = wakes.find(wake => !wake.dm)!
    expect(chat).deep.include({
      title: dmWake.from,
      body: dmText,
      tag: `chat:${dmId}`
    })
    expect(groupWake.title).equals('Eagles Members')
    expect(chat).deep.include({
      title: `${groupWake.from} in Eagles Members`,
      body: mentionText,
      tag: `chat:${group}`
    })
    await line(
      'n3',
      `filtered by chat: tags: ${chat.length} — "${dmWake.from}" "${dmText}" and "${groupWake.from} in Eagles Members" "${mentionText}"; the plain message showed nothing`
    )

    // A reaction wakes nobody.
    const reacted = (await records()).length
    await engine.react(dmId, sentDm!.id, '👍')
    await pause(3000)
    expect((await records()).slice(reacted)).deep.equals([])
    await line('n3', '$ P1 reacts 👍 to the DM: no push.jsonl record')

    // Off: P2 is told of nothing.
    await flip(phone, MESSAGES)
    await follows(phone, MESSAGES, false)
    const off = (await records()).length
    await engine.sendText(dmId, `Are you there? ${stamp}`)
    await engine.sendText(group, `@${p2.name} again, ${stamp}`, {
      mentions: [p2.userId]
    })
    await pause(3000)
    expect(
      (await records()).slice(off).filter(record => record.userId === p2.userId)
    ).deep.equals([])
    await line(
      'n3',
      '$ P2 turns the switch off; P1 sends a DM and a mention: no push.jsonl record for P2'
    )

    // The live push service, end to end: the server's Web Push reaches the
    // browser through Chrome's push service, with no replay.
    await flip(phone, MESSAGES)
    await follows(phone, MESSAGES, true)
    await closeShown(phone)
    const live = `Live push check, ${stamp}`
    await engine.sendText(dmId, live)
    await line('n3', `$ P2 turns it on; P1 sends the DM "${live}"; no replay`)
    try {
      const arrived = await until(
        'the live push',
        async () =>
          (await shown(phone)).find(
            note => note.tag === `chat:${dmId}` && note.body === live
          ),
        60000
      )
      await line(
        'n3',
        `live push service (${endpointHost}): ${JSON.stringify(arrived)} shown`
      )
    } catch (error) {
      await line(
        'n3',
        `live push service: blocked: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const wakeOf = (record: PushLogRecord): ChatWake | ChatRead =>
      JSON.parse(
        record.message.platform === 'web' ? record.message.payload : '{}'
      ) as ChatWake | ChatRead
    const p2Web = (record: PushLogRecord): boolean =>
      record.userId === p2.userId && record.platform === 'web'

    // Seen: P2's browser shows the DM, focused and visible. A DM that comes
    // is read there within the hold and wakes nobody, and a wake for that
    // conversation shows nothing.
    await phone.page.goto(`${WEB}/chat/${dmId}`, { waitUntil: 'networkidle2' })
    await phone.page.bringToFront()
    await until('the DM on screen', async () =>
      (await text(phone)).includes(live)
    )
    await closeShown(phone)
    const onScreen = await phone.page.evaluate(
      () => `focused ${document.hasFocus()}, ${document.visibilityState}`
    )
    await line(
      'seen',
      '$ TS_NOTIFY_ARTIFACTS=<dir> npx mocha -r sucrase/register --timeout 600000 src/app/notifications.e2e.ts (N3 steps 8–9)'
    )
    await line('seen', `$ P2's browser opens /chat/${dmId}: ${onScreen}`)
    const seenFrom = (await records()).length
    const seenText = `Seen as it came, ${stamp}`
    await engine.sendText(dmId, seenText)
    await until('the DM in P2’s browser', async () =>
      (await text(phone)).includes(seenText)
    )
    // Past the stack's 2 s hold, and the sender's next turn.
    await pause(6000)
    const seenWakes = (await records())
      .slice(seenFrom)
      .filter(record => p2Web(record) && wakeOf(record).t === 'chat')
    expect(seenWakes).deep.equals([])
    await line(
      'seen',
      `$ P1 sends "${seenText}" while P2's browser shows the DM: read within the hold, no push.jsonl wake for P2`
    )
    const dmRecord = sent.find(record => (wakeOf(record) as ChatWake).dm)!
    await deliver(control, dmRecord)
    await pause(2000)
    const whileOpen = (await shown(phone)).filter(
      note => note.tag === `chat:${dmId}`
    )
    expect(whileOpen).deep.equals([])
    await line(
      'seen',
      `$ CDP ServiceWorker.deliverPushMessage of the DM's wake, its chat on screen: shown ${JSON.stringify(whileOpen)}`
    )

    // Read elsewhere: a DM shown here is closed by the read push the server
    // sends this browser once P2 reads it on another device.
    await account(phone)
    const shownFrom = (await records()).length
    const elsewhereText = `Read on another device, ${stamp}`
    await engine.sendText(dmId, elsewhereText)
    const wake = await until('the wake for P2’s browser', async () =>
      (await records())
        .slice(shownFrom)
        .find(record => p2Web(record) && wakeOf(record).t === 'chat')
    )
    await deliver(control, wake)
    const note = await until('the DM shown', async () =>
      (await shown(phone)).find(
        item => item.tag === `chat:${dmId}` && item.body === elsewhereText
      )
    )
    await line(
      'seen',
      `$ P2's browser on Account; P1 sends "${elsewhereText}": wake delivered, shown ${JSON.stringify(note)}`
    )
    const seq = wakeOf(wake).seq
    const otherDevice = await clientOf(p2)
    await otherDevice.markChatRead(dmId, seq)
    const read = await until('the read push for P2’s browser', async () =>
      (await records())
        .slice(shownFrom)
        .find(
          record =>
            record.registrationId === wake.registrationId &&
            wakeOf(record).t === 'read'
        )
    )
    expect(wakeOf(read)).deep.equals({
      t: 'read',
      u: p2.userId,
      c: dmId,
      seq
    })
    await deliver(control, read)
    await until('the DM notification to close', async () =>
      (await shown(phone)).every(item => item.tag !== `chat:${dmId}`)
    )
    await line(
      'seen',
      `$ P2 reads the DM to seq ${seq} on another device: push.jsonl ${JSON.stringify(wakeOf(read))} to this browser; delivered, chat:${dmId} closed`
    )
    engine.stop()
  })

  it('N4: a reminder for an RSVPed event, and taps that open it and the DM', async () => {
    const zone = 'America/Los_Angeles'
    const eventId = makeId('teamEvent')
    const startAt = new Date(Date.now() + 90 * 60 * 1000)
    const eagles = await db
      .selectFrom('memberships')
      .select('team_id')
      .where('user_id', '=', p2.userId)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('team_events')
      .values({
        id: eventId,
        team_id: eagles.team_id,
        title: 'Batting cage',
        start_at: startAt,
        timezone: zone,
        status: 'scheduled'
      })
      .execute()
    await line(
      'n4',
      `$ insert team event ${eventId} "Batting cage" for the Eagles at ${startAt.toISOString()} (in 90 minutes)`
    )
    const p2Client = await clientOf(p2)
    await p2Client.saveRsvp(eventId, p2.userId, 'yes')
    await line('n4', `$ P2 (${p2.name}) RSVPs yes`)
    // P3 would hear of RSVPed events, on a device, and has not answered.
    const p3Client = await clientOf(p3)
    await p3Client.setAccountNotifications({ rsvpEvents: true })
    const p3Registration = await p3Client.registerPush({
      platform: 'web',
      address: unusedSubscription(),
      environment: 'production'
    })
    await line(
      'n4',
      `$ P3 (${p3.name}) has RSVPed events on and registration ${p3Registration}, and no RSVP`
    )

    // The primary's sweep, run now rather than in up to five minutes: the
    // due starts go on the API's push queue, and its push sender sends.
    const queue = makePushEnqueuer(config, () => undefined)
    const due = await dueReminders(db, new Date())
    try {
      for (const request of due)
        await until(
          `queueing ${request.eventId}`,
          async () => await queue.add(request)
        )
    } finally {
      await queue.close()
    }
    await line(
      'n4',
      `$ dueReminders(db, now) queued on the API's push queue: ${JSON.stringify(due.filter(request => request.eventId === eventId))}`
    )
    const reminder = await until('the reminder in push.jsonl', async () =>
      (await records()).find(
        record =>
          record.userId === p2.userId &&
          record.platform === 'web' &&
          record.message.platform === 'web' &&
          record.message.payload.includes(eventId)
      )
    )
    expect(
      (await records()).filter(
        record => record.registrationId === p3Registration
      )
    ).deep.equals([])
    await line('n4', `push.jsonl for P3's registration: none`)
    const payload = JSON.parse(
      reminder.message.platform === 'web' ? reminder.message.payload : '{}'
    ) as EventReminder
    await line('n4', `push.jsonl for P2: ${JSON.stringify(payload)}`)
    expect(payload).include({
      t: 'event',
      u: p2.userId,
      title: 'Batting cage',
      url: `teamstation://games/${eventId}`,
      tag: `event:${eventId}`
    })
    expect(payload.body).matches(/^Starts at \d{1,2}:\d{2}\s?[AP]M$/)

    await deliver(control, reminder)
    await line(
      'n4',
      `$ CDP ServiceWorker.deliverPushMessage ${reminder.registrationId}`
    )
    const note = await until('the reminder', async () =>
      (await shown(phone)).find(item => item.tag === `event:${eventId}`)
    )
    expect(note).deep.equals({
      title: 'Batting cage',
      body: payload.body,
      tag: `event:${eventId}`
    })
    await line('n4', `shown: ${JSON.stringify(note)}`)

    await tap(`event:${eventId}`)
    await until(
      'the event page',
      async () => new URL(phone.page.url()).pathname === `/games/${eventId}`
    )
    await line(
      'n4',
      `$ tap the reminder (notificationclick in the worker): page at ${new URL(phone.page.url()).pathname}`
    )

    // The DM's notification from N3; replayed if the live one never came.
    if ((await shown(phone)).every(item => item.tag !== `chat:${dmId}`)) {
      const dmRecord = (await records()).find(
        record =>
          record.userId === p2.userId &&
          record.platform === 'web' &&
          record.message.platform === 'web' &&
          record.message.payload.includes(dmId)
      )!
      await deliver(control, dmRecord)
      await until('the DM notification', async () =>
        (await shown(phone)).find(item => item.tag === `chat:${dmId}`)
      )
    }
    await tap(`chat:${dmId}`)
    await until(
      'the conversation',
      async () => new URL(phone.page.url()).pathname === `/chat/${dmId}`
    )
    await line(
      'n4',
      `$ tap the DM notification: page at ${new URL(phone.page.url()).pathname}`
    )
    expect(dmText).not.equals('')
  })
})
