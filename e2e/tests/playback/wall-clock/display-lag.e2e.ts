import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { BoardStep } from '../../../../src/common/api'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  eachGrayFrame,
  frameTimes,
  type GrayFrame,
  recordScreen,
  videoSize
} from '../../../core/video'
import { markerGeometry, unwrapMarker } from '../../../rigs/media/readMarker'
import {
  boardBrowser,
  type BoardStack,
  boardStack,
  broadcast,
  camera,
  clock,
  dashboard,
  endCamera,
  FRAME_MS,
  frameLogger,
  GRID_VIDEOS,
  gridReady,
  iso,
  overrides,
  pause,
  PICTURE_READY,
  pitch,
  print,
  probe,
  readFrames,
  ready,
  scorer,
  until,
  videoTimeline
} from '../../../rigs/overlayRig'

/**
 * F1: the live board as a viewer saw it. This machine's Chrome plays a
 * game's live stream from the stack's fake broadcaster while a scorer and
 * the override dashboard change the board at known wall times, and
 * maestro-d records the page. The recording is then stepped frame by frame:
 * in each recorded frame the wall clock burned into the picture (bottom-left)
 * is read, and whether the board (top-left) has just changed. A change of
 * the board is placed by the marker in the same recorded frame, so the lag
 * is what a viewer saw, with nothing from inside the page. In step is the
 * board changing on the first picture that has reached the step: the frame
 * before the change shows a picture before the step plus one picture, and
 * the change's own picture is never before the step.
 *
 * sync: a stamped 10-minute stream with a 20 s outage at 300 s, pitches and
 *   overrides before and after it. The page is opened again after the
 *   outage when the live player has stopped.
 * grid: an unstamped and a stamped stream of one game. The unstamped angle
 *   alone for about 2 minutes, the live grid of both for about 2 minutes,
 *   then the unstamped angle again through the end and the switch to the
 *   recording.
 */

/** The page's size: a 1920x1080 display in full screen, under a browser's bars. */
const SCREEN = '1920x999'
/** How much a board's block must change between frames to count as a change. */
const THRESHOLD = 24

/** Covers every stream key that shows, again and again: the page re-renders. */
const COVER_KEYS = `
  const cover = () => {
    for (const box of document.querySelectorAll('[aria-label^="Copy the URL for"]')) {
      if (box.querySelector('[data-cover="stream-key"]') != null) continue
      const r = box.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
      const sheet = document.createElement('div')
      sheet.textContent = 'stream key hidden'
      sheet.dataset.cover = 'stream-key'
      Object.assign(sheet.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', background: '#e8ebe2', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '18px sans-serif', zIndex: 2147483647 })
      box.appendChild(sheet)
    }
  }
  cover()
  clearInterval(window.__f1cover)
  window.__f1cover = setInterval(cover, 200)
  return true
`

/**
 * Scrolls the single player's picture to the top of the window, so all of it
 * (the marker is at its bottom) is in the recording whatever the page above
 * it grows to. The grid is fixed over the page and needs none.
 */
const SCROLL_PICTURE = `
  const picture = document.querySelector('#root video')
  if (picture != null) {
    const box = picture.getBoundingClientRect()
    if (box.top < 0 || box.bottom > window.innerHeight - 4)
      picture.scrollIntoView({ block: 'start' })
  }
`

/** Where things are, in page pixels. */
const GEOMETRY = `
  const box = node => { if (node == null) return null; const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  const videos = [...document.querySelectorAll('video')]
  return {
    now: Date.now(),
    screen: { innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY },
    videos: videos.map(v => ({ ...box(v), videoW: v.videoWidth, videoH: v.videoHeight, inRoot: v.closest('#root') != null, t: v.currentTime })),
    boards: [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].map(node => ({ ...box(node), at: node.getAttribute('data-at') })),
    keys: [...document.querySelectorAll('[aria-label^="Copy the URL for"]')].map(box)
  }
`

interface Box {
  x: number
  y: number
  w: number
  h: number
}
interface Geometry {
  what: string
  now: number
  screen: { dpr: number; innerW: number; innerH: number }
  videos: Array<Box & { videoW: number; videoH: number; inRoot: boolean }>
  boards: Array<Box & { at: string | null }>
}

