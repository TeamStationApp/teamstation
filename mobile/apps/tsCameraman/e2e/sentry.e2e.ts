/**
 * Crash reporting in TS Cameraman for iOS, end to end: launches with `-sentryTest error`, then
 * `-sentryTest crash`, then plainly so the SDK sends the crash it saved. Whether the events
 * arrived is checked against Sentry.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package>
 *   CAMERAMAN_DEVICE_UDID=<device or simulator> [CAMERAMAN_APP=<.app to install>]
 *   node -r sucrase/register mobile/apps/tsCameraman/e2e/sentry.e2e.ts
 *
 * The build must have been made with TS_SENTRY_DSN.
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
    device: required('CAMERAMAN_DEVICE_UDID'),
    platform: 'ios',
    appId: APP_ID,
    ...(process.env.CAMERAMAN_APP == null ? {} : { appFile: process.env.CAMERAMAN_APP }),
    artifacts: 'on-failure'
  })
  try {
    console.log('test error at', new Date().toISOString())
    await m.launchApp({ appId: APP_ID, stopApp: true, arguments: { sentryTest: 'error' } })
    await pause(8000)
    console.log('native crash at', new Date().toISOString())
    // The app crashes while launching, so the launch itself is expected to fail.
    await m.launchApp({
      appId: APP_ID,
      stopApp: true,
      arguments: { sentryTest: 'crash' },
      optional: true
    })
    await pause(5000)
    await m.launchApp({ appId: APP_ID, stopApp: true })
    // The crash was saved on the way down; this start sends it.
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
