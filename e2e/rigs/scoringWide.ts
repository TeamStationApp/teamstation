import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { PARK } from '../../src/common/scoring/park'
import type { E2eContext, WebSession } from '../core/spec'
import { FIELD_SCENE_PROBE, groundPoint, measuredBoard } from './fieldPointer'
import {
  expectSwapped,
  remotePitch,
  RESET_AND_SWAP_REPORT,
  scoringSwapFixture
} from './scoringLayout'

const desktop = [
  [1920, 1080],
  [1440, 900],
  [1280, 800],
  [1194, 834],
  [1133, 744],
  [1024, 768],
  [820, 1180],
  [819, 1180],
  [1200, 640],
  [1200, 639],
  [768, 1024],
  [600, 900],
  [480, 800],
  [390, 844],
  [360, 740],
  [320, 568]
]
const tablets = [
  [1133, 744],
  [834, 1194],
  [1194, 834],
  [744, 1133]
]

async function size(
  s: WebSession,
  width: number,
  height: number,
  marker: string
): Promise<
  Record<'holder' | 'deck' | 'card' | 'strip' | 'menu', DOMRect> &
    Record<'column' | 'log' | 'box' | 'band', DOMRect | null>
> {
  await s.resize({ width, height })
  const side = width >= 820 && height >= 640
  const fieldWidth = side ? width - 360 : width
  await s.page.waitForFunction(
    (width, height, fw, marker) => {
      const canvas = document.querySelector('canvas[data-field-ready="true"]')
      if (canvas == null) return false
      return (
        window.innerWidth === width &&
        window.innerHeight === height &&
        document.documentElement.dataset.matrixRun === marker &&
        canvas.getBoundingClientRect().width === fw &&
        canvas.getBoundingClientRect().height === height
      )
    },
    {},
    width,
    height,
    fieldWidth,
    marker
  )
  const geometry = await s.page.evaluate(() => {
    const rect = (sel: string): DOMRect | null => {
      const el = document.querySelector(sel)
      return el == null
        ? null
        : (el.getBoundingClientRect().toJSON() as DOMRect)
    }
    return {
      holder: rect('[data-testid="scoring-field-holder"]')!,
      deck: rect('[data-testid="scoring-deck"]')!,
      card: rect('[data-position="C"]')!,
      strip: rect('[data-testid="scoring-notice-strip"]')!,
      menu: rect('[aria-label="Open scoring menu"]')!,
      column: rect('[data-testid="scoring-side"]'),
      log: rect('[data-testid="remote-scoring-updates"]'),
      box: rect('[data-testid="replay-box-score"]'),
      band: rect('[data-testid="scoring-log-band"]')
    }
  })
  const { holder, deck, card, strip, menu, column, log, box, band } = geometry
  expect(holder.width).closeTo(fieldWidth, 1)
  expect(deck.top - card.bottom).closeTo(4, 1)
  expect(deck.bottom).at.most(strip.top + 1)
  expect(card.left).at.least(holder.left - 1)
  expect(card.right).at.most(holder.right + 1)
  expect(strip.width).equals(fieldWidth)
  const board = await measuredBoard(s.page)
  expect(board.top - menu.bottom).closeTo(8, 1)
  if (side) {
    expect(column!.width).equals(360)
    expect(column!.left).equals(holder.right)
    expect(box!.left).at.least(column!.left)
    expect(band).equals(null)
    if (log != null) expect(log.bottom).at.most(box!.top + 1)
    for (const sign of [-1, 1]) {
      for (const a of [Math.PI / 4, PARK.outfieldHalfAngle]) {
        const [x, y] = await groundPoint(
          s.page,
          sign * PARK.outfieldRadius * Math.sin(a),
          -PARK.outfieldRadius * Math.cos(a)
        )
        expect(x).within(
          holder.left + fieldWidth * 0.05 - 1,
          holder.right - fieldWidth * 0.05 + 1
        )
        expect(y).within(holder.top, holder.bottom)
      }
    }
  } else {
    expect(column).equals(null)
    expect(box).equals(null)
    expect(band!.top - deck.bottom).closeTo(8, 1)
    if (log != null) expect(log.top - deck.bottom).closeTo(8, 1)
  }
  return geometry
}

const logSel = '[data-testid="remote-scoring-update-lines"]'
async function waitForPeer(s: WebSession): Promise<void> {
  await s.page.waitForFunction(
    sel => {
      const body = document.querySelector(sel)
      return body != null && String(body.textContent).includes('Score P')
    },
    { timeout: 30000 },
    logSel
  )
}

