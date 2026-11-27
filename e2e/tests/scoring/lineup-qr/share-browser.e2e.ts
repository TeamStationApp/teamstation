import { strict as assert } from 'node:assert'

import { readJson } from '../../../core/readback'
import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { pause } from '../../../rigs/scoring/scorerSheets'
import {
  beginRoster,
  playsOf,
  type Roster
} from '../roster-edit/player-settings.e2e'

/**
 * Lineup QR share on the scorekeeper's Set Team Rosters screen in a
 * phone-sized window of the runner's browser: the share row as tall as a
 * player's, the footer's red Cancel beside Save Rosters, a save and a
 * cancelled edit read back from the book, each team's QR code drawn from
 * what was saved, the web's word that it cannot scan, and the code and its
 * Cancel kept on screen in a short landscape window. Every press is a
 * maestro-d step; the page is only read.
 */

const SHARE = 'Share or import team lineup'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const label = (name: string): string => `[aria-label="${name}"]`

async function box(page: Page, name: string): Promise<Box> {
  await page.waitForSelector(label(name), { visible: true, timeout: 30000 })
  return await page.$$eval(label(name), nodes => {
    const r = nodes[nodes.length - 1].getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

/** Presses the last control named `name`: an open sheet's sits after the editor's. */
async function click(run: Roster, name: string): Promise<void> {
  const page = run.s.web!.page
  await page.waitForSelector(label(name), { visible: true, timeout: 30000 })
  await run.s.m.evalBrowserScript({
    script: `const nodes = document.querySelectorAll(${JSON.stringify(label(name))}); nodes[nodes.length - 1].click()`
  })
  await pause(250)
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText)
}

async function waitText(
  page: Page,
  text: string,
  present = true
): Promise<void> {
  await page.waitForFunction(
    (wanted: string, shown: boolean) =>
      document.body.innerText.includes(wanted) === shown,
    { timeout: 30000 },
    text,
    present
  )
}

async function openRosters(run: Roster): Promise<void> {
  const page = run.s.web!.page
  await click(run, 'Open scoring menu')
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="button"],[role="menuitem"]')].some(
        node => node.textContent === 'Set Team Rosters'
      ),
    { timeout: 30000 }
  )
  await run.s.m.evalBrowserScript({
    script:
      '[...document.querySelectorAll(\'[role="button"],[role="menuitem"]\')].find(node => node.textContent === \'Set Team Rosters\').click()'
  })
  await page.waitForSelector(label('Save Rosters'), {
    visible: true,
    timeout: 30000
  })
  await pause(400)
}

