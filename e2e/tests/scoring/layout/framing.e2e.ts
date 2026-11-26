import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import { FIELD_SCENE_PROBE, measuredBoard } from '../../../rigs/fieldPointer'

export default defineE2e({
  id: 'scoring/layout/framing',
  title:
    'The scoreboard sits beneath the menu and the catcher clears the pitch controls',
  kind: 'e2e',
  covers: [
    'src/app/field/scoringFrame.ts',
    'src/app/field/cameraModel.ts',
    'src/app/field/FieldScene.tsx',
    'src/app/field/BaseballScreen.tsx',
    'src/app/scoring/ScoringScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['web', 'api'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'web-sizes': async ctx => {
      const world = await ctx.fixture('coach-game')
      const session = await ctx.browser(
        { width: 375, height: 667 },
        { beforeLoad: FIELD_SCENE_PROBE }
      )
      const { m, page } = session
      try {
        await m.openLink({ link: ctx.stack.origin })
        await ctx.signIn('scorekeeper', m)
        for (const [width, height] of [
          [375, 667],
          [390, 844],
          [393, 852],
          [463, 905],
          [800, 905],
          [1000, 742]
        ]) {
          await session.resize({ width, height })
          await m.openLink({
            link: `${ctx.stack.origin}/games/${world.ids.game}/score`
          })
          await m.assertVisible({ text: 'Ball', timeout: 60000 })
          await page.waitForFunction(
            (width, height) => {
              const canvas = document.querySelector(
                'canvas[data-field-ready="true"]'
              )
              if (canvas == null) return false
              const rect = canvas.getBoundingClientRect()
              return (
                rect.width === width &&
                rect.height === height &&
                document.querySelector('[data-position="C"]') != null
              )
            },
            {},
            width,
            height
          )
          const board = await measuredBoard(page)
          const { menu, card, face, firstControl } = await page.evaluate(() => {
            const el = (sel: string): Element => document.querySelector(sel)!
            const catcher = el('[data-position="C"]')
            const row = document.querySelector('[data-testid="walk-up-row"]')
            return {
              menu: el(
                '[aria-label="Open scoring menu"]'
              ).getBoundingClientRect().bottom,
              card: catcher.getBoundingClientRect().toJSON(),
              face: catcher.getAttribute('aria-label'),
              firstControl: (row == null
                ? el('[aria-label="More"]')
                : row
              ).getBoundingClientRect().top
            }
          })
          expect(board.top, 'roof below menu').closeTo(menu + 8, 1)
          expect(
            card.bottom,
            'entire catcher card clears the controls'
          ).at.most(firstControl + 0.5)
          if (width === 463)
            expect(
              firstControl - card.bottom,
              'spare height above the controls'
            ).greaterThan(8)
          if (width === 1000) {
            expect(card.height).greaterThan(0)
            expect(card.top).greaterThan(board.top)
            expect(card.left).at.least(0)
            expect(card.right).at.most(width)
            expect(face).to.be.a('string').and.have.length.greaterThan(0)
          }
          if (width === 393)
            expect(
              board.width,
              'unclipped roof at baseline phone size'
            ).closeTo(419.977, 419.977 * 0.02)
          writeFileSync(
            ctx.artifact(`framing-${width}-after.png`),
            await m.screenshot()
          )
          console.log(
            JSON.stringify({
              width,
              height,
              board,
              menu,
              card,
              firstControl,
              face
            })
          )
        }
      } finally {
        await session.close()
      }
    }
  }
})
