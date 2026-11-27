import { expect } from 'chai'
import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../../../src/app/field/cameraModel'
import { createPlayers } from '../../../../src/app/field/fieldModel'
import { defineHarness } from '../../../core/spec'
import type { Page } from '../../../core/web'
import {
  aimLanding,
  dropOfferedRunner,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  artifactDir,
  chooseHit,
  click,
  fieldOf,
  open,
  overrideBases,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * Plays on the field: undo history, errors, hits, throws, fouls, interference and recipients.
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

it('opens full-width undo history above its button and preserves a short undo', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 402, height: 874 })
    for (const pitch of [
      'Ball',
      'Called Strike',
      'Foul Ball',
      'Foul Ball',
      'Foul Ball',
      'Foul Ball'
    ]) {
      await click(page, pitch)
      await waitReady(page)
    }
    const undo = await page.$('[aria-label^="Undo "]')
    expect(undo).not.equals(null)
    const before = await undo!.evaluate(node => node.getAttribute('aria-label'))
    await undo!.hover()
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 1100))
    await page.mouse.up()
    await page.waitForSelector('[data-testid="scoring-tag-history"]')
    await page.waitForFunction(() => {
      const panel = document
        .querySelector('[data-testid="scoring-tag-history"]')!
        .getBoundingClientRect()
      const button = document
        .querySelector('[aria-label^="Undo "]')!
        .getBoundingClientRect()
      return panel.bottom <= button.top - 3
    })
    const panel = await page.$eval(
      '[data-testid="scoring-tag-history"]',
      node => node.getBoundingClientRect().toJSON()
    )
    expect(panel.left).closeTo(12, 1)
    expect(panel.right).closeTo(390, 1)
    expect(await page.$$('[data-testid^="tag-history-"]')).length(6)
    await page.waitForSelector(
      '[aria-label*="1 balls 2 strikes 0 outs · Pitches 6"]'
    )
    // Click the visible backdrop margin, outside the full-width rows.
    await page.mouse.click(6, 100)
    await page.waitForSelector('[data-testid="scoring-tag-history"]', {
      hidden: true
    })
    expect(
      await undo!.evaluate(node => node.getAttribute('aria-label'))
    ).equals(before)
    await click(page, before!)
    await page.waitForSelector(
      '[aria-label*="1 balls 2 strikes 0 outs · Pitches 5"]'
    )
    await waitReady(page)
    expect(
      await page.$eval('[aria-label^="Undo "]', node =>
        node.getAttribute('aria-label')
      )
    ).equals(before)
    // One short press removes one pitch, even when the previous label repeats.
    await undo!.hover()
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 1100))
    await page.mouse.up()
    await page.waitForSelector('[data-testid="scoring-tag-history"]')
    // The history opens without taking back another pitch.
    await page.waitForSelector(
      '[aria-label*="1 balls 2 strikes 0 outs · Pitches 5"]'
    )
    await page.setViewport({ width: 844, height: 390 })
    await page.waitForSelector('[data-testid="scoring-tag-history"]', {
      hidden: true
    })
    // A larger heading shrinks the scroll viewport after content measurement.
    await page.addStyleTag({
      content:
        '[data-testid="scoring-tag-history"]>div:first-child{font-size:40px!important}'
    })
    const holdUndo = async (): Promise<void> => {
      await undo!.hover()
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 1100))
      await page.mouse.up()
      await page.waitForSelector('[data-testid="scoring-tag-history"]')
    }
    const newestIsVisible = async (): Promise<void> => {
      await page.waitForFunction(() => {
        const scroll = document.querySelector(
          '[data-testid="scoring-history-older-scroll"]'
        )!
        const rows = document.querySelectorAll('[data-testid^="tag-history-"]')
        const newest = rows[rows.length - 1].getBoundingClientRect()
        const visible = scroll.getBoundingClientRect()
        return (
          newest.top >= visible.top &&
          newest.bottom <= visible.bottom + 1 &&
          Math.abs(
            scroll.scrollTop + scroll.clientHeight - scroll.scrollHeight
          ) < 1
        )
      })
    }
    // Scoring fills the screen on web, including the browser's unsafe strips.
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { left: 44, right: 44, top: 30, bottom: 21 }
    })
    await holdUndo()
    await newestIsVisible()
    const safePanel = await page.$eval(
      '[data-testid="scoring-tag-history"]',
      node => node.getBoundingClientRect().toJSON()
    )
    expect(safePanel.left).closeTo(44, 1)
    expect(safePanel.right).closeTo(800, 1)
    expect(safePanel.top).at.least(29)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { left: 0, right: 0, top: 0, bottom: 0 }
    })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="scoring-tag-history"]', {
      hidden: true
    })
    // Some modal hosts start at an offset while retaining the window width.
    await page.addStyleTag({
      content:
        '[role="dialog"]{left:62px!important;width:844px!important;right:auto!important}'
    })
    await holdUndo()
    await page.waitForFunction(() => {
      const panel = document
        .querySelector('[data-testid="scoring-tag-history"]')!
        .getBoundingClientRect()
      return panel.left >= 12 && panel.right <= innerWidth - 12
    })
    await newestIsVisible()
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
for (const loaded of [false, true])
  it(`advances and credits an Error with ${loaded ? 'loaded' : 'empty'} bases`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      if (loaded) {
        await overrideBases(page, [
          ['First base', 'Player 6'],
          ['Second base', 'Player 7'],
          ['Third base', 'Player 8']
        ])
      }
      await chooseHit(page, 'Error')
      await page.waitForSelector(
        '[aria-label^="Tap or drag another defender"]',
        { timeout: 30000 }
      )
      expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
      if (loaded) {
        await placeOffered(fieldOf(page), 1)
        await page.waitForSelector(
          '[aria-label^="Tap or drag another defender"]',
          { timeout: 10000 }
        )
      }
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label^="Error by "]')
      const credits = await page.$$eval('[aria-label^="Error by "]', nodes =>
        nodes.map(n => n.getAttribute('aria-label')!)
      )
      expect(credits).has.length(loaded ? 2 : 1)
      await click(page, 'Cancel')
      await click(page, 'Finish defensive play')
      await click(page, credits.at(-1)!)
      if (loaded) {
        await page.waitForSelector(
          '[aria-label="Home plate decision for Player 8"]'
        )
        await click(page, 'Safe')
      }
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
      await page.waitForSelector(
        `[aria-label*="Owls ${loaded ? 1 : 0} · Hawks 0"]`
      )
    } finally {
      await page.close()
    }
  })
