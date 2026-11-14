import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { PNG } from 'pngjs'

import { TeamStationClient } from '../../src/common/api'
import { makeId } from '../../src/common/ids'
import type { ChatRead, ChatWake, EventReminder } from '../../src/common/push'
import { ChatEngine } from '../../src/app/chat/engine/engine'
import type { ChatKeyRecord } from '../../src/app/chat/keyRecord'
import { createSession } from '../../src/server/auth/sessions'
import { makeDatabase } from '../../src/server/db/database'
import { wakeMessage } from '../../src/server/push/chatWakes'
import type { PushLogRecord } from '../../src/server/push/log'
import { makePushEnqueuer } from '../../src/server/push/queue'
import { dueReminders } from '../../src/server/push/rsvpReminders'
import { liveRegistrations } from '../../src/server/push/send'
import type { ServerConfig } from '../../src/server/serverConfig'
import {
  readSeedTable,
  type SeedTablePerson
} from '../../src/test/chatSeedTable'
import { chatRowText } from '../../src/test/chatRows'
import { attach, type AttachedDevice, flatten } from './maestroD'

/**
 * N5: notifications in the Android app (debug build, `app.teamstation.app`)
 * on an emulator, through maestro-d's JavaScript client, against a running
 * API with the chat fixture in its database:
 *
 *   MAESTRO_D=notify-<run> TS_E2E_DEVICE=emulator-5554 \
 *   TS_NOTIFY_ARTIFACTS=<dir> TS_NOTIFY_CONFIG=<the API's serverConfig.json> \
 *   TS_NOTIFY_SEED=<run>/seed.txt TS_NOTIFY_API=http://127.0.0.1:9141/api/v1 \
 *   TS_NOTIFY_APK=android/app/build/outputs/apk/debug/app-debug.apk \
 *     node -r sucrase/register mobile/test/teamStationAppNotifications.e2e.ts
 *
 * `scripts/push-coverage.mjs run android` starts the API, Metro (with the
 * app's `TS_API_BASE_URL` on the emulator's address for this Mac) and this
 * script, and measures it. `TS_NOTIFY_CONFIG`'s database is where the checks
 * read and the reminder sweep runs, its `redis` the push queue the sweep's
 * requests go on, and its `push.logFile` holds every push the API's push
 * sender sends. `TS_NOTIFY_METRO_PORT` is Metro's port on this Mac, the
 * one the app was built for (`-PreactNativeDevServerPort`). With `TS_PUSH_COVERAGE_DIR` set, the
 * app's JaCoCo counters (a `TS_PUSH_COVERAGE=1` build) are pulled there
 * before every `am kill`, before the fresh install and at the end.
 *
 * P1 is Eagles admin Ea, who writes from Node; P2 is coach Ec, signed in on
 * the emulator. The emulator has no Firebase, so each push the API logged for
 * P2's phone is handed to the app by the debug build's `PUSH_DEBUG`
 * broadcast, which goes through the app's FCM service as FCM would.
 *
 * N6, with `TS_NOTIFY_PLATFORM=ios`: the same in the iOS app on a simulator
 * (`TS_E2E_DEVICE` its UDID), installed from `TS_NOTIFY_APP`, with
 * `TS_NOTIFY_FILTERING_APP` the same build signed with the filtering
 * entitlement. Each push the API logged for P2's iPhone is delivered with
 * `xcrun simctl push`, which runs the app's notification extension as APNs
 * would. `scripts/push-coverage.mjs run ios` builds both, starts the API on
 * this Mac's LAN address and measures it; with `TS_PUSH_COVERAGE_DIR` set,
 * the profiles the app and its extension wrote are moved there before every
 * reinstall and at the end.
 */
