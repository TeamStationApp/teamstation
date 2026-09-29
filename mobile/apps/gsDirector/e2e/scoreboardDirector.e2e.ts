import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { attach } from '../../../test/maestroD'

/**
 * GS Director against a development seat: the chosen GameStation event
 * covering recordings (D1, D2).
 *
 *   node -r sucrase/register mobile/apps/gsDirector/e2e/scoreboardDirector.e2e.ts \
 *     --step <eventRecording|eventStream>
 *
 * Every step runs against the iPad named by the environment, never one named
 * here, on a maestro-d daemon this agent owns:
 *
 *   MAESTRO_D             the daemon's name, e.g. director-nativeScoreboard
 *   DIRECTOR_DEVICE_UDID  the iPad
 *   SEAT_HOST             the seat's host, e.g. nativescoreboard.gamestation.co
 *   GS_E2E_GAMES          the seeder's ids, comma-separated, in its order:
 *                         −4 h, −10 m, +1 h … +6 h, cancelled
 *   GS_E2E_TOKEN          a bearer token for scoreboard-e2e@gamestation.local
 *   SEAT_SQL              a command that runs its last argument as SQL on the
 *                         seat's database and prints bare rows, e.g.
 *                         "ssh gs psql -d GameStation_nativeScoreboard -tAc"
 *   SEAT_SIGN_IN_CODE     a command printing the newest sign-in code of the
 *                         e-mail given as its last argument (read from the
 *                         seat service's journal)
 *
 * Screenshots land in the run's artifact directory, and each result is also
 * confirmed with a frame from the bench webcam (the webcam-capture skill).
 */

const RUNNER_EMAIL = 'scoreboard-e2e@gamestation.local'
const APP_ID = 'co.gamestation.director'

type Device = Awaited<ReturnType<typeof attach>>

interface Env {
  daemon: string
  device: string
  host: string
  games: string[]
  token: string
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

function env(): Env {
  const games = required('GS_E2E_GAMES').split(',')
  assert(games.length === 9, 'GS_E2E_GAMES holds the seeder’s nine ids')
  return {
    daemon: required('MAESTRO_D'),
    device: required('DIRECTOR_DEVICE_UDID'),
    host: required('SEAT_HOST'),
    games,
    token: required('GS_E2E_TOKEN')
  }
}

/** The seeded games by name. */
function game(e: Env, name: '-4h' | '-10m' | '+1h'): string {
  const at = { '-4h': 0, '-10m': 1, '+1h': 2 }[name]
  return e.games[at]
}

/** Runs one of the SEAT_* commands with a last argument, and returns stdout. */
function seat(key: string, ...args: string[]): string {
  const [command, ...rest] = required(key).split(' ')
  return execFileSync(command, [...rest, ...args], { encoding: 'utf8' }).trim()
}

const sql = (query: string): string => seat('SEAT_SQL', query)

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// MARK: - Driving the app

async function launch(m: Device): Promise<void> {
  await m.launchApp({
    appId: APP_ID,
    arguments: { uiTest: true, debugHUD: false }
  })
  await m.extendedWaitUntil({ visible: { id: 'start-directing' }, timeout: 30_000 })
  await m.tapOn({ id: 'start-directing' })
  await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30_000 })
}

async function openSettings(m: Device): Promise<void> {
  await m.tapOn({ id: 'settings-button' })
  await m.extendedWaitUntil({
    visible: { id: 'settings-gamestation-account' },
    timeout: 20_000
  })
}

async function saveSettings(m: Device): Promise<void> {
  await m.tapOn({ id: 'settings-save' })
  await m.extendedWaitUntil({ notVisible: { id: 'settings-save' }, timeout: 10_000 })
}

