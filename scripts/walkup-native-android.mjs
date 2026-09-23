// E21 and E22 on an Android phone, through maestro-d's JavaScript library.
//
// Required: WALKUP_DEVICE_UDID (an adb serial), MAESTRO_D (this agent's own
// daemon; run `maestro-d ps` first), WALKUP_ARTIFACT_DIR. Optional:
// WALKUP_SERVER_LOG, the API's log, to check the WalkUpMusicState lines that
// reached /api/v1/logs; MAESTRO_D_CLIENT_ROOT, a checkout of the maestro-d
// npm package when it is not installed.
//
// The app must be signed in as S, T's songkeeper, with player C (Tom A)
// holding no song or a song this script may remove, and player B (Blake B)
// holding an Apple Music song. The phone must be unlocked. Real phones only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const client = process.env.MAESTRO_D_CLIENT_ROOT
  ? createRequire(
      join(resolve(process.env.MAESTRO_D_CLIENT_ROOT), 'package.json')
    )
  : require
const { MaestroD } = client('maestro-d')
const required = key => {
  assert(process.env[key], `${key} is required`)
  return process.env[key]
}
const device = required('WALKUP_DEVICE_UDID')
const artifacts = resolve(required('WALKUP_ARTIFACT_DIR'))
const serverLog = process.env.WALKUP_SERVER_LOG
const fixture = resolve('src2/test/fixtures/walkup-fixture.mp3')
const appId = 'co.gamestation.app'
const permission = 'android.permission.READ_MEDIA_AUDIO'

const adb = (...args) =>
  execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const daemon = await MaestroD.connect({
  name: required('MAESTRO_D'),
  spawn: false
})
const m = await daemon.attach({
  device,
  platform: 'android',
  appId,
  artifacts: 'on-failure'
})
await mkdir(artifacts, { recursive: true })

let serial = 0
const shot = async label => {
  const stem = join(artifacts, `${String(++serial).padStart(2, '0')}-${label}`)
  await writeFile(`${stem}.png`, await m.screenshot())
  console.log(`Captured ${label}`)
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)]
const nodes = async () => flatten(await m.hierarchy())
const texts = async () =>
  (await nodes()).filter(node => node.text).map(node => node.text)
/** Taps the centre of the first node that matches, exactly. */
async function tap(match, settle = 1200) {
  // The next screen can take a moment to draw: look for up to 10 s.
  let found
  for (let tries = 0; tries < 20 && found == null; tries++) {
    found = (await nodes()).find(match)
    if (found == null) await sleep(500)
  }
  assert(found?.bounds, `Nothing to tap: ${match}`)
  const b = found.bounds
  await m.tapOn({
    point: `${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`
  })
  await sleep(settle)
}
const button = label =>
  tap(node => node.type === 'Button' && node.text === label)
const exact = label => tap(node => node.text === label)
async function expectText(text, timeout = 10000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if ((await texts()).includes(text)) return
    await sleep(500)
  }
  assert.fail(`Expected "${text}" on screen`)
}
const readout = async id =>
  (await nodes()).find(node => node.id === `walkup-${id}`)?.text
const walkUpLog = () =>
  adb('logcat', '-d', '-s', 'WalkUpMusic:I')
    .split('\n')
    .filter(line => line.includes('WalkUpMusicState'))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))))

async function openPlayer(name) {
  await tap(node => node.type === 'Button' && node.text === 'Tigers')
  await tap(node => node.type === 'View' && node.text === 'Team')
  await m.scrollUntilVisible({
    element: { text: `${name}.*` },
    direction: 'DOWN'
  })
  await tap(
    node => node.type === 'Button' && (node.text ?? '').startsWith(name)
  )
  await tap(node => node.type === 'View' && node.text === 'Walk-up', 2500)
}

