import { join } from 'node:path'

import { expect } from 'chai'
import type { Mesh, MeshStandardMaterial } from 'three'

import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  dropOfferedRunner,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  captureScene,
  chooseHit,
  click,
  fieldOf,
  open,
  overrideBases,
  projectBase,
  type SceneProbeWindow,
  suite,
  tapSettled,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * Runners put out between and during plays, terminal plays and team identities.
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
/** A nested mocha `describe`: its tests are added as they come. */
const describe = (_title: string, body: () => void): void => {
  body()
}

describe('did not tag up', function () {
  const returnOutReasons = [
    'Did Not Tag Up',
    'Offensive Interference',
    'Out on Appeal',
    'Other'
  ]
  async function phoneWithRunnerOnFirst(page: Page): Promise<void> {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [['First base', 'Player 6']])
    await page.waitForSelector('canvas[data-field-ready="true"]')
  }
  async function caughtFly(page: Page): Promise<void> {
    await click(page, 'Swing in Play')
    await click(page, 'Batter Out')
    await click(page, 'Ball Caught')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    await placeOffered(fieldOf(page))
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    await setTrajectory(fieldOf(page))
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
  }
  /** Holds the runner on `base` and lets go on the Out target beside him. */
  async function holdRunnerOut(page: Page, base: 1 | 2): Promise<void> {
    const [x, y] = await projectBase(page, base, 6)
    await page.touchscreen.touchStart(x, y)
    await new Promise(resolve => setTimeout(resolve, 450))
    await page.waitForSelector('[aria-label="Out drag target"]')
    const out = await page.$eval('[aria-label="Out drag target"]', e => {
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.touchscreen.touchMove(out.x, out.y)
    await page.touchscreen.touchEnd()
  }
  async function shot(page: Page, name: string): Promise<void> {
    const directory = artifactDir()
    if (directory == null) return
    await new Promise(resolve => setTimeout(resolve, 900))
    await page.screenshot({ path: join(directory, `${name}.png`) })
  }
  it('records a runner returning to first on a caught fly as doubled off', async function () {
    this.timeout(120000)
    const { page } = await open('/games/g1/score')
    interface SavedPlay {
      result: { eventType: string }
      runners: Array<{
        movement: { isOut: boolean }
        details: { movementReason: string | null }
      }>
    }
    const saves: Array<Promise<{ plays?: SavedPlay[] }>> = []
    page.on('request', request => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/events')
      )
        saves.push(
          request.fetchPostData().then(body => JSON.parse(body ?? '{}'))
        )
    })
    try {
      await phoneWithRunnerOnFirst(page)
      await caughtFly(page)
      await holdRunnerOut(page, 1)
      await shot(page, 'did-not-tag-up-after')
      for (const reason of returnOutReasons)
        await page.waitForSelector(`[aria-label="${reason}"]`)
      expect(await page.$('[aria-label="Picked Off"]')).equals(null)
      await tapSettled(page, 'Did Not Tag Up')
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await placeOffered(fieldOf(page), 1)
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="0 balls 0 strikes 2 outs"]')
      await shot(page, 'did-not-tag-up-recorded')
      await page.waitForSelector('[aria-label^="Undo Out by "]')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      // The outbox posts the closed play on its own schedule: wait for it.
      let play: SavedPlay | undefined
      for (let wait = 0; play == null && wait < 60; wait++) {
        play = (await Promise.all(saves))
          .flatMap(body => body.plays ?? [])
          .find(row => row.result.eventType === 'double_play')
        if (play == null) await new Promise(resolve => setTimeout(resolve, 250))
      }
      expect(play, 'saved double play').not.equals(undefined)
      expect(
        play!.runners
          .filter(row => row.movement.isOut)
          .map(row => row.details.movementReason)
      ).includes('r_doubled_off')
    } finally {
      await page.close()
    }
  })
  it('keeps the runner on first when the reason menu is closed', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await phoneWithRunnerOnFirst(page)
      await caughtFly(page)
      await holdRunnerOut(page, 1)
      await page.waitForSelector('[aria-label="Did Not Tag Up"]')
      await tapSettled(page, 'Cancel')
      await page.waitForSelector('[aria-label="Did Not Tag Up"]', {
        hidden: true
      })
      await page.waitForSelector('[aria-label="Time to edit play"]')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="0 balls 0 strikes 1 outs"]')
    } finally {
      await page.close()
    }
  })
  it('asks no reason for a runner put out at his base after a single', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await phoneWithRunnerOnFirst(page)
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await holdRunnerOut(page, 2)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      expect(await page.$('[aria-label="Did Not Tag Up"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('offers no Did Not Tag Up between pitches', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await phoneWithRunnerOnFirst(page)
      await click(page, 'Ball')
      await waitReady(page)
      await holdRunnerOut(page, 1)
      await page.waitForSelector('[aria-label="Picked Off"]')
      expect(await page.$('[aria-label="Did Not Tag Up"]')).equals(null)
    } finally {
      await page.close()
    }
  })
})
for (const walk of [true, false])
  it(`completes a terminal ${walk ? 'walk' : 'strikeout'} with the appropriate play completion`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      for (let i = 0; i < (walk ? 4 : 3); i++)
        await click(page, walk ? 'Ball' : 'Called Strike')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 20000
      })
      await page.waitForSelector(
        `[aria-label*="0 balls 0 strikes ${walk ? 0 : 1} outs · Pitches ${walk ? 4 : 3}"]`
      )
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await page.locator('[aria-label^="Undo "]').click()
      await page.waitForSelector(
        `[aria-label*="${walk ? '3 balls 0' : '0 balls 2'} strikes 0 outs"]`
      )
    } finally {
      await page.close()
    }
  })
