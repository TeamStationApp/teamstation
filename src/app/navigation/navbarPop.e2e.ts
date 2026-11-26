import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  browserSession,
  capture,
  contains,
  fill,
  log,
  maestro,
  navigationDaemonName,
  tap
} from '../../../e2e/rigs/refinementsMaestro'
import { makeId } from '../../common/ids'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { demoLocality, groupFixture } from '../../test/groupFixtures'
import {
  navigationCookies,
  type NavigationFixture,
  navigationFixture,
  type OwnedNavigationFixture
} from '../../test/navigationFixture.e2e'
import { navTabCss } from '../../test/navTab.e2e'
const artifacts = process.env.TS_NAVBAR_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_NAVBAR_ARTIFACTS')
const before = process.argv.includes('before')
const daemonName =
  process.env.TS_NAVBAR_DAEMON ?? navigationDaemonName('navbarPop')

async function seed(): Promise<OwnedNavigationFixture<NavigationFixture>> {
  const f = await groupFixture(resolve('dist'))
  try {
    // The account harness's own team is also named Demo Hawks; this script
    // follows the fixture's, so Home must show one team by that name.
    await f.h.db
      .updateTable('teams')
      .set({ name: 'Demo Harness Team' })
      .where('id', '=', 'tem_account')
      .execute()
    const owls = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Owls',
        parent: { kind: 'season', id: f.seasonA },
        locality: demoLocality,
        idempotencyKey: 'navbar-pop-owls'
      },
      101
    )
    assert.equal(owls.status, 201)
    const owlId = ((await owls.json()) as { id: string }).id
    const players = await f.h.request(
      'POST',
      `/teams/${f.teamA}/players`,
      {
        players: [
          {
            firstName: 'Alex',
            lastName: 'Lee',
            externalId: { system: 'demo', id: 'alex-lee', kind: 'person' }
          }
        ]
      },
      101
    )
    assert.equal(players.status, 200)
    const playerRow = (
      (await players.json()) as { results: Array<{ result: string }> }
    ).results[0]
    assert.ok(
      playerRow.result === 'created' || playerRow.result === 'joined',
      playerRow.result
    )
    const games = await f.h.request(
      'POST',
      `/teams/${f.teamA}/games`,
      {
        games: [
          {
            startAt: '2027-04-10T17:00:00Z',
            opponent: { teamId: owlId },
            seasonId: f.seasonA,
            side: 'home'
          }
        ]
      },
      101
    )
    assert.equal(games.status, 200)
    const scheduled = (
      (await games.json()) as {
        results: Array<{ result: string; gameId?: string; error?: unknown }>
      }
    ).results[0]
    assert.equal(scheduled.result, 'created', JSON.stringify(scheduled))
    const gameId = scheduled.gameId
    assert.ok(gameId != null && gameId !== '')
    const now = f.clock.now()
    await f.h.db
      .insertInto('videos')
      .values({
        id: makeId('video'),
        game_id: gameId,
        kind: 'program',
        storage: 'local',
        status: 'ready',
        title: 'Demo',
        created_at: now,
        updated_at: now
      })
      .execute()
    return {
      data: { origin: f.h.origin, token: f.h.tokens.get(101)! },
      close: f.h.close
    }
  } catch (error) {
    await f.h.close()
    throw error
  }
}

