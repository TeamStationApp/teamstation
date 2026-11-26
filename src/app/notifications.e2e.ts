import { createECDH, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect } from 'chai'
import { sql } from 'kysely'
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
import { localClock, localDate } from '../common/umpireTime'
import { createSession } from '../server/auth/sessions'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { makeDatabase } from '../server/db/database'
import type { PushLogRecord } from '../server/push/log'
import { makePushEnqueuer } from '../server/push/queue'
import { dueReminders } from '../server/push/rsvpReminders'
import type { ServerConfig } from '../server/serverConfig'
import { recordUmpireDigests } from '../server/umpires/notices'
import { readSeedTable, type SeedTablePerson } from '../test/chatSeedTable'
import { ChatEngine } from './chat/engine/engine'
import type { ChatKeyRecord } from './chat/keyRecord'
import { askedKey, switchesKey } from './platform/notificationSwitches'
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
 * and measures it, and the suite runs that as
 * `npm run -s e2e -- run platform/push/browser#dms-mentions-reminders --surface web-chromium`. `TS_NOTIFY_CONFIG` is the API's `serverConfig.json`: its
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
 *
 * N5–N7 are QPLL admin L's Umpire Management Notifications, with umpire B
 * and A2, guardian G1, whom L makes a second admin.
 * Their proving artifacts (screenshots, `umpire-digest.log` and
 * `umpire-notices.log`) go to `TS_UMPIRE_PROOF` when it is set, as the
 * umpire end-to-end files' do, else to `TS_NOTIFY_ARTIFACTS`.
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
const LEAGUE_MANAGEMENT = 'Notify for league management'
const BLOCKED = 'Notifications are blocked by this device'
const ALLOW = 'Allow notifications on this device'
const WITHIN_MS = 5000
const ASK_TITLE =
  "TeamStation would like to send you notifications for events you've RSVP'd to and for direct messages from other users"
const ASK_WEB_BLOCKED =
  "Allow notifications for TeamStation in your browser's site settings."
/**
 * The ask's `$` lines from every run, web and phones, appended to: each run
 * starts with its command.
 */
const ASK_LOG = 'ask-flow.log'

const LOGS = {
  n1: 'settings-per-device.log',
  n3: 'web-dm-mention-notifications.log',
  /** N3 steps 8–9, the seen-message steps, on their own. */
  seen: 'web-seen-guard-and-clear.log',
  n4: 'web-reminder-tap.log',
  n1b: 'web-league-management-switch.log'
}

/** Where N5–N7's proving artifacts go. */
const proofs = process.env.TS_UMPIRE_PROOF ?? artifacts
const UMPIRE_LOGS = {
  n6: 'umpire-digest.log',
  n7: 'umpire-notices.log'
}

/** A line of an umpire case's log, among the proving artifacts. */
async function umpireLine(
  log: keyof typeof UMPIRE_LOGS,
  text: string
): Promise<void> {
  await appendFile(path.join(proofs, UMPIRE_LOGS[log]), text + '\n')
}

/** A proving artifact: `page`'s viewport, under its own name. */
async function proof(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => await document.fonts.ready)
  await pause(800)
  await page.screenshot({ path: path.join(proofs, name) })
}

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Set ${name}`)
  return value
}

async function line(log: keyof typeof LOGS, text: string): Promise<void> {
  await appendFile(path.join(artifacts, LOGS[log]), text + '\n')
}

/** A line of the ask's log, `ask-flow.log`, shared with the phones' runs. */
async function askLine(text: string): Promise<void> {
  await appendFile(path.join(artifacts, ASK_LOG), text + '\n')
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

/**
 * Waits for the server to hold `messages` as `on` on `device`'s own
 * registration: the switch reaches it by a PATCH the page sends after the
 * tap, and a wake is decided on what the registration says.
 */
async function serverHolds(device: Device, on: boolean): Promise<void> {
  await until(
    `${device.name}'s registration with messages ${on ? 'on' : 'off'}`,
    async () =>
      (
        await db
          .selectFrom('push_registrations')
          .select('messages')
          .where('session_id', '=', device.sessionId)
          .executeTakeFirst()
      )?.messages === on
  )
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

/** The app's ask about notifications, on show. */
const askShown = async (device: Device): Promise<boolean> =>
  (await device.page.$('[data-testid="notification-ask"]')) != null

/** Waits for the ask, and answers what it says. */
async function untilAsk(device: Device): Promise<string> {
  await device.page.waitForSelector('[data-testid="notification-ask"]', {
    timeout: 90000
  })
  return await device.page.$eval(
    '[data-testid="notification-ask"]',
    node => (node as HTMLElement).innerText
  )
}

/** Presses one of the ask's answers. */
async function answerAsk(
  device: Device,
  id: 'continue' | 'not-now' | 'done'
): Promise<void> {
  await device.page.$eval(`[data-testid="notification-ask-${id}"]`, node => {
    ;(node as HTMLElement).click()
  })
}

/** Waits `ms`, then says whether the ask is on show. */
async function askAfter(device: Device, ms: number): Promise<boolean> {
  await pause(ms)
  return await askShown(device)
}

/** Taps one of the app's tabs (Home, Chat, …) in its navigation. */
async function tab(device: Device, label: string): Promise<void> {
  await device.page.waitForSelector(`[role="tab"][aria-label="${label}"]`, {
    timeout: 60000
  })
  await device.page.$eval(`[role="tab"][aria-label="${label}"]`, node => {
    ;(node as HTMLElement).click()
  })
}

/** This browser's ask record and switches for `userId`, as `localStorage` keeps them. */
async function keptFor(
  device: Device,
  userId: string
): Promise<{ asked: string | null; switches: string | null }> {
  return await device.page.evaluate(
    (asked: string, switches: string) => ({
      asked: window.localStorage.getItem(asked),
      switches: window.localStorage.getItem(switches)
    }),
    askedKey(userId),
    switchesKey(userId)
  )
}

/**
 * Answers `userId`'s RSVP on the event page on show, through its RSVP sheet
 * (`index` 0 yes, 1 maybe, 2 no), and closes the sheet with Done once it has
 * saved.
 */