async function signIn(m: Device): Promise<void> {
  await m.tapOn({ id: 'settings-gamestation-account' })
  const signedIn = await m
    .assertVisible({ id: 'gamestation-sign-out', timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  if (!signedIn) {
    await m.tapOn({ id: 'gamestation-email' })
    await m.inputText({ text: RUNNER_EMAIL })
    await m.hideKeyboard()
    await m.tapOn({ id: 'gamestation-send-code' })
    await m.extendedWaitUntil({ visible: { id: 'gamestation-code' }, timeout: 30_000 })
    await sleep(3_000)
    await m.tapOn({ id: 'gamestation-code' })
    await m.inputText({ text: seat('SEAT_SIGN_IN_CODE', RUNNER_EMAIL) })
    await m.hideKeyboard()
    await m.tapOn({ id: 'gamestation-submit-code' })
    await m.extendedWaitUntil({ visible: { id: 'gamestation-sign-out' }, timeout: 30_000 })
  }
  await m.tapOn({ id: 'gamestation-sign-in-done' })
}

async function clearEvent(m: Device): Promise<void> {
  await m.tapOn({ id: 'settings-gamestation-event-clear', optional: true })
  await m.assertNotVisible({ id: 'settings-gamestation-event-clear' })
}

async function pickEvent(m: Device, gameId: string): Promise<void> {
  await m.tapOn({ id: 'settings-gamestation-event' })
  await m.extendedWaitUntil({
    visible: { id: `event-picker-row-${gameId}` },
    timeout: 20_000
  })
  await m.tapOn({ id: `event-picker-row-${gameId}` })
  await m.extendedWaitUntil({
    visible: { id: 'settings-gamestation-event-clear' },
    timeout: 20_000
  })
}

async function toggleCapture(m: Device, id: 'record-button' | 'stream-button'): Promise<void> {
  await m.tapOn({ id })
}

/** Completes the slide-to-stop popup after Record or Stream was tapped. */
async function slideToStop(m: Device): Promise<void> {
  await m.extendedWaitUntil({ visible: { id: 'slide-to-stop-track' }, timeout: 8_000 })
  await m.swipe({ start: '79%, 12%', end: '96%, 12%', duration: 1_200 })
}

async function record(m: Device, seconds: number): Promise<void> {
  await toggleCapture(m, 'record-button')
  await sleep(seconds * 1_000)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
}

/** Takes that belong to a game, from the seat's database. */
function liveStreams(gameId: string): number {
  return Number(sql(`select count(*) from live_streams where game_id = '${gameId}'`))
}

// MARK: - The steps

/** D1: an event links a record-only take, and a take already running. */
async function eventRecording(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  await launch(m)
  await openSettings(m)
  await signIn(m)
  await clearEvent(m)
  await m.tapOn({ id: 'settings-stream-destination-url' })
  await saveSettings(m)

  await toggleCapture(m, 'record-button')
  await sleep(10_000)
  await openSettings(m)
  await pickEvent(m, id)
  await saveSettings(m)
  await sleep(10_000)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
  await record(m, 10)

  assert.equal(liveStreams(id), 0, 'nothing was claimed for a record-only event')
  await openSettings(m)
  await m.shot('d1-settings')
  await saveSettings(m)

  await m.tapOn({ id: 'recordings-button' })
  await m.extendedWaitUntil({ visible: { id: 'recordings-dates' }, timeout: 10_000 })
  // Each take's title names the game, away at home, so it holds the
  // visiting team's name once.
  const tree = JSON.stringify(await m.hierarchy())
  const titled = tree.split('Scoreboard E2E Visitors').length - 1
  assert(titled >= 2, `both takes are titled with the game (found ${titled})`)
  await m.shot('d1-recordings')
}

/** D2: choosing the event destination claims it. */
async function eventStream(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  await launch(m)
  await openSettings(m)
  await m.tapOn({ id: 'settings-stream-destination-event' })
  await saveSettings(m)
  await toggleCapture(m, 'stream-button')
  await sleep(30_000)
  assert.equal(liveStreams(id), 1, 'the event was claimed')
  const state = sql(`select state from live_streams where game_id = '${id}'`)
  assert.equal(state, 'publishing', 'the stream is publishing')
  await m.shot('d2-streaming')
  await toggleCapture(m, 'stream-button')
  await slideToStop(m)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)

  await openSettings(m)
  await m.tapOn({ id: 'settings-gamestation-event-clear' })
  await m.assertVisible({ text: 'GameStation event — pick one above' })
  await m.shot('d2-cleared')
  await saveSettings(m)
}

const STEPS: Record<string, (m: Device, e: Env) => Promise<void>> = {
  eventRecording,
  eventStream
}

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--step')
  const name = at >= 0 ? argv[at + 1] : undefined
  const step = name != null ? STEPS[name] : undefined
  if (name == null || step == null) {
    throw new Error(`--step is one of ${Object.keys(STEPS).join(', ')}`)
  }
  const e = env()
  const m = await attach({ daemon: e.daemon, device: e.device, appId: APP_ID })
  console.log(`▸ ${name} on ${e.device}`)
  await step(m, e)
  console.log(`✓ ${name}`)
}

if ((process.argv[1] ?? '').endsWith('scoreboardDirector.e2e.ts')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
