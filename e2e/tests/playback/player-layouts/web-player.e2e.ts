import { expect } from 'chai'

import { lstrings } from '../../../../src/app/locales/strings'
import type { Rect } from '../../../../src/app/player/multiCam/layout'
import {
  GAP,
  playerLayout
} from '../../../../src/app/player/multiCam/playerLayout'
import { currentInning } from '../../../../src/app/player/scoreboardOverlay/lineScoreLayout'
import type { LineScoreStep } from '../../../../src/common/api'
import type { BoardLine } from '../../../../src/common/scoring/boardLineTypes'
import { mediaAt, wallAt } from '../../../../src/common/wallTimeline'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  GRID_VIDEOS,
  gridPath,
  gridState,
  open,
  pause,
  type PlayerGame,
  type PlayerWeb,
  playerWeb,
  playerWorld,
  recordedGames,
  rectOf,
  setPlaying,
  shot,
  tapIn
} from './games'

/**
 * The one player for every video in a browser (E1–E4, E8, and E9's full
 * pass): its layouts, its line score and its gestures, on the
 * `player-layouts` world's games recorded on the stack. Every tap, drag and
 * key is maestro-d's; the page is only read.
 */

const PORTRAIT: [number, number] = [402, 874]
const LANDSCAPE: [number, number] = [874, 402]

async function resizeTo(
  web: PlayerWeb,
  width: number,
  height: number
): Promise<void> {
  await web.session.resize({ width, height })
  web.width = width
  web.height = height
}