async function rsvpInApp(
  device: Device,
  userId: string,
  index: number
): Promise<void> {
  const pill = `[data-testid="event-rsvp-${userId}-${index}"]`
  await device.page.waitForSelector('[data-testid="event-replies-open"]', {
    timeout: 60000
  })
  await device.page.$eval('[data-testid="event-replies-open"]', node => {
    ;(node as HTMLElement).click()
  })
  await device.page.waitForSelector(pill, { timeout: 60000 })
  await device.page.$eval(pill, node => {
    ;(node as HTMLElement).click()
  })
  await device.page.waitForFunction(
    `document.querySelector('${pill}')?.getAttribute('aria-checked') === 'true' && !document.querySelector('[data-testid="event-rsvp-modal"] [aria-busy="true"]')`,
    { timeout: 30000 }
  )
  // Saved: the sheet's Done closes it.
  await pause(1000)
  expect(await askShown(device), 'never over the RSVP sheet').equals(false)
  await device.page.$$eval(
    '[data-testid="event-rsvp-modal"] [role="button"]',
    nodes => {
      for (const node of nodes)
        if ((node as HTMLElement).innerText === 'Done')
          (node as HTMLElement).click()
    }
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
  /** N4 sends a fresh DM with the same enrolled sender N3 used. */
  let senderEngine: ChatEngine | undefined

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
    await mkdir(proofs, { recursive: true })
    for (const log of Object.values(UMPIRE_LOGS))
      await writeFile(path.join(proofs, log), '')
    await askLine(
      '$ TS_NOTIFY_ARTIFACTS=<dir> npx mocha -r sucrase/register --timeout 600000 src/app/notifications.e2e.ts (web, Chrome)'
    )
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
    senderEngine?.stop()
    const output = process.env.TS_NOTIFY_COVERAGE
    if (output != null && browser != null) await coverage.record(output)
    await browser?.close()
    await db?.destroy()
  })

  it('N1: a switch turned on in one browser stays off in another of the same person’s, and stays on after a reload', async () => {
    await line(
      'n1',
      '$ TS_NOTIFY_ARTIFACTS=<dir> npx mocha -r sucrase/register --timeout 600000 src/app/notifications.e2e.ts'
    )
    const a = await open('A', p1)
    const b = await open('B', p1)
    const state = async (device: Device, when: string): Promise<void> => {
      const kept = await device.page.evaluate(
        (key: string) => window.localStorage.getItem(key),
        switchesKey(p1.userId)
      )
      const reads: string[] = []
      for (const label of [MESSAGES, RSVP_EVENTS, LEAGUE_MANAGEMENT])
        reads.push(`${label} ${(await checked(device, label)) ? 'on' : 'off'}`)
      await line(
        'n1',
        `$ ${device.name} ${when}: ${reads.join(', ')}; localStorage ${kept ?? '(nothing)'}`
      )
    }
    for (const device of [a, b]) {
      // Anything it tells the server about its switches.
      device.page.on('request', request => {
        const url = request.url()
        if (
          url.includes('/api/v1/me/account/notifications') ||
          (url.includes('/api/v1/me/push-registrations') &&
            request.method() !== 'GET')
        )
          request
            .fetchPostData()
            .then(async body => {
              await line(
                'n1',
                `${device.name}: ${request.method()} ${url.replace(API, '')} ${body ?? ''}`
              )
            })
            .catch(() => undefined)
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
    await line('n1', `$ A and B are two browsers, both signed in as P1`)
    // Three switches, all off in a browser never asked.
    for (const device of [a, b])
      for (const label of [MESSAGES, RSVP_EVENTS, LEAGUE_MANAGEMENT])
        expect(await checked(device, label), `${device.name} ${label}`).equals(
          false
        )
    await state(a, 'opened')
    await state(b, 'opened')

    await flip(a, MESSAGES)
    await follows(a, MESSAGES, true)
    await state(a, 'after A turned it on')
    // B is another device: it keeps its own, now and after a reload.
    await pause(WITHIN_MS)
    expect(await checked(b, MESSAGES)).equals(false)
    await state(b, `${WITHIN_MS} ms after A's tap`)
    await account(b)
    expect(await checked(b, MESSAGES)).equals(false)
    await state(b, 'after a reload')
    await frame(b, 'settings-device-b-independent.png')

    // A keeps its own across a reload.
    await account(a)
    expect(await checked(a, MESSAGES)).equals(true)
    expect(await checked(a, RSVP_EVENTS)).equals(false)
    expect(await checked(a, LEAGUE_MANAGEMENT)).equals(false)
    await state(a, 'after a reload')

    // Nothing is kept for the account: there is no account-wide table.
    const table = await sql<{
      found: string | null
    }>`select to_regclass('public.user_notification_settings')::text as found`.execute(
      db
    )
    expect(table.rows[0].found).equals(null)
    await line(
      'n1',
      `$ select to_regclass('public.user_notification_settings'): ${String(table.rows[0].found)}`
    )
    for (const device of [a, b]) await device.page.close()

    // 7. Entering messaging by the Chat tab asks someone this browser has
    // never asked, over the chat; Not Now is kept, and never asks again.
    const fresh = seed.D2
    const c = await open('C', fresh)
    await c.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
    await c.page.goto(`${WEB}/`, { waitUntil: 'networkidle0' })
    expect(await askAfter(c, 2000), 'not on Home').equals(false)
    await tab(c, 'Chat')
    const said = await untilAsk(c)
    expect(new URL(c.page.url()).pathname).equals('/chat')
    expect(said).contains(ASK_TITLE).and.contains('Continue')
    expect(said).contains('Not Now')
    await pause(800)
    await c.page.screenshot({ path: path.join(artifacts, 'ask-modal-web.png') })
    await askLine(
      `$ web N1.7: ${fresh.name}, never asked in this browser (notifications not decided), taps the Chat tab: the ask over /chat: ${JSON.stringify(said)}`
    )
    await answerAsk(c, 'not-now')
    await c.page.waitForSelector('[data-testid="notification-ask"]', {
      hidden: true
    })
    const kept = await keptFor(c, fresh.userId)
    expect(kept.asked).not.equals(null)
    expect(kept.switches).equals(null)
    await askLine(
      `$ web N1.7: Not Now: ${askedKey(fresh.userId)} ${kept.asked}; switches ${kept.switches ?? '(none, all off)'}`
    )
    await tab(c, 'Home')
    await tab(c, 'Chat')
    expect(await askAfter(c, 5000), 'asked again').equals(false)
    await c.page.reload({ waitUntil: 'networkidle0' })
    await tab(c, 'Home')
    await tab(c, 'Chat')
    expect(await askAfter(c, 5000), 'asked after a reload').equals(false)
    await askLine(
      '$ web N1.7: Home, then Chat, again and after a reload: never asked again'
    )
    await c.page.close()
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
          .select([
            'id',
            'platform',
            'address_key',
            'messages',
            'rsvp_events',
            'league_management'
          ])
          .where('session_id', '=', phone.sessionId)
          .executeTakeFirst(),
      30000
    )
    expect(row.platform).equals('web')
    // Registered with this browser's own switches, League management off
    // as kept here.
    expect([row.messages, row.rsvp_events, row.league_management]).deep.equals([
      false,
      true,
      false
    ])
    endpointHost = new URL(row.address_key).host
    say(
      `$ allowed, then ${ALLOW}: registration ${row.platform} at ${new URL(row.address_key).host}, messages ${String(row.messages)}, rsvp_events ${String(row.rsvp_events)}, league_management ${String(row.league_management)}`
    )
    await until(
      'the blocked line to go',
      async () => !(await text(phone)).includes(BLOCKED)
    )
    control = await workerControl(phone)
    await measuredWorker(control)

    // 6. Refused at the browser, the ask's Continue turns all three switches on
    // and, with no settings page a site can open, says where to allow them.
    const refusing = seed.Es
    const r = await open('R', refusing, 'denied')
    await r.page.goto(`${WEB}/`, { waitUntil: 'networkidle0' })
    await tab(r, 'Chat')
    expect(await untilAsk(r)).contains(ASK_TITLE)
    await answerAsk(r, 'continue')
    await r.page.waitForSelector('[data-testid="notification-ask-hint"]', {
      timeout: 30000
    })
    const hint = await r.page.$eval(
      '[data-testid="notification-ask-hint"]',
      node => (node as HTMLElement).innerText
    )
    expect(hint).equals(ASK_WEB_BLOCKED)
    const refused = await keptFor(r, refusing.userId)
    expect(refused.switches).equals(
      '{"messages":true,"rsvpEvents":true,"leagueManagement":true}'
    )
    expect(refused.asked).not.equals(null)
    await askLine(
      `$ web N2.6: ${refusing.name}, notifications denied in this browser, taps the Chat tab, then Continue: "${hint}"; switches ${refused.switches}`
    )
    await answerAsk(r, 'done')
    await r.page.waitForSelector('[data-testid="notification-ask"]', {
      hidden: true
    })
    await r.page.close()
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
    await serverHolds(phone, true)

    const sender = await clientOf(p1)
    const engine = await engineOf(p1, sender)
    senderEngine = engine
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
    await serverHolds(phone, false)
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
      '$ P2 turns the switch off on this browser (its registration patched); P1 sends a DM and a mention: no push.jsonl record for P2'
    )

    // The live push service, end to end: the server's Web Push reaches the
    // browser through Chrome's push service, with no replay.
    await flip(phone, MESSAGES)
    await follows(phone, MESSAGES, true)
    await serverHolds(phone, true)
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
    const p3Registration = await p3Client.registerPush({
      platform: 'web',
      address: unusedSubscription(),
      environment: 'production',
      messages: false,
      rsvpEvents: true
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

    // P2's switch changes and Allow in Account (N1, N2) were P2's own
    // answer, kept as asked: the app never asks P2 here, nor changes those
    // switches. So that steps 7 and 8 see someone never asked, this browser
    // forgets that record.
    const fromAccount = await keptFor(phone, p2.userId)
    expect(fromAccount.asked, 'Account kept it as asked').not.equals(null)
    await phone.page.evaluate((key: string) => {
      window.localStorage.removeItem(key)
    }, askedKey(p2.userId))
    await askLine(
      `$ web N4.6: P2's changes in Account (N1, N2) kept ${askedKey(p2.userId)} ${fromAccount.asked}; this browser forgets it for steps 7 and 8`
    )

    await tap(`event:${eventId}`)
    await until(
      'the event page',
      async () => new URL(phone.page.url()).pathname === `/games/${eventId}`
    )
    await line(
      'n4',
      `$ tap the reminder (notificationclick in the worker): page at ${new URL(phone.page.url()).pathname}`
    )

    // N3 read its DMs and sent a read push. A delayed copy of that read can
    // close an old wake replayed here, so use a new message beyond that read.
    const dmFrom = (await records()).length
    const navigationText = `Open this DM from its notification, ${Date.now()}`
    const navigationPost = await senderEngine!.sendText(dmId, navigationText)
    expect(navigationPost, 'the new navigation DM was sent').not.equals(
      undefined
    )
    const dmRecord = await until('the new DM wake', async () =>
      (await records()).slice(dmFrom).find(record => {
        if (
          record.userId !== p2.userId ||
          record.platform !== 'web' ||
          record.message.platform !== 'web'
        )
          return false
        const wake = JSON.parse(record.message.payload) as ChatWake | ChatRead
        return (
          wake.t === 'chat' &&
          wake.c === dmId &&
          wake.seq === navigationPost!.seq
        )
      })
    )
    const isNavigationDm = (item: { tag: string; body: string }): boolean =>
      item.tag === `chat:${dmId}` && item.body === navigationText
    if (!(await shown(phone)).some(isNavigationDm)) {
      await deliver(control, dmRecord)
    }
    const dmNote = await until('the DM notification', async () =>
      (await shown(phone)).find(isNavigationDm)
    )
    expect(dmNote.body).equals(navigationText)
    await line(
      'n4',
      `$ new DM seq ${navigationPost!.seq}: ${JSON.stringify(dmNote)} shown`
    )
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

    // 7. A notification's tap goes to its address, which never asks: P2,
    // never asked in this browser, saw no ask at the event or the DM.
    expect(await askAfter(phone, 3000)).equals(false)
    expect((await keptFor(phone, p2.userId)).asked).equals(null)
    await askLine(
      `$ web N4.7: P2 (${p2.name}) taps the reminder (/games/${eventId}) and the DM notification (/chat/${dmId}): no ask, nothing kept`
    )

    // 8. Allowed already, an RSVP answered in the app turns all three
    // switches on quietly and tells the registration.
    await phone.page.goto(`${WEB}/games/${eventId}`, {
      waitUntil: 'networkidle0'
    })
    await rsvpInApp(phone, p2.userId, 1)
    expect(await askAfter(phone, 3000), 'no question when allowed').equals(
      false
    )
    const quiet = await until('P2’s switches all on', async () => {
      const now = await keptFor(phone, p2.userId)
      return now.asked != null &&
        now.switches ===
          '{"messages":true,"rsvpEvents":true,"leagueManagement":true}'
        ? now
        : undefined
    })
    const quietRow = await until(
      'P2’s registration with all three on',
      async () => {
        const row = await db
          .selectFrom('push_registrations')
          .select(['id', 'messages', 'rsvp_events', 'league_management'])
          .where('session_id', '=', phone.sessionId)
          .executeTakeFirst()
        return row?.messages === true &&
          row.rsvp_events &&
          row.league_management
          ? row
          : undefined
      }
    )
    await askLine(
      `$ web N4.8: P2, notifications allowed, answers Maybe in the RSVP sheet and closes it: no ask; switches ${quiet.switches}; push_registrations ${quietRow.id} messages ${String(quietRow.messages)}, rsvp_events ${String(quietRow.rsvp_events)}, league_management ${String(quietRow.league_management)}`
    )

    // 9. Not decided yet, an RSVP answered in the app asks once the sheet
    // has closed; Continue turns all three on, asks the browser, and
    // registers.
    const rsvper = seed.D
    const { token: rsvperToken, sessionId: rsvperSession } =
      await createSession(db, rsvper.userId, 'notifications-e2e')
    await phone.context.setCookie({
      name: SESSION_COOKIE,
      value: rsvperToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await allow(phone.context, 'prompt')
    await phone.page.goto(`${WEB}/games/${eventId}`, {
      waitUntil: 'networkidle0'
    })
    await rsvpInApp(phone, rsvper.userId, 0)
    const asked = await untilAsk(phone)
    expect(asked).contains(ASK_TITLE)
    expect(new URL(phone.page.url()).pathname).equals(`/games/${eventId}`)
    await askLine(
      `$ web N4.9: ${rsvper.name}, never asked in this browser, notifications not decided, answers Yes in the RSVP sheet and taps Done: the ask over /games/${eventId}`
    )
    // The browser's own question, answered Allow.
    await allow(phone.context, 'granted')
    await answerAsk(phone, 'continue')
    const row = await until(
      `${rsvper.name}’s registration with all three on`,
      async () => {
        const found = await db
          .selectFrom('push_registrations')
          .select([
            'id',
            'platform',
            'messages',
            'rsvp_events',
            'league_management'
          ])
          .where('session_id', '=', rsvperSession)
          .executeTakeFirst()
        return found?.messages === true &&
          found.rsvp_events &&
          found.league_management
          ? found
          : undefined
      },
      60000
    )
    const continued = await keptFor(phone, rsvper.userId)
    expect(continued.switches).equals(
      '{"messages":true,"rsvpEvents":true,"leagueManagement":true}'
    )
    expect(continued.asked).not.equals(null)
    // Up, busy, under the browser's question, and gone once it is answered.
    await phone.page.waitForSelector('[data-testid="notification-ask"]', {
      hidden: true
    })
    await askLine(
      `$ web N4.9: Continue, the browser allows: switches ${continued.switches}; push_registrations ${row.id} ${row.platform} messages ${String(row.messages)}, rsvp_events ${String(row.rsvp_events)}, league_management ${String(row.league_management)}`
    )
    await rsvpInApp(phone, rsvper.userId, 2)
    expect(await askAfter(phone, 3000), 'asked again').equals(false)
    await askLine(`$ web N4.9: another answer (No): never asked again`)
  })

  it('N1b: League management turned off and on in Account changes only its own column', async () => {
    // P2 again in the browser that is pushed to, where N4.8 turned all three
    // of P2's switches on.
    const { token, sessionId } = await createSession(
      db,
      p2.userId,
      'notifications-e2e'
    )
    await phone.context.setCookie({
      name: SESSION_COOKIE,
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await allow(phone.context, 'granted')
    const p2Phone: Device = { ...phone, sessionId }
    await account(p2Phone)
    await line(
      'n1b',
      `$ P2 (${p2.name}) signed in again in the pushed browser, opens Account`
    )
    const row = async (
      what: string,
      done: (found: {
        messages: boolean
        rsvp_events: boolean
        league_management: boolean
      }) => boolean
    ): Promise<{
      id: string
      messages: boolean
      rsvp_events: boolean
      league_management: boolean
    }> =>
      await until(
        what,
        async () => {
          const found = await db
            .selectFrom('push_registrations')
            .select(['id', 'messages', 'rsvp_events', 'league_management'])
            .where('session_id', '=', sessionId)
            .executeTakeFirst()
          return found != null && done(found) ? found : undefined
        },
        60000
      )
    const say = async (
      when: string,
      found: Awaited<ReturnType<typeof row>>
    ): Promise<void> => {
      await line(
        'n1b',
        `$ ${when}: push_registrations ${found.id} messages ${String(found.messages)}, rsvp_events ${String(found.rsvp_events)}, league_management ${String(found.league_management)}; localStorage ${(await keptFor(p2Phone, p2.userId)).switches ?? '(nothing)'}`
      )
    }
    for (const label of [MESSAGES, RSVP_EVENTS, LEAGUE_MANAGEMENT])
      expect(await checked(p2Phone, label), label).equals(true)
    await say(
      'opened, all three on',
      await row(
        'P2’s registration with all three on',
        found => found.messages && found.rsvp_events && found.league_management
      )
    )

    await flip(p2Phone, LEAGUE_MANAGEMENT)
    await follows(p2Phone, LEAGUE_MANAGEMENT, false)
    const off = await row(
      'League management off on the registration',
      found => !found.league_management
    )
    expect([off.messages, off.rsvp_events]).deep.equals([true, true])
    expect(await checked(p2Phone, MESSAGES)).equals(true)
    expect(await checked(p2Phone, RSVP_EVENTS)).equals(true)
    await say(`${LEAGUE_MANAGEMENT} off`, off)

    await flip(p2Phone, LEAGUE_MANAGEMENT)
    await follows(p2Phone, LEAGUE_MANAGEMENT, true)
    const on = await row(
      'League management on again on the registration',
      found => found.league_management
    )
    expect([on.messages, on.rsvp_events]).deep.equals([true, true])
    expect(on.id).equals(off.id)
    await say(`${LEAGUE_MANAGEMENT} on again`, on)
  })

  describe('Umpire Management Notifications (N5–N7)', function () {
    const ZONE = 'America/Los_Angeles'
    const MISSING_SLOTS = 'Send notifications for missing slots'
    const SIGN_UPS = 'Receive notifications when umpires sign up'
    const WITHDRAWALS = 'Receive notifications when umpires withdraw'
    const DAYS = '[data-testid="umpire-notifications-days"]'
    const DAYS_CELL = '[data-testid="grid-cell-umpire-notifications-days"]'
    const DAYS_INPUT =
      '[data-testid="grid-cell-input-umpire-notifications-days"]'
    let lena: SeedTablePerson
    let blair: SeedTablePerson
    /** QPLL's second admin, made one in the setup. */
    let admin2: SeedTablePerson
    let admin2Client: TeamStationClient
    /** L's browser: the one pushed to, now that P2 is done with it. */
    let l: Device
    let lClient: TeamStationClient
    let bClient: TeamStationClient
    let league: string
    /** Today in Pacific, QPLL's zone with no locality: D. */
    let today: string
    /** The two games 1 day out on D, in start order, and the one 4 days out. */
    let near: [string, string]
    let far: string
    /**
     * A game on D+1 at 12:00, its Plate filled: the next upcoming game, and
     * not in the digest.
     */
    let noon: string
    let slot: string

    /** `day` (`YYYY-MM-DD`) at `time` (`HH:mm`) in Pacific, as an instant. */
    const pacific = (day: string, time: string): Date => {
      for (const hours of [7, 8]) {
        const at = new Date(
          Date.parse(`${day}T${time}:00Z`) + hours * 60 * 60 * 1000
        )
        if (localDate(at, ZONE) === day && localClock(at, ZONE) === time)
          return at
      }
      throw new Error(`no ${day} ${time} in ${ZONE}`)
    }
    const plusDays = (day: string, days: number): string =>
      new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000)
        .toISOString()
        .slice(0, 10)
    const settings = async (): Promise<
      Awaited<ReturnType<TeamStationClient['umpireNotifications']>>
    > => await lClient.umpireNotifications(league)
    /** The digest rows of L in QPLL for `day`: one at most, ever. */
    const digestsOn = async (
      day: string
    ): Promise<Array<{ id: string; metadata: unknown; created_at: Date }>> =>
      await db
        .selectFrom('notification_events')
        .select(['id', 'metadata', 'created_at'])
        .where('source_type', '=', 'umpireMissingSlots')
        .where('source_id', '=', `${league}:${lena.userId}`)
        .where('revision', '=', Number(day.replaceAll('-', '')))
        .execute()
    /** L's (or `who`'s) notices of `type`, oldest first. */
    const noticesOf = async (
      type: 'umpireSignUp' | 'umpireWithdraw',
      who: SeedTablePerson = lena
    ): Promise<Array<{ id: string; metadata: unknown }>> =>
      await db
        .selectFrom('notification_events')
        .select(['id', 'metadata'])
        .where('source_type', '=', type)
        .where(eb =>
          eb(eb.val(who.userId), '=', eb.fn.any('recorded_recipients'))
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    /** The pushes `push.jsonl` holds to L (or `who`) for the notice `id`. */
    const pushesOf = async (
      id: string,
      who: SeedTablePerson = lena
    ): Promise<PushLogRecord[]> =>
      (await records()).filter(
        record =>
          record.userId === who.userId &&
          record.message.platform === 'web' &&
          record.message.payload.includes(`event:league:${id}`)
      )
    const leaguePushes = async (
      who: SeedTablePerson = lena
    ): Promise<PushLogRecord[]> =>
      (await records()).filter(
        record =>
          record.userId === who.userId &&
          record.message.platform === 'web' &&
          record.message.payload.includes('event:league:')
      )
    const metadataOf = (
      metadata: unknown
    ): { title: string; description: string; gameId: string } =>
      metadata as { title: string; description: string; gameId: string }
    /** Exactly one push for `id`, and still one a moment later. */
    const onePush = async (id: string): Promise<PushLogRecord> => {
      await until(`a push for ${id}`, async () =>
        (await pushesOf(id)).length > 0 ? true : undefined
      )
      await pause(2000)
      const found = await pushesOf(id)
      expect(found, `pushes for ${id}`).length(1)
      return found[0]
    }
    const payloadOf = (record: PushLogRecord): EventReminder =>
      JSON.parse(
        record.message.platform === 'web' ? record.message.payload : '{}'
      ) as EventReminder
    /** Runs the digest sweep at `at` and queues what it recorded. */
    const sweep = async (at: Date): Promise<number> => {
      const requests = await recordUmpireDigests(db, at)
      // A queue closed before it has connected leaves its socket open, and
      // the run with it: one is made only for something to queue.
      if (requests.length > 0) {
        const queue = makePushEnqueuer(config, () => undefined)
        try {
          for (const request of requests)
            await until(
              `queueing ${request.tag}`,
              async () => await queue.add(request)
            )
        } finally {
          await queue.close()
        }
      }
      await umpireLine(
        'n6',
        `$ recordUmpireDigests(db, ${at.toISOString()} = ${localDate(at, ZONE)} ${localClock(at, ZONE)} Pacific) and queue what it answers: ${requests.length} recorded (${requests.length === 0 ? 'none' : requests.map(request => `${request.tag} to ${request.u.join(',')}: ${request.body}`).join('; ')})`
      )
      return requests.length
    }
    /** L's Notifications, on `mode`, once `words` are on it. */
    const notifications = async (
      mode: 'Pending' | 'History',
      words: string
    ): Promise<void> => {
      await l.page.goto(`${WEB}/notifications`, { waitUntil: 'networkidle0' })
      if (mode === 'History') await pressText(l, 'History')
      await until(`${words} in ${mode}`, async () =>
        (await text(l)).includes(words)
      )
    }

    before(async () => {
      const seedText = await readFile(required('TS_NOTIFY_SEED'), 'utf8')
      const qpll = /^QPLL (\S+)\s+Spring 2027 (\S+)/m.exec(seedText)
      const template = /^Owls v Hawks \(next week\) (\S+)/m.exec(seedText)
      if (qpll == null || template == null)
        throw new Error('The seed table names QPLL, Spring 2027 and its games')
      league = qpll[1]
      const season = qpll[2]
      lena = seed.L
      blair = seed.B
      lClient = await clientOf(lena)
      bClient = await clientOf(blair)
      // A second QPLL admin, for N7: G1, on QPLL's people as a guardian and
      // nobody's admin there until L makes them one.
      admin2 = seed.G1
      admin2Client = await clientOf(admin2)
      expect(
        await admin2Client.umpireNotifications(league).then(
          () => 200,
          (error: unknown) => (error as { status?: number }).status ?? error
        ),
        'G1 is not yet a QPLL admin'
      ).equals(403)
      await lClient.addRole('league', league, admin2.userId, 'admin')
      // QPLL manages umpires: Majors needs one Plate, and B may take it.
      await lClient.setUmpireSettings(league, { management: true })
      const plate =
        (await lClient.umpireTypes(league)).find(t => t.name === 'Plate') ??
        (await lClient.addUmpireType(league, 'Plate'))
      const majors =
        (await lClient.umpireLevels(league)).find(v => v.name === 'Majors') ??
        (await lClient.addUmpireLevel(league, 'Majors'))
      await lClient.setUmpireRequirements(league, {
        seasonIds: [season],
        levelId: majors.id,
        types: [{ typeId: plate.id, required: 1, optional: 0 }]
      })
      await lClient.grantUmpire(league, blair.userId)
      await lClient.certifyUmpire(league, blair.userId, {
        levelId: majors.id,
        typeId: plate.id,
        enabled: true
      })
      slot = `${plate.id}:1`
      // The seed's season is in UTC; days out are counted in the season's
      // zone, so it is put in QPLL's, Pacific, for D+1 to be a day out.
      await db
        .updateTable('seasons')
        .set({ timezone: ZONE })
        .where('id', '=', season)
        .execute()
      // Two games 1 day out and one 4 days out, none assigned.
      today = localDate(new Date(), ZONE)
      const game = await db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', template[1])
        .executeTakeFirstOrThrow()
      const made: string[] = []
      for (const [days, time] of [
        [1, '18:00'],
        [1, '19:00'],
        [4, '18:00']
      ] as const) {
        const id = makeId('game')
        const startAt = pacific(plusDays(today, days), time)
        await db
          .insertInto('games')
          .values({
            ...game,
            id,
            start_at: startAt,
            end_at: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
            timezone: ZONE,
            status: 'scheduled',
            withdrawn_at: null
          })
          .execute()
        made.push(id)
      }
      near = [made[0], made[1]]
      far = made[2]
      // Before them on D+1, a game at 12:00 whose Plate B has: the next game
      // to come, though no digest lists it.
      noon = makeId('game')
      const noonAt = pacific(plusDays(today, 1), '12:00')
      await db
        .insertInto('games')
        .values({
          ...game,
          id: noon,
          start_at: noonAt,
          end_at: new Date(noonAt.getTime() + 2 * 60 * 60 * 1000),
          timezone: ZONE,
          status: 'scheduled',
          withdrawn_at: null
        })
        .execute()
      await db
        .insertInto('umpire_assignments')
        .values({
          game_id: noon,
          slot,
          user_id: blair.userId,
          assigned_by: lena.userId,
          credit_team_id: null
        })
        .execute()
      // Enough games after them for the schedule to scroll, so it can open
      // with a game other than the first at the top.
      for (let days = 6; days <= 13; days++) {
        const startAt = pacific(plusDays(today, days), '18:00')
        await db
          .insertInto('games')
          .values({
            ...game,
            id: makeId('game'),
            start_at: startAt,
            end_at: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
            timezone: ZONE,
            status: 'scheduled',
            withdrawn_at: null
          })
          .execute()
      }
      await umpireLine(
        'n6',
        `# N6 — QPLL ${league} (no locality: Pacific), admin L (${lena.name}); D = ${today}; games ${near[0]} and ${near[1]} at D+1 18:00 and 19:00, ${far} at D+4 18:00, Majors needing one Plate, none assigned; ${noon} at D+1 12:00 with its Plate filled by B (the next game, never listed); eight more at D+6 to D+13 18:00, so the schedule scrolls; Spring 2027's zone set to ${ZONE}`
      )
    })

    it('N5: L opts in on Umpire Management Notifications, with the ask, and Days refuses 31', async () => {
      // P2 is done with the pushed browser: it is L's now, never asked here.
      await phone.page.close()
      l = await open('L', lena, 'prompt', true)
      await l.page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 2
      })
      await l.page.goto(`${WEB}/groups/league/${league}/settings`, {
        waitUntil: 'networkidle0'
      })
      expect((await keptFor(l, lena.userId)).asked).equals(null)
      await l.page.waitForSelector(
        '[data-testid="umpire-send-me-notifications"]',
        { timeout: 60000 }
      )
      // The card's last row, under Enable Team Credits.
      expect(
        await l.page.evaluate(() => {
          const credits = document.querySelector(
            '[aria-label="Enable Team Credits"]'
          )!
          const send = document.querySelector(
            '[data-testid="umpire-send-me-notifications"]'
          )!
          return (
            (credits.compareDocumentPosition(send) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0 && send.parentElement!.lastElementChild === send
          )
        })
      ).equals(true)
      await l.page.$eval(
        '[data-testid="umpire-send-me-notifications"]',
        node => {
          ;(node as HTMLElement).click()
        }
      )
      await until(
        'Umpire Management Notifications',
        async () =>
          new URL(l.page.url()).pathname ===
            `/groups/league/${league}/umpire-notifications` &&
          (await text(l)).includes('Umpire Management Notifications') &&
          (await l.page.$(DAYS_CELL)) != null
      )
      // 2. Days reads 7, greyed out until missing slots is on.
      const gated = async (): Promise<string | null> =>
        await l.page.$eval(DAYS, node => node.getAttribute('aria-disabled'))
      expect(await l.page.$eval(DAYS_CELL, node => node.textContent)).equals(
        '7'
      )
      expect(await gated()).equals('true')
      for (const label of [MISSING_SLOTS, SIGN_UPS, WITHDRAWALS])
        expect(await checked(l, label), label).equals(false)
      await proof(l.page, 'umpire-notifications-screen.png')
      await flip(l, MISSING_SLOTS)
      const said = await untilAsk(l)
      expect(said).contains(ASK_TITLE).and.contains('Continue')
      // The browser's own question, answered Allow.
      await allow(l.context, 'granted')
      await answerAsk(l, 'continue')
      await l.page.waitForSelector('[data-testid="notification-ask"]', {
        hidden: true,
        timeout: 60000
      })
      await until(
        'missingSlots saved',
        async () => (await settings()).missingSlots
      )
      await until('Days active', async () => (await gated()) !== 'true')
      // The browser's first ask turns all three switches on.
      const registered = await until(
        'L’s registration with League management on',
        async () => {
          const found = await db
            .selectFrom('push_registrations')
            .select(['id', 'messages', 'rsvp_events', 'league_management'])
            .where('session_id', '=', l.sessionId)
            .executeTakeFirst()
          return found?.league_management === true ? found : undefined
        },
        60000
      )
      expect([registered.messages, registered.rsvp_events]).deep.equals([
        true,
        true
      ])
      await askLine(
        `$ web N5: L (${lena.name}), never asked in this browser, turns on missing slots: the ask; Continue, the browser allows: push_registrations ${registered.id} messages ${String(registered.messages)}, rsvp_events ${String(registered.rsvp_events)}, league_management ${String(registered.league_management)}`
      )
      // 3. 31 is refused and saves nothing; 1 saves.
      const typeDays = async (value: string): Promise<void> => {
        if ((await l.page.$(DAYS_INPUT)) == null)
          await l.page.$eval(DAYS_CELL, node => {
            ;(node as HTMLElement).click()
          })
        await l.page.waitForSelector(DAYS_INPUT, { timeout: 10000 })
        await l.page.$eval(DAYS_INPUT, node => {
          const input = node as HTMLInputElement
          input.focus()
          input.select()
        })
        await l.page.keyboard.type(value)
        await l.page.keyboard.press('Enter')
      }
      await typeDays('31')
      await until('the refusal', async () =>
        (await text(l)).includes('Choose 1 to 30 days')
      )
      await pause(1000)
      expect((await settings()).daysBefore).equals(7)
      await typeDays('1')
      await until('daysBefore 1', async () =>
        (await settings()).daysBefore === 1 ? true : undefined
      )
      await l.page.waitForSelector(DAYS_INPUT, { hidden: true })
      // Gated while the save is on its way, and active once it answers.
      await until('Days active at 1', async () =>
        (await gated()) !== 'true' &&
        (await l.page.$eval(DAYS_CELL, node => node.textContent)) === '1'
          ? true
          : undefined
      )
      await proof(l.page, 'umpire-notifications-days.png')
      expect(await settings()).deep.equals({
        missingSlots: true,
        daysBefore: 1,
        signUps: false,
        withdrawals: false
      })
    })

    it('N6: the day’s digest is recorded once, pushed once, replaced the next day, and opens the schedule on its first game', async () => {
      const tomorrow = plusDays(today, 1)
      // D 10:01: the two games 1 day out, not the one 4 days out.
      await sweep(pacific(today, '10:01'))
      const [first] = await until('D’s digest', async () => {
        const rows = await digestsOn(today)
        return rows.length > 0 ? rows : undefined
      })
      expect(await digestsOn(today)).length(1)
      const digest = metadataOf(first.metadata)
      expect(digest.title).equals('2 games still need umpires')
      const lines = digest.description.split('\n')
      expect(lines).length(2)
      for (const row of lines) expect(row).matches(/\(1 day out\)$/)
      expect(digest.gameId).equals(near[0])
      expect(digest.description).not.contains('4 days out')
      const pushed = payloadOf(await onePush(first.id))
      expect(pushed).include({
        t: 'event',
        u: lena.userId,
        title: 'QPLL',
        body: '2 games still need umpires',
        url: `teamstation://umpires/${league}?view=league&game=${near[0]}`,
        tag: `event:league:${first.id}`
      })
      await umpireLine(
        'n6',
        `notification_events umpireMissingSlots for (L, QPLL, ${today}): 1 row ${first.id}, recorded ${first.created_at.toISOString()}\n  ${digest.title}\n  ${lines.join('\n  ')}\npush.jsonl to L: 1 push ${JSON.stringify(pushed)}`
      )
      await notifications('Pending', digest.title)
      expect(
        await l.page.$$eval(
          '[data-testid^="notification-row-"]',
          (rows, title) =>
            rows.filter(row => String(row.textContent).includes(title)).length,
          digest.title
        )
      ).equals(1)
      for (const row of lines) expect(await text(l)).includes(row)
      await proof(l.page, 'notifications-digest.png')

      // D 10:20, a rerun the same day: nothing more.
      await sweep(pacific(today, '10:20'))
      expect(await digestsOn(today)).length(1)
      await pause(2000)
      expect(await pushesOf(first.id)).length(1)
      await umpireLine(
        'n6',
        `notification_events for (L, QPLL, ${today}): still 1 row; push.jsonl: still 1 push`
      )

      // D+1 10:01: a new digest, the only one in Pending.
      await sweep(pacific(tomorrow, '10:01'))
      const next = await digestsOn(tomorrow)
      expect(next).length(1)
      const second = metadataOf(next[0].metadata)
      expect(second.title).equals('2 games still need umpires')
      expect(second.gameId).equals(near[0])
      const nextLines = second.description.split('\n')
      expect(nextLines).length(2)
      for (const row of nextLines) expect(row).matches(/\(today\)$/)
      const nextPush = payloadOf(await onePush(next[0].id))
      expect(nextPush.body).equals('2 games still need umpires')
      const settled = await db
        .selectFrom('notification_receipts')
        .select('dismissed_at')
        .where('event_id', '=', first.id)
        .where('user_id', '=', lena.userId)
        .executeTakeFirst()
      expect(settled?.dismissed_at).not.equals(null)
      await umpireLine(
        'n6',
        `notification_events for (L, QPLL, ${tomorrow}): 1 row ${next[0].id}\n  ${second.title}\n  ${nextLines.join('\n  ')}\npush.jsonl to L: 1 push ${JSON.stringify(nextPush)}\nnotification_receipts ${first.id}: dismissed ${settled?.dismissed_at?.toISOString() ?? '(none)'}`
      )
      await notifications('Pending', second.title)
      expect(
        await l.page.$(`[data-testid="notification-row-${next[0].id}"]`)
      ).not.equals(null)
      expect(
        await l.page.$(`[data-testid="notification-row-${first.id}"]`)
      ).equals(null)

      // A tap opens the league's umpire schedule on the first game listed.
      await l.page.$eval(
        `[data-testid="notification-row-${next[0].id}"] [role="button"]`,
        node => {
          ;(node as HTMLElement).click()
        }
      )
      await until('the umpire schedule', async () => {
        const url = new URL(l.page.url())
        return (
          url.pathname === `/umpires/${league}` &&
          url.searchParams.get('view') === 'league' &&
          url.searchParams.get('game') === near[0]
        )
      })
      const row = `[data-testid="umpire-game-${near[0]}"]`
      await l.page.waitForSelector(row, { timeout: 60000 })
      const onScreen = async (): Promise<boolean> =>
        await l.page.$eval(row, node => {
          const box = node.getBoundingClientRect()
          return box.top >= 0 && box.top < window.innerHeight
        })
      /**
       * Whether the middle of `id`'s row shows that row, rather than being
       * off screen or under the header.
       */
      const showing = async (id: string): Promise<boolean> =>
        await l.page.$eval(`[data-testid="umpire-game-${id}"]`, node => {
          const box = node.getBoundingClientRect()
          const y = box.top + box.height / 2
          if (y < 0 || y >= window.innerHeight) return false
          const hit = document.elementFromPoint(box.left + 8, y)
          return hit != null && node.contains(hit)
        })
      await until(
        'the 18:00 game on screen, the 12:00 one scrolled away',
        async () => (await onScreen()) && !(await showing(noon))
      )
      await pause(1500)
      expect(await onScreen()).equals(true)
      expect(await showing(near[0]), 'the 18:00 game showing').equals(true)
      expect(await showing(noon), 'the 12:00 game showing').equals(false)
      await proof(l.page, 'umpire-digest-open.png')
      // It opens on the digest's first game, not where `around=next` opens,
      // on the 12:00 game before it: the rows from the opening one down.
      const opening = async (
        around: string
      ): Promise<{ anchorId: string | null; rows: string[] }> => {
        const page = await lClient.umpireSchedulePage(league, 'view=schedule', {
          around
        })
        const from = page.items.findIndex(item => item.id === page.anchorId)
        return {
          anchorId: page.anchorId,
          rows: page.items
            .slice(Math.max(0, from), Math.max(0, from) + 3)
            .map(
              item =>
                `${item.id} ${localDate(new Date(item.startAt), ZONE)} ${localClock(new Date(item.startAt), ZONE)}`
            )
        }
      }
      const onGame = await opening(near[0])
      const onNext = await opening('next')
      expect(onGame.anchorId).equals(near[0])
      expect(onNext.anchorId).equals(noon)
      expect(onGame.rows).not.deep.equals(onNext.rows)
      // Where each game's row is, and the scrolling table's top.
      const geometry = await l.page.$$eval(
        '[data-testid^="umpire-game-"]',
        rows => {
          // No `??` or `?.` here: the page has no helpers for them.
          let scroller: Element | null = rows.length > 0 ? rows[0] : null
          while (scroller != null) {
            const style = getComputedStyle(scroller)
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              scroller.scrollHeight > scroller.clientHeight
            )
              break
            scroller = scroller.parentElement
          }
          return {
            scrollTop:
              scroller == null
                ? 0
                : Math.round(scroller.getBoundingClientRect().top),
            rows: rows.map(node => ({
              id: String(node.getAttribute('data-testid')).replace(
                'umpire-game-',
                ''
              ),
              top: Math.round(node.getBoundingClientRect().top),
              bottom: Math.round(node.getBoundingClientRect().bottom)
            }))
          }
        }
      )
      await umpireLine(
        'n6',
        `$ L taps the digest in Pending: ${new URL(l.page.url()).pathname}${new URL(l.page.url()).search}; ${near[0]} (D+1 18:00) is the top row showing, ${noon} (D+1 12:00) is scrolled away\nscroller top ${geometry.scrollTop} px; rows (id top..bottom px): ${geometry.rows.map(row => `${row.id} ${row.top}..${row.bottom}`).join(', ')}\n$ GET /leagues/${league}/umpire-schedule?view=schedule&paged=1&around=${near[0]}: anchorId ${onGame.anchorId}, rows from it ${onGame.rows.join('; ')}\n$ GET /leagues/${league}/umpire-schedule?view=schedule&paged=1&around=next: anchorId ${onNext.anchorId}, rows from it ${onNext.rows.join('; ')}`
      )
    })

    it('N7: sign-ups and withdrawals notify L, an admin’s removal notifies no admin, and League management off stops only the push', async () => {
      await umpireLine(
        'n7',
        `# N7 — QPLL ${league}, admin L (${lena.name}), umpire B (${blair.name}), game ${near[0]}, slot ${slot}`
      )
      await l.page.goto(`${WEB}/groups/league/${league}/umpire-notifications`, {
        waitUntil: 'networkidle0'
      })
      await l.page.waitForSelector(`input[aria-label="${SIGN_UPS}"]`, {
        timeout: 60000
      })
      await flip(l, SIGN_UPS)
      await until('signUps saved', async () => (await settings()).signUps)
      await flip(l, WITHDRAWALS)
      await until(
        'withdrawals saved',
        async () => (await settings()).withdrawals
      )
      // Asked before, and allowed: no sheet.
      expect(await askAfter(l, 2000)).equals(false)
      await umpireLine(
        'n7',
        `$ L turns on sign-ups and withdrawals: ${JSON.stringify(await settings())}`
      )
      // QPLL's second admin, A2 (guardian G1), made one by L in the setup,
      // hears of withdrawals alone, on a device with League management on.
      const admin2Device = await admin2Client.registerPush({
        platform: 'web',
        address: unusedSubscription(),
        environment: 'production',
        messages: false,
        rsvpEvents: false,
        leagueManagement: true
      })
      const admin2Settings = await admin2Client.setUmpireNotifications(league, {
        withdrawals: true
      })
      expect(admin2Settings).include({ withdrawals: true, signUps: false })
      await umpireLine(
        'n7',
        `$ L makes A2 (${admin2.name}) a QPLL admin in the setup: PUT /manage/league/${league}/people/${admin2.userId}/roles/admin (before it, A2's GET /leagues/${league}/umpire-notifications was 403)\n$ A2 turns on withdrawals alone: ${JSON.stringify(admin2Settings)}; push_registrations ${admin2Device} league_management true`
      )
      /** The one new notice of `type` since `before`, with its single push. */
      const arrives = async (
        type: 'umpireSignUp' | 'umpireWithdraw',
        before: number,
        pushed: boolean
      ): Promise<{ id: string; title: string }> => {
        const found = await until(`a new ${type}`, async () => {
          const rows = await noticesOf(type)
          return rows.length > before ? rows : undefined
        })
        expect(found, type).length(before + 1)
        const id = found.at(-1)!.id
        // The row keeps the umpire's id, never a name: L's inbox names them.
        expect(JSON.stringify(found.at(-1)!.metadata)).not.includes(
          blair.name.split(' ')[0]
        )
        const notice = { id, title: (await lClient.notification(id)).title }
        if (pushed) {
          const push = payloadOf(await onePush(notice.id))
          expect(push.body).equals(notice.title)
          await umpireLine(
            'n7',
            `notification_events ${type} ${notice.id} to L: ${notice.title}\npush.jsonl to L: ${JSON.stringify(push)}`
          )
        } else {
          await pause(8000)
          expect(await pushesOf(notice.id)).length(0)
          await umpireLine(
            'n7',
            `notification_events ${type} ${notice.id} to L: ${notice.title}\npush.jsonl to L for ${notice.id}: none (8 s later)`
          )
        }
        return notice
      }

      await bClient.assignUmpire(near[0], { slot, userId: blair.userId })
      await umpireLine(
        'n7',
        `$ B signs up: POST /games/${near[0]}/umpire-slots ${slot}`
      )
      const signedUp = await arrives('umpireSignUp', 0, true)
      expect(signedUp.title).contains(' signed up as Plate for ')
      await bClient.removeUmpire(near[0], slot)
      await umpireLine(
        'n7',
        `$ B withdraws: DELETE /games/${near[0]}/umpire-slots ${slot}`
      )
      const withdrew = await arrives('umpireWithdraw', 0, true)
      expect(withdrew.title).contains(' withdrew from Plate for ')
      // A2 heard of B's own withdrawal, in the app and pushed, and not of the
      // sign-up.
      expect(
        (await noticesOf('umpireWithdraw', admin2)).map(row => row.id)
      ).deep.equals([withdrew.id])
      expect(await noticesOf('umpireSignUp', admin2)).length(0)
      await until('a push to A2', async () =>
        (await pushesOf(withdrew.id, admin2)).length > 0 ? true : undefined
      )
      expect(await pushesOf(withdrew.id, admin2)).length(1)
      expect(await leaguePushes(admin2)).length(1)
      await umpireLine(
        'n7',
        `notification_events umpireWithdraw ${withdrew.id} to A2 too; umpireSignUp to A2: none\npush.jsonl to A2: 1 push, for ${withdrew.id}`
      )
      await notifications('History', withdrew.title)
      expect(await text(l)).includes(signedUp.title)
      await proof(l.page, 'notifications-umpire-history.png')

      // An assignment of B's that L did not make, which L removes.
      await db
        .insertInto('umpire_assignments')
        .values({
          game_id: near[1],
          slot,
          user_id: blair.userId,
          assigned_by: blair.userId,
          credit_team_id: null
        })
        .execute()
      const pushesBefore = (await leaguePushes()).length
      const admin2PushesBefore = (await leaguePushes(admin2)).length
      const withdrawalsBefore = await db
        .selectFrom('notification_events')
        .select(db.fn.countAll<string>().as('count'))
        .where('source_type', '=', 'umpireWithdraw')
        .executeTakeFirstOrThrow()
      await lClient.removeUmpire(near[1], slot)
      await pause(8000)
      expect(await noticesOf('umpireWithdraw')).length(1)
      expect(await noticesOf('umpireSignUp')).length(1)
      expect(await leaguePushes()).length(pushesBefore)
      // A2, opted in to withdrawals and not the one removing it, hears nothing
      // either: an admin's removal is no withdrawal.
      expect(
        (await noticesOf('umpireWithdraw', admin2)).map(row => row.id)
      ).deep.equals([withdrew.id])
      expect(await leaguePushes(admin2)).length(admin2PushesBefore)
      const withdrawalsAfter = await db
        .selectFrom('notification_events')
        .select(db.fn.countAll<string>().as('count'))
        .where('source_type', '=', 'umpireWithdraw')
        .executeTakeFirstOrThrow()
      expect(withdrawalsAfter.count).equals(withdrawalsBefore.count)
      await umpireLine(
        'n7',
        `$ L removes B's assignment of ${near[1]} (assigned by B): DELETE /games/${near[1]}/umpire-slots ${slot}\nnotification_events umpireWithdraw, to anyone: ${withdrawalsBefore.count} before, ${withdrawalsAfter.count} after; to A2: still only ${withdrew.id} (B's own)\npush.jsonl: no new push to L (${pushesBefore} league pushes before and after) and none to A2 (${admin2PushesBefore} before and after), 8 s later`
      )

      // League management off in Account: the notice, and no push.
      await account(l)
      await l.page.waitForSelector(`input[aria-label="${LEAGUE_MANAGEMENT}"]`, {
        timeout: 60000
      })
      expect(await checked(l, LEAGUE_MANAGEMENT)).equals(true)
      await flip(l, LEAGUE_MANAGEMENT)
      await follows(l, LEAGUE_MANAGEMENT, false)
      const off = await until(
        'League management off on L’s registration',
        async () => {
          const found = await db
            .selectFrom('push_registrations')
            .select(['id', 'league_management'])
            .where('session_id', '=', l.sessionId)
            .executeTakeFirst()
          return found?.league_management === false ? found : undefined
        },
        60000
      )
      await umpireLine(
        'n7',
        `$ L turns ${LEAGUE_MANAGEMENT} off in Account: push_registrations ${off.id} league_management false`
      )
      await bClient.assignUmpire(near[0], { slot, userId: blair.userId })
      await umpireLine(
        'n7',
        `$ B signs up again: POST /games/${near[0]}/umpire-slots ${slot}`
      )
      const quiet = await arrives('umpireSignUp', 1, false)
      await notifications('History', quiet.title)
      await umpireLine('n7', `L's History lists it: ${quiet.title}`)
    })
  })
})
