import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  flatten,
  type HierarchyNode,
  maestroBin,
  maestroClient
} from '../../../test/maestroD'

/**
 * Director's Stream on a TeamStation game with no camera place free: the
 * operator reads the server's sentence and nothing dials. Beside it, the two
 * behaviours that change must leave alone: a Stream pressed while TeamStation
 * cannot be reached dials the address Director already holds, and a redial of
 * a camera ended on TeamStation stops with "This camera was ended".
 *
 * Install first, from a build whose TS_PRIMARY_HOST is SEAT_HOST, so Director
 * and this script talk to the same server:
 *
 *   TS_PRIMARY_HOST=<SEAT_HOST> DIRECTOR_SIMULATOR_UDID=<udid> bash scripts/build-sim.sh
 *   xcrun simctl install <udid> "<the .app it prints>"
 *
 * Then:
 *
 *   MAESTRO_D=<this agent's daemon> \
 *   DIRECTOR_DEVICE_UDID=<udid> \
 *   SEAT_HOST=<host:port of the server> \
 *   SEAT_SIGN_IN_CODE=<command printing the newest sign-in code for the email given as its last argument> \
 *   SEAT_SQL=<command that runs its last argument as SQL and prints bare rows> \
 *   SEAT_INGEST_LOG=<the ingest process's log file> \
 *   SEAT_API_STOP=<command that stops the API, leaving the ingest running> \
 *   SEAT_API_START=<command that starts the API again and returns once it answers> \
 *   TS_E2E_EMAIL=<the account Director signs in as> \
 *   TS_E2E_TOKEN=<a bearer token for that account> \
 *   TS_E2E_OTHER_TOKEN=<a bearer token for a second account that can film the game> \
 *   TS_E2E_GAME=<a game starting now, with no cameras> \
 *   [TS_E2E_ARTIFACT_DIR=<where the screenshots go>] \
 *     node -r sucrase/register mobile/apps/tsDirector/e2e/slotFull.e2e.ts
 *
 * Both accounts run the game (an administrator does). Every step runs and
 * takes its screenshot even when an earlier one failed, so a run against a
 * build without the change shows each step's state; the run then exits 1,
 * naming the steps that failed.
 *
 *   1. With the API stopped, Stream goes live on the address Director holds.
 *   2. That camera is ended on TeamStation: the redial stops with the ended
 *      sentence, and nothing new is made.
 *   3. Four cameras on the game, two of each account: Stream shows the game's
 *      sentence, and nothing dials.
 *   4. Four of the director's own: the game is full with one person's
 *      cameras alone, and Stream still shows the game's sentence, not a
 *      person's, and nothing dials.
 *   5. One of them ended: Stream goes live on a fresh camera.
 *
 * "Nothing dials" is read three ways: the game's rows (no new one, none
 * publishing), the ingest log (no publish began after the tap: no new
 * "start push" line; only the count is printed, because the lines carry keys)
 * and the Stream button, which still reads
 * STREAM ten seconds later.
 */

const APP_ID = 'app.teamstation.director'
const MARGIN = '1%'
const CAMERA = 'Slot Full'
const ENDED = 'This camera was ended. Start streaming again to go live.'
const GAME_FULL = 'This game already has 4 cameras. End one to add another.'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Device {
  launchApp: (value?: unknown) => Promise<unknown>
  tapOn: (value: unknown) => Promise<unknown>
  inputText: (value: unknown) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  assertVisible: (value: unknown) => Promise<unknown>
  extendedWaitUntil: (value: unknown) => Promise<unknown>
  swipe: (value: unknown) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  hierarchy: () => Promise<HierarchyNode>
  detach: () => Promise<unknown>
}

interface Stream {
  id: string
  label: string | null
  state: string
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

/** Runs the command in `key`, with `args` after its own. */
function seat(key: string, ...args: string[]): string {
  const [command, ...rest] = required(key).split(' ')
  return execFileSync(command, [...rest, ...args], { encoding: 'utf8' }).trim()
}

function sql(query: string): string {
  return seat('SEAT_SQL', query)
}

/** `https` for a DNS name, `http` for an IP or localhost. Same rule as AppServer. */
function apiBase(host: string): string {
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? host)
  const plain =
    name === 'localhost' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    name.startsWith('[')
  return `${plain ? 'http' : 'https'}://${host}/api/v1`
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, ms))

const env = {
  host: '',
  game: '',
  email: '',
  token: '',
  other: '',
  shots: ''
}