export default defineHarness({
  id: 'scoring/lineup-qr/share-browser',
  title: "The web roster screen shares each team's saved lineup as a QR code",
  kind: 'e2e',
  covers: [
    'src/app/scoring/LineupShareSheet.tsx',
    'src/app/scoring/lineupQrCodec.ts',
    'src/app/scoring/lineupQrExport.ts',
    'src/app/scoring/lineupQrMatrix.ts',
    'src/app/scoring/ScoringScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['roster-edit'],
  exclusive: false,
  surfaces: {
    // The roster sheet sits over the 3D field: the Mac's browser, with a GPU.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // The dense wide layout: a sheet under 440pt tall and 600pt or wider.
    dense: async ctx => {
      const run = await beginRoster(ctx)
      await run.s.web!.resize({ width: 900, height: 420 })
      await run.s.open(`games/${run.game}/score`)
      await openRosters(run)
      await click(run, 'Defense')
      await pause(600)
      await run.s.capture('roster-footer-dense')
    },
    'share-and-save': async ctx => {
      const run = await beginRoster(ctx)
      const { s } = run
      const page = s.web!.page
      const { recordOf } = await import('../../../../src/common/scoring/gumbo')
      const { withNames } =
        await import('../../../../src/common/scoring/storedNames')
      const { encodeLineupQr } =
        await import('../../../../src/app/scoring/lineupQrCodec')
      const { lineupQrOf } =
        await import('../../../../src/app/scoring/lineupQrExport')
      const { qrMatrix } =
        await import('../../../../src/app/scoring/lineupQrMatrix')
      const { ROSTER_PLAYERS } =
        await import('../../../../src/server/dev/fixtures/scoringSheets')
      const { signInTestAccount } =
        await import('../../../../src/test/passwordFixtures')
      const token = await signInTestAccount(
        `${ctx.stack.origin}/api/v1`,
        run.world.accounts.scorer
      )
      const teams = {
        away: { id: run.teams.away },
        home: { id: run.teams.home }
      }
      // The server keeps plays without the names of players who have ids:
      // the saved setups are read with the roster's names again.
      const names = new Map<number, string>(
        (['away', 'home'] as const).flatMap(side =>
          run.gumbos[side].map((gumbo, i): [number, string] => [
            gumbo,
            `${ROSTER_PLAYERS[i][0]} ${ROSTER_PLAYERS[i][1]}`
          ])
        )
      )
      const savedSetups = async (): Promise<any[]> =>
        playsOf(await run.book())
          .flatMap(
            play =>
              withNames(recordOf(play, teams) as any, names)?.actions ?? []
          )
          .flatMap((action: any) =>
            action.type === 'lineup' &&
            action.kind === 'roster' &&
            action.setup != null
              ? [action.setup]
              : []
          )
      const compactNames = new Map<number, string>()
      for (const side of ['away', 'home'] as const)
        for (const row of (await readJson(
          ctx.stack.origin,
          `/api/v1/teams/${run.teams[side]}/roster?includeFullNames=true`,
          { headers: { authorization: `Bearer ${token}` } }
        )) as Array<{ gumboId: number; compactName?: string | null }>)
          if (row.compactName != null)
            compactNames.set(row.gumboId, row.compactName)
      /** The QR path the app must draw for a side of a saved setup. */
      const expectedPath = (setup: any, side: 'away' | 'home'): string => {
        const draft = {
          gamePk: run.game,
          gameData: {
            teams: {
              away: { id: run.teams.away, name: 'Owls', logoUrl: null },
              home: { id: run.teams.home, name: 'Hawks', logoUrl: null }
            },
            // The code names each player by his public label, which the
            // roster the app reads gives a reader who sees full names.
            players: Object.fromEntries(
              Object.entries(setup.players).map(([id, player]) => [
                id,
                {
                  ...(player as object),
                  compactName: compactNames.get(Number(id))
                }
              ])
            )
          },
          liveData: { boxscore: { teams: setup.sides } }
        }
        return qrMatrix(encodeLineupQr(lineupQrOf(draft as any, side))).path
      }
      const qrPath = async (): Promise<string> =>
        await page.$eval('svg[data-testid="qrCode"] path', node =>
          String(node.getAttribute('d'))
        )
      const openShare = async (): Promise<void> => {
        await click(run, 'Roster')
        await click(run, SHARE)
      }

      // A phone's size, as the legacy run had it.
      await s.web!.resize({ width: 390, height: 844 })
      await s.open(`games/${run.game}/score`)
      await openRosters(run)

      // B1: the share row leads the Roster tab; the footer is one row of
      // Cancel, the microphone's place and Save Rosters, and saves as before.
      await click(run, 'Roster')
      await box(page, SHARE)
      const heights = await page.$$eval(
        '[data-testid="Edit roster players"] [role="button"]',
        nodes =>
          nodes.slice(0, 2).map(node => node.getBoundingClientRect().height)
      )
      assert(
        heights.length === 2 && Math.abs(heights[0] - heights[1]) < 1,
        `The share row is as tall as a player row (${heights.join(', ')})`
      )
      const save = await box(page, 'Save Rosters')
      assert(
        !(await bodyText(page)).includes('Share Lineup'),
        'Share Lineup has left the footer'
      )
      const bar = await page.$eval(
        '[data-testid="Roster footer bar"]',
        node => {
          const r = node.getBoundingClientRect()
          return { x: r.x, width: r.width }
        }
      )
      const word = await page.$eval('[data-testid="Roster cancel"]', node => {
        const r = node.getBoundingClientRect()
        const inBar = node.closest('[data-testid="Roster footer bar"]') != null
        const text = node.querySelector('[dir="auto"]')
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          inBar,
          fill: getComputedStyle(node).backgroundColor,
          // No `?.` here: the page has no sucrase helpers.
          text: text == null ? '' : getComputedStyle(text).color
        }
      })
      assert(word.inBar, 'Cancel is in the footer bar')
      assert(
        Math.abs(word.width - save.width) < 1 &&
          Math.abs(word.height - save.height) < 1,
        `Cancel is as large as Save Rosters (${word.width}×${word.height}, ${save.width}×${save.height})`
      )
      assert.equal(word.fill, 'rgb(168, 53, 53)', 'Cancel is filled red')
      assert.equal(word.text, 'rgb(255, 255, 255)', 'Cancel’s word is white')
      assert(
        Math.abs(word.y + word.height / 2 - (save.y + save.height / 2)) < 4,
        'Cancel is on Save Rosters’ row'
      )
      assert(
        word.x + word.width <= bar.x + bar.width / 2 &&
          save.x + save.width / 2 > bar.x + bar.width / 2,
        'Cancel is left of the middle, Save right of it'
      )
      await s.capture('share-row-web')
      await click(run, 'Lineup')
      const before = (await savedSetups()).length
      // Every roster player starts in the order; Zack Wheeler comes out.
      await click(run, 'Remove Zack Wheeler')
      await click(run, 'Save Rosters')
      const end = Date.now() + 30000
      while ((await savedSetups()).length === before && Date.now() < end)
        await pause(200)
      const saved = (await savedSetups()).at(-1)
      assert(saved != null, 'Save Rosters saved the lineup')
      assert(
        saved.sides.away.battingOrder.some(
          (id: string) => saved.players[id].fullName === 'Zack Wheeler'
        ) === false,
        'The saved order leaves out the removed batter'
      )
      await openRosters(run)
      await click(run, 'Lineup')
      await click(run, 'Remove Adam Duvall')
      await click(run, 'Cancel')
      await page.waitForSelector(label('Save Rosters'), {
        hidden: true,
        timeout: 30000
      })
      assert.equal(
        (await savedSetups()).length,
        before + 1,
        'Cancel saved nothing'
      )

      // B2: Generate shows the away lineup's QR code.
      await openRosters(run)
      await openShare()
      await waitText(page, 'Share/Import Lineup')
      await click(run, 'Generate QR to share lineup')
      await waitText(page, 'Share Lineup')
      const heading = await page.$$eval('[role="heading"]', nodes =>
        nodes.map(node => node.textContent)
      )
      assert(heading.includes('Owls'), 'The sheet names the away team')
      assert.equal(await qrPath(), expectedPath(saved, 'away'))
      await click(run, 'Cancel')
      await waitText(page, 'Share/Import Lineup', false)

      // B3: the web says it cannot scan; Cancel leaves the editor as it was.
      await openShare()
      await click(run, 'Scan QR code to import lineup')
      await waitText(
        page,
        'Unsupported on the web version of TeamStation. Please download the app.'
      )
      await click(run, 'Cancel')
      await waitText(page, 'Unsupported on the web version', false)
      assert(!(await bodyText(page)).includes('Share/Import Lineup'))
      assert.equal(
        await page.$eval(label('Save Rosters'), node =>
          node.getAttribute('aria-disabled')
        ),
        'true',
        'Nothing changed'
      )

      // B4: the chooser follows the slider to the home team.
      await click(run, 'Home Team')
      await openShare()
      await waitText(page, 'Share/Import Lineup')
      const home = await page.$$eval('[role="heading"]', nodes =>
        nodes.map(node => node.textContent)
      )
      assert(home.includes('Hawks'), 'The sheet names the home team')
      await click(run, 'Generate QR to share lineup')
      assert.equal(await qrPath(), expectedPath(saved, 'home'))
      await click(run, 'Cancel')

      // B5: in a short landscape window the QR and the sheet's Cancel fit.
      for (const [width, height] of [
        [844, 390],
        [900, 420]
      ]) {
        await s.web!.resize({ width, height })
        await pause(400)
        await openShare()
        await click(run, 'Generate QR to share lineup')
        await page.waitForSelector('svg[data-testid="qrCode"]', {
          visible: true
        })
        const qr = await page.$eval('svg[data-testid="qrCode"]', node => {
          const r = node.getBoundingClientRect()
          return { top: r.top, bottom: r.bottom }
        })
        const sheetCancel = await box(page, 'Cancel')
        assert(
          qr.top >= 0 && qr.bottom <= height,
          `QR fits at ${width}×${height}`
        )
        assert(
          sheetCancel.y + sheetCancel.height <= height,
          `The sheet's Cancel is on screen at ${width}×${height}`
        )
        await click(run, 'Cancel')
        await page.waitForSelector('svg[data-testid="qrCode"]', {
          hidden: true
        })
      }
    }
  }
})
