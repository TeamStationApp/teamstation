import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  dropOfferedRunner,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  click,
  dragRunner,
  fieldOf,
  open,
  overrideBases,
  runnerNearBase,
  suite,
  waitReady,
  waitRunnerNearBase
} from '../../../rigs/scoring/webScoring'

/**
 * E1: a ground out sends every other runner up a base. With TS_CAPTURE_ONLY=1
 * (the before pictures, taken on the base revision) only the scenarios that
 * take a picture run, and nothing is asserted. Pictures go to
 * TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png` (after by
 * default).
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
  // Let the last motion settle before the picture.
  await new Promise(resolve => setTimeout(resolve, settleMs))
  await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
}
/** The play stays open for correction for a few seconds: drag at once. */
async function correcting(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Time to edit play"]', {
    timeout: 30000
  })
}
/** The ground ball to the shortstop, the fifth player the field offers. */
async function groundOut(
  page: Page,
  contact: 'Swing' | 'Bunt' = 'Swing'
): Promise<void> {
  await waitReady(page)
  await click(page, `${contact} in Play`)
  await click(page, 'Batter Out')
  // The base revision calls it Throw Out.
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
  // The shortstop, fifth of the players the field offers.
  const field = fieldOf(page)
  await placeOffered(field, 4)
  await setTrajectory(field, contact === 'Swing' ? -10 : undefined)
  await page.waitForSelector('[aria-label^="Tap or drag the next defender"]', {
    timeout: 30000
  })
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
/** The shortstop holds the ball: the first baseman is third, and takes it. */
async function batterOutAtFirst(page: Page): Promise<void> {
  await place(page, 3)
  await tapEither(page, 'Finish defensive play')
}
async function outsShown(page: Page, outs: number): Promise<void> {
  await page.waitForSelector(`[aria-label*=" ${outs} outs"]`, {
    timeout: 30000
  })
}
async function score(page: Page, away: number): Promise<void> {
  await page.waitForSelector(`[aria-label*="Owls ${away} · Hawks 0"]`, {
    timeout: 30000
  })
}
async function stillNear(page: Page, base: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await runnerNearBase(page, base), `runner on ${base}`).equals(true)
}
/**
 * A dropped runner is set back on the base he left and runs to the one he
 * was dropped on, so a base he passes through is not empty until the field
 * moves nobody.
 */
async function atRest(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Baseball field"][data-moving=""]', {
    timeout: 30000
  })
}
async function nobodyNear(page: Page, base: number): Promise<void> {
  expect(await runnerNearBase(page, base), `nobody on ${base}`).equals(false)
}

it('sends the runner on first to second, and he drags back to first', async function () {
  const page = await openPhone()
  try {
    await overrideBases(page, [['First base', 'Player 7']])
    await groundOut(page)
    await batterOutAtFirst(page)
    await correcting(page)
    if (!capturing) await waitRunnerNearBase(page, 2)
    await picture(page, 'ground-out-runner-on-first', 0)
    if (capturing) return
    await outsShown(page, 1)
    await dragRunner(page, 2, 1)
    await page.touchscreen.touchEnd()
    await atRest(page)
    await waitRunnerNearBase(page, 1)
    await nobodyNear(page, 2)
    await tapEither(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    await stillNear(page, 1)
  } finally {
    await page.close()
  }
})

it('sends runners on first and second to second and third, and refuses the lead back onto the trail', async function () {
  if (capturing) this.skip()
  const page = await openPhone()
  try {
    await overrideBases(page, [
      ['First base', 'Player 6'],
      ['Second base', 'Player 7']
    ])
    await groundOut(page)
    await batterOutAtFirst(page)
    await correcting(page)
    await waitRunnerNearBase(page, 3)
    await waitRunnerNearBase(page, 2)
    // Second is taken: the field offers the lead runner no way back, and
    // he stays on third.
    await dragRunner(page, 3, 2)
    await page.touchscreen.touchEnd()
    await waitRunnerNearBase(page, 3)
    // The trailing runner goes back to first; the lead keeps third.
    await dragRunner(page, 2, 1)
    await page.touchscreen.touchEnd()
    await atRest(page)
    await waitRunnerNearBase(page, 1)
    await waitRunnerNearBase(page, 3)
    await nobodyNear(page, 2)
  } finally {
    await page.close()
  }
})

for (const call of ['Safe', 'Out', 'Back'] as const)
  it(`asks Safe, Out or Back for the runner from third, and he is ${call}`, async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await overrideBases(page, [['Third base', 'Player 8']])
      await groundOut(page)
      await batterOutAtFirst(page)
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      // The run is not on the board until he is called safe.
      await score(page, 0)
      expect(await page.$('[aria-label="Back"]')).not.equals(null)
      await click(page, call)
      if (call === 'Safe') await score(page, 1)
      else if (call === 'Out') {
        await place(page, 0)
        await tapEither(page, 'Finish defensive play')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await outsShown(page, 2)
        await score(page, 0)
      } else {
        await waitRunnerNearBase(page, 3)
        await score(page, 0)
        await tapEither(page, 'Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await stillNear(page, 3)
        await score(page, 0)
      }
    } finally {
      await page.close()
    }
  })

