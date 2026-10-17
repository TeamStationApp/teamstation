import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { BoardStep, GameDetail } from '../../../common/api'
import { wallAt } from '../../../common/wallTimeline'
import { serverConfig } from '../../../server/serverConfig'
import { tileRects } from '../multiCam/layout'
import { boardAt } from './boardAt'
import {
  api,
  APP,
  broadcast,
  browser,
  camera,
  dashboard,
  endCamera,
  GRID_VIDEOS,
  gridReady,
  gridState,
  iso,
  LONG_AWAY,
  markerGeometry,
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
  readMarkerSource,
  ready,
  scorer,
  seekReads,
  setUp,
  tearDown,
  until,
  unwrapMarker,
  type VideoTimeline,
  videoTimeline
} from './overlayRig.e2e'

/**
 * E8: the web players draw the game's board at the wall time of the frame on
 * screen, recorded and live. Real server, real RTMP from the fake
 * broadcaster, real FFmpeg, and a Chromium-family browser through maestro-d.
 *
 *   E8_BROWSER=<Chromium-family binary> MAESTRO_D=<daemon> \
 *   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *   [E8_BEFORE_APP=<the base build of the web app>] \
 *   [TS_E2E_ARTIFACT_DIR=<where the pictures go>] \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/player/scoreboardOverlay/overlay.e2e.ts
 *
 * Needs the API on this machine with live ingest (`npm start`, with a
 * `sessionSecret`), the fake Space when recordings go there
 * (`npm run fake-space`), and the web app built against the API
 * (`npm run start.web`). It makes its own administrator (`npm run seed`) and
 * two games (`npm run scoring-game`), G with scoring and H with none, with
 * passwords it draws and never prints.
 *
 * 1. Live, stamped: a stamped programme with a 20 s outage and a stamped
 *    angle are published into G while a scorer scores pitches (one undone,
 *    one held back 20 s and then sent) and the dashboard turns overrides on
 *    and off. The page plays the programme live and logs, for every frame
 *    presented, the wall clock burned into it and the board's `data-at`.
 *    Each change shows when the marker reads its time, within 0.25 s; the
 *    undo and the late post correct it. The live player stops at the outage,
 *    so the page is opened again after it; there the player shows the
 *    stream's first segments where the later ones belong, so after the break
 *    the board is judged against the player's own time for each frame, and
 *    the frames whose picture disagrees with it are counted as the player's
 *    (`KNOWN`). At the end the page asks for the recording's timeline whole
 *    and is still in step.
 *
 * The scorer is the app's own scoring session posting through the API, so
 * that a post can be held back an exact 20 s. `E8_FRAMES_DIR` keeps each
 * page's frame log as JSON.
 * 2. Live, unstamped, and a live grid: an unstamped angle and a stamped one
 *    of G, and two short angles of H. One page plays the unstamped angle (in
 *    step to within the measured publish latency and a segment), another the
 *    grid of both (one board, following the heard, master tile).
 * 3. Recorded, single picture at 1280x720 and 402x874: every change of
 *    board, ± 0.2 s, against the marker; where the node's default single
 *    setting puts it: 1% in from the picture's top-left, at most 15% of it tall.
 * 4. Recorded grid at 402x874 (one band above four stacked tiles) and at
 *    874x402 and 1280x720 (over the top-left tile by the landscape default, wider
 *    for long team names).
 * 5. H, with no scoring and no log: no board and no band.
 *
 * Every video and camera it made is deleted at the end; the games stay.
 */
const BEFORE_APP = process.env.E8_BEFORE_APP
onThisMachine(BEFORE_APP)
/** A change of board is on time when the marker reads within this of it. */
const ON_TIME_MS = 250
/** One frame of the fake broadcaster's 30 frames a second. */
const FRAME_MS = 1000 / 30
/** How long after a correction is sent the page may still show the old. */
const CORRECTION_MS = 1500

/**
 * Starts logging every frame the page's single player presents (or the
 * grid's tile at `gridIndex`): its own time, the low bits of the wall clock
 * burned into it, the board's `data-at`, and the page's clock.
 */
