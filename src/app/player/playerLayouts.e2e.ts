import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { type LineScoreStep, TeamStationClient } from '../../common/api'
import type { BoardLine } from '../../common/scoring/boardLineTypes'
import { lstrings } from '../locales/strings'
import type { Rect } from './multiCam/layout'
import { GAP, playerLayout } from './multiCam/playerLayout'
import {
  API,
  finish,
  fixture,
  type FixtureGame,
  GRID_VIDEOS,
  gridState,
  open,
  pause,
  shot,
  signedIn,
  type WebSession,
  webSession
} from './playerLayoutsRig.e2e'
import { currentInning } from './scoreboardOverlay/lineScoreLayout'

const PORTRAIT: [number, number] = [402, 874]
const LANDSCAPE: [number, number] = [874, 402]

const grid = (game: FixtureGame, count: number, t: number): string =>
  `/games/${game.id}?angles=${game.videos.slice(0, count).join(',')}&audio=${game.videos[0]}&t=${t}`

/** Waits for `count` tiles with pictures, and the board and box when due. */
async function gridReady(
  session: WebSession,
  count: number,
  wants: { board: boolean; box: boolean }
): Promise<void> {
  await session.page.waitForFunction(
    `(() => {
      const v = ${GRID_VIDEOS}
      if (v.length !== ${count} || !v.every(one => one.readyState >= 2)) return false
      const outside = node => node.closest('#root') == null
      const board = [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].some(outside)
      const box = [...document.querySelectorAll('[data-testid="line-score-box"]')].find(outside)
      return board === ${wants.board} && (box != null && box.getAttribute('data-at') !== '') === ${wants.box}
    })()`,
    { timeout: 60_000 }
  )
}

/** The grid's master picture: its time, and whether it is playing. */
async function master(
  session: WebSession
): Promise<{ currentTime: number; paused: boolean; aspect: number }> {
  return (await session.page.evaluate(`(() => {
    const v = ${GRID_VIDEOS}[0]
    return { currentTime: v.currentTime, paused: v.paused, aspect: v.videoWidth / v.videoHeight }
  })()`)) as { currentTime: number; paused: boolean; aspect: number }
}

/** The box score's rows as text, header first, and which cells are bold. */
async function boxRows(
  session: WebSession
): Promise<{ rows: string[][]; bold: string[] }> {
  return (await session.page.evaluate(`(() => {
    const line = [...document.querySelectorAll('[data-testid="line-score-box"]')].find(node => node.closest('#root') == null)
    const leaves = row => [...row.querySelectorAll('div')].filter(cell => cell.childElementCount === 0)
    const rows = [...line.firstElementChild.children]
    return {
      rows: rows.map(row => leaves(row).map(cell => cell.textContent)),
      bold: rows.slice(1).flatMap(row => leaves(row).filter(cell => Number(getComputedStyle(cell).fontWeight) >= 700).map(cell => cell.textContent))
    }
  })()`)) as { rows: string[][]; bold: string[] }
}

const near = (
  actual: Rect | null,
  expected: Rect | null,
  what: string
): void => {
  if (expected == null) {
    expect(actual, what).equals(null)
    return
  }
  expect(actual, what).not.equals(null)
  for (const key of ['x', 'y', 'w', 'h'] as const)
    expect(actual![key], `${what}.${key}`).closeTo(expected[key], 1)
}

/**
 * The player-layouts scenarios in a browser (E1–E4, and E9's full pass):
 * the one player for every video, its layouts, its line score and its
 * gestures, on the fixture's games.
 *
 *   MAESTRO_D=playerLayouts MAESTRO_D_BIN=~/git/maestro-d/maestro-d \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *   TS_PLAYER_APP=http://<this Mac>:8091 \
 *   [TS_E2E_ARTIFACT_DIR=…] [TS_PLAYER_BROWSER_COVERAGE=…] \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/playerLayouts.e2e.ts
 *
 * Needs the API (`npm start`), the production web build served with it
 * (`npm run build.web`, `scripts/e2e/playerLayouts/serveDist.mjs`) and the
 * fixture (`scripts/e2e/playerLayouts/fixture.ts`).
 */
