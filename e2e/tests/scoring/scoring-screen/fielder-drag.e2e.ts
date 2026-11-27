import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  artifactDir,
  click,
  open,
  suite
} from '../../../rigs/scoring/webScoring'

/**
 * E6: fielders drag between positions with no hold, and the defense has a red
 * Clear. On the hosts' Defense tab a touch that moves 9 px is a tap and clears
 * the position; one that moves 10 px lifts the card at once; a fielder dropped
 * on an empty position moves there and one dropped on an occupied position
 * swaps with the man there. Clear, level with Roster, empties every position,
 * the pitcher's too, and scoring then waits for a pitcher. With
 * TS_CAPTURE_ONLY=1 (the before pictures, taken on the base revision) only the
 * pictures are taken, and nothing is asserted; pictures go to
 * TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png`.
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
  const { page } = await open('/games/g1/score')
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
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(animation => animation.playState !== 'running')
  )
  await new Promise(resolve => setTimeout(resolve, 300))
}
async function picture(page: Page, name: string): Promise<void> {
  const dir = artifactDir()
  if (dir == null || dir === '') return
  await mkdir(dir, { recursive: true })
  await settle(page)
  await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
}
/** The hosts' roster sheet, on its Defense tab: they field first. */
async function defenseTab(page: Page): Promise<void> {
  await click(page, 'Open scoring menu')
  await click(page, 'Set Team Rosters')
  await page.waitForSelector('[aria-label="Save Rosters"]')
  await click(page, 'Home Team')
  await click(page, 'Defense')
  await page.waitForSelector('[data-roster-target="defense-P"]', {
    visible: true
  })
}
const card = (position: string): string =>
  `[data-roster-target="defense-${position}"]`
/** The player id at a position, or null when it is empty. */
async function fielder(page: Page, position: string): Promise<string | null> {
  return await page.$eval(card(position), node =>
    node.getAttribute('data-roster-player')
  )
}
async function centre(page: Page, selector: string): Promise<[number, number]> {
  return await page.$eval(selector, node => {
    const r = node.getBoundingClientRect()
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number]
  })
}
/**
 * A touch on `position`'s card that travels `distance` px right, with no
 * hold, then on to `target` when given. Resolves whether the card lifted
 * within 400 ms of the move.
 */
async function touchDrag(
  page: Page,
  position: string,
  distance: number,
  target?: string
): Promise<boolean> {
  const [x, y] = await centre(page, card(position))
  await page.touchscreen.touchStart(x, y)
  await page.touchscreen.touchMove(x + distance, y)
  const lifted = await page
    .waitForSelector('[data-testid="Roster dragged card"]', { timeout: 400 })
    .then(
      () => true,
      () => false
    )
  if (target != null) {
    const [tx, ty] = await centre(page, card(target))
    for (let step = 1; step <= 8; step++)
      await page.touchscreen.touchMove(
        x + distance + ((tx - x - distance) * step) / 8,
        y + ((ty - y) * step) / 8
      )
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await page.touchscreen.touchEnd()
  await settle(page)
  return lifted
}

it('drags fielders with no hold, swaps on an occupied position, and clears the defense from the red Clear at the field’s top right', async function () {
  const page = await openPhone()
  try {
    await defenseTab(page)
    await picture(page, 'defense-header')
    if (!capturing) {
      // No Roster title over the cards: blue Help and red Clear sit in the
      // field's top corners, clear of every position card.
      expect(await page.$('[data-testid="Defense roster header"]')).equals(null)
      const corners = await page.$eval(
        '[data-testid="Defensive field"]',
        field => {
          const box = (node: Element): DOMRect => node.getBoundingClientRect()
          const word = (
            label: string
          ): {
            left: number
            right: number
            top: number
            bottom: number
            color: string
          } | null => {
            const node = field.querySelector(`[aria-label="${label}"]`)
            if (node == null) return null
            const r = box(node)
            const text = node.querySelector('[dir="auto"]')
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              color: text == null ? '' : window.getComputedStyle(text).color
            }
          }
          const cards = Array.from(
            field.querySelectorAll('[data-testid$=" card"]')
          ).map(card => {
            const r = box(card)
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom
            }
          })
          const r = box(field)
          return {
            field: { left: r.left, right: r.right, top: r.top },
            help: word('Defense help'),
            clear: word('Clear Defense'),
            cards
          }
        }
      )
      const { field, help, clear, cards } = corners
      expect(help, 'Help').not.equals(null)
      expect(clear, 'Clear').not.equals(null)
      expect(help!.left - field.left).closeTo(4, 1)
      expect(field.right - clear!.right).closeTo(4, 1)
      expect(help!.top - field.top).closeTo(4, 1)
      expect(clear!.top - field.top).closeTo(4, 1)
      // The sheet's own red, scoringSurface.danger (55c74b3f4).
      expect(clear!.color).equals('rgb(248, 113, 113)')
      expect(cards).has.length(9)
      for (const control of [help!, clear!])
        for (const card of cards)
          expect(
            control.right <= card.left ||
              control.left >= card.right ||
              control.bottom <= card.top ||
              control.top >= card.bottom
          ).equals(true)
    }
    // Swap: first base's man dropped on short trades places with him.
    const first = await fielder(page, '1B')
    const short = await fielder(page, 'SS')
    const swapLifted = await touchDrag(page, '1B', 12, 'SS')
    await picture(page, 'fielder-swap')
    if (capturing) return
    expect(swapLifted, 'lifted with no hold').equals(true)
    expect(await fielder(page, 'SS')).equals(first)
    expect(await fielder(page, '1B')).equals(short)
    // A 9 px touch is a tap: the catcher's spot empties.
    const catcher = await fielder(page, 'C')
    expect(catcher).not.equals(null)
    expect(await touchDrag(page, 'C', 9)).equals(false)
    expect(await fielder(page, 'C')).equals(null)
    // A 10 px touch lifts the pitcher at once; dropped on the empty
    // catcher's spot he moves there and the mound empties.
    const pitcher = await fielder(page, 'P')
    expect(await touchDrag(page, 'P', 10, 'C')).equals(true)
    expect(await fielder(page, 'C')).equals(pitcher)
    expect(await fielder(page, 'P')).equals(null)
    // Clear empties every position.
    await click(page, 'Clear Defense')
    for (const position of ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'])
      expect(await fielder(page, position), position).equals(null)
    await click(page, 'Save Rosters')
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save Rosters"]') == null,
      { timeout: 30000 }
    )
    // Scoring waits for a pitcher.
    await page.waitForFunction(
      () => document.body.innerText.includes('Assign a pitcher'),
      { timeout: 30000 }
    )
    expect(
      await page.$eval(
        '[aria-label="Ball"]',
        node => node.getAttribute('aria-disabled') === 'true'
      )
    ).equals(true)
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/fielder-drag',
  title: 'Fielders are dragged, swapped and cleared',
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
  minutes: 10,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