for (const logos of ['valid', 'broken', undefined] as const) {
  it(`keeps team colors and dugout identities across halves with ${logos ?? 'absent'} logos`, async function () {
    const { page, unexpected } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true,
      logos
    )
    try {
      await page.setViewport({ width: 390, height: 844 })
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await captureScene(page)
      if (logos === 'valid')
        await page.waitForFunction(() =>
          Boolean(
            (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
              'dugout-logo-home'
            )
          )
        )
      for (const half of ['top', 'bottom']) {
        const data = await page.evaluate(() => {
          const scene = (window as unknown as SceneProbeWindow).qaScene!
          const color = (name: string): string =>
            (
              (
                scene
                  .getObjectByName(name)!
                  .getObjectByName('jersey-torso') as Mesh
              ).material as MeshStandardMaterial
            ).color.getHexString()
          const heads: string[] = []
          scene.traverse(n => {
            if (n.name === 'dugout-head') heads.push(n.name)
          })
          return {
            offense: color(
              'player-offense-' +
                (scene.getObjectByName('player-offense-101') == null
                  ? '201'
                  : '101')
            ),
            defense: color(
              'player-defense-' +
                (scene.getObjectByName('player-defense-201') == null
                  ? '101'
                  : '201')
            ),
            heads: heads.length,
            logos: ['away', 'home'].filter(
              s => scene.getObjectByName('dugout-logo-' + s) != null
            )
          }
        })
        expect(data.offense).equals(half === 'top' ? '294c78' : 'b74242')
        expect(data.defense).equals(half === 'top' ? 'b74242' : '294c78')
        expect(data.heads).equals(6)
        expect(data.logos).has.length(logos === 'valid' ? 2 : 0)
        await page.screenshot({
          path: join(artifactDir(), `dugouts-${logos ?? 'absent'}-${half}.png`)
        })
        if (half === 'top') {
          await click(page, 'Open scoring menu')
          await click(page, 'End Half Inning')
          await click(page, 'Confirm End Half Inning')
          await page.waitForFunction(() =>
            document.body.textContent!.includes('Bottom')
          )
        }
      }
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
}
// Skipped until #333: the pitch presentation after the undone half can
// stay in delivery, and the field then takes no input.
it('confirms and undoes a manual half and a runner-only third out', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'End Half Inning')
    await click(page, 'Cancel')
    await page.waitForSelector('[aria-label*="Top 1st"]')
    await click(page, 'Open scoring menu')
    await click(page, 'End Half Inning')
    await click(page, 'Confirm End Half Inning')
    await page.waitForSelector('[aria-label*="Bottom 1st"]')
    await page.locator('[aria-label^="Undo "]').click()
    await page.waitForSelector('[aria-label*="Top 1st"]')
    await overrideBases(page, [['First base', 'Player 6']])
    await click(page, 'Open scoring menu')
    await click(page, 'Overrides')
    await click(page, 'Outs 2')
    await click(page, 'Apply Override')
    // A pitch locks the switch hitter, leaving the base runner selectable.
    await click(page, 'Ball')
    await waitReady(page)
    await dropOfferedRunner(fieldOf(page), 'Out')
    await click(page, 'Picked Off')
    await placeOffered(fieldOf(page))
    await click(page, 'Finish defensive play')
    await page.waitForSelector('[aria-label*="Bottom 1st"]', {
      timeout: 30000
    })
    await page.locator('[aria-label^="Undo "]').click()
    await page.waitForSelector('[aria-label*="Top 1st"]')
    await page.waitForSelector('[aria-label*="2 outs"]')
  } finally {
    await page.close()
  }
})
it('waits when the next lineup batter is on base after a strikeout, then repairs through Overrides', async function () {
  this.timeout(90000)
  const { page } = await open('/games/g1/score')
  try {
    await overrideBases(page, [['First base', 'Player 2']])
    for (let i = 0; i < 3; i++) await click(page, 'Called Strike')
    await page.waitForSelector('[aria-label^="Next batter is on base."]', {
      timeout: 30000
    })
    expect(
      await page.$eval('[aria-label="Ball"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await click(page, 'Open scoring menu')
    await click(page, 'Overrides')
    await click(page, 'Batter')
    expect(
      await page.$eval('[aria-label="2. Player 2 #2"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await click(page, '3. Player 3 #3')
    await click(page, 'Apply Override')
    await page.waitForSelector('[aria-label*="Batter Player 3"]')
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/runner-outs',
  title:
    'Runners put out between and during plays, terminal plays and team identities',
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
  minutes: 30,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
