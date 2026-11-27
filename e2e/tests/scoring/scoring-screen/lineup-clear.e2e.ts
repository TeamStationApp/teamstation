import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  artifactDir,
  click,
  open,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * E5: the lineup's Clear and its lock at the first pitch. Before the first
 * pitch the Lineup header has a red Clear on its right, each row a red X, and
 * Clear empties the order; after a pitch there is neither, a bench player
 * dropped on a row takes that slot, a swap of slots 3 and 4 bats the man now
 * in slot 3, and the bat icon marks that slot. With TS_CAPTURE_ONLY=1 (the
 * before pictures, taken on the base revision) only the pictures are taken,
 * and nothing is asserted; pictures go to TS_SCORING_ARTIFACT_DIR as
 * `<name>-<TS_ARTIFACT_PHASE>.png`.
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
  await page.setViewport({ width: 402, height: 874, deviceScaleFactor: 2 })
  await page.waitForSelector('canvas[data-field-ready="true"]', {
    timeout: 30000
  })
  return page
}
async function picture(page: Page, name: string): Promise<void> {
  const dir = artifactDir()
  if (dir == null || dir === '') return
  await mkdir(dir, { recursive: true })
  await settle(page)
  await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
}
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(animation => animation.playState !== 'running')
  )
  await new Promise(resolve => setTimeout(resolve, 300))
}
/** The away team's roster sheet, on its Lineup tab. */
async function lineupTab(page: Page): Promise<void> {
  await click(page, 'Open scoring menu')
  await click(page, 'Set Team Rosters')
  await page.waitForSelector('[aria-label="Save Rosters"]')
  await click(page, 'Lineup')
  await page.waitForSelector('[data-roster-target="lineup-0"]', {
    visible: true
  })
}
/** The batting order shown, by name. */
async function order(page: Page): Promise<string[]> {
  return await page.$$eval(
    '[data-roster-target^="lineup-"][data-roster-player]',
    nodes =>
      nodes.map(node =>
        String(node.textContent)
          .replace(/^\D*\d+\. (#\S+ )?/, '')
          .replace(/\W+$/, '')
      )
  )
}
/** A mouse drag, held until the card lifts, from `source` onto `target`. */
async function dragOnto(
  page: Page,
  source: string,
  target: string
): Promise<void> {
  await page.$eval(source, node => {
    node.scrollIntoView({ block: 'center' })
  })
  const centre = async (selector: string): Promise<[number, number]> =>
    await page.$eval(selector, node => {
      const r = node.getBoundingClientRect()
      return [r.x + Math.min(40, r.width / 2), r.y + r.height / 2] as [
        number,
        number
      ]
    })
  const from = await centre(source)
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.waitForSelector('[data-testid="Roster dragged card"]')
  const to = await centre(target)
  await page.mouse.move(...to, { steps: 12 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await page.mouse.up()
  await settle(page)
}
/** Four balls to the batter, and the next one up. */
async function walk(page: Page, next: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await waitReady(page)
    await click(page, 'Ball')
  }
  await page.waitForSelector(`[aria-label*="Batter ${next}"]`, {
    timeout: 45000
  })
}

it('offers a red Clear on the Lineup header and an X per row before the first pitch, and Clear empties the order', async function () {
  const page = await openPhone()
  try {
    await lineupTab(page)
    await picture(page, 'lineup-header')
    if (capturing) return
    const header = await page.$eval('[data-testid="Lineup header"]', node => {
      const words = Array.from(node.querySelectorAll('*'))
        .filter(
          each =>
            each.children.length === 0 &&
            ['Lineup', 'Clear'].includes(String(each.textContent))
        )
        .map(each => {
          const r = each.getBoundingClientRect()
          const style = window.getComputedStyle(each)
          return {
            text: String(each.textContent),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            color: style.color,
            clipped: each.scrollWidth > each.clientWidth + 1
          }
        })
      const r = node.getBoundingClientRect()
      return { words, right: r.right }
    })
    const lineup = header.words.find(word => word.text === 'Lineup')!
    const clear = header.words.find(word => word.text === 'Clear')!
    expect(lineup, 'Lineup').not.equals(undefined)
    expect(clear, 'Clear').not.equals(undefined)
    // One row: Lineup on the left, Clear right-justified, both whole.
    expect(clear.left).greaterThan(lineup.right)
    expect(Math.abs(clear.right - header.right)).lessThan(2)
    expect(Math.abs(clear.top - lineup.top)).lessThan(4)
    expect(clear.clipped || lineup.clipped).equals(false)
    // The sheet's own red, scoringSurface.danger (55c74b3f4).
    expect(clear.color).equals('rgb(248, 113, 113)')
    const rows = (await order(page)).length
    expect(rows).equals(9)
    expect(
      await page.$$eval(
        '[data-roster-target^="lineup-"] [aria-label^="Remove "]',
        nodes => nodes.length
      )
    ).equals(rows)
    await click(page, 'Clear Lineup')
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-roster-target^="lineup-"][data-roster-player]'
        ).length === 0
    )
    // Every player is back in the roster column.
    expect(
      await page.$$eval(
        '[data-roster-target="roster"] [data-roster-player]',
        nodes => nodes.length
      )
    ).equals(9)
    await click(page, 'Cancel')
  } finally {
    await page.close()
  }
})

it('locks the lineup at the first pitch: no Clear or X, a bench drop replaces, and a swap of slots 3 and 4 bats the new slot 3 under the bat', async function () {
  const page = await openPhone()
  try {
    // Player 9 sits before the game; two walks bring up slot 3.
    await lineupTab(page)
    await click(page, 'Remove Player 9')
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    // Eight batters: the scorer accepts the short lineup.
    await click(page, 'Accept Lineup')
    await walk(page, 'Player 2')
    await walk(page, 'Player 3')
    await lineupTab(page)
    await picture(page, 'lineup-after-pitch')
    if (capturing) return
    expect(await page.$('[aria-label="Clear Lineup"]')).equals(null)
    expect(await page.$('[aria-label^="Remove Player"]')).equals(null)
    const batSlot = async (): Promise<string | null> =>
      await page.$eval('[data-testid="batIcon"]', node =>
        node.closest('[data-roster-target]')!.getAttribute('data-roster-target')
      )
    expect(await batSlot()).equals('lineup-2')
    // The bench player dropped on slot 6 replaces Player 6 there.
    const shown = await order(page)
    expect(shown[5]).equals('Player 6')
    await dragOnto(
      page,
      '[data-roster-target="roster"] [aria-label="Add Player 9 to Lineup"]',
      '[data-roster-target="lineup-5"]'
    )
    expect(await order(page)).deep.equals(
      shown.map((name, slot) => (slot === 5 ? 'Player 9' : name))
    )
    expect(
      await page.$('[aria-label="Add Player 6 to Lineup"]'),
      'Player 6 on the roster'
    ).not.equals(null)
    // Slot 4 dropped on slot 3: the two swap, and the bat stays on slot 3.
    await dragOnto(
      page,
      '[aria-label="Reorder Player 4"]',
      '[data-roster-target="lineup-2"]'
    )
    expect((await order(page)).slice(2, 4)).deep.equals([
      'Player 4',
      'Player 3'
    ])
    expect(await batSlot()).equals('lineup-2')
    expect(
      await page.$eval('[data-testid="batIcon"]', node =>
        node.getAttribute('aria-label')
      )
    ).equals('Player 4 bats')
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label*="Batter Player 4"]', {
      timeout: 30000
    })
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/lineup-clear',
  title: 'The lineup is cleared before the first pitch and locked after it',
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
  minutes: 6,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