/** Waits for `count` tiles with pictures, and the board and box when due. */
async function gridReady(
  web: PlayerWeb,
  count: number,
  wants: { board: boolean; box: boolean }
): Promise<void> {
  await web.page.waitForFunction(
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
  web: PlayerWeb
): Promise<{ currentTime: number; paused: boolean; aspect: number }> {
  return (await web.page.evaluate(`(() => {
    const v = ${GRID_VIDEOS}[0]
    return { currentTime: v.currentTime, paused: v.paused, aspect: v.videoWidth / v.videoHeight }
  })()`)) as { currentTime: number; paused: boolean; aspect: number }
}

/** The box score's rows as text, header first, and which cells are bold. */
async function boxRows(
  web: PlayerWeb
): Promise<{ rows: string[][]; bold: string[] }> {
  return (await web.page.evaluate(`(() => {
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

async function scoredGame(
  ctx: HarnessContext,
  quick = true
): Promise<{
  pw: Awaited<ReturnType<typeof playerWorld>>
  S: PlayerGame
}> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S'], { quick })
  return { pw, S: games.S! }
}

async function videosPage(ctx: HarnessContext): Promise<void> {
  const { pw, S } = await scoredGame(ctx)
  const web = await playerWeb(pw, ...PORTRAIT)
  await open(web, `/games/${S.id}?tab=watch`)
  await web.page
    .waitForFunction(
      `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 2 })()`,
      { timeout: 60_000 }
    )
    .catch(async (error: unknown) => {
      // Why nothing played: each video's state, and what the page reported.
      const videos = await web.page.evaluate(
        `JSON.stringify(Array.from(document.querySelectorAll('video')).map(v => ({ root: v.closest('#root') != null, ready: v.readyState, network: v.networkState, error: v.error && v.error.message })))`
      )
      const shown = await web.page.evaluate(
        `location.href + ' :: ' + document.body.innerText.slice(0, 400)`
      )
      throw new Error(
        `${String(error)}; videos ${String(videos)}; page ${String(shown)}; ${web.errors.join(' | ')}`
      )
    })
  expect(
    await web.page.evaluate(`document.querySelectorAll('video').length`)
  ).at.least(1)
}

async function gridLayout(ctx: HarnessContext): Promise<void> {
  const { pw, S } = await scoredGame(ctx)
  const overlay = await pw.client.scoreboardOverlay(S.id)
  const web = await playerWeb(pw, ...PORTRAIT)
  for (const [width, height] of [PORTRAIT, LANDSCAPE]) {
    await resizeTo(web, width, height)
    const landscape = width > height
    for (const count of [1, 2, 3, 4]) {
      await open(web, gridPath(S, count, 60))
      const box = landscape ? count === 2 || count === 3 : count <= 3
      await gridReady(web, count, { board: true, box })
      // The board's natural size: its rect undone by the scale it is
      // drawn at, read until the board holds still across the reads.
      const scaleNow = async (): Promise<number> =>
        Number(
          await web.page.evaluate(`(() => {
          const board = [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].find(node => node.closest('#root') == null)
          const scaled = [...board.querySelectorAll('div')].find(node => /scale\\(/.test(node.style.transform))
          return /scale\\(([0-9.]+)\\)/.exec(scaled.style.transform)[1]
        })()`)
        )
      let scale = await scaleNow()
      let state = await gridState(web.page)
      for (let tries = 0; tries < 10; tries++) {
        const again = await scaleNow()
        const settled = await gridState(web.page)
        if (
          again === scale &&
          JSON.stringify(settled.tiles) === JSON.stringify(state.tiles)
        )
          break
        scale = again
        state = settled
        await pause(200)
      }
      const { aspect } = await master(web)
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
            (state.box != null ? above.y + above.h : layout.tiles[0].y - GAP) +
              GAP,
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
        web,
        `web-${landscape ? 'landscape' : 'portrait'}-${count}-after.png`
      )
    }
  }
}

async function lineScore(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S', 'L', 'N', 'N0'])
  const { S, L, N, N0 } = games as Record<'S' | 'L' | 'N' | 'N0', PlayerGame>
  const { client } = pw
  const { steps } = await client.lineScore(S.id)
  expect(steps.length).greaterThan(10)
  /** The first step of inning `n`, by when it was in effect. */
  const inning = (n: number): LineScoreStep =>
    steps.find(step => currentInning(step.line) >= n)!
  const stepAt = (wall: number): LineScoreStep | undefined =>
    steps.filter(step => step.at <= wall).at(-1)

  const web = await playerWeb(pw, ...PORTRAIT)
  for (const [width, height] of [PORTRAIT, LANDSCAPE]) {
    const landscape = width > height
    await resizeTo(web, width, height)
    const size = landscape ? 'landscape' : 'portrait'

    // Use the recording's media-to-wall anchors. The scoreboard's data-at
    // is the last scoring change, not the current playhead's wall time.
    const timeline = await client.wallTimeline(S.videos[0])
    const tFor = (wall: number): number =>
      Math.max(0, mediaAt(timeline.anchors, wall)! / 1000)

    /** The box against the step in effect at the playhead. */
    const check = async (what: string): Promise<BoardLine> => {
      const state = await gridState(web.page)
      const playhead = wallAt(
        timeline.anchors,
        (await master(web)).currentTime * 1000
      )!
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
      const { rows, bold } = await boxRows(web)
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
    await open(web, gridPath(S, 2, tFor(inning(1).at)))
    await gridReady(web, 2, { board: true, box: true })
    await setPlaying(web, true, true)
    const seen = new Set<number>()
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      const state = await gridState(web.page)
      seen.add(Math.max(...state.box!.innings))
      if (state.box!.at >= inning(3).at) break
      await pause(1000)
    }
    expect([...seen], 'innings as it played').include.members([1, 2, 3])
    await check(`${size} into 3`)

    // Back into inning 2, then into inning 11.
    await open(web, gridPath(S, 2, tFor(inning(2).at) + 2))
    await gridReady(web, 2, { board: true, box: true })
    const second = await check(`${size} back into 2`)
    expect(currentInning(second)).equals(2)
    // The query for that moment answers the line the box showed.
    const shown = (await gridState(web.page)).box!.at
    const asked = await client.lineScore(S.id, { at: shown })
    expect(asked.steps).length(1)
    expect(asked.steps[0].line).deep.equals(second)

    await open(web, gridPath(S, 2, tFor(inning(11).at) + 2))
    await gridReady(web, 2, { board: true, box: true })
    const eleventh = await check(`${size} into 11`)
    expect(currentInning(eleventh)).equals(11)
    const latest = (await gridState(web.page)).box!.innings
    // Compact layouts fit more than six columns; every layout keeps the
    // most recent innings in order and ends at the current inning.
    expect(latest.length, 'at least six innings fit').at.least(6)
    expect(latest, 'the latest consecutive innings').deep.equals(
      Array.from(
        { length: latest.length },
        (_, index) => 12 - latest.length + index
      )
    )
    await shot(
      web,
      landscape
        ? `web-${size}-2-inning11.png`
        : 'web-boxscore-extra-innings.png'
    )

    // L: logs and no events, so a board and no box.
    await open(web, gridPath(L, 2, 30))
    await gridReady(web, 2, { board: true, box: false })
    const logs = await gridState(web.page)
    if (landscape)
      expect(logs.board!.x + logs.board!.w / 2, 'L board centred').closeTo(
        logs.window.w / 2,
        1
      )
    else
      expect(logs.tiles[0].y, 'L tiles under the board').greaterThan(
        logs.board!.y + logs.board!.h
      )
    await shot(web, `web-${size}-2-logonly.png`)

    // N: events before the overlay's start, so a box and no board.
    await open(web, gridPath(N, 1, 0))
    if (landscape) {
      await gridReady(web, 1, { board: false, box: false })
    } else {
      await gridReady(web, 1, { board: false, box: true })
      const events = await gridState(web.page)
      expect(events.box!.y, 'N box at the top').closeTo(0, 1)
      expect(events.tiles[0].y, 'N tile under the box').closeTo(
        events.box!.y + events.box!.h + GAP,
        1
      )
      await shot(web, `web-portrait-1-noboard.png`)
    }

    // N0: neither, so the tiles from the top.
    await open(web, gridPath(N0, 1, 0))
    await gridReady(web, 1, { board: false, box: false })
    const bare = await gridState(web.page)
    if (!landscape) expect(bare.tiles[0].y, 'N0 tiles at the top').closeTo(0, 1)
  }
}

async function oneAnglePlayer(ctx: HarnessContext): Promise<void> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S', 'U'], { quick: true })
  const { S, U } = games as Record<'S' | 'U', PlayerGame>
  const web = await playerWeb(pw, ...PORTRAIT)
  const { page } = web
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
    try {
      await page.waitForFunction(
        `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 1 && ${GRID_VIDEOS}.length === 0 })()`,
        { timeout: 60_000 }
      )
    } catch (error) {
      pw.say(
        'the inline video never became ready',
        await page.evaluate(
          `(() => ({ url: location.href, inline: [...document.querySelectorAll('#root video')].map(v => ({ src: v.currentSrc, readyState: v.readyState, error: v.error && v.error.code })), tiles: ${GRID_VIDEOS}.length }))()`
        )
      )
      throw error
    }
  }
  /** Taps the picture's open control, and answers the one tile's first reading. */
  const openPlayer = async (): Promise<{ t: number }> => {
    // A first tap only reveals hidden controls (develop 44b04fbc7); whether
    // they showed is read from whether the player opened, and a second tap
    // inside the reveal opens it.
    const square = '#root [data-testid="gameVideoOpen"]'
    await tapIn(web, await rectOf(page, square))
    const opened = await page
      .waitForFunction(`(() => ${GRID_VIDEOS}.length > 0)()`, {
        timeout: 1000
      })
      .then(
        () => true,
        () => false
      )
    if (!opened) await tapIn(web, await rectOf(page, square))
    await page.waitForFunction(
      `(() => { const v = ${GRID_VIDEOS}; return v.length === 1 && v[0].readyState >= 2 })()`,
      { timeout: 60_000 }
    )
    return (await tiles())[0]
  }
  const closePlayer = async (): Promise<number> => {
    const [tile] = await tiles()
    await web.m.pressKey({ key: 'tab' })
    const close = `[aria-label="${lstrings.angles_close}"][tabindex="0"]`
    await page.waitForFunction(`document.querySelector('${close}')`)
    await tapIn(web, await rectOf(page, close))
    await inlineReady()
    return tile.t
  }
  const settled = async (): Promise<{ t: number; paused: boolean }> => {
    // The resume seeks once the source is attached again.
    await page.waitForFunction(
      `(() => { const v = document.querySelector('#root video'); return v != null && v.readyState >= 1 && !v.seeking })()`,
      { timeout: 30_000 }
    )
    await pause(1500)
    return await inlineTime()
  }

  for (const game of [S, U]) {
    const video = game === S ? game.videos[1] : game.videos[0]
    await open(web, `/games/${game.id}?tab=watch&video=${video}&t=30`)
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
    await setPlaying(web, false, false)
    const before = await inlineTime()
    const opened = await openPlayer()
    expect(opened.t, `${game.id} opens at the inline time`).closeTo(
      before.t,
      0.5
    )
    await pause(3000)
    const [playingTile] = await tiles()
    expect(playingTile.paused, `${game.id} playing`).equals(false)
    if (game === U) {
      const bar = (await page.evaluate(
        `(() => document.querySelectorAll('[role="slider"], [aria-valuenow]').length)()`
      )) as number
      expect(bar, 'U has a bar').greaterThan(0)
      // On its own media time, a drag along the bottom row scrubs it as it
      // does any other.
      const [from] = await tiles()
      const [only] = (await gridState(page)).tiles
      const row = Math.round(only.y + only.h * 0.9)
      await web.m.dragAndDrop({
        from: { point: `${Math.round(402 * 0.5)},${row}` },
        to: { point: `${Math.round(402 * 0.75)},${row}` },
        holdDuration: 1,
        duration: 400
      })
      await page.waitForFunction(
        `(() => { const v = ${GRID_VIDEOS}[0]; return !v.seeking && v.readyState >= 2 })()`,
        { timeout: 30_000 }
      )
      const [to] = await tiles()
      expect(to.t - from.t, 'U scrubs').greaterThan(3)
    }
    await shot(
      web,
      `web-one-angle-${game === S ? 'scored' : 'nostart'}-after.png`
    )
    // The card comes back as the player was: the scored game closed
    // playing, the other paused first.
    const playing = game === S
    if (!playing) await setPlaying(web, true, false)
    const closedAt = Date.now()
    const last = await closePlayer()
    const back = await settled()
    expect(back.paused, `${game.id} ${playing ? 'playing' : 'paused'}`).equals(
      !playing
    )
    if (playing)
      expect(back.t, `${game.id} on from the player's time`).within(
        last - 0.5,
        last + (Date.now() - closedAt) / 1000 + 0.5
      )
    else
      expect(back.t, `${game.id} back at the player's time`).closeTo(last, 0.5)
  }

  // In a browser a highlight plays in the page's own picture, at its own
  // time and with its sound, and no full-screen player opens.
  await open(web, `/games/${S.id}?tab=watch&video=${S.videos[1]}`)
  await inlineReady()
  await page.waitForFunction(
    `document.querySelector('#root [aria-label^="Play highlight: "]') != null`,
    { timeout: 30_000 }
  )
  const label = (await page.evaluate(
    `document.querySelector('#root [aria-label^="Play highlight: "]').getAttribute('aria-label')`
  )) as string
  const title = String(label).replace('Play highlight: ', '')
  const { highlights } = await pw.client.highlights(S.videos[1])
  const chosen = highlights.find(one => one.title === title)!
  await tapIn(web, await rectOf(page, '#root [aria-label^="Play highlight: "]'))
  await page.waitForFunction(
    `(() => { const v = document.querySelector('#root video'); return v != null && !v.paused && Math.abs(v.currentTime - ${chosen.startOffsetSec}) < 1.5 })()`,
    { timeout: 30_000 }
  )
  const card = (await page.evaluate(
    `(() => ({ muted: document.querySelector('#root video').muted, grid: ${GRID_VIDEOS}.length }))()`
  )) as { muted: boolean; grid: number }
  expect(card.grid, 'no full-screen player').equals(0)
  expect(card.muted, 'heard').equals(false)
}

