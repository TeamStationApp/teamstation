/**
 * Crash reporting in TS Cameraman, end to end: launches with `sentryTest=error`, then with
 * `sentryTest=crash` (a null-pointer write in the app's own native library), then plainly so the
 * NDK handler sends the crash it saved. Whether the events arrived is checked against Sentry.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package>
 *   CAMERAMAN_ANDROID_SERIAL=<adb serial> [CAMERAMAN_APK=<apk to install>]
 *   node -r sucrase/register mobile/apps/tsCameramanAndroid/e2e/sentry.e2e.ts
 *
 * The APK must have been built with TS_SENTRY_DSN and TS_SENTRY_TESTS=1; a build without the
 * second ignores the `sentryTest` extra.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const APP_ID = 'app.teamstation.cameraman'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `Set ${name}`)
  return value
}

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const requireClient = createRequire(path.join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const m = await daemon.attach({
    device: required('CAMERAMAN_ANDROID_SERIAL'),
    platform: 'android',
    appId: APP_ID,
    ...(process.env.CAMERAMAN_APK == null ? {} : { appFile: process.env.CAMERAMAN_APK }),
    artifacts: 'on-failure'
  })
  try {
    console.log('test error at', new Date().toISOString())
    await m.launchApp({ appId: APP_ID, clearState: true, arguments: { sentryTest: 'error' } })
    await pause(8000)
    console.log('native crash at', new Date().toISOString())
    await m.launchApp({ appId: APP_ID, stopApp: true, arguments: { sentryTest: 'crash' } })
    await pause(5000)
    await m.launchApp({ appId: APP_ID, stopApp: true })
    // The NDK handler saved the crash; this start sends it.
    await pause(15000)
    console.log('done')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