function frameLogger(gridIndex?: number): string {
  return `
    const readMarker = ${readMarkerSource()}
    const geometry = ${JSON.stringify(markerGeometry(720))}
    const v = ${gridIndex == null ? `document.querySelector('video')` : `${GRID_VIDEOS}[${gridIndex}]`}
    window.__e8 = { frames: [], stop: false }
    const log = (now, meta) => {
      if (window.__e8.stop) return
      const board = document.querySelector('[data-testid="scoreboard-overlay"]')
      window.__e8.frames.push([Date.now(), readMarker(v, geometry), board == null ? null : Number(board.getAttribute('data-at')), meta.mediaTime])
      v.requestVideoFrameCallback(log)
    }
    v.muted = true
    v.play().catch(() => undefined)
    v.requestVideoFrameCallback(log)
    return true
  `
}

interface Frame {
  now: number
  wall: number | null
  at: number | null
  mediaSec: number
}

async function frames(
  page: Page,
  nearMs: number,
  label: string
): Promise<Frame[]> {
  const raw = await probe<
    Array<[number, number | null, number | null, number]>
  >(page, `window.__e8.stop = true; return window.__e8.frames`)
  // Kept for a closer look, when asked for.
  const keep = process.env.E8_FRAMES_DIR
  if (keep != null)
    writeFileSync(join(keep, `${label}.json`), JSON.stringify(raw))
  return raw.map(([now, marker, at, mediaSec]) => ({
    now,
    wall: marker == null ? null : unwrapMarker(marker, nearMs),
    at,
    mediaSec
  }))
}

interface Correction {
  /** When it was sent, on this machine's clock. */
  sentAt: number
  /** Frames sent before then may show this step and later be corrected. */
  stepAt: number | null
  /** Or every frame from this wall time on, until it was sent. */
  fromWall?: number
}

/**
 * Judges a frame log against the board's final timeline: every frame shows
 * the step in effect at the wall clock burned into it, except within
 * `ON_TIME_MS` of a change and where a correction was still on its way.
 * Prints each change, with the marker of the first frame that showed it.
 */
function judgeLive(
  label: string,
  log: Frame[],
  steps: BoardStep[],
  corrections: Correction[],
  slackMs = ON_TIME_MS
): { checked: number; wrong: Frame[] } {
  const read = log.filter(frame => frame.wall != null)
  const wrong: Frame[] = []
  let checked = 0
  for (const frame of read) {
    const wall = frame.wall!
    const expected = boardAt(steps, wall)?.at ?? null
    if (frame.at === expected) {
      checked++
      continue
    }
    // Near a change, either side of it is on time.
    const near = steps.some(step => Math.abs(step.at - wall) <= slackMs)
    const pending = corrections.some(
      fix =>
        frame.now < fix.sentAt + CORRECTION_MS &&
        (frame.at === fix.stepAt ||
          (fix.fromWall != null && wall >= fix.fromWall - slackMs))
    )
    if (near || pending) continue
    wrong.push(frame)
  }
  console.log(`  ${label}: change   first frame showing it (marker − change)`)
  for (const step of steps) {
    const first = read.find(frame => frame.at === step.at)
    if (first == null) continue
    console.log(
      `    ${iso(step.at)}  ${(first.wall! - step.at).toFixed(0).padStart(6)} ms`
    )
  }
  return { checked, wrong }
}

