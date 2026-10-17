import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { BoardStep } from '../../../common/api'
import { wallAt } from '../../../common/wallTimeline'
import { lstrings } from '../../locales/strings'
import { boardAt } from './boardAt'
import {
  api,
  APP,
  broadcast,
  browser,
  camera,
  dashboard,
  endCamera,
  gridReady,
  gridState,
  iso,
  mediaAt,
  nameChips,
  onThisMachine,
  overrides,
  type Page,
  pause,
  picture,
  PICTURE_READY,
  pitch,
  print,
  probe,
  ready,
  scorer,
  seekReads,
  setUp,
  tearDown,
  until,
  type VideoTimeline,
  videoTimeline
} from './overlayRig.e2e'

/**
 * E9: the phone's layout of the board, in a browser at a phone's size (no
 * phone, tablet or simulator). Real server, real RTMP from the fake
 * broadcaster, real FFmpeg, and a Chromium-family browser through maestro-d,
 * at 402x874 and 874x402.
 *
 *   E9_BROWSER=<Chromium-family binary> MAESTRO_D=<daemon> \
 *   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *   [E9_BEFORE_APP=<the base build of the web app>] \
 *   [TS_E2E_ARTIFACT_DIR=<where the pictures go>] \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/scoreboardOverlay/overlayPhone.e2e.ts
 *
 * Needs what E8 needs (`overlay.e2e.ts`): the API on this machine with live
 * ingest, the fake Space when recordings go there, and the web app built
 * against the API. Its data is made as E8's is: a game G, a stamped
 * programme and a stamped angle of it published by the fake broadcaster and
 * recorded, while the app's scoring session scores pitches and the override
 * dashboard turns overrides on and off.
 *
 * 1. Single picture, at both sizes: G's programme is sought to just after
 *    each change of board, and the board is asserted visible with the count
 *    the change made, as the step in effect at the wall clock burned into
 *    the picture.
 * 2. "All angles", at both sizes, chosen from the game page as a viewer
 *    does: upright, one board in a band above the stacked angles; sideways,
 *    one board over the top-left angle by the landscape default. Each is the
 *    step at the master tile's frame.
 *
 * The native-only code (the board's gradient drawn with svg, its font and
 * the interpolated playhead) is held by its unit cases and the native type
 * check. Every video and camera it made is deleted at the end; the game
 * stays.
 */
const BEFORE_APP = process.env.E9_BEFORE_APP
onThisMachine(BEFORE_APP)
const SIZES = ['402x874', '874x402']
/** How far past a change each seek lands: clear of the change itself. */
const AFTER_MS = 300
/** The single programme at `t0 + 25 s`, paused, for a picture. */
const SHOT_SEC = 25

