import { join } from 'node:path'

import { expect } from 'chai'
import { type Mesh, PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { BASES } from '../../../../src/app/field/fieldModel'
import { ROSTER_CARD_GAP } from '../../../../src/app/scoring/rosterLayout'
import { defineHarness } from '../../../core/spec'
import {
  aimLandingAt,
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
  openPlaceholderSheet,
  overrideBases,
  readGuide,
  type SceneProbeWindow,
  server,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * Paired controls, menus, bunts, guidance, badges, pills and long names.
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

it('hides scoring for nonzero scores and recovers failed roster reads', async function () {
  const scored = await open('/games/g1', 7)
  try {
    await scored.page.waitForSelector('[aria-label="Box score"]')
    expect(await scored.page.$('[aria-label="Score"]')).equals(null)
  } finally {
    await scored.page.close()
  }
  const { page } = await open('/games/g1/score', false, false, true)
  try {
    await page.waitForSelector('[aria-label="Retry loading scoring"]')
    expect(await page.$('[aria-label="Ball"]')).equals(null)
    await click(page, 'Retry loading scoring')
    await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
    await page.waitForSelector('[aria-label*="Batter Jordan K"]')
    await click(page, 'Ball')
    await page.waitForSelector('[aria-label*="1 balls"]')
  } finally {
    await page.close()
  }
})
it('rejects invalid lineups, pitchers and base occupants, and restores a moving play with Undo', async function () {
  this.timeout(90000)
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    await click(page, 'Remove Jordan K.')
    for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
    // Incomplete setup is now saveable; readiness blocks scoring until repaired.
    expect(
      await page.$eval('[aria-label="Save Rosters"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).not.equals('true')
    await click(page, 'Add Jordan K. to Lineup')
    await click(page, 'Defense')
    await click(page, 'Clear P')
    expect(
      await page.$eval('[aria-label="Save Rosters"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).not.equals('true')
    await click(page, 'Cancel')
    await overrideBases(page, [['First base', 'Player 6']])
    await click(page, 'Open scoring menu')
    await click(page, 'Overrides')
    await click(page, 'Batter')
    expect(
      await page.$eval('[aria-label="6. Player 6 #6"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await click(page, 'Cancel')
    await click(page, 'Cancel')
    await click(page, 'Undo Override game state')
    await chooseHit(page, 'Home Run')
    await click(page, 'Undo 45° Fly Ball')
    await click(page, 'Undo Home-run landing')
    await new Promise(resolve => setTimeout(resolve, 11000))
    await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
    expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    await click(page, 'Undo Home Run')
    await page.waitForSelector(
      '[aria-label*="0 balls 0 strikes 0 outs · Pitches 0"]'
    )
  } finally {
    await page.close()
  }
})
it('completes a tapped caught pop fly and undoes after automatic completion', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Swing in Play')
    await click(page, 'Batter Out')
    await click(page, 'Ball Caught')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    await placeOffered(fieldOf(page))
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    await setTrajectory(fieldOf(page), 50)
    await page.waitForSelector('[aria-label*="50° Pop Fly"]')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    await click(page, 'Undo 50° Pop Fly')
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
  } finally {
    await page.close()
  }
})
it('allows exit when the game cannot be read', async function () {
  const { page, unexpected } = await open('/games/g1/score', false, true)
  try {
    await page.waitForFunction(() =>
      String(document.body.textContent).includes('Unable to load scoring.')
    )
    expect(await page.$('[aria-label="Retry loading scoring"]')).not.equals(
      null
    )
    await click(page, 'Exit Current Game')
    await page.waitForFunction(() => location.pathname === '/games/g1')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('stationary runner presents one Safe and Out pair only during the hold', async () => {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [['First base', 'Player 6']])
    await page.waitForSelector('canvas[data-field-ready="true"]')
    const rect = await page.$eval('canvas', n => {
      const r = n.getBoundingClientRect()
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
    const pt = new Vector3(BASES[1].x, 6, BASES[1].z).project(camera)
    await page.touchscreen.touchStart(
      rect.x + ((pt.x + 1) * rect.width) / 2,
      rect.y + ((1 - pt.y) * rect.height) / 2
    )
    await new Promise(resolve => setTimeout(resolve, 450))
    await page.waitForSelector('[aria-label="Safe drag target"]')
    const positions = await page.evaluate(() =>
      ['Safe drag target', 'Out drag target'].map(label => {
        const e = document.querySelector(`[aria-label="${label}"]`)!
        const r = e.getBoundingClientRect()
        return { label, x: r.x, y: r.y, width: r.width, height: r.height }
      })
    )
    expect(unexpected).deep.equals([])
    expect(positions[0].x).equals(positions[1].x)
    expect(positions[0].y + positions[0].height).at.most(positions[1].y)
    expect(positions[0].x).greaterThan(rect.x + ((pt.x + 1) * rect.width) / 2)
    await page.touchscreen.touchEnd()
    expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
  } finally {
    await page.close()
  }
})
it('keeps earlier runs when a runner is tagged out at home for third out', async () => {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await overrideBases(page, [
      ['Third base', 'Player 8'],
      ['Second base', 'Player 7']
    ])
    await click(page, 'Open scoring menu')
    await click(page, 'Overrides')
    await click(page, 'Outs 2')
    await click(page, 'Apply Override')
    await chooseHit(page, 'Triple')
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 8"]',
      { timeout: 30000 }
    )
    for (const name of ['Player 8']) {
      await page.waitForSelector(
        `[aria-label="Home plate decision for ${name}"]`,
        { timeout: 30000 }
      )
      await click(page, 'Safe')
    }
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 7"]',
      { timeout: 30000 }
    )
    await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
    await click(page, 'Out')
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
    await click(page, 'Finish defensive play')
    await page.waitForSelector('[aria-label*="Bottom 1st"]', {
      timeout: 30000
    })
    const summary = await page.$eval('[aria-label*="Owls "]', n =>
      n.getAttribute('aria-label')
    )
    expect(unexpected).deep.equals([])
    expect(summary).includes('Owls 1 · Hawks 0')
  } finally {
    await page.close()
  }
})
for (const width of [320, 390, 844])
  it(`keeps paired controls and camera framing fixed at ${width}px`, async () => {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    try {
      const height = width === 844 ? 390 : 844
      await page.setViewport({ width, height })
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await captureScene(page)
      const actual = await page.evaluate(() => {
        const camera = (window as unknown as SceneProbeWindow).qaCamera!
        const labels = [
          'More',
          'Nothing to undo',
          'Ball',
          'Called Strike',
          'Swing and Miss',
          'Foul Ball',
          'Swing in Play',
          'Bunt in Play'
        ]
        return {
          matrix: camera.matrixWorld.toArray(),
          projection: camera.projectionMatrix.toArray(),
          controls: labels.map(label => {
            const n = document.querySelector(`[aria-label="${label}"]`)!
            const r = n.getBoundingClientRect()
            const st = getComputedStyle(n)
            return {
              label,
              x: r.x,
              y: r.y,
              bottom: r.bottom,
              right: r.right,
              h: r.height,
              bg: st.backgroundColor,
              font: getComputedStyle(
                n.querySelector('[data-testid="scoring-control-label"]') == null
                  ? n
                  : n.querySelector('[data-testid="scoring-control-label"]')!
              ).fontSize,
              weight: getComputedStyle(
                n.querySelector('[data-testid="scoring-control-label"]') == null
                  ? n
                  : n.querySelector('[data-testid="scoring-control-label"]')!
              ).fontWeight,
              shadow: st.boxShadow,
              images: n.querySelectorAll('img').length
            }
          }),
          canvas: {
            width: document.querySelector('canvas')!.clientWidth,
            height: document.querySelector('canvas')!.clientHeight
          }
        }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        ...actual.canvas,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      for (const [a, b] of [
        [actual.matrix, camera.matrixWorld.toArray()],
        [actual.projection, camera.projectionMatrix.toArray()]
      ])
        a.forEach((v, i) => expect(v).closeTo(b[i], 1e-8))
      // Equal matrices preserve every projected landmark, including plate and scoreboard.
      for (const point of [
        new Vector3(0, 0, 0),
        new Vector3(27, 0, -27),
        new Vector3(0, 28.2, -135)
      ]) {
        const comparison = camera.clone()
        comparison.matrixWorld.fromArray(actual.matrix)
        comparison.matrixWorldInverse.copy(comparison.matrixWorld).invert()
        comparison.projectionMatrix.fromArray(actual.projection)
        expect(
          point
            .clone()
            .project(comparison)
            .distanceTo(point.clone().project(camera))
        ).lessThan(1e-8)
      }
      const swing = actual.controls.find(c => c.label === 'Swing in Play')!
      const bunt = actual.controls.find(c => c.label === 'Bunt in Play')!
      expect(swing.bottom - bunt.y).closeTo(120, 0.1)
      expect(swing.y - bunt.bottom).closeTo(8, 0.1)
      for (const c of actual.controls) {
        expect(c.h, c.label).closeTo(56, 0.1)
        const backgrounds: Record<string, string> = {
          More: 'rgb(28, 39, 33)',
          'Nothing to undo': 'rgb(26, 38, 32)',
          Ball: 'rgb(15, 92, 59)',
          'Called Strike': 'rgb(146, 64, 14)',
          'Swing and Miss': 'rgb(130, 30, 20)',
          'Foul Ball': 'rgb(127, 100, 69)',
          'Swing in Play': 'rgb(111, 66, 25)',
          'Bunt in Play': 'rgb(111, 66, 25)'
        }
        expect(c.bg).equals(backgrounds[c.label] ?? actual.controls[0].bg)
        expect(c.shadow).not.equals('none')
        expect(c.images).equals(0)
        expect(c.font).equals(
          ['Ball', 'Nothing to undo', 'Bunt in Play', 'Swing in Play'].includes(
            c.label
          )
            ? '12px'
            : '11px'
        )
        expect(c.weight).equals('900')
        if (c.label !== 'Nothing to undo')
          expect(c.right - c.x).closeTo(swing.right - swing.x, 0.2)
        expect(c.right).at.most(width)
        expect(c.bottom).at.most(height)
      }
      await click(page, 'Open scoring menu')
      expect(
        await page.$eval('[aria-label="Set Team Rosters"]', n => {
          const t = n.querySelector('[dir="auto"]')!
          return {
            font: getComputedStyle(t).fontSize,
            weight: getComputedStyle(t).fontWeight
          }
        })
      ).deep.equals({ font: '13px', weight: '700' })
      await page.screenshot({
        path: join(artifactDir(), `paired-controls-${width}.png`)
      })
    } finally {
      await page.close()
    }
  })
for (const outcome of ['Single', 'Ground Out'])
  it(`completes a bunt ${outcome} with distinct menus and Undo`, async () => {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Bunt in Play')
      expect(await page.$('[aria-label="Home Run"]')).equals(null)
      expect(await page.$('[aria-label="Swing in Play outcomes"]')).equals(null)
      expect(await page.$('[aria-label="Fielder\'s Choice"]')).equals(null)
      if (outcome === 'Ground Out') await click(page, 'Batter Out')
      await click(page, outcome)
      await page.waitForSelector(`[aria-label="Undo Bunt: ${outcome}"]`)
      await placeOffered(fieldOf(page))
      await setTrajectory(fieldOf(page))
      if (outcome === 'Ground Out') {
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await placeOffered(fieldOf(page), 1)
        await click(page, 'Finish defensive play')
      } else await click(page, 'Finish at-bat')
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
      await page.locator('[aria-label^="Undo "]').click()
      await page.screenshot({
        path: join(artifactDir(), `bunt-${outcome}.png`)
      })
    } finally {
      await page.close()
    }
  })
for (const kind of ['Swing', 'Bunt'])
  for (const touch of [false, true])
    it(`drags ${kind} outcomes with ${touch ? 'touch' : 'mouse'} through both menu levels`, async () => {
      const { page } = await open('/games/g1/score')
      try {
        await page.setViewport({
          width: 390,
          height: 844,
          hasTouch: touch,
          isMobile: touch
        })
        await page.waitForSelector(`[aria-label="${kind} in Play"]`)
        const center = async (
          label: string
        ): Promise<{ x: number; y: number }> =>
          await page.$eval(`[aria-label="${label}"]`, n => {
            const r = n.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          })
        const move = async (p: { x: number; y: number }): Promise<void> => {
          if (touch) await page.touchscreen.touchMove(p.x, p.y)
          else await page.mouse.move(p.x, p.y)
        }
        const trigger = await center(`${kind} in Play`)
        if (touch) await page.touchscreen.touchStart(trigger.x, trigger.y)
        else {
          await page.mouse.move(trigger.x, trigger.y)
          await page.mouse.down()
        }
        await move({ x: trigger.x, y: trigger.y - 25 })
        await page.waitForSelector('[aria-label="Batter Out"]')
        const parent = await center('Batter Out')
        await move(parent)
        await page.waitForSelector('[aria-label="Ball Caught"]')
        await move(await center('Single'))
        await page.waitForSelector('[aria-label="Ball Caught"]', {
          hidden: true
        })
        await move(parent)
        await page.waitForSelector('[aria-label="Ball Caught"]')
        await move(await center('Ball Caught'))
        if (touch) await page.touchscreen.touchEnd()
        else await page.mouse.up()
        await page.waitForSelector(
          `[aria-label="Undo ${kind === 'Bunt' ? 'Bunt: ' : ''}Ball Caught"]`
        )
        expect(await page.$('[role="menu"]')).equals(null)
      } finally {
        await page.close()
      }
    })
for (const touch of [false, true])
  it(`closes More after crossing its submenu bridge with ${touch ? 'touch' : 'mouse'}`, async () => {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        hasTouch: touch,
        isMobile: touch
      })
      await page.waitForSelector('[aria-label="More"]')
      const center = async (label: string): Promise<{ x: number; y: number }> =>
        await page.$eval(`[aria-label="${label}"]`, n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      const move = async (p: { x: number; y: number }): Promise<void> => {
        if (touch) await page.touchscreen.touchMove(p.x, p.y)
        else await page.mouse.move(p.x, p.y)
      }
      const trigger = await center('More')
      if (touch) await page.touchscreen.touchStart(trigger.x, trigger.y)
      else {
        await page.mouse.move(trigger.x, trigger.y)
        await page.mouse.down()
      }
      await move({ x: trigger.x, y: trigger.y - 20 })
      await page.waitForSelector('[aria-label="Put Batter on Base"]')
      const parent = await center('Put Batter on Base')
      await move(parent)
      await page.waitForSelector('[aria-label="First"]')
      const first = await center('First')
      await move({ x: 195, y: first.y })
      expect(await page.$('[aria-label="First"]')).not.equals(null)
      await move(first)
      await move({ x: 350, y: 140 })
      await page.waitForSelector('[aria-label="First"]', { hidden: true })
      expect(await page.$('[aria-label="First"]')).equals(null)
      await move(parent)
      if (touch) await page.touchscreen.touchEnd()
      else await page.mouse.up()
      expect(await page.$('[role="menu"]')).equals(null)
      expect(await page.$('[aria-label^="Undo Put Batter"]')).equals(null)
      await click(page, 'More')
      await page.waitForSelector('[aria-label="Hit by Pitch"]')
    } finally {
      await page.close()
    }
  })

for (const bats of ['right', 'left'] as const)
  for (const bunt of [true, false])
    it(`renders a ${bats} ${bunt ? 'ninety-degree bunt' : 'full swing'} from the outcome choice`, async () => {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        bats,
        true
      )
      try {
        await page.setViewport({ width: 390, height: 844 })
        await click(page, bunt ? 'Bunt in Play' : 'Swing in Play')
        await click(page, 'Single')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await placeOffered(fieldOf(page))
        await page.waitForSelector('[aria-label^="Ball trajectory:"]')
        await captureScene(page)
        const sampling = page.evaluate(async () => {
          const scene = (window as unknown as SceneProbeWindow).qaScene!
          const samples: Array<{ x: number; y: number; z: number }> = []
          const start = performance.now()
          let started = false
          let completed = false
          while (performance.now() - start < 12000) {
            await new Promise(requestAnimationFrame)
            const player = scene.getObjectByName('player-offense-101')
            const rig =
              player == null ? undefined : player.getObjectByName('athlete-rig')
            const bat =
              rig == null ? undefined : rig.getObjectByName('animated-bat')
            if (rig != null && rig.visible && bat != null) {
              started = true
              const d = bat.position
                .clone()
                .set(0, 1, 0)
                .applyQuaternion(bat.quaternion)
              samples.push({ x: d.x, y: d.y, z: d.z })
            } else if (started) {
              completed = true
              break
            }
          }
          return { samples, completed }
        })
        await setTrajectory(fieldOf(page))
        if (bunt) {
          await page.waitForFunction(
            () => {
              const scene = (window as unknown as SceneProbeWindow).qaScene!
              const player = scene.getObjectByName('player-offense-101')
              const rig =
                player == null
                  ? undefined
                  : player.getObjectByName('athlete-rig')
              const bat =
                rig == null ? undefined : rig.getObjectByName('animated-bat')
              return (
                rig != null &&
                rig.visible &&
                bat != null &&
                Math.abs(
                  bat.position
                    .clone()
                    .set(0, 1, 0)
                    .applyQuaternion(bat.quaternion).x
                ) > 0.98
              )
            },
            { polling: 'raf' }
          )
          await page.screenshot({
            path: join(artifactDir(), `bunt-contact-${bats}.png`)
          })
        }
        const { samples, completed } = await sampling
        expect(completed, 'rendered batting motion must finish').equals(true)
        expect(samples.length, 'observe actual rendered motion').greaterThan(0)
        if (bunt) {
          expect(
            samples.every(d => d.y >= -0.00001 && Math.abs(d.z) < 0.00001)
          ).equals(true)
          expect(
            samples.some(d => (bats === 'right' ? d.x > 0.98 : d.x < -0.98))
          ).equals(true)
        } else expect(samples.some(d => Math.abs(d.z) > 0.4)).equals(true)
        await click(page, 'Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
        await page.locator('[aria-label^="Undo "]').click()
      } finally {
        await page.close()
      }
    })
for (const width of [390, 844])
  for (const homeRun of [false, true])
    it(`pulses yellow guidance text without badges for ${homeRun ? 'home run' : 'single'} at ${width}px`, async () => {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right'
      )
      try {
        await page.setViewport({ width, height: width === 390 ? 844 : 390 })
        await click(page, 'Swing in Play')
        await click(page, homeRun ? 'Home Run' : 'Single')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        if (homeRun)
          await page.waitForSelector('[aria-label^="Home run type:"]')
        if (homeRun) {
          // Placed on the guide, where it already points.
          const guide = await readGuide(page)
          await aimLandingAt(fieldOf(page), guide.x, guide.z)
        } else await placeOffered(fieldOf(page))
        await page.waitForSelector('[aria-label^="Ball trajectory:"]')
        const style = await page.$$eval('[data-testid$=" value"]', nodes =>
          nodes.map(node => {
            const st = getComputedStyle(node)
            const parent = getComputedStyle(node.parentElement!)
            return {
              color: st.color,
              weight: st.fontWeight,
              background: parent.backgroundColor,
              radius: parent.borderRadius
            }
          })
        )
        expect(style).has.length(homeRun ? 2 : 1)
        for (const row of style)
          expect(row).deep.equals({
            color: 'rgb(241, 207, 85)',
            weight: '700',
            background: 'rgba(0, 0, 0, 0)',
            radius: '0px'
          })
        const samples = await page.evaluate(async () => {
          const shadow = document.querySelector(
            '[data-testid="Ball trajectory shadow"]'
          )!
          const foreground = document.querySelector(
            '[data-testid="Ball trajectory value"]'
          )!
          const result: Array<{ shadow: number; foreground: number }> = []
          const begin = performance.now()
          while (performance.now() - begin < 3500) {
            await new Promise(requestAnimationFrame)
            result.push({
              shadow: Number(getComputedStyle(shadow).opacity),
              foreground: Number(getComputedStyle(foreground).opacity)
            })
          }
          return result
        })
        expect(Math.max(...samples.map(s => s.shadow))).greaterThan(0.8)
        expect(Math.min(...samples.map(s => s.shadow))).lessThan(0.2)
        expect(samples.every(s => s.foreground === 1)).equals(true)
        await page.screenshot({
          path: join(
            artifactDir(),
            `guidance-${homeRun ? 'home-run' : 'single'}-${width}.png`
          )
        })
        await page.emulateMediaFeatures([
          { name: 'prefers-reduced-motion', value: 'reduce' }
        ])
        await page.waitForFunction(
          () =>
            getComputedStyle(
              document.querySelector('[data-testid="Ball trajectory shadow"]')!
            ).opacity === '0'
        )
        await page.emulateMediaFeatures([
          { name: 'prefers-reduced-motion', value: 'no-preference' }
        ])
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(
                document.querySelector(
                  '[data-testid="Ball trajectory shadow"]'
                )!
              ).opacity
            ) > 0.5
        )
        await page.locator('[aria-label^="Undo "]').click()
        expect(await page.$('[data-testid="Ball trajectory shadow"]')).equals(
          null
        )
      } finally {
        await page.close()
      }
    })
it('holds the browser live badge still, with or without reduced motion', async () => {
  const { page, unexpected } = await open(
    '/games/g1',
    false,
    false,
    false,
    'right',
    false,
    undefined,
    true
  )
  try {
    // A game not yet started opens on Info; its camera is under Videos.
    await page
      .locator('[aria-label="Game sections"] [aria-label="Videos"]')
      .click()
    await page.waitForSelector('[aria-label="Live now"]')
    const sample = async (
      selector: string,
      transform = false
    ): Promise<number[]> =>
      await page.evaluate(
        async (selector, transform) => {
          const node = document.querySelector(selector)!
          const values: number[] = []
          const start = performance.now()
          while (performance.now() - start < 3500) {
            await new Promise(requestAnimationFrame)
            const style = getComputedStyle(node)
            values.push(
              transform
                ? new DOMMatrixReadOnly(style.transform).m41
                : Number(style.opacity)
            )
          }
          return values
        },
        selector,
        transform
      )
    // Movement over a live picture costs the browser frames, so the pill
    // the web draws holds still whatever the viewer's motion setting.
    const still = await sample('[aria-label="Live now"]')
    expect(still.every(value => value === 1)).equals(true)
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ])
    expect(
      (await sample('[aria-label="Live now"]')).every(value => value === 1)
    ).equals(true)
    await page.screenshot({
      path: join(artifactDir(), 'reanimated-live.png')
    })
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('pulses the switch-hitter hint with Reanimated and stops it for reduced motion and dismissal', async () => {
  const { page } = await open('/games/g1/score')
  try {
    await page.evaluate(() => {
      localStorage.removeItem('teamstation:scoring:100:switch-hitter')
    })
    await page.reload()
    const selector = '[aria-label="Drag to the other batter box"]'
    await page.waitForSelector(selector)
    const values = await page.evaluate(async selector => {
      const node = document.querySelector(selector)!
      const result: number[] = []
      const start = performance.now()
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame)
        result.push(Number(getComputedStyle(node).opacity))
      }
      return result
    }, selector)
    expect(Math.min(...values)).within(0.29, 0.4)
    expect(Math.max(...values)).greaterThan(0.9)
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ])
    await page.waitForFunction(
      selector =>
        getComputedStyle(document.querySelector(selector)!).opacity === '1',
      {},
      selector
    )
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ])
    await page.waitForFunction(
      selector =>
        Number(getComputedStyle(document.querySelector(selector)!).opacity) <
        0.5,
      {},
      selector
    )
    await click(page, 'OK')
    expect(await page.$(selector)).equals(null)
  } finally {
    await page.close()
  }
})
for (const [width, height, direction, outcome] of [
  [390, 844, -1, 'Single'],
  [844, 390, 1, 'Single'],
  [390, 844, -1, 'Home Run'],
  [844, 390, 1, 'Home Run']
] as const) {
  it(`shows the trajectory polish grip and grass apron for ${outcome} at ${width}px`, async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    try {
      await page.setViewport({ width, height })
      await click(page, 'Swing in Play')
      await click(page, outcome)
      await page.waitForSelector('canvas[data-field-ready="true"]')
      if (outcome === 'Single')
        // The pitcher takes it out and to the side.
        await placeOffered(fieldOf(page), 0, 60, direction * 50)
      else {
        await captureScene(page)
        expect(
          await page.evaluate(() => {
            const ring = (
              window as unknown as SceneProbeWindow
            ).qaScene!.getObjectByName('destination-ring') as Mesh
            return (
              ring.geometry as unknown as {
                parameters: { outerRadius: number }
              }
            ).parameters.outerRadius
          })
        ).equals(11)
        const guide = await readGuide(page)
        await aimLandingAt(
          fieldOf(page),
          guide.x,
          guide.z - (direction > 0 ? 15 : 0)
        )
      }
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await captureScene(page)
      await page.waitForFunction(() => {
        const scene = (window as unknown as SceneProbeWindow).qaScene!
        return scene.getObjectByName('arc-angle-handle')!.scale.x !== 1
      })
      const data = await page.evaluate(() => {
        const host = window as unknown as SceneProbeWindow
        const scene = host.qaScene!
        const camera = host.qaCamera!
        const box = document.querySelector('canvas')!.getBoundingClientRect()
        const handle = scene.getObjectByName('arc-angle-handle')!
        const target = scene.getObjectByName('destination-marker')!
        const ring = scene.getObjectByName('destination-ring') as Mesh
        const world = handle.position.clone()
        const screen = world.clone().project(camera)
        const home = world.clone().set(0, 0.7, 0).project(camera)
        const landing = target.position
          .clone()
          .setY(target.position.y - 0.1)
          .project(camera)
        const footprint = (scene.getObjectByName('grass-apron') as Mesh)
          .geometry
        footprint.computeBoundingBox()
        return {
          x: box.x + ((screen.x + 1) * box.width) / 2,
          y: box.y + ((1 - screen.y) * box.height) / 2,
          midpointError:
            (Math.abs(screen.y - (home.y + landing.y) / 2) * box.height) / 2,
          radius: (
            ring.geometry as unknown as {
              parameters: { outerRadius: number }
            }
          ).parameters.outerRadius,
          color: (
            ring.material as unknown as {
              color: { getHexString: () => string }
            }
          ).color.getHexString(),
          rings: handle.children.filter(c => c.name === 'arc-grab-ring').length,
          arrows: handle.children.filter(c => c.name === 'arc-pulse-arrow')
            .length,
          grassBack: -footprint.boundingBox!.min.y,
          camera: camera.matrixWorld.toArray()
        }
      })
      expect(data.midpointError).lessThan(1)
      expect(data.radius).equals(5.5)
      expect(data.color).equals('ffffff')
      expect(data.rings).equals(3)
      expect(data.arrows).equals(6)
      expect(data.grassBack).closeTo(15.24, 0.01)
      await page.screenshot({
        path: `${artifactDir()}/trajectory-polish-${outcome}-${width}.png`
      })
      await page.mouse.move(data.x, data.y)
      await page.mouse.down()
      await page.mouse.move(data.x, data.y - 30, { steps: 8 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label^="Undo "]')
      expect(
        await page.evaluate(() =>
          (
            window as unknown as SceneProbeWindow
          ).qaCamera!.matrixWorld.toArray()
        )
      ).deep.equals(data.camera)
    } finally {
      await page.close()
    }
  })
}
for (const [width, height] of [
  [390, 844],
  [844, 390]
])
  it(`names the teams inside a full-width Away/Home pill at ${width}×${height}`, async function () {
    const { page } = await open('/games/g1/score')
    const box = async (
      selector: string
    ): Promise<{ x: number; y: number; width: number; height: number }> =>
      await page.$eval(selector, n => {
        const r = n.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
    try {
      await page.setViewport({ width, height })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await page.waitForSelector('[data-testid="Roster selector captions"]')
      await new Promise(resolve => setTimeout(resolve, 300))
      const footer = await box('[data-testid="Roster footer"]')
      const away = await box('[aria-label="Away Team"]')
      const home = await box('[aria-label="Home Team"]')
      expect(away.x).closeTo(footer.x, 1)
      expect(home.x + home.width).closeTo(footer.x + footer.width, 1)
      expect(
        await page.$eval('[aria-label="Away Team"]', n => n.textContent)
      ).equals('Owls')
      expect(
        await page.$eval('[aria-label="Home Team"]', n => n.textContent)
      ).equals('Hawks')
      // "Away" and "Home" sit above their halves, centred on them.
      const captions = await page.$$eval(
        '[data-testid="Roster selector captions"] > * > *',
        nodes =>
          nodes.map(n => {
            const r = n.getBoundingClientRect()
            return {
              text: n.textContent,
              centre: r.x + r.width / 2,
              bottom: r.bottom
            }
          })
      )
      expect(captions.map(c => c.text)).deep.equals(['Away', 'Home'])
      expect(captions[0].centre).closeTo(away.x + away.width / 2, 2)
      expect(captions[1].centre).closeTo(home.x + home.width / 2, 2)
      for (const caption of captions)
        expect(caption.bottom).at.most(Math.min(away.y, home.y))
      // No team name stands on its own outside the pill.
      const loose = await page.$$eval(
        'body *',
        nodes =>
          nodes.filter(
            n =>
              n.children.length === 0 &&
              ['Owls', 'Hawks'].includes(String(n.textContent)) &&
              n.closest('[role="tab"]') == null
          ).length
      )
      expect(loose).equals(0)
      // Both pills show whole inside the editor's top area.
      const top = await box('[data-testid="Roster editor top"]')
      for (const tab of ['Away Team', 'Lineup', 'Defense']) {
        const r = await box(`[aria-label="${tab}"]`)
        expect(r.y).at.least(top.y - 0.5)
        expect(r.y + r.height).at.most(top.y + top.height + 0.5)
      }
      if (artifactDir() != null)
        await page.screenshot({
          path: `${artifactDir()}/roster-pill-${width}.png`
        })
      // Tapping the right half picks the home team; dragging back picks away.
      const lineup = async (): Promise<string> =>
        await page.$eval('[aria-label="Batting lineup"]', n =>
          String(n.textContent)
        )
      const awayLineup = await lineup()
      await click(page, 'Home Team')
      await page.waitForSelector(
        '[aria-label="Home Team"][aria-selected="true"]'
      )
      expect(await lineup()).not.equals(awayLineup)
      // Measured again: choosing a side can scroll the top of the editor.
      const from = await box('[aria-label="Home Team"]')
      const to = await box('[aria-label="Away Team"]')
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
        steps: 8
      })
      await page.mouse.up()
      await page.waitForSelector(
        '[aria-label="Away Team"][aria-selected="true"]'
      )
      expect(await lineup()).equals(awayLineup)
      await click(page, 'Cancel')
    } finally {
      await page.close()
    }
  })
