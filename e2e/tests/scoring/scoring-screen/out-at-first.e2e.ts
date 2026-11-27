import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { placeOffered, setTrajectory } from '../../../rigs/fieldPointer'
import {
  artifactDir,
  click,
  fieldOf,
  open,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * E3: Out at First is a Batter Out row of its own on a swing and a bunt. A
 * ball the shortstop fields goes to first with no receiver to choose, the
 * shortstop assisting and the first baseman taking the putout; a ball the
 * first baseman fields asks who took it; with nobody at first a nameless
 * stand-in takes the throw and nobody is credited. Each play's box score is
 * printed (`box:` lines) from what the page saved. With TS_CAPTURE_ONLY=1
 * (the before picture, taken on the base revision) only the menu picture is
 * taken and nothing is asserted; pictures go to TS_SCORING_ARTIFACT_DIR as
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

/** A fielding credit as the saved play document writes it. */
interface SavedCredit {
  credit: string
  position: { abbreviation: string }
  player?: { id: number }
}
interface SavedPlay {
  about: { atBatIndex: number }
  runners?: Array<{
    details: { runner: { id: number }; event?: string }
    movement: { isOut: boolean; outBase?: string | null }
    credits: SavedCredit[]
  }>
}
/** The plays the page saved, the latest version of each. */
type Saved = Map<number, SavedPlay>

async function openPhone(): Promise<{ page: Page; saved: Saved }> {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    true
  )
  const saved: Saved = new Map()
  // The save each play was last seen in, so a later save always wins.
  const seenIn = new Map<number, number>()
  let saves = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (
      request.method() !== 'POST' ||
      url.pathname !== '/api/v1/games/g1/events'
    )
      return
    const save = ++saves
    const read = async (): Promise<void> => {
      const change = JSON.parse((await request.fetchPostData()) ?? '{}') as {
        plays?: SavedPlay[]
        currentPlay?: SavedPlay | null
      }
      for (const play of [...(change.plays ?? []), change.currentPlay]) {
        if (play?.about == null) continue
        const index = play.about.atBatIndex
        if ((seenIn.get(index) ?? 0) > save) continue
        seenIn.set(index, save)
        saved.set(index, play)
      }
    }
    read().catch(() => undefined)
  })
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
  return { page, saved }
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
/** The Batter Out rows the open menu lists, in order. */
async function batterOutRows(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label]'))
      .map(node => node.getAttribute('aria-label')!)
      .filter(label =>
        [
          'Throw Out',
          'Ground Out',
          'Out at First',
          'Ball Caught',
          'Batter Interference'
        ].includes(label)
      )
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
/**
 * An Out at First fielded by the player `presses` steps along the list
 * the field offers: P, C, 1B, 2B, SS with the whole defense out.
 */
async function outAtFirst(page: Page, presses: number): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  await click(page, 'Batter Out')
  await click(page, 'Out at First')
  await page.waitForSelector(
    '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await place(page, presses)
  await setTrajectory(fieldOf(page), -10)
}
async function oneOut(page: Page): Promise<void> {
  await page.waitForSelector(
    '[aria-label*=" 1 outs"], [aria-label*=" 1 out"]',
    { timeout: 30000 }
  )
}
/** Ends the play: with nobody on it closes once its correction time is up. */
async function nextBatter(page: Page): Promise<void> {
  if ((await page.$('[aria-label="Finish at-bat"]')) != null)
    await click(page, 'Finish at-bat')
  await page.waitForSelector('[aria-label*="Batter Player 2"]', {
    timeout: 30000
  })
}
/**
 * The fielding box score of the saved plays, a line per credit: putouts
 * and assists by position, and the player credited (nobody for a
 * stand-in). Printed for the proving log.
 */