describe('E8: the board over the web players, at the frame’s wall time', function () {
  let gameG = ''
  let gameH = ''
  /** The videos the live runs leave recorded. */
  const recorded: Record<
    'programme' | 'angle' | 'unstamped' | 'stamped' | 'h1' | 'h2',
    string
  > = {
    programme: '',
    angle: '',
    unstamped: '',
    stamped: '',
    h1: '',
    h2: ''
  }
  let firstT0 = 0
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) failures.push(what)
  }

  before(async function () {
    ;[gameG, gameH] = await setUp({
      name: 'e8',
      browser: process.env.E8_BROWSER ?? 'chrome',
      games: 2
    })
    print('games', { G: gameG, H: gameH })
  })

  after(tearDown)

  it('4. live, stamped: in step through an undo, a late post, an outage and the end', async function () {
    const programme = await camera(gameG, 'E8 programme')
    const angle = await camera(gameG, 'E8 angle')
    recorded.programme = programme.videoId
    recorded.angle = angle.videoId
    const duration = 170
    const lead = 200
    const shows = [
      broadcast(programme.url, [
        '--stamped',
        '--duration',
        String(duration),
        '--outage',
        '90:20',
        '--lead',
        String(lead)
      ]),
      broadcast(angle.url, [
        '--stamped',
        '--duration',
        String(duration),
        '--lead',
        String(lead)
      ])
    ]
    const t0 = await shows[0].t0
    firstT0 = t0
    print('T0', iso(t0))
    const session = await scorer(gameG)
    const desk = await dashboard(gameG)
    const page = await browser('live', '1280x720')
    const at = async (sec: number): Promise<void> => {
      await pause(t0 + sec * 1000 - Date.now())
    }

    await at(8)
    await page.openBrowser({
      url: `${APP}/games/${gameG}?video=${programme.videoId}`
    })
    await until(page, PICTURE_READY, 'the live programme showed a picture')
    await probe(page, frameLogger())
    print('logging every frame the page presents')

    const corrections: Correction[] = []
    await at(15)
    pitch(session, 'B')
    await session.flush()
    await at(25)
    pitch(session, 'C')
    await session.flush()
    await at(35)
    desk.send(JSON.stringify({ type: 'overrides', data: overrides(true) }))
    print('dashboard: count and long team names on')
    await at(45)
    desk.send(JSON.stringify({ type: 'overrides', data: overrides(false) }))
    print('dashboard: off')
    await at(55)
    const undone = pitch(session, 'F')
    await session.flush()
    await at(75)
    session.undo()
    await session.flush()
    corrections.push({ sentAt: Date.now(), stepAt: null, fromWall: undone })
    print('undid the foul from', iso(undone))
    await at(85)
    pitch(session, 'B')
    await session.flush()
    // The live player stops at an outage and does not pick the stream up
    // again: the publisher's going closes the live playlist (ENDLIST) until
    // it comes back, and a player that has read a closed playlist stops
    // asking. That is the player's and the ingest's, not the board's, so the
    // page is opened again after the break, as a viewer would, and judged on.
    await at(112)
    const stalled = await probe<{ at: number; ended: boolean; end: number }>(
      page,
      `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended, end: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0 }`
    )
    print('the live player after the outage', stalled)
    const beforeBreak = await frames(page, t0, 'stamped-before-break')
    await page.openBrowser({
      url: `${APP}/games/${gameG}?video=${programme.videoId}`
    })
    await until(page, PICTURE_READY, 'the programme showed a picture again')
    // A moment for the player to settle where it starts.
    await pause(6000)
    await probe(page, frameLogger())
    print('opened again; logging every frame')
    await at(115)
    pitch(session, 'S')
    await session.flush()
    await at(120)
    const held = pitch(session, 'B')
    print('a ball, held back 20 s', iso(held))
    await at(140)
    await session.flush()
    corrections.push({ sentAt: Date.now(), stepAt: null, fromWall: held })
    print('sent the held ball')
    await at(150)
    pitch(session, 'C')
    await session.flush()
    desk.close(1000)

    const codes = await Promise.all(shows.map(async show => await show.done))
    check(
      codes.every(code => code === 0),
      `both streams published (${codes.join(', ')})`
    )
    const endedAt = Date.now()
    await endCamera(gameG, programme.videoId)
    await endCamera(gameG, angle.videoId)
    await ready(gameG, programme.videoId)
    await ready(gameG, angle.videoId)
    print('recorded')
    // The viewer is some seconds behind: let the page play out the end.
    await pause(15_000)
    const log = [
      ...beforeBreak,
      ...(await frames(page, t0, 'stamped-after-break'))
    ]
    const steps = (
      await api().scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
    ).steps
    print(
      'steps',
      steps.map(step => [iso(step.at), step.state.balls, step.state.strikes])
    )
    const vod = await videoTimeline(programme.videoId)
    check(!vod.live && vod.source === 'sei', 'the recording is sei')
    // Before the break, the board against the picture itself. After it the
    // page was opened again, and there the player places the stream's own
    // first segments where the ones after the break belong: the picture
    // disagrees with the player's own time for the frame. The board follows
    // the player's time, which is all a board can follow, so after the break
    // it is judged against that, and the player's fault is counted apart.
    const byFrame = (frames: Frame[]): Frame[] =>
      frames.map(frame => ({
        ...frame,
        wall: wallAt(vod.anchors, frame.mediaSec * 1000)
      }))
    const afterBreak = log.slice(beforeBreak.length)
    const misplaced = afterBreak.filter(
      frame =>
        frame.wall != null &&
        Math.abs(frame.wall - wallAt(vod.anchors, frame.mediaSec * 1000)!) >
          FRAME_MS
    )
    console.log(
      `KNOWN the reopened live player shows a picture away from its own time in ${misplaced.length} of ${afterBreak.length} frames (the player's, not the board's)`
    )
    const before = judgeLive(
      'stamped, before the break, against the picture',
      beforeBreak,
      steps,
      corrections
    )
    const afterJudged = judgeLive(
      'stamped, after the break, against the player’s time for the frame',
      byFrame(afterBreak),
      steps,
      corrections
    )
    const checked = before.checked + afterJudged.checked
    const wrong = [...before.wrong, ...afterJudged.wrong]
    for (const frame of wrong.slice(0, 10))
      print('out of step', {
        now: iso(frame.now),
        marker: iso(frame.wall!),
        frameSec: frame.mediaSec,
        showing: frame.at == null ? null : iso(frame.at),
        expected: boardAt(steps, frame.wall)?.at
      })
    check(
      checked > 1000 && wrong.length === 0,
      `stamped live: ${checked} frames in step, ${wrong.length} out`
    )
    const after = byFrame(afterBreak).filter(
      frame => frame.wall != null && frame.wall > t0 + 110_000
    )
    check(
      after.length > 300,
      `frames after the outage were judged (${after.length})`
    )
    // The session stamps an action a moment after `pitch` reads the clock.
    const was = (at: number | null, ms: number): boolean =>
      at != null && at >= ms && at <= ms + 100
    check(
      log.some(
        frame => was(frame.at, undone) && frame.now < corrections[0].sentAt
      ),
      'the board showed the foul before it was undone'
    )
    check(
      !log.some(
        frame =>
          was(frame.at, undone) &&
          frame.now > corrections[0].sentAt + CORRECTION_MS
      ),
      'the undone foul is gone from the board once the undo is sent'
    )
    check(
      log.some(
        frame => was(frame.at, held) && frame.now > corrections[1].sentAt
      ),
      'the held ball reached the board once it was sent'
    )
    // The stream's end: the page asked for the recording's timeline whole.
    const asked = await probe<string[]>(
      page,
      `return performance.getEntriesByType('resource').filter(e => e.name.includes('/wall-timeline') && !e.name.includes('afterMs') && performance.timeOrigin + e.startTime > ${endedAt}).map(e => e.name)`
    )
    check(
      asked.length > 0,
      `after the end, the page asked for the whole timeline again (${asked.length} times)`
    )
    // Still in step on the same page, at moments either side of the outage:
    // with the player's time for the frame on screen, for the reason above.
    const reads = await seekReads(page, vod, steps, [
      t0 + 30_000,
      t0 + 50_000,
      t0 + 125_000
    ])
    check(
      reads.length === 3 && reads.every(one => one.okByFrame),
      `after the end, still in step with the player at ${reads.length} seeks`
    )
    console.log(
      `KNOWN after the end the reopened live player's picture matched its own time at ${reads.filter(one => one.ok).length} of ${reads.length} seeks`
    )
    await page.detach()
  })

  it('5 and 6. live, unstamped, and a live grid of a stamped and an unstamped angle', async function () {
    const unstamped = await camera(gameG, 'E8 unstamped')
    const stamped = await camera(gameG, 'E8 stamped')
    const h1 = await camera(gameH, 'E8 H one')
    const h2 = await camera(gameH, 'E8 H two')
    recorded.unstamped = unstamped.videoId
    recorded.stamped = stamped.videoId
    recorded.h1 = h1.videoId
    recorded.h2 = h2.videoId
    const duration = 100
    const lead = 240
    const shows = [
      broadcast(unstamped.url, [
        '--duration',
        String(duration),
        '--lead',
        String(lead)
      ]),
      broadcast(stamped.url, [
        '--stamped',
        '--duration',
        String(duration),
        '--lead',
        String(lead)
      ]),
      broadcast(h1.url, [
        '--duration',
        '40',
        '--size',
        '640x360',
        '--lead',
        String(lead)
      ]),
      broadcast(h2.url, [
        '--duration',
        '40',
        '--size',
        '640x360',
        '--lead',
        String(lead)
      ])
    ]
    const t0 = await shows[0].t0
    print('T0', iso(t0))
    const session = await scorer(gameG)
    const single = await browser('unstamped', '1280x720')
    const grid = await browser('livegrid', '1280x720')
    const at = async (sec: number): Promise<void> => {
      await pause(t0 + sec * 1000 - Date.now())
    }
    await at(8)
    await single.openBrowser({
      url: `${APP}/games/${gameG}?video=${unstamped.videoId}`
    })
    await grid.openBrowser({
      url: `${APP}/games/${gameG}?angles=${unstamped.videoId},${stamped.videoId}&audio=${stamped.videoId}`
    })
    await until(single, PICTURE_READY, 'the unstamped angle showed a picture')
    await until(
      grid,
      gridReady(2),
      'both tiles of the live grid showed a picture'
    )
    await probe(single, frameLogger())
    // The heard tile is the master: the stamped one, second in the grid.
    await probe(grid, frameLogger(1))
    for (const sec of [20, 32, 44, 56, 68, 80]) {
      await at(sec)
      pitch(session, sec % 24 === 8 ? 'B' : 'C')
      await session.flush()
    }
    const counts = await probe<number>(
      grid,
      `return document.querySelectorAll('[data-testid="scoreboard-overlay"]').length`
    )
    check(counts === 1, `the live grid draws one board (${counts})`)
    const codes = await Promise.all(shows.map(async show => await show.done))
    check(
      codes.every(code => code === 0),
      `four streams published (${codes.join(', ')})`
    )
    const singleLog = await frames(single, t0, 'unstamped')
    const gridLog = await frames(grid, t0, 'live-grid')
    const steps = (
      await api().scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
    ).steps

    // Unstamped: the board follows the picture, out by no more than the
    // publish latency, measured as the timeline's lateness behind the
    // marker, and a segment.
    const live = await api().wallTimeline(unstamped.videoId)
    const lateness = singleLog
      .filter(frame => frame.wall != null)
      .map(frame => wallAt(live.anchors, frame.mediaSec * 1000)! - frame.wall!)
      .sort((a, b) => a - b)
    const latency = lateness[Math.floor(lateness.length / 2)] ?? 0
    const segmentMs = serverConfig.live.segmentSeconds * 1000
    print('unstamped: the timeline is behind the marker by (median)', {
      ms: latency
    })
    const unstampedJudged = judgeLive(
      'unstamped',
      singleLog,
      steps,
      [],
      Math.abs(latency) + segmentMs
    )
    check(
      unstampedJudged.checked > 500 && unstampedJudged.wrong.length === 0,
      `unstamped live: in step to within ${Math.abs(latency)} ms latency and a ${segmentMs} ms segment (${unstampedJudged.checked} frames, ${unstampedJudged.wrong.length} out)`
    )
    const gridJudged = judgeLive('live grid (master)', gridLog, steps, [])
    check(
      gridJudged.checked > 500 && gridJudged.wrong.length === 0,
      `live grid: the one board follows the master tile (${gridJudged.checked} frames, ${gridJudged.wrong.length} out)`
    )
    for (const one of [unstamped, stamped]) await endCamera(gameG, one.videoId)
    for (const one of [h1, h2]) await endCamera(gameH, one.videoId)
    for (const one of [unstamped, stamped]) await ready(gameG, one.videoId)
    for (const one of [h1, h2]) await ready(gameH, one.videoId)
    await single.detach()
    await grid.detach()
  })

  /** The board timeline of G and the programme's, recorded. */
  async function programmeTimelines(): Promise<{
    steps: BoardStep[]
    timeline: VideoTimeline
  }> {
    return {
      steps: (
        await api().scoreboardTimeline(gameG, { fromMs: firstT0 - 60_000 })
      ).steps,
      timeline: await videoTimeline(recorded.programme)
    }
  }

  /** The single programme at `t0 + 30 s`, paused, for a picture. */
  const SHOT_SEC = 30

  it("1. recorded, single picture: every change ± 0.2 s, where the node's default puts it", async function () {
    const { steps, timeline } = await programmeTimelines()
    // Every change made while the programme was recording, which is case 4's
    // schedule: each must be in the recording either side, so a seek that
    // lands outside it fails. The live runs after it change G's board too,
    // after the programme ends, where no seek of it can show them.
    const ends = wallAt(timeline.anchors, timeline.endMs)!
    const changes = steps.filter(
      step => step.at > firstT0 + 5000 && step.at + 200 < ends
    )
    print(
      `${changes.length} changes inside the programme, which ends at ${iso(ends)}; ${steps.filter(step => step.at + 200 >= ends).length} later ones are not in it`
    )
    for (const size of ['1280x720', '402x874']) {
      const page = await browser(`single-${size}`, size)
      await page.openBrowser({
        url: `${APP}/games/${gameG}?video=${recorded.programme}`
      })
      await until(
        page,
        PICTURE_READY,
        `the programme showed a picture at ${size}`
      )
      const reads = await seekReads(
        page,
        timeline,
        steps,
        changes.flatMap(step => [step.at - 200, step.at + 200])
      )
      check(
        reads.length === changes.length * 2 && reads.every(one => one.ok),
        `${size}: the board at ${reads.length} seeks either side of ${changes.length} changes is the step at the marker`
      )
      // Where it is: the node's default single setting, 1% in from the
      // picture's top-left, the full board 15% of its height (shorter with
      // nobody named).
      const placed = reads.filter(one => one.board != null)
      const fifth = placed.every(
        one =>
          one.board!.h <= 0.15 * one.video.h + 1 &&
          Math.abs(one.board!.y - (one.video.y + 0.01 * one.video.h)) <= 1 &&
          Math.abs(one.board!.x - (one.video.x + 0.01 * one.video.w)) <= 1
      )
      check(
        placed.length > 0 && fifth,
        `${size}: by the default single setting over a ${placed[0]?.video.w.toFixed(0)}x${placed[0]?.video.h.toFixed(0)} picture, to within 1 px (board ${placed[0]?.board?.w.toFixed(1)}x${placed[0]?.board?.h.toFixed(1)})`
      )
      if (size === '1280x720') {
        await seekReads(page, timeline, steps, [firstT0 + SHOT_SEC * 1000])
        await picture(page, 'web-programme-after.png')
      }
      await page.detach()
    }
  })

  /** Opens the recorded grid of G's four angles at `t0 + sec`, paused. */
  async function openGrid(
    app: string,
    page: Page,
    sec: number,
    gameId = gameG,
    angles = [
      recorded.programme,
      recorded.angle,
      recorded.unstamped,
      recorded.stamped
    ]
  ): Promise<void> {
    const game: GameDetail = await api().game(gameId)
    const starts = game.videos
      .filter(video => angles.includes(video.id))
      .map(video => Date.parse(video.startAt!))
    const fromMs = Math.min(...starts)
    const t = Math.max(1, Math.round((firstT0 + sec * 1000 - fromMs) / 1000))
    await page.openBrowser({
      url: `${app}/games/${gameId}?angles=${angles.join(',')}&audio=${angles[0]}&t=${t}`
    })
    await until(page, gridReady(angles.length), 'the grid showed a picture')
    // Stopped where it opened.
    await probe(
      page,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 1500)); return true`
    )
  }

  it('2 and 3. recorded grid: a band above four stacked tiles upright, the top-left tile sideways', async function () {
    const { steps, timeline } = await programmeTimelines()
    // Upright.
    const upright = await browser('grid-portrait', '402x874')
    await openGrid(APP, upright, SHOT_SEC)
    await layoutSettles()
    const portrait = await gridState(upright)
    check(
      portrait.boards.length === 1,
      `402x874: one board (${portrait.boards.length})`
    )
    const board = portrait.boards[0]
    const tiles = portrait.tiles.sort((a, b) => a.y - b.y)
    check(tiles.length === 4, `402x874: four tiles (${tiles.length})`)
    check(
      board != null &&
        tiles.every(tile => tile.y >= board.y + board.h - 0.5) &&
        board.h <= 0.15 * portrait.window.h + 0.5 &&
        tiles.every(
          (tile, i) =>
            i === 0 || tile.y >= tiles[i - 1].y + tiles[i - 1].h - 0.5
        ),
      `402x874: the band (${board?.h.toFixed(1)} px, at most 15% of ${portrait.window.h}) is above four stacked tiles, none overlapped`
    )
    const expectedAt = boardAt(
      steps,
      wallAt(timeline.anchors, portrait.masterSec * 1000)
    )?.at
    check(
      board != null && board.at === expectedAt,
      `402x874: the board is the step at the master tile's frame (${board == null ? '-' : iso(board.at)})`
    )
    await namesShow(upright, '402x874')
    await picture(upright, 'web-grid-portrait-after.png')
    await upright.detach()

    // Sideways, at two sizes, before and inside the long team names.
    for (const size of ['874x402', '1280x720']) {
      const page = await browser(`grid-${size}`, size)
      const widths: { long: number[]; short: number[] } = {
        long: [],
        short: []
      }
      // The grid opens to the whole second and plays on for a few seconds
      // before it is stopped, so moments either side of the ten seconds of
      // long names, and early in them, are tried until both have been shown.
      for (const sec of [SHOT_SEC, 40, 20, 38, 25, 36, 34, 42, 32]) {
        if (widths.long.length > 0 && widths.short.length > 0) break
        await openGrid(APP, page, sec)
        await layoutSettles()
        const state = await gridState(page)
        const [corner] = [...state.tiles].sort((a, b) =>
          a.y === b.y ? a.x - b.x : a.y - b.y
        )
        const over = state.boards[0]
        check(
          state.boards.length === 1 &&
            over != null &&
            over.h <= 0.15 * corner.h + 1 &&
            Math.abs(over.x - (corner.x + 8)) <= 1 &&
            Math.abs(over.y - (corner.y + 8)) <= 1,
          `${size} at +${sec} s: one board over the top-left tile, ${over?.h.toFixed(1)} px for a ${corner.h.toFixed(1)} px tile`
        )
        await namesShow(page, `${size} at +${sec} s`)
        const shown = steps.find(step => step.at === over?.at)
        const stopped = wallAt(timeline.anchors, state.masterSec * 1000)
        print(`${size} opened at +${sec} s`, {
          stoppedAt: stopped == null ? null : (stopped - firstT0) / 1000,
          board: over == null ? null : iso(over.at),
          longNames: shown?.state.awayTeam === LONG_AWAY
        })
        if (over != null && shown != null)
          widths[shown.state.awayTeam === LONG_AWAY ? 'long' : 'short'].push(
            over.w
          )
        if (size === '1280x720' && sec === SHOT_SEC)
          await picture(page, 'web-grid-landscape-after.png')
      }
      check(
        widths.long.length > 0 &&
          widths.short.length > 0 &&
          Math.min(...widths.long) > Math.max(...widths.short),
        `${size}: the long team names widen the board (${widths.short.map(w => w.toFixed(0)).join(', ')} px short, ${widths.long.map(w => w.toFixed(0)).join(', ')} px long)`
      )
      await page.detach()
    }
  })

  /**
   * Every angle's name shows, clear of the board, the heard one's with its
   * 🔊; and the heard one, the programme, is the top-left angle.
   */
  async function namesShow(page: Page, label: string): Promise<void> {
    const chips = await nameChips(page, [
      'E8 programme',
      'E8 angle',
      'E8 unstamped',
      'E8 stamped'
    ])
    const { tiles } = await gridState(page)
    const [corner] = [...tiles].sort((a, b) =>
      a.y === b.y ? a.x - b.x : a.y - b.y
    )
    const inCorner = chips.filter(
      chip =>
        corner != null &&
        chip.x + chip.w / 2 >= corner.x &&
        chip.x + chip.w / 2 <= corner.x + corner.w &&
        chip.y + chip.h / 2 >= corner.y &&
        chip.y + chip.h / 2 <= corner.y + corner.h
    )
    check(
      chips.length === 4 &&
        chips.every(chip => !chip.covered) &&
        chips.filter(chip => chip.text.startsWith('🔊')).length === 1 &&
        inCorner.length === 1 &&
        inCorner[0].text === '🔊 E8 programme',
      `${label}: every angle's name shows clear of the board, the top-left one heard (${chips.map(chip => `${chip.text} at ${chip.x.toFixed(0)},${chip.y.toFixed(0)}${chip.covered ? ' COVERED' : ''}`).join(', ')})`
    )
  }

  /** A moment for the board to be measured and placed after a load. */
  async function layoutSettles(): Promise<void> {
    await pause(1500)
  }

  it('7. a game with no scoring and no log: no board, and no band', async function () {
    const page = await browser('none-single', '1280x720')
    await page.openBrowser({
      url: `${APP}/games/${gameH}?video=${recorded.h1}`
    })
    await until(page, PICTURE_READY, 'H showed a picture')
    await pause(3000)
    const drawn = await probe<number>(
      page,
      `return document.querySelectorAll('[data-scoreboard="board"]').length`
    )
    check(drawn === 0, `H single: no board at all (${drawn})`)
    await page.detach()

    const upright = await browser('none-grid', '402x874')
    await upright.openBrowser({
      url: `${APP}/games/${gameH}?angles=${recorded.h1},${recorded.h2}&audio=${recorded.h1}`
    })
    await until(upright, gridReady(2), 'the grid of H showed a picture')
    await pause(3000)
    const state = await gridState(upright)
    const expected = tileRects({
      width: state.window.w,
      height: state.window.h,
      count: 2
    })
    const tops = state.tiles.map(tile => tile.y).sort((a, b) => a - b)
    check(
      state.boards.length === 0 && Math.abs(tops[0] - expected[0].y) <= 1,
      `H grid: no board, and the first tile where it is with no band (${tops[0]?.toFixed(1)} px, expected ${expected[0].y.toFixed(1)})`
    )
    await upright.detach()
  })

  it('the before pictures, on the base build, at the same moments', async function () {
    if (BEFORE_APP == null) this.skip()
    const { steps, timeline } = await programmeTimelines()
    const single = await browser('before-single', '1280x720', BEFORE_APP)
    await single.openBrowser({
      url: `${BEFORE_APP}/games/${gameG}?video=${recorded.programme}`
    })
    await until(single, PICTURE_READY, 'the base build showed the programme')
    await seekReads(single, timeline, steps, [firstT0 + SHOT_SEC * 1000])
    await picture(single, 'web-programme-before.png')
    await single.detach()
    const upright = await browser('before-portrait', '402x874', BEFORE_APP)
    await openGrid(BEFORE_APP, upright, SHOT_SEC)
    await layoutSettles()
    await picture(upright, 'web-grid-portrait-before.png')
    await upright.detach()
    const sideways = await browser('before-landscape', '1280x720', BEFORE_APP)
    await openGrid(BEFORE_APP, sideways, SHOT_SEC)
    await layoutSettles()
    await picture(sideways, 'web-grid-landscape-before.png')
    await sideways.detach()
  })

  it('passes every check', function () {
    expect(failures, failures.join('\n')).deep.equals([])
  })
})
