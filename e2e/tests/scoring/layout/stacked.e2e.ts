import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { PHONE_BOARD_RATIO } from '../../../../src/app/field/cameraModel'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { fakeMicrophone } from '../../../rigs/fakeMicrophone'
import {
  FIELD_SCENE_PROBE,
  maestroDriver,
  measuredBoard,
  placeOffered,
  setTrajectory
} from '../../../rigs/fieldPointer'
import { catcherFixture, remotePitch } from '../../../rigs/scoringLayout'
import { toneWav } from '../../../rigs/tessWeb'

const cover = '[data-testid="rotate-to-portrait"]'
/** The scoreboard's own count of the pitcher's pitches. */
async function pitches(page: WebSession['page']): Promise<number> {
  const label = await page.$eval('[aria-label^="Visitors "]', el =>
    String(el.getAttribute('aria-label'))
  )
  const count = /Pitches (\d+)/.exec(label)
  if (count == null) throw new Error('No pitch count in ' + label)
  return Number(count[1])
}

/**
 * The count once the peer's last pitch has reached this page: `pitch()`
 * waits for the server, not for this scorer's screen.
 */
async function settled(page: WebSession['page']): Promise<number> {
  let count = await pitches(page)
  for (let tries = 0; tries < 10; tries++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const next = await pitches(page)
    if (next === count) return count
    count = next
  }
  throw new Error('The pitch count never settled')
}

/**
 * A phone browser held sideways: the page cannot lock its rotation, so a
 * blurred cover asks for portrait and takes the tap meant for Ball. Turned
 * upright again, the same screen scores.
 */
