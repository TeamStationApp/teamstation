import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'

import express from 'express'
import puppeteer from 'puppeteer'

import { rosterEditFixture } from '../../../e2e/fixtures/scoringRosterEditFixture'
import { recordBrowserCoverage } from '../../../e2e/rigs/browserCoverage'
import { storedRecordOf } from '../../common/scoring/gumbo'
import type { GameSetup } from '../../common/scoring/state'
import { encodeLineupQr } from './lineupQrCodec'
import { lineupQrOf } from './lineupQrExport'
import { qrMatrix } from './lineupQrMatrix'
import type { ScoringSessionState, Side } from './scoringTypes'

/**
 * Lineup QR share on the scorekeeper's Set Team Rosters screen, in Chrome
 * through puppeteer, against `rosterEditFixture` and the production web
 * bundle, so the run's browser coverage maps back to the app's sources.
 *
 *   LINEUP_QR_SECTION       dense | all (default all)
 *   LINEUP_QR_PHASE         before | after (default after): names the dense shot
 *   LINEUP_QR_ARTIFACT_DIR  where screenshots go
 *   SCORING_FIXTURE_PORT    optional; an ephemeral port by default
 *
 * It builds the bundle itself (`TS_API_BASE_URL=/api/v1 node src/build.mjs`),
 * because a development server rewrites `dist/index.html` to name `app.js`.
 * With `all`, it writes the run's coverage to coverage/lineupQr/browser.json
 * for `npm run coverage.lineupQr`.
 */
const section = process.env.LINEUP_QR_SECTION ?? 'all'
const phase = process.env.LINEUP_QR_PHASE ?? 'after'
assert(['dense', 'all'].includes(section))
assert(['before', 'after'].includes(phase))
const artifacts = resolve(
  process.env.LINEUP_QR_ARTIFACT_DIR ?? 'coverage/lineupQr/artifacts'
)
const coverageFile = resolve('coverage/lineupQr/browser.json')
/** The Roster tab's row that opens Share Lineup. */
const SHARE = 'Share or import team lineup'

