import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

interface WebDevice {
  openBrowser: (options: { url: string }) => Promise<unknown>
  tapOn: (options: {
    text?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  assertVisible: (options: {
    text: string
    timeout?: number
  }) => Promise<unknown>
  assertNotVisible: (options: { text: string }) => Promise<unknown>
  setCookies: (options: {
    cookies: Array<{
      name: string
      value: string
      domain: string
      path: string
      secure: boolean
      httpOnly: boolean
    }>
  }) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}
interface Daemon {
  attach: (options: object) => Promise<WebDevice>
  shutdown: (options: object) => Promise<void>
}

/** Drives the built application and actual provider through maestro-d. */
export async function verifyOAuthWeb(options: {
  origin: string
  browserBin: string
  sessionToken: string
  authorizeUrl: string
  waitForCallback: () => Promise<URL>
}): Promise<URL> {
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  const artifacts = process.env.TS_BUILDS_ARTIFACT_DIR
  const name = process.env.MAESTRO_D
  assert(
    clientRoot != null && artifacts != null && name != null,
    'Set the maestro-d client, owned daemon and artifact directory'
  )
  const { MaestroD } = require(path.join(clientRoot, 'dist/cjs/index.js')) as {
    MaestroD: { connect: (options: object) => Promise<Daemon> }
  }
  const daemon = await MaestroD.connect({ name })
  try {
    const device = await daemon.attach({
      device: 'web-builds-approval',
      platform: 'web',
      url: options.origin,
      extra: { browser: options.browserBin, windowSize: '1100,820' },
      artifacts: 'none',
      commandTimeout: 15000,
      outputDir: artifacts
    })
    await device.openBrowser({ url: options.origin })
    console.log('Web acceptance: application opened')
    await writeFile(
      path.join(artifacts, 'oauth-web-debug.png'),
      await device.screenshot()
    )
    await device.assertVisible({ text: '^Sign in$', timeout: 20000 })
    console.log('Web acceptance: signed-out screen visible')
    await device.tapOn({ css: '[aria-label="About TeamStation"]' })
    console.log('Web acceptance: signed-out modal opened')
    await device.assertVisible({ text: '^Build number$' })
    await device.assertNotVisible({ text: '^Download builds$' })
    await new Promise(resolve => setTimeout(resolve, 400))
    await writeFile(
      path.join(artifacts, 'teamstation-web-signed-out-after.png'),
      await device.screenshot()
    )
    await device.tapOn({ css: '[aria-label="Close build information"]' })
    console.log('Web acceptance: modal closed')
    await device.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: options.sessionToken,
          domain: new URL(options.origin).hostname,
          path: '/',
          secure: true,
          httpOnly: true
        }
      ]
    })
    await device.openBrowser({ url: options.origin })
    await device.tapOn({
      css: '[aria-label="About TeamStation"]',
      timeout: 20000
    })
    await device.assertVisible({ text: '^Download builds$', timeout: 10000 })
    await new Promise(resolve => setTimeout(resolve, 400))
    await writeFile(
      path.join(artifacts, 'teamstation-web-after.png'),
      await device.screenshot()
    )
    await device.tapOn({ css: '[aria-label="Close build information"]' })
    console.log('Web acceptance: modal closed')
    await device.openBrowser({ url: options.origin + '/i/demo-builds' })
    await device.assertVisible({
      text: '^You have been invited$',
      timeout: 10000
    })
    await device.assertVisible({ text: 'Demo Hawks', timeout: 10000 })
    await device.tapOn({ css: '[aria-label="About TeamStation"]' })
    await device.assertVisible({ text: '^Build number$' })
    await new Promise(resolve => setTimeout(resolve, 400))
    await writeFile(
      path.join(artifacts, 'teamstation-web-join-after.png'),
      await device.screenshot()
    )
    await device.tapOn({ css: '[aria-label="Close build information"]' })
    await device.assertVisible({ text: '^Accept the invitation$' })
    await device.openBrowser({
      url: options.origin + '/oauth/approve/expired-fixture'
    })
    await device.assertVisible({
      text: 'This request expired or could not be completed.',
      timeout: 10000
    })
    await device.openBrowser({ url: options.authorizeUrl })
    await device.assertVisible({ text: '^Deny$', timeout: 10000 })
    await device.tapOn({ text: '^Deny$' })
    try {
      await device.assertVisible({
        text: '^Authorization complete$',
        timeout: 10000
      })
    } catch {
      await device.assertVisible({
        text: '^Authorization complete$',
        timeout: 10000
      })
    }
    const denied = await options.waitForCallback()
    assert.equal(denied.searchParams.get('error'), 'access_denied')
    await device.openBrowser({ url: options.authorizeUrl })
    await device.assertVisible({
      text: 'Example builds wants to use your TeamStation identity.',
      timeout: 10000
    })
    await device.assertVisible({ text: '^Signed in as Alex Liddi$' })
    await writeFile(
      path.join(artifacts, 'oauth-consent-web.png'),
      await device.screenshot()
    )
    await device.tapOn({ text: '^Allow$' })
    // A real provider traverses two documents; the first assertion can lose
    // its CDP execution context to that navigation. Retry the same assertion.
    try {
      await device.assertVisible({
        text: '^Authorization complete$',
        timeout: 10000
      })
    } catch {
      await device.assertVisible({
        text: '^Authorization complete$',
        timeout: 10000
      })
    }
    return await options.waitForCallback()
  } finally {
    await daemon.shutdown({ wait: true })
  }
}
