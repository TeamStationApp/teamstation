/** Finished-build checks. All endpoints, credentials and selected devices come from the run environment. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { nativeFunnel } from './nativeFunnel'
import { nativeVideo } from './nativeVideo'
import { webScenario } from './web'

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `Set ${key}`)
  return value
}
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (key: string): string => args[args.indexOf(key) + 1]
  const target = option('--target')
  const scenario = option('--scenario')
  assert(
    ['errors', 'cors', 'video', 'funnel'].includes(scenario),
    'This scenario is not implemented yet'
  )
  assert(
    [
      'director',
      'cam-ios',
      'cam-android',
      'ts-ios',
      'ts-android',
      'web'
    ].includes(target)
  )
  const client = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )
  const { MaestroD } = client('./dist/cjs/index.js')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  const app =
    target === 'web'
      ? 'TS web'
      : target === 'director'
        ? 'TS dir'
        : target.startsWith('ts-')
          ? 'TS'
          : 'cam'
  const appId =
    process.env.OBSERVABILITY_APP_ID ??
    (target === 'director'
      ? 'app.teamstation.director'
      : target.startsWith('ts-')
        ? 'app.teamstation.app'
        : 'app.teamstation.cameraman')
  const secret = JSON.parse(
    await readFile(required('OBSERVABILITY_SECRETS'), 'utf8')
  )
  const collector = required('OBSERVABILITY_LOG_URL')
  assert(new URL(collector).protocol === 'https:')
  // Device clocks can differ slightly from the host running this assertion.
  const since = (): string => new Date(Date.now() - 5000).toISOString()
  let started = since()
  const seen = new Set<string>()
  const device = required(
    target === 'web'
      ? 'MAESTRO_WEB_DEVICE'
      : target === 'director'
        ? 'DIRECTOR_DEVICE_UDID'
        : target === 'cam-ios' || target === 'ts-ios'
          ? 'TS_IOS_DEVICE_UDID'
          : 'TS_ANDROID_DEVICE'
  )
  const attach = async (): Promise<any> =>
    await daemon.attach({
      device,
      platform:
        target === 'web'
          ? 'web'
          : target.endsWith('-android')
            ? 'android'
            : 'ios',
      ...(target === 'web'
        ? {
            url: required('OBSERVABILITY_APP_URL'),
            extra: {
              browser: process.env.OBSERVABILITY_BROWSER ?? 'chrome',
              headed: true,
              userDataDir: process.env.OBSERVABILITY_BROWSER_PROFILE
            }
          }
        : { appId }),
      ...(process.env.OBSERVABILITY_TEAM_ID != null
        ? { teamId: process.env.OBSERVABILITY_TEAM_ID }
        : {}),
      // Failures can contain form values or invitation links. Explicit private
      // screenshots below are opt-in; the driver's reports must not retain them.
      artifacts: 'none'
    })
  let m = await attach()
  const query = async (level: string): Promise<any[]> => {
    const response = await fetch(collector + '/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + secret.readToken
      },
      body: JSON.stringify({
        environment: 'development',
        from: started,
        to: new Date().toISOString(),
        app,
        event: 'app_error',
        level
      })
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    return result.hits.hits.map((hit: any) => hit._source)
  }
  const observed = async (
    level: string,
    classification?: string
  ): Promise<void> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = (await query(level)).filter(
        row =>
          !seen.has(row.I) &&
          (classification == null || row.P.c === classification)
      )
      if (rows.length > 0) {
        for (const row of rows) {
          seen.add(row.I)
          assert.equal(row.A, app)
          assert.equal(row.N, 'development')
          assert(
            typeof row.V === 'string' && row.V !== '',
            'App version is required'
          )
          assert.equal(Object.keys(row)[0], 'D')
          assert(!JSON.stringify(row).includes('Sentry test error'))
        }
        console.log(
          `${target}: indexed ${level} app error with version, D first and sanitized payload`
        )
        return
      }
      await delay(1500)
    }
    assert.fail(`No indexed ${level} event from the actual app`)
  }
  try {
    if (target === 'web') {
      await webScenario(
        m,
        scenario,
        required('OBSERVABILITY_APP_URL'),
        collector
      )
      if (scenario === 'errors') await observed('error')
      return
    }
    if (target.startsWith('ts-') && ['funnel', 'video'].includes(scenario)) {
      await m.launchApp({ appId, stopApp: true })
      if (scenario === 'video') {
        await nativeVideo(
          m,
          required('OBSERVABILITY_APP_URL'),
          JSON.parse(await readFile(required('OBSERVABILITY_FIXTURES'), 'utf8'))
        )
        return
      }
      await nativeFunnel(
        m,
        device,
        required('OBSERVABILITY_APP_URL'),
        JSON.parse(await readFile(required('OBSERVABILITY_FIXTURES'), 'utf8'))
      )
      return
    }
    assert.equal(scenario, 'errors')
    if (target.startsWith('ts-')) {
      await m.launchApp({ appId, stopApp: true })
      // Sign-in is a prerequisite supplied by the isolated test environment.
      // It uses pasteboard input so the driver's inputText log holds no secret.
      await m.assertVisible({ text: 'About TeamStation', timeout: 15000 })
      await m.tapOn({ text: 'About TeamStation' })
      await m.tapOn({ text: 'Send a test error' })
      await delay(3000)
      await m.detach()
      m = await attach()
      await m.launchApp({ appId, stopApp: true })
      // React Native treats this unhandled JS exception as fatal in Release.
      await observed('fatal')
      started = since()
      await m.tapOn({ text: 'About TeamStation' })
      await m.tapOn({ text: 'Test a native crash' })
      await delay(3000)
      await m.detach()
      m = await attach()
      await m.launchApp({ appId, stopApp: true })
      await observed(
        'fatal',
        target === 'ts-android' ? 'RuntimeException' : undefined
      )
      await m.tapOn({ text: 'About TeamStation' })
      await writeFile(
        join(
          required('OBSERVABILITY_ARTIFACT_DIR'),
          `${target}-relaunched.png`
        ),
        await m.screenshot()
      )
      return
    }
    await m.launchApp({
      appId,
      stopApp: true,
      arguments: { sentryTest: 'error' }
    })
    await observed('error')
    await writeFile(
      join(required('OBSERVABILITY_ARTIFACT_DIR'), `${target}-error.png`),
      await m.screenshot()
    )
    await m.launchApp({
      appId,
      stopApp: true,
      arguments: { sentryTest: 'crash' },
      optional: true
    })
    await delay(3000)
    // XCTest can invalidate its session when the app deliberately crashes.
    await m.detach()
    m = await attach()
    await m.launchApp({ appId, stopApp: true })
    await observed('fatal')
    await writeFile(
      join(required('OBSERVABILITY_ARTIFACT_DIR'), `${target}-relaunched.png`),
      await m.screenshot()
    )
  } catch (error) {
    if (process.env.OBSERVABILITY_PRIVATE_SCREENSHOT != null)
      await writeFile(
        process.env.OBSERVABILITY_PRIVATE_SCREENSHOT,
        await m.screenshot()
      )
    throw error
  } finally {
    if (target !== 'web') await m.stopApp({ appId }).catch(() => {})
    await m.detach()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Observability E2E failed'
  )
  process.exitCode = 1
})