const APP = 'app.teamstation.app'
const MESSAGES = 'Notify for direct messages and mentions'
const RSVP_EVENTS = 'Notify for RSVPed events'
const BLOCKED = 'Notifications are blocked by this device'
const ALLOW_ID = 'com.android.permissioncontroller:id/permission_allow_button'
const DENY_ID = 'com.android.permissioncontroller:id/permission_deny_button'
const IOS = process.env.TS_NOTIFY_PLATFORM === 'ios'
const LOG = IOS ? 'ios-notifications.log' : 'android-notifications.log'
/** The seen-message steps (N5 6a–6b, N6 2a–2b), on their own as well. */
const SEEN_LOG = IOS ? 'ios-seen-guard.log' : 'android-seen-guard-and-clear.log'

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Set ${name}`)
  return value
}

const artifacts = required('TS_NOTIFY_ARTIFACTS')
const serial = required('TS_E2E_DEVICE')
const API = required('TS_NOTIFY_API').replace(/\/+$/, '')
const coverageDir = process.env.TS_PUSH_COVERAGE_DIR

async function say(text: string): Promise<void> {
  console.log(`  ${text}`)
  await appendFile(path.join(artifacts, LOG), text + '\n')
}

/** Says a seen-message step, in the platform's log and the seen log. */
async function saySeen(text: string): Promise<void> {
  await say(text)
  await appendFile(path.join(artifacts, SEEN_LOG), text + '\n')
}

function adb(...args: string[]): string {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' })
}

/** One argument of `adb shell`, which hands the whole line to sh. */
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

async function until<T>(
  what: string,
  read: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 30000
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

let config: ServerConfig
let db: ReturnType<typeof makeDatabase>
let dumps = 0

/**
 * The primary's reminder sweep, run now rather than in up to five minutes:
 * each due start goes on the API's push queue, for its push sender to send.
 * Answers the requests for `eventId`.
 */
async function queueReminders(eventId: string): Promise<string> {
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
  return JSON.stringify(due.filter(request => request.eventId === eventId))
}

async function records(): Promise<PushLogRecord[]> {
  const text = await readFile(config.push?.logFile ?? '', 'utf8').catch(
    () => ''
  )
  return text
    .split('\n')
    .filter(row => row !== '')
    .map(row => JSON.parse(row) as PushLogRecord)
}

/** The payload of an Android message, as FCM's `data.payload` carries it. */
function payloadOf(record: PushLogRecord): string {
  if (record.message.platform !== 'android')
    throw new Error('Not an Android message')
  return record.message.data.payload
}

/** P2's Android records after the first `from`, once there are `count`. */
async function androidRecords(
  userId: string,
  from: number,
  count: number
): Promise<PushLogRecord[]> {
  return await until(`${count} Android pushes`, async () => {
    const found = (await records())
      .slice(from)
      .filter(
        record => record.userId === userId && record.platform === 'android'
      )
    return found.length >= count ? found : undefined
  })
}

/** Hands one logged push to the app, as FCM would deliver it. */
async function deliver(record: PushLogRecord): Promise<void> {
  adb(
    'shell',
    `am broadcast -p ${APP} -a ${APP}.PUSH_DEBUG --es payload ${quoted(JSON.stringify(record))}`
  )
}

/** The app's posted notifications, by tag, from the notification service. */
function posted(): string[] {
  const dump = adb('shell', 'dumpsys', 'notification', '--noredact')
  return [
    ...dump.matchAll(
      new RegExp(
        `NotificationRecord\\([^)]*pkg=${APP.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[^)]*tag=([^\\s)]+)`,
        'g'
      )
    )
  ].map(match => match[1])
}

/**
 * Writes the app's JaCoCo counters to `files/coverage-<n>.ec` and pulls
 * them here, when this run is measured.
 */
async function dumpCoverage(when: string): Promise<void> {
  if (coverageDir == null || coverageDir === '') return
  // Twice, one after the other: the second holds the first dump's own
  // lines, which ran after its counters were read.
  const n = (dumps += 2)
  let bytes = Buffer.alloc(0)
  for (const each of [n - 1, n]) {
    adb(
      'shell',
      `am broadcast -p ${APP} -a ${APP}.PUSH_DEBUG_DUMP --es n ${each}`
    )
    const read = (): Buffer | undefined => {
      try {
        return execFileSync('adb', [
          '-s',
          serial,
          'exec-out',
          'run-as',
          APP,
          'cat',
          `files/coverage-${each}.ec`
        ])
      } catch {
        return undefined
      }
    }
    // Written once it reads the same twice.
    bytes = await until(`coverage ${each}`, async () => {
      const first = read()
      await pause(500)
      const second = read()
      return first != null && second != null && first.equals(second)
        ? second
        : undefined
    })
  }
  await mkdir(coverageDir, { recursive: true })
  await writeFile(path.join(coverageDir, `device-${n}.ec`), bytes)
  await say(`$ PUSH_DEBUG_DUMP ${n} (${when}): ${bytes.length} bytes pulled`)
}

/**
 * Signs `who` in on the emulator. `answer`, the id of a button of Android's
 * notification question, answers it when the phone asks as it signs in (a
 * switch the account already has on); the question covers the app until then.
 */
async function signIn(
  m: AttachedDevice,
  who: SeedTablePerson,
  answer?: string
): Promise<void> {
  for (const attempt of [1, 2]) {
    // Not asked yet: maestro grants every permission at launch unless told.
    await m.launchApp({
      appId: APP,
      clearState: true,
      stopApp: true,
      permissions: { notifications: 'unset' }
    })
    await m.tapOn({ text: 'Use a password instead', timeout: 60000 })
    await m.tapOn({ text: 'E-mail address' })
    await m.inputText({ text: who.email })
    await m.tapOn({ text: 'Password' })
    await m.inputText({ text: who.password })
    await m.hideKeyboard().catch(() => undefined)
    await m.tapOn({ text: 'Sign in', optional: true, timeout: 5000 })
    try {
      if (answer != null) await m.tapOn({ id: answer, timeout: 30000 })
      await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
      return
    } catch {
      console.log(`Sign-in attempt ${attempt} did not take`)
    }
  }
  throw new Error(`Could not sign in as ${who.email}`)
}

/**
 * Opens one of the app's own links, where `screen` (a regex of a text it
 * shows) is the screen it opens. The first `teamstation://` link on a
 * simulator asks "Open in “TeamStation”?", which is answered, and on a busy
 * machine the question can come many seconds late: until the screen shows,
 * for up to 20 s, the question is looked for.
 */
async function openLink(
  m: AttachedDevice,
  link: string,
  screen: string
): Promise<void> {
  await m.openLink({ link })
  if (!IOS) return
  const shows = new RegExp(`^(?:${screen})$`)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const texts = flatten(await m.hierarchy()).map(node => node.text ?? '')
    if (texts.some(text => text === 'Open' || text.startsWith('Open in '))) {
      await m.tapOn({ text: 'Open' })
      return
    }
    if (texts.some(text => shows.test(text))) return
    await pause(500)
  }
  throw new Error(
    `${link} showed neither "${screen}" nor the question to open it`
  )
}

/** Opens Account and brings the notification switches on screen. */
async function account(m: AttachedDevice): Promise<void> {
  await openLink(m, 'teamstation://account', ACCOUNT_SCREEN)
  // Down to Sign out, so neither switch is under the floating tab bar.
  await m.scrollUntilVisible({ element: { text: 'Sign out' }, timeout: 30000 })
  await m.assertVisible({ text: RSVP_EVENTS })
}

/** Texts Account shows, whichever part of it is on screen. */
const ACCOUNT_SCREEN = `Account|Name|NAME|Sign out|${MESSAGES}`

/** The simulator's screen now, decoded. */
function screenNow(file: string): PNG {
  simctl('io', serial, 'screenshot', file)
  return PNG.sync.read(readFileSync(file))
}

/**
 * The share of the band where a banner shows (below the status bar, the top
 * 6–18% of the screen) that differs from `before`.
 */
function bannerShare(before: PNG, now: PNG): number {
  const { width, height } = now
  if (before.width !== width || before.height !== height) return 1
  let changed = 0
  let all = 0
  for (let y = Math.round(height * 0.06); y < height * 0.18; y += 2)
    for (let x = Math.round(width * 0.05); x < width * 0.95; x += 2) {
      const at = (y * width + x) * 4
      const diff =
        Math.abs(now.data[at] - before.data[at]) +
        Math.abs(now.data[at + 1] - before.data[at + 1]) +
        Math.abs(now.data[at + 2] - before.data[at + 2])
      all++
      if (diff > 60) changed++
    }
  return changed / all
}

/** The newest notification in the shade, opened by a tap; waits for `then`. */
async function tapInShade(
  m: AttachedDevice,
  text: string,
  then: string,
  shot?: string
): Promise<void> {
  await m.openNotifications()
  await m.extendedWaitUntil({ visible: { text }, timeout: 30000 })
  if (shot != null)
    await writeFile(path.join(artifacts, shot), await m.screenshot())
  await m.tapOn({ text })
  await m.extendedWaitUntil({ visible: { text: then }, timeout: 60000 })
}

/** A chat engine for `person` in Node, keys held in memory. */
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
  if ((await engine.start()) !== 'ready')
    throw new Error(`${person.name}'s chat did not start`)
  return engine
}