async function api(
  method: string,
  route: string,
  token: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await fetch(`${apiBase(env.host)}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body == null ? {} : { 'content-type': 'application/json' })
    },
    body: body == null ? undefined : JSON.stringify(body)
  })
  const text = await answer.text()
  return {
    status: answer.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  }
}

/** A camera made through the API, as somebody's phone or encoder would be. */
async function addCamera(token: string, label: string): Promise<string> {
  const made = await api('POST', `/games/${env.game}/live-streams`, token, {
    label
  })
  assert.equal(made.status, 201, `${label} was made (${made.status})`)
  return made.body.id as string
}

async function endCamera(token: string, id: string): Promise<void> {
  const ended = await api(
    'POST',
    `/games/${env.game}/live-streams/${id}/end`,
    token
  )
  assert.equal(ended.status, 200, `${id} was ended (${ended.status})`)
}

/** Every camera on the game, from its rows. */
function streams(): Stream[] {
  const rows = sql(
    `select id, coalesce(label, ''), state from live_streams ` +
      `where game_id = '${env.game}' and state <> 'revoked' order by created_at`
  )
  return rows === ''
    ? []
    : rows.split('\n').map(row => {
        const [id, label, state] = row.split('|')
        return { id, label: label === '' ? null : label, state }
      })
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(1000)
  }
}

function ingestBytes(): number {
  return statSync(required('SEAT_INGEST_LOG')).size
}

/**
 * How many publishes the ingest began after `from` bytes: its "start push"
 * lines, one per RTMP publish that reached it. Its other lines (a camera ended
 * a moment before, being tidied up) are not a dial. Never the lines.
 */
function ingestPushesSince(from: number): number {
  const text = readFileSync(required('SEAT_INGEST_LOG'), 'utf8')
  return text
    .slice(from)
    .split('\n')
    .filter(line => line.includes(' start push ')).length
}

async function nodeById(
  m: Device,
  id: string
): Promise<HierarchyNode | undefined> {
  return flatten(await m.hierarchy()).find(node => node.id === id)
}

async function boundsOf(m: Device, id: string): Promise<Box | undefined> {
  return (await nodeById(m, id))?.bounds
}

async function isVisible(
  m: Device,
  id: string,
  timeout = 1000
): Promise<boolean> {
  return await m
    .assertVisible({ id, timeout })
    .then(() => true)
    .catch(() => false)
}

/** STREAM or STREAMING: what the Stream button reads. */
async function streamLabel(m: Device): Promise<string> {
  return ((await nodeById(m, 'stream-button'))?.text ?? '').trim()
}

async function statusMessage(m: Device): Promise<string | undefined> {
  return (await nodeById(m, 'status-message'))?.text?.trim()
}

/** Waits for the status toast to say `text`, and says what it said instead. */
async function waitForStatus(
  m: Device,
  text: string,
  timeoutMs = 30_000
): Promise<void> {
  let seen: string | undefined
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    seen = await statusMessage(m)
    if (seen === text) return
    await sleep(1000)
  }
  throw new Error(`the status said "${seen ?? '(nothing)'}", not "${text}"`)
}

async function dismissStatus(m: Device): Promise<void> {
  if (await isVisible(m, 'status-dismiss', 500)) {
    await m.tapOn({ id: 'status-dismiss' }).catch(() => undefined)
  }
}

let serial = 0
async function shot(m: Device, name: string): Promise<void> {
  const file = path.join(
    env.shots,
    `${String(++serial).padStart(2, '0')}-${name}.png`
  )
  mkdirSync(env.shots, { recursive: true })
  writeFileSync(file, await m.screenshot())
  console.log(`  screenshot ${file}`)
}

async function settingsToTop(m: Device): Promise<void> {
  for (let flings = 0; flings < 15; flings++) {
    if (await isVisible(m, 'settings-teamstation-account')) return
    await m.swipe({
      start: `${MARGIN}, 30%`,
      end: `${MARGIN}, 85%`,
      duration: 250
    })
  }
  throw new Error('Settings did not come back to its top after 15 flings')
}

async function showInSettings(m: Device, id: string): Promise<void> {
  await settingsToTop(m)
  for (let swipes = 0; !(await isVisible(m, id)); swipes++) {
    if (swipes === 12) throw new Error(`${id} did not come into view`)
    await m.swipe({
      start: `${MARGIN}, 75%`,
      end: `${MARGIN}, 25%`,
      duration: 600
    })
  }
  const footer = await boundsOf(m, 'settings-save')
  for (let nudges = 0; nudges < 3; nudges++) {
    const box = await boundsOf(m, id)
    if (footer == null || box == null || box.y + box.height <= footer.y - 8)
      return
    await m.swipe({
      start: `${MARGIN}, 60%`,
      end: `${MARGIN}, 45%`,
      duration: 600
    })
  }
}

async function signIn(m: Device): Promise<void> {
  await showInSettings(m, 'settings-teamstation-account')
  await m.tapOn({ id: 'settings-teamstation-account' })
  const signedIn = await m
    .assertVisible({ id: 'teamstation-sign-out', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (signedIn) {
    assert(
      JSON.stringify(await m.hierarchy()).includes(env.email),
      `Director is signed in as somebody other than ${env.email}`
    )
    await m.tapOn({ id: 'settings-teamstation-account' }).catch(() => undefined)
    return
  }
  await m.tapOn({ id: 'teamstation-email' })
  await m.inputText({ text: env.email })
  await m.hideKeyboard()
  await m.tapOn({ id: 'teamstation-send-code' })
  await m.extendedWaitUntil({
    visible: { id: 'teamstation-code' },
    timeout: 30_000
  })
  await sleep(3000)
  await m.tapOn({ id: 'teamstation-code' })
  await m.inputText({ text: seat('SEAT_SIGN_IN_CODE', env.email) })
  if (await isVisible(m, 'teamstation-submit-code', 2000)) {
    await m.hideKeyboard()
    await m.tapOn({ id: 'teamstation-submit-code' })
  }
  await m.extendedWaitUntil({
    visible: { id: 'settings-teamstation-account' },
    timeout: 30_000
  })
}

/** Director on its grid, signed in, streaming to the game as CAMERA. */
async function setUp(m: Device): Promise<string> {
  await m.launchApp({
    appId: APP_ID,
    stopApp: true,
    clearState: true,
    arguments: { uiTest: true, debugHUD: false, sourceProfile: 'synthetic4' }
  })
  // Source 1 on, from the launch Cameras sheet. One touch on its inert copy
  // first: a row that has just appeared takes a tap before its gestures are
  // attached and does nothing with it (maestro/flows/shared/settle-source-list.yaml).
  await m.extendedWaitUntil({
    visible: { id: 'source-row-1' },
    timeout: 30_000
  })
  await m.tapOn({
    text: 'Choose up to five cameras for the director grid, and whose audio to mix.'
  })
  await sleep(3000)
  await m.tapOn({ id: 'source-toggle-1' })
  await m.tapOn({ id: 'start-directing' })
  await m.extendedWaitUntil({
    visible: { id: 'settings-button' },
    timeout: 30_000
  })
  await m.extendedWaitUntil({
    notVisible: { text: 'No output source' },
    timeout: 20_000
  })

  await m.tapOn({ id: 'settings-button' })
  await m.extendedWaitUntil({
    visible: { id: 'settings-teamstation-account' },
    timeout: 20_000
  })
  await signIn(m)
  await showInSettings(m, 'settings-stream-destination-event')
  await m.tapOn({ id: 'settings-stream-destination-event' })
  await showInSettings(m, 'settings-camera-name')
  await m.tapOn({ id: 'settings-camera-name' })
  await m.inputText({ text: CAMERA })
  await m.hideKeyboard()
  await showInSettings(m, 'settings-teamstation-event')
  await m.tapOn({ id: 'settings-teamstation-event' })
  await m.extendedWaitUntil({
    visible: { id: `event-picker-row-${env.game}` },
    timeout: 20_000
  })
  await m.tapOn({ id: `event-picker-row-${env.game}` })
  await m.extendedWaitUntil({
    visible: { id: 'settings-teamstation-event-clear' },
    timeout: 20_000
  })
  await m.tapOn({ id: 'settings-save' })
  await m.extendedWaitUntil({
    notVisible: { id: 'settings-save' },
    timeout: 10_000
  })

  const claimed = streams().filter(row => row.label === CAMERA)
  assert.equal(claimed.length, 1, `picking the game claimed ${CAMERA}`)
  console.log(`  claimed ${CAMERA} as ${claimed[0].id}`)
  return claimed[0].id
}

/**
 * Taps Stream on a game with no place free and checks that Director says
 * `sentence` and dials nothing. The screenshot is taken before anything is
 * checked, so a build without the change still leaves its picture.
 */
async function streamOnAFullGame(
  m: Device,
  sentence: string,
  name: string
): Promise<void> {
  const before = streams()
  const mark = ingestBytes()
  await dismissStatus(m)
  await m.tapOn({ id: 'stream-button' })
  let said: Error | undefined
  try {
    await waitForStatus(m, sentence)
  } catch (error) {
    said = error as Error
  }
  await sleep(10_000)
  await shot(m, name)
  const after = streams()
  const pushes = ingestPushesSince(mark)
  const label = await streamLabel(m)
  console.log(
    `  after Stream: status "${(await statusMessage(m)) ?? ''}", button ${label}, ` +
      `${after.length} rows (was ${before.length}), ` +
      `${after.filter(row => row.state === 'publishing').length} publishing, ` +
      `ingest began ${pushes} publishes`
  )
  if (said != null) throw said
  assert.equal(after.length, before.length, 'no camera was made')
  assert(
    after.every(row => row.state !== 'publishing'),
    'no camera is publishing'
  )
  assert.equal(pushes, 0, 'the ingest began no publish: nothing dialled')
  assert.equal(label, 'STREAM', 'the Stream button is off')
}

async function main(): Promise<void> {
  const daemon = required('MAESTRO_D')
  const device = required('DIRECTOR_DEVICE_UDID')
  env.host = required('SEAT_HOST')
  env.game = required('TS_E2E_GAME')
  env.email = required('TS_E2E_EMAIL')
  env.token = required('TS_E2E_TOKEN')
  env.other = required('TS_E2E_OTHER_TOKEN')
  env.shots =
    process.env.TS_E2E_ARTIFACT_DIR ??
    path.join('/tmp', 'maestroD', daemon, `slotFull-${Date.now()}`)
  required('SEAT_SQL')
  required('SEAT_INGEST_LOG')
  required('SEAT_API_STOP')
  required('SEAT_API_START')
  assert.equal(streams().length, 0, 'the game starts with no cameras')

  const bin = maestroBin()
  console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())
  const { MaestroD } = maestroClient()
  const connection = await MaestroD.connect({ name: daemon, bin })
  const m = (await connection.attach({
    device,
    platform: 'ios',
    appId: APP_ID
  })) as unknown as Device

  const failed: string[] = []
  const step = async (
    name: string,
    run: () => Promise<void>
  ): Promise<void> => {
    console.log(`\n${name}`)
    try {
      await run()
      console.log(`  passed`)
    } catch (error) {
      failed.push(name)
      console.log(
        `  FAILED: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  try {
    const held = await setUp(m)
    const mine: string[] = []
    const others: string[] = []

    await step('1. offline at start dials the address held', async () => {
      seat('SEAT_API_STOP')
      try {
        await m.tapOn({ id: 'stream-button' })
        await until(
          `${held} publishing`,
          () => streams().find(row => row.id === held)?.state === 'publishing',
          60_000
        )
        await shot(m, 'offline-start-live')
      } finally {
        seat('SEAT_API_START')
      }
    })

    await step(
      '2. a redial of an ended camera stops with streamEnded',
      async () => {
        const before = streams().length
        await endCamera(env.token, held)
        await waitForStatus(m, ENDED, 60_000)
        await until(
          'the Stream button is off',
          async () => (await streamLabel(m)) === 'STREAM',
          15_000
        )
        await shot(m, 'redial-ended')
        assert.equal(streams().length, before, 'the redial made nothing')
      }
    )

    await step(
      '3. a full game shows its sentence and dials nothing',
      async () => {
        for (const label of ['Other 1', 'Other 2']) {
          others.push(await addCamera(env.other, label))
        }
        for (const label of ['Extra 1', 'Extra 2']) {
          mine.push(await addCamera(env.token, label))
        }
        await streamOnAFullGame(m, GAME_FULL, 'slot-full')
      }
    )

    await step(
      '4. a person at four shows the game sentence and dials nothing',
      async () => {
        await endCamera(env.other, others[0])
        await endCamera(env.other, others[1])
        for (const label of ['Extra 3', 'Extra 4']) {
          mine.push(await addCamera(env.token, label))
        }
        await streamOnAFullGame(m, GAME_FULL, 'slot-full-own-four')
      }
    )

    await step(
      '5. ending one lets Stream go live on a fresh camera',
      async () => {
        await endCamera(env.token, mine[0])
        await dismissStatus(m)
        await m.tapOn({ id: 'stream-button' })
        await until(
          `a fresh ${CAMERA} publishing`,
          () =>
            streams().some(
              row =>
                row.label === CAMERA &&
                row.id !== held &&
                row.state === 'publishing'
            ),
          60_000
        )
        await shot(m, 'freed-live')
        const fresh = streams().find(
          row =>
            row.label === CAMERA &&
            row.id !== held &&
            row.state === 'publishing'
        )
        if (fresh != null) {
          await endCamera(env.token, fresh.id)
          await waitForStatus(m, ENDED, 60_000).catch(() => undefined)
        }
      }
    )
  } finally {
    await m.detach().catch(() => undefined)
  }

  if (failed.length > 0) {
    throw new Error(`failed: ${failed.join('; ')}`)
  }
  console.log('\nall steps passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
