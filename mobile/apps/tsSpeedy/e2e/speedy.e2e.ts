import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { attach } from '../../../test/maestroD'
import { APP_ID, required, runScenarios } from '../../../test/speedy'

/**
 * TS Speedy on iOS: the readout, the voice, the audio switch, Settings and portrait (E1–E6).
 *
 * Install a build first (`bash scripts/build-sim.sh` with INSTALL=1, or `bash scripts/build-device.sh`),
 * then:
 *
 *   # the task simulator: no Bluetooth, so Settings says "Bluetooth off" and Pair is skipped
 *   MAESTRO_D=speedy-ios SPEEDY_DEVICE_UDID=<simulator udid> SPEEDY_DEVICE_KIND=simulator \
 *   E2E_ARTIFACT_DIR=<dir> node -r sucrase/register mobile/apps/tsSpeedy/e2e/speedy.e2e.ts
 *
 *   # an iPhone
 *   MAESTRO_D=speedy-ios SPEEDY_DEVICE_UDID=<iphone udid> SPEEDY_DEVICE_KIND=device \
 *   MAESTRO_D_TEAM_ID=<team> E2E_ARTIFACT_DIR=<dir> node -r sucrase/register mobile/apps/tsSpeedy/e2e/speedy.e2e.ts
 *
 * After E3b the app's own speech, as its player rendered it, is pulled to
 * `<E2E_ARTIFACT_DIR>/ios-voice-e3.wav`. On a phone that needs a development-signed install.
 */

async function main(): Promise<void> {
  const device = required('SPEEDY_DEVICE_UDID')
  const kind = required('SPEEDY_DEVICE_KIND')
  if (kind !== 'simulator' && kind !== 'device') throw new Error('SPEEDY_DEVICE_KIND is simulator or device')
  const m = await attach({ daemon: required('MAESTRO_D'), device, appId: APP_ID })

  const pullSpeech = async (): Promise<void> => {
    const destination = join(m.artifactDir, 'ios-voice-e3.wav')
    if (kind === 'simulator') {
      const container = execFileSync('xcrun', ['simctl', 'get_app_container', device, APP_ID, 'data'], { encoding: 'utf8' }).trim()
      execFileSync('cp', [join(container, 'Documents', 'speech-capture.wav'), destination])
    } else {
      execFileSync('xcrun', [
        'devicectl', 'device', 'copy', 'from',
        '--device', device,
        '--domain-type', 'appDataContainer',
        '--domain-identifier', APP_ID,
        '--source', 'Documents/speech-capture.wav',
        '--destination', destination
      ], { stdio: 'inherit' })
    }
    console.log(`speech capture ${destination}`)
  }

  try {
    await runScenarios(
      m,
      {
        launch: async () => {
          await m.launchApp({ appId: APP_ID, stopApp: true, arguments: { uiTest: true } })
          // The first launch asks for Bluetooth.
          await m.tapOn({ text: 'Allow', optional: true, timeout: 5000 })
        },
        unpairedStatus: kind === 'simulator' ? 'Bluetooth off' : 'No radar paired',
        canPair: kind === 'device',
        afterVoice: pullSpeech
      },
      'ios'
    )
  } finally {
    await m.detach().catch(() => {})
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