async function android(): Promise<void> {
  config = JSON.parse(
    await readFile(required('TS_NOTIFY_CONFIG'), 'utf8')
  ) as ServerConfig
  if (config.push?.logFile == null || config.push.logFile === '')
    throw new Error('The API must log its pushes: set push.logFile')
  db = makeDatabase(config.databaseUrl)
  const seed = readSeedTable(await readFile(required('TS_NOTIFY_SEED'), 'utf8'))
  const p1 = seed.Ea
  const p2 = seed.Ec
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, LOG), '')
  await writeFile(
    path.join(artifacts, SEEN_LOG),
    `$ TS_NOTIFY_PLATFORM=${IOS ? 'ios' : 'android'} node -r sucrase/register mobile/test/teamStationAppNotifications.e2e.ts\n`
  )
  const metro = process.env.TS_NOTIFY_METRO_PORT ?? '8081'
  adb('reverse', `tcp:${metro}`, `tcp:${metro}`)

  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: serial,
    appId: APP,
    artifactDir: path.join(artifacts, 'android')
  })
  try {
    // 2. Signed in as P2, chat set up, both switches on, notifications allowed.
    await signIn(m, p2)
    await say(`$ P2 (${p2.name}) signs in on ${serial}`)
    await openLink(
      m,
      'teamstation://chat',
      chatRowText('Eagles Members', 'android')
    )
    await m.extendedWaitUntil({
      visible: { text: chatRowText('Eagles Members', 'android') },
      timeout: 90000
    })
    await say('$ P2 opens Chat: this phone is set up for chat')
    await account(m)
    await m.tapOn({ text: MESSAGES })
    await m.tapOn({ id: ALLOW_ID, timeout: 30000 })
    await say(`$ ${MESSAGES} on; the system asks; tapOn Allow`)
    await m.tapOn({ text: RSVP_EVENTS })
    await m.assertNotVisible({ text: BLOCKED })
    adb('shell', `am broadcast -p ${APP} -a ${APP}.PUSH_DEBUG_TOKEN`)
    const registration = await until(
      'P2’s debug registration',
      async () =>
        await db
          .selectFrom('push_registrations')
          .select(['id', 'platform', 'address', 'environment'])
          .where('user_id', '=', p2.userId)
          .where('platform', '=', 'android')
          .executeTakeFirst()
    )
    if (!registration.address.startsWith('debug-'))
      throw new Error(`Unexpected registration ${registration.address}`)
    await say(
      `$ PUSH_DEBUG_TOKEN: push_registrations row ${registration.id} ${registration.platform} ${registration.environment} debug-…`
    )

    // 3. P1 writes P2 a DM.
    const sender = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p1.userId, 'notifications-e2e')).token
    })
    const engine = await engineOf(p1, sender)
    const dm = await sender.createDm([p2.userId])
    const stamp = Date.now().toString(36)
    const dmText = `Bring the cones, ${stamp}`
    let from = (await records()).length
    await engine.open(dm.id)
    await engine.sendText(dm.id, dmText)
    const [dmRecord] = await androidRecords(p2.userId, from, 1)
    const dmWake = JSON.parse(payloadOf(dmRecord)) as ChatWake
    await say(
      `$ P1 sends P2 the DM "${dmText}": push.jsonl android ${dmRecord.message.platform === 'android' ? dmRecord.message.priority : ''} wake dm=${dmWake.dm} from="${dmWake.from}"`
    )

    // 4–5. Delivered open, in the background, and to a process that is gone;
    // each posts the DM, and a tap opens the conversation.
    await deliver(dmRecord)
    await tapInShade(m, dmText, dmText, 'android-dm-notification.png')
    await say(
      `$ PUSH_DEBUG in the foreground: "${dmWake.from}" "${dmText}" in the shade; tap opens the DM`
    )
    await m.pressKey({ key: 'home' })
    await deliver(dmRecord)
    await tapInShade(m, dmText, dmText)
    await say('$ pressKey home, PUSH_DEBUG: posted; tap opens the DM')
    await m.pressKey({ key: 'home' })
    await pause(1000)
    await dumpCoverage('before am kill')
    adb('shell', 'am', 'kill', APP)
    await until('the app’s process to go', () =>
      adb('shell', 'pidof', APP).trim() === '' ? true : undefined
    ).catch(() => undefined)
    await deliver(dmRecord)
    await tapInShade(m, dmText, dmText)
    await say(
      '$ am kill, PUSH_DEBUG: a new process posts it with no service started; tap opens the DM'
    )

    // A process that cannot open the DM in time (its JavaScript is not to
    // be had: Metro is paused) still says who wrote.
    const metroPid = process.env.TS_NOTIFY_METRO_PID
    if (metroPid != null && metroPid !== '') {
      await m.pressKey({ key: 'home' })
      await dumpCoverage('before am kill')
      adb('shell', 'am', 'kill', APP)
      await until('the app’s process to go', () =>
        adb('shell', 'pidof', APP).trim() === '' ? true : undefined
      ).catch(() => undefined)
      process.kill(Number(metroPid), 'SIGSTOP')
      const fallback = `New message from ${dmWake.from}`
      try {
        await deliver(dmRecord)
        // Read from the notification service, not the shade: a cold process
        // waits out the task's 9 s before it posts this, and while Metro is
        // paused the shade's view hierarchy may not come back at all. The
        // shade is opened once Metro runs again.
        await until(
          'the fallback notification',
          () =>
            adb('shell', 'dumpsys', 'notification', '--noredact').includes(
              fallback
            )
              ? true
              : undefined,
          60000
        )
      } finally {
        process.kill(Number(metroPid), 'SIGCONT')
      }
      await say(
        `$ am kill, Metro paused, PUSH_DEBUG: the task cannot finish in 9 s, and "${fallback}" is posted`
      )
      await tapInShade(m, dmWake.from, dmText)
      await say('$ Metro resumed: a tap opens the DM')
      // The task, let go, then opens the DM after all and posts it whole.
      const late = await until(
        'the opened DM',
        () => (posted().includes(`chat:${dm.id}`) ? true : undefined),
        30000
      ).catch(() => false)
      if (late) {
        await tapInShade(m, dmText, dmText)
        await say('$ the resumed task posts the opened DM; a tap opens it')
      }
    }

    // A push that is neither a wake nor a reminder shows nothing.
    await m.pressKey({ key: 'home' })
    await pause(5000)
    const before = posted()
    adb(
      'shell',
      `am broadcast -p ${APP} -a ${APP}.PUSH_DEBUG --es payload ${quoted('{"t":"other","u":"' + p2.userId + '"}')}`
    )
    await pause(3000)
    const added = posted().filter(tag => !before.includes(tag))
    if (added.length > 0)
      throw new Error(`An unknown push posted ${added.join(', ')}`)
    await say('$ PUSH_DEBUG of {"t":"other"}: nothing posted')

    // 6. A mention, sent at normal priority, to the backgrounded app; then a
    // plain message, which posts nothing.
    const group = await until(
      'Eagles Members in P1’s chats',
      async () =>
        (await engine.refresh()).find(
          chat => chat.kind === 'teamMembers' && chat.title === 'Eagles Members'
        )?.id
    )
    await m.pressKey({ key: 'home' })
    const mentionText = `@${p2.name} has the scorebook, ${stamp}`
    from = (await records()).length
    await engine.open(group)
    await engine.sendText(group, mentionText, { mentions: [p2.userId] })
    const [mention] = await androidRecords(p2.userId, from, 1)
    const mentionWake = JSON.parse(payloadOf(mention)) as ChatWake
    if (
      mention.message.platform !== 'android' ||
      mention.message.priority !== 'normal'
    )
      throw new Error('A group wake is sent at normal priority')
    await deliver(mention)
    const mentionTitle = `${mentionWake.from} in Eagles Members`
    await tapInShade(m, mentionTitle, mentionText)
    await say(
      `$ mention at normal priority, backgrounded: "${mentionTitle}" "${mentionText}"; tap opens the chat`
    )
    await m.pressKey({ key: 'home' })
    const plainText = `Practice moved inside, ${stamp}`
    from = (await records()).length
    await engine.sendText(group, plainText)
    const [plain] = await androidRecords(p2.userId, from, 1)
    await deliver(plain)
    await pause(8000)
    const after = posted()
    if (after.includes(`chat:${group}`))
      throw new Error('A plain group message posted a notification')
    await say(
      `$ plain group message delivered: posted tags ${JSON.stringify(after)}, none for chat:${group}`
    )

    // Seen: the DM on screen. A DM that comes is read within the hold and
    // wakes nobody, and a wake for that conversation posts nothing.
    await openLink(
      m,
      `teamstation://chat/${dm.id}`,
      `.*${escapeRegex(dmText)}.*`
    )
    await m.extendedWaitUntil({ visible: { text: dmText }, timeout: 60000 })
    const seenText = `Seen as it came, ${stamp}`
    from = (await records()).length
    await engine.open(dm.id)
    await engine.sendText(dm.id, seenText)
    await m.extendedWaitUntil({ visible: { text: seenText }, timeout: 30000 })
    // Past the stack's 2 s hold, and the sender's next turn.
    await pause(6000)
    const seenWakes = (await records())
      .slice(from)
      .filter(
        record =>
          record.userId === p2.userId &&
          record.platform === 'android' &&
          (JSON.parse(payloadOf(record)) as { t: string }).t === 'chat'
      )
    if (seenWakes.length > 0)
      throw new Error(`A DM read on screen woke P2: ${seenWakes.length}`)
    await saySeen(
      `$ the DM on screen; P1 sends "${seenText}": read within the hold, no push.jsonl wake for P2`
    )
    await deliver(dmRecord)
    await pause(8000)
    if (posted().includes(`chat:${dm.id}`))
      throw new Error('A wake for the conversation on screen posted')
    await saySeen(
      `$ PUSH_DEBUG of the DM's wake, its chat on screen: posted tags ${JSON.stringify(posted())}, none for chat:${dm.id}`
    )

    // Read elsewhere: a DM posted here goes once P2 reads it on another
    // device, by the read push the server sends this phone.
    await m.pressKey({ key: 'home' })
    await pause(1000)
    const elsewhereText = `Read on another device, ${stamp}`
    from = (await records()).length
    await engine.sendText(dm.id, elsewhereText)
    const [elsewhere] = await androidRecords(p2.userId, from, 1)
    const elsewhereWake = JSON.parse(payloadOf(elsewhere)) as ChatWake
    await deliver(elsewhere)
    await until(
      'the DM posted',
      () => (posted().includes(`chat:${dm.id}`) ? true : undefined),
      30000
    )
    await m.openNotifications()
    await m.extendedWaitUntil({
      visible: { text: elsewhereText },
      timeout: 30000
    })
    await writeFile(
      path.join(artifacts, 'android-clear-on-read-before.png'),
      await m.screenshot()
    )
    await saySeen(
      `$ pressKey home; P1 sends "${elsewhereText}": wake delivered, chat:${dm.id} posted, in the shade (android-clear-on-read-before.png)`
    )
    const otherDevice = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p2.userId, 'notifications-e2e')).token
    })
    from = (await records()).length
    await otherDevice.markChatRead(dm.id, elsewhereWake.seq)
    const [read] = await androidRecords(p2.userId, from, 1)
    const readPayload = JSON.parse(payloadOf(read)) as ChatRead
    if (
      readPayload.t !== 'read' ||
      readPayload.c !== dm.id ||
      readPayload.seq !== elsewhereWake.seq ||
      read.message.platform !== 'android' ||
      read.message.priority !== 'normal'
    )
      throw new Error(`Not the read push: ${JSON.stringify(read.message)}`)
    await deliver(read)
    await until(
      'the DM taken down',
      () => (posted().includes(`chat:${dm.id}`) ? undefined : true),
      30000
    )
    await m.extendedWaitUntil({
      notVisible: { text: elsewhereText },
      timeout: 30000
    })
    await writeFile(
      path.join(artifacts, 'android-clear-on-read-after.png'),
      await m.screenshot()
    )
    await m.pressKey({ key: 'back' })
    await saySeen(
      `$ P2 reads the DM to seq ${elsewhereWake.seq} on another device: push.jsonl android normal ${payloadOf(read)}; delivered, chat:${dm.id} taken down, gone from the shade (android-clear-on-read-after.png)`
    )
    engine.stop()

    // 7. A reminder for an event P2 said yes to, which opens the event.
    const eventId = makeId('teamEvent')
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
        start_at: new Date(Date.now() + 90 * 60 * 1000),
        timezone: 'America/Los_Angeles',
        status: 'scheduled'
      })
      .execute()
    const p2Client = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p2.userId, 'notifications-e2e')).token
    })
    await p2Client.saveRsvp(eventId, p2.userId, 'yes')
    from = (await records()).length
    const queued = await queueReminders(eventId)
    await say(
      `$ team event "Batting cage" in 90 minutes, P2 RSVPs yes; dueReminders queued for the push sender: ${queued}`
    )
    const reminder = await until('P2’s Android reminder', async () =>
      (await records()).find(
        record =>
          record.userId === p2.userId &&
          record.platform === 'android' &&
          payloadOf(record).includes(eventId)
      )
    )
    const payload = JSON.parse(payloadOf(reminder)) as EventReminder
    await deliver(reminder)
    await m.openNotifications()
    await m.extendedWaitUntil({
      visible: { text: 'Batting cage' },
      timeout: 30000
    })
    await m.assertVisible({ text: payload.body })
    // What the notification service holds is what the refused case reads.
    if (!posted().includes(`event:${eventId}`))
      throw new Error(`The reminder is not among ${posted().join(', ')}`)
    await m.tapOn({ text: 'Batting cage' })
    await m.extendedWaitUntil({
      visible: { text: '.*Batting cage.*' },
      timeout: 60000
    })
    await pause(1500)
    await writeFile(
      path.join(artifacts, 'android-tap-opens-event.png'),
      await m.screenshot()
    )
    await say(
      `$ reminder "${payload.title}" "${payload.body}" posted; tap opens ${payload.url}`
    )

    // 7b. Signing out lets go of the phone: nothing wakes it for P2 after
    // (the app deletes the registration it made, and the logout ends the
    // session the debug token's was made under), and a DM or a reminder
    // that reaches it anyway shows nothing.
    await account(m)
    await m.tapOn({ text: 'Sign out' })
    await m.assertVisible({ text: 'Use a password instead', timeout: 60000 })
    await until('no live registration for P2’s phone', async () =>
      (await liveRegistrations(db, [p2.userId])).some(
        live => live.platform === 'android'
      )
        ? undefined
        : true
    )
    await say(
      `$ Sign out: push_registrations row ${registration.id} wakes nothing (liveRegistrations has no android row for P2)`
    )
    await m.pressKey({ key: 'home' })
    await deliver(dmRecord)
    await deliver(reminder)
    await pause(10000)
    const afterSignOut = posted().filter(
      tag => tag === `chat:${dm.id}` || tag === `event:${eventId}`
    )
    if (afterSignOut.length > 0)
      throw new Error(`A signed-out phone posted ${afterSignOut.join(', ')}`)
    await say(
      '$ signed out: PUSH_DEBUG of the DM and the reminder: nothing posted'
    )

    // 8. A fresh install, with a switch the account already has on: signed
    // in, the phone asks by itself, without Account. Refused, the switch
    // stays on with the blocked line, and nothing is posted.
    await p2Client.setAccountNotifications({
      messages: true,
      rsvpEvents: false
    })
    await dumpCoverage('before the fresh install')
    adb('uninstall', APP)
    adb('install', required('TS_NOTIFY_APK'))
    adb('reverse', `tcp:${metro}`, `tcp:${metro}`)
    await signIn(m, p2, DENY_ID)
    await say(
      `$ fresh install, ${MESSAGES} already on for the account: signed in, the phone asks by itself; Don't allow`
    )
    await account(m)
    await m.extendedWaitUntil({ visible: { text: BLOCKED }, timeout: 30000 })
    await m.shot('android-blocked')
    await say(`$ Account: ${MESSAGES} on, "${BLOCKED}"`)
    // Refused once, the phone is not asked again.
    await m.tapOn({ text: RSVP_EVENTS })
    await pause(2000)
    await m.assertNotVisible({ id: DENY_ID })
    await m.assertVisible({ text: BLOCKED })
    await say(`$ ${RSVP_EVENTS} on: no second question, still "${BLOCKED}"`)
    await m.pressKey({ key: 'home' })
    await deliver(dmRecord)
    await deliver(reminder)
    await pause(10000)
    const refused = posted()
    if (refused.length > 0)
      throw new Error(`A refused app posted ${refused.join(', ')}`)
    await say('$ PUSH_DEBUG of the DM and the reminder: nothing posted')
    await dumpCoverage('at the end')
    console.log('N5 passed')
  } finally {
    await m.detach()
    await db.destroy()
  }
}

