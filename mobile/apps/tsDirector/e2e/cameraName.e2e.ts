import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { flatten, maestroBin, maestroClient } from '../../../test/maestroD'

/**
 * Director names its camera when it claims a TeamStation event.
 *
 * Install first, with the seat host and no scheme, so the claim and this
 * script's API read are the same server:
 *
 *   TS_PRIMARY_HOST=<SEAT_HOST> xcodebuild ... onto DIRECTOR_DEVICE_UDID
 *
 * Then:
 *
 *   MAESTRO_D=camera-name-director \
 *   DIRECTOR_DEVICE_UDID=<udid> \
 *   SEAT_HOST=<seat host> \
 *   SEAT_SIGN_IN_CODE=<command that prints the newest code for the email given as its last argument> \
 *   TS_E2E_EMAIL=<that account's email> \
 *   TS_E2E_TOKEN=<bearer for the same account> \
 *   TS_E2E_GAME=<game id> \
 *   SEAT_SQL=<command that runs its last argument as SQL and prints bare rows> \
 *     node -r sucrase/register mobile/apps/tsDirector/e2e/cameraName.e2e.ts
 *
 * The account runs the game (owner or manager) and films it (videographer).
 * The game's start is within the last two hours or in the future, and it is
 * among the 20 soonest games `GET /events?scope=run` returns.
 */

const APP_ID = 'app.teamstation.director'
const MARGIN = '1%'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface HierarchyNode {
  id?: string
  text?: string
  bounds?: Box
  children?: HierarchyNode[]
}

interface Device {
  launchApp: (value?: unknown) => Promise<unknown>
  tapOn: (value: unknown) => Promise<unknown>
  inputText: (value: unknown) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  assertVisible: (value: unknown) => Promise<unknown>
  assertNotVisible: (value: unknown) => Promise<unknown>
  extendedWaitUntil: (value: unknown) => Promise<unknown>
  swipe: (value: unknown) => Promise<unknown>
  hierarchy: () => Promise<HierarchyNode>
  detach: () => Promise<unknown>
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

function seat(key: string, ...args: string[]): string {
  const [command, ...rest] = required(key).split(' ')
  return execFileSync(command, [...rest, ...args], { encoding: 'utf8' }).trim()
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

async function boundsOf(m: Device, id: string): Promise<Box | undefined> {
  return flatten(await m.hierarchy()).find(
    node => node.id === id && node.bounds != null
  )?.bounds
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

async function showInSettings(
  m: Device,
  id: string,
  bound = 12
): Promise<void> {
  await settingsToTop(m)
  for (let swipes = 0; ; swipes++) {
    if (await isVisible(m, id)) break
    if (swipes === bound) {
      throw new Error(
        `${id} did not come into view in ${bound} swipes down Settings`
      )
    }
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

async function signIn(m: Device, email: string): Promise<void> {
  await showInSettings(m, 'settings-teamstation-account')
  await m.tapOn({ id: 'settings-teamstation-account' })
  let signedIn = await m
    .assertVisible({ id: 'teamstation-sign-out', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (signedIn && !JSON.stringify(await m.hierarchy()).includes(email)) {
    await m.tapOn({ id: 'teamstation-sign-out' })
    await m.extendedWaitUntil({
      visible: { id: 'teamstation-slide-logout' },
      timeout: 5000
    })
    const track = await boundsOf(m, 'teamstation-slide-logout')
    if (track != null) {
      const y = track.y + track.height / 2
      await m.swipe({
        startX: track.x + 4,
        startY: y,
        endX: track.x + track.width - 4,
        endY: y,
        duration: 400
      })
    }
    await m.extendedWaitUntil({
      visible: { id: 'teamstation-email' },
      timeout: 10000
    })
    signedIn = false
  }
  if (!signedIn) {
    await m.tapOn({ id: 'teamstation-email' })
    await m.inputText({ text: email })
    await m.hideKeyboard()
    await m.tapOn({ id: 'teamstation-send-code' })
    await m.extendedWaitUntil({
      visible: { id: 'teamstation-code' },
      timeout: 30000
    })
    await new Promise(resolve => setTimeout(resolve, 3000))
    await m.tapOn({ id: 'teamstation-code' })
    await m.inputText({ text: seat('SEAT_SIGN_IN_CODE', email) })
    const stillThere = await m
      .assertVisible({ id: 'teamstation-submit-code', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
    if (stillThere) {
      await m.hideKeyboard()
      await m.tapOn({ id: 'teamstation-submit-code' })
    }
    await m.extendedWaitUntil({
      visible: { id: 'settings-teamstation-account' },
      timeout: 30000
    })
  }
}

async function main(): Promise<void> {
  const daemon = required('MAESTRO_D')
  const device = required('DIRECTOR_DEVICE_UDID')
  const host = required('SEAT_HOST')
  const email = required('TS_E2E_EMAIL')
  const token = required('TS_E2E_TOKEN')
  const gameId = required('TS_E2E_GAME')
  const bin = maestroBin()
  console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())

  const { MaestroD } = maestroClient()
  const connection = await MaestroD.connect({ name: daemon, spawn: false, bin })
  const teamId = process.env.MAESTRO_D_TEAM_ID ?? 'G5LQ7MERPK'
  const attached = await connection.attach({
    device,
    platform: 'ios',
    appId: APP_ID,
    teamId
  })
  const m = attached as unknown as Device
  try {
    await m.launchApp({
      appId: APP_ID,
      stopApp: true,
      arguments: { uiTest: true }
    })
    await m.extendedWaitUntil({
      visible: { id: 'start-directing' },
      timeout: 30000
    })
    await m.tapOn({ id: 'start-directing' })
    await m.extendedWaitUntil({
      visible: { id: 'settings-button' },
      timeout: 30000
    })
    await m.tapOn({ id: 'settings-button' })
    await m.extendedWaitUntil({
      visible: { id: 'settings-teamstation-account' },
      timeout: 20000
    })

    await signIn(m, email)

    await showInSettings(m, 'settings-stream-destination-url')
    await m.assertNotVisible({ id: 'settings-camera-name' })

    await showInSettings(m, 'settings-stream-destination-event')
    await m.tapOn({ id: 'settings-stream-destination-event' })
    await showInSettings(m, 'settings-camera-name')
    await m.assertVisible({ id: 'settings-camera-name' })
    await m.tapOn({ id: 'settings-camera-name' })
    await m.inputText({ text: 'Center Field' })
    await m.hideKeyboard()

    await showInSettings(m, 'settings-teamstation-event')
    await m.tapOn({ id: 'settings-teamstation-event' })
    await m.extendedWaitUntil({
      visible: { id: `event-picker-row-${gameId}` },
      timeout: 20000
    })
    await m.tapOn({ id: `event-picker-row-${gameId}` })

    const listed = await fetch(
      `${apiBase(host)}/games/${gameId}/live-streams`,
      {
        headers: { authorization: `Bearer ${token}` }
      }
    )
    assert.equal(listed.status, 200)
    const body = (await listed.json()) as {
      mine: Array<{ label: string; videoId: string | null }>
    }
    const stream = body.mine.find(row => row.label === 'Center Field')
    assert(stream != null, 'the claim stored the camera name Center Field')
    assert(stream.videoId != null && /^[A-Za-z0-9_-]+$/.test(stream.videoId))
    const title = seat(
      'SEAT_SQL',
      `select title from videos where id = '${stream.videoId}'`
    )
    assert(
      title.endsWith(' — Center Field'),
      'the video title ends with the camera name'
    )
    console.log('claimed Center Field')
  } finally {
    await m.detach().catch(() => undefined)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