it('scores the lead runner with the bases loaded and moves the others up a base', async function () {
  if (capturing) this.skip()
  const page = await openPhone()
  try {
    await overrideBases(page, [
      ['First base', 'Player 6'],
      ['Second base', 'Player 7'],
      ['Third base', 'Player 8']
    ])
    await groundOut(page)
    await batterOutAtFirst(page)
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 8"]',
      { timeout: 30000 }
    )
    await score(page, 0)
    await click(page, 'Safe')
    await score(page, 1)
    await waitRunnerNearBase(page, 2)
    await waitRunnerNearBase(page, 3)
    await outsShown(page, 1)
  } finally {
    await page.close()
  }
})

it('moves the runner up on a bunt ground out too', async function () {
  if (capturing) this.skip()
  const page = await openPhone()
  try {
    await overrideBases(page, [['First base', 'Player 7']])
    await groundOut(page, 'Bunt')
    await batterOutAtFirst(page)
    await waitRunnerNearBase(page, 2)
  } finally {
    await page.close()
  }
})

it('puts the runner from first out on second in a 6-4-3, then the batter at first', async function () {
  const page = await openPhone()
  try {
    await overrideBases(page, [['First base', 'Player 7']])
    await groundOut(page)
    // The shortstop holds the ball, so the second baseman is fourth.
    await place(page, 4)
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
    if (!capturing)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender, hold a runner to put him out on his base"]'
      )
    // The runner is the last player the field offers: held where he stands.
    await frame(page)
    await frame(page)
    await dropOfferedRunner(fieldOf(page), 'Out')
    if (!capturing) {
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender, or hit Done"]'
      )
    }
    // The second baseman still holds it, so the first baseman is third.
    await batterOutAtFirst(page)
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    await picture(page, 'ground-out-double-play')
    if (capturing) return
    await outsShown(page, 2)
    for (const at of [1, 2, 3]) await nobodyNear(page, at)
  } finally {
    await page.close()
  }
})

it('moves nobody with two out: the batter out ends the half', async function () {
  if (capturing) this.skip()
  const page = await openPhone()
  try {
    await overrideBases(page, [['First base', 'Player 7']])
    for (let i = 0; i < 6; i++) {
      await waitReady(page)
      await click(page, 'Swing and Miss')
    }
    await waitReady(page)
    await groundOut(page)
    await stillNear(page, 1)
    await nobodyNear(page, 2)
    await batterOutAtFirst(page)
    await page.waitForSelector('[aria-label*="Bottom 1st"]', {
      timeout: 30000
    })
    await score(page, 0)
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/ground-outs',
  title: 'Ground outs move the runners up, or let them be called',
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
  minutes: 20,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
