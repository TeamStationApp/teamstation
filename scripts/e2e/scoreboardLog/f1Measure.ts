/**
 * F1's measurement: steps a display recording made by `f1Recording.ts` frame
 * by frame, and in each recorded frame reads the wall clock burned into the
 * picture (the fake broadcaster's marker, bottom-left) and whether the board
 * (top-left) has just changed. A change of the board is placed by the marker
 * in the same recorded frame, so the lag it reports is what a viewer saw,
 * with nothing from inside the page.
 *
 *   node -r sucrase/register scripts/e2e/scoreboardLog/f1Measure.ts \
 *     <part.json> <recording.mov> [--video <n>] [--threshold 24] \
 *     [--frames <directory>] [--out <report.json>]
 *
 * `<part.json>` is what `f1Recording.ts` wrote: the page's geometry each time
 * it opened (where the video and the board were, in page pixels), when the
 * display recording started, and the board's steps from the API. The page's
 * place on the display (under the browser's own bars) is found by looking
 * for the marker's always-white cell in the recording itself.
 *
 * For each step of the board, the change is the first recorded frame, near
 * the step's time, whose board differs from the frame before it. Its lag is
 * the marker in that frame minus the step's time: in step when the board
 * changes on the first frame whose picture has reached the step, so between
 * zero and one picture (33 ms) late, never early.
 *
 * `--frames` saves the frame before each change and the change itself,
 * cropped to the picture, for a person to look at.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { markerGeometry, unwrapMarker } from './readMarker'

const FFMPEG = process.env.F1_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
const FFPROBE = process.env.F1_FFPROBE ?? '/opt/homebrew/bin/ffprobe'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    video: { type: 'string' },
    threshold: { type: 'string', default: '24' },
    frames: { type: 'string' },
    out: { type: 'string' }
  }
})
const [partFile, movie] = positionals
if (partFile == null || movie == null)
  throw new Error('Give <part.json> <recording.mov>')

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
  keys: Array<Box | null>
}
interface Part {
  part: string
  t0: number
  actions: Array<{ at: number; what: string }>
  geometry: Geometry[]
  capture: { startedAt: number; seconds: number } | null
  steps: Array<{ at: number; state: unknown }> | null
}
const record = JSON.parse(readFileSync(partFile, 'utf8')) as Part
if (record.capture == null) throw new Error('the part has no recording')
const startedAt = record.capture.startedAt

/** Width and height of the recording, and every frame's time, in order. */
function probe(): { width: number; height: number; times: number[] } {
  const stream = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      movie
    ],
    { encoding: 'utf8' }
  )
  const [width, height] = stream.stdout.trim().split(',').map(Number)
  const packets = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      movie
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 }
  )
  const times = packets.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(Number)
    .sort((a, b) => a - b)
  return { width, height, times }
}

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

const geometryAt = (wall: number): Geometry => {
  let chosen = record.geometry[0]
  for (const one of record.geometry) if (one.now <= wall) chosen = one
  return chosen
}

/** The `<video>` whose marker is read: the grid's master, or the first. */
function videoOf(geometry: Geometry): Geometry['videos'][number] | undefined {
  if (values.video != null) return geometry.videos[Number(values.video)]
  const grid = geometry.videos.filter(one => !one.inRoot)
  return grid.length > 1 ? grid[1] : geometry.videos[0]
}

class Frame {
  constructor(
    readonly data: Buffer,
    readonly width: number
  ) {}

  mean(x: number, y: number, w: number, h: number): number {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.max(x0 + 1, Math.round(x + w))
    const y1 = Math.max(y0 + 1, Math.round(y + h))
    let sum = 0
    let count = 0
    for (let row = y0; row < y1; row++) {
      const base = row * this.width
      for (let col = x0; col < x1; col++) {
        sum += this.data[base + col]
        count++
      }
    }
    return sum / count
  }
}

const GEOMETRY = markerGeometry(720)

