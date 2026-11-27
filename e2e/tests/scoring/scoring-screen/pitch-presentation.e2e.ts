import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  chooseHit,
  click,
  open,
  suite,
  waitReady
} from '../../../rigs/scoring/webScoring'

/**
 * Pitch presentation: a lost WebGL context, pauses, audio and themed chrome.
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
    // A pitch's picture lasts 280 ms: the menu opens in the same task as
    // the tap, before it can end.
    await page.evaluate(() => {
      for (const label of ['Ball', 'Open scoring menu'])
        document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
    })
    await new Promise(resolve => setTimeout(resolve, 1400))
    await page.keyboard.press('Escape')
    expect(
      await page.$eval('[aria-label="Ball"]', node =>
        node.getAttribute('aria-disabled')
      )
    ).equals('true')
    await waitReady(page)
    // Hidden first, then the foul tapped: its 540 ms picture waits.
    const background = await page.browserContext().newPage()
    await background.bringToFront()
    await page.waitForFunction(() => document.hidden)
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[aria-label="Foul Ball"]')!.click()
    })
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
      await waitReady(page)
      // The pitch and two rapid taps in one task: a pitch's picture lasts
      // 280 ms, shorter than a puppeteer click's round trip.
      await page.evaluate(label => {
        const button = document.querySelector<HTMLElement>(
          `[aria-label="${label}"]`
        )!
        button.click()
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
    await click(page, 'Done')
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
        dragUp: String(play.getAttribute('title')).includes('drag up')
      }
    })
    expect(styles).deep.equals({ select: 'none', dragUp: true })
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
    // The hit, at whatever angle the screen started it at.
    const hitUndo = await page.$eval('[aria-label^="Undo "]', n =>
      String(n.getAttribute('aria-label'))
    )
    expect(hitUndo).matches(/^Undo -?\d+° /)
    await click(page, hitUndo)
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
/**
 * Scores a ball the server holds, leaves with browser Back, and opens
 * scoring again: at once (`gone` false), as a scorer who comes straight
 * back does while the screen is still sliding away, or once the screen
 * and its field have gone. The ball is on screen both ways, and reaches
 * the server once it answers.
 */

export default defineHarness({
  id: 'scoring/scoring-screen/pitch-presentation',
  title:
    'Pitch presentation: a lost WebGL context, pauses, audio and themed chrome',
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
