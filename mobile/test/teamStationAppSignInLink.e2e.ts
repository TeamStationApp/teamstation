import path from 'node:path'

import { attach } from './maestroD'
import {
  appLinkHost,
  claimAppLinks,
  mailedLink,
  newestMail,
  otherServersLink
} from './signInLinks'

/**
 * The TeamStation app signs in from the link in its sign-in e-mail, on iOS (E5) or Android (E6).
 *
 * Install a clean build whose clientConfig.json names the app's link host and whose
 * TS_API_BASE_URL is the seat: a Mason build (`create-build`), or locally on iOS
 * `xcodebuild … -xcconfig ../clientConfig.xcconfig` (simulated entitlements on a simulator).
 * On Android a locally signed build cannot verify its link host; run it with
 * APP_LINKS_USER_SELECTION=1 to approve the host by user selection instead.
 *
 *   MAESTRO_D=sign-in-link-app \
 *   TS_E2E_PLATFORM=ios|android \
 *   TS_E2E_DEVICE=<simulator or device UDID, or adb serial> \
 *   TS_E2E_EMAIL=<an address whose mail the command below can read> \
 *   SEAT_MAIL_LINK=<command: `newest <email>` / `after <email> <id>`, as for Director's> \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/test/teamStationAppSignInLink.e2e.ts
 *
 * Signed out, a link naming another server is refused without being spent, and the app says
 * whose it is. Then the app asks for a code with its link host, the operating system hands it
 * the mailed link, and it signs in.
 */

const APP_ID = 'app.teamstation.app'
const LINK_HOST = appLinkHost(path.join(__dirname, '..', '..', 'clientConfig.json'))

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

async function main(): Promise<void> {
  const platform = required('TS_E2E_PLATFORM')
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('TS_E2E_PLATFORM is ios or android')
  }
  const device = required('TS_E2E_DEVICE')
  const email = required('TS_E2E_EMAIL')
  if (platform === 'android') claimAppLinks(device, APP_ID, LINK_HOST)

  const m = await attach({
    daemon: required('MAESTRO_D'),
    device,
    appId: APP_ID
  })
  try {
    // Signed out: a clean install, or Android's cleared state. The link screen draws only
    // signed out, so the refusal comes first.
    await m.launchApp({
      appId: APP_ID,
      stopApp: true,
      clearState: platform === 'android'
    })
    await m.extendedWaitUntil({
      visible: { text: 'Sign in to TeamStation' },
      timeout: 30000
    })
    const elsewhere = otherServersLink(`https://${LINK_HOST}/signin/x?server=x`)
    await m.openLink({ link: elsewhere })
    await m.extendedWaitUntil({
      visible: { text: 'This link is for another server' },
      timeout: 30000
    })
    await m.assertVisible({
      text: 'This link is for https://other.example.test.*'
    })
    await m.shot(`rn-${platform}-wrong-server`)
    // The shell's header also reads "Sign in": the card's button is tapped by its id.
    await m.tapOn({ id: 'signInLinkSignIn' })

    await m.extendedWaitUntil({
      visible: { text: 'Sign in to TeamStation' },
      timeout: 30000
    })
    const before = newestMail(email)
    await m.tapOn({ text: 'parent@example.com' })
    await m.inputText({ text: email })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Send me a sign-in code' })
    await m.extendedWaitUntil({ visible: { text: '123456' }, timeout: 30000 })
    const link = mailedLink(email, before, LINK_HOST)

    await m.openLink({ link })
    await m.extendedWaitUntil({
      notVisible: { text: 'Signing you in…' },
      timeout: 30000
    })
    await m.assertNotVisible({ text: 'Sign in to TeamStation' })
    await m.assertNotVisible({ text: 'This link is for another server' })
    await m.assertNotVisible({ text: 'Couldn’t sign you in' })
    await m.shot(`rn-${platform}-link-after`)
    console.log('refused another server’s link, and signed in from its own')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
