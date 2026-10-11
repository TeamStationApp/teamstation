import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { attach } from '../../../test/maestroD'
import { appLinkHost, claimAppLinks, mailedLink, newestMail, otherServersLink } from '../../../test/signInLinks'

/**
 * TS Cameraman on Android signs in from the link in its sign-in e-mail (E9).
 *
 * Install a Mason build (`create-build`, target app.teamstation.cameraman android) pointed at the
 * seat: its key is the one in assetlinks.json, so Android verifies the link host. A local build is
 * signed by this machine's debug key, which cannot verify; run it with APP_LINKS_USER_SELECTION=1
 * to approve the host for it by user selection instead.
 *
 *   MAESTRO_D=sign-in-link-cameraman-android \
 *   CAMERAMAN_ANDROID_SERIAL=<adb serial> [CAMERAMAN_APK=<apk to install>] \
 *   TS_E2E_EMAIL=<an address whose mail the command below can read> \
 *   SEAT_MAIL_LINK=<command: `newest <email>` / `after <email> <id>`, as for Director's> \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/apps/tsCameramanAndroid/e2e/signInLink.e2e.ts
 *
 * Cameraman asks for the code with its link host, Android hands it the mailed link, and the
 * camera screen says it signed in. Then a link naming another server is refused without being
 * spent, and the camera screen says whose it is.
 */

const APP_ID = 'app.teamstation.cameraman'
const LINK_HOST = appLinkHost(path.join(__dirname, '..', 'clientConfig.json'))
const PERMISSIONS = [
  'CAMERA',
  'RECORD_AUDIO',
  'POST_NOTIFICATIONS',
  'BLUETOOTH_SCAN',
  'BLUETOOTH_CONNECT',
  'ACCESS_FINE_LOCATION',
  'ACCESS_COARSE_LOCATION'
]

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

async function main(): Promise<void> {
  const serial = required('CAMERAMAN_ANDROID_SERIAL')
  const email = required('TS_E2E_EMAIL')
  const apk = process.env.CAMERAMAN_APK
  if (apk != null && apk !== '') execFileSync('adb', ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' })
  // Granted up front: the permission dialogs are not what this test is about.
  for (const permission of PERMISSIONS) {
    try {
      execFileSync('adb', ['-s', serial, 'shell', 'pm', 'grant', APP_ID, `android.permission.${permission}`])
    } catch {
      // Not requested on this Android version.
    }
  }
  claimAppLinks(serial, APP_ID, LINK_HOST)

  const m = await attach({ daemon: required('MAESTRO_D'), device: serial, appId: APP_ID })
  try {
    await m.launchApp({ appId: APP_ID, clearState: false, stopApp: true })
    await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-button' })
    await m.scrollUntilVisible({ element: { id: 'settings-teamstation' }, direction: 'DOWN', timeout: 10000 })
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
    await m.shot('cameraman-android-link-after')

    await m.openLink({ link: otherServersLink(link) })
    await m.extendedWaitUntil({
      visible: { id: 'sign-in-link-message', text: 'This link is for https://other.example.test.*' },
      timeout: 30000
    })
    await m.shot('cameraman-android-wrong-server')
    console.log('signed in from the link, and refused another server’s')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
