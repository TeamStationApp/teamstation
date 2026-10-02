// The iPhone's walk-up checks, through maestro-d's JavaScript library.
//
// Required: WALKUP_DEVICE_UDID, MAESTRO_D (this agent's own daemon; run
// `maestro-d ps` first), WALKUP_ARTIFACT_DIR. WALKUP_AS is `songkeeper`
// (signed in as S, the default) or `member` (signed in as M, for E23).
// Optional: MAESTRO_D_CLIENT_ROOT, a checkout of the maestro-d npm package.
//
// As S it checks the Account screen's fade switch (it persists across a
// relaunch and is left on), then opens B's song for Change, picks another
// song and searches Apple Music. With Apple Music on the phone that search
// lists songs with the `Apple Music` badge and E19/E20 follow by hand;
// without it — no subscription, or no MusicKit service on the App ID — the
// picker must show Apple's error and Retry, not crash, and that is recorded
// as pending. As M it is E23: B's page has no Walk-up tab.
//
// Taps go straight to WebDriverAgent in viewport points, because the iOS
// driver reads the 13 Pro as landscape and misplaces its own point taps.
import assert from 'node:assert/strict'
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
const as = process.env.WALKUP_AS ?? 'songkeeper'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const daemon = await MaestroD.connect({
  name: required('MAESTRO_D'),
  spawn: false
})
const m = await daemon.attach({
  device,
  platform: 'ios',
  appId: 'app.teamstation.app',
  artifacts: 'on-failure'
})
await mkdir(artifacts, { recursive: true })

const driverLog = await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
const port = driverLog
  .split('\n')
  .filter(s => s.includes(`Starting WDA on device ${device} (port:`))
  .at(-1)
  ?.match(/\(port: (\d+)\)/)?.[1]
assert(port, 'Cannot find this device’s WDA port in the daemon log')
const wda = `http://127.0.0.1:${port}`
async function request(path, body) {
  const script =
    body == null
      ? `http.get(${JSON.stringify(wda + path)})`
      : `http.post(${JSON.stringify(wda + path)}, {body:${JSON.stringify(body)}})`
  const result = await m.eval(script)
  assert.equal(result.status, 200, result.body)
  return JSON.parse(result.body)
}
const session = (await request('/status')).sessionId

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
async function tap(match, settle = 2000) {
  // The next screen can take a moment to draw: look for up to 10 s.
  let found
  for (let tries = 0; tries < 20 && found == null; tries++) {
    found = (await nodes()).find(match)
    if (found == null) await sleep(500)
  }
  assert(found?.bounds, `Nothing to tap: ${match}`)
  const { x, y, width, height } = found.bounds
  await request(`/session/${session}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'walkup-finger',
        parameters: { pointerType: 'touch' },
        actions: [
          {
            type: 'pointerMove',
            duration: 0,
            x: Math.round(x + width / 2),
            y: Math.round(y + height / 2),
            origin: 'viewport'
          },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerUp', button: 0 }
        ]
      }
    ]
  })
  await sleep(settle)
}
const button = label =>
  tap(node => node.type === 'Button' && node.text === label)
/** The Home tab, pressed until the home screen shows: a relaunch reopens
 * the page it was left on. */
async function goHome() {
  for (let i = 0; i < 4 && !(await texts()).includes('Your Home'); i++) {
    await tap(node => node.type === 'Other' && node.text === 'Home')
  }
  assert((await texts()).includes('Your Home'), 'Home is showing')
}
async function openB() {
  await goHome()
  await tap(node => node.type === 'Button' && node.text === 'Tigers')
  await tap(node => node.text === 'Team')
  await tap(
    node => node.type === 'Button' && (node.text ?? '').startsWith('Blake B'),
    3500
  )
}
async function openAccount() {
  await goHome()
  await tap(
    node => node.type === 'Button' && (node.text ?? '').startsWith('Account,')
  )
  await m.scrollUntilVisible({
    element: { text: 'Sign out' },
    direction: 'DOWN'
  })
}
const fadeSwitch = async () =>
  (await nodes()).find(
    node =>
      node.type === 'Switch' &&
      node.text === 'Fade Apple Music using the phone’s volume'
  )

try {
  await m.launchApp({ stopApp: true })
  await sleep(5000)

  if (as === 'member') {
    await openB()
    const shown = await texts()
    assert(shown.includes('Stats'), 'B’s page is open')
    assert(!shown.includes('Walk-up'), 'M has no Walk-up tab')
    await shot('e23-no-walkup-tab')
    console.log('E23 passed')
  } else {
    // The fade setting: iPhone only, on by default, kept across a launch.
    await openAccount()
    assert(await fadeSwitch(), 'The Walk-up songs switch is on the iPhone')
    await shot('account-fade-switch')
    await tap(
      node =>
        node.type === 'Switch' &&
        node.text === 'Fade Apple Music using the phone’s volume'
    )
    await shot('account-fade-flipped')
    await m.launchApp({ stopApp: true })
    await sleep(5000)
    await openAccount()
    await shot('account-fade-after-relaunch')
    await tap(
      node =>
        node.type === 'Switch' &&
        node.text === 'Fade Apple Music using the phone’s volume'
    )
    await shot('account-fade-back')

    // The picker, on Apple Music.
    await m.launchApp({ stopApp: true })
    await sleep(5000)
    await openB()
    await tap(node => node.text === 'Walk-up', 4000)
    await shot('b-walkup')
    const change = (await texts()).includes('Change') ? 'Change' : 'Set'
    await button(change)
    if (change === 'Change') await button('Pick another song')
    const shown = await texts()
    if (!shown.includes('SEARCH')) {
      await shot('access')
      assert.fail(`Music access is not granted: ${shown.join(' / ')}`)
    }
    await tap(node => node.type === 'TextField' && node.text === 'Search', 800)
    await m.inputText({ text: 'centerfield' })
    await sleep(6000)
    await shot('search-centerfield')
    const after = await texts()
    if (after.includes('Apple Music')) {
      console.log('Apple Music answered: continue E19 and E20 by hand')
    } else {
      assert(after.includes('Retry'), 'A failed search offers Retry')
      const said = (await nodes()).find(
        node =>
          node.type === 'StaticText' &&
          node.text !== 'SEARCH' &&
          !node.text.startsWith('Playing music') &&
          !node.text.startsWith('Walk-up song for')
      )
      console.log(`E19/E20 pending (Apple Music): "${said?.text}"`)
    }
  }
} catch (error) {
  await shot('failure').catch(() => undefined)
  throw error
}
