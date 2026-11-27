import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  chooseHit,
  click,
  dragRunner,
  open,
  overrideBases,
  runnerNearBase,
  suite,
  waitRunnerNearBase
} from '../../../rigs/scoring/webScoring'

/**
 * An unforced runner on a single is offered, kept or sent back.
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

it('E1 auto-advances an unforced runner second to third on a single', async function () {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    true
  )
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [['Second base', 'Player 7']])
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    // Auto-advanced: no forced Safe/Out; retreat from third is available.
    expect(await page.$('[aria-label="Safe"]')).equals(null)
    expect(await page.$('[aria-label="Out"]')).equals(null)
    expect(await runnerNearBase(page, 3)).equals(true)
    await dragRunner(page, 3, 2)
    // Hit-offer retreat commits without mounting Safe/Out.
    expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
    expect(await page.$('[aria-label="Out drag target"]')).equals(null)
    await page.touchscreen.touchEnd()
    await waitRunnerNearBase(page, 2)
    await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    expect(await runnerNearBase(page, 2)).equals(true)
  } finally {
    await page.close()
  }
})

it('E2 leaves the auto-advanced runner on third when the scorer does not drag', async function () {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    true
  )
  try {
    await overrideBases(page, [['Second base', 'Player 7']])
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    expect(await page.$('[aria-label="Safe"]')).equals(null)
    expect(await runnerNearBase(page, 3)).equals(true)
    await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    expect(await runnerNearBase(page, 3)).equals(true)
  } finally {
    await page.close()
  }
})

it('E3 retreats third back to second without a Safe/Out strip', async function () {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    true
  )
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [['Second base', 'Player 7']])
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    expect(await runnerNearBase(page, 3)).equals(true)
    await dragRunner(page, 3, 2)
    // Retreat must not mount Safe/Out.
    expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
    expect(await page.$('[aria-label="Out drag target"]')).equals(null)
    await page.touchscreen.touchEnd()
    await waitRunnerNearBase(page, 2)
    await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    expect(await runnerNearBase(page, 2)).equals(true)
  } finally {
    await page.close()
  }
})

it('E4 still forces the runner on first on a bases-loaded single', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await overrideBases(page, [
      ['First base', 'Player 6'],
      ['Second base', 'Player 7'],
      ['Third base', 'Player 8']
    ])
    await chooseHit(page, 'Single')
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 8"]',
      { timeout: 30000 }
    )
    // Forced advances leave no Back for the runner scoring from third.
    expect(await page.$('[aria-label="Back"]')).equals(null)
    await click(page, 'Safe')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/unforced-hit-offer',
  title: 'An unforced runner on a single is offered, kept or sent back',
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
