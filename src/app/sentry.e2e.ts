/**
 * Crash reporting on a phone, end to end: signs in as a site administrator,
 * sends a test error from the build information sheet, then crashes the app
 * natively, relaunching after each so the SDK sends what it saved.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package>
 *   TS_SENTRY_DEVICE=<udid or adb serial> TS_SENTRY_PLATFORM=ios|android
 *   [TS_SENTRY_APP_FILE=<.app or .apk to install>]
 *   TS_E2E_EMAIL=<admin> TS_E2E_PASSWORD=<password>
 *   TS_SENTRY_ARTIFACTS=<directory for screenshots>
 *   node -r sucrase/register src/app/sentry.e2e.ts
 *
 * The build must have been made with TS_SENTRY_DSN, and TS_API_BASE_URL naming
 * a server the device can reach where that account exists. Whether the events
 * arrived is checked against the Sentry server afterwards.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

interface Device {
  launchApp: (options: Record<string, unknown>) => Promise<unknown>
  tapOn: (options: Record<string, unknown>) => Promise<unknown>
  inputText: (options: Record<string, unknown>) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
  hideKeyboard: () => Promise<unknown>
  takeScreenshot: (options: Record<string, unknown>) => Promise<unknown>
  detach: () => Promise<void>
}

const APP_ID = 'app.teamstation.app'

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `Set ${name}`)
  return value
}

async function signIn(
  m: Device,
  email: string,
  password: string
): Promise<void> {
  await m.assertVisible({ text: 'E-mail address', timeout: 60000 })
  await m.tapOn({ text: 'E-mail address' })
  await m.inputText({ text: email })
  await m.hideKeyboard()
  await m.tapOn({ text: 'Use a password instead' })
  await m.tapOn({ text: 'Password' })
  await m.inputText({ text: password })
  await m.hideKeyboard()
  // On iOS dismissing the keyboard submits the form; the button is gone then.
  await m.tapOn({ text: 'Sign in', optional: true })
}

async function openBuildInfo(m: Device): Promise<void> {
  await m.assertVisible({ text: 'About TeamStation', timeout: 60000 })
  // A tap while the home screen is still loading its teams can be lost, so the
  // sheet is asked for again until it opens.
  for (let attempt = 1; ; attempt++) {
    await m.tapOn({ text: 'About TeamStation' })
    try {
      await m.assertVisible({ text: 'Send a test error', timeout: 15000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
}

async function main(): Promise<void> {
  const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
  const artifacts = required('TS_SENTRY_ARTIFACTS')
  const platform = required('TS_SENTRY_PLATFORM')
  const email = required('TS_E2E_EMAIL')
  const password = required('TS_E2E_PASSWORD')
  await mkdir(artifacts, { recursive: true })
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const { MaestroD } = requireClient('./dist/cjs/index.js')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const m: Device = await daemon.attach({
    device: required('TS_SENTRY_DEVICE'),
    platform,
    appId: APP_ID,
    ...(process.env.TS_SENTRY_APP_FILE == null
      ? {}
      : { appFile: process.env.TS_SENTRY_APP_FILE }),
    artifacts: 'on-failure'
  })
  const shot = async (name: string): Promise<void> => {
    await m.takeScreenshot({
      path: path.join(artifacts, `${platform}-${name}`)
    })
  }
  try {
    await m.launchApp({ appId: APP_ID, clearState: true })
    await signIn(m, email, password)
    await openBuildInfo(m)
    await m.assertVisible({ text: 'Test a native crash' })
    await shot('buildinfo')
    console.log('test error at', new Date().toISOString())
    await m.tapOn({ text: 'Send a test error' })
    // A JavaScript error from a press is fatal in a release build; the SDK
    // saves it and sends it when the app next starts.
    await new Promise(resolve => setTimeout(resolve, 3000))
    await m.launchApp({ appId: APP_ID, stopApp: true })
    await openBuildInfo(m)
    console.log('native crash at', new Date().toISOString())
    await m.tapOn({ text: 'Test a native crash' })
    await new Promise(resolve => setTimeout(resolve, 3000))
    await m.launchApp({ appId: APP_ID, stopApp: true })
    await m.assertVisible({ text: 'About TeamStation', timeout: 60000 })
    await shot('after-crash')
    // Give the SDK time to send the crash it found at start.
    await new Promise(resolve => setTimeout(resolve, 15000))
    console.log('done')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