/** The marker's low 32 bits in a recorded frame, or null. */
function readMarker(frame: Frame, picture: Box & { s: number }): number | null {
  const { bits, originX, originY, stride, cell, sentinelSlot } = GEOMETRY
  // The scale from the 1280x720 picture the marker was drawn on.
  const s = picture.w / 1280
  const half = (cell / 2) * s
  const slot = (n: number): number =>
    frame.mean(
      picture.x + (originX + n * stride + cell / 4) * s,
      picture.y + (originY + cell / 4) * s,
      half,
      half
    )
  if (slot(sentinelSlot) < 160) return null
  const below = frame.mean(
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
function markerScore(frame: Frame, picture: Box & { s: number }): number {
  const { originX, originY, stride, cell, sentinelSlot } = GEOMETRY
  const s = picture.w / 1280
  const half = (cell / 2) * s
  const sentinel = frame.mean(
    picture.x + (originX + sentinelSlot * stride + cell / 4) * s,
    picture.y + (originY + cell / 4) * s,
    half,
    half
  )
  const strip = frame.mean(
    picture.x + originX * s,
    picture.y + (originY + cell + 4) * s,
    (sentinelSlot * stride + cell) * s,
    Math.max(1, 8 * s)
  )
  const gap = frame.mean(
    picture.x + (originX + sentinelSlot * stride - 3) * s,
    picture.y + (originY + cell / 4) * s,
    Math.max(1, 2 * s),
    half
  )
  return sentinel - Math.max(strip, gap)
}

/** The board's look, as the mean of small blocks inside it. */
function boardBlocks(frame: Frame, board: Box): Float32Array {
  const inset = 3
  const size = 6
  const across = Math.max(1, Math.floor((board.w - 2 * inset) / size))
  const down = Math.max(1, Math.floor((board.h - 2 * inset) / size))
  const out = new Float32Array(across * down)
  for (let row = 0; row < down; row++)
    for (let col = 0; col < across; col++)
      out[row * across + col] = frame.mean(
        board.x + inset + col * size,
        board.y + inset + row * size,
        size,
        size
      )
  return out
}

function biggestDifference(a: Float32Array | null, b: Float32Array): number {
  if (a == null) return 255
  if (a.length !== b.length) return 255
  let most = 0
  for (let i = 0; i < a.length; i++)
    most = Math.max(most, Math.abs(a[i] - b[i]))
  return most
}

interface FrameRead {
  n: number
  t: number
  marker: number | null
  board: number
  what: string
}

/**
 * Where the board sits against the picture, in the picture's own pixels:
 * from a look at the page with a board, taken with the same kind of player
 * (single or grid), since the board is not there before the first step.
 */
function boardAgainstPicture(geometry: Geometry): Box | null {
  const video = videoOf(geometry)
  if (video == null) return null
  const kind = video.inRoot
  const withBoard = [...record.geometry]
    .sort(
      (a, b) => Math.abs(a.now - geometry.now) - Math.abs(b.now - geometry.now)
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

async function readFrames(
  width: number,
  height: number,
  times: number[]
): Promise<FrameRead[]> {
  const size = width * height
  const child = spawn(
    FFMPEG,
    [
      '-v',
      'error',
      '-i',
      movie,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const reads: FrameRead[] = []
  const buffer = Buffer.alloc(size)
  let filled = 0
  let n = 0
  let previous: { key: string; blocks: Float32Array } | null = null
  // The picture's place on the recording: found by looking for the marker,
  // and looked for again whenever it has not been read for ten frames (the
  // page moved, was opened again, or something else covered it).
  let at: Placement | null = null
  let atKey = ''
  let lost = 0
  const onFrame = (): void => {
    const frame = new Frame(buffer, width)
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
        Math.abs(unwrapMarker(low, record.t0) - (startedAt + t * 1000)) <
          120_000
          ? low
          : null
      if (at != null)
        marker = plausible(readMarker(frame, pictureOf(video, at)))
      lost = marker == null ? lost + 1 : 0
      if (at == null ? n % 10 === 0 : lost > 0 && lost % 10 === 0) {
        const found = findPlacement(geometry, frame, width)
        if (found != null && JSON.stringify(found) !== JSON.stringify(at)) {
          at = found
          atKey = `${geometry.what}@${n}`
          console.log(
            `frame ${n} (${t.toFixed(3)} s): the picture is at ${JSON.stringify(pictureOf(video, at))}`
          )
          marker = plausible(readMarker(frame, pictureOf(video, at)))
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
    reads.push({ n, t, marker, board, what: geometry.what })
    n++
  }
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    let offset = 0
    while (offset < chunk.length) {
      const take = Math.min(size - filled, chunk.length - offset)
      chunk.copy(buffer, filled, offset, offset + take)
      filled += take
      offset += take
      if (filled === size) {
        onFrame()
        filled = 0
      }
    }
  }
  return reads
}

/**
 * Finds the picture on the recording: where the marker's white cell and
 * black strip line up, and the marker there reads a time near the stream's.
 */
function findPlacement(
  geometry: Geometry,
  frame: Frame,
  width: number
): Placement | null {
  const video = videoOf(geometry)
  if (video == null) return null
  const ratio = width / Math.max(1, geometry.screen.innerW)
  const k = ratio > 0.9 && ratio < 1.1 ? 1 : ratio
  let best: { score: number; at: Placement } | null = null
  for (let dy = -150; dy <= 300; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const at = { dx, dy, k }
      const score = markerScore(frame, pictureOf(video, at))
      if (best == null || score > best.score) best = { score, at }
    }
  if (best == null || best.score < 80) return null
  const low = readMarker(frame, pictureOf(video, best.at))
  if (low == null) return null
  return Math.abs(unwrapMarker(low, record.t0) - record.t0) < 3_600_000
    ? best.at
    : null
}

async function main(): Promise<void> {
  const { width, height, times } = probe()
  const span = times[times.length - 1] - times[0]
  const gaps = times.slice(1).map((t, i) => t - times[i])
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const rate = {
    frames: times.length,
    seconds: Number(span.toFixed(3)),
    meanFps: Number(((times.length - 1) / span).toFixed(2)),
    medianInterval: Number(
      (sortedGaps[Math.floor(sortedGaps.length / 2)] * 1000).toFixed(1)
    ),
    longestInterval: Number(
      (sortedGaps[sortedGaps.length - 1] * 1000).toFixed(1)
    )
  }
  console.log(`recording ${width}x${height}`, JSON.stringify(rate))

  const reads = await readFrames(width, height, times)
  const near = record.t0
  const walls = reads.map(one =>
    one.marker == null ? null : unwrapMarker(one.marker, near)
  )
  const readable = walls.filter(one => one != null).length
  console.log(`frames with a readable marker: ${readable} of ${reads.length}`)

  // Playing stretches: frames whose marker moved on from the frame before.
  const moving = walls.filter(
    (one, i) =>
      one != null && i > 0 && walls[i - 1] != null && one !== walls[i - 1]
  ).length
  console.log(`frames that show a new picture: ${moving}`)

  const threshold = Number(values.threshold)
  // A change of the board: the first of a run of frames that differ from
  // the one before.
  const changes: number[] = []
  for (let i = 0; i < reads.length; i++)
    if (
      reads[i].board > threshold &&
      (i === 0 || reads[i - 1].board <= threshold)
    )
      changes.push(i)
  console.log(`board changes seen: ${changes.length}`)

  const wallOf = (i: number): number | null => {
    for (let j = i; j >= Math.max(0, i - 3); j--)
      if (walls[j] != null) return walls[j]
    return null
  }
  const steps = (record.steps ?? []).filter(
    step =>
      step.at >= startedAt - 5000 && step.at <= startedAt + rate.seconds * 1000
  )
  const used = new Set<number>()
  const results: Array<{
    step: string
    action: string | null
    changeFrame: number | null
    recordedAt: number | null
    markerBefore: string | null
    markerAtChange: string | null
    lagMs: number | null
    byRecording: boolean
  }> = []
  for (const step of steps) {
    const action = record.actions.reduce<{ at: number; what: string } | null>(
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
          .every(one => one.board <= threshold)
        if (!quiet) continue
        chosen = i
        byRecording = true
        break
      }
    }
    if (chosen != null) used.add(chosen)
    const before = chosen == null ? null : wallOf(chosen - 1)
    const at = chosen == null ? null : wallOf(chosen)
    results.push({
      step: new Date(step.at).toISOString(),
      action: action?.what ?? null,
      changeFrame: chosen,
      recordedAt: chosen == null ? null : Number(reads[chosen].t.toFixed(3)),
      markerBefore: before == null ? null : new Date(before).toISOString(),
      markerAtChange: at == null ? null : new Date(at).toISOString(),
      lagMs: at == null ? null : at - step.at,
      byRecording
    })
  }
  for (const one of results)
    console.log(
      `step ${one.step} (${one.action ?? 'no action'}): ` +
        (one.changeFrame == null
          ? 'no board change found within 5 s of it'
          : `frame ${one.changeFrame} at ${one.recordedAt} s, marker before ${one.markerBefore}, at the change ${one.markerAtChange}, lag ${one.lagMs} ms${one.byRecording ? ' (found by the recording, not the marker)' : ''}`)
    )
  const unmatched = changes
    .filter(i => !used.has(i))
    .map(i => ({
      frame: i,
      t: Number(reads[i].t.toFixed(3)),
      marker: wallOf(i) == null ? null : new Date(wallOf(i)!).toISOString(),
      what: reads[i].what,
      difference: Number(reads[i].board.toFixed(1))
    }))
  console.log(`board changes matching no step: ${JSON.stringify(unmatched)}`)

  if (values.frames != null) {
    mkdirSync(values.frames, { recursive: true })
    const wanted = new Map<number, string>()
    for (const one of results)
      if (one.changeFrame != null) {
        const name = one.step.replace(/[:.]/g, '')
        wanted.set(one.changeFrame - 1, `${name}-before`)
        wanted.set(one.changeFrame, `${name}-change`)
      }
    const list = [...wanted.keys()].sort((a, b) => a - b)
    if (list.length > 0) {
      const dir = values.frames
      spawnSync(
        FFMPEG,
        [
          '-v',
          'error',
          '-i',
          movie,
          '-vf',
          `select='${list.map(i => `eq(n\\,${i})`).join('+')}',scale=960:-2`,
          '-fps_mode',
          'passthrough',
          join(dir, 'pick-%03d.png')
        ],
        { stdio: 'inherit' }
      )
      writeFileSync(
        join(dir, 'index.json'),
        JSON.stringify(
          list.map((n, i) => ({
            file: `pick-${String(i + 1).padStart(3, '0')}.png`,
            n,
            name: wanted.get(n)
          })),
          null,
          1
        )
      )
    }
  }
  if (values.out != null)
    writeFileSync(
      values.out,
      JSON.stringify({
        rate,
        readable,
        moving,
        results,
        unmatched,
        reads: reads.map((one, i) => [
          one.t,
          walls[i],
          Number(one.board.toFixed(1))
        ])
      })
    )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