/** The fixture's names: the hosts are Player 1–9 (201–209). */
function name(id: number): string {
  return id > 200
    ? `Player ${id - 200}`
    : id === 101
      ? 'Jordan K.'
      : `Player ${id - 100}`
}
async function boxScore(saved: Saved, title: string): Promise<string[]> {
  for (let wait = 0; wait < 100; wait++) {
    if (
      [...saved.values()].some(play =>
        (play.runners ?? []).some(runner => runner.movement.isOut)
      )
    )
      break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const lines = [...saved.values()]
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
    .flatMap(play =>
      (play.runners ?? []).flatMap(runner =>
        runner.credits.map(
          credit =>
            `${credit.credit === 'f_putout' ? 'PO' : credit.credit === 'f_assist' ? 'A' : credit.credit} ${credit.position.abbreviation} ${credit.player == null ? '(nobody)' : name(credit.player.id)}`
        )
      )
    )
  const outs = [...saved.values()].flatMap(play =>
    (play.runners ?? [])
      .filter(runner => runner.movement.isOut)
      .map(
        runner =>
          `${name(runner.details.runner.id)} ${runner.details.event ?? ''}, out at ${runner.movement.outBase ?? ''}`
      )
  )
  console.log(`box: ${title}`)
  for (const line of [...outs.map(out => `out: ${out}`), ...lines])
    console.log(`box:   ${line}`)
  return lines
}

for (const contact of ['Swing', 'Bunt'] as const)
  it(`lists Out at First under Batter Out on a ${contact.toLowerCase()}`, async function () {
    if (capturing && contact === 'Bunt') this.skip()
    const { page } = await openPhone()
    try {
      await waitReady(page)
      await click(page, `${contact} in Play`)
      await click(page, 'Batter Out')
      await page.waitForSelector(
        '[aria-label="Ground Out"], [aria-label="Throw Out"]'
      )
      if (contact === 'Swing') await picture(page, 'batter-out-menu', 300)
      if (capturing) return
      expect(await batterOutRows(page)).deep.equals([
        'Ground Out',
        'Out at First',
        'Ball Caught',
        'Batter Interference'
      ])
    } finally {
      await page.close()
    }
  })

it("throws the shortstop's ball to first with no prompt: SS assist, 1B putout", async function () {
  if (capturing) this.skip()
  const { page, saved } = await openPhone()
  try {
    await outAtFirst(page, 5)
    await oneOut(page)
    expect(
      await page.$('[aria-label^="Tap or drag the next defender"]')
    ).equals(null)
    await nextBatter(page)
    expect(await boxScore(saved, 'shortstop to first')).deep.equals([
      'A SS Player 5',
      'PO 1B Player 3'
    ])
  } finally {
    await page.close()
  }
})

it("asks who took the first baseman's own ball", async function () {
  if (capturing) this.skip()
  const { page, saved } = await openPhone()
  try {
    await outAtFirst(page, 3)
    await page.waitForSelector(
      '[aria-label^="Tap or drag the next defender"]',
      { timeout: 30000 }
    )
    // Nobody is out until the scorer says who took it.
    expect(await page.$('[aria-label*=" 1 out"]')).equals(null)
    // The pitcher covers first: first among the players the field offers.
    await place(page, 1)
    await tapEither(page, 'Finish defensive play')
    await oneOut(page)
    await nextBatter(page)
    expect(await boxScore(saved, 'first baseman to pitcher')).deep.equals([
      'A 1B Player 3',
      'PO P Player 1'
    ])
  } finally {
    await page.close()
  }
})

it('throws to a nameless stand-in at an empty first, crediting nobody', async function () {
  if (capturing) this.skip()
  const { page, saved } = await openPhone()
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Home Team')
    await click(page, 'Defense')
    await click(page, 'Clear 1B')
    await click(page, 'Save Rosters')
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save Rosters"]') == null,
      { timeout: 30000 }
    )
    await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
    // The players on the field come first: P, C, 2B, SS.
    await outAtFirst(page, 4)
    await oneOut(page)
    expect(
      await page.$('[aria-label^="Tap or drag the next defender"]')
    ).equals(null)
    await nextBatter(page)
    await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
    expect(await boxScore(saved, 'shortstop to an empty first')).deep.equals([
      'A SS Player 5',
      'PO 1B (nobody)'
    ])
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/out-at-first',
  title: 'Out at First under Batter Out, and who gets the putout',
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
  minutes: 16,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
