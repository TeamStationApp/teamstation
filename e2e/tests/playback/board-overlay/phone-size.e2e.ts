import { expect } from 'chai'

import { lstrings } from '../../../../src/app/locales/strings'
import { boardAt } from '../../../../src/app/player/scoreboardOverlay/boardAt'
import type { BoardStep } from '../../../../src/common/api'
import { wallAt } from '../../../../src/common/wallTimeline'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  angleTiles,
  boardBrowser,
  type BoardStack,
  boardStack,
  broadcast,
  camera,
  clock,
  dashboard,
  endCamera,
  gridReady,
  gridState,
  iso,
  mediaAt,
  nameTexts,
  overrides,
  picture,
  PICTURE_READY,
  pitch,
  print,
  probe,
  ready,
  scorer,
  seekReads,
  until,
  type VideoTimeline,
  videoTimeline
} from '../../../rigs/overlayRig'

/**
 * E9: the phone's layout of the board, in this machine's Chrome at a
 * phone's size (no phone, tablet or simulator), at 402x874 and 874x402. Its
 * data is made as E8's is: G's stamped programme and a stamped angle,
 * published by the stack's fake broadcaster and recorded, while the app's
 * scoring session scores pitches and the override dashboard turns overrides
 * on and off.
 *
 * The native-only code (the board's gradient drawn with svg, its font and
 * the interpolated playhead) is held by its unit cases and the native type
 * check.
 */

const SIZES = ['402x874', '874x402']
/** How far past a change each seek lands: clear of the change itself. */
const AFTER_MS = 300
/** The single programme at `t0 + 25 s`, paused, for a picture. */
const SHOT_SEC = 25

/** The count the board shows, as it writes it. */
const countOf = (step: BoardStep): string =>
  `${step.state.balls}-${step.state.strikes}`

function checks(): {
  check: (ok: boolean, what: string) => void
  done: () => void
} {
  const failures: string[] = []
  return {
    check: (ok, what) => {
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
      if (!ok) failures.push(what)
    },
    done: () => {
      expect(failures, failures.join('\n')).deep.equals([])
    }
  }
}

interface Recorded {
  stack: BoardStack
  gameG: string
  t0: number
  programme: string
  steps: BoardStep[]
  timeline: VideoTimeline
}

/** Records a programme and an angle of G while it is scored. */
async function record(
  ctx: HarnessContext,
  check: (ok: boolean, what: string) => void
): Promise<Recorded> {
  const { stack, games } = await boardStack(ctx)
  const [gameG] = games
  const cameras = [
    await camera(stack, gameG, 'E9 programme'),
    await camera(stack, gameG, 'E9 angle')
  ]
  const shows = []
  for (const one of cameras)
    shows.push(await broadcast(stack, one, { stamped: true, duration: 60 }))
  const t0 = shows[0].t0
  print('T0', iso(t0))
  const session = await scorer(stack, gameG)
  const desk = await dashboard(stack, gameG)
  const at = clock(t0)
  await at(10)
  pitch(session, 'B')
  await session.flush()
  await at(20)
  pitch(session, 'C')
  await session.flush()
  await at(30)
  desk.send(JSON.stringify({ type: 'overrides', data: overrides(true) }))
  print('dashboard: count and long team names on')
  await at(38)
  desk.send(JSON.stringify({ type: 'overrides', data: overrides(false) }))
  print('dashboard: off')
  await at(46)
  pitch(session, 'B')
  await session.flush()
  desk.close(1000)
  const codes = await Promise.all(shows.map(async show => await show.done()))
  expect(codes, 'both streams published').deep.equals([0, 0])
  for (const one of cameras) await endCamera(stack, one)
  for (const one of cameras) await ready(stack, gameG, one.videoId)
  const steps = (
    await stack.client.scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
  ).steps
  const timeline = await videoTimeline(stack, cameras[0].videoId)
  print(
    'steps',
    steps.map(step => [iso(step.at), countOf(step)])
  )
  check(timeline.source === 'sei', 'the programme is sei')
  return { stack, gameG, t0, programme: cameras[0].videoId, steps, timeline }
}

/** maestro-d sees the board, and the count `text` on it. */
async function boardShows(m: any, text: string): Promise<boolean> {
  try {
    await m.assertVisible({
      testId: 'scoreboard-overlay',
      containsDescendants: [{ text }],
      timeout: 5000
    })
    return true
  } catch (error) {
    print('not visible', { text, error: String(error) })
    return false
  }
}

/** 1. Single picture: each change is on the board, with its count. */
async function singlePicture(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const g = await record(ctx, check)
  const { steps, timeline } = g
  // Every change the recording holds, from the board in effect when it
  // starts.
  const changes = steps.filter(
    step =>
      mediaAt(timeline.anchors, step.at + AFTER_MS, timeline.endMs) != null
  )
  check(changes.length >= 5, `${changes.length} changes inside the programme`)
  for (const size of SIZES) {
    const { m } = await boardBrowser(ctx, g.stack, size)
    await m.openLink({
      link: `${g.stack.origin}/games/${g.gameG}?video=${g.programme}`
    })
    await until(m, PICTURE_READY, `the programme showed a picture at ${size}`)
    for (const step of changes) {
      const read = (
        await seekReads(m, timeline, steps, [step.at + AFTER_MS])
      ).at(0)
      const shown = await boardShows(m, countOf(step))
      check(
        read?.ok === true && read.at === step.at && shown,
        `${size}: at ${iso(step.at + AFTER_MS)} the board is visible with ${countOf(step)}, the step at the marker (${read?.at == null ? '-' : iso(read.at)})`
      )
    }
    if (size === '402x874') {
      await seekReads(m, timeline, steps, [g.t0 + SHOT_SEC * 1000])
      await picture(m, ctx.artifact('phone-player-after.png'))
    }
  }
  done()
}

