import path from 'node:path'

import { attach } from '../../../test/maestroD'
import { appLinkHost, mailedLink, newestMail, otherServersLink } from '../../../test/signInLinks'

/**
 * TS Cameraman on iOS signs in from the link in its sign-in e-mail (E8).
 *
 * Install a clean build whose clientConfig.json names Cameraman's link host, pointed at the seat
 * and signed so its Associated Domains are in it (`SIM_SIGNING=YES` for a simulator):
 *
 *   TS_PRIMARY_HOST=<SEAT_HOST> SIM_SIGNING=YES ./scripts/build-sim.sh   (or build-device.sh)
 *
 * Then:
 *
 *   MAESTRO_D=sign-in-link-cameraman \
 *   CAMERAMAN_DEVICE_UDID=<udid> \
 *   TS_E2E_EMAIL=<an address whose mail the command below can read> \
 *   SEAT_MAIL_LINK=<command: `newest <email>` prints the newest sign-in mail's id,
 *                   `after <email> <id>` waits for a newer one and prints its link> \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/apps/tsCameraman/e2e/signInLink.e2e.ts
 *
 * Cameraman asks for the code with its link host, the operating system hands it the mailed link,
 * and the camera screen says it signed in. Then a link naming another server is refused without
 * being spent, and the camera screen says whose it is.
 */

const APP_ID = 'app.teamstation.cameraman'
const LINK_HOST = appLinkHost(path.join(__dirname, '..', 'clientConfig.json'))

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

async function main(): Promise<void> {
  const email = required('TS_E2E_EMAIL')
  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: process.env.CAMERAMAN_DEVICE_UDID,
    appId: APP_ID
  })
  try {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    // A clean install asks for the camera, then the microphone.
    for (let i = 0; i < 2; i++) await m.tapOn({ text: 'Allow', optional: true, timeout: 5000 })
    await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-button' })
    await m.extendedWaitUntil({ visible: { id: 'scoreboard-login-row' }, timeout: 20000 })
    await m.tapOn({ id: 'scoreboard-login-row' })

    const before = newestMail(email)
    await m.tapOn({ id: 'scoreboard-email' })
    await m.inputText({ text: email })
    await m.hideKeyboard()
    await m.tapOn({ id: 'scoreboard-send-code' })
    await m.extendedWaitUntil({ visible: { id: 'scoreboard-code' }, timeout: 30000 })
    const link = mailedLink(email, before, LINK_HOST)
    await m.tapOn({ id: 'teamstation-cancel' })
    await m.tapOn({ id: 'settings-done' })

    await m.openLink({ link })
    await m.extendedWaitUntil({
      visible: { id: 'sign-in-link-message', text: 'Signed in to TeamStation as .*' },
      timeout: 30000
    })
    await m.shot('cameraman-ios-link-after')

    await m.openLink({ link: otherServersLink(link) })
    await m.extendedWaitUntil({
      visible: { id: 'sign-in-link-message', text: 'This link is for https://other.example.test.*' },
      timeout: 30000
    })
    await m.shot('cameraman-ios-wrong-server')
    console.log('signed in from the link, and refused another server’s')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
