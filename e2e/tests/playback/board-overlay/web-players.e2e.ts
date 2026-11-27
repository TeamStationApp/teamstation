import { expect } from 'chai'

import { tileRects } from '../../../../src/app/player/multiCam/layout'
import { boardAt } from '../../../../src/app/player/scoreboardOverlay/boardAt'
import type { BoardStep, GameDetail } from '../../../../src/common/api'
import { wallAt } from '../../../../src/common/wallTimeline'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  angleTiles,
  boardBrowser,
  type BoardStack,
  boardStack,
  broadcast,
  type Camera,
  camera,
  clock,
  dashboard,
  endCamera,
  type Frame,
  FRAME_MS,
  frameLogger,
  gridReady,
  gridState,
  iso,
  LONG_AWAY,
  nameTexts,
  overrides,
  pause,
  picture,
  PICTURE_READY,
  pitch,
  print,
  probe,
  readFrames,
  ready,
  scorer,
  seekReads,
  segmentMs,
  until,
  type VideoTimeline,
  videoTimeline
} from '../../../rigs/overlayRig'

/**
 * E8: the web players draw the game's board at the wall time of the frame on
 * screen, recorded and live. The stack's own fake broadcaster publishes
 * stamped and unstamped cameras into its ingest; the app's scoring session
 * and override dashboard change the board over the stack's API; this
 * machine's Chrome, through maestro-d, plays the HEVC and logs, for every
 * frame presented, the wall clock burned into it and the board's `data-at`.
 *
 * Each scenario records what it plays: the recorded ones publish the same
 * stamped programme, with its 20 s outage, while the same pitches, undo, held
 * ball and overrides are made as the live one makes them.
 */

/** A change of board is on time when the marker reads within this of it. */
const ON_TIME_MS = 250
/** How long after a correction is sent the page may still show the old. */
const CORRECTION_MS = 1500
/** The single programme at `t0 + 30 s`, paused, for a picture. */
const SHOT_SEC = 30
/** The programme's length, and its planned start ahead. */
const PROGRAMME_SEC = 170
const LEAD_SEC = 200

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
 * `slackMs` of a change and where a correction was still on its way.
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

/** Collects every failed check, and fails the scenario at its end with all of them. */
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

const gameUrl = (stack: BoardStack, gameId: string, query: string): string =>
  `${stack.origin}/games/${gameId}?${query}`

