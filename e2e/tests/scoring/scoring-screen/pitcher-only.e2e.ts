import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  placeFielder,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  click,
  fieldOf,
  open,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * E2: scoring waits only for a pitcher, and a ball to an empty position is
 * played by a nameless stand-in. With TS_CAPTURE_ONLY=1 (the before
 * pictures, taken on the base revision) nothing is asserted, and pictures go
 * to TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
/*
 * Converted from the scoring screen's legacy browser suite: each mocha `it`
 * is a scenario of the same name, on the stack's web build and the
 * `scoring-field` world, in the Mac's Chrome (the field draws in 3D). The
 * old page-side API's switches (offline, stalled, held and refused saves,
 * a hidden opponent) are the stack's fault server and database
 * (`rigs/scoring/webScoring.ts`).
 */
const { add: it, scenarios } = suite()

const capturing = false
const phase = 'after'

async function openPhone(): Promise<Page> {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    true
  )
  await page.setViewport({
    width: 402,
    height: 874,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  })
  await page.waitForSelector('canvas[data-field-ready="true"]', {
    timeout: 30000
  })
  return page
}
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    async () =>
      await new Promise(resolve => {
        requestAnimationFrame(resolve)
      })
  )
}
async function picture(
  page: Page,
  name: string,
  settleMs = 1500
): Promise<void> {
  const dir = artifactDir()
  if (dir == null || dir === '') return
  await mkdir(dir, { recursive: true })
  await new Promise(resolve => setTimeout(resolve, settleMs))
  await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
}
/** Leaves on the hosts' defense only the positions named. */
async function fieldOnly(page: Page, kept: readonly string[]): Promise<void> {
  await click(page, 'Open scoring menu')
  await click(page, 'Set Team Rosters')
  // The hosts take the field in the top of the first.
  await click(page, 'Home Team')
  await click(page, 'Defense')
  for (const position of ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'])
    if (!kept.includes(position)) await click(page, `Clear ${position}`)
  await click(page, 'Save Rosters')
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Save Rosters"]') == null,
    { timeout: 30000 }
  )
}
async function shown(page: Page, text: string): Promise<boolean> {
  return await page.evaluate(
    said => document.body.innerText.includes(said),
    text
  )
}
async function ballEnabled(page: Page): Promise<boolean> {
  return await page.$eval(
    '[aria-label="Ball"]',
    node => node.getAttribute('aria-disabled') !== 'true'
  )
}
/** Places the player `presses` steps along the field's choosable list. */
/** The player `presses` places along what the field offers takes the ball. */
async function place(page: Page, presses: number): Promise<void> {
  await frame(page)
  await frame(page)
  await placeOffered(fieldOf(page), Math.max(0, presses - 1))
}
async function tapEither(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"], [aria-label="Bottom ${label}"]`
  await page.waitForSelector(selector, { timeout: 30000 })
  await click(
    page,
    (await page.$(`[aria-label="${label}"]`)) == null
      ? `Bottom ${label}`
      : label
  )
}

/** The fielder at `position` takes the ball, dragged where he fields it. */
async function placePosition(page: Page, position: string): Promise<void> {
  await frame(page)
  await placeFielder(fieldOf(page), position)
}

it('scores with only a pitcher, and plays a ground ball to an empty short with a nameless fielder', async function () {
  const page = await openPhone()
  try {
    await fieldOnly(page, ['P'])
    await picture(page, 'missing-defense')
    if (!capturing) {
      // No prompt: the pitch controls are live.
      expect(await shown(page, 'Missing defensive positions')).equals(false)
      expect(await shown(page, 'Assign a pitcher')).equals(false)
      await waitReady(page)
      expect(await ballEnabled(page)).equals(true)
      // Every empty position still has its plate to fill.
      for (const position of ['C', '1B', 'SS', 'RF'])
        expect(
          await page.$(`[aria-label="Assign ${position}"]`),
          position
        ).not.equals(null)
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label*="1 ball"]', { timeout: 30000 })
    }
    if (
      capturing &&
      !(await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[aria-label="Swing in Play"]:not([aria-disabled="true"]):not(:disabled)'
          )
        ).some(node => node.checkVisibility())
      ))
    ) {
      // The base revision puts no ball in play without a whole defense:
      // nobody can play the empty shortstop's spot.
      await picture(page, 'stand-in-fielder', 0)
      return
    }
    await click(page, 'Swing in Play')
    await click(page, 'Batter Out')
    await page.waitForSelector(
      '[aria-label="Ground Out"], [aria-label="Throw Out"]'
    )
    await click(
      page,
      (await page.$('[aria-label="Ground Out"]')) == null
        ? 'Throw Out'
        : 'Ground Out'
    )
    await page.waitForSelector(
      '[aria-label^="Tap or drag a player to where the ball was fielded"]'
    )
    if (capturing) {
      // The pitcher is first among the players the field offers, then the
      // empty positions in order: C, 1B, 2B, SS.
      await place(page, 5)
      // The base revision offers no empty position: the play cannot use
      // the shortstop's spot.
      await picture(page, 'stand-in-fielder', 500)
      return
    }
    // The empty shortstop's spot fields it.
    await placePosition(page, 'SS')
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    // While the play is open the shortstop's spot is a fielder, with no
    // name and no plate. The plates follow the field's next drawn frame.
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Assign SS"]') == null,
      { timeout: 2000 }
    )
    expect(await page.$('[aria-label="Assign 1B"]')).not.equals(null)
    // The angle the control starts at will do for a ground ball.
    await frame(page)
    await setTrajectory(fieldOf(page))
    await page.waitForSelector(
      '[aria-label^="Tap or drag the next defender"]',
      {
        timeout: 30000
      }
    )
    await picture(page, 'stand-in-fielder', 300)
    // The stand-in at short throws to the stand-in at first.
    await placePosition(page, '1B')
    await tapEither(page, 'Finish defensive play')
    await page.waitForSelector(
      '[aria-label*=" 1 outs"], [aria-label*=" 1 out"]',
      {
        timeout: 30000
      }
    )
    // With nobody on, the play closes once its correction time is up.
    if ((await page.$('[aria-label="Finish at-bat"]')) != null)
      await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    // The play over, short is an empty plate again.
    await page.waitForSelector('[aria-label="Assign SS"]', { timeout: 30000 })
    await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
    expect(await shown(page, 'Assign a pitcher')).equals(false)
  } finally {
    await page.close()
  }
})

it('waits for a pitcher once Clear P empties the mound', async function () {
  if (capturing) this.skip()
  const page = await openPhone()
  try {
    await fieldOnly(page, [])
    await page.waitForFunction(
      () => document.body.innerText.includes('Assign a pitcher'),
      { timeout: 30000 }
    )
    expect(await ballEnabled(page)).equals(false)
    expect(await page.$('[aria-label="Assign P"]')).not.equals(null)
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/pitcher-only',
  title: 'Scoring with only a pitcher on the field',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-field'],
  exclusive: false,
  surfaces: {
    // The field draws in 3D: a GPU, so the Mac's Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
