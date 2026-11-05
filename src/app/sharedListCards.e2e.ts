import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'
import type { Page } from 'puppeteer'

import { TeamStationClient } from '../common/api'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  contains,
  maestro
} from '../test/refinementsMaestro.e2e'
import { seedSettingsCleanup3 } from '../test/settingsCleanup3Fixture'

// npm run build.web, then TS_CREATION_ARTIFACTS=<dir> node -r
// sucrase/register src/app/sharedListCards.e2e.ts [--before]. Supply the local
// TS_MAESTRO_D_CLIENT and MAESTRO_D_BIN. Every server/database/browser is owned.
// --use-built-web reuses the retained web-before/web-after bundle for recapture.
async function main(): Promise<void> {
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  assert(artifacts != null, 'Supply TS_CREATION_ARTIFACTS')
  const before = process.argv.includes('--before')
  const phase = before ? 'before' : 'after'
  const web = resolve(artifacts, 'support', `web-${phase}`)
  if (!process.argv.includes('--use-built-web')) {
    await mkdir(web, { recursive: true })
    await cp(resolve('dist'), web, { recursive: true })
    const { webSettings } = await import(
      resolve('scripts/web-build-settings.mjs')
    )
    await build({
      ...webSettings,
      entryPoints: ['src/test/sharedListCards.fixture.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(web, 'fixture.js'),
      define: {
        __DEV__: 'false',
        global: 'globalThis',
        'process.env': '{}',
        'process.env.NODE_ENV': '"production"',
        'process.env.TS_SENTRY_DSN': '""'
      },
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
    })
    const html = (await readFile(join(web, 'index.html'), 'utf8')).replace(
      /<script[^>]*src="\/app-[^"]+"[^>]*><\/script>/,
      '<script src="/fixture.js"></script>'
    )
    assert(html.includes('src="/fixture.js"'))
    await writeFile(join(web, 'index.html'), html)
  }
  const f = await groupFixture(web)
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let session: Awaited<ReturnType<typeof browserSession>> | undefined
  const lines = [
    `$ node -r sucrase/register src/app/sharedListCards.e2e.ts${before ? ' --before' : ''}${process.argv.includes('--use-built-web') ? ' --use-built-web' : ''}`
  ]
  try {
    await seedSettingsCleanup3(f)
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    const kept = await api.createGroup({
      kind: 'team',
      name: 'Willow Woods Westward Wanderers',
      external: true,
      custodian: { kind: 'league', id: f.leagueA },
      idempotencyKey: 'shared-list-kept'
    })
    daemon = await maestro(`shared-cards-${phase}-${process.pid}`)
    session = await browserSession(
      daemon,
      `shared-cards-${phase}-${process.pid}`,
      390,
      844,
      artifacts,
      'chrome'
    )
    const { m, page, browser } = session
    page.on('pageerror', error => {
      console.error('Browser error:', error)
    })
    page.on('console', message => {
      if (message.type() === 'error')
        console.error('Browser console:', message.text())
    })
    const login = async (id: number): Promise<void> => {
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(id)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
    }
    await login(101)
    let dark = false
    let large = false
    const go = async (path: string, wanted: string): Promise<void> => {
      const url = new URL(path, f.h.origin)
      url.searchParams.set('fixtureTheme', dark ? 'dark' : 'light')
      url.searchParams.set('fixtureLarge', large ? '1' : '0')
      await m.openLink({ link: url.toString() })
      await contains(page, wanted)
      await page.waitForNetworkIdle({ idleTime: 150, timeout: 15000 })
      await page.evaluate(async () => await document.fonts.ready)
    }
    const tap = async (label: string): Promise<void> => {
      const css = `[aria-label="${label}"]`
      await m.scrollUntilVisible({
        element: { css },
        centerElement: true,
        timeout: 15000
      })
      await m.tapOn({ css, timeout: 15000 })
    }
    const shot = async (name: string): Promise<void> => {
      await writeFile(
        join(artifacts, `${name}-${phase}.png`),
        await m.screenshot()
      )
    }
    const teamsPath = `/groups/league/${f.leagueA}?tab=teams`
    for (const mode of ['light', 'dark-large'] as const) {
      dark = mode === 'dark-large'
      large = dark
      await page.setViewport({ width: dark ? 320 : 390, height: 844 })
      await go(teamsPath, 'Willow Woods Westward Wanderers')
      const teamRow = dark
        ? '[aria-label="Leave Winter Wolves from Willow Woods"]'
        : '[aria-label="Open Willow Woods Westward Wanderers"]'
      await m.scrollUntilVisible({
        element: { css: teamRow },
        centerElement: true
      })
      if (dark) {
        await m.command('scroll', { direction: 'DOWN' })
        await m.command('scroll', { direction: 'DOWN' })
        await new Promise(resolve => setTimeout(resolve, 350))
        await m.evalBrowserScript({
          script: `(() => {
            let node = document.querySelector('[aria-label="Leave Winter Wolves from Willow Woods"]');
            while (node != null) {
              if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
                node.scrollTop -= 40;
                return true;
              }
              node = node.parentElement;
            }
            return false;
          })()`
        })
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      const metrics = await collection(page, 'Open Winter Wolves')
      assert.equal(metrics.rows, 2)
      assert.equal(metrics.dividers, 1)
      for (const row of metrics.geometry) {
        assert(row.right <= metrics.viewport + 1, 'Row fits viewport')
        for (const target of row.targets) {
          assert(target.width >= 48 && target.height >= 48, '48-point target')
        }
        if (row.split != null) {
          assert(Math.abs(row.split.ratio - 0.8) < 0.025, '80% divider')
          assert(row.split.top > 0 && row.split.bottom > 0, 'Divider gaps')
        }
      }
      await shot(`league-teams-${mode}`)
      await go(`/groups/team/${f.teamA}/settings`, 'PARENT ORGANIZATIONS')
      const reference = await collection(page, 'Leave Willow Woods')
      if (!before) assert.deepEqual(metrics.surface, reference.surface)
      lines.push(`${mode}: ${JSON.stringify(metrics)}`)
      // Existing collection surfaces stay shared and use the same themed card.
      for (const [path, wanted, label] of [
        [`/groups/team/${f.teamA}/settings`, 'MANAGE PLAYERS', 'Remove Ichiro'],
        [
          `/groups/league/${f.leagueA}?tab=seasons`,
          'Winter Weekends',
          'Open Winter Weekends'
        ],
        [
          `/groups/season/${f.seasonA}?tab=teams`,
          'Winter Wolves',
          'Open Winter Wolves'
        ]
      ]) {
        await go(path, wanted)
        const existing = await collection(page, label)
        assert.deepEqual(existing.surface, reference.surface)
      }
      lines.push(
        `${mode}: Parent Organizations and all three existing collections match`
      )
    }
    if (before) return
    dark = false
    large = false
    await page.setViewport({ width: 390, height: 844 })
    await go(teamsPath, 'Winter Wolves')
    await tap('Add team')
    await page.waitForFunction(() => location.pathname.includes('/link'))
    await go(teamsPath, 'Winter Wolves')
    await tap('Create team')
    await m.tapOn({ text: 'Placeholder team', role: 'button' })
    await contains(page, 'Create Placeholder Team')
    await m.tapOn({ text: 'Cancel', role: 'button' })
    await contains(page, 'Willow Woods Westward Wanderers')
    lines.push(
      'PASS: Add opens relationship picker; Create opens placeholder flow; Cancel returns to league Teams'
    )
    assert.equal(
      await page.$(
        '[aria-label="Leave Willow Woods Westward Wanderers from Willow Woods"]'
      ),
      null
    )
    await tap('Open Winter Weekends')
    await page.waitForFunction(() => location.pathname.includes('/season/'))
    await go(teamsPath, 'Winter Wolves')
    await tap('Open Winter Wolves')
    await page.waitForFunction(() => /\/(teams|team)\//.test(location.pathname))
    await go(teamsPath, 'Winter Wolves')
    const parentsBefore = (await api.group({ kind: 'team', id: f.teamA }))
      .parents
    await tap('Leave Winter Wolves from Willow Woods')
    await contains(page, 'Review relationship changes')
    assert(
      page.url().includes(`/league/${f.leagueA}`),
      'Leave does not navigate'
    )
    await m.tapOn({ text: 'Cancel', role: 'button' })
    assert.deepEqual(
      (await api.group({ kind: 'team', id: f.teamA })).parents,
      parentsBefore
    )
    await tap('Leave Winter Wolves from Willow Woods')
    await m.tapOn({
      text: 'Break relationship',
      role: 'button',
      timeout: 15000
    })
    await page.waitForSelector(
      '[aria-label="Leave Winter Wolves from Willow Woods"]',
      { hidden: true }
    )
    assert(
      !(await api.group({ kind: 'team', id: f.teamA })).parents.some(
        parent => parent.id === f.leagueA
      )
    )
    assert(
      (await api.group({ kind: 'league', id: f.leagueA })).keptTeams.some(
        team => team.id === kept.id
      )
    )
    await go(teamsPath, 'Willow Woods Westward Wanderers')
    const onlyKept = await collection(
      page,
      'Open Willow Woods Westward Wanderers'
    )
    assert.equal(onlyKept.rows, 1)
    assert.equal(onlyKept.dividers, 0)
    await login(102)
    await go(teamsPath, 'Willow Woods Westward Wanderers')
    assert.equal(await page.$('[aria-label="Add team"]'), null)
    assert.equal(
      await page.$('[data-testid="relationship-action-divider"]'),
      null
    )
    await login(101)
    const empty = await api.createGroup({
      kind: 'league',
      name: 'Empty Example League',
      locality: {
        city: 'Demo City',
        region: 'Demo Region',
        country: 'US',
        placeId: null,
        timezone: 'UTC'
      },
      idempotencyKey: 'shared-empty'
    })
    await go(
      `/groups/league/${empty.id}?tab=teams`,
      'No teams in this league yet.'
    )
    const emptyList = await page.$eval(
      '[data-testid="league-teams-card"]',
      node => ({
        rows: node.children.length,
        radius: getComputedStyle(node).borderRadius,
        background: getComputedStyle(node).backgroundColor
      })
    )
    assert.equal(emptyList.rows, 0)
    assert.equal(emptyList.radius, '0px')
    assert.equal(emptyList.background, 'rgba(0, 0, 0, 0)')
    lines.push(
      'PASS: identity and season navigation; Leave cancellation sends no write; confirmation removes selected relationship; kept team survives; single/read-only/empty collections'
    )
  } catch (error) {
    if (session != null)
      await writeFile(
        join(artifacts, `failure-${phase}.png`),
        await session.m.screenshot()
      ).catch(() => undefined)
    throw error
  } finally {
    if (session != null) {
      await session.browser.disconnect()
      await session.m.detach().catch(() => undefined)
    }
    if (daemon != null) await daemon.shutdown()
    await f.h.close()
    await writeFile(
      join(artifacts, before ? 'browser-before.log' : 'browser.log'),
      lines.join('\n') + '\n'
    )
  }
}

async function collection(
  page: Page,
  label: string
): Promise<{
  rows: number
  dividers: number
  surface: Record<string, string>
  viewport: number
  geometry: Array<{
    right: number
    targets: Array<{ width: number; height: number }>
    split: null | { ratio: number; top: number; bottom: number }
  }>
}> {
  return await page.evaluate(label => {
    const button = document.querySelector(`[aria-label="${label}"]`)!
    const row = button.closest('[data-testid="relationship-action-row"]')!
    const card = row.parentElement!
    const style = getComputedStyle(card)
    const rows = [...card.children].filter(
      node => node.getAttribute('data-testid') === 'relationship-action-row'
    )
    return {
      rows: rows.length,
      dividers: card.children.length - rows.length,
      surface: Object.fromEntries(
        [
          'background-color',
          'border-radius',
          'border-width',
          'border-color',
          'box-shadow',
          'padding-top',
          'padding-left'
        ].map(key => [key, style.getPropertyValue(key)])
      ),
      viewport: innerWidth,
      geometry: rows.map(node => {
        const bounds = node.getBoundingClientRect()
        const divider = node.querySelector(
          '[data-testid="relationship-action-divider"]'
        )
        const split = divider == null ? null : divider.getBoundingClientRect()
        return {
          right: bounds.right,
          targets: [...node.querySelectorAll('[role="button"]')].map(target => {
            const box = target.getBoundingClientRect()
            return { width: box.width, height: box.height }
          }),
          split:
            split == null
              ? null
              : {
                  ratio: split.height / bounds.height,
                  top: split.top - bounds.top,
                  bottom: bounds.bottom - split.bottom
                }
        }
      })
    }
  }, label)
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
