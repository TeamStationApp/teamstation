import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
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

export default defineE2e({
  id: 'scoring/layout/stacked',
  title: 'Pitch controls and remote updates beneath the catcher',
  kind: 'e2e',
  covers: [
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
            [412, 915],
            [852, 393]
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
                row: rect('[data-testid="walk-up-row"]')
              }
            })
            const { card, deck, strip, menu, row } = rects
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
                  return log?.textContent?.includes('Score P') === true
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