it('hides empty-base fielder choice and clamps a stands home-run arc to Line Drive', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Swing in Play')
    expect(await page.$('[aria-label="Fielder\'s Choice"]')).equals(null)
    await click(page, 'Home Run')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    // Deep into the stands, then dragged as low as it goes: a ball over
    // the fence is a line drive at the least.
    const field = fieldOf(page)
    await aimLanding(field, 0.5, 0.08)
    await setTrajectory(field, -45)
    await page.waitForSelector('[aria-label*="10° Line Drive"]')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    await chooseHit(page, 'Single')
    await click(page, 'Finish at-bat')
    await click(page, 'Swing in Play')
    await page.waitForSelector('[aria-label="Fielder\'s Choice"]')
  } finally {
    await page.close()
  }
})
for (const defensive of [false, true])
  it(`keeps ${defensive ? 'defensive' : 'correction'} toast Done above controls in short landscape`, async function () {
    const { page } = await open('/games/g1/score')
    try {
      if (defensive) {
        await click(page, 'Swing in Play')
        await click(page, 'Batter Out')
        await click(page, 'Ground Out')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await placeOffered(fieldOf(page))
        await setTrajectory(fieldOf(page))
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
      } else {
        await chooseHit(page, 'Single')
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
      }
      await page.setViewport({ width: 874, height: 292 })
      const label = defensive ? 'Finish defensive play' : 'Finish at-bat'
      await page.waitForFunction(
        label => {
          const done = document.querySelector(`[aria-label="${label}"]`)
          const row = done == null ? null : done.parentElement
          const toast = row == null ? null : row.parentElement
          return toast != null && toast.getBoundingClientRect().width > 400
        },
        {},
        label
      )
      const measured = await page.evaluate(label => {
        const done = document
          .querySelector(`[aria-label="${label}"]`)!
          .getBoundingClientRect()
        const undo = document
          .querySelector('[aria-label^="Undo "]')!
          .getBoundingClientRect()
        const hit = document
          .elementFromPoint(done.x + done.width / 2, done.y + done.height / 2)!
          .closest('[aria-label]')!
        return {
          bottom: done.bottom,
          footerTop: undo.top,
          hit: hit.getAttribute('aria-label')
        }
      }, label)
      expect(measured.bottom).lessThan(measured.footerTop)
      expect(measured.hit).equals(label)
      // The lower pill lays itself out over Undo a frame or more after the
      // resize: on a droplet, which draws slowly, it can be read mid-move.
      await page
        .waitForFunction(
          label => {
            const pill = document.querySelector(
              `[aria-label="Bottom ${label}"]`
            )
            const undo = document.querySelector('[aria-label^="Undo "]')
            if (pill == null || undo == null) return false
            const a = pill.getBoundingClientRect()
            const b = undo.getBoundingClientRect()
            return (
              Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) < 0.1 &&
              Math.abs(a.bottom - b.top) < 0.1
            )
          },
          { timeout: 15000 },
          label
        )
        .catch(() => undefined)
      const lower = await page.$eval(`[aria-label="Bottom ${label}"]`, n => {
        const r = n.getBoundingClientRect()
        const undo = document
          .querySelector('[aria-label^="Undo "]')!
          .getBoundingClientRect()
        return {
          bottom: r.bottom,
          top: undo.top,
          center: r.x + r.width / 2,
          undoCenter: undo.x + undo.width / 2
        }
      })
      expect(lower.bottom).closeTo(lower.top, 0.1)
      expect(lower.center).closeTo(lower.undoCenter, 0.1)
      await click(page, `Bottom ${label}`)
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector(`[aria-label*="${defensive ? 1 : 0} outs"]`)
    } finally {
      await page.close()
    }
  })