describe('E9: the board on a phone-size player, single and every angle', function () {
  let gameG = ''
  let programme = ''
  let angle = ''
  let t0 = 0
  let steps: BoardStep[] = []
  let timeline: VideoTimeline
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) failures.push(what)
  }

  before(async function () {
    ;[gameG] = await setUp({
      name: 'e9',
      browser: process.env.E9_BROWSER ?? 'chrome',
      games: 1
    })
    print('game', { G: gameG })
  })

  after(tearDown)

  /** The count the board shows, as it writes it. */
  const countOf = (step: BoardStep): string =>
    `${step.state.balls}-${step.state.strikes}`

  it('records a programme and an angle of G while it is scored', async function () {
    const cameras = [
      await camera(gameG, 'E9 programme'),
      await camera(gameG, 'E9 angle')
    ]
    programme = cameras[0].videoId
    angle = cameras[1].videoId
    const shows = cameras.map(one =>
      broadcast(one.url, ['--stamped', '--duration', '60'])
    )
    t0 = await shows[0].t0
    print('T0', iso(t0))
    const session = await scorer(gameG)
    const desk = await dashboard(gameG)
    const at = async (sec: number): Promise<void> => {
      await pause(t0 + sec * 1000 - Date.now())
    }
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
    const codes = await Promise.all(shows.map(async show => await show.done))
    expect(codes, 'both streams published').deep.equals([0, 0])
    for (const id of [programme, angle]) await endCamera(gameG, id)
    for (const id of [programme, angle]) await ready(gameG, id)
    steps = (await api().scoreboardTimeline(gameG, { fromMs: t0 - 60_000 }))
      .steps
    timeline = await videoTimeline(programme)
    print(
      'steps',
      steps.map(step => [iso(step.at), countOf(step)])
    )
    check(timeline.source === 'sei', 'the programme is sei')
  })

  it('1. single picture: each change is on the board, with its count', async function () {
    // Every change the recording holds, from the board in effect when it
    // starts.
    const changes = steps.filter(
      step =>
        mediaAt(timeline.anchors, step.at + AFTER_MS, timeline.endMs) != null
    )
    check(changes.length >= 5, `${changes.length} changes inside the programme`)
    for (const size of SIZES) {
      const page = await browser(`single-${size}`, size)
      await page.openBrowser({
        url: `${APP}/games/${gameG}?video=${programme}`
      })
      await until(
        page,
        PICTURE_READY,
        `the programme showed a picture at ${size}`
      )
      for (const step of changes) {
        const read = (
          await seekReads(page, timeline, steps, [step.at + AFTER_MS])
        ).at(0)
        const shown = await boardShows(page, countOf(step))
        check(
          read?.ok === true && read.at === step.at && shown,
          `${size}: at ${iso(step.at + AFTER_MS)} the board is visible with ${countOf(step)}, the step at the marker (${read?.at == null ? '-' : iso(read.at)})`
        )
      }
      if (size === '402x874') {
        await seekReads(page, timeline, steps, [t0 + SHOT_SEC * 1000])
        await picture(page, 'phone-player-after.png')
      }
      await page.detach()
    }
  })

  /** maestro-d sees the board, and the count `text` on it. */
  async function boardShows(page: Page, text: string): Promise<boolean> {
    try {
      await page.assertVisible({
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

  it('2. every angle: a band upright, the top-left angle sideways', async function () {
    for (const size of SIZES) {
      const page = await browser(`grid-${size}`, size)
      await page.openBrowser({
        url: `${APP}/games/${gameG}?video=${programme}`
      })
      await until(
        page,
        PICTURE_READY,
        `the programme showed a picture at ${size}`
      )
      // As a viewer opens it: the angles, then the picker's Watch.
      await page.tapOn({ text: lstrings.angles_open, timeout: 15_000 })
      await page.tapOn({ text: lstrings.angles_watch, timeout: 15_000 })
      await until(page, gridReady(2), `the grid showed both angles at ${size}`)
      // Stopped where it is, for the board to be read against it.
      await probe(
        page,
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 1500)); return true`
      )
      try {
        await until(
          page,
          `return document.querySelectorAll('[data-testid="scoreboard-overlay"]').length > 0`,
          `the grid drew its board at ${size}`,
          20_000
        )
      } catch (error) {
        print(
          'the grid without a board',
          await probe(
            page,
            `return { url: location.href, boards: document.querySelectorAll('[data-scoreboard="board"]').length, asked: performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('timeline')) }`
          )
        )
        throw error
      }
      const state = await gridState(page)
      const masterWall = wallAt(timeline.anchors, state.masterSec * 1000)
      const expected = boardAt(steps, masterWall)
      const board = state.boards[0]
      check(
        state.boards.length === 1,
        `${size}: one board over the grid (${state.boards.length})`
      )
      const shown =
        expected == null ? false : await boardShows(page, countOf(expected))
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
            board.h <= 0.15 * state.window.h + 0.5 &&
            tiles[1].y >= tiles[0].y + tiles[0].h - 0.5,
          `${size}: the band (${board?.h.toFixed(1)} px, at most 15% of ${state.window.h}) is above the stacked angles, none overlapped`
        )
      } else {
        const [corner] = tiles
        check(
          board != null &&
            board.h <= 0.15 * corner.h + 1 &&
            Math.abs(board.x - (corner.x + 8)) <= 1 &&
            Math.abs(board.y - (corner.y + 8)) <= 1,
          `${size}: over the top-left angle, ${board?.h.toFixed(1)} px for a ${corner.h.toFixed(1)} px angle`
        )
      }
      // Every angle's name shows clear of the board, the heard one's 🔊 too.
      const chips = await nameChips(page, ['E9 programme', 'E9 angle'])
      check(
        chips.length === 2 &&
          chips.every(chip => !chip.covered) &&
          chips.filter(chip => chip.text.startsWith('🔊')).length === 1,
        `${size}: every angle's name shows clear of the board (${chips.map(chip => `${chip.text}${chip.covered ? ' COVERED' : ''}`).join(', ')})`
      )
      await page.detach()
    }
  })

  it('the before picture, on the base build, at the same moment', async function () {
    if (BEFORE_APP == null) this.skip()
    const page = await browser('before-single', '402x874', BEFORE_APP)
    await page.openBrowser({
      url: `${BEFORE_APP}/games/${gameG}?video=${programme}`
    })
    await until(page, PICTURE_READY, 'the base build showed the programme')
    await seekReads(page, timeline, steps, [t0 + SHOT_SEC * 1000])
    await picture(page, 'phone-player-before.png')
    await page.detach()
  })

  it('passes every check', function () {
    expect(failures, failures.join('\n')).deep.equals([])
  })
})
