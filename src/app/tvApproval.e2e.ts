import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import express from 'express'
import { rateLimit } from 'express-rate-limit'

import { TeamStationClient } from '../common/api'
import { apiKeyRoutes } from '../server/routes/apiKeys'
import { appLinkRoutes } from '../server/routes/appLinks'
import { authRoutes } from '../server/routes/auth'
import { accountHarness } from '../test/accountHarness'

/** Real browser approval against an isolated database, driven through Maestro D. */
async function main(): Promise<void> {
  const artifacts = process.env.TV_ARTIFACTS
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  const daemonName = process.env.MAESTRO_D
  assert(
    artifacts != null && clientRoot != null && daemonName != null,
    'Set TV_ARTIFACTS, MAESTRO_D_CLIENT_ROOT and MAESTRO_D'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const baseline = process.env.TV_BASELINE_WEB_ROOT
  let showBaseline = baseline !== undefined
  let fixtureOrigin = ''
  const h = await accountHarness(
    path.resolve('dist'),
    (app, { db, space, sendCode }) => {
      app.use(rateLimit({ windowMs: 60_000, limit: 6000 }))
      // Generate and follow the actual fixture QR through the real link route.
      app.use(
        '/api/v1',
        authRoutes(db, {
          space,
          sendCode,
          get publicUrl() {
            return fixtureOrigin
          },
          get tvAppOrigin() {
            return fixtureOrigin
          },
          get appOrigins() {
            return [fixtureOrigin]
          },
          get tvAppOrigins() {
            return [fixtureOrigin]
          }
        })
      )
      app.use((req, res, next) => {
        // Match siteAppLinkPaths: a redirected no-query email stays with SPA.
        if (req.path.startsWith('/signin/') && req.query.server == null) {
          next()
          return
        }
        appLinkRoutes({
          publicUrl: fixtureOrigin,
          appLinks: { apps: [{ origin: fixtureOrigin }], knownServers: [] }
        })(req, res, next)
      })
      if (baseline !== undefined) {
        app.get('/account', (_req, res, next) => {
          if (showBaseline) res.sendFile(path.resolve(baseline, 'index.html'))
          else next()
        })
        app.use(express.static(path.resolve(baseline)))
      }
    },
    '127.0.0.1',
    (app, { db }) => {
      app.use(
        '/api/v1',
        apiKeyRoutes(db, { sessionSecret: 'synthetic-tv-fixture-secret' })
      )
    }
  )
  fixtureOrigin = h.origin
  const daemon = await MaestroD.connect({ name: daemonName })
  const m = await daemon.attach({
    device: 'tvApprovalWeb',
    platform: 'web',
    url: h.origin + '/account',
    extra: { windowSize: '1280x1400' }
  })
  try {
    await mkdir(artifacts, { recursive: true })
    await m.setCookies({
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
    await m.openBrowser({ url: h.origin + '/account' })
    if (showBaseline) {
      await m.assertVisible({ text: 'Create API key', timeout: 15000 })
      await m.assertNotVisible({
        text: 'The server sent something unreadable.'
      })
      await writeFile(
        path.join(artifacts, 'account-before.png'),
        await m.screenshot()
      )
      showBaseline = false
      await m.openBrowser({ url: h.origin + '/account' })
    }
    await m.assertVisible({ text: 'TeamStation TV', timeout: 15000 })
    await m.assertVisible({ text: 'Create API key', timeout: 15000 })
    await m.assertNotVisible({ text: 'The server sent something unreadable.' })
    await writeFile(
      path.join(artifacts, 'account-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'TeamStation TV' })
    await m.assertVisible({
      text: 'Enter the eight letters shown on your TV to sign it in.'
    })
    await writeFile(
      path.join(artifacts, 'tv-approval.png'),
      await m.screenshot()
    )
    const tv = new TeamStationClient({ baseUrl: h.origin + '/api/v1' })
    const request = await tv.startTvLogin('Apple TV')
    await m.tapOn({ css: 'input[aria-label="Eight-letter TV login code"]' })
    await m.inputText({
      text: request.displayCode.replace('–', '').toLowerCase()
    })
    await m.assertVisible({ text: 'Your TV is signed in', timeout: 15000 })
    assert(
      'token' in
        (await tv.claimTvLogin(request.requestId, request.clientSecret))
    )
    const qr = await tv.startTvLogin('Google TV')
    const token = new URL(qr.qrUrl).searchParams.get('token')!
    const redirected = await fetch(qr.qrUrl, { redirect: 'manual' })
    assert.equal(redirected.status, 302)
    assert.equal(
      redirected.headers.get('location'),
      `${h.origin}/account/tv?token=${token}`
    )
    await m.openBrowser({ url: qr.qrUrl })
    await m.assertVisible({ text: 'Log in to Google TV' })
    await m.waitForAnimationToEnd()
    await new Promise(resolve => setTimeout(resolve, 3000))
    await m.tapOn({ text: 'Log in to Google TV' })
    await writeFile(
      path.join(artifacts, 'tv-approval-after.png'),
      await m.screenshot()
    )
    await m.tapOn({ text: 'Cancel' })
    assert.deepEqual(await tv.claimTvLogin(qr.requestId, qr.clientSecret), {
      ready: false
    })
    await m.openBrowser({ url: qr.qrUrl })
    await m.assertVisible({ text: 'Log in to Google TV' })
    await m.tapOn({ text: 'Login' })
    await m.assertVisible({ text: 'Your TV is signed in' })
    assert('token' in (await tv.claimTvLogin(qr.requestId, qr.clientSecret)))
    const wrongSeat = await tv.startTvLogin('Apple TV')
    const wrongToken = new URL(wrongSeat.qrUrl).searchParams.get('token')!
    await m.openBrowser({
      url: `${h.origin}/account/tv?token=${wrongToken}&server=https%3A%2F%2Fdevelop5.teamstation.app`
    })
    await m.assertVisible({
      text: 'This TV uses a different TeamStation server. Open it in your browser to continue.'
    })
    await m.assertVisible({ text: 'Open in browser' })
    assert.deepEqual(
      await tv.claimTvLogin(wrongSeat.requestId, wrongSeat.clientSecret),
      { ready: false }
    )
    await writeFile(
      path.join(artifacts, 'tv-wrong-seat-after.png'),
      await m.screenshot()
    )
    const signedOut = await tv.startTvLogin('Apple TV')
    await m.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: '',
          domain: '127.0.0.1',
          path: '/',
          expires: 1
        }
      ]
    })
    await m.openBrowser({ url: signedOut.qrUrl })
    await m.assertVisible({ text: 'Sign in to TeamStation', timeout: 15000 })
    await m.tapOn({ css: 'input[type="email"]' })
    await m.inputText({ text: 'alex@example.com' })
    await m.tapOn({ text: 'Send me a sign-in code' })
    await m.assertVisible({ text: 'Sign-in code', timeout: 15000 })
    const mail = h.links.get('alex@example.com')
    assert(
      mail?.includes('/signin-browser/') === true,
      'browser email must avoid app-associated path'
    )
    assert(mail != null)
    await m.openBrowser({ url: h.origin + new URL(mail).pathname })
    await m.assertVisible({ text: 'Log in to Apple TV', timeout: 15000 })
    assert.deepEqual(
      await tv.claimTvLogin(signedOut.requestId, signedOut.clientSecret),
      { ready: false }
    )
    await m.tapOn({ text: 'Login' })
    await m.assertVisible({ text: 'Your TV is signed in' })
    assert(
      'token' in
        (await tv.claimTvLogin(signedOut.requestId, signedOut.clientSecret))
    )
    console.log(
      'PASS: account entry, code approval, issued QR redirect, signed-out email return, explicit approval, and one-time TV claims'
    )
  } finally {
    await m.detach()
    await h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