/** What a part records for its measurement. */
interface Part {
  t0: number
  actions: Array<{ at: number; what: string }>
  geometry: Geometry[]
  notes: string[]
  steps: BoardStep[]
}

function newPart(): Part {
  return { t0: 0, actions: [], geometry: [], notes: [], steps: [] }
}

function note(part: Part, what: string, detail?: unknown): void {
  print(what, detail)
  part.notes.push(
    `${new Date().toISOString()} ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`
  )
}

/** Opens `url`, waits for `ready`, and records where the page put things. */
async function open(
  part: Part,
  m: any,
  url: string,
  readyScript: string,
  what: string
): Promise<void> {
  await m.openLink({ link: url })
  await probe(m, COVER_KEYS)
  await until(m, readyScript, what)
  await probe(m, COVER_KEYS)
  await probe(m, `${SCROLL_PICTURE}; return true`)
  await pause(500)
  const geometry = await probe<Geometry>(m, GEOMETRY)
  part.geometry.push({ ...geometry, what })
  note(part, what, { videos: geometry.videos })
}

/**
 * Every 2 s while the page is recorded: the picture is kept whole at the top
 * of the window, and the API is asked whether it answers. Answers a function
 * that stops watching.
 */
function watchPage(part: Part, m: any, stack: BoardStack): () => void {
  const watching = { stopped: false }
  const looking = (async () => {
    while (!watching.stopped) {
      await pause(2000)
      if (watching.stopped) break
      try {
        await probe(m, `${SCROLL_PICTURE}; return true`)
      } catch (error: unknown) {
        note(part, 'could not look at the page', String(error))
      }
      try {
        const answer = await fetch(`${stack.api}/time`)
        if (!answer.ok) note(part, 'the API answered', answer.status)
      } catch (error: unknown) {
        note(part, 'the API does not answer', String(error))
      }
    }
  })()
  looking.catch(() => undefined)
  return () => {
    watching.stopped = true
  }
}

// ---- the measurement, over the recording ----------------------------------

/** Where, on the recording, the page's pixels are. */
interface Placement {
  dx: number
  dy: number
  /** Recording pixels per page pixel. */
  k: number
}

/** The picture inside a `<video>` box: contained, centred. */
function pictureOf(
  video: Box & { videoW: number; videoH: number },
  at: Placement
): Box & { s: number } {
  const w = video.videoW > 0 ? video.videoW : 1280
  const h = video.videoH > 0 ? video.videoH : 720
  const s = Math.min(video.w / w, video.h / h) * at.k
  const x = at.dx + video.x * at.k + (video.w * at.k - w * s) / 2
  const y = at.dy + video.y * at.k + (video.h * at.k - h * s) / 2
  return { x, y, w: w * s, h: h * s, s }
}

