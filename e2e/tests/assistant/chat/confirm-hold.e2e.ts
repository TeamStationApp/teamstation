/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions -- Serialized browser callbacks cannot capture Sucrase's generated helper functions. */
import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  EMBLEMS,
  pause,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

const CHANGE = '[data-testid="Tess change"]'
const HOLD = '[role="button"][aria-label="Hold to confirm"]'
const HOLD_MS = 3400
/** The card shows the fixture's random ids; her thought's row, how long it took. */
const CARD_IDS = [{ id: 'Tess change request' }, { id: 'Tess change body' }]

/** Asks for the game, and waits for the card that proposes it. */
async function proposed(web: TessWeb): Promise<void> {
  await web.open('/')
  await web.openChat()
  await web.say(
    'Add a game against Demo Eagles Saturday at 10',
    'Hold Confirm under the table to add the game.'
  )
  await web.see(CHANGE)
  await web.see(HOLD)
}

/** The team's games, read from the server behind the proxy. */
async function gamesOfTeam(web: TessWeb): Promise<number> {
  const { f } = web.t
  const answer = await f.h.request('GET', `/teams/${f.teamA}/games`)
  expect(answer.status).equals(200)
  const body = (await answer.json()) as unknown
  return Array.isArray(body)
    ? body.length
    : ((body as { games: unknown[] }).games ?? []).length
}

async function traceOffset(web: TessWeb): Promise<number> {
  return await web.page.evaluate(() => {
    const trace = document.querySelector('[data-testid="Tess hold trace"]')
    const offset =
      trace == null ? null : trace.getAttribute('stroke-dashoffset')
    return offset == null ? -1 : Number.parseFloat(offset)
  })
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/confirm-hold',
  title:
    'A change Tess proposes is shown on a card, and only a full three-second hold makes it',
  covers: [
    'src/app/tess/ChangeBatch.tsx',
    'src/app/tess/HoldToConfirm.tsx',
    'src/server/routes/tess.ts',
    'src/server/tess/turns.ts'
  ],
  minutes: 1,
  faults: ['not-saved', 'wrong-data', 'api-500'],
  scenarios: {
    'card-shows-the-change': async ctx => {
      await withTess(ctx, async web => {
        await proposed(web)
        const card = await web.page.$eval(
          CHANGE,
          node => node.textContent || ''
        )
        expect(card).includes('Demo Eagles')
        expect(card).includes('Sat May 15')
        expect(card).includes('10:00 AM')
        expect(card).includes('Demo Field')
        await web.m.tapOn({ text: 'Request details' })
        await eventually(async () => {
          const request = await web.page.$eval(
            '[data-testid="Tess change request"]',
            node => node.textContent || ''
          )
          const body = await web.page.$eval(
            '[data-testid="Tess change body"]',
            node => node.textContent || ''
          )
          expect(request).includes(`POST /teams/${web.t.f.teamA}/games`)
          expect(body).includes('"opponent"')
        })
        await ctx.checkpoint('change-card', {
          expect: [{ id: 'Tess change' }],
          golden: { mask: [...CARD_IDS, ...EMBLEMS] }
        })
      })
    },
    'early-release-runs-nothing': async ctx => {
      await withTess(
        ctx,
        async web => {
          await proposed(web)
          const gamesBefore = await gamesOfTeam(web)
          const fullOffset = await traceOffset(web)
          const holding = web.m.longPressOn({ css: HOLD, duration: 1200 })
          await eventually(
            async () => {
              expect(await traceOffset(web)).lessThan(fullOffset)
            },
            5000,
            50
          )
          await holding
          await pause(400)
          expect(await traceOffset(web)).equals(fullOffset)
          await ctx.checkpoint('nothing-ran', {
            expect: [{ id: 'Hold to confirm' }],
            readBack: async () => {
              expect(await gamesOfTeam(web)).equals(gamesBefore)
            }
          })
        },
        { liveClock: true }
      )
    },
    'full-hold-makes-the-change': async ctx => {
      await withTess(
        ctx,
        async web => {
          await proposed(web)
          const gamesBefore = await gamesOfTeam(web)
          await web.m.longPressOn({ css: HOLD, duration: HOLD_MS })
          await web.shown('Done: the game against Demo Eagles')
          await eventually(async () => {
            expect(
              await web.page.evaluate(() => {
                const status = document.querySelector(
                  '[data-testid="Tess change status"]'
                )
                return status == null ? null : status.textContent
              })
            ).equals('Done')
          })
          await ctx.checkpoint('change-done', {
            expect: [{ text: 'Done' }, { text: 'Demo League A' }],
            readBack: async () => {
              expect(await gamesOfTeam(web)).equals(gamesBefore + 1)
            },
            golden: {
              mask: [{ css: '[data-testid="Tess thought"]' }, ...EMBLEMS]
            }
          })
        },
        { liveClock: true }
      )
    }
  }
})
