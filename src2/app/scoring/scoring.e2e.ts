import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { PerspectiveCamera, Vector3 } from 'three'

import { asGameDetail } from '../../common/api'
import { applyFieldCamera } from '../field/cameraModel'
import { BASES } from '../field/fieldModel'

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
const base = process.env.GS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
let browser: Browser
async function open(
  path: string,
  scored: boolean | number = false,
  failed = false,
  failedRoster = false
): Promise<{ page: Page; unexpected: string[] }> {
  const page = await browser.newPage()
  const unexpected: string[] = []
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  page.setDefaultTimeout(8000)
  await page.setViewport({ width: 1200, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
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
          ? game
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
              bats: 'switch',
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
  await click(page, 'Ball in Play')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector('[aria-label^="Drag fielder to location"]')
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
          '[aria-label^="Tap and drag another defender"]',
          { timeout: 30000 }
        )
        expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
        if (loaded) {
          await placeDefenderWithKeyboard(page, true)
          await page.waitForSelector(
            '[aria-label^="Tap and drag another defender"]',
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
      await click(page, 'Ball in Play')
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
      await click(page, 'Ball in Play')
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
          await click(page, 'Ball in Play')
          await click(page, 'Batter Out')
          await click(page, 'Throw Out')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await placeDefenderWithKeyboard(page)
          await page.keyboard.press('Enter')
          await page.waitForSelector(
            '[aria-label^="Tap and drag the next defender"]'
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
        await click(page, 'Ball in Play')
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
          '[aria-label^="Tap and drag the next defender"]'
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
  it('chains three recipients with no intermediate out and finishes from the toast', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await dropRunnerWithKeyboard(page, 'Out', true)
      await page.waitForSelector(
        '[aria-label^="Tap and drag the next defender"]'
      )
      expect(await page.$('[aria-label^="Tap and Drag Thrower"]')).equals(null)
      for (let n = 0; n < 3; n++) {
        await placeDefenderWithKeyboard(page, n % 2 === 0)
        await page.waitForSelector(
          '[aria-label^="Tap and drag the next defender"]',
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
      await click(page, 'Ball in Play')
      await click(page, 'Dismiss outcomes')
      expect(await page.$('[data-outcome]')).equals(null)
      const styles = await page.evaluate(() => {
        const play = document.querySelector('[aria-label="Ball in Play"]')!
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
  it('appends tapped names, reorders immediately, drags both selectors, and auto-scrolls the lineup', async function () {
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
      await page.focus('[aria-label="Reorder Jordan K."]')
      await page.keyboard.press('Escape')
      expect(await page.$('[aria-label="Save Rosters"]')).equals(null)
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
        await page.waitForSelector('[aria-label="Ball in Play"]')
        const button = await center('Ball in Play')
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
        await page.waitForSelector('[aria-label^="Drag fielder to location"]')
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
      await click(page, 'Ball in Play')
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
        '[aria-label^="Tap and drag the next defender"]'
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
      await click(page, 'Add Player')
      await page.locator('[aria-label="New player name"]').fill('Relief Batter')
      await click(page, 'Create Player')
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
  for (const width of [320, 390, 874]) {
    it(`keeps More halves fixed and extends the field at ${width}px`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        await page.setViewport({ width, height: width === 874 ? 402 : 844 })
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
        await page.keyboard.press('Escape')
        expect(await page.$('[aria-label="More scoring actions"]')).equals(null)
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
      await page.waitForSelector('[aria-label="Finish at-bat"]', {
        timeout: 30000
      })
      await click(page, 'Finish at-bat')
      await page.mouse.move(trigger.x, trigger.y)
      await page.mouse.down()
      await page.mouse.move(trigger.x, trigger.y - 20)
      await page.mouse.move(500, trigger.y - 100)
      await page.mouse.up()
      expect(await page.$('[aria-label="Hit by Pitch"]')).not.equals(null)
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
    'Wild Pitch',
    'Passed Ball',
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
          await click(page, 'Confirm Placements')
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
          66,
          Math.min(rect.height - 56, ((1 - projected.y) * rect.height) / 2 - 58)
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
      const { page } = await open('/games/g1/score')
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
        const from = BASES[base]
        const to = BASES[(base + 1) % 4]
        await page.mouse.move(...project(from.x, 6, from.z))
        await page.mouse.down()
        const locations: number[] = []
        for (const progress of [0.49, 0.51, 0.49]) {
          await page.mouse.move(
            ...project(
              from.x + (to.x - from.x) * progress + (to.z - from.z) * 2,
              0.7,
              from.z + (to.z - from.z) * progress - (to.x - from.x) * 2
            )
          )
          await page.waitForSelector('[aria-label="Safe drag target"]')
          expect(await page.$$('[aria-label="Safe drag target"]')).has.length(1)
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
          await click(page, 'Ball in Play')
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
          await page.mouse.move(...project(0, -18.44, 6))
          await page.mouse.down()
          await page.mouse.move(...project(0, -100, 0.7), { steps: 10 })
          await page.waitForFunction(() =>
            String(document.body.textContent).includes('In-the-park Home Run')
          )
          if (outside) {
            await page.mouse.move(...project(0, -129, 7), { steps: 10 })
            await page.waitForFunction(() =>
              String(document.body.textContent).includes(
                'fielded ball. Home Run'
              )
            )
          }
          await page.mouse.up()
          await page.focus('[role="application"]')
          await page.keyboard.press('Enter')
          if (loaded && !outside)
            for (const name of ['Player 8', 'Player 7', 'Player 6']) {
              await page.waitForSelector(
                `[aria-label="Home plate decision for ${name}"]`,
                { timeout: 30000 }
              )
              await click(page, 'Safe')
            }
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
  it('scores all four loaded home-run arrivals and keeps phone home decisions usable', async function () {
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
      for (const name of ['Player 8', 'Player 7', 'Player 6']) {
        await page.waitForSelector(
          `[aria-label="Home plate decision for ${name}"]`,
          { timeout: 30000 }
        )
        if (name === 'Player 8') {
          await new Promise(resolve => setTimeout(resolve, 10500))
          await page.waitForSelector(
            '[aria-label="Home plate decision for Player 8"]'
          )
        }
        expect(await page.$('[aria-label="Back"]')).equals(null)
        if (name === 'Player 8' && process.env.GS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: `${process.env.GS_SCORING_ARTIFACT_DIR}/home-queue-phone.png`
          })
        await click(page, 'Safe')
      }
      await page.waitForSelector('[aria-label*="Owls 4 · Hawks 0"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
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
            await page.waitForSelector('[aria-label^="Tap and Drag Thrower."]')
            await placeDefenderWithKeyboard(page)
            await page.waitForSelector(
              '[aria-label^="Tap and drag the next defender"]'
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
          '[aria-label^="Tap and drag the next defender"]'
        )
        await new Promise(resolve => setTimeout(resolve, 10500))
        await page.waitForSelector(
          '[aria-label^="Tap and drag the next defender"]'
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
        if (walk)
          await page.waitForSelector('[aria-label="Time to edit play"]', {
            timeout: 30000
          })
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 20000
        })
        await page.waitForSelector(
          `[aria-label*="0 balls 0 strikes ${walk ? 0 : 1} outs · Pitches ${walk ? 4 : 3}"]`
        )
        await page.locator('[aria-label^="Undo "]').click()
        await page.waitForSelector(
          `[aria-label*="${walk ? '3 balls 0' : '0 balls 2'} strikes 0 outs"]`
        )
      } finally {
        await page.close()
      }
    })
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
      await click(page, 'Undo Fielded by Player 1')
      await new Promise(resolve => setTimeout(resolve, 11000))
      await page.waitForSelector('[aria-label^="Drag fielder to location"]')
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
      await click(page, 'Ball in Play')
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
  it('keeps previous home runs when a runner is tagged out at home for third out', async () => {
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
      await chooseHit(page, 'Home Run')
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
        '[aria-label^="Tap and drag the next defender"]'
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
})
