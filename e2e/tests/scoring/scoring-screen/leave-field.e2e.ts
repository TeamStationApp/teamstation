import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { BASES } from '../../../../src/app/field/fieldModel'
import { initialHitTarget } from '../../../../src/app/field/trajectoryGuide'
import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { setTrajectory } from '../../../rigs/fieldPointer'
import {
  artifactDir,
  captureScene,
  chooseHit,
  click,
  dragRunner,
  fieldOf,
  open,
  overrideBases,
  runnerNearBase,
  type SceneProbeWindow,
  suite,
  tapSettled,
  waitReady,
  waitRunnerNearBase
} from '../../../rigs/scoring/webScoring'

/**
 * E4: a runner who scores leaves the field. After a home run, in the park or
 * over the fence, with the bases empty or loaded, nobody stays beside home
 * and there is no handle there to drag back; a runner dragged home and
 * called safe is gone, and still gone after the next pitch. With
 * TS_CAPTURE_ONLY=1 (the before pictures, taken on the base revision) only
 * the scenarios that take a picture run, and nothing is asserted; pictures go
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
async function picture(page: Page, name: string): Promise<void> {
  const dir = artifactDir()
  if (dir == null || dir === '') return
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
}
/** Where a ground point sits on the canvas, in the home view. */
async function project(
  page: Page,
  x: number,
  z: number,
  y = 0
): Promise<[number, number]> {
  const rect = await page.$eval('canvas', canvas => {
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    width: rect.width,
    height: rect.height,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  const point = new Vector3(x, y, z).project(camera)
  return [
    rect.x + ((point.x + 1) * rect.width) / 2,
    rect.y + ((1 - point.y) * rect.height) / 2
  ]
}
/** The offense players drawn on the field, by gumbo id. */
async function offense(page: Page): Promise<number[]> {
  await captureScene(page)
  return await page.evaluate(() => {
    const scene = (window as unknown as SceneProbeWindow).qaScene
    if (scene == null) return []
    const ids: number[] = []
    scene.traverse(obj => {
      if (!obj.name.startsWith('player-offense-')) return
      let shown = true
      for (let node: typeof obj | null = obj; node != null; node = node.parent)
        if (!node.visible) shown = false
      if (shown) ids.push(Number(obj.name.slice('player-offense-'.length)))
    })
    return ids.sort((a, b) => a - b)
  })
}
/** Waits for the walk to the dugout to end with exactly `ids` drawn. */
async function onlyOffense(page: Page, ids: number[]): Promise<void> {
  let drawn: number[] = []
  for (let i = 0; i < 100; i++) {
    drawn = await offense(page)
    if (JSON.stringify(drawn) === JSON.stringify(ids)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(drawn, 'offense players drawn').deep.equals(ids)
}
/**
 * The old drag-back handle stood in the home queue, well behind the
 * batter: a drag from there to third changes nothing.
 */
async function noHandleAtHome(page: Page, runs: number): Promise<void> {
  const distance = 1.2 + 15 * 0.61
  const from = await project(
    page,
    -distance / Math.SQRT2,
    -distance / Math.SQRT2,
    6
  )
  const to = await project(page, BASES[3].x, BASES[3].z)
  await page.touchscreen.touchStart(...from)
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.touchscreen.touchMove(...to)
  await page.touchscreen.touchEnd()
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await page.content()).not.includes('Runner did not advance')
  await page.waitForSelector(`[aria-label*="Owls ${runs} · Hawks 0"]`)
  expect(await runnerNearBase(page, 3), 'nobody on 3').equals(false)
}
/** Aims the ball in the park or over the fence, as the scorer drags it. */
async function homeRun(page: Page, outside: boolean): Promise<void> {
  await waitReady(page)
  await click(page, 'Swing in Play')
  await click(page, 'Home Run')
  await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
  const origin = await project(page, -32, -25)
  const start = initialHitTarget('R')
  const initial = await project(page, start.x, start.z, 0.7)
  const target = await project(
    page,
    0,
    outside ? -133 : -100,
    outside ? 8 : 0.7
  )
  await page.mouse.move(...origin)
  await page.mouse.down()
  await page.mouse.move(
    origin[0] + target[0] - initial[0],
    origin[1] + target[1] - initial[1],
    { steps: 10 }
  )
  if (!capturing)
    await page.waitForSelector(
      `[aria-label="Home run type: ${outside ? 'Home Run' : 'In-the-park Home Run'}"]`
    )
  await page.mouse.up()
  await setTrajectory(fieldOf(page))
  await page.waitForSelector('[aria-label*="Batter Player 2"]', {
    timeout: 45000
  })
}

for (const outside of [false, true])
  for (const loaded of [false, true])
    it(`sends everyone off after ${outside ? 'an over-the-fence' : 'an in-the-park'} home run with the bases ${loaded ? 'loaded' : 'empty'}`, async function () {
      // The before picture is the plainest case.
      if (capturing && (outside || loaded)) this.skip()
      const page = await openPhone()
      try {
        if (loaded)
          await overrideBases(page, [
            ['First base', 'Player 6'],
            ['Second base', 'Player 7'],
            ['Third base', 'Player 8']
          ])
        await homeRun(page, outside)
        const runs = loaded ? 4 : 1
        if (capturing) {
          await new Promise(resolve => setTimeout(resolve, 4000))
          await picture(page, 'home-run-end')
          return
        }
        await page.waitForSelector(`[aria-label*="Owls ${runs} · Hawks 0"]`)
        // Only the next batter, Player 2, is left on the offense.
        await onlyOffense(page, [102])
        if (!loaded && !outside) await picture(page, 'home-run-end')
        await noHandleAtHome(page, runs)
        await onlyOffense(page, [102])
      } finally {
        await page.close()
      }
    })

it('sends a runner dragged home and called safe off, and keeps him off after the next pitch', async function () {
  const page = await openPhone()
  try {
    await overrideBases(page, [['Second base', 'Player 7']])
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    if (!capturing) await waitRunnerNearBase(page, 3)
    // Drag him home and drop him on Safe.
    await dragRunner(page, 3, 0)
    const safe = await page.waitForSelector('[aria-label="Safe drag target"]', {
      timeout: 10000
    })
    const box = (await safe!.boundingBox())!
    await page.touchscreen.touchMove(
      box.x + box.width / 2,
      box.y + box.height / 2
    )
    await page.touchscreen.touchEnd()
    await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]', {
      timeout: 30000
    })
    await tapSettled(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    if (!capturing) {
      // The batter on first and the next batter; Player 7 (107) is gone.
      await onlyOffense(page, [101, 102])
      await noHandleAtHome(page, 1)
    }
    await waitReady(page)
    await click(page, 'Ball')
    await page.waitForSelector(
      '[aria-label*="1 balls 0 strikes 1 outs"], [aria-label*="1 balls 0 strikes 0 outs"]',
      {
        timeout: 30000
      }
    )
    await new Promise(resolve => setTimeout(resolve, 1500))
    await picture(page, 'safe-at-home-next-play')
    if (capturing) return
    await onlyOffense(page, [101, 102])
    await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/leave-field',
  title: 'Scorers send runners off the field as they score',
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
  minutes: 12,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
