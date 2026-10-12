// E14: pairing a Tag Sports radar from the streaming screen's settings, its
// row, its readings on the overlay and on the game's web scoreboard, Unpair,
// and the picker with no radar in range. Through maestro-d's JavaScript
// client, on an iPhone or an Android phone, with the bench radar beside it.
//
//   TS_STREAM_IOS_UDID=<iPhone> | TS_STREAM_ANDROID_SERIAL=<Android phone> \
//   MAESTRO_D=<this agent's daemon> \
//   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> [MAESTRO_D_BIN=<binary>] \
//   [TS_STREAM_TEAM_ID=<WebDriverAgent signing team, for an iPhone>] \
//   TS_STREAM_API=http://<LAN address>:<port>/api/v1 \
//   TS_STREAM_WEB=http://<LAN address>:<web port> \
//   TS_STREAM_SERVER_LOG=<the local server's log> \
//   TS_STREAM_EMAIL=<a seeded user who runs the game> \
//   TS_STREAM_GAME=<a game whose scoreboard is open> \
//   [TS_STREAM_ANGLE=Home Plate] [TS_STREAM_TOKEN=<session>] \
//   [TS_STREAM_ARTIFACT_DIR=<dir>] [TS_RADAR_PITCH_SECONDS=120] \
//   [TS_RADAR_OFF_SECONDS=120] \
//     node -r sucrase/register src/app/stream/radarPairing.e2e.ts
//
// A person takes part: the script says when to throw a pitch past the radar
// and when to switch the radar off, and waits for each.
//
//   1. The gear, the Radar "On" switch, Pair Device, the `ADFA…` row: the row
//      reads "Connected" and the battery. Screenshots of the picker and the
//      card.
//   2. A pitch: the row and the overlay's readout show its speed, and the web
//      scoreboard (puppeteer) shows it, then clears 5 s later.
//   3. Unpair: the row is gone.
//   4. With the radar off, Pair Device: "No radars in range". Screenshot.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import puppeteer, { type Browser } from 'puppeteer'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Node {
  id?: string
  text?: string
  bounds?: Bounds
  children?: Node[]
}
interface Driver {
  hierarchy: () => Promise<Node>
  takeScreenshot: (options: { path: string }) => Promise<unknown>
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (target: { text: string } | { id: string }) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  scrollUntilVisible: (options: {
    element: { text: string }
    centerElement?: boolean
  }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: {
    device: string
    platform: 'ios' | 'android'
    appId: string
    teamId?: string
  }) => Promise<Driver>
}

const required = (key: string): string => {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}
const iosDevice = process.env.TS_STREAM_IOS_UDID
const androidDevice = process.env.TS_STREAM_ANDROID_SERIAL
assert(
  (iosDevice ?? androidDevice) != null,
  'TS_STREAM_IOS_UDID or TS_STREAM_ANDROID_SERIAL is required'
)
const device = (iosDevice ?? androidDevice)!
const platform: 'ios' | 'android' = iosDevice != null ? 'ios' : 'android'
const daemonName = required('MAESTRO_D')
const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
const api = required('TS_STREAM_API').replace(/\/$/, '')
const web = required('TS_STREAM_WEB').replace(/\/$/, '')
const serverLog = required('TS_STREAM_SERVER_LOG')
const email = required('TS_STREAM_EMAIL')
const game = required('TS_STREAM_GAME')
const angle = process.env.TS_STREAM_ANGLE ?? 'Home Plate'
const teamId = process.env.TS_STREAM_TEAM_ID
const artifacts = process.env.TS_STREAM_ARTIFACT_DIR
const pitchSeconds = Number(process.env.TS_RADAR_PITCH_SECONDS ?? '120')
const offSeconds = Number(process.env.TS_RADAR_OFF_SECONDS ?? '120')
const APP = 'app.teamstation.app'
/** A Tag Sports radar advertises itself as `ADFA…`. */
const RADAR_ROW = /^pair-device-(ADFA.*)$/

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const started = Date.now()
const say = (line: string): void => {
  console.log(
    `${new Date().toISOString()} +${((Date.now() - started) / 1000).toFixed(1)}s ${line}`
  )
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]
/** A node's words, its own or its children's. */
const wordsOf = (node: Node): string =>
  node.text ?? (node.children ?? []).map(wordsOf).join('')