const listen = async (server: Server): Promise<number> =>
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address != null && typeof address === 'object')
      resolve(address.port)
    })
  })
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function main(): Promise<void> {
  execFileSync('node', ['src/build.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, TS_API_BASE_URL: '/api/v1' }
  })
  await mkdir(artifacts, { recursive: true })
  const assets = createServer(express().use(express.static(resolve('dist'))))
  const assetPort = await listen(assets)
  const fixture = await rosterEditFixture(
    `http://127.0.0.1:${assetPort}`,
    Number(process.env.SCORING_FIXTURE_PORT ?? 0)
  )
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.TS_CHROME_PATH,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader'
    ]
  })
  const page = await browser.newPage()
  const box = async (label: string): Promise<Box> => {
    const selector = `[aria-label="${label}"]`
    await page.waitForSelector(selector, { visible: true, timeout: 30000 })
    return await page.$$eval(selector, nodes => {
      const r = nodes[nodes.length - 1].getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }
  /** The Roster tab's first row opens Share Lineup. */
  const openShare = async (): Promise<void> => {
    await click('Roster')
    await click(SHARE)
  }
  /** The last control of this label: an open sheet's sits after the editor's. */
  const click = async (label: string): Promise<void> => {
    const selector = `[aria-label="${label}"]`
    await page.waitForSelector(selector, { visible: true, timeout: 30000 })
    await page.$$eval(selector, nodes => {
      ;(nodes[nodes.length - 1] as HTMLElement).click()
    })
    await pause(250)
  }
  const bodyText = async (): Promise<string> =>
    await page.evaluate(() => document.body.innerText)
  const waitText = async (text: string, present = true): Promise<void> => {
    await page.waitForFunction(
      (wanted: string, shown: boolean) =>
        document.body.innerText.includes(wanted) === shown,
      { timeout: 30000 },
      text,
      present
    )
  }
  const openRosters = async (): Promise<void> => {
    await click('Open scoring menu')
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[role="button"],[role="menuitem"]')
        ].some(node => node.textContent === 'Set Team Rosters'),
      { timeout: 30000 }
    )
    await page.evaluate(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="button"],[role="menuitem"]'
        )
      ].find(node => node.textContent === 'Set Team Rosters')
      item!.click()
    })
    await page.waitForSelector('[aria-label="Save Rosters"]', {
      visible: true,
      timeout: 30000
    })
    await pause(400)
  }
  const savedSetups = (): GameSetup[] =>
    [
      ...fixture.stored().plays,
      ...(fixture.stored().currentPlay == null
        ? []
        : [fixture.stored().currentPlay!])
    ]
      .flatMap(play => storedRecordOf(play)?.actions ?? [])
      .flatMap(action =>
        action.type === 'lineup' &&
        action.kind === 'roster' &&
        action.setup != null
          ? [action.setup]
          : []
      )
  /** The QR path the app must draw for a side of a saved setup. */
  const expectedPath = (setup: GameSetup, side: Side): string => {
    const draft = {
      gamePk: fixture.gameId,
      gameData: {
        teams: {
          away: { id: 'away', name: 'Owls', logoUrl: null },
          home: { id: 'home', name: 'Hawks', logoUrl: null }
        },
        players: setup.players
      },
      liveData: { boxscore: { teams: setup.sides } }
    } as unknown as ScoringSessionState
    return qrMatrix(encodeLineupQr(lineupQrOf(draft, side))).path
  }
  const qrPath = async (): Promise<string> =>
    await page.$eval(
      'svg[data-testid="qrCode"] path',
      // Plain script: sucrase turns ?? into a helper the page does not have.
      node => String(node.getAttribute('d'))
    )

  try {
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      includeRawScriptCoverage: true
    })
    const dense = section === 'dense'
    // The dense wide layout is a sheet under 440pt tall and at least 600pt
    // wide; the scenarios run at a phone's size.
    await page.setViewport(
      dense
        ? { width: 900, height: 420, deviceScaleFactor: 2 }
        : { width: 390, height: 844, deviceScaleFactor: 2 }
    )
    await page.goto(`${fixture.url}/games/${fixture.gameId}/score`, {
      waitUntil: 'networkidle0'
    })
    await openRosters()
    if (dense) {
      await click('Defense')
      await pause(600)
      await page.screenshot({
        path: join(artifacts, `roster-footer-dense-${phase}.png`)
      })
      console.log('Captured', `roster-footer-dense-${phase}`)
      return
    }

    // B1: the share row leads the Roster tab; the footer is Create Player
    // and Save Rosters over a Cancel in the middle, and saves as before.
    await click('Roster')
    await box(SHARE)
    const heights = await page.$$eval(
      '[data-testid="Edit roster players"] [role="button"]',
      nodes =>
        nodes.slice(0, 2).map(node => node.getBoundingClientRect().height)
    )
    assert(
      heights.length === 2 && Math.abs(heights[0] - heights[1]) < 1,
      `The share row is as tall as a player row (${heights.join(', ')})`
    )
    const save = await box('Save Rosters')
    const cancel = await box('Cancel')
    assert(
      !(await bodyText()).includes('Share Lineup'),
      'Share Lineup has left the footer'
    )
    assert(cancel.y >= save.y + save.height - 1, 'Cancel is below Save')
    // Cancel's word, not its stretched button, sits in the footer bar's middle.
    const bar = await page.$eval('[data-testid="Roster footer bar"]', node => {
      const r = node.getBoundingClientRect()
      return { x: r.x, width: r.width }
    })
    const word = await page.$$eval('[aria-label="Cancel"]', nodes => {
      const button = nodes[nodes.length - 1]
      // No `??` here: the page has no sucrase helpers.
      const label = button.querySelector('[dir="auto"]')
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      const r = (label == null ? button : label).getBoundingClientRect()
      return { x: r.x, width: r.width }
    })
    assert(
      word.width < bar.width / 3 &&
        Math.abs(word.x + word.width / 2 - (bar.x + bar.width / 2)) < 2,
      'Cancel is in the middle'
    )
    await page.screenshot({ path: join(artifacts, 'share-row-web.png') })
    await click('Lineup')
    const before = savedSetups().length
    // Every roster player starts in the order; Zack W comes out of it.
    await click('Remove Zack W')
    await click('Save Rosters')
    const until = Date.now() + 30000
    while (savedSetups().length === before && Date.now() < until)
      await pause(200)
    const saved = savedSetups().at(-1)
    assert(saved != null, 'Save Rosters saved the lineup')
    assert(
      !saved.sides.away.battingOrder.some(
        id => saved.players[id].fullName === 'Zack W'
      ),
      'The saved order leaves out the removed batter'
    )
    await openRosters()
    await click('Remove Adam D')
    await click('Cancel')
    await page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true,
      timeout: 30000
    })
    assert.equal(savedSetups().length, before + 1, 'Cancel saved nothing')
    console.log('PASS B1 footer, Save Rosters and Cancel')

    // B2: Generate shows the away lineup's QR code.
    await openRosters()
    await openShare()
    await waitText('Share/Import Lineup')
    await click('Generate QR to share lineup')
    await waitText('Share Lineup')
    const heading = await page.$$eval('[role="heading"]', nodes =>
      nodes.map(node => node.textContent)
    )
    assert(heading.includes('Owls'), 'The sheet names the away team')
    assert.equal(await qrPath(), expectedPath(saved, 'away'))
    await click('Cancel')
    await waitText('Share/Import Lineup', false)
    console.log('PASS B2 generate')

    // B3: the web says it cannot scan, and Cancel leaves the editor as it was.
    await openShare()
    await click('Scan QR code to import lineup')
    await waitText(
      'Unsupported on the web version of TeamStation. Please download the app.'
    )
    await click('Cancel')
    await waitText('Unsupported on the web version', false)
    assert(!(await bodyText()).includes('Share/Import Lineup'))
    assert.equal(
      await page.$eval('[aria-label="Save Rosters"]', node =>
        node.getAttribute('aria-disabled')
      ),
      'true',
      'Nothing changed'
    )
    console.log('PASS B3 unsupported scan')

    // B4: the chooser follows the slider to the home team.
    await click('Home Team')
    await openShare()
    await waitText('Share/Import Lineup')
    const home = await page.$$eval('[role="heading"]', nodes =>
      nodes.map(node => node.textContent)
    )
    assert(home.includes('Hawks'), 'The sheet names the home team')
    await click('Generate QR to share lineup')
    assert.equal(await qrPath(), expectedPath(saved, 'home'))
    await click('Cancel')
    console.log('PASS B4 home side')

    // B5: in a short landscape window the QR and the sheet's Cancel fit.
    for (const [width, height] of [
      [844, 390],
      [900, 420]
    ]) {
      await page.setViewport({ width, height, deviceScaleFactor: 2 })
      await pause(400)
      await openShare()
      await click('Generate QR to share lineup')
      await page.waitForSelector('svg[data-testid="qrCode"]', {
        visible: true
      })
      const qr = await page.$eval('svg[data-testid="qrCode"]', node => {
        const r = node.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom }
      })
      const sheetCancel = await box('Cancel')
      assert(
        qr.top >= 0 && qr.bottom <= height,
        `QR fits at ${width}×${height}`
      )
      assert(
        sheetCancel.y + sheetCancel.height <= height,
        `The sheet's Cancel is on screen at ${width}×${height}`
      )
      await click('Cancel')
      await page.waitForSelector('svg[data-testid="qrCode"]', { hidden: true })
    }
    console.log('PASS B5 short landscape window')

    await recordBrowserCoverage([page], fixture.url, coverageFile)
    const map = JSON.parse(await readFile(coverageFile, 'utf8')) as Record<
      string,
      unknown
    >
    assert(
      Object.keys(map).some(path =>
        path.endsWith('src/app/scoring/LineupShareSheet.tsx')
      ),
      'Browser coverage maps to LineupShareSheet.tsx'
    )
    console.log('Wrote', coverageFile)
  } finally {
    await browser.close()
    await fixture.close()
    assets.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
