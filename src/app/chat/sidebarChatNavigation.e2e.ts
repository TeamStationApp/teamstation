import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { publicWebNodes } from '../../test/chat2Maestro.e2e'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../test/refinementsMaestro.e2e'
import { tessFixture } from '../../test/tessFixture'
import { sharedChromeReturnsToChat } from './chat2.e2e'
import { openRecoveryChat } from './chatHistoryRecoveryReplyFixture.e2e'

/** Owns the real chat fixture and browser used by entityChatNavigation.e2e.ts. */
async function main(): Promise<void> {
  const out = resolve(
    process.env.TS_CHAT_ARTIFACTS ?? '/tmp/sidebarChatNavigation'
  )
  await mkdir(out, { recursive: true })
  const fixture = await tessFixture({
    webRoot: resolve('dist'),
    videos: false,
    mountExtra: (app, { db, media }) => {
      // Server routes use Node timers; do not pull them into the DOM typecheck.
      const { chatRoutes } = require('../../server/routes/chat')
      const { chatKeyRoutes } = require('../../server/routes/chatKeys')
      const { chatEpochRoutes } = require('../../server/routes/chatEpochs')
      const { chatMessageRoutes } = require('../../server/routes/chatMessages')
      app.use('/api/v1', chatRoutes(db, media))
      app.use('/api/v1', chatKeyRoutes(db))
      app.use('/api/v1', chatEpochRoutes(db))
      app.use('/api/v1', chatMessageRoutes(db, media))
    }
  })
  const name = process.env.MAESTRO_D ?? 'sidebarChatNavigation'
  const device = `${name}-browser`
  const daemon = await maestro(name)
  let session: BrowserSession | undefined
  try {
    // Keep the server-only reconciler out of the browser TypeScript program.
    const { drainDirty } = require('../../server/chat/reconciler')
    await drainDirty(fixture.f.h.db, new Date())
    session = await browserSession(daemon, device, 1440, 900, out, 'chrome')
    const { m, page, browser } = session
    const origin = fixture.f.h.origin
    await browser.setCookie({
      name: 'ts_session',
      value: fixture.f.h.tokens.get(101)!,
      domain: new URL(origin).hostname,
      path: '/',
      httpOnly: true
    })
    const tap = async (css: string): Promise<void> => {
      await page.waitForSelector(css, { visible: true })
      await m.tapOn({ css, timeout: 15000 })
    }
    const sidebar = '[data-testid="navigation-sidebar"]'
    await m.openBrowser({ url: origin + '/' })
    await tap(`${sidebar} [aria-label="Messages"]`)
    await tap('[aria-label="Not Now"]')
    await page.waitForFunction(() => location.pathname === '/')
    assert.equal(await page.$('[data-testid="chat-workspace"]'), null)
    await tap(`${sidebar} [aria-label="Messages"]`)
    await tap('[data-testid="chat-age-agree"]')
    await page.waitForSelector('[data-testid="chat-workspace"]', {
      timeout: 30000
    })
    console.log('Messages preserves age consent and real browser key enrolment')

    const source = `/teams/${fixture.f.teamA}?tab=chats`
    const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
    assert(clientRoot != null, 'Supply MAESTRO_D_CLIENT_ROOT')
    const result = await promisify(execFile)(
      process.execPath,
      ['-r', 'sucrase/register', 'src/app/chat/entityChatNavigation.e2e.ts'],
      {
        env: {
          ...process.env,
          MAESTRO_D_CLIENT_ROOT: clientRoot,
          MAESTRO_D: name,
          MAESTRO_DEVICE: device,
          TS_CHAT_WEB: origin,
          TS_CHAT_ORIGIN: source,
          TS_CHAT_ARTIFACTS: out
        }
      }
    )
    console.log(result.stdout)
    await page.setViewport({ width: 1440, height: 900 })
    await tap('[data-testid^="entity-chat-cnv"]')
    await page.waitForSelector('[data-testid="chat-message-pane"]', {
      visible: true
    })
    const conversation = new URL(page.url()).pathname
    assert(conversation.startsWith('/chat/'))

    const check = async (width: number, tess: boolean): Promise<void> => {
      await page.setViewport({ width, height: 900 })
      const sidebarWidth = width >= 1216 ? 256 : 0
      const x = sidebarWidth
      await page.waitForFunction(
        (x, width, tess) => {
          const workspace = document.querySelector(
            '[data-testid="chat-workspace"]'
          )
          const list = document.querySelector('[data-testid="chat-list-pane"]')
          const messages = document.querySelector(
            '[data-testid="chat-message-pane"]'
          )
          if (workspace == null || list == null || messages == null)
            return false
          const box = workspace.getBoundingClientRect()
          return (
            box.x === x &&
            box.width === width - x - (tess ? 400 : 0) &&
            (getComputedStyle(list).display === 'none') === tess &&
            messages.getBoundingClientRect().width > 0
          )
        },
        { timeout: 15000 },
        x,
        width,
        tess
      )
      assert.equal(new URL(page.url()).pathname, conversation)
      await page.screenshot({
        path: resolve(
          out,
          `ready-chat-${width}-tess-${tess ? 'open' : 'closed'}.png`
        )
      })
      console.log(
        `${width}px, Tess ${tess ? 'open' : 'closed'}: ready chat fits and retains its conversation`
      )
    }
    for (const width of [1215, 1216, 1440]) await check(width, false)
    await tap('[role="button"][aria-label="Ask Tess"]')
    await page.waitForSelector('[data-testid="Tess column"]')
    for (const width of [1440, 1215, 1216]) await check(width, true)
    await tap('[aria-label="Close Tess"]')
    await check(1216, false)
    await tap('[aria-label="Back"]')
    await page.waitForFunction(
      source => location.pathname + location.search === source,
      {},
      source
    )
    // Run the affected recovery entry and E9 shared-chrome journey themselves,
    // with both labels, without requiring unrelated recovery/attachment state.
    for (const width of [1440, 1215]) {
      await page.setViewport({ width, height: 900 })
      await page.waitForFunction(
        wide =>
          (document.querySelector('[data-testid="navigation-sidebar"]') !=
            null) ===
          wide,
        {},
        width >= 1216
      )
      await tap('[role="tab"][aria-label="Home"]')
      await openRecoveryChat(m)
      await m.openBrowser({ url: origin + conversation })
      await page.waitForSelector('[data-testid="chat-message-history"]')
      await sharedChromeReturnsToChat({
        native: false,
        nodes: async () => await page.evaluate(publicWebNodes),
        tapObserved: async node => {
          await tap(`[role="tab"][aria-label=${JSON.stringify(node.text)}]`)
        },
        present: async id => {
          await page.waitForSelector(`[data-testid=${JSON.stringify(id)}]`, {
            visible: true
          })
        }
      })
      assert.equal(new URL(page.url()).pathname, conversation)
      console.log(
        `${width}px: recovery entry and E9 shared chrome return passed`
      )
    }
    console.log(
      'PASS ready Messages navigation across sidebar boundary and beside Tess'
    )
  } finally {
    await session?.browser.close().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
    await fixture.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
