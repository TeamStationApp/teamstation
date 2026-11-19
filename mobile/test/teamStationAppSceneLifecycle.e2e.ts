import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { type AttachedDevice, attach, flatten } from './maestroD'
import { appLinkHost, otherServersLink } from './signInLinks'

/**
 * The TeamStation app launches through its scene on iOS, and a link reaches it however the app
 * is opened: closed or running, by the custom scheme or by a web address.
 *
 * Install a clean build, so the app is signed out, whose clientConfig.json names the app's link
 * host: `xcodebuild … -xcconfig ../clientConfig.xcconfig` (simulated entitlements on a simulator).
 *
 *   MAESTRO_D=scene-lifecycle \
 *   TS_E2E_DEVICE=<simulator or device UDID> \
 *   TS_E2E_LAYOUT=phone|tablet \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *   [MAESTRO_D_TEAM_ID=<the team that signs WebDriverAgent on a physical phone>] \
 *     node -r sucrase/register mobile/test/teamStationAppSceneLifecycle.e2e.ts
 *
 * `phone` launches three times and follows the four kinds of link, with the keyboard and a trip
 * to the background between. `tablet` takes a screenshot each way up, to read by eye.
 *
 * Each link names another server, so it is refused without being spent, on a screen unlike the
 * sign-in screen the test starts from. Reaching that screen is what proves the link arrived.
 */

const APP_ID = 'app.teamstation.app'
const LINK_HOST = appLinkHost(path.join(__dirname, '..', '..', 'clientConfig.json'))
const SIGN_IN = 'Sign in to TeamStation'
const REFUSED = 'This link is for another server'
const WEB_LINK = otherServersLink(`https://${LINK_HOST}/signin/x`)
const SCHEME_LINK = WEB_LINK.replace(`https://${LINK_HOST}/`, 'teamstation://')
const TYPED = 'scene@example.com'

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

async function signInScreen(m: AttachedDevice): Promise<void> {
  await m.launchApp({ appId: APP_ID, stopApp: true })
  await m.extendedWaitUntil({ visible: { text: SIGN_IN }, timeout: 30000 })
}

/**
 * Opens the custom-scheme link. A physical phone can hold other TeamStation builds, and iOS gives
 * a scheme to whichever it likes, so there the link is addressed to this build by its bundle id.
 */
async function openSchemeLink(m: AttachedDevice): Promise<void> {
  const team = process.env.MAESTRO_D_TEAM_ID
  if (team == null || team === '') {
    await m.openLink({ link: SCHEME_LINK })
    return
  }
  execFileSync('xcrun', [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    required('TS_E2E_DEVICE'),
    '--payload-url',
    SCHEME_LINK,
    APP_ID
  ])
}

/** Waits for the refusal of a link just opened, answering iOS's `Open` prompt when it asks. */
async function refused(m: AttachedDevice): Promise<void> {
  await m.tapOn({ text: 'Open', optional: true, timeout: 3000 })
  await m.extendedWaitUntil({ visible: { text: REFUSED }, timeout: 30000 })
}

/**
 * Waits for the keyboard the tap brought up. `tapOn` returns as the field takes focus, and a
 * keystroke sent while the keyboard is still coming up is dropped.
 */
async function keyboardUp(m: AttachedDevice): Promise<void> {
  const end = Date.now() + 10000
  while (!flatten(await m.hierarchy()).some(node => /Keyboard$/.test(node.type ?? ''))) {
    if (Date.now() > end) throw new Error('The keyboard did not come up')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const PLACEHOLDER = 'parent@example.com'

/**
 * Types `TYPED` into the e-mail field a character at a time. On a physical phone a burst of
 * automated keystrokes outruns the field and lands out of order, with or without the scene
 * lifecycle. A simulator can still lose a keystroke while the keyboard settles, so the field is
 * checked, and emptied with its clear button and typed again when it does not hold `TYPED`, up
 * to three times. Typing is not what this test is about; the field keeping it through the
 * background is.
 */
async function typeOnSignInScreen(m: AttachedDevice): Promise<void> {
  await signInScreen(m)
  await m.tapOn({ text: PLACEHOLDER })
  await keyboardUp(m)
  for (let attempt = 1; ; attempt++) {
    for (const character of TYPED) await m.inputText({ text: character })
    try {
      await m.assertVisible({ text: TYPED, timeout: 3000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
    console.log(`typing attempt ${attempt} dropped a keystroke; clearing and typing again`)
    await m.tapOn({ id: 'Clear E-mail address' })
    await m.tapOn({ text: PLACEHOLDER })
    await keyboardUp(m)
  }
}

async function phone(m: AttachedDevice): Promise<void> {
  for (let launch = 1; launch <= 3; launch++) {
    await signInScreen(m)
    console.log(`launch ${launch}: ${SIGN_IN}`)
  }
  await m.shot('first-screen')

  await m.stopApp()
  await openSchemeLink(m)
  await refused(m)
  console.log('cold custom-scheme link: refused')

  await signInScreen(m)
  await openSchemeLink(m)
  await refused(m)
  console.log('running custom-scheme link: refused')

  await m.stopApp()
  await m.openLink({ link: WEB_LINK })
  await refused(m)
  console.log('cold web link: refused')

  await signInScreen(m)
  await m.openLink({ link: WEB_LINK })
  await refused(m)
  console.log('running web link: refused')

  await typeOnSignInScreen(m)
  await m.pressKey({ key: 'Home' })
  await m.launchApp({
    appId: APP_ID,
    stopApp: false,
    permissions: { all: 'unset' }
  })
  await m.assertVisible({ text: TYPED })
  console.log('keyboard and background: kept')
}

async function tablet(m: AttachedDevice): Promise<void> {
  await signInScreen(m)
  await m.setOrientation({ orientation: 'LANDSCAPE_LEFT' })
  await m.assertVisible({ text: SIGN_IN })
  await m.shot('ipad-landscape')
  await m.setOrientation({ orientation: 'PORTRAIT' })
  await m.assertVisible({ text: SIGN_IN })
  await m.shot('ipad-portrait')
}

async function main(): Promise<void> {
  const layout = required('TS_E2E_LAYOUT')
  if (layout !== 'phone' && layout !== 'tablet') {
    throw new Error('TS_E2E_LAYOUT is phone or tablet')
  }
  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: required('TS_E2E_DEVICE'),
    appId: APP_ID
  })
  try {
    await (layout === 'phone' ? phone(m) : tablet(m))
    console.log(`${layout}: passed`)
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