async function drive(data: NavigationFixture): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const daemon = await maestro(daemonName)
  const { m, page, browser } = await browserSession(
    daemon,
    `${daemonName}-phone`,
    402,
    874,
    artifacts!
  )
  const note = async (line: string): Promise<void> => {
    await log(artifacts!, 'navbar-pop.log', line)
  }
  const pathOf = async (): Promise<string> =>
    await page.evaluate(() => location.pathname + location.search)
  const labeled = async (label: string): Promise<boolean> =>
    (await page.$(`[aria-label="${label}"]`)) != null
  const shot = async (name: string): Promise<void> => {
    await capture(m, artifacts!, name)
  }
  // A covered screen keeps its rows in the DOM where no tap reaches them: mark
  // the top screen's match that a tap at its centre lands on, and tap that.
  const tapCss = async (css: string): Promise<void> => {
    await page.waitForSelector(css, { timeout: 15000 })
    const marked = await page.evaluate(selector => {
      const top = document.querySelector('[data-scene-role="top"]')
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Sucrase would compile `??` to a helper the browser does not have.
      for (const node of (top === null ? document : top).querySelectorAll(
        selector
      )) {
        node.scrollIntoView({ block: 'center' })
        const rect = node.getBoundingClientRect()
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        )
        if (hit !== null && node.contains(hit)) {
          node.setAttribute('data-e2e-tap', 'here')
          return true
        }
      }
      return false
    }, css)
    await m.tapOn({
      css: marked ? '[data-e2e-tap="here"]' : css,
      timeout: 15000
    })
    if (marked)
      await page.evaluate(() => {
        for (const node of document.querySelectorAll('[data-e2e-tap]'))
          node.removeAttribute('data-e2e-tap')
      })
  }
  const settle = async (text: string): Promise<void> => {
    await contains(page, text)
    await page
      .waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
      .catch(() => undefined)
    // A screen or a pill page still sliding out is in the page too, and a
    // selector can find its copy of a row just before it goes.
    await page.waitForSelector(
      '[data-scene-role="outgoing"], [data-page-role="outgoing"]',
      { hidden: true, timeout: 5000 }
    )
  }
  try {
    await note(
      `$ node -r sucrase/register src/app/navigation/navbarPop.e2e.ts${before ? ' before' : ''}`
    )
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true
    })
    await browser.setCookie(...navigationCookies(data, SESSION_COOKIE))
    await m.openLink({ link: data.origin + '/' })
    await settle('Your Home')
    await settle('Demo Hawks')

    const openPlayerFromGame = async (): Promise<void> => {
      await tapCss('[aria-label="Demo Owls"], [aria-label*="Demo Owls"]')
      await settle('Demo Hawks')
      await tapCss('[role="link"][aria-label="Demo Hawks"]')
      await settle('Demo Hawks')
      await tapCss('[aria-label="Team sections"] [aria-label="Team"]')
      await tap(m, 'Alex Lee')
      await settle('Alex Lee')
    }
    const popped = async (
      tab: Parameters<typeof navTabCss>[0],
      pathname: string,
      text: string,
      file: string
    ): Promise<void> => {
      await tapCss(navTabCss(tab))
      await settle(text)
      const path = await pathOf()
      await note(`${tab} pathname ${path}`)
      assert.equal(path, pathname)
      assert.equal(await labeled('Back'), false)
      await shot(file)
    }

    await tapCss('[role="button"][aria-label^="Demo Hawks"]')
    await settle('Demo Hawks')
    await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
    await settle('Demo Owls')
    await openPlayerFromGame()
    if (before) await shot('home-deep-before.png')
    else {
      await popped('home', '/', 'Your Home', 'home-root-after.png')
      await page.goBack({ waitUntil: 'domcontentloaded' })
      const text = (await page.evaluate(() => document.body.textContent)) ?? ''
      assert.equal(text.includes('Alex L'), false)
      assert.equal(text.includes('Demo Hawks'), false)
      await note('home back left the cleared player')
      await page.goForward({ waitUntil: 'domcontentloaded' })
      await settle('Your Home')
    }

    await tapCss(navTabCss('videos'))
    await settle('Game videos')
    await openPlayerFromGame()
    if (before) await shot('videos-deep-before.png')
    else
      await popped('videos', '/videos', 'Game videos', 'videos-root-after.png')

    await tapCss(navTabCss('schedule'))
    await settle('Schedule')
    await openPlayerFromGame()
    if (before) await shot('schedule-deep-before.png')
    else
      await popped(
        'schedule',
        '/schedule',
        'Schedule',
        'schedule-root-after.png'
      )

    await tapCss(navTabCss('search'))
    await settle('Discover')
    await fill(m, 'Search leagues, seasons, teams and people', 'Demo League A')
    await tap(m, 'Open Demo League A')
    await settle('Demo League A')
    await tap(m, 'Open Demo Regular')
    await settle('Demo Regular')
    if (before) await shot('search-season-before.png')
    else
      await popped(
        'search',
        '/discover',
        'Discover',
        'search-discover-after.png'
      )

    if (!before) {
      await tapCss(navTabCss('home'))
      await settle('Your Home')
      await tapCss('[role="button"][aria-label^="Demo Hawks"]')
      await settle('Demo Hawks')
      await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await openPlayerFromGame()
      await tapCss(navTabCss('videos'))
      await tapCss(navTabCss('home'))
      await settle('Alex Lee')
      const path = await pathOf()
      await note(`switch pathname ${path}`)
      assert.ok(path.startsWith('/players/'))
      assert.equal(
        ((await page.evaluate(() => document.body.textContent)) ?? '').includes(
          'Your Home'
        ),
        false
      )
      assert.equal(await labeled('Back'), true)
      await shot('switch-preserves-after.png')
    }
  } finally {
    await m.detach()
    await browser.close()
    await daemon.shutdown()
  }
}

async function main(): Promise<void> {
  await navigationFixture('navbarPop', seed, drive)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
