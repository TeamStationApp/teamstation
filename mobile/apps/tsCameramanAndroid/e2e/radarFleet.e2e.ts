import { execFileSync } from 'node:child_process'

import { attach, type AttachedDevice } from '../../../test/maestroD'

/**
 * TS Cameraman on Android pairs a TAG One through the radar fleet and lets it go again (E5).
 *
 * Build and install the release build (`./gradlew :app:assembleRelease`), switch a TAG One on in
 * range, then:
 *
 *   MAESTRO_D=radar-fleet-cameraman-android \
 *   TS_STREAM_ANDROID_SERIAL=<adb serial> \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/apps/tsCameramanAndroid/e2e/radarFleet.e2e.ts
 *
 * The camera broadcasts, Settings turns the radar on, pairs the first radar in range, waits for
 * Connected, then unpairs it and checks the serial is gone.
 */

const APP_ID = 'app.teamstation.cameraman'
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

/** Whether `selector` shows up within `timeout`, without failing the run when it does not. */
async function shows(m: AttachedDevice, selector: Record<string, unknown>, timeout = 3000): Promise<boolean> {
  try {
    await m.extendedWaitUntil({ visible: selector, timeout })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const serial = required('TS_STREAM_ANDROID_SERIAL')
  // Granted up front: the permission dialogs are not what this test is about.
  for (const permission of PERMISSIONS) {
    try {
      execFileSync('adb', ['-s', serial, 'shell', 'pm', 'grant', APP_ID, `android.permission.${permission}`])
    } catch {
      // Not requested on this Android version.
    }
  }

  const m = await attach({ daemon: required('MAESTRO_D'), device: serial, appId: APP_ID })
  try {
    await m.launchApp({ appId: APP_ID, clearState: false, stopApp: true })
    await m.extendedWaitUntil({ visible: { id: 'broadcast-button' }, timeout: 30000 })
    await m.tapOn({ id: 'broadcast-button' })
    await m.extendedWaitUntil({ visible: { id: 'broadcasting-pill' }, timeout: 30000 })

    await m.tapOn({ id: 'settings-button' })
    await m.scrollUntilVisible({ element: { id: 'settings-radar-enabled' }, direction: 'DOWN', timeout: 10000 })
    if (await shows(m, { id: 'settings-radar-enabled', checked: false }, 1000)) {
      await m.tapOn({ id: 'settings-radar-enabled' })
    }
    if (await shows(m, { id: 'settings-radar-unpair' })) {
      await m.tapOn({ id: 'settings-radar-unpair' })
    }
    await m.tapOn({ id: 'settings-radar-pair' })
    await m.extendedWaitUntil({ visible: { id: 'settings-radar-option-ADFA.*' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-radar-option-ADFA.*' })
    await m.extendedWaitUntil({ visible: { id: 'settings-radar-status', text: 'Connected' }, timeout: 60000 })
    await m.shot('cameraman-android-radar-connected')

    await m.tapOn({ id: 'settings-radar-unpair' })
    await m.assertNotVisible({ id: 'settings-radar-serial' })
    await m.assertVisible({ id: 'settings-radar-pair' })
    await m.shot('cameraman-android-radar-unpaired')
    await m.tapOn({ id: 'settings-done' })
    console.log('the radar paired through the fleet, connected, and unpaired')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