/**
 * A drag along the bottom row scrubs, a drag above it does nothing, a hold
 * crawls, a hold on a tile picks it up, and (with a mouse) Right tapped
 * skips ten seconds. The touch run's pointer reads as a finger's
 * (`playerBeforeLoad`'s `touchPointer`): maestro-d's web driver sends a
 * mouse's.
 */
function gestures(touch: boolean) {
  return async (ctx: HarnessContext): Promise<void> => {
    const { pw, S } = await scoredGame(ctx)
    const [width, height] = touch ? [402, 874] : [1280, 720]
    const what = touch ? 'touch' : 'mouse'
    const web = await playerWeb(pw, width, height, {
      touch,
      touchPointer: touch
    })
    const { page, m } = web
    await open(web, gridPath(S, 2, 60))
    await gridReady(web, 2, { board: true, box: true })
    const times = async (): Promise<Array<{ t: number; paused: boolean }>> =>
      (await page.evaluate(
        `(() => ${GRID_VIDEOS}.map(v => ({ t: v.currentTime, paused: v.paused })))()`
      )) as Array<{ t: number; paused: boolean }>
    const slowShown = async (): Promise<boolean> =>
      (await page.evaluate(
        `document.body.innerText.includes(${JSON.stringify(lstrings.player_slow_mo)})`
      )) as boolean
    const point = (x: number, y: number): string =>
      `${Math.round(x)},${Math.round(y)}`
    const settle = async (): Promise<Array<{ t: number; paused: boolean }>> => {
      await page.waitForFunction(
        `(() => ${GRID_VIDEOS}.every(v => !v.seeking && v.readyState >= 2))()`,
        { timeout: 30_000 }
      )
      // Past the hold that fills every tile at a place outside what they
      // had buffered: the tiles are playing in this test.
      await page.waitForFunction(
        `(() => ${GRID_VIDEOS}.every(v => !v.paused))()`,
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
        await page.evaluate(
          `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}) != null`
        ),
        `${what}: no ${label}`
      ).equals(false)

    // A drag along the bottom row of the block of videos: the playhead goes
    // where the finger is on the drawn line, with all controls visible.
    const span = Number(
      await page.evaluate(
        `document.querySelector('[aria-label="Position in the game"]').getAttribute('aria-valuemax')`
      )
    )
    const line = (await page.evaluate(
      `(() => { const r = document.querySelector('[aria-label="Position in the game"]').getBoundingClientRect(); return { x: r.left, w: r.width } })()`
    )) as { x: number; w: number }
    // Past the grid's opening hold, which on a loaded bench can still be
    // holding the tiles here: the drag is to leave them playing.
    await page.waitForFunction(
      `(() => ${GRID_VIDEOS}.every(v => !v.paused))()`,
      {
        timeout: 30_000
      }
    )
    const block = (await gridState(page)).tiles
    const blockTop = Math.min(...block.map(rect => rect.y))
    const blockBottom = Math.max(...block.map(rect => rect.y + rect.h))
    const row = blockBottom - (blockBottom - blockTop) * 0.08
    const before = await settle()
    // Reveal first so the following gesture is allowed to scrub.
    await m.tapOnPoint({
      x: Math.round(line.x + line.w * 0.5),
      y: Math.round(row),
      waitToSettleTimeoutMs: 0
    })
    // The drag, read while the finger is still moving: the bar fades in,
    // and the other controls with it.
    const dragging = m.dragAndDrop({
      from: { point: point(line.x + line.w * 0.5, row) },
      to: { point: point(line.x + line.w * 0.75, row) },
      holdDuration: 1,
      duration: 1200
    })
    await pause(600)
    const barUp = (await page.evaluate(
      `getComputedStyle(document.querySelector('[aria-label="Position in the game"]').closest('div[aria-hidden]')).opacity`
    )) as string
    const closeUp = (await page.evaluate(
      `getComputedStyle(document.querySelector('[aria-label="${lstrings.angles_close}"]').parentElement).opacity`
    )) as string
    await dragging
    const after = await settle()
    expect(Number(barUp), `${what}: the bar shows`).greaterThan(0)
    expect(Number(closeUp), `${what}: controls show together`).greaterThan(0)
    const landed = Number(
      await page.evaluate(
        `document.querySelector('[aria-label="Position in the game"]').getAttribute('aria-valuenow')`
      )
    )
    expect(landed, `${what}: lands three quarters along`).closeTo(
      span * 0.75,
      Math.max(2, span * 0.02)
    )
    const moved = after[0].t - before[0].t
    after.forEach((tile, index) => {
      expect(
        tile.t - before[index].t,
        `${what}: tile ${index} sought with the others`
      ).closeTo(moved, 1.5)
      expect(tile.paused, `${what}: play state kept`).equals(
        before[index].paused
      )
    })

    // Sideways across the pictures above the bottom row, nothing.
    const y = blockTop + (blockBottom - blockTop) * 0.5
    await m.dragAndDrop({
      from: { point: point(line.x + line.w * 0.4, y) },
      to: { point: point(line.x + line.w * 0.8, y) },
      holdDuration: 1,
      duration: 400
    })
    const still = await settle()
    expect(still[0].t, `${what}: a drag above the line does nothing`).closeTo(
      after[0].t,
      1.5
    )

    // Held still on the middle right: a crawl, shown until it is let go.
    const right = point(width * 0.9, blockTop + (blockBottom - blockTop) * 0.45)
    const holding = m.dragAndDrop({
      from: { point: right },
      to: { point: right },
      holdDuration: 1500,
      duration: 1
    })
    await pause(600)
    const crawling = await slowShown()
    await holding
    await pause(200)
    expect(crawling, `${what}: slow motion shows`).equals(true)
    expect(await slowShown(), `${what}: and goes`).equals(false)

    // Held still on a tile's left, it is picked up; dropped on the other,
    // the two swap.
    const rects = (await gridState(page)).tiles
    const [first, second] = rects
    await m.dragAndDrop({
      from: { point: point(first.x + first.w * 0.15, first.y + first.h * 0.4) },
      to: {
        point: point(second.x + second.w * 0.5, second.y + second.h * 0.5)
      },
      holdDuration: 600,
      duration: 400
    })
    await page.waitForFunction(
      `new URLSearchParams(location.search).get('angles') === ${JSON.stringify([S.videos[1], S.videos[0]].join(','))}`,
      { timeout: 10_000 }
    )

    if (!touch) {
      // Right, tapped: ten seconds on.
      const tapFrom = await settle()
      await m.pressKey({ key: 'right' })
      const tapped = await settle()
      expect(tapped[0].t - tapFrom[0].t, 'Right tapped').closeTo(10, 0.5)
    }
    await shot(web, `web-gestures-${what}-after.png`)
  }
}

async function rightHeld(): Promise<void> {
  // Right held for 700 ms crawls and skips nothing, and slow motion goes
  // when it is let go: maestro-d's web pressKey presses and lets go at once,
  // and holdOn (which holds a key) is not on the shared hubs yet.
  throw new BlockedError(
    'needs a key held down for 700 ms (maestro-d holdOn), which the shared hubs do not have yet'
  )
}

async function noHevc(ctx: HarnessContext): Promise<void> {
  const { pw, S } = await scoredGame(ctx)
  // Chrome without HEVC: Media Source says no to it alone; everything else
  // answers as Chrome does, `canPlayType` included.
  const web = await playerWeb(pw, 1280, 720, {
    observeNetwork: true,
    beforeLoad: `(() => {
      const supported = MediaSource.isTypeSupported.bind(MediaSource)
      MediaSource.isTypeSupported = type => !/hvc1|hev1/.test(type) && supported(type)
    })()`
  })
  const { page } = web
  const media: string[] = []
  page.on('request', request => {
    const url = request.url()
    if (/\.(m3u8|m4s|mp4|ts)(\?|$)/.test(url)) media.push(url)
  })
  await open(web, `/games/${S.id}?tab=watch&video=${S.videos[0]}`)
  await page.waitForFunction(
    `document.body.innerText.includes(${JSON.stringify(lstrings.video_not_supported)})`,
    { timeout: 30_000 }
  )
  expect(
    await page.evaluate(`document.querySelectorAll('#root video').length`)
  ).equals(0)
  await shot(web, 'web-unsupported-after.png')

  await open(web, gridPath(S, 2, 60))
  await page.waitForFunction(
    `(() => [...document.querySelectorAll('[data-tile-state]')].filter(tile => tile.getAttribute('data-tile-state') === 'unsupported').length === 2)()`,
    { timeout: 30_000 }
  )
  await pause(3000)
  expect(media, 'no media asked for').deep.equals([])
}

export default defineHarness({
  id: 'playback/player-layouts/web-player',
  title:
    'The one player lays out its angles, board and line score, follows the playhead, and answers its gestures in a browser',
  kind: 'e2e',
  covers: [
    'src/app/player/multiCam/**',
    'src/app/player/scoreboardOverlay/**',
    'src/app/player/MultiCamView.tsx',
    'src/app/player/PlayerSurface.tsx',
    'src/app/player/pressGrid.ts',
    'src/app/player/slowMotion.ts',
    'src/app/player/cardScrub.ts',
    'src/server/scoreboard/**'
  ],
  stack: 'isolated',
  fixtures: ['player-layouts'],
  exclusive: false,
  surfaces: {
    // The stack's recordings are HEVC: Chrome for Testing on the Mac.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 90,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'videos-page': videosPage,
    'grid-layout': gridLayout,
    'line-score': lineScore,
    'one-angle-player': oneAnglePlayer,
    'gestures-mouse': gestures(false),
    'gestures-touch': gestures(true),
    'right-held-crawls': rightHeld,
    'no-hevc': noHevc
  }
})