// N6, iOS.

const DONT_ALLOW = 'Don’t Allow'

/**
 * Answers iOS's notification question with Allow. It is SpringBoard's: while
 * it is up the app's hierarchy is hidden, so its Allow is tapped where an
 * iPhone 17 shows it. Done when the app's switches are back after that.
 */
async function allowIos(m: AttachedDevice): Promise<void> {
  let answered = false
  for (let tries = 0; tries < 30; tries++) {
    await pause(1500)
    const nodes = flatten(await m.hierarchy())
    if (!nodes.some(node => node.type === 'Switch' && node.text === MESSAGES)) {
      await m.tapOn({ point: '68%,59%' })
      answered = true
      continue
    }
    if (answered) return
  }
  throw new Error('iOS was not answered Allow')
}

function simctl(...args: string[]): string {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' })
}

/** Ends the app's process, as swiping it away does; nothing when it is not running. */
function terminateIos(): void {
  try {
    simctl('terminate', serial, APP)
  } catch {}
}

/** An iOS message's body: `aps` and the app's own keys, as APNs carries it. */
function apnsOf(record: PushLogRecord): Record<string, unknown> {
  if (record.message.platform !== 'ios') throw new Error('Not an iOS message')
  return record.message.payload
}

/** P2's iOS records after the first `from`, once there are `count`. */
async function iosRecords(
  userId: string,
  from: number,
  count: number
): Promise<PushLogRecord[]> {
  return await until(`${count} iOS pushes`, async () => {
    const found = (await records())
      .slice(from)
      .filter(record => record.userId === userId && record.platform === 'ios')
    return found.length >= count ? found : undefined
  })
}