/** The newest match of `pattern` in the server's log, after `offset` characters. */
async function fromServerLog(pattern: RegExp, offset: number): Promise<string> {
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const match = pattern.exec(
      (await readFile(serverLog, 'utf8')).slice(offset)
    )
    if (match?.[1] != null) return match[1]
    await sleep(300)
  }
  throw new Error(`Nothing matching ${String(pattern)} in the server log`)
}

/** Asks for a sign-in mail; the local server logs its link instead. */
async function signInLink(): Promise<string> {
  const offset = (await readFile(serverLog, 'utf8')).length
  const asked = await fetch(`${api}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  assert.equal(asked.status, 202, 'the sign-in code was sent')
  return await fromServerLog(
    /link: https?:\/\/[^/\s]+\/signin\/([A-Za-z0-9_-]+)/,
    offset
  )
}

async function main(): Promise<void> {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js') as {
    MaestroD: {
      connect: (options: { name: string; spawn: boolean }) => Promise<Daemon>
    }
  }
  const daemon = await MaestroD.connect({ name: daemonName, spawn: true })
  const m = await daemon.attach({
    device,
    platform,
    appId: APP,
    ...(teamId == null ? {} : { teamId })
  })
  const results: string[] = []
  if (artifacts != null) await mkdir(artifacts, { recursive: true })
  let browser: Browser | undefined

  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const find = async (
    test: (node: Node) => boolean,
    wait = 10000
  ): Promise<Node | undefined> => {
    for (const until = Date.now() + wait; ;) {
      const found = (await nodes()).find(test)
      if (found != null) return found
      if (Date.now() > until) return undefined
      await sleep(500)
    }
  }
  const byId = (id: string) => (node: Node) => node.id === id
  const byText = (text: string) => (node: Node) => node.text === text
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    say(`$ takeScreenshot ${name}`)
    await m.takeScreenshot({ path: path.join(artifacts, name) })
  }

  try {
    // The game's web scoreboard, as the people at the field see it.
    browser = await puppeteer.launch({ headless: true })
    const board = await browser.newPage()
    say(`$ puppeteer goto ${web}/scoreboard/${game}`)
    await board.goto(`${web}/scoreboard/${game}`, { waitUntil: 'networkidle2' })
    const boardSpeed = async (): Promise<{ lit: boolean; text: string }> =>
      await board.$eval('[data-scoreboard="pitchSpeed"]', element => ({
        lit: element.getAttribute('data-lit') === 'true',
        text: element.textContent ?? ''
      }))

    say('$ launchApp')
    await m.launchApp({ appId: APP, stopApp: true })
    if ((await find(byText('Sign in to TeamStation'), 12000)) != null) {
      const link = await signInLink()
      say('$ openLink teamstation://signin/<token>')
      await m.openLink({ link: `teamstation://signin/${link}` })
      await sleep(3000)
      if ((await find(byId('signInLinkSignIn'), 3000)) != null)
        await m.tapOn({ id: 'signInLinkSignIn' })
    }
    say(`$ openLink teamstation://games/${game}`)
    await m.openLink({ link: `teamstation://games/${game}` })
    await sleep(3000)
    await m.scrollUntilVisible({
      element: { text: 'Record video' },
      centerElement: true
    })
    say('$ tapOn Record video')
    await m.tapOn({ text: 'Record video' })
    await m.inputText({ text: angle })
    say('$ tapOn Start')
    await m.tapOn({ text: 'Start' })
    assert(
      (await find(byId('settings-button'), 20000)) != null,
      'the streaming screen opened'
    )

    // 1. Pair.
    say('$ tapOn settings-button')
    await m.tapOn({ id: 'settings-button' })
    assert((await find(byId('settings-radar-enabled'))) != null)
    say('$ tapOn settings-radar-enabled')
    await m.tapOn({ id: 'settings-radar-enabled' })
    await sleep(1500)
    say('$ tapOn settings-radar-pair')
    await m.tapOn({ id: 'settings-radar-pair' })
    assert(
      (await find(byId('pair-device-modal'))) != null,
      'Pair Device opened the picker'
    )
    const row = await find(node => RADAR_ROW.test(node.id ?? ''), 30000)
    assert(row?.id != null, 'the radar is listed')
    const serial = RADAR_ROW.exec(row.id)![1]
    await shot('pair-device-modal.png')
    say(`$ tapOn ${row.id}`)
    await m.tapOn({ id: row.id })
    for (const until = Date.now() + 5000; Date.now() < until;) {
      if ((await find(byId('pair-device-modal'), 0)) == null) break
      await sleep(500)
    }
    assert(
      (await find(byId('pair-device-modal'), 0)) == null,
      'pairing closed the picker'
    )
    const deviceRow = `settings-radar-device-${serial}`
    let rowText = ''
    for (const until = Date.now() + 30000; Date.now() < until;) {
      const found = await find(byId(deviceRow), 0)
      rowText = found == null ? '' : wordsOf(found)
      if (rowText.includes('Connected') && rowText.includes('⚡')) break
      await sleep(1000)
    }
    assert(
      rowText.includes('Connected') && rowText.includes('⚡'),
      `the radar's row reads Connected and its battery: ${rowText}`
    )
    await shot('stream-radar-card-after.png')
    results.push(`1 paired ${serial}: “${rowText}”`)

    // 2. A pitch.
    say(`>>> Throw a pitch past the radar within ${pitchSeconds} s`)
    let speed: string | undefined
    for (const until = Date.now() + pitchSeconds * 1000; Date.now() < until;) {
      const found = await find(byId(deviceRow), 0)
      speed = /· (\d+) \//.exec(found == null ? '' : wordsOf(found))?.[1]
      if (speed != null) break
      await sleep(500)
    }
    assert(speed != null, 'the row shows the pitch speed')
    const heardAt = Date.now()
    const shown = await boardSpeed()
    say(`pitch ${speed} mph; the web scoreboard reads ${JSON.stringify(shown)}`)
    // The readout sits under the sheet: Done, then read it.
    say('$ tapOn settings-done')
    await m.tapOn({ id: 'settings-done' })
    const readout = await find(byId('radar-speeds'), 5000)
    const readoutText = readout == null ? '' : wordsOf(readout)
    let cleared: number | undefined
    for (const until = heardAt + 10000; Date.now() < until;) {
      if (!(await boardSpeed()).lit) {
        cleared = (Date.now() - heardAt) / 1000
        break
      }
      await sleep(250)
    }
    assert(
      shown.lit && shown.text.includes(speed),
      'the web scoreboard shows the speed'
    )
    assert(readoutText.includes(speed), 'the overlay’s readout shows the speed')
    assert(
      cleared != null && cleared >= 4 && cleared <= 7,
      'the web scoreboard clears about 5 s later'
    )
    results.push(
      `2 pitch ${speed} mph: row, readout “${readoutText}”, web scoreboard lit; cleared after ${cleared.toFixed(1)} s`
    )

    // 3. Unpair.
    say('$ tapOn settings-button')
    await m.tapOn({ id: 'settings-button' })
    say(`$ tapOn settings-radar-unpair-${serial}`)
    await m.tapOn({ id: `settings-radar-unpair-${serial}` })
    for (const until = Date.now() + 10000; Date.now() < until;) {
      if ((await find(byId(deviceRow), 0)) == null) break
      await sleep(500)
    }
    assert((await find(byId(deviceRow), 0)) == null, 'Unpair took the row')
    results.push('3 Unpair: the row is gone')

    // 4. Nothing in range.
    say(`>>> Switch the radar off within ${offSeconds} s`)
    await sleep(offSeconds * 1000)
    say('$ tapOn settings-radar-pair')
    await m.tapOn({ id: 'settings-radar-pair' })
    assert(
      (await find(byText('No radars in range'), 15000)) != null,
      'the picker says no radars are in range'
    )
    await shot('pair-device-empty.png')
    say('$ tapOn pair-device-close')
    await m.tapOn({ id: 'pair-device-close' })
    results.push('4 Pair Device with the radar off: “No radars in range”')
  } finally {
    await browser?.close()
    await m.detach()
  }
  for (const line of results) say(`PASS ${line}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
