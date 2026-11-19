import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach } from '../../../test/maestroD'
import {
  APP_ID,
  checkVoice,
  keepAwake,
  required,
  runScenarios,
  type SpeedyHooks
} from '../../../test/speedy'

/**
 * TS Speedy on Android: the readout, the voice, the audio switch, Settings and portrait (A1–A6).
 *
 * Install a build first (`SPEEDY_ANDROID_SERIAL=<serial> bash scripts/build.sh`), then:
 *
 *   MAESTRO_D=speedy-android SPEEDY_ANDROID_SERIAL=<serial> E2E_ARTIFACT_DIR=<dir> \
 *     node -r sucrase/register mobile/apps/tsSpeedyAndroid/e2e/speedy.e2e.ts
 *
 * Before the first launch the radar's four permissions are granted, and Bluetooth and Location
 * are turned on; both are put back as they were at the end.
 *
 * SPEEDY_KEEP_AWAKE=1 also checks the screen stays on: "stay awake while charging" is turned off and
 * the screen timeout set to 15 s, the readout watched for 30 s while `dumpsys power` must still say
 * Awake, then both settings are put back. After
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
    return execFileSync('adb', ['-s', serial, ...args], {
      encoding: 'utf8'
    }).trim()
  }

  for (const permission of PERMISSIONS)
    adb('shell', 'pm', 'grant', APP_ID, permission)
  const bluetoothWas = adb('shell', 'settings', 'get', 'global', 'bluetooth_on')
  const locationWas = adb('shell', 'cmd', 'location', 'is-location-enabled')
  adb('shell', 'svc', 'bluetooth', 'enable')
  adb('shell', 'cmd', 'location', 'set-location-enabled', 'true')

  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: serial,
    appId: APP_ID
  })
  const hooks: SpeedyHooks = {
    launch: async () => {
      await m.launchApp({
        appId: APP_ID,
        stopApp: true,
        arguments: { uiTest: 'true' }
      })
    },
    unpairedStatus: 'No radar paired',
    canPair: true,
    afterVoice: async () => {
      const out = join(m.artifactDir, 'android-voice-e3.wav')
      console.log(
        `$ adb -s <serial> exec-out run-as ${APP_ID} cat files/speech-capture.wav > ${out}`
      )
      // run-as reads only a debuggable install. On a release build it prints its refusal and
      // still exits 0: that, and only that, skips the check. Any other answer that is not a WAV
      // (no capture written, because no phrase ever finished) fails the run.
      const capture = execFileSync(
        'adb',
        [
          '-s',
          serial,
          'exec-out',
          'run-as',
          APP_ID,
          'cat',
          'files/speech-capture.wav'
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const answer = capture.subarray(0, 200).toString('utf8').trim()
      if (capture.subarray(0, 4).toString('ascii') !== 'RIFF') {
        if (!answer.includes('not debuggable')) {
          throw new Error(`no speech capture to check: ${answer}`)
        }
        console.log(`speech capture not readable: ${answer}`)
        return
      }
      writeFileSync(out, capture)
      checkVoice(out)
    }
  }

  try {
    await runScenarios(m, hooks, 'android')
    if (process.env.SPEEDY_KEEP_AWAKE === '1') {
      await keepAwake(
        m,
        hooks,
        async () => {
          const stayOn = adb(
            'shell',
            'settings',
            'get',
            'global',
            'stay_on_while_plugged_in'
          )
          const timeout = adb(
            'shell',
            'settings',
            'get',
            'system',
            'screen_off_timeout'
          )
          adb(
            'shell',
            'settings',
            'put',
            'global',
            'stay_on_while_plugged_in',
            '0'
          )
          adb(
            'shell',
            'settings',
            'put',
            'system',
            'screen_off_timeout',
            '15000'
          )
          return async () => {
            adb(
              'shell',
              'settings',
              'put',
              'global',
              'stay_on_while_plugged_in',
              stayOn
            )
            adb(
              'shell',
              'settings',
              'put',
              'system',
              'screen_off_timeout',
              timeout
            )
          }
        },
        30000,
        async () => {
          const power = adb('shell', 'dumpsys', 'power')
          const wakefulness = /mWakefulness=(\w+)/.exec(power)?.[1]
          console.log(`mWakefulness=${wakefulness}`)
          const windows = adb('shell', 'dumpsys', 'window', 'windows')
          const flagged = windows
            .split('Window #')
            .some(w => w.includes(APP_ID) && w.includes('KEEP_SCREEN_ON'))
          console.log(`${APP_ID} window has KEEP_SCREEN_ON: ${flagged}`)
          return wakefulness === 'Awake' && flagged
        },
        'keep-screen-on'
      )
    }
  } finally {
    await m.detach().catch(() => {})
    if (bluetoothWas === '0') adb('shell', 'svc', 'bluetooth', 'disable')
    if (locationWas === 'false')
      adb('shell', 'cmd', 'location', 'set-location-enabled', 'false')
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