export async function wideScoring(
  ctx: E2eContext,
  all: boolean
): Promise<void> {
  const world = await scoringSwapFixture(ctx)
  const s = await ctx.browser(
    { width: 1133, height: 744 },
    { beforeLoad: FIELD_SCENE_PROBE }
  )
  try {
    await s.m.openLink({ link: ctx.stack.origin })
    await ctx.signIn('scorekeeper', s.m)
    await s.m.openLink({
      link: ctx.stack.origin + '/games/' + world.ids.game + '/score'
    })
    await s.m.assertVisible({ text: '^Ball$', timeout: 60000 })
    const marker = randomUUID()
    await s.page.evaluate(id => {
      document.documentElement.dataset.matrixRun = id
    }, marker)
    const peer = await remotePitch(ctx, world)
    try {
      await peer.pitch()
      await waitForPeer(s)
      for (const [width, height] of all ? desktop : tablets) {
        const g = await size(s, width, height, marker)
        writeFileSync(
          ctx.artifact(`${all ? 'desktop' : 'side'}-${width}x${height}.png`),
          await s.m.screenshot()
        )
        if (g.column != null) expect(g.log).not.equals(null)
      }
      if (all) {
        for (const [width, height] of [
          [1440, 900],
          [1200, 840],
          [1000, 800],
          [820, 800],
          [819, 800],
          [600, 810],
          [480, 830],
          [390, 844],
          [480, 830],
          [600, 810],
          [819, 800],
          [820, 800],
          [1000, 800],
          [1200, 840],
          [1440, 900]
        ])
          await size(s, width, height, marker)
        await s.m.tapOn({ text: 'Collapse scoring updates' })
        await size(s, 390, 844, marker)
        await s.m.assertVisible({ text: 'Expand scoring updates' })
        await s.m.tapOn({ text: 'Expand scoring updates' })
        const before = await s.page.$eval(logSel, el => el.textContent)
        await size(s, 320, 568, marker)
        expect(await s.page.$(logSel)).equals(null)
        await peer.pitch()
        await size(s, 390, 844, marker)
        await s.page.waitForFunction(
          (sel, old) => {
            const el = document.querySelector(sel)
            return (
              el != null &&
              el.textContent !== old &&
              String(el.textContent).includes('Score P')
            )
          },
          {},
          logSel,
          before
        )
        await s.m.tapOn({ text: 'Dismiss scoring updates' })
        await size(s, 1133, 744, marker)
        expect(await s.page.$(logSel)).equals(null)
        await peer.pitch()
        await waitForPeer(s)
      } else {
        await size(s, 1133, 744, marker)
        const pitcher = '[data-testid="replay-box-current"]'
        const stat = async (index: number): Promise<string> =>
          await s.page.$$eval(
            pitcher,
            (rows, i) => {
              const row = rows.find(r => r.children.length === 10)!
              return String(row.children[i].textContent)
            },
            index
          )
        const pc = Number(await stat(8))
        const tap = async (label: string): Promise<void> =>
          await s.m.tapOn({ css: `[aria-label="${label}"]` })
        await tap('Ball')
        await s.page.waitForFunction(
          (sel, expected) =>
            Array.from(document.querySelectorAll(sel)).some(
              row =>
                row.children.length === 10 &&
                row.children[8].textContent === String(expected)
            ),
          {},
          pitcher,
          pc + 1
        )
        const ks = Number(await stat(6))
        await tap('Called Strike')
        await tap('Called Strike')
        await tap('Called Strike')
        await s.page.waitForFunction(
          (sel, k) =>
            Array.from(document.querySelectorAll(sel)).some(
              row =>
                row.children.length === 10 &&
                row.children[6].textContent === String(k)
            ),
          { timeout: 1000 },
          pitcher,
          ks + 1
        )
      }
      let reversed = false
      for (const [width, height] of all ? desktop : tablets) {
        await s.resize({ width, height })
        // Re-arm the real report at each size: slow devices can take longer
        // than its eight-second lifetime to complete a full resize sweep.
        await peer.pitch()
        await peer.swap()
        await expectSwapped(
          ctx,
          reversed
            ? {
                ...world,
                ids: {
                  ...world.ids,
                  homeTeam: world.ids.awayTeam,
                  awayTeam: world.ids.homeTeam
                }
              }
            : world
        )
        reversed = !reversed
        await s.m.assertVisible({ text: RESET_AND_SWAP_REPORT, timeout: 10000 })
        const fieldWidth = width >= 820 && height >= 640 ? width - 360 : width
        await s.page.waitForFunction(
          (w, h, fw) => {
            const el = document.querySelector('[data-testid="scoringNotice"]')
            if (el == null || innerWidth !== w || innerHeight !== h)
              return false
            const box = el.getBoundingClientRect()
            return (
              box.left === 0 &&
              Math.abs(box.right - fw) < 1 &&
              Math.abs(box.bottom - h) < 1
            )
          },
          { timeout: 2000 },
          width,
          height,
          fieldWidth
        )
      }
    } finally {
      await peer.close()
    }
  } finally {
    await s.close()
  }
}