function mean(
  frame: GrayFrame,
  x: number,
  y: number,
  w: number,
  h: number
): number {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(frame.width, Math.max(x0 + 1, Math.round(x + w)))
  const y1 = Math.min(frame.height, Math.max(y0 + 1, Math.round(y + h)))
  let sum = 0
  let count = 0
  for (let row = y0; row < y1; row++) {
    const base = row * frame.width
    for (let col = x0; col < x1; col++) {
      sum += frame.data[base + col]
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

const MARKER = markerGeometry(720)

/** The marker's low 32 bits in a recorded frame, or null. */
function markerIn(
  frame: GrayFrame,
  picture: Box & { s: number }
): number | null {
  const { bits, originX, originY, stride, cell, sentinelSlot } = MARKER
  // The scale from the 1280x720 picture the marker was drawn on.
  const s = picture.w / 1280
  const half = (cell / 2) * s
  const slot = (n: number): number =>
    mean(
      frame,
      picture.x + (originX + n * stride + cell / 4) * s,
      picture.y + (originY + cell / 4) * s,
      half,
      half
    )
  if (slot(sentinelSlot) < 160) return null
  const below = mean(
    frame,
    picture.x + originX * s,
    picture.y + (originY + cell + 4) * s,
    half,
    Math.max(1, 8 * s)
  )
  if (below > 96) return null
  let value = 0
  for (let bit = 0; bit < bits; bit++)
    if (slot(bit) > 128) value += Math.pow(2, bit)
  return value
}

/** How well a placement puts the marker's white cell and black strip. */
function markerScore(frame: GrayFrame, picture: Box & { s: number }): number {
  const { originX, originY, stride, cell, sentinelSlot } = MARKER
  const s = picture.w / 1280
  const half = (cell / 2) * s
  const sentinel = mean(
    frame,
    picture.x + (originX + sentinelSlot * stride + cell / 4) * s,
    picture.y + (originY + cell / 4) * s,
    half,
    half
  )
  const strip = mean(
    frame,
    picture.x + originX * s,
    picture.y + (originY + cell + 4) * s,
    (sentinelSlot * stride + cell) * s,
    Math.max(1, 8 * s)
  )
  const gap = mean(
    frame,
    picture.x + (originX + sentinelSlot * stride - 3) * s,
    picture.y + (originY + cell / 4) * s,
    Math.max(1, 2 * s),
    half
  )
  return sentinel - Math.max(strip, gap)
}

/** The board's look, as the mean of small blocks inside it. */
function boardBlocks(frame: GrayFrame, board: Box): Float32Array {
  const inset = 3
  const size = 6
  const across = Math.max(1, Math.floor((board.w - 2 * inset) / size))
  const down = Math.max(1, Math.floor((board.h - 2 * inset) / size))
  const out = new Float32Array(across * down)
  for (let row = 0; row < down; row++)
    for (let col = 0; col < across; col++)
      out[row * across + col] = mean(
        frame,
        board.x + inset + col * size,
        board.y + inset + row * size,
        size,
        size
      )
  return out
}

function biggestDifference(a: Float32Array | null, b: Float32Array): number {
  if (a?.length !== b.length) return 255
  let most = 0
  for (let i = 0; i < a.length; i++)
    most = Math.max(most, Math.abs(a[i] - b[i]))
  return most
}

interface FrameRead {
  t: number
  marker: number | null
  board: number
}

interface LagResult {
  step: string
  action: string | null
  changeFrame: number | null
  markerBefore: number | null
  markerAtChange: number | null
  lagMs: number | null
  byRecording: boolean
}

/** Steps the recording of `part` frame by frame and places each step's change. */
async function measure(
  part: Part,
  file: string,
  startedAt: number,
  log: (line: string) => void
): Promise<{ results: LagResult[]; readable: number; frames: number }> {
  const size = videoSize(file)
  const times = frameTimes(file)
  const geometryAt = (wall: number): Geometry => {
    let chosen = part.geometry[0]
    for (const one of part.geometry) if (one.now <= wall) chosen = one
    return chosen
  }
  /** The `<video>` whose marker is read: the grid's master, or the first. */
  const videoOf = (
    geometry: Geometry
  ): Geometry['videos'][number] | undefined => {
    const grid = geometry.videos.filter(one => !one.inRoot)
    return grid.length > 1 ? grid[1] : geometry.videos[0]
  }
  /**
   * Where the board sits against the picture, in the picture's own pixels:
   * from a look at the page with a board, taken with the same kind of player.
   */
  const boardAgainstPicture = (geometry: Geometry): Box | null => {
    const video = videoOf(geometry)
    if (video == null) return null
    const kind = video.inRoot
    const withBoard = [...part.geometry]
      .sort(
        (a, b) =>
          Math.abs(a.now - geometry.now) - Math.abs(b.now - geometry.now)
      )
      .find(one => one.boards.length > 0 && videoOf(one)?.inRoot === kind)
    if (withBoard == null) return null
    const picture = pictureOf(videoOf(withBoard)!, { dx: 0, dy: 0, k: 1 })
    const board = withBoard.boards[0]
    return {
      x: (board.x - picture.x) / picture.s,
      y: (board.y - picture.y) / picture.s,
      w: board.w / picture.s,
      h: board.h / picture.s
    }
  }
  const findPlacement = (
    geometry: Geometry,
    frame: GrayFrame
  ): Placement | null => {
    const video = videoOf(geometry)
    if (video == null) return null
    const ratio = frame.width / Math.max(1, geometry.screen.innerW)
    const k = ratio > 0.9 && ratio < 1.1 ? 1 : ratio
    let best: { score: number; at: Placement } | null = null
    for (let dy = -150; dy <= 300; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const at = { dx, dy, k }
        const score = markerScore(frame, pictureOf(video, at))
        if (best == null || score > best.score) best = { score, at }
      }
    if (best == null || best.score < 80) return null
    const low = markerIn(frame, pictureOf(video, best.at))
    if (low == null) return null
    return Math.abs(unwrapMarker(low, part.t0) - part.t0) < 3_600_000
      ? best.at
      : null
  }

  const reads: FrameRead[] = []
  let previous: { key: string; blocks: Float32Array } | null = null
  let at: Placement | null = null
  let atKey = ''
  let lost = 0
  const count = await eachGrayFrame(file, size, (frame, n) => {
    const t = times[n] ?? NaN
    const geometry = geometryAt(startedAt + t * 1000)
    const video = videoOf(geometry)
    let marker: number | null = null
    let board = 0
    if (video != null) {
      // A marker is only taken when it reads a time within two minutes of
      // the recording's own clock: one read off something else is noise.
      const plausible = (low: number | null): number | null =>
        low != null &&
        Math.abs(unwrapMarker(low, part.t0) - (startedAt + t * 1000)) < 120_000
          ? low
          : null
      if (at != null) marker = plausible(markerIn(frame, pictureOf(video, at)))
      lost = marker == null ? lost + 1 : 0
      if (at == null ? n % 10 === 0 : lost > 0 && lost % 10 === 0) {
        const found = findPlacement(geometry, frame)
        if (found != null && JSON.stringify(found) !== JSON.stringify(at)) {
          at = found
          atKey = `${geometry.what}@${n}`
          log(
            `frame ${n} (${t.toFixed(3)} s): the picture is at ${JSON.stringify(pictureOf(video, at))}`
          )
          marker = plausible(markerIn(frame, pictureOf(video, at)))
          lost = marker == null ? lost : 0
        }
      }
      const relative = boardAgainstPicture(geometry)
      if (at != null && relative != null) {
        const picture = pictureOf(video, at)
        const blocks = boardBlocks(frame, {
          x: picture.x + relative.x * picture.s,
          y: picture.y + relative.y * picture.s,
          w: relative.w * picture.s,
          h: relative.h * picture.s
        })
        const key = `${atKey}/${geometry.what}`
        board =
          previous?.key === key ? biggestDifference(previous.blocks, blocks) : 0
        previous = { key, blocks }
      }
    }
    reads.push({ t, marker, board })
  })
  const walls = reads.map(one =>
    one.marker == null ? null : unwrapMarker(one.marker, part.t0)
  )
  const readable = walls.filter(one => one != null).length
  log(
    `recording ${size.width}x${size.height}, ${count} frames; a readable marker in ${readable}`
  )

  const changes: number[] = []
  for (let i = 0; i < reads.length; i++)
    if (
      reads[i].board > THRESHOLD &&
      (i === 0 || reads[i - 1].board <= THRESHOLD)
    )
      changes.push(i)
  log(`board changes seen: ${changes.length}`)
  const wallOf = (i: number): number | null => {
    for (let j = i; j >= Math.max(0, i - 3); j--)
      if (walls[j] != null) return walls[j]
    return null
  }
  const span = (times[times.length - 1] ?? 0) * 1000
  const steps = part.steps.filter(
    step => step.at >= startedAt - 5000 && step.at <= startedAt + span
  )
  const used = new Set<number>()
  const results: LagResult[] = []
  for (const step of steps) {
    const action = part.actions.reduce<{ at: number; what: string } | null>(
      (best, one) =>
        Math.abs(one.at - step.at) < 2000 &&
        (best == null ||
          Math.abs(one.at - step.at) < Math.abs(best.at - step.at))
          ? one
          : best,
      null
    )
    // The change nearest the step, by the picture's own clock, within 5 s.
    let chosen: number | null = null
    for (const i of changes) {
      if (used.has(i)) continue
      const wall = wallOf(i)
      if (wall == null || Math.abs(wall - step.at) > 5000) continue
      if (
        chosen == null ||
        Math.abs(wall - step.at) < Math.abs(wallOf(chosen)! - step.at)
      )
        chosen = i
    }
    // When the picture is not where its clock says (the live player opened
    // again after an outage), the change is the first clear one the
    // recording shows within 30 s after the step, after a second without
    // one: the board follows the player's time, not the picture's.
    let byRecording = false
    if (chosen == null) {
      for (const i of changes) {
        if (used.has(i)) continue
        const recorded = startedAt + reads[i].t * 1000
        if (recorded < step.at || recorded > step.at + 30_000) continue
        const quiet = reads
          .slice(Math.max(0, i - 120), i)
          .filter(one => one.t >= reads[i].t - 1)
          .every(one => one.board <= THRESHOLD)
        if (!quiet) continue
        chosen = i
        byRecording = true
        break
      }
    }
    if (chosen != null) used.add(chosen)
    const before = chosen == null ? null : wallOf(chosen - 1)
    const atChange = chosen == null ? null : wallOf(chosen)
    const one: LagResult = {
      step: iso(step.at),
      action: action?.what ?? null,
      changeFrame: chosen,
      markerBefore: before,
      markerAtChange: atChange,
      lagMs: atChange == null ? null : atChange - step.at,
      byRecording
    }
    results.push(one)
    log(
      `step ${one.step} (${one.action ?? 'no action'}): ` +
        (chosen == null
          ? 'no board change found within 5 s of it'
          : `frame ${chosen} at ${reads[chosen].t.toFixed(3)} s, marker before ${before == null ? '-' : iso(before)}, at the change ${atChange == null ? '-' : iso(atChange)}, lag ${one.lagMs} ms${byRecording ? ' (found by the recording, not the marker)' : ''}`)
    )
  }
  return { results, readable, frames: count }
}

/** The measurement's verdict: every step's change seen, and each in step. */
function judge(
  part: Part,
  steps: BoardStep[],
  measured: { results: LagResult[]; readable: number },
  log: (line: string) => void
): string[] {
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) failures.push(what)
  }
  check(
    measured.readable > 0,
    `the marker was read in ${measured.readable} recorded frames`
  )
  check(
    measured.results.length > 0,
    `${measured.results.length} of the ${steps.length} board steps fell inside the recording`
  )
  for (const one of measured.results) {
    check(
      one.changeFrame != null,
      `${one.step}: the recording shows the board change`
    )
    if (one.changeFrame == null || one.byRecording) continue
    const stepAt = Date.parse(one.step)
    check(
      one.markerAtChange != null && one.markerAtChange >= stepAt,
      `${one.step}: never early (the change's picture is ${one.lagMs} ms after the step)`
    )
    check(
      one.markerBefore != null && one.markerBefore < stepAt + FRAME_MS,
      `${one.step}: at most one picture late (the frame before it shows ${one.markerBefore == null ? '-' : one.markerBefore - stepAt} ms from the step)`
    )
  }
  note(part, `${failures.length} of the checks failed`)
  return failures
}

/** Records the page around `run`, then measures and judges the recording. */
async function recordAndMeasure(
  ctx: HarnessContext,
  part: Part,
  name: string,
  m: any,
  run: () => Promise<void>
): Promise<void> {
  const lines: string[] = []
  const log = (line: string): void => {
    console.log(line)
    lines.push(line)
  }
  const recording = await recordScreen(m, ctx.runDir, name, run)
  const measured = await measure(
    part,
    recording.file,
    recording.startedAtMs,
    log
  )
  const failures = judge(part, part.steps, measured, log)
  writeFileSync(
    ctx.artifact(`${name}.json`),
    JSON.stringify({ ...part, results: measured.results })
  )
  writeFileSync(ctx.artifact(`${name}.log`), `${lines.join('\n')}\n`)
  expect(failures, failures.join('\n')).deep.equals([])
}

async function frames(part: Part, m: any, label: string): Promise<void> {
  const logged = await readFrames(m, part.t0)
  note(part, `page frames ${label}`, { count: logged.length })
}

/** sync: a stamped 10-minute stream with a 20 s outage at 300 s. */
async function sync(ctx: HarnessContext): Promise<void> {
  const part = newPart()
  const { stack, games } = await boardStack(ctx)
  const [gameId] = games
  const programme = await camera(stack, gameId, 'F1 programme')
  const show = await broadcast(stack, programme, {
    stamped: true,
    duration: 600,
    outages: [{ at: 300, seconds: 20 }],
    lead: 360
  })
  const t0 = show.t0
  part.t0 = t0
  note(part, 'T0', iso(t0))
  const session = await scorer(stack, gameId)
  const desk = await dashboard(stack, gameId)
  const { m } = await boardBrowser(ctx, stack, SCREEN)
  const at = clock(t0)
  const act = (what: string): void => {
    part.actions.push({ at: Date.now(), what })
    note(part, what)
  }
  const ball = async (call: 'B' | 'C' | 'S' | 'F'): Promise<void> => {
    const when = pitch(session, call)
    part.actions.push({ at: when, what: `pitch ${call}` })
    note(part, `pitch ${call}`, iso(when))
    await session.flush()
  }
  const board = (on: boolean): void => {
    desk.send(JSON.stringify({ type: 'overrides', data: overrides(on) }))
    act(`dashboard ${on ? 'on' : 'off'}`)
  }
  await at(6)
  const url = `${stack.origin}/games/${gameId}?video=${programme.videoId}`
  await open(part, m, url, PICTURE_READY, 'the live programme shows a picture')
  await probe(m, frameLogger())
  const plan: Array<[number, string]> = [
    [30, 'pitch B'],
    [60, 'pitch C'],
    [90, 'dashboard on'],
    [120, 'dashboard off'],
    [150, 'pitch B'],
    [180, 'pitch F'],
    [210, 'pitch B'],
    [240, 'pitch S'],
    [270, 'pitch B'],
    [350, 'pitch C'],
    [380, 'dashboard on'],
    [410, 'dashboard off'],
    [440, 'pitch B'],
    [470, 'pitch B'],
    [500, 'pitch C'],
    [530, 'pitch F'],
    [560, 'pitch B']
  ]
  await recordAndMeasure(ctx, part, 'f1-sync', m, async () => {
    const unwatch = watchPage(part, m, stack)
    let reopened = false
    for (const [sec, what] of plan) {
      if (!reopened && sec > 320) {
        // Two seconds after the publisher is back: has the live player
        // stopped at the outage?
        await at(322)
        const state = await probe<{ at: number; ended: boolean }>(
          m,
          `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended, paused: v.paused, end: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0 }`
        )
        note(part, 'the live player two seconds after the outage', state)
        await pause(8000)
        const later = await probe<{ at: number; ended: boolean }>(
          m,
          `const v = document.querySelector('video'); return { at: v.currentTime, ended: v.ended }`
        )
        note(part, 'ten seconds after the outage', later)
        if (later.ended || later.at - state.at < 4) {
          await frames(part, m, 'before-break')
          act('reopen the page')
          await open(
            part,
            m,
            url,
            PICTURE_READY,
            'the programme shows a picture again'
          )
          await probe(m, frameLogger())
        } else note(part, 'the live player kept playing; not reopened')
        reopened = true
      }
      await at(sec)
      if (what.startsWith('pitch '))
        await ball(what.slice(6) as 'B' | 'C' | 'S' | 'F')
      else board(what === 'dashboard on')
    }
    desk.close(1000)
    const code = await show.done()
    note(part, 'the stream ended', { code })
    expect(code, 'the stream published').equals(0)
    await at(612)
    part.geometry.push({ ...(await probe<Geometry>(m, GEOMETRY)), what: 'end' })
    await frames(part, m, reopened ? 'after-break' : 'whole')
    unwatch()
    part.steps = (
      await stack.client.scoreboardTimeline(gameId, { fromMs: t0 - 60_000 })
    ).steps
  })
  await endCamera(stack, programme)
  await ready(stack, gameId, programme.videoId)
  const vod = await videoTimeline(stack, programme.videoId)
  note(part, 'the recording', {
    source: vod.source,
    points: vod.anchors.length
  })
}

/** grid: an unstamped angle, the live grid of it and a stamped one, then the unstamped angle again. */
async function grid(ctx: HarnessContext): Promise<void> {
  const part = newPart()
  const { stack, games } = await boardStack(ctx)
  const [gameId] = games
  const unstamped = await camera(stack, gameId, 'F1 unstamped')
  const stamped = await camera(stack, gameId, 'F1 stamped')
  const duration = 280
  const lead = 240
  const shows = [
    await broadcast(stack, unstamped, { duration, lead }),
    await broadcast(stack, stamped, { stamped: true, duration, lead })
  ]
  const t0 = shows[0].t0
  part.t0 = t0
  note(part, 'T0', iso(t0))
  const session = await scorer(stack, gameId)
  const { m } = await boardBrowser(ctx, stack, SCREEN)
  const at = clock(t0)
  const single = `${stack.origin}/games/${gameId}?video=${unstamped.videoId}`
  const both = `${stack.origin}/games/${gameId}?angles=${unstamped.videoId},${stamped.videoId}&audio=${stamped.videoId}`
  await at(8)
  await open(
    part,
    m,
    single,
    PICTURE_READY,
    'the unstamped angle shows a picture'
  )
  await probe(m, frameLogger())
  let pitches = 0
  const pitchAt = async (sec: number): Promise<void> => {
    await at(sec)
    const call = (['B', 'C', 'B', 'F'] as const)[pitches++ % 4]
    const when = pitch(session, call)
    part.actions.push({ at: when, what: `pitch ${call}` })
    note(part, `pitch ${call}`, iso(when))
    await session.flush()
  }
  await recordAndMeasure(ctx, part, 'f1-grid', m, async () => {
    const unwatch = watchPage(part, m, stack)
    for (const sec of [25, 50, 75, 100, 120]) await pitchAt(sec)
    await at(130)
    await frames(part, m, 'unstamped')
    part.actions.push({ at: Date.now(), what: 'open the live grid' })
    await open(
      part,
      m,
      both,
      gridReady(2),
      'both tiles of the live grid show a picture'
    )
    await probe(m, frameLogger(`${GRID_VIDEOS}[1]`))
    for (const sec of [150, 175, 200, 225, 245]) await pitchAt(sec)
    await at(252)
    part.geometry.push({
      ...(await probe<Geometry>(m, GEOMETRY)),
      what: 'grid'
    })
    await frames(part, m, 'live-grid')
    part.actions.push({ at: Date.now(), what: 'back to the unstamped angle' })
    await open(part, m, single, PICTURE_READY, 'the unstamped angle again')
    await probe(m, frameLogger())
    await pitchAt(265)
    const codes = await Promise.all(shows.map(async show => await show.done()))
    note(part, 'both streams ended', { codes })
    expect(codes, 'both streams published').deep.equals([0, 0])
    await endCamera(stack, unstamped)
    await endCamera(stack, stamped)
    part.actions.push({ at: Date.now(), what: 'cameras ended' })
    await ready(stack, gameId, unstamped.videoId)
    part.actions.push({ at: Date.now(), what: 'unstamped recording ready' })
    part.geometry.push({ ...(await probe<Geometry>(m, GEOMETRY)), what: 'end' })
    await frames(part, m, 'after-end')
    unwatch()
    await ready(stack, gameId, stamped.videoId)
    part.steps = (
      await stack.client.scoreboardTimeline(gameId, { fromMs: t0 - 60_000 })
    ).steps
  })
}

export default defineHarness({
  id: 'playback/wall-clock/display-lag',
  title:
    'The live board changes on the first picture that reaches each change, as a recording of the page shows it',
  kind: 'e2e',
  covers: [
    'src/app/player/scoreboardOverlay/**',
    'src/app/player/multiCam/**',
    'src/server/live/**'
  ],
  stack: 'isolated',
  fixtures: ['scoring-game'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // It plays the stack's HEVC live.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { sync, grid }
})