async function sideways(ctx: E2eContext, session: WebSession): Promise<void> {
  const { m, page } = session
  // A phone's screen, not this desktop's: a short desktop window is not a
  // phone and is never covered. Safari reports its screen upright.
  const cdp = await page.createCDPSession()
  for (const [width, height, screenWidth, screenHeight] of [
    [852, 393, 852, 393],
    // Safari's landscape viewport under its toolbars
    [852, 283, 393, 852]
  ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth,
      screenHeight
    })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.waitForSelector(cover, { visible: true, timeout: 15000 })
    expect(await page.$eval(cover, el => el.textContent)).equals(
      'Rotate to portrait to continue scoring.'
    )
    // The words are on an opaque card, readable over a dark or light
    // blurred screen (drawn on the scrim, the words were only 1.14:1).
    const contrast = await page.$eval(
      '[data-testid="rotate-to-portrait-card"]',
      card => {
        // No ?? or ?.: sucrase's helpers are not defined inside the page.
        const rgb = (css: string): number[] => {
          const parts = css.match(/[\d.]+/g)
          return parts === null ? [] : parts.slice(0, 4).map(Number)
        }
        const lum = (c: number[]): number => {
          const [r, g, b] = c.slice(0, 3).map(v => {
            const x = v / 255
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        let text: Element = card
        const inner = card.querySelector('div')
        if (inner !== null) text = inner
        const fill = rgb(getComputedStyle(card).backgroundColor)
        if (fill.length === 4 && fill[3] < 1) return 0
        const a = lum(rgb(getComputedStyle(text).color))
        const b = lum(fill)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }
    )
    expect(contrast, 'cover text contrast').at.least(7)
    const before = await settled(page)
    const ball = await page.$eval('[aria-label="Ball"]', el => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    // What a finger there touches is the cover, and Ball does not score.
    expect(
      await page.evaluate(
        (x, y, sel) => {
          // No ?.: sucrase's helper is not defined inside the page.
          const hit = document.elementFromPoint(x, y)
          if (hit == null) return false
          return hit.closest(sel) !== null
        },
        ball.x,
        ball.y,
        cover
      )
    ).equals(true)
    await page.mouse.click(ball.x, ball.y)
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(await pitches(page)).equals(before)
    writeFileSync(
      ctx.artifact(`stacked-${width}x${height}-sideways.png`),
      await m.screenshot()
    )
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 393,
    height: 852,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 393,
    screenHeight: 852
  })
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForSelector(cover, { hidden: true, timeout: 15000 })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
  await session.resize({ width: 393, height: 852 })
  const before = await settled(page)
  await m.tapOn({ css: '[aria-label="Ball"]' })
  await page.waitForFunction(
    (sel, n) => {
      const el = document.querySelector(sel)
      const label = el == null ? '' : String(el.getAttribute('aria-label'))
      const count = /Pitches (\d+)/.exec(label)
      return count != null && Number(count[1]) === n
    },
    { timeout: 15000 },
    '[aria-label^="Visitors "]',
    before + 1
  )
  writeFileSync(
    ctx.artifact('stacked-upright-again-after.png'),
    await m.screenshot()
  )
}

export default defineE2e({
  id: 'scoring/layout/stacked',
  title: 'Pitch controls and remote updates beneath the catcher',
  kind: 'e2e',
  covers: [
    'src/app/scoring/RotateToPortrait.tsx',
    'src/app/field/scoringFrame.ts',
    'src/app/field/BaseballScreen.tsx',
    'src/app/scoring/RemoteScoringUpdates.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 7,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'web-sizes': async ctx => {
      const world = await ctx.fixture('coach-game')
      const session = await ctx.browser(
        { width: 320, height: 568 },
        { beforeLoad: FIELD_SCENE_PROBE }
      )
      const { m, page } = session
      try {
        await page.evaluateOnNewDocument(fakeMicrophone, toneWav())
        await m.openLink({ link: ctx.stack.origin })
        await ctx.signIn('scorekeeper', m)
        await m.openLink({
          link: `${ctx.stack.origin}/games/${world.ids.game}/score`
        })
        await m.assertVisible({ text: '^Ball$', timeout: 60000 })
        await m.tapOn({ css: '[aria-label="Dictation"]', timeout: 60000 })
        await m.assertVisible({ text: 'Push to talk', timeout: 15000 })
        const peer = await remotePitch(ctx, world)
        try {
          for (const [width, height] of [
            [320, 568],
            [375, 667],
            [390, 844],
            [393, 852],
            [412, 915]
          ]) {
            await session.resize({ width, height })
            await page.waitForFunction(
              (w, h) => {
                const canvas = document.querySelector(
                  'canvas[data-field-ready="true"]'
                )
                if (canvas == null) return false
                const r = canvas.getBoundingClientRect()
                return r.width === w && r.height === h
              },
              {},
              width,
              height
            )
            await peer.pitch()
            const rects = await page.evaluate(() => {
              const rect = (sel: string): DOMRect =>
                document.querySelector(sel)!.getBoundingClientRect().toJSON()
              return {
                card: rect('[data-position="C"]'),
                deck: rect('[data-testid="scoring-deck"]'),
                strip: rect('[data-testid="scoring-notice-strip"]'),
                menu: rect('[aria-label="Open scoring menu"]'),
                mic: rect('[aria-label="Dictation"]'),
                row: rect('[data-testid="walk-up-row"]')
              }
            })
            const { card, deck, strip, menu, mic, row } = rects
            const apart = (a: DOMRect, b: DOMRect): boolean =>
              a.right <= b.left ||
              b.right <= a.left ||
              a.bottom <= b.top ||
              b.bottom <= a.top
            expect(apart(mic, menu), 'the microphone clears ☰').equals(true)
            const board = await measuredBoard(page)
            expect(deck.top - card.bottom).closeTo(4, 1)
            expect(deck.top - row.bottom).closeTo(8, 1)
            expect(board.top - menu.bottom).closeTo(8, 1)
            expect(deck.bottom).at.most(strip.top)
            const lines = Math.max(
              0,
              Math.min(
                5,
                Math.floor((strip.top - 8 - (deck.bottom + 8) - 44 + 0.01) / 20)
              )
            )
            if (lines > 0) {
              await page.waitForFunction(
                () => {
                  const log = document.querySelector(
                    '[data-testid="remote-scoring-update-lines"]'
                  )
                  // No optional chaining: sucrase turns it into a helper
                  // call, and the helper is not defined inside the page.
                  return (
                    log != null && String(log.textContent).includes('Score P')
                  )
                },
                { timeout: 30000 }
              )
              const box = await page.evaluate(() => ({
                top: document
                  .querySelector('[data-testid="remote-scoring-updates"]')!
                  .getBoundingClientRect().top,
                height: document
                  .querySelector('[data-testid="remote-scoring-update-lines"]')!
                  .getBoundingClientRect().height
              }))
              expect(box.top - deck.bottom).closeTo(8, 1)
              expect(box.height).equals(lines * 20)
              // Height past the longest log goes to the field until the board
              // spans the column as an iPhone 15's does; never wider.
              expect(board.width / width).at.most(PHONE_BOARD_RATIO * 1.02)
              if (lines === 5 && board.width / width < PHONE_BOARD_RATIO * 0.98)
                expect(strip.top - (box.top + 44 + box.height)).closeTo(8, 1)
            } else
              expect(
                await page.$('[data-testid="remote-scoring-updates"]')
              ).equals(null)
            if (width === 393)
              expect(board.width).closeTo(419.977, 419.977 * 0.02)
            writeFileSync(
              ctx.artifact(`stacked-${width}-after.png`),
              await m.screenshot()
            )
          }
          await sideways(ctx, session)
        } finally {
          await peer.close()
        }
      } finally {
        await session.close()
      }
    },
    'done-pill': async ctx => {
      for (const width of [320, 375, 393]) {
        const world = await ctx.fixture('coach-game')
        const kind =
          width === 320 ? 'long' : width === 375 ? 'empty' : 'unnumbered'
        await catcherFixture(ctx, world, kind)
        const session = await ctx.browser(
          { width, height: width === 320 ? 568 : width === 375 ? 667 : 852 },
          { beforeLoad: FIELD_SCENE_PROBE }
        )
        const { m, page } = session
        try {
          await page.evaluateOnNewDocument(fakeMicrophone, toneWav())
          await m.openLink({ link: ctx.stack.origin })
          await ctx.signIn('scorekeeper', m)
          await m.openLink({
            link: `${ctx.stack.origin}/games/${world.ids.game}/score`
          })
          await m.tapOn({ css: '[aria-label="Dictation"]', timeout: 60000 })
          await m.tapOn({ css: '[aria-label="Swing in Play"]' })
          await m.tapOn({ text: 'Single' })
          const driver = maestroDriver(m)
          await placeOffered(driver)
          await setTrajectory(driver)
          const done = '[data-testid="scoring-done-pill"]'
          await page.waitForSelector(done, { visible: true })
          const face = await page.$eval('[data-position="C"]', el => {
            const number = el.querySelector('[data-line="number"]')
            return {
              label: el.getAttribute('aria-label'),
              number: number == null ? undefined : number.textContent
            }
          })
          if (kind === 'long')
            expect(face.label).contains('Alexandriaverylongcatchername')
          if (kind === 'empty') expect(face.label).contains('Assign')
          if (kind === 'unnumbered') expect(face.number).equals(undefined)
          const gap = await page.evaluate(done => {
            const rect = (sel: string): DOMRect =>
              document.querySelector(sel)!.getBoundingClientRect()
            const box = rect(done)
            return {
              card: box.left - rect('[data-position="C"]').right,
              mic: rect('[aria-label="Dictation"]').left - box.right
            }
          }, done)
          expect(gap.card).at.least(8 - 0.01)
          expect(gap.mic).closeTo(6, 0.5)
          writeFileSync(
            ctx.artifact(
              width === 393 ? 'done-pill-after.png' : `done-pill-${width}.png`
            ),
            await m.screenshot()
          )
          await m.tapOn({ css: done })
          await page.waitForSelector(done, { hidden: true })
        } finally {
          await session.close()
        }
      }
    }
  }
})
