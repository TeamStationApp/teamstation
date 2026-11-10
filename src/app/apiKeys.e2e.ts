import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from 'chai'

import {
  browserSession,
  capture,
  contains,
  fill,
  log,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { apiKeyRoutes } from '../server/routes/apiKeys'
import { accountHarness } from '../test/accountHarness'

/**
 * API keys on Account, in one Chrome tab driven by maestro-d at a phone's
 * width: make a key on Create API key, find it on Account, copy it, keep it
 * through a cancelled delete, and delete it.
 *
 *   npm run build.web
 *   TS_ARTIFACTS_DIR=<dir> TS_MAESTRO_D_CLIENT=<maestro-d js client> \
 *     MAESTRO_D_BIN=<maestro-d> node -r sucrase/register src/app/apiKeys.e2e.ts
 *
 * The app and the API share one origin (`accountHarness` serving `dist`), and
 * Babe Ruth (101) is signed in by the session cookie.
 */
const LOG = 'account-api-keys-e2e.log'

async function main(): Promise<void> {
  const out = resolve(process.env.TS_ARTIFACTS_DIR ?? 'artifacts/apiKeys')
  await mkdir(out, { recursive: true })
  const h = await accountHarness(
    resolve(process.env.TS_UI_WEB_ROOT ?? 'dist'),
    undefined,
    '127.0.0.1',
    (app, { db }) => {
      app.use('/api/v1', apiKeyRoutes(db, { sessionSecret: 'e2e-secret' }))
    }
  )
  const d = await maestro(process.env.MAESTRO_D ?? 'apikeys')
  const s = await browserSession(d, 'apikeys-web', 390, 844, out, 'chrome')
  const step = async (line: string): Promise<void> => {
    await log(out, LOG, line)
  }
  try {
    await step('$ node -r sucrase/register src/app/apiKeys.e2e.ts')
    const origin = new URL(h.origin)
    // `setPermission`, its replacement, is refused by the Chrome maestro-d
    // drives; this still grants the clipboard.
    await s.browser
      .defaultBrowserContext()
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      .overridePermissions(h.origin, [
        'clipboard-read',
        'clipboard-sanitized-write'
      ])
    await s.browser.setCookie({
      name: 'ts_session',
      value: h.tokens.get(101) ?? '',
      domain: origin.hostname,
      path: '/',
      httpOnly: true
    })
    const toKeys = async (): Promise<void> => {
      await s.page.evaluate(() => {
        const all = [...document.querySelectorAll('div')].filter(
          node =>
            node.textContent === 'API KEYS' || node.textContent === 'API keys'
        )
        const last = all.at(-1)
        if (last != null) last.scrollIntoView({ block: 'center' })
      })
      await new Promise(resolve => setTimeout(resolve, 600))
    }

    await s.m.openBrowser({ url: `${h.origin}/account` })
    await contains(s.page, 'Create API key')
    await step('Account: the API keys section holds only Create API key')

    await tap(s.m, 'Create API key')
    await contains(s.page, 'Umpire management')
    expect(s.page.url()).equals(`${h.origin}/account/api-keys/new`)
    await step(`Create API key opened at ${new URL(s.page.url()).pathname}`)
    await fill(s.m, 'Name', 'Schedule agent')
    await s.m.tapOn({
      text: 'Schedule write',
      role: 'checkbox',
      timeout: 10000
    })
    const circles = await s.page.evaluate(() =>
      ['Schedule read', 'Schedule write'].map(label => {
        const circle = document.querySelector(`[aria-label="${label}"]`)
        return circle === null ? null : circle.getAttribute('aria-checked')
      })
    )
    expect(circles).deep.equals(['true', 'true'])
    await step('Tapped Schedule W: Schedule R and W are both checked')
    await capture(s.m, out, 'create-api-key.png')

    await tap(s.m, 'Create API key')
    await contains(s.page, 'Schedule agent')
    expect(new URL(s.page.url()).pathname).equals('/account')
    const listed = (await (await h.request('GET', '/me/api-keys')).json()) as {
      keys: Array<{ id: string; name: string; secret: string }>
    }
    expect(listed.keys.map(key => key.name)).deep.equals(['Schedule agent'])
    const [key] = listed.keys
    await contains(s.page, `${key.secret.slice(0, 8)}…`)
    await step(
      `Back on Account: "Schedule agent" with ${key.secret.slice(0, 8)}… above Create API key`
    )
    await toKeys()
    await capture(s.m, out, 'account-api-keys-after.png')

    await tap(s.m, 'Copy Schedule agent')
    const clipboard = await s.page.evaluate(
      async () => await navigator.clipboard.readText()
    )
    expect(clipboard).equals(key.secret)
    await step(
      'Copy: the clipboard holds the whole secret GET /me/api-keys gave'
    )

    const games = `/teams/tem_account/games`
    await tap(s.m, 'Delete Schedule agent')
    await contains(s.page, 'Anything using this key stops working.')
    await capture(s.m, out, 'delete-api-key-sheet.png')
    await step('Delete opened "Delete Schedule agent?" with its detail')
    await tap(s.m, 'Cancel')
    const kept = await h.request('GET', games, undefined, key.secret)
    expect(kept.status).equals(200)
    await step(`Cancel: the key still reads GET ${games}: HTTP ${kept.status}`)

    await tap(s.m, 'Delete Schedule agent')
    await contains(s.page, 'Anything using this key stops working.')
    await s.page.evaluate(() => {
      const deletes = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].filter(node => node.textContent === 'Delete')
      const confirm = deletes.at(-1)
      if (confirm !== undefined) confirm.click()
    })
    await s.page.waitForFunction(() => {
      const body = document.body.textContent
      return body !== null && !body.includes('Schedule agent')
    })
    const revoked = await h.request('GET', games, undefined, key.secret)
    expect(revoked.status).equals(401)
    await step(
      `Confirm: the row is gone, and the key now gets GET ${games}: HTTP ${revoked.status}`
    )
    await toKeys()
    await capture(s.m, out, 'account-api-key-deleted.png')
  } finally {
    await s.m.detach().catch(() => undefined)
    await d.shutdown()
    await h.close()
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