let pushes = 0

/**
 * Delivers one APNs body to the app with `simctl push`; false when the
 * simulator refuses it, as it does a background push.
 */
async function deliverIos(payload: Record<string, unknown>): Promise<boolean> {
  const file = path.join(artifacts, 'ios', `push-${++pushes}.apns`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({ 'Simulator Target Bundle': APP, ...payload }, null, 2)
  )
  try {
    simctl('push', serial, APP, file)
    return true
  } catch (error) {
    // A simulator takes no push without an alert.
    if (
      String((error as { stderr?: unknown }).stderr).includes(
        'no user visible content'
      )
    )
      return false
    throw error
  }
}

/** The home screen; the app's counters are written as it goes to the background. */
async function home(m: AttachedDevice): Promise<void> {
  await m.pressKey({ key: 'home' })
  await pause(2000)
}

/**
 * Moves the profiles the app and its extension wrote off the simulator
 * into `TS_PUSH_COVERAGE_DIR`, when this run is measured.
 */
async function pullProfiles(when: string): Promise<void> {
  if (coverageDir == null || coverageDir === '') return
  const containers = path.join(
    homedir(),
    'Library/Developer/CoreSimulator/Devices',
    serial,
    'data/Containers/Data'
  )
  let moved = 0
  for (const kind of ['Application', 'PluginKitPlugin']) {
    const dir = path.join(containers, kind)
    const each = await readdir(dir).catch(() => [] as string[])
    for (const container of each) {
      const tmp = path.join(dir, container, 'tmp')
      const names = await readdir(tmp).catch(() => [] as string[])
      for (const name of names) {
        if (!/^push-\d+\.profraw$/.test(name)) continue
        await mkdir(coverageDir, { recursive: true })
        const file = path.join(tmp, name)
        await copyFile(file, path.join(coverageDir, `${container}-${name}`))
        await rm(file)
        moved++
      }
    }
  }
  await say(`$ ${moved} profiles moved off the simulator (${when})`)
}

/**
 * Signs `who` in on a fresh launch, with notifications not asked yet, or
 * with the question already answered Don't Allow (`deny`).
 */
