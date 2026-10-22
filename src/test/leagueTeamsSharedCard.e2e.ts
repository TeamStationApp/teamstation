import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'
import express from 'express'

import { groupFixture } from './groupFixtures'
import {
  browserSession,
  contains,
  maestro,
  type MaestroHandle
} from './refinementsMaestro.e2e'

/** Synthetic presentation plus finished-app navigation, driven by Maestro D. */
async function main(): Promise<void> {
  const out = process.env.TS_ARTIFACTS_DIR
  const device = process.env.TS_SIMULATOR_UDID
  assert(
    out != null && device != null,
    'Supply artifacts directory and simulator UDID'
  )
  const before = process.env.TS_UI_BEFORE === '1'
  const suffix = before ? 'before' : 'after'
  const directory = join(out, 'support', 'fixture')
  await mkdir(directory, { recursive: true })
  const { webSettings } = await import(
    resolve('scripts/web-build-settings.mjs')
  )
  await build({
    ...webSettings,
    entryPoints: ['src/test/leagueTeamsSharedCard.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  await cp('src/app/assets/fonts', join(directory, 'fonts'), {
    recursive: true
  })
  const html = await readFile('src/app/web/index.html', 'utf8')
  await writeFile(join(directory, 'index.html'), html)
  const app = express()
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const daemon = await maestro(process.env.MAESTRO_D ?? 'leagueTeamsSharedCard')
  const logs = [
    '$ node -r sucrase/register src/test/leagueTeamsSharedCard.e2e.ts'
  ]
  let browser: Awaited<ReturnType<typeof browserSession>> | undefined
  let simulator: MaestroHandle | undefined
  let fixture: Awaited<ReturnType<typeof groupFixture>> | undefined
  const tap = async (m: MaestroHandle, text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 15000 })
  }
  const visible = async (m: MaestroHandle, text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 15000 })
  }
  try {
    browser = await browserSession(
      daemon,
      'league-teams-chromium',
      390,
      844,
      out
    )
    const { m, page } = browser
    for (const [name, query] of [
      ['chromium', ''],
      ['chromium-dark', '?dark'],
      ['chromium-large', '?large']
    ]) {
      await m.openBrowser({ url: url + query })
      await contains(page, 'Demo Hawks')
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await writeFile(join(out, `${name}-${suffix}.png`), await m.screenshot())
      if (!before) {
        const geometry = await page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(
            '[data-testid="league-teams-card"]'
          )!
          const ref = document.querySelector<HTMLElement>(
            '[data-testid="reference-parent"] [data-testid="relationship-action-row"]'
          )!.parentElement!
          const css = getComputedStyle(card)
          const reference = getComputedStyle(ref)
          const rows = [
            ...card.querySelectorAll<HTMLElement>(
              '[data-testid="relationship-action-row"]'
            )
          ]
          const row = rows[0].getBoundingClientRect()
          const divider = card
            .querySelector<HTMLElement>(
              '[data-testid="relationship-action-divider"]'
            )!
            .getBoundingClientRect()
          return {
            rows: rows.length,
            children: card.children.length,
            surface: css.backgroundColor,
            reference: reference.backgroundColor,
            radius: css.borderTopLeftRadius,
            referenceRadius: reference.borderTopLeftRadius,
            padding: css.padding,
            ratio: divider.height / row.height,
            top: divider.top - row.top,
            bottom: row.bottom - divider.bottom,
            overflow: document.documentElement.scrollWidth > innerWidth,
            targets: [
              ...card.querySelectorAll<HTMLElement>('[role="button"]')
            ].map(n => n.getBoundingClientRect().height)
          }
        })
        assert.equal(geometry.rows, 2)
        assert.equal(geometry.children, 3)
        assert.equal(geometry.surface, geometry.reference)
        assert.equal(geometry.radius, geometry.referenceRadius)
        assert.equal(geometry.padding, '0px')
        assert(Math.abs(geometry.ratio - 0.8) < 0.02)
        assert(geometry.top > 0 && geometry.bottom > 0 && !geometry.overflow)
        assert(geometry.targets.every(height => height >= 48))
        logs.push(`${name}: ${JSON.stringify(geometry)}`)
      }
    }
    await m.openBrowser({ url })
    await contains(page, 'Demo Hawks')
    simulator = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await simulator.openLink({ link: url })
    await visible(simulator, 'Demo Hawks')
    await simulator.tapOn({ text: 'Close', optional: true, timeout: 1000 })
    await writeFile(
      join(out, `simulator-${suffix}.png`),
      await simulator.screenshot()
    )
    if (before) return
    for (const target of [m, simulator]) {
      await tap(target, 'Add team')
      await visible(target, 'Add; writes 0')
      await tap(target, 'Create team')
      await visible(target, 'Create; writes 0')
      await tap(target, 'Open Demo Hawks')
      await visible(target, 'Opened team demo_hawks; writes 0')
      await tap(target, 'Open Demo Spring')
      await visible(target, 'Opened season demo_season; writes 0')
      await tap(target, 'Leave Demo Hawks from Demo League')
      await visible(target, 'Review relationship changes')
      await tap(target, 'Cancel')
      await visible(target, 'Opened season demo_season; writes 0')
      await tap(target, 'Leave Demo Hawks from Demo League')
      await tap(target, 'Break relationship')
      await visible(target, 'Removed Demo Hawks; writes 1')
      await target.assertNotVisible({ text: 'Open Demo Hawks' })
      logs.push(
        `${target === m ? 'Chromium' : 'Simulator Safari'}: team/season navigation, Cancel without write, selected Leave once and refresh passed`
      )
    }
    for (const query of ['?empty', '?readonly']) {
      await m.openBrowser({ url: url + query })
      await contains(
        page,
        query === '?empty' ? 'No teams in this league yet.' : 'Demo Hawks'
      )
      assert.equal(
        await page.$('[aria-label="Leave Demo Hawks from Demo League"]'),
        null
      )
      if (query === '?empty') {
        const background = await page.$eval(
          '[data-testid="league-teams-card"]',
          n => getComputedStyle(n).backgroundColor
        )
        assert.equal(background, 'rgba(0, 0, 0, 0)')
      }
      logs.push(`${query}: no unauthorized Leave or empty card`)
    }
    fixture = await groupFixture(
      resolve('dist'),
      undefined,
      (router, _context) => {
        router.get('/test-login', (_req, res) => {
          assert(fixture != null)
          res.cookie('ts_session', fixture.h.tokens.get(101), {
            httpOnly: true
          })
          res.redirect(`/groups/league/${fixture.leagueA}?tab=teams`)
        })
      }
    )
    const f = fixture
    await m.openBrowser({ url: f.h.origin + '/test-login' })
    await contains(page, 'Demo Hawks')
    assert.notEqual(await page.$('[data-testid="league-teams-card"]'), null)
    await tap(m, 'Open Demo Hawks')
    await page.waitForFunction(
      id => location.pathname.includes(id),
      {},
      f.teamA
    )
    await contains(page, 'Demo Hawks')
    await m.openBrowser({
      url: `${f.h.origin}/groups/league/${f.leagueA}?tab=teams`
    })
    await tap(m, 'Open Demo Regular')
    await page.waitForFunction(
      id => location.pathname.includes(id),
      {},
      f.seasonA
    )
    await contains(page, 'Demo Regular')
    await m.openBrowser({
      url: `${f.h.origin}/groups/league/${f.leagueA}?tab=teams`
    })
    await tap(m, 'Leave Demo Hawks from Demo League A')
    await visible(m, 'Review relationship changes')
    await tap(m, 'Cancel')
    await visible(m, 'Open Demo Hawks')
    logs.push(
      'Finished app: actual League Teams card, real team and season destinations, Leave Cancel preserved relationship'
    )
  } finally {
    await writeFile(
      join(out, before ? 'baseline.log' : 'acceptance.log'),
      logs.join('\n') + '\n'
    )
    await simulator?.detach()
    await browser?.browser.disconnect()
    await daemon.shutdown()
    await fixture?.h.close()
    await new Promise<void>((resolve, reject) =>
      server.close(error => {
        if (error == null) resolve()
        else reject(error)
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
