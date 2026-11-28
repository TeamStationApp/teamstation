import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { PHONE_BOARD_RATIO } from '../../src/app/field/cameraModel'
import { BASE } from '../../src/app/field/fieldModel'
import { PARK } from '../../src/common/scoring/park'
import { signInTestAccount } from '../../src/test/passwordFixtures'
import type { E2eContext, WebSession } from '../core/spec'
import { clearSignInLimits } from './coach/coachApp'
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
  // The overlay's nameplates follow the canvas a frame or more after it
  // takes the new size: read once the card and the deck have held still
  // for three animation frames.
  await s.page.evaluate(() => {
    Reflect.deleteProperty(window, '__held')
  })
  await s.page.waitForFunction(
    () => {
      const card = document.querySelector('[data-position="C"]')
      const deck = document.querySelector('[data-testid="scoring-deck"]')
      if (card == null || deck == null) return false
      const a = card.getBoundingClientRect()
      const b = deck.getBoundingClientRect()
      const key = [a.left, a.top, a.bottom, b.top, b.left].join(':')
      const w = window as unknown as { __held?: { key: string; n: number } }
      // No ?. or ??: sucrase turns them into helpers the page lacks.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- runs in the page
      const held = w.__held === undefined ? { key: '', n: -1 } : w.__held
      w.__held = { key, n: held.key === key ? held.n + 1 : 0 }
      return w.__held.n >= 3
    },
    { polling: 'raf', timeout: 10000 }
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
    // A field column taller than wide is framed as a phone is: the board
    // spans it as an iPhone 15's does (419.977 / 393), unless the deck reaches
    // the strip first; first and third stay in the column.
    if (fieldWidth < height) {
      const ratio = board.width / fieldWidth
      expect(ratio).at.most(PHONE_BOARD_RATIO * 1.02)
      if (Math.abs(deck.bottom - strip.top) > 1)
        expect(ratio).closeTo(PHONE_BOARD_RATIO, PHONE_BOARD_RATIO * 0.02)
      for (const sign of [-1, 1]) {
        const [x, y] = await groundPoint(s.page, sign * BASE, -BASE)
        expect(x).within(holder.left, holder.right)
        expect(y).within(holder.top, deck.top)
      }
    } else
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

/**
 * Opens the Swing in Play menu and its Batter Out submenu, and holds both
 * inside the field column with the menu's bottom 8 above the deck, as the
 * native menu sits; saves `<name>.png` and the rects, then closes it.
 */
async function swingMenu(
  ctx: E2eContext,
  s: WebSession,
  name: string
): Promise<void> {
  const rects = async (): Promise<Record<string, DOMRect | null>> =>
    await s.page.evaluate(() => {
      const rect = (sel: string): DOMRect | null => {
        const el = document.querySelector(sel)
        return el == null
          ? null
          : (el.getBoundingClientRect().toJSON() as DOMRect)
      }
      return {
        holder: rect('[data-testid="scoring-field-holder"]'),
        deck: rect('[data-testid="scoring-deck"]'),
        trigger: rect('[aria-label="Swing in Play"]'),
        menu: rect('[aria-label="Swing in Play outcomes"]'),
        out: rect('[aria-label="Batter Out options"]')
      }
    })
  await s.m.tapOn({ css: '[aria-label="Swing in Play"]' })
  await s.m.tapOn({ css: '[aria-label="Batter Out"]' })
  await s.m.assertVisible({ text: 'Ball Caught' })
  const g = await rects()
  writeFileSync(ctx.artifact(name + '.png'), await s.m.screenshot())
  writeFileSync(ctx.artifact(name + '.json'), JSON.stringify(g, null, 2))
  const holder = g.holder!
  const deck = g.deck!
  for (const panel of [g.menu!, g.out!]) {
    expect(panel.left).at.least(holder.left - 1)
    expect(panel.right).at.most(holder.right + 1)
    expect(panel.bottom).at.most(deck.top - 8 + 1)
  }
  expect(g.menu!.bottom).closeTo(deck.top - 8, 1)
  expect(g.menu!.right).closeTo(g.trigger!.right, 1)
  await s.page.keyboard.press('Escape')
  await s.page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Swing in Play outcomes"]') == null
  )
}

