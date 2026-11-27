import { join } from 'node:path'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { initialHitTarget } from '../../../../src/app/field/trajectoryGuide'
import { withoutNames } from '../../../../src/common/scoring/storedNames'
import { defineHarness } from '../../../core/spec'
import {
  aimLandingAt,
  dropOfferedRunner,
  groundPoint,
  placeOffered,
  setTrajectory,
  tapOffered
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  chooseHit,
  click,
  fieldOf,
  open,
  overrideBases,
  readGuide,
  type SceneProbeWindow,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * Arrivals, home runs and fielder choices.
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

for (const caught of [false, true]) {
  it(`arrives ${caught ? 'before catch' : 'after landing'} on the live field`, async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    try {
      await click(page, 'Swing in Play')
      if (caught) {
        await click(page, 'Batter Out')
        await click(page, 'Ball Caught')
      } else await click(page, 'Single')
      // The pitcher takes it some thirty feet out.
      const field = fieldOf(page)
      await placeOffered(field, 0, 60)
      const target = await readGuide(page)
      const samplesPromise = page.evaluate(
        async () =>
          await new Promise<
            Array<{ z: number; gap: number; fz: number; t: number }>
          >(resolve => {
            const scene = (window as unknown as SceneProbeWindow).qaScene!
            const out: Array<{
              z: number
              gap: number
              fz: number
              t: number
            }> = []
            let seen = false
            const run = (): void => {
              const ball = scene.getObjectByName('animated-baseball')
              const fielder = scene.getObjectByName('player-defense-201')
              if (ball != null && ball.visible && fielder != null) {
                seen = true
                out.push({
                  t: performance.now(),
                  z: ball.position.z,
                  fz: fielder.position.z,
                  gap: Math.hypot(
                    ball.position.x - fielder.position.x,
                    ball.position.z - fielder.position.z
                  )
                })
              }
              if (seen && ball == null) resolve(out)
              else requestAnimationFrame(run)
            }
            run()
          })
      )
      await setTrajectory(field)
      const samples = await samplesPromise
      // How often the page drew: these checks read one sample a frame.
      const gaps = samples
        .slice(1)
        .map((one, i) => one.t - samples[i].t)
        .sort((a, b) => a - b)
      console.log(
        `    ${samples.length} frames of flight, median ${gaps[gaps.length >> 1]?.toFixed(0) ?? '-'} ms apart, longest ${gaps.at(-1)?.toFixed(0) ?? '-'} ms`
      )
      const moving = samples.filter(p => p.z < -3 && p.z > target.z / 2).at(-1)
      expect(moving, 'defender starts during early ball flight').not.equals(
        undefined
      )
      expect(moving!.fz).lessThan(-18.44)
      const landing = samples.filter(p => Math.abs(p.z - target.z) < 0.01)
      if (caught) {
        expect(landing.length).equals(0)
        expect(samples.at(-1)!.gap).lessThan(3)
      } else {
        expect(landing.length).greaterThan(1)
        expect(landing[0].gap).greaterThan(0.1)
        expect((landing[0].fz + 18.44) / (target.z + 18.44)).closeTo(0.8, 0.08)
        expect(landing.at(-1)!.gap).lessThan(landing[0].gap)
      }
      await page.locator('[aria-label^="Undo "]').click()
    } finally {
      await page.close()
    }
  })
}
for (const outside of [false, true]) {
  it(`celebrates ${outside ? 'stands' : 'in-park'} home run on the LED scoreboard`, async function () {
    this.timeout(90000)
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      outside ? 'left' : 'right',
      true
    )
    try {
      await page.setViewport(
        outside ? { width: 844, height: 390 } : { width: 390, height: 844 }
      )
      await click(page, 'Swing in Play')
      await click(page, 'Home Run')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const target = await readGuide(page)
      expect(Math.hypot(target.x, target.z)).closeTo(113.5, 0.01)
      expect(target.bearing).closeTo(outside ? 15 : -15, 0.01)
      // On the guide, or fifteen feet past it into the stands.
      await aimLandingAt(fieldOf(page), target.x, target.z - (outside ? 15 : 0))
      await setTrajectory(fieldOf(page))
      await page.waitForFunction(
        () =>
          (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
            'home-run-celebration'
          ) != null
      )
      expect(await page.$('[aria-label^="Ball trajectory:"]')).equals(null)
      const samples = (await page.evaluate(async () => {
        const scene = (window as unknown as SceneProbeWindow).qaScene!
        const sample = (): unknown => {
          const lights = scene.getObjectByName(
            'home-run-fireworks'
          )! as unknown as { instanceMatrix: { array: ArrayLike<number> } }
          const text = scene.getObjectByName(
            'home-run-letters'
          )! as unknown as {
            material: {
              opacity: number
              map: { image: { data: ArrayLike<number> } }
            }
          }
          return {
            matrix: Array.from(lights.instanceMatrix.array),
            opacity: text.material.opacity,
            pixels: Array.from(text.material.map.image.data)
          }
        }
        const before = sample()
        await new Promise(resolve => setTimeout(resolve, 300))
        return { before, after: sample() }
      })) as {
        before: { matrix: number[]; opacity: number; pixels: number[] }
        after: { matrix: number[]; opacity: number; pixels: number[] }
      }
      expect(samples.before.matrix).not.deep.equals(samples.after.matrix)
      expect(samples.before.opacity).not.equals(samples.after.opacity)
      expect(samples.before.pixels).deep.equals(samples.after.pixels)
      await page.screenshot({
        path: join(
          artifactDir(),
          `celebration-${outside ? 'stands' : 'park'}.png`
        )
      })
      await page.waitForFunction(
        () =>
          (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
            'home-run-celebration'
          ) == null,
        { timeout: 10000 }
      )
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 45000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    } finally {
      await page.close()
    }
  })
}
it('defaults home-run guidance by batting side and eases through the center gap', async function () {
  this.timeout(150000)
  for (const bats of ['right', 'left'] as const) {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      bats,
      true
    )
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Home Run')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      expect((await readGuide(page)).bearing).closeTo(
        bats === 'right' ? -15 : 15,
        0.01
      )
      // The landing is held and moved in three-foot steps towards the
      // middle, where the guide's bearing eases across the center gap.
      const guide = await readGuide(page)
      const toward = bats === 'right' ? 3 : -3
      let x = guide.x
      const moveTo = async (to: number): Promise<void> => {
        x = to
        await page.mouse.move(
          ...(await groundPoint(fieldOf(page), x, guide.z)),
          {
            steps: 3
          }
        )
      }
      await page.mouse.move(...(await groundPoint(fieldOf(page), x, guide.z)))
      await page.mouse.down()
      await moveTo(x + toward / 3)
      await moveTo(guide.x)
      for (let i = 0; i < 9; i++) {
        await moveTo(x + toward)
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      await page.waitForFunction(() => {
        const arc = (
          window as unknown as SceneProbeWindow
        ).qaScene!.getObjectByName('ball-arc')!
        return Math.abs(Math.abs(Number(arc.userData.bearing)) - 5) < 0.01
      })
      const start = await readGuide(page)
      expect(start.bearing).closeTo(bats === 'right' ? -5 : 5, 0.01)
      for (const step of [toward, -toward]) {
        const samples = page.evaluate(
          async () =>
            await new Promise<number[]>(resolve => {
              const out: number[] = []
              const sample = (): void => {
                out.push(
                  Number(
                    (
                      window as unknown as SceneProbeWindow
                    ).qaScene!.getObjectByName('ball-arc')!.userData.bearing
                  )
                )
                if (out.length < 35) requestAnimationFrame(sample)
                else resolve(out)
              }
              requestAnimationFrame(sample)
            })
        )
        await moveTo(x + step)
        const values = await samples
        expect(
          values.some(value => Math.abs(value) > 0.05 && Math.abs(value) < 4.95)
        ).equals(true)
        expect(Math.abs(values.at(-1)!)).closeTo(5, 0.01)
      }
      const final = await readGuide(page)
      expect(final.x).closeTo(start.x, 0.01)
      expect(final.z).closeTo(start.z, 0.01)
      await page.mouse.up()
      await setTrajectory(fieldOf(page))
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 45000
      })
      for (let undo = 0; undo < 4; undo++) {
        if (
          await page.$eval(
            '[aria-label="Swing in Play"]',
            n => n.getAttribute('aria-disabled') !== 'true'
          )
        )
          break
        await page.locator('[aria-label^="Undo "]').click()
      }
      await click(page, 'Swing in Play')
      await click(page, 'Single')
      await tapOffered(fieldOf(page))
      await page.waitForSelector('[aria-label^="Ball trajectory:"]')
      const central = await readGuide(page)
      expect(central.x).equals(0)
      expect(Math.abs(central.bearing)).equals(5)
      await setTrajectory(fieldOf(page))
      await page.waitForSelector('[aria-label="Finish at-bat"]', {
        timeout: 45000
      })
      await click(page, 'Finish at-bat')
    } finally {
      await page.close()
    }
  }
})
for (const outside of [false, true])
  for (const loaded of [false, true]) {
    it(`classifies ${outside ? 'stands' : 'in-park'} home run with ${loaded ? 'loaded' : 'empty'} bases and finishes automatically`, async function () {
      this.timeout(90000)
      const { page } = await open('/games/g1/score')
      try {
        await page.setViewport({ width: 390, height: 844 })
        if (loaded) {
          await overrideBases(page, [
            ['First base', 'Player 6'],
            ['Second base', 'Player 7'],
            ['Third base', 'Player 8']
          ])
        }
        await click(page, 'Swing in Play')
        await click(page, 'Home Run')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        const rect = await page.$eval('canvas', node => {
          const r = node.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          ...rect,
          view: 'home',
          zoom: 1.25,
          tilt: (-11 * Math.PI) / 180,
          heightOffset: 33,
          bottomExtension: 112
        })
        const project = (x: number, z: number, y: number): [number, number] => {
          const p = new Vector3(x, y, z).project(camera)
          return [
            rect.x + ((p.x + 1) * rect.width) / 2,
            rect.y + ((1 - p.y) * rect.height) / 2
          ]
        }
        // Start away from the target; apply a screen-space displacement from
        // the initial landing rather than aiming directly under the mouse.
        const origin = project(loaded ? 32 : -32, -25, 0)
        const initialTarget = initialHitTarget('R')
        const initial = project(initialTarget.x, initialTarget.z, 0.7)
        const target = project(0, outside ? -133 : -100, outside ? 8 : 0.7)
        await page.mouse.move(...origin)
        await page.mouse.down()
        await page.waitForSelector(
          '[aria-label="Home run type: In-the-park Home Run"]'
        )
        await page.mouse.move(
          origin[0] + target[0] - initial[0],
          origin[1] + target[1] - initial[1],
          { steps: 10 }
        )
        await page.waitForSelector(
          `[aria-label="Home run type: ${outside ? 'Home Run' : 'In-the-park Home Run'}"]`
        )
        await page.mouse.up()
        await setTrajectory(fieldOf(page))
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 45000
        })
        await page.waitForSelector(
          `[aria-label*="Owls ${loaded ? 4 : 1} · Hawks 0"]`
        )
        expect(await page.$('[aria-label="Safe"]')).equals(null)
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        await page.locator('[aria-label^="Undo "]').click()
        expect(await page.$('[aria-label*="Batter Player 2"]')).equals(null)
      } finally {
        await page.close()
      }
    })
  }
