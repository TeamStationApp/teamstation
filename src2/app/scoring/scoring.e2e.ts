import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import {
  type Mesh,
  type MeshStandardMaterial,
  PerspectiveCamera,
  type Scene,
  Vector3
} from 'three'

import { asGameDetail } from '../../common/api'
import { applyFieldCamera } from '../field/cameraModel'
import { BASES } from '../field/fieldModel'
import { initialHitTarget } from '../field/trajectoryGuide'

const game = asGameDetail({
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  videos: []
})
interface ProbeFiber {
  memoizedProps?: {
    value?: { getState?: () => { scene?: Scene; camera?: PerspectiveCamera } }
  }
  child?: ProbeFiber
  sibling?: ProbeFiber
}
interface SceneProbeWindow {
  qaRoots: Array<{ current: ProbeFiber }>
  qaScene?: Scene
  qaCamera?: PerspectiveCamera
  __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
}
const base = process.env.GS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
let browser: Browser
async function open(
  path: string,
  scored: boolean | number = false,
  failed = false,
  failedRoster = false,
  bats: 'switch' | 'left' | 'right' = 'switch',
  probe = false,
  logos?: 'valid' | 'broken'
): Promise<{ page: Page; unexpected: string[] }> {
  const page = await browser.newPage()
  if (probe)
    await page.evaluateOnNewDocument(() => {
      const host = window as unknown as SceneProbeWindow
      host.qaRoots = []
      host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(): number {
          return 1
        },
        onCommitFiberRoot(_id: number, root: { current: ProbeFiber }): void {
          if (!host.qaRoots.includes(root)) host.qaRoots.push(root)
        },
        onCommitFiberUnmount(): void {}
      }
    })
  const unexpected: string[] = []
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  page.setDefaultTimeout(8000)
  await page.setViewport({ width: 1200, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/qa-logo-')) {
      const away = url.pathname.includes('away')
      request
        .respond({
          status: logos === 'broken' ? 404 : 200,
          contentType: 'image/svg+xml',
          body:
            logos === 'broken'
              ? 'Missing image'
              : `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${away ? '#294c78' : '#b74242'}"/><path d="M64 8L98 45H78V74H50V45H30Z" fill="white"/><text x="64" y="115" text-anchor="middle" font-size="36" fill="white">${away ? 'A' : 'H'}</text></svg>`
        })
        .catch(() => undefined)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    let body: unknown
    let status = 200
    if (request.method() !== 'GET')
      unexpected.push(`${request.method()} ${url.pathname}`)
    if (url.pathname === '/api/v1/auth/me')
      body = { id: 'scorer', displayName: 'Scorer', isAdmin: false }
    else if (url.pathname === '/api/v1/games/g1') {
      body =
        scored === false
          ? {
              ...game,
              awayLogoUrl: logos == null ? null : `${base}/qa-logo-away.svg`,
              homeLogoUrl: logos == null ? null : `${base}/qa-logo-home.svg`
            }
          : {
              ...game,
              awayScore: typeof scored === 'number' ? scored : 0,
              homeScore: 0
            }
      if (failed) {
        status = 404
        body = { error: 'Not found' }
      }
    } else if (url.pathname === '/api/v1/teams') body = []
    else if (url.pathname.endsWith('/roster')) {
      if (failedRoster) status = 503
      body = url.pathname.includes('/away/')
        ? [
            {
              userId: 'usr_jordan',
              shortName: 'Jordan K.',
              jersey: '00',
              positions: ['P'],
              isPlayer: true,
              role: 'member',
              bats,
              throws: 'right'
            }
          ]
        : []
    } else if (url.pathname.endsWith('/live-streams')) body = { streams: [] }
    else {
      unexpected.push(url.pathname)
      status = 500
      body = {}
    }
    request
      .respond({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body)
      })
      .catch(() => undefined)
  })
  await page.goto(`${base}${path}`)
  return { page, unexpected }
}
/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers. */
async function captureScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as SceneProbeWindow
    const scan = (fiber?: ProbeFiber): void => {
      if (fiber == null) return
      const value =
        fiber.memoizedProps == null ? undefined : fiber.memoizedProps.value

      const state =
        value == null || value.getState == null ? undefined : value.getState()
      if (state != null && state.scene != null) {
        host.qaScene = state.scene
        host.qaCamera = state.camera
      }
      scan(fiber.child)
      scan(fiber.sibling)
    }
    for (const root of host.qaRoots) scan(root.current)
  })
}
async function readGuide(
  page: Page
): Promise<{ bearing: number; x: number; z: number }> {
  await captureScene(page)
  return await page.evaluate(() => {
    const arc = (
      window as unknown as SceneProbeWindow
    ).qaScene!.getObjectByName('ball-arc')!
    const target = arc.getObjectByName('destination-marker')!.position
    return { bearing: Number(arc.userData.bearing), x: target.x, z: target.z }
  })
}
/* eslint-enable @typescript-eslint/prefer-optional-chain */
async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]`
  await page.waitForFunction(
    selector => {
      const node = document.querySelector(selector)
      return (
        node != null &&
        node.getAttribute('aria-disabled') !== 'true' &&
        !(node instanceof HTMLButtonElement && node.disabled)
      )
    },
    {},
    selector
  )
  await page.locator(selector).click()
}
async function chooseHit(page: Page, outcome: string): Promise<void> {
  await click(page, 'Swing in Play')
  if (outcome === 'Batter Interference') await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    outcome === 'Home Run'
      ? '[aria-label^="Drag where the ball was hit"]'
      : '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  await page.focus('[role="application"]')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.waitForSelector(
    '[aria-label^="Drag up and down for ball trajectory."]'
  )
  await page.keyboard.press('Enter')
}
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Ball"]')!
        .getAttribute('aria-disabled') !== 'true',
    { timeout: 30000 }
  )
}
async function dropRunnerWithKeyboard(
  page: Page,
  decision: 'Safe' | 'Out',
  advance = false
): Promise<void> {
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.focus('[role="application"]')
  await page.keyboard.press('Space')
  if (advance) for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
  await page.keyboard.press(decision === 'Safe' ? 's' : 'o')
  await page.keyboard.press('Enter')
}
async function placeDefenderWithKeyboard(
  page: Page,
  next = false
): Promise<void> {
  await page.focus('[role="application"]')
  if (next) {
    await page.keyboard.press(']')
    await page.keyboard.press(']')
  }
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
}
describe('scoring browser', function () {
  this.timeout(60000)
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.GS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })
  for (const loaded of [false, true])
    it(`advances and credits an Error with ${loaded ? 'loaded' : 'empty'} bases`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        if (loaded) {
          await click(page, 'Open scoring menu')
          await click(page, 'Overrides')
          for (const [base, name] of [
            ['First base', 'Player 6'],
            ['Second base', 'Player 7'],
            ['Third base', 'Player 8']
          ]) {
            await click(page, base)
            await click(page, `Choose ${base} ${name}`)
          }
          await click(page, 'Apply Override')
        }
        await chooseHit(page, 'Error')
        await page.waitForSelector(
          '[aria-label^="Tap or drag another defender"]',
          { timeout: 30000 }
        )
        expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
        if (loaded) {
          await placeDefenderWithKeyboard(page, true)
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
      await page.focus('[role="application"]')
      await page.keyboard.press('Space')
      for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      for (let i = 0; i < 100; i++) await page.keyboard.press('ArrowDown')
      await page.waitForSelector('[aria-label*="10° Line Drive"]')
      await page.keyboard.press('Enter')
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
          await click(page, 'Throw Out')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await placeDefenderWithKeyboard(page)
          await page.keyboard.press('Enter')
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
            .elementFromPoint(
              done.x + done.width / 2,
              done.y + done.height / 2
            )!
            .closest('[aria-label]')!
          return {
            bottom: done.bottom,
            footerTop: undo.top,
            hit: hit.getAttribute('aria-label')
          }
        }, label)
        expect(measured.bottom).lessThan(measured.footerTop)
        expect(measured.hit).equals(label)
        await click(page, label)
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
        await click(page, 'Throw Out')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await placeDefenderWithKeyboard(page)
        if (process.env.GS_SCORING_ARTIFACT_DIR != null && assisted)
          recorder = await page.record({
            path: `${process.env.GS_SCORING_ARTIFACT_DIR}/20260923-scoring-hit-throw.mp4`,
            audio: true
          })
        await page.keyboard.press('Enter')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        if (assisted) await placeDefenderWithKeyboard(page, true)
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
        const { page } = await open(
          '/games/g1/score',
          false,
          false,
          false,
          bats
        )
        try {
          await page.setViewport({ width, height: width === 390 ? 844 : 900 })
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await click(page, 'Foul Ball')
          if (process.env.GS_SCORING_ARTIFACT_DIR != null) {
            await new Promise(resolve => setTimeout(resolve, 900))
            for (let frame = 0; frame < 4; frame++) {
              await page.screenshot({
                path: `${process.env.GS_SCORING_ARTIFACT_DIR}/foul-${bats}-${width}-${frame}.png`
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
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
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
      for (const [x, z, name] of [
        [24, -23, 'Player 3'],
        [15, -41, 'Player 4']
      ] as const) {
        await page.mouse.click(...project(x, z))
        await page.waitForSelector(`[aria-label="Undo Throw to ${name}"]`)
        await page.waitForSelector(
          '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
        )
        expect(await page.$('[aria-label*="Batter Jordan K."]')).not.equals(
          null
        )
      }
      await page.mouse.move(...project(-15, -41))
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
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
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
      await dropRunnerWithKeyboard(page, 'Out', true)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      expect(await page.$('[aria-label^="Tap and Drag Thrower"]')).equals(null)
      for (let n = 0; n < 3; n++) {
        await placeDefenderWithKeyboard(page, n % 2 === 0)
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
  it('recovers a lost WebGL context during a pitch without replaying the scoring action', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await click(page, 'Ball')
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')!
        const gl = canvas.getContext('webgl2')!
        gl.getExtension('WEBGL_lose_context')!.loseContext()
      })
      await page.waitForSelector('canvas', { hidden: true })
      await page.locator('::-p-text(Try again)').click()
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 0 outs · Pitches 1"]'
      )
      await click(page, 'Ball')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="2 balls 0 strikes 0 outs · Pitches 2"]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('pauses a pitch while a menu or hidden document blocks the field', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await click(page, 'Ball')
      await click(page, 'Open scoring menu')
      await new Promise(resolve => setTimeout(resolve, 1400))
      await click(page, 'Resume Game')
      expect(
        await page.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await waitReady(page)
      await click(page, 'Foul Ball')
      const background = await browser.newPage()
      await background.bringToFront()
      await new Promise(resolve => setTimeout(resolve, 1700))
      expect(await page.evaluate(() => document.hidden)).equals(true)
      expect(
        await page.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await background.close()
      await page.bringToFront()
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Pitches 2"]')
    } finally {
      await page.close()
    }
  })
  it('animates each pitch with real audio sources, gates rapid taps, mutes and cancels on Undo', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await page.evaluate(() => {
        const target = window as unknown as {
          pitchCues: Array<{ time: number; peak: number }>
        }
        target.pitchCues = []
        // Keep the original receiver when wrapping the browser audio factory.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = AudioContext.prototype.createBufferSource
        AudioContext.prototype.createBufferSource = function () {
          const source = original.call(this)
          const start = source.start.bind(source)
          source.start = (...args) => {
            const data =
              source.buffer == null ? [] : source.buffer.getChannelData(0)
            target.pitchCues.push({
              time: performance.now(),
              peak: Math.max(...Array.from(data).map(Math.abs))
            })
            start(...args)
          }
          return source
        }
      })
      let pitch = 0
      for (const label of [
        'Ball',
        'Called Strike',
        'Swing and Miss',
        'Foul Ball'
      ]) {
        await click(page, label)
        await page.evaluate(label => {
          const button = document.querySelector<HTMLElement>(
            `[aria-label="${label}"]`
          )!
          button.click()
          button.click()
        }, label)
        expect(
          await page.$eval('[aria-label="Ball"]', node =>
            node.getAttribute('aria-disabled')
          )
        ).equals('true')
        await waitReady(page)
        pitch++
        await page.waitForSelector(`[aria-label*="Pitches ${pitch}"]`)
      }
      const cues = await page.evaluate(
        () =>
          (
            window as unknown as {
              pitchCues: Array<{ time: number; peak: number }>
            }
          ).pitchCues
      )
      expect(cues).has.length(9)
      expect(cues.every(cue => cue.peak > 0.1)).equals(true)
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      await click(page, 'Toggle scoring sound')
      await click(page, 'Cancel')
      await click(page, 'Ball')
      await waitReady(page)
      expect(
        await page.evaluate(
          () => (window as unknown as { pitchCues: unknown[] }).pitchCues.length
        )
      ).equals(9)
      await click(page, 'Foul Ball')
      await click(page, 'Undo Foul Ball')
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Pitches 5"]')
    } finally {
      await page.close()
    }
  })
  it('uses themed chrome and completes the toast with Done', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      expect(await page.$('[aria-label="Zoom in"]')).equals(null)
      await click(page, 'Open scoring menu')
      await click(page, 'Dismiss scoring menu')
      expect(await page.$('[aria-label="Settings"]')).equals(null)
      await click(page, 'Swing in Play')
      await click(page, 'Dismiss outcomes')
      expect(await page.$('[data-outcome]')).equals(null)
      const styles = await page.evaluate(() => {
        const play = document.querySelector('[aria-label="Swing in Play"]')!
        return {
          select: getComputedStyle(play.parentElement!).userSelect,
          chevrons: play.textContent!.includes('⌃')
        }
      })
      expect(styles).deep.equals({ select: 'none', chevrons: true })
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      expect(await page.evaluate(() => document.body.textContent)).includes(
        'Drag any other runners to advance them or have them called out'
      )
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await click(page, 'Undo 45° Fly Ball')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('opens an unscored game full screen and protects dirty browser Back', async function () {
    const { page, unexpected } = await open('/games/g1')
    try {
      await click(page, 'Score Game')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector('canvas')
      expect(await page.$('[aria-label="Schedule"]')).equals(null)
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label="Undo Ball"]')
      const length = await page.evaluate(() => history.length)
      await page.evaluate(() => {
        history.back()
      })
      await click(page, 'Cancel')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      expect(await page.evaluate(() => history.length)).equals(length)
      await page.evaluate(() => {
        history.back()
      })
      await click(page, 'Discard and Exit')
      await page.waitForSelector('[aria-label="Score Game"]')
      expect(new URL(page.url()).pathname).equals('/games/g1')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('excludes recorded zero scores and resolves direct scoring links', async function () {
    const scored = await open('/games/g1', true)
    try {
      await scored.page.waitForSelector('[aria-label="Box score"]')
      expect(await scored.page.$('[aria-label="Score Game"]')).equals(null)
      expect(scored.unexpected).deep.equals([])
    } finally {
      await scored.page.close()
    }
    const direct = await open('/games/g1/score')
    try {
      await click(direct.page, 'Open scoring menu')
      await click(direct.page, 'Exit Current Game')
      await direct.page.waitForSelector('[aria-label="Score Game"]')
      expect(new URL(direct.page.url()).pathname).equals('/games/g1')
      expect(direct.unexpected).deep.equals([])
    } finally {
      await direct.page.close()
    }
  })
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
          `[aria-label*="Batter Jordan K. ${side} handed"]`
        )
        await click(page, 'Ball')
        await waitReady(page)
        await page.mouse.move(...end)
        await page.mouse.down()
        await page.mouse.move(...start, { steps: 12 })
        await page.mouse.up()
        expect(
          await page.$(`[aria-label*="Batter Jordan K. ${side} handed"]`)
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
        await page.waitForSelector('[aria-label*="Batter Jordan K."]')
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
        await click(page, 'Open scoring menu')
        await click(page, 'Overrides')
        for (const [base, player] of [
          ['First base', 'Player 6'],
          ['Second base', 'Player 7'],
          ['Third base', 'Player 8']
        ]) {
          await click(page, base)
          await click(page, `Choose ${base} ${player}`)
        }
        await click(page, 'Apply Override')
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
          `[aria-label*="Batter ${action === 'Balk' ? 'Jordan K.' : 'Player 2'}"]`
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
        localStorage.removeItem('gamestation:scoring:scorer:switch-hitter')
      })
      await page.reload()
      await page.waitForSelector(
        '[aria-label*="Batter Jordan K. right handed"]'
      )
      await page.waitForSelector('[aria-label="OK"]')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const box = await page.$eval('canvas', canvas => {
        const rect = canvas.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      const camera = new PerspectiveCamera(
        43,
        box.width / box.height,
        0.1,
        1000
      )
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
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/field.png`
        })
      await page.waitForSelector('[aria-label*="Batter Jordan K. left handed"]')
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
        await page.$('[aria-label*="Batter Jordan K. left handed"]')
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
  it('edits rosters with a captured drag, validates overrides, and uses slide-up settings', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Remove Player 2')
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      const source = '[data-roster-target="roster"] [data-roster-player="2"]'
      const target = '[data-roster-target="lineup-0"]'
      await page.$eval(source, node => {
        node.scrollIntoView({ block: 'center' })
      })
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .textContent!.includes('Player 2')
      )
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await page.locator('[aria-label="balls"]').fill('4')
      expect(
        await page.$eval('[aria-label="Apply Override"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await page.locator('[aria-label="balls"]').fill('2')
      await click(page, 'Apply Override')
      await page.waitForSelector('[aria-label*="2 balls 0 strikes"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      await click(page, 'Toggle switch-hitter help')
      await click(page, 'Reset shown count')
      await click(page, 'Cancel')
      await click(page, 'Undo Override game state')
      await click(page, 'Undo Set team roster')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('creates detailed players in a full-screen roster and cancels only the active sheet', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Create Player')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') === 'First Name'
      )
      await page.locator('[aria-label="First Name"]').fill('Alex')
      await page.locator('[aria-label="Last Name"]').fill('Local')
      await page.locator('[aria-label="Jersey Number"]').fill('07')
      await click(page, 'Throws L')
      await click(page, 'Bats S')
      await click(page, 'Player position P')
      await click(page, 'Player position DH')
      await click(page, 'Save and Add Another Player')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') === 'First Name' &&
          (document.activeElement as HTMLInputElement).value === ''
      )
      expect(
        await page.$eval('[aria-label="Bats R"]', n =>
          n.getAttribute('aria-selected')
        )
      ).equals('true')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Create Player"]')
      expect(await page.$('[aria-label="First Name"]')).equals(null)
      expect(
        await page.$eval(
          '[aria-label="Add Alex Local to Lineup"]',
          n => n.textContent
        )
      ).includes('#07 Alex Local')
      await click(page, 'Home Team')
      expect(await page.$('[aria-label="Add Alex Local to Lineup"]')).equals(
        null
      )
      await click(page, 'Away Team')
      await click(page, 'Save Rosters')
      await click(page, 'Undo Set team roster')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(await page.$('[aria-label="Add Alex Local to Lineup"]')).equals(
        null
      )
      await click(page, 'Cancel')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('adds selected placeholder batches, cancels, isolates teams and supports Save/Undo', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Add Placeholder Players')
      await page.waitForSelector('[aria-label="Number of placeholder players"]')
      await new Promise(resolve => setTimeout(resolve, 400))
      const cancels = await page.$$('[aria-label="Cancel"]')
      const cancelBox = await cancels.at(-1)!.boundingBox()
      await page.mouse.click(
        cancelBox!.x + cancelBox!.width / 2,
        cancelBox!.y + cancelBox!.height / 2
      )
      await page.waitForSelector(
        '[aria-label="Number of placeholder players"]',
        { hidden: true }
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      const add = async (count: number): Promise<void> => {
        await click(page, 'Add Placeholder Players')
        // Let the slide-up Modal install its focus trap before keyboard input.
        await new Promise(resolve => setTimeout(resolve, 400))
        await page.focus('[aria-label="Number of placeholder players"]')
        await page.keyboard.press(count === 16 ? 'End' : 'Home')
        await page.waitForSelector(
          `[aria-label="Player count ${count}"][aria-selected="true"]`
        )
        await click(page, 'Add')
        await page.waitForSelector(
          '[aria-label="Number of placeholder players"]',
          { hidden: true }
        )
        await new Promise(resolve => setTimeout(resolve, 400))
      }
      await add(1)
      await add(16)
      expect(await page.$('[aria-label="Add Owls Q to Lineup"]')).not.equals(
        null
      )
      expect(
        await page.$$('[data-roster-target="roster"] [data-roster-player]')
      ).length(26)
      await click(page, 'Home Team')
      expect(await page.$('[aria-label="Add Owls A to Lineup"]')).equals(null)
      await add(1)
      expect(await page.$('[aria-label="Add Hawks A to Lineup"]')).not.equals(
        null
      )
      await click(page, 'Save Rosters')
      await click(page, 'Undo Set team roster')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(
        await page.$$('[data-roster-target="roster"] [data-roster-player]')
      ).length(9)
      await add(1)
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(await page.$('[aria-label="Add Owls A to Lineup"]')).equals(null)
      await click(page, 'Cancel')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('shows one lineup insertion line and numbered themed rows before dropping', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            animation =>
              animation.effect == null ||
              animation.effect.getComputedTiming().iterations === Infinity ||
              (!animation.pending && animation.playState !== 'running')
          )
      )
      await page.evaluate(() => {
        const trace: unknown[] = []
        ;(
          window as Window & { rosterAcceptanceTrace?: unknown[] }
        ).rosterAcceptanceTrace = trace
        for (const type of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
          'lostpointercapture'
        ])
          document.addEventListener(
            type,
            event => {
              const e = event as PointerEvent
              const row =
                e.target instanceof Element
                  ? e.target.closest('[data-roster-target]')
                  : null
              trace.push({
                type,
                at: performance.now(),
                x: e.clientX,
                y: e.clientY,
                buttons: e.buttons,
                row:
                  row == null ? null : row.getAttribute('data-roster-target'),
                bounds: Array.from(
                  document.querySelectorAll('[data-roster-target]')
                ).map(target => ({
                  target: target.getAttribute('data-roster-target'),
                  player: target.getAttribute('data-roster-player'),
                  bounds: target.getBoundingClientRect().toJSON()
                }))
              })
            },
            true
          )
      })
      const position = async (
        selector: string,
        bottom = false
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(
          selector,
          (n, bottom) => {
            const r = n.getBoundingClientRect()
            return { x: r.x + 20, y: bottom ? r.bottom - 8 : r.top + 8 }
          },
          bottom
        )
      // Wait for the slide-up sheet to settle before measuring drag coordinates.
      await page.locator('[aria-label="Reorder Jordan K."]').hover()
      const a = await position('[aria-label="Reorder Jordan K."]')
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 550))
      // Measure the destination after the grab; focus and layout can settle independently.
      const b = await position('[data-roster-target="lineup-2"]', true)
      await page.mouse.move(b.x, b.y, { steps: 10 })
      await page.waitForFunction(
        () => {
          const line = document.querySelector<HTMLElement>(
            '[aria-label="Lineup insertion point"]'
          )
          if (line == null) return false
          const parent = line.parentElement
          if (parent == null) return false
          return (
            parent.getAttribute('data-roster-target') === 'lineup-2' &&
            line.style.bottom === '-2px'
          )
        },
        { timeout: 20000 }
      )
      expect(await page.$$('[aria-label="Lineup insertion point"]')).length(1)
      expect(
        await page.$eval(
          '[data-roster-target="lineup-2"]',
          n => getComputedStyle(n).outlineStyle
        )
      ).equals('none')
      await page.mouse.up()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-2"]')!
            .getAttribute('data-roster-player') === '1',
        { timeout: 20000 }
      )
      expect(
        await page.$eval('[data-roster-target="lineup-2"]', n => n.textContent)
      ).includes('#00 Jordan K.')
      await click(page, 'Cancel')
      await click(page, 'More')
      await click(page, 'Put Batter on Base')
      const alignment = await page.evaluate(() => ({
        parent: document
          .querySelector('[aria-label="Put Batter on Base"]')!
          .getBoundingClientRect().top,
        child: document
          .querySelector('[aria-label="First"]')!
          .getBoundingClientRect().top
      }))
      expect(alignment.child).closeTo(alignment.parent, 1)
    } catch (error) {
      const directory =
        process.env.GS_SCORING_ARTIFACT_DIR ??
        join(homedir(), '.cursor', 'logs')
      await mkdir(directory, { recursive: true })
      const stem = join(directory, `roster-insertion-failure-${Date.now()}`)
      const detail = await page.evaluate(() => ({
        trace: (window as Window & { rosterAcceptanceTrace?: unknown[] })
          .rosterAcceptanceTrace,
        rows: Array.from(document.querySelectorAll('[data-roster-target]')).map(
          row => ({
            target: row.getAttribute('data-roster-target'),
            player: row.getAttribute('data-roster-player'),
            bounds: row.getBoundingClientRect().toJSON(),
            text: row.textContent
          })
        ),
        animations: document.getAnimations().map(animation => ({
          state: animation.playState,
          pending: animation.pending
        })),
        lines: Array.from(
          document.querySelectorAll('[aria-label="Lineup insertion point"]')
        ).map(line => line.getBoundingClientRect().toJSON())
      }))
      await writeFile(stem + '.json', JSON.stringify(detail, null, 2))
      await page.screenshot({ path: stem + '.png' })
      console.error('Insertion failure diagnostics:', stem)
      throw error
    } finally {
      await page.close()
    }
  })
  it('appends tapped names, reorders after a hold, drags both selectors, and auto-scrolls the lineup', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 740,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      const center = async (
        selector: string
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(selector, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      const swipe = async (from: string, to: string): Promise<void> => {
        const a = await center(from)
        const b = await center(to)
        await page.touchscreen.touchStart(a.x, a.y)
        await new Promise(resolve => setTimeout(resolve, 550))
        for (let i = 1; i <= 12; i++)
          await page.touchscreen.touchMove(
            a.x + ((b.x - a.x) * i) / 12,
            a.y + ((b.y - a.y) * i) / 12
          )
        await page.touchscreen.touchEnd()
      }
      await click(page, 'Remove Player 2')
      await click(page, 'Remove Player 3')
      await click(page, 'Add Player 3 to Lineup')
      await click(page, 'Add Player 2 to Lineup')
      expect(
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          nodes =>
            nodes.map(n => n.getAttribute('data-roster-player')).slice(-2)
        )
      ).deep.equals(['3', '2'])
      expect(await page.$$('[aria-label^="Move Player"]')).length(0)
      await swipe('[aria-label="Away Team"]', '[aria-label="Home Team"]')
      await page.waitForSelector(
        '[aria-label="Home Team"][aria-selected="true"]'
      )
      await swipe('[aria-label="Set Lineup"]', '[aria-label="Set Defense"]')
      await page.waitForSelector(
        '[aria-label="Set Defense"][aria-selected="true"]'
      )
      await click(page, 'Clear P')
      // A tap in defense never implies a slot; a direct drag replaces C.
      await click(page, 'Player 1')
      expect(
        await page.$eval('[data-roster-target="defense-P"]', n => n.textContent)
      ).includes('Unassigned')
      await swipe(
        '[data-roster-target="roster"] [data-roster-player="10"]',
        '[data-roster-target="defense-C"]'
      )
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="defense-C"]')!
          .textContent!.includes('Player 1')
      )
      expect(
        await page.$eval(
          '[data-roster-target="roster"] [data-roster-player="11"]',
          n => n.getAttribute('aria-disabled')
        )
      ).equals('false')
      await swipe('[aria-label="Home Team"]', '[aria-label="Away Team"]')
      await swipe('[aria-label="Set Defense"]', '[aria-label="Set Lineup"]')
      await page.waitForSelector(
        '[aria-label="Set Lineup"][aria-selected="true"]'
      )
      await page.$eval('[aria-label="Batting lineup"]', n => {
        n.scrollTop = 0
      })
      const from = await center('[aria-label="Drag Jordan K."]')
      const edge = await page.$eval('[aria-label="Batting lineup"]', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.bottom - 12 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.touchscreen.touchMove(edge.x, edge.y)
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Batting lineup"]')!.scrollTop >
          80
      )
      await page.touchscreen.touchEnd()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-0"]')!
            .getAttribute('data-roster-player') !== '1'
      )
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/roster-slider-drag.png`
        })
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(
        await page.$eval('[data-roster-target="lineup-0"]', n =>
          n.getAttribute('data-roster-player')
        )
      ).equals('1')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('cancels only the keyboard roster grab on Escape and retains prior draft edits', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Remove Player 2')
      await click(page, 'Remove Player 3')
      await click(page, 'Add Player 3 to Lineup')
      await click(page, 'Add Player 2 to Lineup')
      await page.focus('[aria-label="Reorder Jordan K."]')
      for (const key of ['Space', 'ArrowDown', 'ArrowDown', 'Enter'])
        await page.keyboard.press(key as 'Space' | 'ArrowDown' | 'Enter')
      const order = async (): Promise<Array<string | null>> =>
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          nodes => nodes.map(n => n.getAttribute('data-roster-player'))
        )
      const before = await order()
      expect(before.slice(0, 3)).deep.equals(['4', '5', '1'])
      expect(before.slice(-2)).deep.equals(['3', '2'])
      await page.keyboard.press('Space')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Save Rosters"]')
      expect(await order()).deep.equals(before)
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(await order()).deep.equals(before)
      await page.waitForSelector('[role="dialog"]')
      await page.focus('[aria-label="Reorder Jordan K."]')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Save Rosters"]', {
        hidden: true
      })
      expect(await page.$('[aria-label="Save Rosters"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('scrolls roster and lineup rows before the hold and adds only after a held drop', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 740,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Remove Player 2')
      await page.waitForSelector('[role="dialog"]')
      const order = async (): Promise<string[]> =>
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          rows => rows.map(n => n.getAttribute('data-roster-player')!)
        )
      const before = await order()
      for (const [list, selector] of [
        [
          'Roster players',
          '[data-roster-target="roster"] [data-roster-player="2"]'
        ],
        ['Batting lineup', '[data-roster-target="lineup-1"]']
      ]) {
        const from = await page.$eval(selector, n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + 20, y: r.y + r.height / 2 }
        })
        await page.touchscreen.touchStart(from.x, from.y)
        for (let step = 1; step <= 8; step++)
          await page.touchscreen.touchMove(from.x, from.y - step * 10)
        await page.touchscreen.touchEnd()
        await page.waitForFunction(
          label =>
            document.querySelector(`[aria-label="${label}"]`)!.scrollTop > 20,
          {},
          list
        )
        expect(await order()).deep.equals(before)
      }
      await page.$$eval(
        '[aria-label="Roster players"], [aria-label="Batting lineup"]',
        rows => {
          rows.forEach(n => {
            n.scrollTop = 0
          })
        }
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      const from = await page.$eval(
        '[data-roster-target="roster"] [data-roster-player="2"]',
        n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + 20, y: r.y + 20 }
        }
      )
      const to = await page.$eval('[data-roster-target="lineup-1"]', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + 20, y: r.y + 6 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.touchscreen.touchMove(to.x, to.y)
      await page.touchscreen.touchEnd()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-1"]')!
            .getAttribute('data-roster-player') === '2'
      )
      expect(await order()).length(before.length + 1)
    } finally {
      await page.close()
    }
  })
  it('assigns a defender with a touch drag on a phone-sized sheet', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Set Defense')
      await click(page, 'Clear P')
      const source = '[data-roster-target="roster"] [data-roster-player="1"]'
      const target = '[data-roster-target="defense-P"]'
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.touchscreen.touchMove(to.x, to.y)
      await page.touchscreen.touchEnd()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="defense-P"]')!
          .textContent!.includes('Jordan K.')
      )
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/rosters-phone.png`
        })
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  for (const out of ['Ball Caught', 'Throw Out'])
    it(`opens ${out} under one drag and returns to the right without a Back button`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        const center = async (
          label: string
        ): Promise<{ x: number; y: number }> =>
          await page.$eval(`[aria-label="${label}"]`, node => {
            const r = node.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          })
        await page.waitForSelector('[aria-label="Swing in Play"]')
        const button = await center('Swing in Play')
        await page.mouse.move(button.x, button.y)
        await page.mouse.down()
        await page.mouse.move(button.x, button.y - 20, { steps: 3 })
        await page.waitForSelector('[aria-label="Batter Out"]')
        const parent = await center('Batter Out')
        await page.mouse.move(parent.x, parent.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Throw Out"]')
        const right = await center('Single')
        await page.mouse.move(right.x, right.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Throw Out"]', { hidden: true })
        await page.mouse.move(parent.x, parent.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Ball Caught"]')
        const leaf = await center(out)
        await page.mouse.move(leaf.x, leaf.y, { steps: 8 })
        await page.mouse.up()
        await page.waitForSelector(
          '[aria-label^="Tap or drag a player to where the ball was fielded"]'
        )
        expect(await page.$('[aria-label="Back"]')).equals(null)
        await page.waitForSelector('canvas[data-field-ready="true"]')
        const field = '[role="application"]'
        await page.focus(field)
        await page.keyboard.press('Space')
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Enter')
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory."]'
        )
        for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown')
        const angle =
          out === 'Ball Caught' ? '10° Line Drive' : '5° Ground Ball'
        await page.waitForSelector(`[aria-label*="${angle}"]`)
        await page.keyboard.press('Enter')
        await page.waitForSelector(`[aria-label="Undo ${angle}"]`)
        await click(page, `Undo ${angle}`)
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory."]'
        )
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
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
      if (process.env.GS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.GS_SCORING_ARTIFACT_DIR}/fielder-trajectory.png`
        })
      await page.mouse.move(500, 500)
      await page.mouse.down()
      await page.mouse.move(500, 620, { steps: 12 })
      await page.$eval('[role="application"]', node =>
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
  it('runs a real ten-second correction window, pauses it for Settings and closes once', async function () {
    this.timeout(90000)
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      const seconds = await page.$eval(
        '[aria-label="Time to edit play"]',
        node => node.getAttribute('aria-valuenow')
      )
      expect(Number(seconds)).within(1, 10)
      await new Promise(resolve => setTimeout(resolve, 10500))
      expect(
        await page.$eval('[aria-label="Time to edit play"]', node =>
          node.getAttribute('aria-valuenow')
        )
      ).equals(seconds)
      await click(page, 'Cancel')
      const background = await browser.newPage()
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
      expect(Date.now() - resumed).greaterThan(
        (Number(seconds) - 1) * 1000 - 200
      )
      await click(page, 'Ball')
      await waitReady(page)
      await dropRunnerWithKeyboard(page, 'Safe')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 0 outs · Pitches 2"]'
      )
      await dropRunnerWithKeyboard(page, 'Safe', true)
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      for (const [base, player] of [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ]) {
        await click(page, base)
        await click(page, `Choose ${base} ${player}`)
      }
      await click(page, 'Apply Override')
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
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
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
      for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
      await click(page, 'Save Rosters')
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label^="Next batter is on base."]', {
        timeout: 30000
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Create Player')
      await page.locator('[aria-label="First Name"]').fill('Relief')
      await page.locator('[aria-label="Last Name"]').fill('Batter')
      await click(page, 'Add Player')
      await click(page, 'Add Relief Batter to Lineup')
      await click(page, 'Next batter Relief Batter')
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label*="Batter Relief Batter"]')
      await click(page, 'Undo Set team roster')
      await page.waitForSelector('[aria-label^="Next batter is on base."]')
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
        const headings = await page.$eval(
          '[aria-label="More scoring actions"]',
          panel =>
            Array.from(panel.querySelectorAll('div'))
              .filter(n =>
                ['Between pitches', "Didn't see it", 'This pitch'].includes(
                  // Browser closures cannot reference Sucrase's nullish helper.
                  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                  n.textContent == null ? '' : n.textContent
                )
              )
              .map(n => ({
                color: getComputedStyle(n).color,
                background: getComputedStyle(panel).backgroundColor,
                size: getComputedStyle(n).fontSize,
                weight: getComputedStyle(n).fontWeight
              }))
        )
        expect(headings).has.length(1)
        for (const heading of headings) {
          expect(heading.color).not.equals(heading.background)
          expect(heading.size).equals('14.4px')
          expect(heading.weight).equals('700')
        }

        expect(
          await page.$eval('[aria-label="Put Batter on Base"]', n => ({
            font: getComputedStyle(n).fontSize,
            weight: getComputedStyle(n).fontWeight
          }))
        ).deep.equals({ font: '16.8px', weight: '700' })
        await click(page, 'Put Batter on Base')
        expect(await bounds('More scoring actions')).deep.equals(parent)
        expect((await bounds('Batter base')).x).at.least(width / 2)
        await page.focus('[aria-label="First"]')
        expect(
          await page.$eval('[aria-label="First"]', node => ({
            bg: getComputedStyle(node).backgroundColor,
            text: getComputedStyle(node).color
          }))
        ).deep.equals({ bg: 'rgb(36, 113, 61)', text: 'rgb(255, 255, 255)' })
        const child = await bounds('Batter base')
        expect(child.bottom).at.most(width === 844 ? 390 : 844)
        if (process.env.GS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: join(
              process.env.GS_SCORING_ARTIFACT_DIR,
              `menus-more-${width}.png`
            )
          })
        await page.keyboard.press('Escape')
        expect(await page.$('[aria-label="More scoring actions"]')).equals(null)
        await click(page, 'Swing in Play')
        await click(page, 'Batter Out')
        expect(
          await page.$eval('[aria-label="Throw Out"]', n => ({
            font: getComputedStyle(n).fontSize,
            weight: getComputedStyle(n).fontWeight
          }))
        ).deep.equals({ font: '16.8px', weight: '700' })
        for (const label of [
          'Throw Out',
          'Ball Caught',
          'Batter Interference'
        ]) {
          const row = await bounds(label)
          expect(row.y).at.least(0)
          expect(row.bottom).at.most(width === 844 ? 390 : 844)
        }
        if (process.env.GS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: join(
              process.env.GS_SCORING_ARTIFACT_DIR,
              `menus-outcome-${width}.png`
            )
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
    'Put Batter on Base',
    'Place a Runner (Tiebreaker)',
    'Balk',
    'Batter Out — Other',
    'Strike Three, Not Caught'
  ])
    it(`More executes ${action} locally`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        if (['Balk', 'Wild Pitch', 'Passed Ball'].includes(action)) {
          await click(page, 'Open scoring menu')
          await click(page, 'Overrides')
          await click(page, 'First base')
          await click(page, 'Choose First base Player 6')
          await click(page, 'Apply Override')
        }
        if (action === 'Wild Pitch' || action === 'Passed Ball')
          await click(page, 'Ball')
        if (action === 'Strike Three, Not Caught') {
          await click(page, 'Called Strike')
          await click(page, 'Called Strike')
        }
        await click(page, 'More')
        await click(page, action)
        if (action === 'Put Batter on Base') {
          await click(page, 'Third')
        }
        if (action === 'Place a Runner (Tiebreaker)') {
          await click(page, 'Placed runner')
          await click(page, 'Choose Placed runner Player 6')
          await click(page, 'Destination base')
          await click(page, 'Choose Destination base Second')
          await click(page, 'Place Runner')
        }
        if (
          ['Wild Pitch', 'Passed Ball', 'Strike Three, Not Caught'].includes(
            action
          )
        ) {
          await page.focus('[role="application"]')
          await page.keyboard.press('Space')
          for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
          await page.keyboard.press('s')
          await page.keyboard.press('Enter')
        }
        if (action === 'Batter Out — Other') {
          await page.focus('[role="application"]')
          await page.keyboard.press('Space')
          await page.keyboard.press('ArrowUp')
          await page.keyboard.press('Enter')
          await click(page, 'Finish defensive play')
        }
        const windowExpected = ![
          'Place a Runner (Tiebreaker)',
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
            : action === 'Strike Three, Not Caught'
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
  it('anchors keyboard decisions to the base and supports Tab activation and Escape', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 6')
      await click(page, 'Apply Override')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      for (const width of [1200, 390]) {
        await page.setViewport({ width, height: 900 })
        await page.waitForFunction(
          width => {
            const canvas = document.querySelector('canvas')!
            return canvas.width >= width && canvas.width <= width * 1.5 + 1
          },
          {},
          width
        )
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
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
        const projected = new Vector3(BASES[2].x, 9, BASES[2].z).project(camera)
        const expectedX = Math.max(
          8,
          Math.min(rect.width - 176, ((projected.x + 1) * rect.width) / 2 - 84)
        )
        const expectedY = Math.max(
          8,
          Math.min(
            rect.height - 194,
            ((1 - projected.y) * rect.height) / 2 - 80
          )
        )
        await page.waitForFunction(
          (x, y) => {
            const node = document.querySelector(
              '[aria-label="Safe drag target"]'
            )
            if (node == null) return false
            const r = node.getBoundingClientRect()
            return Math.abs(r.x - x) < 2 && Math.abs(r.y - y) < 2
          },
          {},
          rect.x + expectedX,
          rect.y + expectedY
        )
        const target = await page.$eval(
          '[aria-label="Safe drag target"]',
          node => {
            const r = node.getBoundingClientRect()
            return {
              x: r.x,
              y: r.y,
              role: node.getAttribute('role'),
              tabIndex: (node as HTMLElement).tabIndex
            }
          }
        )
        expect(target.x).closeTo(rect.x + expectedX, 2)
        expect(target.y).closeTo(rect.y + expectedY, 2)
        expect(target.role).equals('button')
        expect(target.tabIndex).equals(0)
        let reached = false
        for (let i = 0; i < 16; i++) {
          await page.keyboard.press('Tab')
          reached = await page.evaluate(() => {
            const active = document.activeElement
            if (active == null) return false
            return active.getAttribute('aria-label') === 'Safe drag target'
          })
          if (reached) break
        }
        expect(reached).equals(true)
        await page.keyboard.press('Enter')
        await page.waitForSelector('[aria-label="Steal"]')
        await click(page, 'Cancel')
        expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        await page.keyboard.press('ArrowUp')
        await page.focus('[aria-label="Out drag target"]')
        await page.keyboard.press('Escape')
        expect(await page.$('[aria-label="Out drag target"]')).equals(null)
      }
    } finally {
      await page.close()
    }
  })
  it('cancels an entire runner draft by button, outside or Escape and commits one edit', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 6')
      await click(page, 'Apply Override')
      await click(page, 'Ball')
      await waitReady(page)
      const propose = async (): Promise<void> => {
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp')
        await page.keyboard.press('s')
        await page.keyboard.press('Enter')
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
        await click(page, `Choose ${name} Player 6`)
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
        const point = new Vector3(BASES[base].x, y, BASES[base].z).project(
          camera
        )
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
        '[aria-label="Time to edit play"][aria-valuenow="10"]',
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
      await click(page, 'Throw Out')
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
      await page.focus('[role="application"]')
      await page.keyboard.press('Space')
      await page.keyboard.press('Enter')
      await reject()
      await page.focus('[role="application"]')
      await page.keyboard.press('Enter')
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
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
        const target = await readGuide(page)
        const samplesPromise = page.evaluate(
          async () =>
            await new Promise<Array<{ z: number; gap: number; fz: number }>>(
              resolve => {
                const scene = (window as unknown as SceneProbeWindow).qaScene!
                const out: Array<{ z: number; gap: number; fz: number }> = []
                let seen = false
                const run = (): void => {
                  const ball = scene.getObjectByName('animated-baseball')
                  const fielder = scene.getObjectByName('player-defense-10')
                  if (ball != null && ball.visible && fielder != null) {
                    seen = true
                    out.push({
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
              }
            )
        )
        await page.keyboard.press('Enter')
        const samples = await samplesPromise
        const moving = samples
          .filter(p => p.z < -3 && p.z > target.z / 2)
          .at(-1)
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
          expect((landing[0].fz + 18.44) / (target.z + 18.44)).closeTo(
            0.8,
            0.08
          )
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
        await page.focus('[role="application"]')
        if (outside)
          for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
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
            process.env.GS_SCORING_ARTIFACT_DIR!,
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
        await page.focus('[role="application"]')
        const toward = bats === 'right' ? 'ArrowRight' : 'ArrowLeft'
        for (let i = 0; i < 9; i++) {
          await page.keyboard.press(toward)
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
        for (const key of [
          toward,
          bats === 'right' ? 'ArrowLeft' : 'ArrowRight'
        ] as const) {
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
          await page.keyboard.press(key)
          const values = await samples
          expect(
            values.some(
              value => Math.abs(value) > 0.05 && Math.abs(value) < 4.95
            )
          ).equals(true)
          expect(Math.abs(values.at(-1)!)).closeTo(5, 0.01)
        }
        const final = await readGuide(page)
        expect(final.x).closeTo(start.x, 0.01)
        expect(final.z).closeTo(start.z, 0.01)
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
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
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        await page.keyboard.press('Enter')
        await page.waitForSelector('[aria-label^="Ball trajectory:"]')
        const central = await readGuide(page)
        expect(central.x).equals(0)
        expect(Math.abs(central.bearing)).equals(5)
        await page.keyboard.press('Enter')
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
            await click(page, 'Open scoring menu')
            await click(page, 'Overrides')
            for (const [base, name] of [
              ['First base', 'Player 6'],
              ['Second base', 'Player 7'],
              ['Third base', 'Player 8']
            ]) {
              await click(page, base)
              await click(page, `Choose ${base} ${name}`)
            }
            await click(page, 'Apply Override')
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
          const project = (
            x: number,
            z: number,
            y: number
          ): [number, number] => {
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
          await page.focus('[role="application"]')
          await page.keyboard.press('Enter')
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      for (const [base, player] of [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ]) {
        await click(page, base)
        await click(page, `Choose ${base} ${player}`)
      }
      await click(page, 'Apply Override')
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
  it('backs up a legal home arrival and completes Fielder’s Choice explicitly', async function () {
    this.timeout(120000)
    const rollback = await open('/games/g1/score')
    try {
      await click(rollback.page, 'Open scoring menu')
      await click(rollback.page, 'Overrides')
      await click(rollback.page, 'Second base')
      await click(rollback.page, 'Choose Second base Player 7')
      await click(rollback.page, 'Third base')
      await click(rollback.page, 'Choose Third base Player 8')
      await click(rollback.page, 'Apply Override')
      await chooseHit(rollback.page, 'Single')
      await rollback.page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      await click(rollback.page, 'Back')
      await rollback.page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await rollback.page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
    } finally {
      await rollback.page.close()
    }
    for (const outcome of ["Fielder's Choice"]) {
      const { page } = await open('/games/g1/score')
      try {
        if (outcome !== 'Error') {
          await click(page, 'Open scoring menu')
          await click(page, 'Overrides')
          await click(page, 'First base')
          await click(page, 'Choose First base Player 6')
          await click(page, 'Apply Override')
        }
        await chooseHit(page, outcome)
        await page.waitForSelector('[aria-label^="Drag batter to a base"]')
        await dropRunnerWithKeyboard(page, 'Safe', true)
        if (outcome !== 'Error') {
          await page.waitForSelector('[aria-label^="Resolve Player 6"]')
          await dropRunnerWithKeyboard(page, 'Out')
          await placeDefenderWithKeyboard(page)
          await click(page, 'Finish defensive play')
        }
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 20000
        })
      } finally {
        await page.close()
      }
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
          await click(page, 'Open scoring menu')
          await click(page, 'Overrides')
          await click(page, 'First base')
          await click(page, 'Choose First base Player 6')
          await click(page, 'Apply Override')
          await click(page, 'Ball')
          await waitReady(page)
          await dropRunnerWithKeyboard(page, decision, advance)
          await click(page, reason)
          if (decision === 'Out') {
            await page.waitForSelector(
              '[aria-label^="Tap or drag a player to where the ball was fielded."]'
            )
            await placeDefenderWithKeyboard(page)
            await page.waitForSelector(
              '[aria-label^="Tap or drag the next defender"]'
            )
            await placeDefenderWithKeyboard(page, true)
            await click(page, 'Finish defensive play')
          }
          await waitReady(page)
          await page.waitForSelector(
            `[aria-label*="1 balls 0 strikes ${decision === 'Out' ? 1 : 0} outs · Pitches 1"]`
          )
          await page.waitForSelector('[aria-label*="Batter Jordan K."]')
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
        await dropRunnerWithKeyboard(page, 'Out')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await new Promise(resolve => setTimeout(resolve, 10500))
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        if (!sameDefender) await placeDefenderWithKeyboard(page, true)
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
                  (scene.getObjectByName('player-offense-1') == null
                    ? '10'
                    : '1')
              ),
              defense: color(
                'player-defense-' +
                  (scene.getObjectByName('player-defense-10') == null
                    ? '1'
                    : '10')
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
            path: join(
              process.env.GS_SCORING_ARTIFACT_DIR ?? '/tmp',
              `dugouts-${logos ?? 'absent'}-${half}.png`
            )
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await page.locator('[aria-label="outs"]').fill('2')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 6')
      await click(page, 'Apply Override')
      // A pitch locks the switch hitter, leaving the base runner selectable.
      await click(page, 'Ball')
      await waitReady(page)
      await dropRunnerWithKeyboard(page, 'Out')
      await click(page, 'Picked Off')
      await placeDefenderWithKeyboard(page)
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 2')
      await click(page, 'Apply Override')
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
      await click(page, 'First base')
      await click(page, 'Choose First base Empty')
      await click(page, 'Batter')
      await click(page, 'Choose Batter Player 2')
      await click(page, 'Apply Override')
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
    } finally {
      await page.close()
    }
  })
  it('hides scoring for nonzero scores and recovers failed roster reads', async function () {
    const scored = await open('/games/g1', 7)
    try {
      await scored.page.waitForSelector('[aria-label="Box score"]')
      expect(await scored.page.$('[aria-label="Score Game"]')).equals(null)
    } finally {
      await scored.page.close()
    }
    const { page } = await open('/games/g1/score', false, false, true)
    try {
      await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
      await page.waitForSelector('[aria-label*="Batter Player 1"]')
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
      await click(page, 'Remove Jordan K.')
      for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
      expect(
        await page.$eval('[aria-label="Save Rosters"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'Add Jordan K. to Lineup')
      await click(page, 'Set Defense')
      await click(page, 'Clear P')
      expect(
        await page.$eval('[aria-label="Save Rosters"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 6')
      await click(page, 'Second base')
      await click(page, 'Choose Second base Player 6')
      expect(
        await page.$eval('[aria-label="Apply Override"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'Second base')
      await click(page, 'Choose Second base Empty')
      await click(page, 'First base')
      await click(page, 'Choose First base Jordan K.')
      expect(
        await page.$eval('[aria-label="Apply Override"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'First base')
      await click(page, 'Choose First base Empty')
      await click(page, 'Apply Override')
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
      await placeDefenderWithKeyboard(page)
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
      await page.waitForSelector('[aria-label*="50° Pop Fly"]')
      await page.keyboard.press('Enter')
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
        String(document.body.textContent).includes('Game not found.')
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'First base')
      await click(page, 'Choose First base Player 6')
      await click(page, 'Apply Override')
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
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await page.locator('[aria-label="outs"]').fill('2')
      for (const [base, player] of [
        ['Third base', 'Player 8'],
        ['Second base', 'Player 7']
      ]) {
        await click(page, base)
        await click(page, `Choose ${base} ${player}`)
      }
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
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
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
        expect(bunt.bottom - swing.y).closeTo(112, 0.1)
        expect(bunt.y - swing.bottom).closeTo(8, 0.1)
        for (const c of actual.controls) {
          expect(c.h, c.label).closeTo(52, 0.1)
          expect(c.bg).equals(actual.controls[0].bg)
          expect(c.shadow).not.equals('none')
          expect(c.images).equals(0)
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
        ).deep.equals({ font: '16.8px', weight: '700' })
        await page.screenshot({
          path: join(
            process.env.GS_SCORING_ARTIFACT_DIR!,
            `paired-controls-${width}.png`
          )
        })
      } finally {
        await page.close()
      }
    })
  for (const outcome of ['Single', 'Throw Out'])
    it(`completes a bunt ${outcome} with distinct menus and Undo`, async () => {
      const { page } = await open('/games/g1/score')
      try {
        await click(page, 'Bunt in Play')
        expect(await page.$('[aria-label="Home Run"]')).equals(null)
        expect(await page.$('[aria-label="Swing in Play outcomes"]')).equals(
          null
        )
        expect(await page.$('[aria-label="Fielder\'s Choice"]')).equals(null)
        if (outcome === 'Throw Out') await click(page, 'Batter Out')
        await click(page, outcome)
        await page.waitForSelector(`[aria-label="Undo Bunt: ${outcome}"]`)
        await page.focus('[role="application"]')
        await page.keyboard.press('Space')
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('Enter')
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory"]'
        )
        await page.keyboard.press('Enter')
        if (outcome === 'Throw Out') {
          await page.waitForSelector(
            '[aria-label^="Tap or drag the next defender"]'
          )
          await placeDefenderWithKeyboard(page, true)
          await click(page, 'Finish defensive play')
        } else await click(page, 'Finish at-bat')
        await waitReady(page)
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
        await page.locator('[aria-label^="Undo "]').click()
        await page.screenshot({
          path: join(
            process.env.GS_SCORING_ARTIFACT_DIR!,
            `bunt-${outcome}.png`
          )
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
          await page.focus('[role="application"]')
          await page.keyboard.press('Space')
          await page.keyboard.press('ArrowUp')
          await page.keyboard.press('Enter')
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
              const player = scene.getObjectByName('player-offense-1')
              const rig =
                player == null
                  ? undefined
                  : player.getObjectByName('athlete-rig')
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
          await page.keyboard.press('Enter')
          if (bunt) {
            await page.waitForFunction(
              () => {
                const scene = (window as unknown as SceneProbeWindow).qaScene!
                const player = scene.getObjectByName('player-offense-1')
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
              path: join(
                process.env.GS_SCORING_ARTIFACT_DIR ?? '/tmp',
                `bunt-contact-${bats}.png`
              )
            })
          }
          const { samples, completed } = await sampling
          expect(completed, 'rendered batting motion must finish').equals(true)
          expect(samples.length, 'observe actual rendered motion').greaterThan(
            0
          )
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
})