/**
 * Opens the ☰ scoring menu and holds it 8 below ☰, its right edge 4 inside
 * ☰'s, inside the field column; saves `<name>.png` and the rects, then
 * closes it.
 */
async function scoringMenu(
  ctx: E2eContext,
  s: WebSession,
  name: string,
  width: number
): Promise<void> {
  const trigger = '[aria-label="Open scoring menu"]'
  await s.m.tapOn({ css: trigger })
  await s.m.assertVisible({ text: 'Exit Current Game' })
  const g = await s.page.evaluate(sel => {
    const rect = (q: string): DOMRect | null => {
      const el = document.querySelector(q)
      return el == null
        ? null
        : (el.getBoundingClientRect().toJSON() as DOMRect)
    }
    return {
      holder: rect('[data-testid="scoring-field-holder"]'),
      trigger: rect(sel),
      menu: rect('[data-testid="scoring-menu"]'),
      width: innerWidth
    }
  }, trigger)
  writeFileSync(ctx.artifact(name + '.png'), await s.m.screenshot())
  writeFileSync(ctx.artifact(name + '.json'), JSON.stringify(g, null, 2))
  expect(g.width, 'window width').equals(width)
  const menu = g.menu!
  expect(menu.top).closeTo(g.trigger!.bottom + 8, 1)
  expect(menu.right).closeTo(g.trigger!.right - 4, 1)
  expect(menu.left).at.least(g.holder!.left - 1)
  expect(menu.right).at.most(g.holder!.right + 1)
  await s.page.keyboard.press('Escape')
  await s.page.waitForFunction(
    () => document.querySelector('[data-testid="scoring-menu"]') == null
  )
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
    await clearSignInLimits(ctx)
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
    const snap = async (name: string): Promise<void> => {
      writeFileSync(ctx.artifact(name + '.png'), await s.m.screenshot())
    }
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
        writeFileSync(
          ctx.artifact(`geometry-${width}x${height}.json`),
          JSON.stringify(g, null, 2)
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
        await snap('log-collapsed')
        await s.m.tapOn({ text: 'Expand scoring updates' })
        const before = await s.page.$eval(logSel, el => el.textContent)
        await size(s, 320, 568, marker)
        expect(await s.page.$(logSel)).equals(null)
        await snap('log-zero')
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
        await snap('log-restored')
        await s.m.tapOn({ text: 'Dismiss scoring updates' })
        await size(s, 1133, 744, marker)
        await snap('log-dismissed')
        expect(await s.page.$(logSel)).equals(null)
        await peer.pitch()
        await waitForPeer(s)
      }
      const observer = await signInTestAccount(
        ctx.stack.origin + '/api/v1',
        world.accounts.coach
      )
      let reversed = false
      let firstReport = true
      for (const [width, height] of all ? desktop : tablets) {
        await s.resize({ width, height })
        // Re-arm the real report at each size: slow devices can take longer
        // than its eight-second lifetime to complete a full resize sweep.
        // The first game is populated already. A fourth Ball would start
        // a walk and leave the scorer finishing the at-bat.
        if (!firstReport) await peer.pitch()
        firstReport = false
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
            : world,
          observer
        ).catch(async (error: unknown) => {
          // What the peer's screen showed when its swap did not land.
          await peer
            .evidence(`peer-swap-${width}x${height}`)
            .catch(() => undefined)
          throw error
        })
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
      if (!all) {
        // A screenshot puts the window back to its first size (1133×744),
        // and setting the size it was last set to again does nothing, so
        // each check after a screenshot is at a new size or at 1133×744.
        await size(s, 1366, 1024, marker)
        await scoringMenu(ctx, s, 'side-menu-after', 1366)
        await size(s, 1133, 744, marker)
        await scoringMenu(ctx, s, 'side-menu-1133x744', 1133)
        await swingMenu(ctx, s, 'side-swing-menu-after')
        await size(s, 393, 852, marker)
        await swingMenu(ctx, s, 'stacked-swing-menu-after')
        await size(s, 390, 844, marker)
        await scoringMenu(ctx, s, 'stacked-menu-after', 390)
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
        await snap('box-before-ball')
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
        await snap('box-after-ball')
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
    } finally {
      await peer.close()
    }
  } finally {
    await s.close()
  }
}