async function signInIos(
  m: AttachedDevice,
  who: SeedTablePerson,
  notifications: 'unset' | 'deny' = 'unset'
): Promise<void> {
  for (const attempt of [1, 2, 3]) {
    try {
      terminateIos()
    } catch {}
    try {
      await m.launchApp({
        appId: APP,
        clearState: true,
        stopApp: true,
        permissions: { notifications }
      })
      await m.tapOn({ text: 'Use a password instead', timeout: 60000 })
      // The simulator's keyboard drops what is typed before it is up.
      await m.tapOn({ text: 'E-mail address' })
      await pause(1500)
      await m.inputText({ text: who.email })
      await m.tapOn({ text: 'Password' })
      await pause(1500)
      await m.inputText({ text: who.password })
      await m.hideKeyboard().catch(() => undefined)
      await m.tapOn({ text: 'Sign in', optional: true, timeout: 5000 })
      // iOS offers to save the password, and asks again until answered.
      await m
        .tapOn({ text: 'Not Now', optional: true, timeout: 5000 })
        .catch(() => undefined)
      await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
      return
    } catch (error) {
      console.log(`Sign-in attempt ${attempt} did not take: ${String(error)}`)
    }
  }
  throw new Error(`Could not sign in as ${who.email}`)
}

/** Taps the switch labelled `label`: on iOS its label beside it is not part of it. */
async function toggleIos(m: AttachedDevice, label: string): Promise<void> {
  const found = await until(
    `the switch "${label}"`,
    async () =>
      flatten(await m.hierarchy()).find(
        node =>
          node.type === 'Switch' && node.text === label && node.bounds != null
      )?.bounds
  )
  const { x, y, width, height } = found
  await m.tapOn({
    point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
  })
}

/**
 * Delivers a push over the home screen and taps its banner where it shows,
 * at once (looking it up in SpringBoard's hierarchy can outlast it), then
 * waits for `then`, which the tap opens. `text` is what the banner says.
 */
async function tapBanner(
  m: AttachedDevice,
  deliver: () => Promise<unknown>,
  text: string,
  then: string,
  shot?: string
): Promise<void> {
  if (shot == null) {
    await deliver()
    await pause(800)
  } else {
    // The simulator's own screenshot is quick: the screen is taken until
    // the banner is in it, however late it slides in on a busy machine, and
    // that frame is the artifact.
    const file = path.join(artifacts, 'ios', 'banner-now.png')
    await mkdir(path.dirname(file), { recursive: true })
    const before = screenNow(file)
    await deliver()
    const deadline = Date.now() + 8000
    for (;;) {
      if (bannerShare(before, screenNow(file)) > 0.3) break
      if (Date.now() > deadline)
        throw new Error(`No banner "${text}" came within 8 s`)
    }
    await copyFile(file, path.join(artifacts, shot))
  }
  await m.tapOn({ point: '50%,10%' })
  await m
    .extendedWaitUntil({
      visible: { text: `.*${escapeRegex(then)}.*` },
      timeout: 60000
    })
    .catch((error: unknown) => {
      throw new Error(
        `Tapping the banner "${text}" did not open "${then}": ${String(error)}`
      )
    })
}

