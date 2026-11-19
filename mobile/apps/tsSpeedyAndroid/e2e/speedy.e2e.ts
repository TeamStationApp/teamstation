import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach } from '../../../test/maestroD'
import { APP_ID, required, runScenarios } from '../../../test/speedy'

/**
 * TS Speedy on Android: the readout, the voice, the audio switch, Settings and portrait (A1–A6).
 *
 * Install a build first (`SPEEDY_ANDROID_SERIAL=<serial> bash scripts/build.sh`), then:
 *
 *   MAESTRO_D=speedy-android SPEEDY_ANDROID_SERIAL=<serial> E2E_ARTIFACT_DIR=<dir> \
 *     node -r sucrase/register mobile/apps/tsSpeedyAndroid/e2e/speedy.e2e.ts
 *
 * Before the first launch the radar's four permissions are granted, and Bluetooth and Location
 * are turned on; both are put back as they were at the end. After
 * A3b the app's own speech, as its player played it, is pulled from the debug build to
 * `<E2E_ARTIFACT_DIR>/android-voice-e3.wav`.
 */

const PERMISSIONS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION'
]

async function main(): Promise<void> {
  const serial = required('SPEEDY_ANDROID_SERIAL')
  const adb = (...args: string[]): string => {
    console.log(`$ adb -s <serial> ${args.join(' ')}`)
    return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim()
  }

  for (const permission of PERMISSIONS) adb('shell', 'pm', 'grant', APP_ID, permission)
  const bluetoothWas = adb('shell', 'settings', 'get', 'global', 'bluetooth_on')
  const locationWas = adb('shell', 'cmd', 'location', 'is-location-enabled')
  adb('shell', 'svc', 'bluetooth', 'enable')
  adb('shell', 'cmd', 'location', 'set-location-enabled', 'true')

  const m = await attach({ daemon: required('MAESTRO_D'), device: serial, appId: APP_ID })
  try {
    await runScenarios(
      m,
      {
        launch: async () => {
          await m.launchApp({ appId: APP_ID, stopApp: true, arguments: { uiTest: 'true' } })
        },
        unpairedStatus: 'No radar paired',
        canPair: true,
        afterVoice: async () => {
          const out = join(m.artifactDir, 'android-voice-e3.wav')
          console.log(`$ adb -s <serial> exec-out run-as ${APP_ID} cat files/speech-capture.wav > ${out}`)
          writeFileSync(out, execFileSync('adb', ['-s', serial, 'exec-out', 'run-as', APP_ID, 'cat', 'files/speech-capture.wav']))
        }
      },
      'android'
    )
  } finally {
    await m.detach().catch(() => {})
    if (bluetoothWas === '0') adb('shell', 'svc', 'bluetooth', 'disable')
    if (locationWas === 'false') adb('shell', 'cmd', 'location', 'set-location-enabled', 'false')
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