it('scores all four loaded home-run arrivals automatically on a phone', async function () {
  this.timeout(90000)
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [
      ['First base', 'Player 6'],
      ['Second base', 'Player 7'],
      ['Third base', 'Player 8']
    ])
    await chooseHit(page, 'Home Run')
    await page.waitForSelector('[aria-label*="Owls 4 · Hawks 0"]', {
      timeout: 30000
    })
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    expect(await page.$('[aria-label="Safe"]')).equals(null)
  } finally {
    await page.close()
  }
})
it('backs up a legal home arrival', async function () {
  this.timeout(120000)
  const rollback = await open('/games/g1/score')
  const tap = async (label: string): Promise<void> => {
    await rollback.page
      .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
      .click()
  }
  try {
    await overrideBases(rollback.page, [
      ['Second base', 'Player 7'],
      ['Third base', 'Player 8']
    ])
    await chooseHit(rollback.page, 'Single')
    await rollback.page.waitForSelector(
      '[aria-label="Home plate decision for Player 8"]',
      { timeout: 30000 }
    )
    if (artifactDir() != null) {
      await rollback.page.setViewport({ width: 402, height: 579 })
      await new Promise(resolve => setTimeout(resolve, 500))
      await rollback.page.screenshot({
        path: join(artifactDir(), `home-after.png`)
      })
    }
    await tap('Back')
    await rollback.page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await rollback.page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
  } finally {
    await rollback.page.close()
  }
})
for (const [mask, outIds] of [
  [1, [6]],
  [2, [7]],
  [3, [6]],
  [4, []],
  [5, [6]],
  [6, [7]],
  [7, []],
  [7, [6, 7]],
  [7, [8]]
] as Array<[number, number[]]>)
  it(`completes fielder choice bases ${mask}, runners out ${outIds.length === 0 ? 'none' : outIds.join(',')}, then reloads the saved play`, async function () {
    this.timeout(120000)
    const { page, unexpected } = await open('/games/g1/score')
    const saves: Array<
      Promise<{
        plays?: Array<{
          matchup: { batter: { id: number } }
          runners: Array<{
            details: { runner: { id: number; fullName: string } }
            movement: { isOut: boolean }
          }>
          result: { awayScore: number }
          teamStation: {
            detail: {
              fieldingRoute: Array<{
                player: { id: number }
                location: { x: number; z: number }
              }>
            }
          }
        }>
      }>
    > = []
    page.on('request', request => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/events')
      )
        saves.push(
          request.fetchPostData().then(body => JSON.parse(body ?? '{}'))
        )
    })
    // Locators wait for sheet controls to finish moving before pointer input.
    const tap = async (label: string): Promise<void> => {
      await page
        .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
        .click()
    }
    try {
      await overrideBases(
        page,
        (['First base', 'Second base', 'Third base'] as const).flatMap(
          (base, index) =>
            (mask & (1 << index)) !== 0
              ? [
                  [base, `Player ${index + 6}`] as [
                    'First base' | 'Second base' | 'Third base',
                    string
                  ]
                ]
              : []
        )
      )
      await chooseHit(page, "Fielder's Choice")
      await page.waitForSelector('[aria-label^="Tap or drag each defender"]', {
        timeout: 30000
      })
      expect(
        await page.$('[aria-label^="Fielder\'s choice decision for"]')
      ).equals(null)
      expect(await page.$('[aria-label^="Drag batter to a base"]')).equals(null)
      await placeOffered(fieldOf(page), 1)
      await page.waitForSelector(
        '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
      )
      if (mask === 3) {
        await placeOffered(fieldOf(page), 1)
        await page.waitForSelector(
          '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
        )
      }
      await click(page, 'Finish defensive play')
      await page.waitForSelector(
        '[aria-label^="Mark each runner Safe or Out"]',
        { timeout: 30000 }
      )
      const ids = [6, 7, 8].filter((_, index) => (mask & (1 << index)) !== 0)
      expect(
        await page.$$('[aria-label^="Fielder\'s choice decision for"]')
      ).length(ids.length)
      expect(await page.$('[aria-label="Out Player 1"]')).equals(null)
      if (mask === 7 && outIds.length === 0 && artifactDir() != null)
        await page.screenshot({
          path: join(artifactDir(), 'loaded-bases-after.png')
        })
      if (mask === 7 && outIds.length === 0) {
        if (artifactDir() != null) {
          for (const [name, viewport] of [
            ['portrait', { width: 402, height: 579 }],
            ['landscape', { width: 844, height: 390 }]
          ] as const) {
            await page.setViewport(viewport)
            await new Promise(resolve => setTimeout(resolve, 500))
            await page.screenshot({
              path: join(artifactDir(), `${name}-after.png`)
            })
          }
        }
        for (const viewport of [
          { width: 402, height: 579 },
          { width: 844, height: 390 },
          { width: 1200, height: 900 },
          { width: 800, height: 450 },
          { width: 390, height: 640 },
          { width: 568, height: 320 },
          { width: 874, height: 292 }
        ]) {
          await page.setViewport(viewport)
          if (artifactDir() != null) {
            await new Promise(resolve => setTimeout(resolve, 500))
            console.log(
              'Runner decision hit targets',
              viewport,
              await page.evaluate(() =>
                Array.from(
                  document.querySelectorAll(
                    '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
                  )
                ).map(button => {
                  const box = button.getBoundingClientRect()
                  const hit = document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2
                  )
                  return {
                    label: button.getAttribute('aria-label'),
                    rect: box.toJSON(),
                    // Browser callbacks cannot reference Sucrase helpers.

                    hit: hit == null ? null : hit.getAttribute('aria-label'),

                    text: hit == null ? null : hit.textContent
                  }
                })
              )
            )
          }
          await page.waitForFunction(() => {
            const buttons = Array.from(
              document.querySelectorAll(
                '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
              )
            )
            return (
              buttons.length === 6 &&
              buttons.every((button, index) => {
                const box = button.getBoundingClientRect()
                const hit = document.elementFromPoint(
                  box.x + box.width / 2,
                  box.y + box.height / 2
                )
                return (
                  hit != null &&
                  button.contains(hit) &&
                  buttons.slice(index + 1).every(other => {
                    const target = other.getBoundingClientRect()
                    return (
                      box.right <= target.left ||
                      target.right <= box.left ||
                      box.bottom <= target.top ||
                      target.bottom <= box.top
                    )
                  })
                )
              })
            )
          })
          const placements = await page.evaluate(() =>
            [6, 7, 8].map(id => {
              const group = document.querySelector(
                `[aria-label="Fielder's choice decision for Player ${id}"]`
              )!
              const plate = document.querySelector(
                `[data-nameplate="offense-${100 + id}"]`
              )!
              return {
                control: group.getBoundingClientRect().toJSON(),
                runner: plate.getBoundingClientRect().toJSON(),
                text: group.textContent,
                background: getComputedStyle(group).backgroundColor
              }
            })
          )
          expect(placements[0].control.bottom).lessThan(
            placements[0].runner.top
          )
          expect(placements[1].control.right).at.most(placements[1].runner.left)
          expect(placements[2].control.left).at.least(
            placements[2].runner.right
          )
          for (const placed of placements) {
            expect(placed.text).equals('SafeOut')
            expect(placed.background).equals('rgba(0, 0, 0, 0)')
          }
        }
        const controls = await page.$$(
          '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
        )
        for (const control of controls) {
          const box = await control.boundingBox()
          expect(box).not.equals(null)
          expect(box!.y).at.least(0)
          expect(box!.y + box!.height).at.most(292)
        }
      }
      for (const id of ids) {
        await tap(`${outIds.includes(id) ? 'Out' : 'Safe'} Player ${id}`)
        if (outIds.includes(id)) {
          await page.waitForSelector('[aria-label^="Putout by"]')
          if (mask === 3 && id === 6) {
            await tap('Cancel')
            await tap(`Out Player ${id}`)
            await page.waitForSelector('[aria-label^="Putout by"]')
          }
          if (
            mask === 7 &&
            outIds.includes(6) &&
            id === 6 &&
            artifactDir() != null
          )
            await page.screenshot({
              path: join(artifactDir(), 'putout-picker-after.png')
            })
          const choices = await page.$$('[aria-label^="Putout by"]')
          const label = await choices[
            mask === 3 ? 1 : choices.length - 1
          ].evaluate(node => node.getAttribute('aria-label')!)
          await tap(label)
        }
      }
      await page.setViewport({ width: 1200, height: 900 })
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      const expectedRuns = (mask & 4) !== 0 && !outIds.includes(8) ? 1 : 0
      await page.waitForSelector(
        `[aria-label*="Owls ${expectedRuns} · Hawks 0"]`
      )
      const bodies = await Promise.all(saves)
      const play = bodies.flatMap(body => body.plays ?? []).at(-1)!
      expect(play, 'saved completed choice').not.equals(undefined)
      expect(play.runners.filter(row => row.movement.isOut)).length(
        outIds.length
      )
      expect(
        play.runners.some(
          row =>
            row.details.runner.id === play.matchup.batter.id &&
            row.movement.isOut
        )
      ).equals(false)
      expect(play.result.awayScore).equals(expectedRuns)
      const route = play.teamStation.detail.fieldingRoute
      expect(route).length(mask === 3 ? 3 : 2)
      expect(
        route.every(
          hop =>
            Number.isFinite(hop.location.x) && Number.isFinite(hop.location.z)
        )
      ).equals(true)
      const loadedEvents = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith('/games/g1/events')
      )
      await page.reload({ waitUntil: 'networkidle0', timeout: 30000 })
      const loaded = (await (await loadedEvents).json()) as {
        plays: Array<{
          gumbo: { teamStation: { detail: { fieldingRoute: typeof route } } }
        }>
      }
      // Read back named, as the API names every player from his account:
      // in its stored form it is the route that was saved.
      expect(
        withoutNames(loaded.plays.at(-1)!.gumbo).teamStation.detail
          .fieldingRoute
      ).deep.equals(route)
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector(
        `[aria-label*="Owls ${expectedRuns} · Hawks 0"]`
      )
      expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })

for (const [decision, advance, reasons] of [
  [
    'Safe',
    true,
    [
      'Steal',
      'Wild Pitch',
      'Passed Ball',
      'Throwing Error',
      'Fielding Error',
      'Defensive Indifference',
      'Other'
    ]
  ],
  [
    'Out',
    true,
    ['Caught Stealing', 'Offensive Interference', 'Out on Appeal', 'Other']
  ],
  [
    'Out',
    false,
    ['Picked Off', 'Offensive Interference', 'Out on Appeal', 'Other']
  ]
] as const)
  for (const reason of reasons)
    it(`records ${advance ? 'advanced' : 'stationary'} ${decision}: ${reason} between pitches`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        await overrideBases(page, [['First base', 'Player 6']])
        await click(page, 'Ball')
        await waitReady(page)
        await dropOfferedRunner(fieldOf(page), decision, advance)
        await click(page, reason)
        if (reason === 'Wild Pitch')
          await click(page, 'Use previous pitch as wild pitch')
        else if (reason === 'Passed Ball') await click(page, 'YES')
        else if (reason === 'Throwing Error' || reason === 'Fielding Error')
          await placeOffered(fieldOf(page))
        if (decision === 'Out') {
          await page.waitForSelector(
            '[aria-label^="Tap or drag a player to where the ball was fielded."]'
          )
          await placeOffered(fieldOf(page))
          await page.waitForSelector(
            '[aria-label^="Tap or drag the next defender"]'
          )
          await placeOffered(fieldOf(page), 1)
          // The out with no runner left ends the play by itself.
          const finish = await page.waitForSelector(
            '[aria-label="Finish defensive play"]:not([aria-disabled="true"]), [aria-label^="Undo Out by"]',
            { visible: true }
          )
          if (
            (await finish?.evaluate(node =>
              node.getAttribute('aria-label')
            )) === 'Finish defensive play'
          )
            await click(page, 'Finish defensive play')
        }
        await waitReady(page)
        await page.waitForSelector(
          `[aria-label*="1 balls 0 strikes ${decision === 'Out' ? 1 : 0} outs · Pitches 1"]`
        )
        await page.waitForSelector('[aria-label*="Batter Jordan K"]')
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        await page.locator('[aria-label^="Undo "]').click()
        await page.waitForSelector('[aria-label="Undo Ball"]')
        await page.waitForSelector(
          '[aria-label*="1 balls 0 strikes 0 outs · Pitches 1"]'
        )
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
for (const sameDefender of [true, false])
  it(`retires a current-play runner with ${sameDefender ? 'one defender' : 'an assist'} and finishes when no runners remain`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Double')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await dropOfferedRunner(fieldOf(page), 'Out')
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await new Promise(resolve => setTimeout(resolve, 10500))
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      if (!sameDefender) await placeOffered(fieldOf(page), 1)
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await page.waitForSelector('[aria-label*="0 balls 0 strikes 1 outs"]')
    } finally {
      await page.close()
    }
  })

export default defineHarness({
  id: 'scoring/scoring-screen/home-runs-and-choices',
  title: 'Arrivals, home runs and fielder choices',
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
  minutes: 50,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