/** Whether a banner showing `text` comes within 10 s of `deliver`. */
async function bannerShown(
  m: AttachedDevice,
  deliver: () => Promise<unknown>,
  text: string
): Promise<boolean> {
  const seen = m
    .extendedWaitUntil({
      visible: { text: `.*${escapeRegex(text)}.*` },
      timeout: 10000
    })
    .then(
      () => true,
      () => false
    )
  await pause(500)
  await deliver()
  return await seen
}

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function ios(): Promise<void> {
  config = JSON.parse(
    await readFile(required('TS_NOTIFY_CONFIG'), 'utf8')
  ) as ServerConfig
  if (config.push?.logFile == null || config.push.logFile === '')
    throw new Error('The API must log its pushes: set push.logFile')
  db = makeDatabase(config.databaseUrl)
  const seed = readSeedTable(await readFile(required('TS_NOTIFY_SEED'), 'utf8'))
  const p1 = seed.Ea
  const p2 = seed.Ec
  const appFile = required('TS_NOTIFY_APP')
  const filteringApp = required('TS_NOTIFY_FILTERING_APP')
  await mkdir(artifacts, { recursive: true })
  await writeFile(path.join(artifacts, LOG), '')
  await writeFile(
    path.join(artifacts, SEEN_LOG),
    `$ TS_NOTIFY_PLATFORM=${IOS ? 'ios' : 'android'} node -r sucrase/register mobile/test/teamStationAppNotifications.e2e.ts\n`
  )

  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: serial,
    appId: APP,
    artifactDir: path.join(artifacts, 'ios')
  })
  try {
    // 1. Signed in as P2, chat set up, both switches on, notifications allowed.
    await signInIos(m, p2)
    await say(`$ P2 (${p2.name}) signs in on the simulator`)
    await openLink(
      m,
      'teamstation://chat',
      chatRowText('Eagles Members', 'ios')
    )
    await m.extendedWaitUntil({
      visible: { text: chatRowText('Eagles Members', 'ios') },
      timeout: 90000
    })
    await say('$ P2 opens Chat: this phone is set up for chat')
    // Framed as account-ios-before.png was: Chat, then Notifications
    // before Walk-up songs.
    await openLink(m, 'teamstation://account', ACCOUNT_SCREEN)
    await m.scrollUntilVisible({
      element: { text: 'Chat devices' },
      timeout: 30000
    })
    await m.scroll({}).catch(() => undefined)
    await pause(1500)
    await writeFile(
      path.join(artifacts, 'account-ios-after.png'),
      await m.screenshot()
    )
    await account(m)
    const started = new Date()
    await toggleIos(m, MESSAGES)
    await allowIos(m)
    await say(`$ ${MESSAGES} on; iOS asks; tapOn Allow`)
    await toggleIos(m, RSVP_EVENTS)
    await m.assertNotVisible({ text: BLOCKED })
    const registration = await until(
      'P2’s APNs registration',
      async () =>
        await db
          .selectFrom('push_registrations')
          .select(['id', 'platform', 'address', 'environment'])
          .where('user_id', '=', p2.userId)
          .where('platform', '=', 'ios')
          .where('seen_at', '>', started)
          .executeTakeFirst(),
      60000
    )
    await say(
      `$ push_registrations row ${registration.id} ${registration.platform} ${registration.environment} (an APNs token of ${registration.address.length} hex digits)`
    )

    // 2. The default build, iosFiltering off. A DM is an alert the extension opens.
    const sender = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p1.userId, 'notifications-e2e')).token
    })
    const engine = await engineOf(p1, sender)
    const dm = await sender.createDm([p2.userId])
    const stamp = Date.now().toString(36)
    const dmText = `Bring the cones, ${stamp}`
    let from = (await records()).length
    await engine.open(dm.id)
    await engine.sendText(dm.id, dmText)
    const [dmRecord] = await iosRecords(p2.userId, from, 1)
    const dmPayload = apnsOf(dmRecord)
    const dmWake = dmPayload as unknown as ChatWake
    const aps = dmPayload.aps as Record<string, unknown>
    if (aps['mutable-content'] !== 1)
      throw new Error('A DM is an alert the extension may rewrite')
    await say(
      `$ P1 sends P2 the DM "${dmText}": push.jsonl ios ${dmRecord.message.platform === 'ios' ? dmRecord.message.pushType : ''} mutable-content body "${JSON.stringify(aps.alert)}" from="${dmWake.from}"`
    )
    // `simctl push` hands an alert straight to Notification Center: it never
    // runs the notification extension, which only a delivery through APNs
    // does (`ChatWakeDecryptorTests` runs the extension's code in the app).
    // So the DM shows the server's own body, and a tap opens it.
    const fallbackBody = `New message from ${dmWake.from}`
    await home(m)
    await tapBanner(
      m,
      async () => await deliverIos(dmPayload),
      fallbackBody,
      dmText,
      'ios-dm-notification.png'
    )
    await say(
      `$ simctl push of the DM alert, app in the background: the banner says "${fallbackBody}", the server's body — simctl push does not run the extension, so "${dmWake.from}" "${dmText}" in its place is BLOCKED here until an APNs delivery (ChatWakeDecryptorTests runs the extension's code); a tap opens the DM, "${dmText}"`
    )
    // Seen: the tap left the DM on screen. A DM that comes is read within
    // the hold and wakes nobody, and an alert for it shows no banner
    // (`willPresent`).
    const seenText = `Seen as it came, ${stamp}`
    from = (await records()).length
    await engine.sendText(dm.id, seenText)
    await m.extendedWaitUntil({
      visible: { text: `.*${escapeRegex(seenText)}.*` },
      timeout: 30000
    })
    // Past the stack's 2 s hold, and the sender's next turn.
    await pause(6000)
    const seenWakes = (await records())
      .slice(from)
      .filter(
        record => record.userId === p2.userId && record.platform === 'ios'
      )
    if (seenWakes.length > 0)
      throw new Error(`A DM read on screen woke P2: ${seenWakes.length}`)
    await saySeen(
      `$ the DM on screen; P1 sends "${seenText}": read within the hold, no push.jsonl wake for P2`
    )
    if (
      await bannerShown(
        m,
        async () => await deliverIos(dmPayload),
        fallbackBody
      )
    )
      throw new Error('An alert for the conversation on screen showed a banner')
    await saySeen(
      '$ simctl push of the DM alert with the DM on screen: no banner (willPresent shows nothing for it)'
    )
    // Anywhere else in the app it shows over the app.
    await openLink(
      m,
      'teamstation://chat',
      chatRowText('Eagles Members', 'ios')
    )
    await m.extendedWaitUntil({
      visible: { text: chatRowText('Eagles Members', 'ios') },
      timeout: 30000
    })
    const banner = await bannerShown(
      m,
      async () => await deliverIos(dmPayload),
      fallbackBody
    )
    await saySeen(
      banner
        ? '$ simctl push, app in the foreground on the chat list: the banner shows over the app'
        : '$ simctl push, app in the foreground on the chat list: delivered (the banner is SpringBoard’s, outside the app’s hierarchy)'
    )

    // Read elsewhere: the server sends this iPhone a background push that
    // takes the DM's notifications down (`removeDeliveredNotifications`).
    await home(m)
    const elsewhereText = `Read on another device, ${stamp}`
    from = (await records()).length
    await engine.sendText(dm.id, elsewhereText)
    const [elsewhere] = await iosRecords(p2.userId, from, 1)
    const elsewhereWake = apnsOf(elsewhere) as unknown as ChatWake
    await deliverIos(apnsOf(elsewhere))
    const otherDevice = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p2.userId, 'notifications-e2e')).token
    })
    from = (await records()).length
    await otherDevice.markChatRead(dm.id, elsewhereWake.seq)
    const [read] = await iosRecords(p2.userId, from, 1)
    const readPayload = apnsOf(read)
    if (
      read.message.platform !== 'ios' ||
      read.message.pushType !== 'background' ||
      readPayload.t !== 'read' ||
      readPayload.c !== dm.id ||
      readPayload.seq !== elsewhereWake.seq
    )
      throw new Error(`Not the read push: ${JSON.stringify(read.message)}`)
    const readDelivered = await deliverIos(readPayload)
    await saySeen(
      readDelivered
        ? `$ P2 reads the DM to seq ${elsewhereWake.seq} on another device: push.jsonl ios background ${JSON.stringify(readPayload)}; delivered`
        : `$ P2 reads the DM to seq ${elsewhereWake.seq} on another device: push.jsonl ios background ${JSON.stringify(readPayload)}. Delivering it is BLOCKED here: simctl push refuses a push with no alert ("Notification has no user visible content"); PushTests hands it to the app delegate's background handler and checks removeDeliveredNotifications instead`
    )

    // Group wakes are background pushes: a mention posts a notification,
    // a plain message nothing.
    const group = await until(
      'Eagles Members in P1’s chats',
      async () =>
        (await engine.refresh()).find(
          chat => chat.kind === 'teamMembers' && chat.title === 'Eagles Members'
        )?.id
    )
    await home(m)
    const mentionText = `@${p2.name} has the scorebook, ${stamp}`
    from = (await records()).length
    await engine.open(group)
    await engine.sendText(group, mentionText, { mentions: [p2.userId] })
    const [mention] = await iosRecords(p2.userId, from, 1)
    if (
      mention.message.platform !== 'ios' ||
      mention.message.pushType !== 'background'
    )
      throw new Error('A group wake without iosFiltering is a background push')
    const mentionWake = apnsOf(mention) as unknown as ChatWake
    const mentionTitle = `${mentionWake.from} in Eagles Members`
    const plainText = `Practice moved inside, ${stamp}`
    if (await deliverIos(apnsOf(mention))) {
      await tapBanner(m, async () => true, mentionTitle, mentionText)
      await say(
        `$ mention, a background push to the backgrounded app: "${mentionTitle}" "${mentionText}" posted; a tap opens the chat`
      )
      await home(m)
      from = (await records()).length
      await engine.sendText(group, plainText)
      const [plain] = await iosRecords(p2.userId, from, 1)
      if (
        await bannerShown(
          m,
          async () => await deliverIos(apnsOf(plain)),
          plainText
        )
      )
        throw new Error('A plain group message posted a notification')
      await say('$ plain group message, a background push: nothing posted')
    } else {
      from = (await records()).length
      await engine.sendText(group, plainText)
      const [plain] = await iosRecords(p2.userId, from, 1)
      await say(
        `$ mention and plain group message: push.jsonl ios ${mention.message.pushType} and ${plain.message.platform === 'ios' ? plain.message.pushType : ''} (content-available, priority 5). Delivering them is BLOCKED here: simctl push refuses a push with no alert ("Notification has no user visible content"); ChatWakeDecryptorTests hands both to the app delegate's background handler instead`
      )
    }

    // 3a. Swiped away, the app is not woken for a background push; an alert still comes.
    await home(m)
    await pullProfiles('before the app is swiped away')
    terminateIos()
    const lateText = `Bus leaves at 4, ${stamp}`
    from = (await records()).length
    await engine.open(dm.id)
    await engine.sendText(dm.id, lateText)
    const [late] = await iosRecords(p2.userId, from, 1)
    if (
      !(await bannerShown(
        m,
        async () => await deliverIos(apnsOf(late)),
        fallbackBody
      ))
    )
      throw new Error('A DM alert did not come to a swiped-away app')
    await say(
      '$ app swiped away: a DM alert still arrives. A background group wake is not delivered to it, as iOS documents (known limitation until the filtering entitlement)'
    )

    // 4. A tap on a cold app: the DM opens the conversation on launch.
    // The banner above goes first, which says the same.
    await pause(10000)
    terminateIos()
    const coldText = `Gate code is 4410, ${stamp}`
    from = (await records()).length
    await engine.open(dm.id)
    await engine.sendText(dm.id, coldText)
    const [cold] = await iosRecords(p2.userId, from, 1)
    await tapBanner(
      m,
      async () => await deliverIos(apnsOf(cold)),
      fallbackBody,
      coldText
    )
    await pause(1500)
    await writeFile(
      path.join(artifacts, 'ios-tap-opens-conversation.png'),
      await m.screenshot()
    )
    await say(
      '$ app terminated, DM alert: a tap on its banner launches the app cold, straight into the conversation'
    )

    // A reminder for an event P2 said yes to, which opens the event.
    const eventId = makeId('teamEvent')
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
        start_at: new Date(Date.now() + 90 * 60 * 1000),
        timezone: 'America/Los_Angeles',
        status: 'scheduled'
      })
      .execute()
    const p2Client = new TeamStationClient({
      baseUrl: API,
      token: (await createSession(db, p2.userId, 'notifications-e2e')).token
    })
    await p2Client.saveRsvp(eventId, p2.userId, 'yes')
    from = (await records()).length
    const queued = await queueReminders(eventId)
    await say(
      `$ team event "Batting cage" in 90 minutes, P2 RSVPs yes; dueReminders queued for the push sender: ${queued}`
    )
    const reminder = await until('P2’s iOS reminder', async () =>
      (await records())
        .slice(from)
        .find(
          record =>
            record.userId === p2.userId &&
            record.platform === 'ios' &&
            JSON.stringify(apnsOf(record)).includes(eventId)
        )
    )
    const payload = apnsOf(reminder) as unknown as EventReminder
    await home(m)
    await tapBanner(
      m,
      async () => await deliverIos(apnsOf(reminder)),
      'Batting cage',
      'Batting cage'
    )
    await say(
      `$ reminder "${payload.title}" "${payload.body}" shown; a tap opens ${payload.url}`
    )

    // 3. The build with the filtering entitlement, as iosFiltering on would
    // send it: group wakes are alerts the extension opens or hides.
    await home(m)
    await pullProfiles('before the filtering build is installed')
    simctl('install', serial, filteringApp)
    await m.launchApp({ appId: APP, stopApp: true })
    await m.assertVisible({ text: 'Account, .*', timeout: 60000 })
    await home(m)
    const to = {
      id: registration.id,
      userId: p2.userId,
      platform: 'ios' as const,
      address: registration.address,
      environment: 'development' as const
    }
    const filtered = (record: PushLogRecord): Record<string, unknown> => {
      const { aps: _aps, ...wake } = apnsOf(record)
      const message = wakeMessage(to, wake as unknown as ChatWake, true)
      if (message?.platform !== 'ios' || message.pushType !== 'alert')
        throw new Error('With iosFiltering a group wake is an alert')
      return message.payload
    }
    const filteredText = `@${p2.name} bring the pitching rubber, ${stamp}`
    from = (await records()).length
    await engine.sendText(group, filteredText, { mentions: [p2.userId] })
    const [filteredMention] = await iosRecords(p2.userId, from, 1)
    const groupBody = 'New message in Eagles Members'
    await tapBanner(
      m,
      async () => await deliverIos(filtered(filteredMention)),
      groupBody,
      filteredText
    )
    await say(
      `$ filtering build, the mention as the alert iosFiltering sends: "${groupBody}" and a tap opens the chat. Showing "${mentionTitle}" "${filteredText}" in its place is BLOCKED here: simctl push does not run the extension, which needs an APNs delivery (an APNs key)`
    )
    await home(m)
    const hiddenText = `Snacks are on the table, ${stamp}`
    from = (await records()).length
    await engine.sendText(group, hiddenText)
    const [hidden] = await iosRecords(p2.userId, from, 1)
    const shownPlain = await bannerShown(
      m,
      async () => await deliverIos(filtered(hidden)),
      groupBody
    )
    await say(
      shownPlain
        ? `$ filtering build, a plain group alert: "${groupBody}" is shown. Hiding it is BLOCKED here, for the same reason, until an APNs delivery to a device holding the granted entitlement`
        : '$ filtering build, a plain group alert: nothing shown'
    )
    engine.stop()

    // 5. A fresh install that is refused: the switch stays on with the blocked line.
    await p2Client.setAccountNotifications({
      messages: false,
      rsvpEvents: false
    })
    await home(m)
    await pullProfiles('before the fresh install')
    simctl('uninstall', serial, APP)
    simctl('install', serial, appFile)
    // maestro-d's driver answers the question itself, so it is answered
    // Don't Allow as the app is launched.
    await signInIos(m, p2, 'deny')
    await account(m)
    await toggleIos(m, MESSAGES)
    await m.extendedWaitUntil({ visible: { text: BLOCKED }, timeout: 30000 })
    await m.shot('ios-blocked')
    await say(`$ fresh install, ${MESSAGES} on, Don’t Allow: "${BLOCKED}"`)
    await toggleIos(m, RSVP_EVENTS)
    await pause(2000)
    await m.assertNotVisible({ text: DONT_ALLOW })
    await m.assertVisible({ text: BLOCKED })
    await say(`$ ${RSVP_EVENTS} on: no second question, still "${BLOCKED}"`)
    await home(m)
    await pullProfiles('at the end')
    console.log('N6 passed')
  } finally {
    await m.detach()
    await db.destroy()
  }
}

;(IOS ? ios() : android()).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