describe('player layouts in a browser', function () {
  after(async function () {
    await finish()
  })

  it("opens a scored game's videos page", async function () {
    const S = fixture().games.S
    const session: WebSession = await webSession('smoke', 402, 874)
    await open(session, `/games/${S.id}?tab=watch`)
    await session.page.waitForFunction(
      `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 2 })()`,
      { timeout: 60_000 }
    )
    expect(await session.page.$$eval('video', all => all.length)).at.least(1)
  })

  it('places the angles, the board and the box score by playerLayout (E2)', async function () {
    const S = fixture().games.S
    const overlay = await new TeamStationClient({
      baseUrl: API,
      token: await signedIn()
    }).scoreboardOverlay(S.id)
    for (const [width, height] of [PORTRAIT, LANDSCAPE]) {
      const session = await webSession(`e2-${width}`, width, height)
      const landscape = width > height
      for (const count of [1, 2, 3, 4]) {
        await open(session, grid(S, count, 60))
        const box = landscape ? count === 2 || count === 3 : count <= 3
        await gridReady(session, count, { board: true, box })
        // The board's natural size: its rect undone by the scale it is
        // drawn at, read until the board holds still across the reads.
        const scaleNow = async (): Promise<number> =>
          Number(
            await session.page.evaluate(`(() => {
            const board = [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].find(node => node.closest('#root') == null)
            const scaled = [...board.querySelectorAll('div')].find(node => /scale\\(/.test(node.style.transform))
            return /scale\\(([0-9.]+)\\)/.exec(scaled.style.transform)[1]
          })()`)
          )
        let scale = await scaleNow()
        let state = await gridState(session)
        for (let tries = 0; tries < 10; tries++) {
          const again = await scaleNow()
          const settled = await gridState(session)
          if (
            again === scale &&
            JSON.stringify(settled.tiles) === JSON.stringify(state.tiles)
          )
            break
          scale = again
          state = settled
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        const { aspect } = await master(session)
        const screen = { width: state.window.w, height: state.window.h }
        const natural =
          state.board == null
            ? null
            : { width: state.board.w / scale, height: state.board.h / scale }
        const layout = playerLayout({
          screen,
          safe: { x: 0, y: 0, w: screen.width, h: screen.height },
          count,
          aspect,
          landscape,
          settings: overlay,
          board: natural,
          line: true
        })
        const what = `${count} ${landscape ? 'sideways' : 'upright'}`
        expect(state.tiles, what).length(count)
        state.tiles.forEach((tile, index) => {
          near(tile, layout.tiles[index], `${what} tile ${index}`)
        })
        near(state.box, layout.box, `${what} box`)
        if (count !== 4) near(state.board, layout.board, `${what} board`)
        // What the spec says, in its own terms.
        const [first] = state.tiles
        if (!landscape) {
          const above = state.box ?? state.board!
          if (count < 4)
            expect(first.y, `${what} tiles under`).closeTo(
              (state.box != null
                ? above.y + above.h
                : layout.tiles[0].y - GAP) + GAP,
              1
            )
        } else if (count === 2) {
          for (const tile of state.tiles)
            expect(tile.y + tile.h, `${what} on the bottom`).closeTo(
              screen.height,
              1
            )
          expect(state.board!.x, `${what} board left`).closeTo(
            screen.width / 2 + GAP,
            1
          )
          expect(state.box!.x + state.box!.w, `${what} box right`).closeTo(
            screen.width / 2 - GAP,
            1
          )
        } else if (count === 3) {
          // The top-right angle is the first; the bottom-left one the second.
          const right = state.tiles[0].x - GAP
          expect(state.board!.x + state.board!.w, `${what} board`).closeTo(
            right,
            1
          )
          expect(state.box!.x + state.box!.w, `${what} box`).closeTo(right, 1)
          expect(state.box!.y, `${what} box under the board`).greaterThan(
            state.board!.y
          )
          expect(state.box!.y + state.box!.h, `${what} in the cell`).at.most(
            state.tiles[1].y
          )
        } else if (count === 4) {
          expect(state.board!.x).at.least(first.x - 1)
          expect(state.board!.y).at.least(first.y - 1)
        }
        await shot(
          session,
          `web-${landscape ? 'landscape' : 'portrait'}-${count}-after.png`
        )
      }
    }
  })

  it('shows the line score at the playhead, and only for a scored game (E3)', async function () {
    const f = fixture()
    const { S, L, N, N0 } = f.games
    const client = new TeamStationClient({
      baseUrl: API,
      token: await signedIn()
    })
    const { steps } = await client.lineScore(S.id)
    expect(steps.length).greaterThan(10)
    /** The first step of inning `n`, by when it was in effect. */
    const inning = (n: number): LineScoreStep =>
      steps.find(step => currentInning(step.line) >= n)!
    const stepAt = (wall: number): LineScoreStep | undefined =>
      steps.filter(step => step.at <= wall).at(-1)

    for (const [width, height] of [PORTRAIT, LANDSCAPE]) {
      const landscape = width > height
      const session = await webSession(`e3-${width}`, width, height)
      const size = landscape ? 'landscape' : 'portrait'

      // Where the take's clock is: the board's wall time less the picture's.
      await open(session, grid(S, 2, 30))
      await gridReady(session, 2, { board: true, box: true })
      const offsetOf = async (): Promise<number> => {
        const state = await gridState(session)
        return state.board!.at - (await master(session)).currentTime * 1000
      }
      const offset = await offsetOf()
      const tFor = (wall: number): number => Math.max(0, (wall - offset) / 1000)

      /** The box against the step in effect at the playhead. */
      const check = async (what: string): Promise<BoardLine> => {
        const state = await gridState(session)
        const playhead = (await master(session)).currentTime * 1000 + offset
        const expected = stepAt(state.box!.at)!
        expect(state.box!.at, `${what} box at`).at.most(playhead + 1000)
        expect(
          stepAt(playhead + 1000)?.at ?? 0,
          `${what} the latest step`
        ).at.most(state.box!.at + 1000)
        expect(
          Math.max(...state.box!.innings),
          `${what} no later inning`
        ).at.most(currentInning(expected.line))
        const { rows, bold } = await boxRows(session)
        expect(rows[0].slice(-3), `${what} totals`).deep.equals(['R', 'H', 'E'])
        expect(rows[1][0]).length.greaterThan(0)
        expect(bold, `${what} R bold`).include.members([
          String(expected.line.away.r),
          String(expected.line.home.r)
        ])
        expect(rows[1].at(-3), `${what} away R`).equals(
          String(expected.line.away.r)
        )
        expect(rows[2].at(-3), `${what} home R`).equals(
          String(expected.line.home.r)
        )
        return expected.line
      }

      // Inning 1, played into inning 3: the box follows.
      await open(session, grid(S, 2, tFor(inning(1).at)))
      await gridReady(session, 2, { board: true, box: true })
      await session.page.evaluate(
        `(() => { const v = ${GRID_VIDEOS}; v[0].muted = true; return v[0].play() })()`
      )
      const seen = new Set<number>()
      const until = Date.now() + 120_000
      while (Date.now() < until) {
        const state = await gridState(session)
        seen.add(Math.max(...state.box!.innings))
        if (state.box!.at >= inning(3).at) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      expect([...seen], 'innings as it played').include.members([1, 2, 3])
      await check(`${size} into 3`)

      // Back into inning 2, then into inning 11.
      await open(session, grid(S, 2, tFor(inning(2).at) + 2))
      await gridReady(session, 2, { board: true, box: true })
      const second = await check(`${size} back into 2`)
      expect(currentInning(second)).equals(2)
      // The query for that moment answers the line the box showed.
      const shown = (await gridState(session)).box!.at
      const asked = await client.lineScore(S.id, { at: shown })
      expect(asked.steps).length(1)
      expect(asked.steps[0].line).deep.equals(second)

      await open(session, grid(S, 2, tFor(inning(11).at) + 2))
      await gridReady(session, 2, { board: true, box: true })
      await check(`${size} into 11`)
      const latest = (await gridState(session)).box!.innings
      // Shaped for six, it shows the latest six, at either size.
      expect(latest, 'the latest six innings').deep.equals([6, 7, 8, 9, 10, 11])
      await shot(
        session,
        landscape
          ? `web-${size}-2-inning11.png`
          : 'web-boxscore-extra-innings.png'
      )

      // L: logs and no events, so a board and no box.
      await open(session, grid(L, 2, 30))
      await gridReady(session, 2, { board: true, box: false })
      const logs = await gridState(session)
      if (landscape)
        expect(logs.board!.x + logs.board!.w / 2, 'L board centred').closeTo(
          logs.window.w / 2,
          1
        )
      else
        expect(logs.tiles[0].y, 'L tiles under the board').greaterThan(
          logs.board!.y + logs.board!.h
        )
      await shot(session, `web-${size}-2-logonly.png`)

      // N: events before the overlay's start, so a box and no board.
      await open(session, grid(N, 1, 0))
      if (landscape) {
        await gridReady(session, 1, { board: false, box: false })
      } else {
        await gridReady(session, 1, { board: false, box: true })
        const events = await gridState(session)
        expect(events.box!.y, 'N box at the top').closeTo(0, 1)
        expect(events.tiles[0].y, 'N tile under the box').closeTo(
          events.box!.y + events.box!.h + GAP,
          1
        )
        await shot(session, `web-portrait-1-noboard.png`)
      }

      // N0: neither, so the tiles from the top.
      await open(session, grid(N0, 1, 0))
      await gridReady(session, 1, { board: false, box: false })
      const bare = await gridState(session)
      if (!landscape)
        expect(bare.tiles[0].y, 'N0 tiles at the top').closeTo(0, 1)
    }
  })

  it('opens the one-angle player from the videos page, and comes back to the same moment (E1)', async function () {
    const { S, U } = fixture().games
    const session = await webSession('e1', 402, 874)
    const { page } = session
    const inlineTime = async (): Promise<{ t: number; paused: boolean }> =>
      (await page.evaluate(
        `(() => { const v = document.querySelector('#root video'); return { t: v.currentTime, paused: v.paused } })()`
      )) as { t: number; paused: boolean }
    const tiles = async (): Promise<
      Array<{ t: number; paused: boolean; ready: boolean }>
    > =>
      (await page.evaluate(
        `(() => ${GRID_VIDEOS}.map(v => ({ t: v.currentTime, paused: v.paused, ready: v.readyState >= 2 })))()`
      )) as Array<{ t: number; paused: boolean; ready: boolean }>
    const inlineReady = async (): Promise<void> => {
      await page.waitForFunction(
        `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 1 && ${GRID_VIDEOS}.length === 0 })()`,
        { timeout: 60_000 }
      )
    }
    /** Taps the picture, and answers the one tile's first reading. */
    const openPlayer = async (): Promise<{ t: number }> => {
      await page.click('[data-testid="gameVideoOpen"]')
      await page.waitForFunction(
        `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 && v[0].readyState >= 2 })()`,
        { timeout: 60_000 }
      )
      return (await tiles())[0]
    }
    const closePlayer = async (): Promise<number> => {
      const [tile] = await tiles()
      await page.evaluate(
        `(() => { [...document.querySelectorAll('[aria-label="${lstrings.angles_close}"]')].find(node => node.closest('#root') == null).click() })()`
      )
      await inlineReady()
      return tile.t
    }
    const settled = async (): Promise<{ t: number; paused: boolean }> => {
      // The resume seeks once the source is attached again.
      await page.waitForFunction(
        `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 1 && !v.seeking })()`,
        { timeout: 30_000 }
      )
      await new Promise(resolve => setTimeout(resolve, 1500))
      return await inlineTime()
    }

    for (const game of [S, U]) {
      const video = game === S ? game.videos[1] : game.videos[0]
      await open(session, `/games/${game.id}?tab=watch&video=${video}&t=30`)
      await inlineReady()
      if (game === S)
        await page.waitForFunction(
          `document.querySelectorAll('#root [data-testid="scoreboard-overlay"]').length === 1`,
          { timeout: 30_000 }
        )
      // No controls and nothing to press but the one way in; the board on
      // it where the game is scored.
      const inline = (await page.evaluate(`(() => {
        const v = document.querySelector('#root video')
        return {
          controls: v.controls,
          opens: document.querySelectorAll('#root [data-testid="gameVideoOpen"]').length,
          board: document.querySelectorAll('#root [data-testid="scoreboard-overlay"]').length
        }
      })()`)) as { controls: boolean; opens: number; board: number }
      expect(inline.controls, `${game.id} inline controls`).equals(false)
      expect(inline.opens).equals(1)
      if (game === S) expect(inline.board, 'the board inline').equals(1)
      await page.evaluate(`document.querySelector('#root video').pause()`)
      const before = await inlineTime()
      const opened = await openPlayer()
      expect(opened.t, `${game.id} opens at the inline time`).closeTo(
        before.t,
        0.5
      )
      await new Promise(resolve => setTimeout(resolve, 3000))
      const [playingTile] = await tiles()
      expect(playingTile.paused, `${game.id} playing`).equals(false)
      if (game === U) {
        const bar = (await page.evaluate(
          `(() => document.querySelectorAll('[role="slider"], [aria-valuenow]').length)()`
        )) as number
        expect(bar, 'U has a bar').greaterThan(0)
        // On its own media time, a drag scrubs it as it does any other.
        const [from] = await tiles()
        await page.mouse.move(402 * 0.5, 874 * 0.12)
        await page.mouse.down()
        await page.mouse.move(402 * 0.75, 874 * 0.12, { steps: 8 })
        await page.mouse.up()
        await page.waitForFunction(
          `(() => { const v = ${GRID_VIDEOS}[0]; return !v.seeking && v.readyState >= 2 })()`,
          { timeout: 30_000 }
        )
        const [to] = await tiles()
        expect(to.t - from.t, 'U scrubs').greaterThan(3)
      }
      await shot(
        session,
        `web-one-angle-${game === S ? 'scored' : 'nostart'}-after.png`
      )
      const last = await closePlayer()
      const back = await settled()
      expect(back.t, `${game.id} back at the player's time`).closeTo(last, 0.5)
      expect(back.paused, `${game.id} paused`).equals(true)
    }

    // A highlight opens the player at its own time.
    await open(session, `/games/${S.id}?tab=watch&video=${S.videos[1]}`)
    await inlineReady()
    const firstHighlight = await page.waitForSelector(
      '#root [aria-label^="Play highlight: "]',
      { timeout: 30_000 }
    )
    // The label as the page has it; trimmed here, where `??` is safe.
    const label = await firstHighlight!.evaluate(node =>
      node.getAttribute('aria-label')
    )
    const title = String(label).replace('Play highlight: ', '')
    const { highlights } = await new TeamStationClient({
      baseUrl: API,
      token: await signedIn()
    }).highlights(S.videos[1])
    const chosen = highlights.find(one => one.title === title)!
    await firstHighlight!.click()
    await page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 && v[0].readyState >= 2 })()`,
      { timeout: 60_000 }
    )
    expect((await tiles())[0].t, 'the player at the highlight').closeTo(
      chosen.startOffsetSec,
      0.5
    )

    // Reloaded, the address names the angle and nothing of where it came
    // from; Back is the videos page, and forward the player again.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 })()`,
      { timeout: 60_000 }
    )
    const search = (await page.evaluate('location.search')) as string
    expect(search).includes('angles=')
    expect(search).not.includes('from')
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(`(() => ${GRID_VIDEOS}.length === 0)()`, {
      timeout: 30_000
    })
    await page.goForward({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(`(() => ${GRID_VIDEOS}.length === 1)()`, {
      timeout: 30_000
    })
  })

  it('scrubs on a drag, crawls on a hold, picks a tile up, and keys Right as a tap or a hold (E4)', async function () {
    const { S } = fixture().games
    for (const [width, height, touch] of [
      [1280, 720, false],
      [402, 874, true]
    ] as const) {
      const what = touch ? 'touch' : 'mouse'
      const session = await webSession(`e4-${what}`, width, height, { touch })
      const { page } = session
      await open(session, grid(S, 2, 60))
      await gridReady(session, 2, { board: true, box: true })
      const times = async (): Promise<Array<{ t: number; paused: boolean }>> =>
        (await page.evaluate(
          `(() => ${GRID_VIDEOS}.map(v => ({ t: v.currentTime, paused: v.paused })))()`
        )) as Array<{ t: number; paused: boolean }>
      const slowShown = async (): Promise<boolean> =>
        (await page.evaluate(
          `document.body.innerText.includes(${JSON.stringify(lstrings.player_slow_mo)})`
        )) as boolean
      const pause = async (ms: number): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, ms))
      }
      const down = async (x: number, y: number): Promise<void> => {
        if (touch) await page.touchscreen.touchStart(x, y)
        else {
          await page.mouse.move(x, y)
          await page.mouse.down()
        }
      }
      const move = async (x: number, y: number): Promise<void> => {
        if (touch) await page.touchscreen.touchMove(x, y)
        else await page.mouse.move(x, y, { steps: 8 })
      }
      const up = async (): Promise<void> => {
        if (touch) await page.touchscreen.touchEnd()
        else await page.mouse.up()
      }
      const settle = async (): Promise<
        Array<{ t: number; paused: boolean }>
      > => {
        await page.waitForFunction(
          `(() => ${GRID_VIDEOS}.every(v => !v.seeking && v.readyState >= 2))()`,
          { timeout: 30_000 }
        )
        return await times()
      }

      // No transport buttons on the bar.
      for (const label of [
        lstrings.angles_back_ten,
        lstrings.angles_forward_ten,
        lstrings.angles_pause,
        lstrings.angles_play
      ])
        expect(
          await page.$(`[aria-label="${label}"]`),
          `${what}: no ${label}`
        ).equals(null)

      // A sideways drag from the middle, a quarter of the width.
      const span = Number(
        await page.evaluate(
          `document.querySelector('[aria-label="Position in the game"]').getAttribute('aria-valuemax')`
        )
      )
      const track = Number(
        await page.evaluate(
          `document.querySelector('[aria-label="Position in the game"]').getBoundingClientRect().width`
        )
      )
      // Past the grid's opening hold, which on a loaded bench can still be
      // holding the tiles here: the drag is to leave them playing.
      await page.waitForFunction(
        `(() => ${GRID_VIDEOS}.every(v => !v.paused))()`,
        { timeout: 30_000 }
      )
      const before = await settle()
      const y = height * (touch ? 0.12 : 0.3)
      const dx = width * 0.25
      await down(width * 0.5, y)
      await move(width * 0.5 + dx, y)
      const barUp = (await page.evaluate(
        `getComputedStyle(document.querySelector('[aria-label="Position in the game"]').closest('div[aria-hidden]')).opacity`
      )) as string
      await up()
      const after = await settle()
      const expected = (span * dx * 0.25) / track
      expect(Number(barUp), `${what}: the bar shows`).greaterThan(0)
      after.forEach((tile, index) => {
        expect(
          tile.t - before[index].t,
          `${what}: tile ${index} sought`
        ).closeTo(expected, Math.max(1, expected * 0.02))
        expect(tile.paused, `${what}: play state kept`).equals(
          before[index].paused
        )
      })

      // From the edge, nothing.
      await down(width * 0.05, y)
      await move(width * 0.05 + dx, y)
      await up()
      const edge = await settle()
      expect(edge[0].t, `${what}: an edge drag does nothing`).closeTo(
        after[0].t,
        0.3
      )

      // Held still on the middle right: a crawl, shown until it is let go.
      await down(width * 0.9, height * 0.5)
      await pause(600)
      expect(await slowShown(), `${what}: slow motion shows`).equals(true)
      await up()
      await pause(200)
      expect(await slowShown(), `${what}: and goes`).equals(false)

      // Held still on a tile's left, it is picked up; dropped on the other,
      // the two swap.
      const rects = (await gridState(session)).tiles
      const [first, second] = rects
      const from = [first.x + first.w * 0.15, first.y + first.h * 0.4] as const
      const to = [second.x + second.w * 0.5, second.y + second.h * 0.5] as const
      await down(...from)
      await pause(600)
      await move(...to)
      await up()
      await page.waitForFunction(
        `new URLSearchParams(location.search).get('angles') === ${JSON.stringify([S.videos[1], S.videos[0]].join(','))}`,
        { timeout: 10_000 }
      )

      if (!touch) {
        // Right, tapped: ten seconds on.
        const tapFrom = await settle()
        await page.keyboard.down('ArrowRight')
        await pause(100)
        await page.keyboard.up('ArrowRight')
        const tapped = await settle()
        expect(tapped[0].t - tapFrom[0].t, 'Right tapped').closeTo(10, 0.5)
        // Right, held: a crawl and no skip.
        await page.keyboard.down('ArrowRight')
        await pause(700)
        expect(await slowShown(), 'Right held crawls').equals(true)
        await page.keyboard.up('ArrowRight')
        const held = await settle()
        expect(held[0].t - tapped[0].t, 'Right held skips nothing').lessThan(2)
        expect(await slowShown()).equals(false)
      }
      await shot(session, `web-gestures-${what}-after.png`)
    }
  })

  it('says a browser without HEVC cannot play the video, inline and on every tile, and fetches none (E8)', async function () {
    const { S } = fixture().games
    const session = await webSession('e8', 1280, 720)
    const { page } = session
    // Chrome without HEVC: Media Source says no to it alone; everything else
    // answers as Chrome does, `canPlayType` included.
    await page.evaluateOnNewDocument(`(() => {
      const supported = MediaSource.isTypeSupported.bind(MediaSource)
      MediaSource.isTypeSupported = type => !/hvc1|hev1/.test(type) && supported(type)
    })()`)
    const media: string[] = []
    page.on('request', request => {
      const url = request.url()
      if (/\.(m3u8|m4s|mp4|ts)(\?|$)/.test(url)) media.push(url)
    })
    await open(session, `/games/${S.id}?tab=watch&video=${S.videos[0]}`)
    await page.waitForFunction(
      `document.body.innerText.includes(${JSON.stringify(lstrings.video_not_supported)})`,
      { timeout: 30_000 }
    )
    expect(
      await page.evaluate(`document.querySelectorAll('#root video').length`)
    ).equals(0)
    await shot(session, 'web-unsupported-after.png')

    await open(session, grid(S, 2, 60))
    await page.waitForFunction(
      `(() => [...document.querySelectorAll('[data-tile-state]')].filter(tile => tile.getAttribute('data-tile-state') === 'unsupported').length === 2)()`,
      { timeout: 30_000 }
    )
    await pause(3000)
    expect(media, 'no media asked for').deep.equals([])
  })
})
