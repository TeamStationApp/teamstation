import { expect } from 'chai'
import { execFile } from 'child_process'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { after, before, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

import { serverConfig } from '../serverConfig'
import { ffprobeFor, MEDIA_PLAYLIST, probeFfmpeg, remuxToHls } from './ffmpeg'

const run = promisify(execFile)

/**
 * A phone's programme export with a hole, as the Android app writes it:
 * fifteen 64×64 black H.264 pictures, a ten-second absence, and fifteen more,
 * with mono sound throughout. The streamcore test that writes it
 * (`ProgrammeExportTest.aHoleIsFilledOnceASecondSoFFmpegsCopyKeepsIt`) fails
 * when the export stops writing exactly this file.
 */
const FIXTURE = join(__dirname, 'fixtures', 'androidHole.mp4')

interface Packet {
  pts: number
  duration: number
  key: boolean
}

async function packets(ffprobe: string, path: string): Promise<Packet[]> {
  const { stdout } = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,duration_time,flags',
      '-of',
      'csv=p=0',
      path
    ],
    { maxBuffer: 1 << 22 }
  )
  return stdout
    .split('\n')
    .map(line => line.split(','))
    .filter(fields => fields.length >= 3 && fields[0] !== '')
    .map(([pts, duration, flags]) => ({
      pts: Number(pts),
      duration: Number(duration),
      key: (flags ?? '').startsWith('K')
    }))
    .sort((a, b) => a.pts - b.pts)
}

/**
 * The first part's pictures at 0 to 0.5 s, each once, the last lasting one
 * frame; a picture at the start of the hole and every second after, each
 * lasting until the next; the second part's first picture at 10.5 s on a
 * keyframe; then one picture a frame to the end at 11 s.
 */
function expectHole(read: Packet[], label: string): void {
  const frame = 1 / 30
  const near = (value: number, to: number): boolean =>
    Math.abs(value - to) < 0.002
  const times = read.map(packet => packet.pts)
  expect(
    times.slice(1).every((time, i) => time > (times[i] ?? 0) + frame / 2),
    `${label}: replayed or out of order ${times.join(' ')}`
  ).to.equal(true)
  const before = read.filter(packet => packet.pts < 0.49)
  const hole = read.filter(packet => packet.pts > 0.49 && packet.pts < 10.49)
  const after = read.filter(packet => packet.pts > 10.49)
  expect(before, `${label}: pictures before the hole`).to.have.length(15)
  expect(before.every((packet, i) => near(packet.pts, i * frame))).to.equal(
    true
  )
  expect(
    before.at(-1)?.duration,
    `${label}: the outgoing picture`
  ).to.be.closeTo(frame, 0.002)
  expect(
    hole.map(packet => Math.round(packet.pts * 1000) / 1000),
    `${label}: the hole`
  ).to.deep.equal([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5])
  expect(after[0]?.pts, `${label}: the return`).to.be.closeTo(10.5, 0.002)
  expect(after[0]?.key, `${label}: the return is a keyframe`).to.equal(true)
  expect(after[0]?.duration, `${label}: the return lasts`).to.be.closeTo(
    frame,
    0.002
  )
  expect(after, `${label}: pictures after the hole`).to.have.length(15)
  expect(
    Math.max(...read.map(packet => packet.duration)),
    `${label}: the longest picture`
  ).to.be.at.most(1.002)
  const last = read.at(-1)
  expect(
    (last?.pts ?? 0) + (last?.duration ?? 0),
    `${label}: end`
  ).to.be.closeTo(11, 0.002)
}

describe("an Android export's hole through FFmpeg", function () {
  this.timeout(60_000)
  const ffmpegPath = serverConfig.ffmpegPath
  const ffprobePath = ffprobeFor(ffmpegPath)
  let workDir = ''

  before(async function () {
    try {
      await probeFfmpeg(ffmpegPath)
      await run(ffprobePath, ['-version'])
    } catch {
      this.skip()
      return
    }
    workDir = await mkdtemp(join(tmpdir(), 'tsAndroidHole-'))
  })

  after(async function () {
    if (workDir !== '') await rm(workDir, { recursive: true, force: true })
  })

  it('FFmpeg reads every picture at its wall time in the file', async function () {
    expectHole(await packets(ffprobePath, FIXTURE), 'file')
  })

  it("keeps the hole in the upload's HLS copy, the return at its wall time", async function () {
    const outDir = join(workDir, 'hls')
    await mkdir(outDir)
    await remuxToHls(ffmpegPath, {
      input: FIXTURE,
      outDir,
      videoTag: 'avc1'
    })
    expectHole(
      await packets(ffprobePath, join(outDir, MEDIA_PLAYLIST)),
      'HLS copy'
    )
  })
})
