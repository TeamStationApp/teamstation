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
  tap
} from '../../../e2e/rigs/refinementsMaestro'
import { makeId } from '../../common/ids'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { demoLocality, groupFixture } from '../../test/groupFixtures'
const artifacts = process.env.TS_NAVBAR_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_NAVBAR_ARTIFACTS')
const before = process.argv.includes('before')
const daemonName = process.env.TS_NAVBAR_DAEMON ?? 'navbarPop'

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(resolve('dist'))
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
  const tapCss = async (css: string): Promise<void> => {
    await page.waitForSelector(css, { timeout: 15000 })
    await m.tapOn({ css, timeout: 15000 })
  }
  // The player's own Videos pill is also a tab. The navbar is the tablist
  // with no name of its own.
  const tapTab = async (label: string): Promise<void> => {
    await tapCss(`[role="tablist"]:not([aria-label]) [aria-label="${label}"]`)
  }
  const settle = async (text: string): Promise<void> => {
    await contains(page, text)
    await page
      .waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
      .catch(() => undefined)
  }
  try {
    await note(
      `$ node -r sucrase/register src/app/navigation/navbarPop.e2e.ts${before ? ' before' : ''}`
    )
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
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true
    })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await m.openLink({ link: f.h.origin + '/' })
    await settle('Your Home')
    await settle('Demo Hawks')

    const openPlayerFromGame = async (): Promise<void> => {
      await tapCss('[aria-label="Demo Owls"], [aria-label*="Demo Owls"]')
      await settle('Demo Hawks')
      await tapCss('[role="link"][aria-label="Demo Hawks"]')
      await settle('Demo Hawks')
      await tapCss('[aria-label="Team sections"] [aria-label="Team"]')
      await tap(m, 'Alex L')
      await settle('Alex L')
    }
    const popped = async (
      tab: string,
      pathname: string,
      text: string,
      file: string
    ): Promise<void> => {
      await tapTab(tab)
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
      await popped('Home', '/', 'Your Home', 'home-root-after.png')
      await page.goBack({ waitUntil: 'domcontentloaded' })
      const text = (await page.evaluate(() => document.body.textContent)) ?? ''
      assert.equal(text.includes('Alex L'), false)
      assert.equal(text.includes('Demo Hawks'), false)
      await note('home back left the cleared player')
      await page.goForward({ waitUntil: 'domcontentloaded' })
      await settle('Your Home')
    }

    await tapTab('Videos')
    await settle('Game videos')
    await openPlayerFromGame()
    if (before) await shot('videos-deep-before.png')
    else
      await popped('Videos', '/videos', 'Game videos', 'videos-root-after.png')

    await tapTab('Schedule')
    await settle('Schedule')
    await openPlayerFromGame()
    if (before) await shot('schedule-deep-before.png')
    else
      await popped(
        'Schedule',
        '/schedule',
        'Schedule',
        'schedule-root-after.png'
      )

    await tapTab('Search')
    await settle('Discover')
    await tap(m, 'Leagues')
    await fill(m, 'Search by name or city', 'Demo League A')
    await tap(m, 'Open Demo League A')
    await settle('Demo League A')
    await tap(m, 'Open Demo Regular')
    await settle('Demo Regular')
    if (before) await shot('search-season-before.png')
    else
      await popped(
        'Search',
        '/discover',
        'Discover',
        'search-discover-after.png'
      )

    if (!before) {
      await tapTab('Home')
      await settle('Your Home')
      await tapCss('[role="button"][aria-label^="Demo Hawks"]')
      await settle('Demo Hawks')
      await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await openPlayerFromGame()
      await tapTab('Videos')
      await tapTab('Home')
      await settle('Alex L')
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
    await browser.disconnect()
    await daemon.shutdown()
    await f.h.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