it('lists the roster by jersey number with players who have none last', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    const create = async (
      first: string,
      last: string,
      jersey: string
    ): Promise<void> => {
      await click(page, 'Create Player')
      await page.locator('[aria-label="First Name"]').fill(first)
      await page.locator('[aria-label="Last Name"]').fill(last)
      if (jersey !== '')
        await page.locator('[aria-label="Jersey Number"]').fill(jersey)
      await click(page, 'Create Player')
      await page.waitForSelector('[aria-label="First Name"]', {
        hidden: true
      })
    }
    // Added out of order, then five placeholders.
    await create('Aaron', 'Judge', '')
    await create('Mookie', 'Betts', '10')
    await openPlaceholderSheet(page)
    await new Promise(resolve => setTimeout(resolve, 400))
    await click(page, 'Player count 5')
    await page.waitForSelector(
      '[aria-label="Player count 5"][aria-selected="true"]'
    )
    // The list scrolls to the count it was given; let it settle there.
    await new Promise(resolve => setTimeout(resolve, 600))
    await page.waitForSelector(
      '[aria-label="Player count 5"][aria-selected="true"]'
    )
    await click(page, 'Create')
    await page.waitForSelector('[aria-label="Number of placeholder players"]', {
      hidden: true
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    if ((await page.$('[aria-label="First Name"]')) != null)
      await page.keyboard.press('Escape')
    await page.waitForSelector('[aria-label="First Name"]', { hidden: true })
    const roster = async (): Promise<string[]> =>
      await page.$$eval(
        '[data-roster-target="roster"] [data-roster-player]',
        // Each row starts with its drag grip.
        nodes => nodes.map(n => String(n.textContent).replace(/^≡/, '').trim())
      )
    const rows = await roster()
    expect(rows).length(2 + 5)
    const numbers = rows.map(row => /^#(\d+)/.exec(row)?.[1])
    const numbered = numbers.filter(number => number != null)
    // Numbers first, lowest first; then everyone without one, by name.
    expect(numbers.slice(0, numbered.length)).deep.equals(numbered)
    expect(numbered.map(Number)).deep.equals(
      [...numbered].map(Number).sort((a, b) => a - b)
    )
    expect(numbered.at(-1)).equals('10')
    const unnumbered = rows.slice(numbered.length)
    expect(unnumbered).deep.equals(
      [...unnumbered].sort((a, b) => a.localeCompare(b))
    )
    expect(unnumbered).includes('Aaron J')
    await click(page, 'Defense')
    expect(await roster()).deep.equals(rows)
    await click(page, 'Lineup')
    // The lineup keeps the order it is built in.
    await click(page, 'Add Mookie B to Lineup')
    const lineup = await page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes => nodes.map(n => String(n.textContent))
    )
    expect(lineup.at(-1)).includes('Mookie B')
    await click(page, 'Cancel')
  } finally {
    await page.close()
  }
})
it('keeps a long team name on one line inside its half of the pill', async function () {
  server.awayTeamName('The Extremely Long Named Visiting Squadron')
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await page.waitForSelector('[data-testid="Roster selector captions"]')
    await new Promise(resolve => setTimeout(resolve, 300))
    const sizes = await page.$$eval('[role="tab"]', nodes =>
      nodes.slice(0, 2).map(n => {
        const r = n.getBoundingClientRect()
        const text = n.firstElementChild!.getBoundingClientRect()
        return { width: r.width, height: r.height, textHeight: text.height }
      })
    )
    expect(sizes[0].width).closeTo(sizes[1].width, 1)
    expect(sizes[0].height).closeTo(sizes[1].height, 1)
    expect(sizes[0].textHeight).closeTo(sizes[1].textHeight, 1)
    expect(
      await page.$eval('[aria-label="Away Team"]', n => n.textContent)
    ).equals(server.awayTeamNameNow())
    await click(page, 'Cancel')
  } finally {
    server.awayTeamName(undefined)
    await page.close()
  }
})
it('roster flow keeps compact selectors and footer visible while full cards animate between columns', async function () {
  const { page } = await open(
    '/games/g1/score',
    false,
    false,
    false,
    'switch',
    false,
    undefined,
    true
  )
  const rect = async (
    selector: string
  ): Promise<{
    x: number
    y: number
    width: number
    height: number
    bottom: number
  }> =>
    await page.$eval(selector, n => {
      const r = n.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        bottom: r.bottom
      }
    })
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    for (const name of ['Jordan K.', 'Player 2', 'Player 3'])
      await click(page, `Remove ${name}`)
    await new Promise(resolve => setTimeout(resolve, 350))
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    for (const [width, height] of [
      [390, 844],
      [844, 390]
    ]) {
      await page.setViewport({
        width,
        height,
        isMobile: true,
        hasTouch: true
      })
      await new Promise(resolve => setTimeout(resolve, 250))
      const footer = await rect('[data-testid="Roster footer"]')
      // The team pill spans the editor, one half per team.
      const awayTab = await rect('[aria-label="Away Team"]')
      const homeTab = await rect('[aria-label="Home Team"]')
      expect(awayTab.x).closeTo(footer.x, 1)
      expect(homeTab.x + homeTab.width).closeTo(footer.x + footer.width, 1)
      expect(awayTab.width).closeTo(homeTab.width, 1)
      expect((await rect('[aria-label="Lineup"]')).height).equals(36)
      expect(footer.bottom).at.most(height)
      expect(height - footer.bottom).lessThan(30)
      for (const label of ['Roster players', 'Batting lineup']) {
        const list = await rect(`[aria-label="${label}"]`)
        expect(list.height).greaterThan(60)
        expect(list.bottom).at.most(footer.y)
      }
      if (artifactDir() != null)
        await page.screenshot({
          path: `${artifactDir()}/roster-flow-${width}.png`
        })
    }
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await page.$$eval(
      '[aria-label="Roster players"], [aria-label="Batting lineup"]',
      lists => {
        lists.forEach(n => {
          n.scrollTop = 0
        })
      }
    )
    await new Promise(resolve => setTimeout(resolve, 1200))
    const source = '[data-roster-target="roster"] [data-roster-player="102"]'
    const third = '[data-roster-target="roster"] [data-roster-player="103"]'
    const a = await rect(source)
    const following = await rect(third)
    expect(following.y - a.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
    const destination = await rect('[data-roster-target="lineup-1"]')
    const next = await rect('[data-roster-target="lineup-2"]')
    expect(next.y - destination.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
    await page.touchscreen.touchStart(a.x + 17, a.y + 13)
    await new Promise(resolve => setTimeout(resolve, 750))
    const ghost = '[data-testid="Roster dragged card"]'
    await page.waitForFunction(
      selector =>
        document.querySelector(selector)!.getBoundingClientRect().height < 1,
      {},
      source
    )
    expect((await rect(source)).height).lessThan(1)
    expect((await rect(third)).y).lessThan(following.y - 40)
    // The lifted card's place closes to one gap between its neighbours.
    await new Promise(resolve => setTimeout(resolve, 250))
    const above = await rect(
      '[data-roster-target="roster"] [data-roster-player="101"]'
    )
    expect((await rect(third)).y - above.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
    await page.touchscreen.touchMove(destination.x + 17, destination.y + 10)
    await new Promise(resolve => setTimeout(resolve, 250))
    const floating = await rect(ghost)
    expect(floating.width).closeTo(a.width, 1)
    expect(floating.height).closeTo(a.height, 1)
    expect(floating.x).closeTo(destination.x, 1)
    expect(floating.y).closeTo(destination.y - 3, 1)
    expect(await page.$eval(ghost, n => n.textContent)).includes('#2 Player 2')
    await page.waitForFunction(
      y =>
        document
          .querySelector('[data-roster-target="lineup-2"]')!
          .getBoundingClientRect().y >
        y + 40,
      {},
      next.y
    )
    expect((await rect('[data-roster-target="lineup-2"]')).y).greaterThan(
      next.y + 40
    )
    if (artifactDir() != null)
      await page.screenshot({
        path: `${artifactDir()}/roster-flow-drag.png`
      })
    await page.touchscreen.touchEnd()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-1"]')!
          .getAttribute('data-roster-player') === '102'
    )
    expect(await page.$(ghost)).equals(null)
    await page.waitForFunction(
      selector => document.querySelector(selector) == null,
      {},
      source
    )
    // The dropped card lands in the gap the drag held open: a lineup card's
    // full height, one gap from each neighbour, drawn over neither. It
    // grows to that height as it lands, which a droplet draws slowly.
    await page
      .waitForFunction(
        height =>
          Math.abs(
            document
              .querySelector('[data-roster-target="lineup-1"]')!
              .getBoundingClientRect().height - height
          ) <= 1,
        { timeout: 3000 },
        destination.height
      )
      .catch(() => undefined)
    const landed = await rect('[data-roster-target="lineup-1"]')
    expect(landed.height).closeTo(destination.height, 1)
    expect(
      landed.y - (await rect('[data-roster-target="lineup-0"]')).bottom
    ).closeTo(ROSTER_CARD_GAP, 0.5)
    expect(
      (await rect('[data-roster-target="lineup-2"]')).y - landed.bottom
    ).closeTo(ROSTER_CARD_GAP, 0.5)
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
  } finally {
    await page.close()
  }
})
for (const outcome of ['Single', 'Ball Caught'] as const)
  it(`keeps the fielding position through an 85-degree high fly for ${outcome}`, async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Swing in Play')
      if (outcome === 'Ball Caught') await click(page, 'Batter Out')
      await click(page, outcome)
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await captureScene(page)
      const before = await page.evaluate(() => {
        const host = window as unknown as SceneProbeWindow
        return {
          player: host
            .qaScene!.getObjectByName('player-defense-201')!
            .position.toArray(),
          camera: host.qaCamera!.position.toArray()
        }
      })
      // The pitcher takes it on his way in, a short landing in front of
      // home.
      await placeOffered(fieldOf(page), 0, -40)
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      // Held while the angle is dragged up to its limit: what the screen
      // shows before the scorer lets go.
      const grip = await page.$eval('canvas', node => {
        const r = node.getBoundingClientRect()
        return [r.x + r.width / 2, r.y + r.height / 2] as [number, number]
      })
      await page.mouse.move(...grip)
      await page.mouse.down()
      await page.mouse.move(grip[0], grip[1] - 120, { steps: 20 })
      await page.waitForSelector('[aria-label="Ball trajectory: 85° Pop Fly"]')
      await captureScene(page)
      const selected = await page.evaluate(() => {
        const host = window as unknown as SceneProbeWindow
        const curve = host.qaScene!.getObjectByName('ball-trajectory') as Mesh
        curve.geometry.computeBoundingBox()
        return {
          player: host
            .qaScene!.getObjectByName('player-defense-201')!
            .position.toArray(),
          camera: host.qaCamera!.position.toArray(),
          apex: curve.geometry.boundingBox!.max.y
        }
      })
      expect(selected.player).deep.equals(before.player)
      expect(selected.camera).deep.equals(before.camera)
      expect(selected.apex).greaterThan(15)
      if (artifactDir() != null)
        await page.screenshot({
          path: join(
            artifactDir(),
            `high-fly-${outcome.replaceAll(' ', '-')}.png`
          )
        })
      const sample = page.evaluate(async () => {
        const scene = (window as unknown as SceneProbeWindow).qaScene!
        const samples: number[][] = []
        const start = performance.now()
        while (performance.now() - start < 2300) {
          await new Promise(requestAnimationFrame)
          samples.push(
            scene.getObjectByName('player-defense-201')!.position.toArray()
          )
        }
        return samples
      })
      await page.mouse.up()
      const positions = await sample
      expect(positions.some(p => Math.abs(p[2] - before.player[2]) > 1)).equals(
        true
      )
      expect(
        positions.some(p => p[2] > before.player[2] + 1 && p[2] < -4)
      ).equals(true)
    } finally {
      await page.close()
    }
  })

export default defineHarness({
  id: 'scoring/scoring-screen/controls-and-layout',
  title:
    'Paired controls, menus, bunts, guidance, badges, pills and long names',
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
  minutes: 86,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
