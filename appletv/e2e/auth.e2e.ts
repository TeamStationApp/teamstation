import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { captureScreenshot } from './capture'
import { tvFixture } from './fixture'

async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
    TV_METRO_URL: metro
  } = process.env
  assert(
    device != null && artifacts != null && clientRoot != null && metro != null,
    'Set simulator, artifacts, client root and Metro URL'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const h = await tvFixture({ webRoot: path.resolve('dist') })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  const browserDaemon = await MaestroD.connect({
    name: process.env.MAESTRO_D_WEB ?? 'appleTvExperience'
  })
  const browser = await browserDaemon.attach({
    artifacts: 'none',
    device: 'tvApprovalWeb',
    platform: 'web',
    url: h.origin + '/account/tv',
    extra: { windowSize: '1280x900' }
  })
  const launch = {
    appId: 'app.teamstation.tv',
    stopApp: true,
    environment: { TV_API_BASE_URL: h.origin + '/api/v1', TV_METRO_URL: metro }
  }
  try {
    await mkdir(artifacts, { recursive: true })
    await tv.launchApp(launch)
    await tv.assertVisible({
      text: 'Your games. On the big screen.',
      timeout: 60000
    })
    await tv.tapOn({ text: 'Dismiss', optional: true, timeout: 1000 })
    const tree = await tv.hierarchy()
    const findCode = (node: any): string | undefined => {
      const match = /[A-Z]{4}[–-][A-Z]{4}/.exec(String(node.text ?? ''))
      return match?.[0] ?? node.children?.map(findCode).find(Boolean)
    }
    const code = findCode(tree)
    assert(code != null, 'TV exposes eight-letter code')
    await captureScreenshot(tv, path.join(artifacts, 'tv-login.png'))
    await browser.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: h.tokens.get(101)!,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true
        }
      ]
    })
    await browser.openBrowser({ url: h.origin + '/account/tv' })
    await browser.tapOn({
      css: 'input[aria-label="Eight-letter TV login code"]'
    })
    await browser.inputText({ text: code.replace(/[–-]/g, '').toLowerCase() })
    await browser.assertVisible({ text: 'Your TV is signed in' })
    await tv.assertVisible({ text: 'Welcome, Babe Ruth', timeout: 15000 })
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await tv.launchApp(launch)
    await tv.assertVisible({ text: 'Welcome, Babe Ruth', timeout: 30000 })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_UP' })
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.tapOn({ id: 'Sign out' })
    await tv.assertVisible({
      text: 'Your games. On the big screen.',
      timeout: 15000
    })
    const expiredCode = findCode(await tv.hierarchy())
    await h.db
      .updateTable('tv_login_requests')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('consumed_at', 'is', null)
      .execute()
    const deadline = Date.now() + 10000
    let nextCode = expiredCode
    while (
      Date.now() < deadline &&
      (nextCode == null || nextCode === expiredCode)
    ) {
      await new Promise(resolve => setTimeout(resolve, 250))
      nextCode = findCode(await tv.hierarchy())
    }
    assert(
      nextCode != null && nextCode !== expiredCode,
      'Expired request automatically rotates its code'
    )
    console.log(
      'PASS TV code approval through browser, Keychain restoration after relaunch, remote direction, sign out, expired request rotation'
    )
  } catch (error) {
    await captureScreenshot(tv, path.join(artifacts, 'tv-auth-failure.png'))
    await writeFile(
      '/private/tmp/tv-auth-hierarchy.json',
      JSON.stringify(await tv.hierarchy(), null, 2)
    )
    throw error
  } finally {
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await browser.detach()
    await h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