try {
  // The fixture, in the phone's music, and no permission yet. Maestro's
  // launchApp grants every permission, so the app is started by adb.
  adb('push', fixture, '/sdcard/Music/walkup-fixture.mp3')
  adb(
    'shell',
    'content call --method scan_volume --uri content://media --arg external_primary'
  )
  adb('shell', 'am', 'force-stop', appId)
  adb('shell', 'pm', 'revoke', appId, permission)
  adb(
    'shell',
    'pm',
    'clear-permission-flags',
    appId,
    permission,
    'user-set',
    'user-fixed'
  )
  adb('logcat', '-c')
  adb(
    'shell',
    'monkey',
    '-p',
    appId,
    '-c',
    'android.intent.category.LAUNCHER',
    '1'
  )
  await sleep(6000)
  const serverStart = serverLog ? (await readFile(serverLog)).length : 0

  // E21: C → Set, refused, then allowed from Settings.
  await openPlayer('Tom A')
  if ((await texts()).includes('Remove')) {
    await button('Remove')
    await button('Tap again to remove')
  }
  await expectText('No walk-up song yet')
  await shot('e21-no-song')
  await button('Set')
  await expectText(
    'Allow GameStation to access music and audio on this device?'
  )
  await shot('e21-permission')
  await button('Don’t allow')
  await expectText('GameStation can’t see your music')
  await shot('e21-denied')
  await button('Open Settings')
  await m.tapOn({ text: 'Permissions' })
  await m.tapOn({ text: 'Music and audio' })
  await m.tapOn({ text: 'Allow' })
  await sleep(1000)
  await m.back()
  await m.back()
  await m.back()
  await expectText('Music on this phone')
  await shot('e21-allowed')

  // Search, clip 0:05–0:20, Preview, Save.
  await m.tapOn({ text: 'Music on this phone' })
  await m.inputText({ text: 'walkup fixture' })
  await m.hideKeyboard()
  await expectText('On this phone')
  await shot('e21-results')
  await tap(
    node =>
      node.type === 'Button' &&
      (node.text ?? '').startsWith('GS Walkup Fixture')
  )
  for (let i = 0; i < 5; i++) await button('Start 1 s later')
  for (let i = 0; i < 5; i++) await button('End 1 s later')
  assert.equal(await readout('start'), '0:05.0')
  assert.equal(await readout('end'), '0:20.0')
  adb('logcat', '-c')
  await button('Preview')
  await sleep(2500)
  await shot('e21-previewing')
  await sleep(15000)
  const states = walkUpLog()
  const playing = states.filter(state => state.kind === 'playing')
  assert(playing.length > 20, 'Expected playing reports')
  assert(Math.abs(playing[0].positionMs - 5000) < 500, 'Starts near 5 s')
  assert.equal(playing[0].volume, 0, 'Fades in from silence')
  assert(
    playing.some(state => state.volume === 1),
    'Reaches full level'
  )
  const idle = states.find(state => state.kind === 'idle')
  assert(idle, 'Stops on its own')
  assert(playing.at(-1).positionMs > 19000, 'Plays to near 20 s')
  assert(playing.at(-1).positionMs < 20300, 'Stops by 20 s')
  assert(idle.lowestLevel < 0.05, 'Fades out')
  await writeFile(
    join(artifacts, 'e21-preview-states.json'),
    JSON.stringify(states, null, 1)
  )
  await button('Save')
  await expectText('Plays 0:05–0:20')
  await shot('e21-saved')

  // Then Choose a file…, through the system picker.
  await button('Change')
  await button('Pick another song')
  await button('Choose a file…')
  await sleep(2500)
  for (let i = 0; i < 3 && !(await texts()).includes('Pixel 10'); i++) {
    await tap(node => node.text === 'Show roots')
  }
  // The phone's own storage, which DocumentsUI always lists; its Audio root
  // comes and goes.
  await exact('Pixel 10')
  await exact('Music')
  await tap(node => node.text === 'walkup-fixture.mp3', 3000)
  await expectText('GS Walkup Fixture')
  for (let i = 0; i < 10; i++) await button('Start 1 s later')
  for (let i = 0; i < 10; i++) await button('End 1 s later')
  await button('Save')
  await expectText('Plays 0:10–0:25')
  await shot('e21-file-saved')

  // E22: B's Apple Music song is not on this phone.
  await button('Back')
  await m.scrollUntilVisible({
    element: { text: 'Blake B.*' },
    direction: 'UP'
  })
  await tap(
    node => node.type === 'Button' && (node.text ?? '').startsWith('Blake B')
  )
  await tap(node => node.type === 'View' && node.text === 'Walk-up', 4000)
  await expectText('Not on this phone')
  adb('logcat', '-c')
  await button('Preview: Not on this phone')
  assert.equal(walkUpLog().length, 0, 'A disabled Preview plays nothing')
  await shot('e22-not-here')

  if (serverLog != null) {
    const lines = (await readFile(serverLog))
      .subarray(serverStart)
      .toString('utf8')
      .split('\n')
      .filter(line => line.includes('[client walkUpMusic-android]'))
    assert(lines.length > 20, 'The reports reached /api/v1/logs')
    await writeFile(join(artifacts, 'server-walkup.log'), lines.join('\n'))
  }
  console.log('E21 and E22 passed')
} catch (error) {
  await shot('failure').catch(() => undefined)
  throw error
}