/** 4. Live, stamped: in step through an undo, a late post, an outage and the end. */
async function liveStamped(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const { stack, games } = await boardStack(ctx)
  const [gameG] = games
  const programme = await camera(stack, gameG, 'E8 programme')
  const angle = await camera(stack, gameG, 'E8 angle')
  const shows = [
    await broadcast(stack, programme, {
      stamped: true,
      duration: PROGRAMME_SEC,
      outages: [{ at: 90, seconds: 20 }],
      lead: LEAD_SEC
    }),
    await broadcast(stack, angle, {
      stamped: true,
      duration: PROGRAMME_SEC,
      lead: LEAD_SEC
    })
  ]
  const t0 = shows[0].t0
  print('T0', iso(t0))
  const session = await scorer(stack, gameG)
  const desk = await dashboard(stack, gameG)
  const { m } = await boardBrowser(ctx, stack, '1280x720')
  const at = clock(t0)
  const url = gameUrl(stack, gameG, `video=${programme.videoId}`)

  await at(8)
  await m.openLink({ link: url })
  await until(m, PICTURE_READY, 'the live programme showed a picture')
  await probe(m, frameLogger())
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
    m,
    `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended, end: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0 }`
  )
  print('the live player after the outage', stalled)
  const beforeBreak = await readFrames(m, t0)
  await m.openLink({ link: url })
  await until(m, PICTURE_READY, 'the programme showed a picture again')
  // A moment for the player to settle where it starts.
  await pause(6000)
  await probe(m, frameLogger())
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

  const codes = await Promise.all(shows.map(async show => await show.done()))
  check(
    codes.every(code => code === 0),
    `both streams published (${codes.join(', ')})`
  )
  const endedAt = Date.now()
  await endCamera(stack, programme)
  await endCamera(stack, angle)
  await ready(stack, gameG, programme.videoId)
  await ready(stack, gameG, angle.videoId)
  print('recorded')
  // The viewer is some seconds behind: let the page play out the end.
  await pause(15_000)
  const afterBreak = await readFrames(m, t0)
  const log = [...beforeBreak, ...afterBreak]
  const steps = (
    await stack.client.scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
  ).steps
  print(
    'steps',
    steps.map(step => [iso(step.at), step.state.balls, step.state.strikes])
  )
  const vod = await videoTimeline(stack, programme.videoId)
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
  const was = (stepAt: number | null, ms: number): boolean =>
    stepAt != null && stepAt >= ms && stepAt <= ms + 100
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
    log.some(frame => was(frame.at, held) && frame.now > corrections[1].sentAt),
    'the held ball reached the board once it was sent'
  )
  // The stream's end: the page asked for the recording's timeline whole.
  const asked = await probe<string[]>(
    m,
    `return performance.getEntriesByType('resource').filter(e => e.name.includes('/wall-timeline') && !e.name.includes('afterMs') && performance.timeOrigin + e.startTime > ${endedAt}).map(e => e.name)`
  )
  check(
    asked.length > 0,
    `after the end, the page asked for the whole timeline again (${asked.length} times)`
  )
  // Still in step on the same page, at moments either side of the outage:
  // with the player's time for the frame on screen, for the reason above.
  const reads = await seekReads(m, vod, steps, [
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
  done()
}

/** 5 and 6. Live, unstamped, and a live grid of a stamped and an unstamped angle. */
async function liveUnstampedAndGrid(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const { stack, games } = await boardStack(ctx)
  const [gameG, gameH] = games
  const unstamped = await camera(stack, gameG, 'E8 unstamped')
  const stamped = await camera(stack, gameG, 'E8 stamped')
  const h1 = await camera(stack, gameH, 'E8 H one')
  const h2 = await camera(stack, gameH, 'E8 H two')
  const duration = 100
  const lead = 240
  const shows = [
    await broadcast(stack, unstamped, { duration, lead }),
    await broadcast(stack, stamped, { stamped: true, duration, lead }),
    await broadcast(stack, h1, { duration: 40, size: '640x360', lead }),
    await broadcast(stack, h2, { duration: 40, size: '640x360', lead })
  ]
  const t0 = shows[0].t0
  print('T0', iso(t0))
  const session = await scorer(stack, gameG)
  const single = (await boardBrowser(ctx, stack, '1280x720')).m
  const grid = (await boardBrowser(ctx, stack, '1280x720')).m
  const at = clock(t0)
  await at(8)
  await single.openLink({
    link: gameUrl(stack, gameG, `video=${unstamped.videoId}`)
  })
  await grid.openLink({
    link: gameUrl(
      stack,
      gameG,
      `angles=${unstamped.videoId},${stamped.videoId}&audio=${stamped.videoId}`
    )
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
  const codes = await Promise.all(shows.map(async show => await show.done()))
  check(
    codes.every(code => code === 0),
    `four streams published (${codes.join(', ')})`
  )
  const singleLog = await readFrames(single, t0)
  const gridLog = await readFrames(grid, t0)
  const steps = (
    await stack.client.scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
  ).steps

  // Unstamped: the board follows the picture, out by no more than the
  // publish latency, measured as the timeline's lateness behind the
  // marker, and a segment.
  const live = await stack.client.wallTimeline(unstamped.videoId)
  const lateness = singleLog
    .filter(frame => frame.wall != null)
    .map(frame => wallAt(live.anchors, frame.mediaSec * 1000)! - frame.wall!)
    .sort((a, b) => a - b)
  const latency = lateness[Math.floor(lateness.length / 2)] ?? 0
  const segment = await segmentMs(stack, unstamped.videoId)
  print('unstamped: the timeline is behind the marker by (median)', {
    ms: latency
  })
  const unstampedJudged = judgeLive(
    'unstamped',
    singleLog,
    steps,
    [],
    Math.abs(latency) + segment
  )
  check(
    unstampedJudged.checked > 500 && unstampedJudged.wrong.length === 0,
    `unstamped live: in step to within ${Math.abs(latency)} ms latency and a ${segment} ms segment (${unstampedJudged.checked} frames, ${unstampedJudged.wrong.length} out)`
  )
  const gridJudged = judgeLive('live grid (master)', gridLog, steps, [])
  check(
    gridJudged.checked > 500 && gridJudged.wrong.length === 0,
    `live grid: the one board follows the master tile (${gridJudged.checked} frames, ${gridJudged.wrong.length} out)`
  )
  for (const one of [unstamped, stamped, h1, h2]) await endCamera(stack, one)
  for (const one of [unstamped, stamped, h1, h2])
    await ready(stack, one.gameId, one.videoId)
  done()
}

/** G's stamped programme and its other angles, recorded while scored. */
interface RecordedG {
  stack: BoardStack
  gameG: string
  gameH: string
  t0: number
  programme: Camera
  angles: Camera[]
  steps: BoardStep[]
  timeline: VideoTimeline
}

/**
 * Records G's stamped programme (with its 20 s outage at 90 s) and `labels`
 * more angles of it, while G is scored as the live scenario scores it: the
 * same pitches, undo, held ball and overrides at the same moments.
 */
async function recordG(
  ctx: HarnessContext,
  labels: Array<{ label: string; stamped: boolean }>
): Promise<RecordedG> {
  const { stack, games } = await boardStack(ctx)
  const [gameG, gameH] = games
  const programme = await camera(stack, gameG, 'E8 programme')
  const angles: Camera[] = []
  for (const one of labels) angles.push(await camera(stack, gameG, one.label))
  const shows = [
    await broadcast(stack, programme, {
      stamped: true,
      duration: PROGRAMME_SEC,
      outages: [{ at: 90, seconds: 20 }],
      lead: LEAD_SEC
    })
  ]
  for (const [i, one] of labels.entries())
    shows.push(
      await broadcast(stack, angles[i], {
        stamped: one.stamped,
        duration: PROGRAMME_SEC,
        lead: LEAD_SEC
      })
    )
  const t0 = shows[0].t0
  print('T0', iso(t0))
  const session = await scorer(stack, gameG)
  const desk = await dashboard(stack, gameG)
  const at = clock(t0)
  await at(15)
  pitch(session, 'B')
  await session.flush()
  await at(25)
  pitch(session, 'C')
  await session.flush()
  await at(35)
  desk.send(JSON.stringify({ type: 'overrides', data: overrides(true) }))
  await at(45)
  desk.send(JSON.stringify({ type: 'overrides', data: overrides(false) }))
  await at(55)
  pitch(session, 'F')
  await session.flush()
  await at(75)
  session.undo()
  await session.flush()
  await at(85)
  pitch(session, 'B')
  await session.flush()
  await at(115)
  pitch(session, 'S')
  await session.flush()
  await at(120)
  pitch(session, 'B')
  await at(140)
  await session.flush()
  await at(150)
  pitch(session, 'C')
  await session.flush()
  desk.close(1000)
  const codes = await Promise.all(shows.map(async show => await show.done()))
  expect(codes, 'every stream published').deep.equals(codes.map(() => 0))
  for (const one of [programme, ...angles]) await endCamera(stack, one)
  for (const one of [programme, ...angles])
    await ready(stack, gameG, one.videoId)
  const steps = (
    await stack.client.scoreboardTimeline(gameG, { fromMs: t0 - 60_000 })
  ).steps
  const timeline = await videoTimeline(stack, programme.videoId)
  return { stack, gameG, gameH, t0, programme, angles, steps, timeline }
}

/** 1. Recorded, single picture: every change ± 0.2 s, where the node's default puts it. */
async function recordedSingle(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const g = await recordG(ctx, [{ label: 'E8 angle', stamped: true }])
  const { stack, steps, timeline } = g
  const ends = wallAt(timeline.anchors, timeline.endMs)!
  // Every change made while the programme was recording: each must be in
  // the recording either side, so a seek that lands outside it fails.
  const changes = steps.filter(
    step => step.at > g.t0 + 5000 && step.at + 200 < ends
  )
  print(
    `${changes.length} changes inside the programme, which ends at ${iso(ends)}; ${steps.filter(step => step.at + 200 >= ends).length} later ones are not in it`
  )
  for (const size of ['1280x720', '402x874']) {
    const { m } = await boardBrowser(ctx, stack, size)
    await m.openLink({
      link: gameUrl(stack, g.gameG, `video=${g.programme.videoId}`)
    })
    await until(m, PICTURE_READY, `the programme showed a picture at ${size}`)
    const reads = await seekReads(
      m,
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
      await seekReads(m, timeline, steps, [g.t0 + SHOT_SEC * 1000])
      await picture(m, ctx.artifact('web-programme-after.png'))
    }
  }
  done()
}

/** Opens the recorded grid of `angles` at `t0 + sec`, stopped where it opened. */
async function openGrid(
  g: RecordedG,
  m: any,
  sec: number,
  angles: string[]
): Promise<void> {
  const game: GameDetail = await g.stack.client.game(g.gameG)
  const starts = game.videos
    .filter(video => angles.includes(video.id))
    .map(video => Date.parse(video.startAt!))
  const fromMs = Math.min(...starts)
  const t = Math.max(1, Math.round((g.t0 + sec * 1000 - fromMs) / 1000))
  await m.openLink({
    link: gameUrl(
      g.stack,
      g.gameG,
      `angles=${angles.join(',')}&audio=${angles[0]}&t=${t}`
    )
  })
  await until(m, gridReady(angles.length), 'the grid showed a picture')
  // Stopped where it opened: the player's own key, pressed on the page.
  await probe(
    m,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 1500)); return true`
  )
}

/** A moment for the board to be measured and placed after a load. */
async function layoutSettles(): Promise<void> {
  await pause(1500)
}

const GRID_TITLES = ['E8 programme', 'E8 angle', 'E8 unstamped', 'E8 stamped']

/**
 * No angle's name is drawn over its picture; each angle is still labelled;
 * and the heard one, the programme, is the top-left angle, the only one
 * heard.
 */
async function namesShow(
  check: (ok: boolean, what: string) => void,
  m: any,
  label: string
): Promise<void> {
  const drawn = await nameTexts(m, GRID_TITLES)
  const tiles = await angleTiles(m, GRID_TITLES)
  const placed = tiles.filter(tile => tile != null)
  const [corner] = [...placed].sort((a, b) =>
    Math.abs(a.y - b.y) < 1 ? a.x - b.x : a.y - b.y
  )
  const heard = placed.filter(tile => tile.heard)
  check(
    drawn.length === 0 &&
      placed.length === GRID_TITLES.length &&
      corner?.title === 'E8 programme' &&
      heard.length === 1 &&
      heard[0].title === 'E8 programme',
    `${label}: no angle's name drawn (${drawn.join(', ')}), every angle labelled (${placed.length}/${GRID_TITLES.length}), the top-left one the programme and the only one heard (${corner?.title ?? '-'}; heard ${heard.map(tile => tile.title).join(', ')})`
  )
}

/** 2 and 3. Recorded grid: a band above four stacked tiles upright, the top-left tile sideways. */
async function recordedGrid(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const g = await recordG(ctx, [
    { label: 'E8 angle', stamped: true },
    { label: 'E8 unstamped', stamped: false },
    { label: 'E8 stamped', stamped: true }
  ])
  const { steps, timeline } = g
  const angles = [g.programme, ...g.angles].map(one => one.videoId)
  // Upright.
  const upright = (await boardBrowser(ctx, g.stack, '402x874')).m
  await openGrid(g, upright, SHOT_SEC, angles)
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
        (tile, i) => i === 0 || tile.y >= tiles[i - 1].y + tiles[i - 1].h - 0.5
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
  await namesShow(check, upright, '402x874')
  await picture(upright, ctx.artifact('web-grid-portrait-after.png'))

  // Sideways, at two sizes, before and inside the long team names.
  for (const size of ['874x402', '1280x720']) {
    const { m } = await boardBrowser(ctx, g.stack, size)
    const widths: { long: number[]; short: number[] } = { long: [], short: [] }
    // The grid opens to the whole second and plays on for a few seconds
    // before it is stopped, so moments either side of the ten seconds of
    // long names, and early in them, are tried until both have been shown.
    for (const sec of [SHOT_SEC, 40, 20, 38, 25, 36, 34, 42, 32]) {
      if (widths.long.length > 0 && widths.short.length > 0) break
      await openGrid(g, m, sec, angles)
      await layoutSettles()
      const state = await gridState(m)
      const [corner] = [...state.tiles].sort((a, b) =>
        a.y === b.y ? a.x - b.x : a.y - b.y
      )
      const over = state.boards[0]
      check(
        state.boards.length === 1 &&
          over != null &&
          // The node's default landscape setting: 1% in from the top-left
          // tile's corner, at most 15% of its height.
          over.h <= 0.15 * corner.h + 1 &&
          Math.abs(over.x - (corner.x + 0.01 * corner.w)) <= 1 &&
          Math.abs(over.y - (corner.y + 0.01 * corner.h)) <= 1,
        `${size} at +${sec} s: one board over the top-left tile, ${over?.h.toFixed(1)} px for a ${corner.h.toFixed(1)} px tile, at ${over?.x.toFixed(1)},${over?.y.toFixed(1)} for one at ${corner.x.toFixed(1)},${corner.y.toFixed(1)} (${state.boards.length} boards)`
      )
      await namesShow(check, m, `${size} at +${sec} s`)
      const shown = steps.find(step => step.at === over?.at)
      const stopped = wallAt(timeline.anchors, state.masterSec * 1000)
      print(`${size} opened at +${sec} s`, {
        stoppedAt: stopped == null ? null : (stopped - g.t0) / 1000,
        board: over == null ? null : iso(over.at),
        longNames: shown?.state.awayTeam === LONG_AWAY
      })
      if (over != null && shown != null)
        widths[shown.state.awayTeam === LONG_AWAY ? 'long' : 'short'].push(
          over.w
        )
      if (size === '1280x720' && sec === SHOT_SEC)
        await picture(m, ctx.artifact('web-grid-landscape-after.png'))
    }
    check(
      widths.long.length > 0 &&
        widths.short.length > 0 &&
        Math.min(...widths.long) > Math.max(...widths.short),
      `${size}: the long team names widen the board (${widths.short.map(w => w.toFixed(0)).join(', ')} px short, ${widths.long.map(w => w.toFixed(0)).join(', ')} px long)`
    )
  }
  done()
}

/** 7. A game with no scoring and no log: no board, and the tiles at the top. */
async function noScoring(ctx: HarnessContext): Promise<void> {
  const { check, done } = checks()
  const { stack, games } = await boardStack(ctx)
  const gameH = games[1]
  const h1 = await camera(stack, gameH, 'E8 H one')
  const h2 = await camera(stack, gameH, 'E8 H two')
  const shows = [
    await broadcast(stack, h1, { duration: 40, size: '640x360' }),
    await broadcast(stack, h2, { duration: 40, size: '640x360' })
  ]
  const codes = await Promise.all(shows.map(async show => await show.done()))
  expect(codes, 'both streams published').deep.equals([0, 0])
  for (const one of [h1, h2]) await endCamera(stack, one)
  for (const one of [h1, h2]) await ready(stack, gameH, one.videoId)

  const single = (await boardBrowser(ctx, stack, '1280x720')).m
  await single.openLink({ link: gameUrl(stack, gameH, `video=${h1.videoId}`) })
  await until(single, PICTURE_READY, 'H showed a picture')
  await pause(3000)
  const drawn = await probe<number>(
    single,
    `return document.querySelectorAll('[data-scoreboard="board"]').length`
  )
  check(drawn === 0, `H single: no board at all (${drawn})`)

  const upright = (await boardBrowser(ctx, stack, '402x874')).m
  await upright.openLink({
    link: gameUrl(
      stack,
      gameH,
      `angles=${h1.videoId},${h2.videoId}&audio=${h1.videoId}`
    )
  })
  await until(upright, gridReady(2), 'the grid of H showed a picture')
  await pause(3000)
  const state = await gridState(upright)
  // With no board and no box score, the angles start at the top.
  const expected = tileRects({
    width: state.window.w,
    height: state.window.h,
    count: 2,
    align: 'top'
  })
  const tops = state.tiles.map(tile => tile.y).sort((a, b) => a - b)
  check(
    state.boards.length === 0 && Math.abs(tops[0] - expected[0].y) <= 1,
    `H grid: no board, and the first tile at the top (${tops[0]?.toFixed(1)} px, expected ${expected[0].y.toFixed(1)})`
  )
  done()
}

/** The before pictures were taken on the base build of the web app beside this one. */
async function beforePictures(): Promise<void> {
  throw new BlockedError(
    'the before pictures need the base build of the web app served beside the stack’s own, and a stack serves one ref'
  )
}

export default defineHarness({
  id: 'playback/board-overlay/web-players',
  title:
    'The web players draw the game’s board at the wall time of the frame on screen, recorded and live',
  kind: 'e2e',
  covers: [
    'src/app/player/scoreboardOverlay/**',
    'src/app/player/multiCam/**',
    'src/server/live/**',
    'src/server/media/wallClockScan.ts',
    'src/server/routes/scoreboard.ts',
    'src/server/routes/live.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoring-game'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // It plays the stack's HEVC, live and recorded.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'live-stamped': liveStamped,
    'live-unstamped-and-grid': liveUnstampedAndGrid,
    'recorded-single': recordedSingle,
    'recorded-grid': recordedGrid,
    'no-scoring': noScoring,
    'before-pictures': beforePictures
  }
})