it('finishes coordinated hit flight before exposing correction or home decisions', async function () {
  for (const outcome of ['Single', 'Double', 'Triple', 'Home Run']) {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await chooseHit(page, outcome)
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      if (outcome !== 'Home Run') {
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await click(page, 'Finish at-bat')
      }
      await waitReady(page)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  }
})
for (const assisted of [false, true])
  it(`completes a batter throw out with ${assisted ? 'a secondary throw' : 'an unassisted touch'} before retirement`, async function () {
    const { page, unexpected } = await open('/games/g1/score')
    let recorder: Awaited<ReturnType<Page['record']>> | undefined
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      await click(page, 'Ground Out')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await placeOffered(fieldOf(page))
      if (artifactDir() != null && assisted)
        recorder = await page.record({
          path: `${artifactDir()}/20260923-scoring-hit-throw.mp4`,
          audio: true
        })
      await setTrajectory(fieldOf(page))
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      if (assisted) await placeOffered(fieldOf(page), 1)
      await click(page, 'Finish defensive play')
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="1 outs"]')
      expect(unexpected).deep.equals([])
    } finally {
      await recorder?.stop()
      await page.close()
    }
  })
for (const bats of ['right', 'left'] as const)
  for (const width of [390, 1200])
    it(`presents a camera-facing ${bats} foul at width ${width} and rewinds it`, async function () {
      const { page } = await open('/games/g1/score', false, false, false, bats)
      try {
        await page.setViewport({ width, height: width === 390 ? 844 : 900 })
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await click(page, 'Foul Ball')
        if (artifactDir() != null) {
          await new Promise(resolve => setTimeout(resolve, 900))
          for (let frame = 0; frame < 4; frame++) {
            await page.screenshot({
              path: `${artifactDir()}/foul-${bats}-${width}-${frame}.png`
            })
            await new Promise(resolve => setTimeout(resolve, 70))
          }
        }
        await waitReady(page)
        await page.waitForSelector('[aria-label*="0 balls 1 strikes 0 outs"]')
        await page.locator('[aria-label^="Undo "]').click()
        await page.waitForSelector('[aria-label*="0 balls 0 strikes 0 outs"]')
      } finally {
        await page.close()
      }
    })
it('routes batter interference through two taps and a dragged recipient before one out', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await chooseHit(page, 'Batter Interference')
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
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
    const project = (x: number, z: number): [number, number] => {
      const p = new Vector3(x, 6, z).project(camera)
      return [
        rect.x + ((p.x + 1) * rect.width) / 2,
        rect.y + ((1 - p.y) * rect.height) / 2
      ]
    }
    const spot = (id: string): { x: number; z: number } => {
      const player = createPlayers().find(item => item.id === id)
      if (player == null) throw new Error(id)
      return player.position
    }
    for (const [id, name] of [
      ['1B', 'Player 3'],
      ['2B', 'Player 4']
    ] as const) {
      const { x, z } = spot(id)
      await page.mouse.click(...project(x, z))
      await page.waitForSelector(`[aria-label="Undo Throw to ${name}"]`)
      await page.waitForSelector(
        '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
      )
      expect(await page.$('[aria-label*="Batter Jordan K"]')).not.equals(null)
    }
    const shortstop = spot('SS')
    await page.mouse.move(...project(shortstop.x, shortstop.z))
    await page.mouse.down()
    await page.mouse.move(...project(-10, -35), { steps: 10 })
    await page.mouse.up()
    await page.waitForSelector('[aria-label="Undo Throw to Player 5"]')
    await page.waitForSelector(
      '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
    )
    await click(page, 'Finish defensive play')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
    await page.waitForSelector('[aria-label*="1 outs"]')
    await page.locator('[aria-label^="Undo "]').click()
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
    expect(await page.$('[aria-label*="Batter Player 2"]')).equals(null)
  } finally {
    await page.close()
  }
})
it('chains three recipients with no intermediate out and finishes from the toast', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await chooseHit(page, 'Single')
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
    await dropOfferedRunner(fieldOf(page), 'Out', true)
    await page.waitForSelector('[aria-label^="Tap or drag the next defender"]')
    expect(await page.$('[aria-label^="Tap and Drag Thrower"]')).equals(null)
    for (let n = 0; n < 3; n++) {
      await placeOffered(fieldOf(page), n % 2 === 0 ? 1 : 0)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]',
        { timeout: 30000 }
      )
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
    }
    await click(page, 'Finish defensive play')
    await page.waitForSelector('[aria-label*="1 outs"]', { timeout: 30000 })
    expect(await page.$('[aria-label="Done"]')).equals(null)
  } finally {
    await page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/field-plays',
  title:
    'Plays on the field: undo history, errors, hits, throws, fouls, interference and recipients',
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
