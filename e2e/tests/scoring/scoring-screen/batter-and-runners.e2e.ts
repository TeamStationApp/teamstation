import { join } from 'node:path'

import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { defineHarness } from '../../../core/spec'
import { placeOffered } from '../../../rigs/fieldPointer'
import {
  artifactDir,
  click,
  fieldOf,
  open,
  overrideBases,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * The batter dragged and placed, forced runs, dropped third strikes and real identities.
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

for (const bats of ['right', 'left'] as const)
  it(`drags a ${bats} batter across the plate before a pitch without switch help`, async function () {
    const { page } = await open('/games/g1/score', false, false, false, bats)
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      expect(await page.$('[aria-label="OK"]')).equals(null)
      const box = await page.$eval('canvas', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width: box.width,
        height: box.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const project = (x: number): [number, number] => {
        const p = new Vector3(x, 6, 0).project(camera)
        return [
          box.x + ((p.x + 1) * box.width) / 2,
          box.y + ((1 - p.y) * box.height) / 2
        ]
      }
      const start = project(bats === 'right' ? -4 : 4)
      const end = project(bats === 'right' ? 7 : -7)
      await page.mouse.move(...start)
      await page.mouse.down()
      await page.mouse.move(...end, { steps: 12 })
      await page.mouse.up()
      const side = bats === 'right' ? 'left' : 'right'
      await page.waitForSelector(
        `[aria-label*="Batter Jordan K ${side} handed"]`
      )
      await click(page, 'Ball')
      await waitReady(page)
      await page.mouse.move(...end)
      await page.mouse.down()
      await page.mouse.move(...start, { steps: 12 })
      await page.mouse.up()
      expect(
        await page.$(`[aria-label*="Batter Jordan K ${side} handed"]`)
      ).not.equals(null)
      await click(page, 'Undo Ball')
    } finally {
      await page.close()
    }
  })
for (const base of ['First', 'Second', 'Third'])
  it(`places batter directly on ${base} and hides placement while occupied`, async () => {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'More')
      expect(await page.$('[aria-label="Wild Pitch"]')).equals(null)
      expect(await page.$('[aria-label="Passed Ball"]')).equals(null)
      await click(page, 'Put Batter on Base')
      await click(page, base)
      expect(await page.$('[aria-label="Confirm Placements"]')).equals(null)
      expect(await page.$('[aria-label="Batter base"]')).equals(null)
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
      expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
      await click(page, 'More')
      expect(await page.$('[aria-label="Put Batter on Base"]')).equals(null)
      await click(page, 'Dismiss More')
      await click(page, 'Undo Put Batter on Base')
      await page.waitForSelector('[aria-label*="Batter Jordan K"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
for (const scenario of ['loaded-safe', 'loaded-out', 'empty-out'])
  // loaded-out is skipped until #333: Out can offer no fielder to place.
  it(`automatically resolves dropped third strike ${scenario}`, async () => {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      if (scenario.startsWith('loaded'))
        await overrideBases(page, [
          ['First base', 'Player 6'],
          ['Second base', 'Player 7'],
          ['Third base', 'Player 8']
        ])
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'Strikes 2')
      if (scenario.startsWith('loaded')) await click(page, 'Outs 2')
      await click(page, 'Apply Override')
      await click(page, 'More')
      await click(page, 'Dropped Third Strike')
      const decision = scenario.startsWith('loaded')
        ? 'Home plate decision for Player 8'
        : 'Runner decision for Jordan K.'
      await page.waitForSelector(`[aria-label="${decision}"]`, {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      expect(await page.$('[aria-label="Back"]')).equals(null)
      expect(await page.$$('[aria-label="Safe"]')).has.length(1)
      for (const label of ['Safe', 'Out']) {
        const copy = await page.$eval(`[aria-label="${label}"]`, button => ({
          text: button.textContent,
          subtitleSize: getComputedStyle(button.lastElementChild!).fontSize,
          align: getComputedStyle(button.lastElementChild!).textAlign
        }))
        expect(copy.text).equals(
          label + (scenario.startsWith('loaded') ? '' : 'At First')
        )
        // Automatic home-queue decisions deliberately have no subtitle;
        // a runner-action destination uses At First (RunnerControls).
        if (!scenario.startsWith('loaded')) {
          expect(copy.subtitleSize).equals('10.5px')
          expect(copy.align).equals('center')
        }
      }
      await page.screenshot({
        path: join(artifactDir(), `dropped-third-${scenario}.png`)
      })
      if (scenario.endsWith('safe')) {
        await click(page, 'Safe')
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
        expect(
          await page.$eval(
            '[aria-label="Bottom Finish at-bat"]',
            node => getComputedStyle(node.firstElementChild!).backgroundColor
          )
        ).equals('rgb(43, 66, 33)')
        await click(page, 'Bottom Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
      } else {
        await click(page, 'Out')
        await placeOffered(fieldOf(page))
        await click(page, 'Bottom Finish defensive play')
        await page.waitForSelector(
          scenario === 'loaded-out'
            ? '[aria-label*="Bottom 1st"]'
            : '[aria-label*="Batter Player 2"]',
          { timeout: 30000 }
        )
        await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
      }
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
for (const action of [
  'Hit by Pitch',
  'Intentional Walk',
  "Catcher's Interference",
  'Walk',
  'Balk'
])
  it(`automatically scores a forced run for ${action} with no correction prompt`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      if (action === 'Walk')
        for (let i = 0; i < 4; i++) {
          await click(page, 'Ball')
          await waitReady(page)
        }
      else {
        await click(page, 'More')
        await click(page, action)
        await waitReady(page)
      }
      await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]', {
        timeout: 30000
      })
      await page.waitForSelector(
        `[aria-label*="Batter ${action === 'Balk' ? 'Jordan K' : 'Player 2'}"]`
      )
      expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
      expect(await page.$('[aria-label="Safe at home"]')).equals(null)
      await click(page, `Undo ${action === 'Walk' ? 'Ball' : action}`)
      await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
    } finally {
      await page.close()
    }
  })
it('shows real identities, switches the hitter before a pitch, and repeatedly undoes pitches', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.evaluate(() => {
      localStorage.removeItem('teamstation:scoring:100:switch-hitter')
    })
    await page.reload()
    await page.waitForSelector('[aria-label*="Batter Jordan K right handed"]')
    await page.waitForSelector('[aria-label="OK"]')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    const box = await page.$eval('canvas', canvas => {
      const rect = canvas.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    const camera = new PerspectiveCamera(43, box.width / box.height, 0.1, 1000)
    applyFieldCamera(camera, {
      width: box.width,
      height: box.height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    camera.updateMatrixWorld()
    const project = (x: number, y: number, z: number): [number, number] => {
      const point = new Vector3(x, y, z).project(camera)
      return [
        box.x + ((point.x + 1) * box.width) / 2,
        box.y + ((1 - point.y) * box.height) / 2
      ]
    }
    const start = project(-4, 6, 0)
    const end = project(7, 6, 0)
    await page.mouse.move(...start)
    await page.mouse.down()
    await page.mouse.move(...end, { steps: 12 })
    await page.mouse.up()
    if (artifactDir() != null)
      await page.screenshot({
        path: `${artifactDir()}/field.png`
      })
    await page.waitForSelector('[aria-label*="Batter Jordan K left handed"]')
    expect(await page.$('[aria-label="OK"]')).equals(null)
    await click(page, 'Ball')
    await click(page, 'Called Strike')
    await click(page, 'Foul Ball')
    await page.waitForSelector(
      '[aria-label*="1 balls 2 strikes 0 outs · Pitches 3"]'
    )
    await page.mouse.move(...end)
    await page.mouse.down()
    await page.mouse.move(...start, { steps: 12 })
    await page.mouse.up()
    expect(
      await page.$('[aria-label*="Batter Jordan K left handed"]')
    ).not.equals(null)
    await click(page, 'Undo Foul Ball')
    await click(page, 'Undo Called Strike')
    await click(page, 'Undo Ball')
    await page.waitForSelector(
      '[aria-label*="0 balls 0 strikes 0 outs · Pitches 0"]'
    )
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/batter-and-runners',
  title:
    'The batter dragged and placed, forced runs, dropped third strikes and real identities',
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