/** 2. Every angle: the board at the top upright, right of the middle above the angles sideways. */
async function everyAngle(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const g = await record(ctx, check)
  const { steps, timeline } = g
  for (const size of SIZES) {
    const { m } = await boardBrowser(ctx, g.stack, size)
    await m.openLink({
      link: `${g.stack.origin}/games/${g.gameG}?video=${g.programme}`
    })
    await until(m, PICTURE_READY, `the programme showed a picture at ${size}`)
    // As a viewer opens it: the angles, then the picker's Watch.
    await m.tapOn({ text: lstrings.angles_open, timeout: 15_000 })
    await m.tapOn({ text: lstrings.angles_watch, timeout: 15_000 })
    await until(m, gridReady(2), `the grid showed both angles at ${size}`)
    // Twenty seconds on, and stopped there: the grid opens on the
    // recording's first frame, which is before the first pitch, and there
    // the board has no step to be judged by. The keys go to the page's body,
    // as a key pressed on it does, down and up: Right skips as it comes up.
    await probe(
      m,
      `const key = name => { for (const type of ['keydown', 'keyup']) document.body.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true })) }; const wait = ms => new Promise(resolve => setTimeout(resolve, ms)); key('ArrowRight'); await wait(500); key('ArrowRight'); await wait(500); const master = [...document.querySelectorAll('video')].filter(video => video.closest('#root') == null)[0]; if (master != null && !master.paused) key('k'); await wait(1500); return true`
    )
    try {
      await until(
        m,
        `return document.querySelectorAll('[data-testid="scoreboard-overlay"]').length > 0`,
        `the grid drew its board at ${size}`,
        20_000
      )
    } catch (error) {
      print(
        'the grid without a board',
        await probe(
          m,
          `return { url: location.pathname, boards: document.querySelectorAll('[data-scoreboard="board"]').length, asked: performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('timeline')).length }`
        )
      )
      throw error
    }
    const state = await gridState(m)
    const masterWall = wallAt(timeline.anchors, state.masterSec * 1000)
    const expected = boardAt(steps, masterWall)
    const board = state.boards[0]
    check(
      state.boards.length === 1,
      `${size}: one board over the grid (${state.boards.length})`
    )
    const shown =
      expected == null ? false : await boardShows(m, countOf(expected))
    check(
      shown && board?.at === expected?.at,
      `${size}: the board is visible with ${expected == null ? '-' : countOf(expected)}, the step at the master tile's frame (${board == null ? '-' : iso(board.at)})`
    )
    const tiles = [...state.tiles].sort((a, b) =>
      a.y === b.y ? a.x - b.x : a.y - b.y
    )
    if (size === '402x874') {
      check(
        board != null &&
          tiles.length === 2 &&
          tiles.every(tile => tile.y >= board.y + board.h - 0.5) &&
          Math.abs(board.w - (state.window.w - 16)) <= 1 &&
          tiles[1].y >= tiles[0].y + tiles[0].h - 0.5,
        `${size}: the board (${board?.w.toFixed(1)} px, the width less its insets, upright with two angles) is above the stacked angles, none overlapped`
      )
    } else {
      // Two angles on the bottom of the screen; the game is scored, so
      // the board runs right from just right of the middle and the box
      // score left from just left of it, both resting on the angles.
      const top = Math.min(...tiles.map(tile => tile.y))
      check(
        board != null &&
          tiles.every(
            tile => Math.abs(tile.y + tile.h - state.window.h) <= 1
          ) &&
          Math.abs(board.x - (state.window.w / 2 + 5)) <= 1 &&
          board.y + board.h <= top - 8 + 1,
        `${size}: the board right of the middle above the angles on the bottom, ${board?.x.toFixed(1)} px in, angles from ${top.toFixed(1)} px`
      )
    }
    // No angle's name drawn over the pictures; every angle still
    // labelled, and one of them heard.
    const titles = ['E9 programme', 'E9 angle']
    const drawn = await nameTexts(m, titles)
    const labelled = (await angleTiles(m, titles)).filter(tile => tile != null)
    const heard = labelled.filter(tile => tile.heard)
    check(
      drawn.length === 0 &&
        labelled.length === titles.length &&
        heard.length === 1,
      `${size}: no angle's name drawn (${drawn.join(', ')}), every angle labelled (${labelled.length}/${titles.length}), one heard (${heard.map(tile => tile.title).join(', ')})`
    )
  }
  done()
}

/** The before picture was taken on the base build of the web app beside this one. */
async function beforePicture(): Promise<void> {
  throw new BlockedError(
    'the before picture needs the base build of the web app served beside the stack’s own, and a stack serves one ref'
  )
}

export default defineHarness({
  id: 'playback/board-overlay/phone-size',
  title:
    'The board on a phone-size web player, single and every angle, upright and sideways',
  kind: 'e2e',
  covers: ['src/app/player/scoreboardOverlay/**', 'src/app/player/multiCam/**'],
  stack: 'isolated',
  fixtures: ['scoring-game'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // It plays the stack's HEVC recordings.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 12,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'single-picture': singlePicture,
    'every-angle': everyAngle,
    'before-picture': beforePicture
  }
})
