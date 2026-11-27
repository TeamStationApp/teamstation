import { join } from 'node:path'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { BASES } from '../../../../src/app/field/fieldModel'
import { defineHarness } from '../../../core/spec'
import {
  dropOfferedRunner,
  placeOffered,
  setTrajectory,
  tapOffered
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  captureScene,
  chooseHit,
  click,
  fieldOf,
  open,
  overrideBases,
  type SceneProbeWindow,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * The correction window, the More halves and runner drafts.
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

it('places a fielder on the rendered field and cancels then accepts a trajectory drag', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await click(page, 'Swing in Play')
    await click(page, 'Single')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    const box = await page.$eval('canvas', canvas => {
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const camera = new PerspectiveCamera(43, box.width / box.height, 2, 1100)
    applyFieldCamera(camera, {
      width: box.width,
      height: box.height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    const point = (x: number, z: number): [number, number] => {
      const p = new Vector3(x, 6, z).project(camera)
      return [
        box.x + ((p.x + 1) * box.width) / 2,
        box.y + ((1 - p.y) * box.height) / 2
      ]
    }
    await page.mouse.move(...point(0, -18.44))
    await page.mouse.down()
    await page.mouse.move(...point(12, -40), { steps: 12 })
    await page.mouse.up()
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    if (artifactDir() != null)
      await page.screenshot({
        path: `${artifactDir()}/fielder-trajectory.png`
      })
    await page.mouse.move(500, 500)
    await page.mouse.down()
    await page.mouse.move(500, 620, { steps: 12 })
    await page.$eval('[aria-label="Baseball field"]', node =>
      node.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: 500,
          clientY: 620
        })
      )
    )
    await page.mouse.up()
    await page.waitForSelector('[aria-label*="45° Fly Ball"]')
    await page.mouse.move(500, 500)
    await page.mouse.down()
    await page.mouse.move(500, 620, { steps: 12 })
    await page.mouse.up()
    await page.waitForSelector('[aria-label="Undo -15° Ground Ball"]')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('runs a real seven-second correction window, pauses it for Settings and closes once', async function () {
  this.timeout(90000)
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Settings')
    const seconds = await page.$eval('[aria-label="Time to edit play"]', node =>
      node.getAttribute('aria-valuenow')
    )
    expect(Number(seconds)).within(1, 7)
    await new Promise(resolve => setTimeout(resolve, 10500))
    expect(
      await page.$eval('[aria-label="Time to edit play"]', node =>
        node.getAttribute('aria-valuenow')
      )
    ).equals(seconds)
    await click(page, 'Done')
    const background = await page.browserContext().newPage()
    await background.bringToFront()
    expect(await page.evaluate(() => document.hidden)).equals(true)
    await new Promise(resolve => setTimeout(resolve, 10500))
    expect(
      await page.$eval('[aria-label="Time to edit play"]', node =>
        node.getAttribute('aria-valuenow')
      )
    ).equals(seconds)
    await background.close()
    await page.bringToFront()
    const resumed = Date.now()
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 20000
    })
    expect(Date.now() - resumed).greaterThan((Number(seconds) - 1) * 1000 - 200)
    await click(page, 'Ball')
    await waitReady(page)
    await dropOfferedRunner(fieldOf(page), 'Safe')
    await waitReady(page)
    await page.waitForSelector(
      '[aria-label*="1 balls 0 strikes 0 outs · Pitches 2"]'
    )
    await dropOfferedRunner(fieldOf(page), 'Safe', true)
    await click(page, 'Steal')
    await waitReady(page)
    await page.waitForSelector(
      '[aria-label*="1 balls 0 strikes 0 outs · Pitches 2"]'
    )
    expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('requires every triple home arrival to be Safe or Out and credits a defender', async function () {
  this.timeout(90000)
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await overrideBases(page, [
      ['First base', 'Player 6'],
      ['Second base', 'Player 7'],
      ['Third base', 'Player 8']
    ])
    await chooseHit(page, 'Triple')
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 8"]',
      { timeout: 30000 }
    )
    expect(await page.$('[aria-label="Back"]')).equals(null)
    await click(page, 'Safe')
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 7"]',
      { timeout: 30000 }
    )
    await click(page, 'Out')
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
    await click(page, 'Finish defensive play')
    await page.waitForSelector(
      '[aria-label="Home plate decision for Player 6"]',
      { timeout: 30000 }
    )
    await click(page, 'Safe')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await page.waitForSelector('[aria-label*="Owls 2 · Hawks 0"]')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('recovers a one-player lineup after timer expiry and can undo the repair', async function () {
  this.timeout(90000)
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
    await click(page, 'Save Rosters')
    await click(page, 'Accept Lineup')
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label^="Next batter is on base."]', {
      timeout: 30000
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Roster')
    await click(page, 'Create Player')
    await page.locator('[aria-label="First Name"]').fill('Mike')
    await page.locator('[aria-label="Last Name"]').fill('Trout')
    await click(page, 'Create Player')
    await click(page, 'Lineup')
    await click(page, 'Add Mike T to Lineup')
    await click(page, 'Next batter Mike T')
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label*="Batter Mike T"]')
    await click(page, 'Undo Set team roster')
    await page.waitForSelector('[aria-label^="Next batter is on base."]')
    // The hit is still on this screen's history, though the roster was
    // read again from the server.
    await click(page, 'Undo 45° Fly Ball')
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
  } finally {
    await page.close()
  }
})
for (const width of [320, 390, 844]) {
  it(`keeps More halves fixed and extends the field at ${width}px`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width, height: width === 844 ? 390 : 844 })
      await click(page, 'More')
      const bounds = async (
        label: string
      ): Promise<{
        x: number
        y: number
        right: number
        bottom: number
        width: number
      }> =>
        await page.$eval(`[aria-label="${label}"]`, node => {
          const r = node.getBoundingClientRect()
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: r.width
          }
        })
      const parent = await bounds('More scoring actions')
      expect(parent.right).at.most(width / 2)
      const headingCount = await page.$eval(
        '[aria-label="More scoring actions"]',
        panel =>
          Array.from(panel.querySelectorAll('div')).filter(n =>
            ['Between pitches', "Didn't see it", 'This pitch'].includes(
              // Browser closures cannot reference Sucrase's nullish helper.
              // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
              n.textContent == null ? '' : n.textContent
            )
          ).length
      )
      expect(headingCount).equals(0)

      expect(
        await page.$eval('[aria-label="Put Batter on Base"]', n => ({
          font: getComputedStyle(n).fontSize,
          weight: getComputedStyle(n).fontWeight
        }))
      ).deep.equals({ font: '13px', weight: '700' })
      await click(page, 'Put Batter on Base')
      expect(await bounds('More scoring actions')).deep.equals(parent)
      expect((await bounds('Batter base')).x).at.least(width / 2)
      await page.focus('[aria-label="First"]')
      expect(
        await page.$eval('[aria-label="First"]', node => ({
          bg: getComputedStyle(node).backgroundImage,
          text: getComputedStyle(node).color
        }))
      ).deep.equals({
        bg: 'linear-gradient(to right, rgb(29, 107, 66), rgb(22, 88, 53))',
        text: 'rgb(255, 255, 255)'
      })
      const child = await bounds('Batter base')
      expect(child.bottom).at.most(width === 844 ? 390 : 844)
      if (artifactDir() != null)
        await page.screenshot({
          path: join(artifactDir(), `menus-more-${width}.png`)
        })
      await page.keyboard.press('Escape')
      expect(await page.$('[aria-label="More scoring actions"]')).equals(null)
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      expect(
        await page.$eval('[aria-label="Ground Out"]', n => ({
          font: getComputedStyle(n).fontSize,
          weight: getComputedStyle(n).fontWeight
        }))
      ).deep.equals({ font: '13px', weight: '700' })
      for (const label of [
        'Ground Out',
        'Ball Caught',
        'Batter Interference'
      ]) {
        const row = await bounds(label)
        expect(row.y).at.least(0)
        expect(row.bottom).at.most(width === 844 ? 390 : 844)
      }
      if (artifactDir() != null)
        await page.screenshot({
          path: join(artifactDir(), `menus-outcome-${width}.png`)
        })
      await click(page, 'Dismiss outcomes')
      const geometry = await page.$eval('canvas', node => ({
        bottom: node.getBoundingClientRect().bottom,
        height: window.innerHeight
      }))
      expect(geometry.bottom).closeTo(geometry.height, 1)
    } finally {
      await page.close()
    }
  })
}
it('opens More on upward drag and releases an action or escapes right', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await page.waitForSelector('[aria-label="More"]')
    const trigger = await page.$eval('[aria-label="More"]', node => {
      const r = node.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.mouse.move(trigger.x, trigger.y)
    await page.mouse.down()
    await page.mouse.move(trigger.x, trigger.y - 20)
    await page.waitForSelector('[aria-label="Hit by Pitch"]')
    const row = await page.$eval('[aria-label="Hit by Pitch"]', node => {
      const r = node.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.mouse.move(row.x, row.y)
    await page.mouse.up()
    await page.waitForSelector('[aria-label="Undo Hit by Pitch"]')
    await waitReady(page)
    expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
    await page.mouse.move(trigger.x, trigger.y)
    await page.mouse.down()
    await page.mouse.move(trigger.x, trigger.y - 20)
    await page.mouse.move(500, trigger.y - 100)
    await page.mouse.up()
    expect(await page.$('[aria-label="Hit by Pitch"]')).equals(null)
    await click(page, 'More')
    await page.waitForSelector('[aria-label="Hit by Pitch"]')
    await click(page, 'Dismiss More')
  } finally {
    await page.close()
  }
})
for (const action of [
  'Hit by Pitch',
  'Intentional Walk',
  "Catcher's Interference",
  // Field-based tiebreaker coverage is in scoringUiPolish.e2e.ts,
  // using the shared Maestro device/browser flow.
  'Put Batter on Base',
  'Balk',
  'Batter Out — Other',
  'Dropped Third Strike'
])
  it(`More executes ${action} locally`, async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      if (['Balk', 'Wild Pitch', 'Passed Ball'].includes(action)) {
        await overrideBases(page, [['First base', 'Player 6']])
      }
      if (action === 'Wild Pitch' || action === 'Passed Ball')
        await click(page, 'Ball')
      if (action === 'Dropped Third Strike') {
        await click(page, 'Called Strike')
        await click(page, 'Called Strike')
      }
      await click(page, 'More')
      await click(page, action)
      if (action === 'Put Batter on Base') {
        await click(page, 'Third')
      }
      if (action === 'Dropped Third Strike') {
        await page.waitForSelector(
          '[aria-label="Runner decision for Jordan K."]',
          { timeout: 30000 }
        )
        await click(page, 'Safe')
      }
      if (action === 'Batter Out — Other') {
        await placeOffered(fieldOf(page))
        await click(page, 'Finish defensive play')
      }
      const windowExpected = ![
        'Put Batter on Base',
        'Hit by Pitch',
        'Intentional Walk',
        "Catcher's Interference",
        'Batter Out — Other',
        'Wild Pitch',
        'Passed Ball',
        'Balk'
      ].includes(action)
      if (windowExpected) {
        await page.waitForSelector('[aria-label="Finish at-bat"]', {
          timeout: 30000
        })
        await click(page, 'Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
      } else await waitReady(page)
      const expected =
        action === 'Hit by Pitch'
          ? 1
          : action === 'Dropped Third Strike'
            ? 3
            : ['Wild Pitch', 'Passed Ball'].includes(action)
              ? 1
              : 0
      await page.waitForSelector(`[aria-label*="Pitches ${expected}"]`)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
it('cancels an entire runner draft by button, outside or Escape and commits one edit', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await overrideBases(page, [['First base', 'Player 6']])
    await click(page, 'Ball')
    await waitReady(page)
    const propose = async (): Promise<void> => {
      await dropOfferedRunner(fieldOf(page), 'Safe', true)
      await page.waitForSelector('[aria-label="Steal"]')
      await page.waitForSelector('[role="dialog"]')
    }
    for (const how of ['Cancel', 'Dismiss sheet', 'Escape']) {
      await propose()
      if (how === 'Escape') await page.keyboard.press('Escape')
      else await click(page, how)
      await page.waitForSelector('[aria-label="Steal"]', { hidden: true })
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      expect(await page.$('[aria-label="Safe"]')).equals(null)
      expect(await page.$('[aria-label="Undo Ball"]')).not.equals(null)
    }
    await propose()
    await click(page, 'Steal')
    await waitReady(page)
    await click(page, 'Undo Steal')
    expect(await page.$('[aria-label="Safe"]')).equals(null)
    expect(await page.$('[aria-label="Undo Ball"]')).not.equals(null)
  } finally {
    await page.close()
  }
})
it('requires a grab and cancels constrained drags at each base with only one target pair', async function () {
  for (const base of [1, 2, 3]) {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      const name = ['', 'First base', 'Second base', 'Third base'][base]
      await click(page, name)
      await click(page, `Choose ${name} Player 6 #6`)
      await click(page, 'Apply Override')
      await click(page, 'Ball')
      await waitReady(page)
      const before = await page.$eval('[aria-label^="Undo "]', node =>
        node.getAttribute('aria-label')
      )
      const rect = await page.$eval('canvas', node => {
        const r = node.getBoundingClientRect()
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
      const project = (x: number, y: number, z: number): [number, number] => {
        const p = new Vector3(x, y, z).project(camera)
        return [
          rect.x + ((p.x + 1) * rect.width) / 2,
          rect.y + ((1 - p.y) * rect.height) / 2
        ]
      }
      await page.mouse.click(...project(-60, 0.7, -60))
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      await captureScene(page)
      const from = BASES[base]
      const to = BASES[(base + 1) % 4]
      await page.mouse.move(...project(from.x, 6, from.z))
      await page.mouse.down()
      // A still grab shows Safe and Out; a small move alone does not, so
      // no redraw drops the touch (3026a901c).
      await new Promise(resolve => setTimeout(resolve, 400))
      const locations: number[] = []
      for (const progress of [0.25, 0.75, 0.25, 0]) {
        await page.mouse.move(
          ...project(
            from.x + (to.x - from.x) * progress + (to.z - from.z) * 2,
            0.7,
            from.z + (to.z - from.z) * progress - (to.x - from.x) * 2
          )
        )
        await page.waitForSelector('[aria-label="Safe drag target"]')
        expect(await page.$$('[aria-label="Safe drag target"]')).has.length(1)
        const actual = await page.evaluate(() => {
          const guide = (
            window as unknown as SceneProbeWindow
          ).qaScene!.getObjectByName('move-preview')!
          const marker = guide.getObjectByName('destination-marker')!
          const line = guide.getObjectByName('runner-transition-line')!
          return {
            x: marker.position.x,
            z: marker.position.z,
            line: line.visible
          }
        })
        const expected = progress > 0.5 ? 1 : progress
        expect(actual.x).closeTo(from.x + (to.x - from.x) * expected, 0.1)
        expect(actual.z).closeTo(from.z + (to.z - from.z) * expected, 0.1)
        expect(actual.line).equals(progress > 0)
        const style = await page.$eval(
          '[aria-label="Safe drag target"]',
          n => ({
            height: n.getBoundingClientRect().height,
            size: getComputedStyle(n.firstElementChild!).fontSize,
            weight: getComputedStyle(n.firstElementChild!).fontWeight
          })
        )
        expect(style).deep.equals({ height: 66, size: '21px', weight: '700' })
        locations.push(
          await page.$eval(
            '[aria-label="Safe drag target"]',
            node => node.getBoundingClientRect().y
          )
        )
      }
      expect(locations[0]).equals(locations[2])
      expect(locations[0]).not.equals(locations[1])
      await page.keyboard.press('Escape')
      await page.mouse.up()
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      expect(
        await page.$eval('[aria-label^="Undo "]', node =>
          node.getAttribute('aria-label')
        )
      ).equals(before)
    } finally {
      await page.close()
    }
  }
})
it('holds and advances a runner by touch on a phone, resetting the correction window', async function () {
  this.timeout(90000)
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[aria-label="Time to edit play"]')!
            .getAttribute('aria-valuenow')
        ) <= 4,
      { timeout: 10000 }
    )
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
    const project = (base: number, y: number): [number, number] => {
      const point = new Vector3(BASES[base].x, y, BASES[base].z).project(camera)
      return [
        rect.x + ((point.x + 1) * rect.width) / 2,
        rect.y + ((1 - point.y) * rect.height) / 2
      ]
    }
    const from = project(1, 6)
    const to = project(2, 0)
    await page.touchscreen.touchStart(...from)
    await new Promise(resolve => setTimeout(resolve, 400))
    await page.touchscreen.touchMove(to[0], to[1])
    await page.waitForSelector('[aria-label="Safe drag target"]')
    const safe = await page.$eval('[aria-label="Safe drag target"]', node => {
      const r = node.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.touchscreen.touchMove(safe.x, safe.y)
    await page.touchscreen.touchEnd()
    expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
    await page.waitForSelector(
      '[aria-label="Time to edit play"][aria-valuenow="7"]',
      { timeout: 30000 }
    )
    expect(await page.$('[aria-label="Steal"]')).equals(null)
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Ball"]')!
          .getAttribute('aria-disabled') === 'true'
    )
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('keeps gray bottom controls inert throughout fielding and trajectory decisions', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Swing in Play')
    await click(page, 'Batter Out')
    await click(page, 'Ground Out')
    const reject = async (): Promise<void> => {
      const undo = await page.$eval('[aria-label^="Undo "]', n =>
        n.getAttribute('aria-label')
      )
      for (const label of [
        'Ball',
        'Called Strike',
        'Swing and Miss',
        'Foul Ball',
        'More',
        'Swing in Play',
        'Bunt in Play'
      ]) {
        const selector = `[aria-label="${label}"]`
        const point = await page.$eval(selector, n => {
          const r = n.getBoundingClientRect()
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            disabled:
              n.getAttribute('aria-disabled') === 'true' ||
              (n instanceof HTMLButtonElement && n.disabled)
          }
        })
        expect(point.disabled, label).equals(true)
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
        await page.mouse.move(point.x, point.y - 30)
        await page.mouse.up()
        await page.$eval(selector, n => {
          ;(n as HTMLElement).click()
        })
        await page.$eval(selector, n =>
          n.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
          )
        )
      }
      expect(await page.$('[role="menu"]')).equals(null)
      expect(
        await page.$eval('[aria-label^="Undo "]', n =>
          n.getAttribute('aria-label')
        )
      ).equals(undo)
    }
    await reject()
    await tapOffered(fieldOf(page))
    await reject()
    await setTrajectory(fieldOf(page))
    await reject()
    await page.waitForSelector(
      '[aria-label^="Tap or drag the next defender"]',
      { timeout: 20000 }
    )
    await reject()
    await page.locator('[aria-label^="Undo "]').click()
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/corrections-and-more',
  title: 'The correction window, the More halves and runner drafts',
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
  minutes: 38,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
