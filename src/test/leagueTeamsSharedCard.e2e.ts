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

/** Each dark fixture state, and the row names it must show readably. */
const DARK_STATES: Array<[string, string[]]> = [
  ['seasons', ['Demo Spring']],
  ['parents', ['Demo League']],
  ['players', ['Aaron Judge', 'Mookie Betts']],
  ['seasonTeams', ['Demo Hawks', 'Willow Woods Westward Wanderers']],
  ['participations', ['Demo Spring']],
  ['blackout', ['Jun 14']],
  ['venue', ['Demo Other League', 'Demo League', 'Field 1']],
  ['schedule', ['Starts', 'Ends']]
]

function contrast(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const rgb = color
      .match(/\d+/g)!
      .slice(0, 3)
      .map(value => {
        const channel = Number(value) / 255
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4
      })
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Runs in the page: each named row title's colour and the card behind it. */
function nameColors(names: string[]): Array<[string, string]> {
  return names.map(name => {
    const title = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="relationship-action-row"] *'
      )
    ].find(node => node.children.length === 0 && node.textContent === name)!
    let surface: HTMLElement = title
    while (
      getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)' &&
      surface.parentElement != null
    )
      surface = surface.parentElement
    return [
      getComputedStyle(title).color,
      getComputedStyle(surface).backgroundColor
    ]
  })
}

/** Synthetic presentation plus finished-app navigation, driven by Maestro D. */
async function main(): Promise<void> {
  const out = process.env.TS_ARTIFACTS_DIR
  // The iOS Safari pass runs only with a simulator to run on.
  const device = process.env.TS_SIMULATOR_UDID
  assert(out != null, 'Supply artifacts directory')
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
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
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
    daemon = await maestro(process.env.MAESTRO_D ?? 'leagueTeamsSharedCard')
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
      ['chromium-large', '?large'],
      ['chromium-readonly', '?readonly']
    ]) {
      await m.openBrowser({ url: url + query })
      await contains(page, 'Demo Hawks')
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await writeFile(join(out, `${name}-${suffix}.png`), await m.screenshot())
      if (!before && query !== '?readonly') {
        const geometry = await page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(
            '[data-testid="league-teams-card"]'
          )!
          const ref = document.querySelector<HTMLElement>(
            '[data-testid="reference-parent"] [data-testid="relationship-action-row"]'
          )!.parentElement!
          const css = getComputedStyle(card)
          const reference = getComputedStyle(ref)
          const labels = ['Demo Hawks', 'Demo Spring', 'Leave'].map(text =>
            [...card.querySelectorAll<HTMLElement>('*')].find(
              node => node.children.length === 0 && node.textContent === text
            )!
          )
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
            labels: labels.map(label => getComputedStyle(label).color),
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
        const labelContrast = geometry.labels.map(color =>
          contrast(color, geometry.surface)
        )
        assert(labelContrast.every(ratio => ratio >= 4.5))
        assert.equal(geometry.rows, 2)
        assert.equal(geometry.children, 3)
        assert.equal(geometry.surface, geometry.reference)
        assert.equal(geometry.radius, geometry.referenceRadius)
        assert.equal(geometry.padding, '0px')
        assert(Math.abs(geometry.ratio - 0.8) < 0.02)
        assert(geometry.top > 0 && geometry.bottom > 0 && !geometry.overflow)
        assert(geometry.targets.every(height => height >= 48))
        logs.push(
          `${name}: ${JSON.stringify({ ...geometry, contrast: labelContrast })}`
        )
      }
    }
    await m.openBrowser({ url: url + '?large&longLink' })
    await contains(page, '2027 Spring Regular Season Majors Division')
    await writeFile(
      join(out, `chromium-long-link-large-${suffix}.png`),
      await m.screenshot()
    )
    if (!before) {
      const link = await page.evaluate(() => {
        const label = [...document.querySelectorAll<HTMLElement>('*')].find(
          node =>
            node.children.length === 0 &&
            node.textContent === '2027 Spring Regular Season Majors Division'
        )!
        const divider = document
          .querySelector<HTMLElement>(
            '[data-testid="relationship-action-divider"]'
          )!
          .getBoundingClientRect()
        const button = label
          .closest<HTMLElement>('[role="button"]')!
          .getBoundingClientRect()
        return {
          right: label.getBoundingClientRect().right,
          bottom: label.getBoundingClientRect().bottom,
          buttonBottom: button.bottom,
          buttonHeight: button.height,
          dividerLeft: divider.left,
          clipped: label.scrollWidth > label.clientWidth
        }
      })
      assert(link.right <= link.dividerLeft && !link.clipped)
      assert(link.bottom <= link.buttonBottom && link.buttonHeight > 48)
      logs.push(`long season link, large text: ${JSON.stringify(link)}`)
    }
    await m.openBrowser({ url: url + '?empty' })
    await contains(page, 'No teams in this league yet.')
    await writeFile(
      join(out, `chromium-empty-${suffix}.png`),
      await m.screenshot()
    )
    for (const [state, names] of DARK_STATES) {
      // Tall enough for the venue's Fields list, below the phone's fold.
      await page.setViewport({
        width: 390,
        height: state === 'venue' ? 1500 : 844
      })
      await m.openBrowser({ url: `${url}?dark&${state}` })
      for (const name of names) await contains(page, name)
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await writeFile(
        join(out, `chromium-${state}-dark-${suffix}.png`),
        await m.screenshot()
      )
      if (!before) {
        const ratios = (await page.evaluate(nameColors, names)).map(
          ([color, surface]) => contrast(color, surface)
        )
        assert(
          ratios.every(ratio => ratio >= 4.5),
          `${state}: ${ratios.join()}`
        )
        logs.push(`${state} dark: name contrast ${JSON.stringify(ratios)}`)
      }
    }
    await page.setViewport({ width: 390, height: 844 })
    await m.openBrowser({ url })
    await contains(page, 'Demo Hawks')
    if (device != null) {
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
    }
    if (before) return
    for (const target of simulator == null ? [m] : [m, simulator]) {
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
    const realCard = await page.$eval(
      '[data-testid="league-teams-card"]',
      card => {
        const css = getComputedStyle(card)
        return {
          surface: css.backgroundColor,
          radius: parseFloat(css.borderTopLeftRadius),
          rows: card.querySelectorAll('[data-testid="relationship-action-row"]')
            .length
        }
      }
    )
    assert.notEqual(realCard.surface, 'rgba(0, 0, 0, 0)')
    assert(realCard.radius > 0 && realCard.rows > 0)
    logs.push(`Finished app card: ${JSON.stringify(realCard)}`)
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
    await Promise.all([
      writeFile(
        join(out, before ? 'baseline.log' : 'acceptance.log'),
        logs.join('\n') + '\n'
      ),
      (async () => {
        try {
          await simulator?.detach()
          await browser?.browser.disconnect()
        } finally {
          await daemon?.shutdown()
        }
      })(),
      fixture?.h.close(),
      new Promise<void>((resolve, reject) =>
        server.close(error => {
          if (error == null) resolve()
          else reject(error)
        })
      )
    ])
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
