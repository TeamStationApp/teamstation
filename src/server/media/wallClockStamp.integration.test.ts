import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  decodeWallClockSei,
  nalType,
  SEI_NAL_TYPE
} from '../../common/wallClockSei'
import {
  canEncode,
  encodeFragmented,
  FFMPEG,
  stampFile
} from '../../test/wallClockFixtures'
import {
  fragmentSamples,
  nalUnits,
  readBoxes,
  type Sample,
  type VideoTrack,
  videoTrackOf
} from './wallClockScan'
import { stampWallClock } from './wallClockStamp'

const run = promisify(execFile)
const START = 1_700_000_000_000

/** Every sample of every track, in file order, with the track it is of. */
function allSamples(
  bytes: Uint8Array,
  track: VideoTrack
): Array<{ video: boolean; sample: Sample }> {
  const out: Array<{ video: boolean; sample: Sample }> = []
  for (const moof of readBoxes(bytes, 0, bytes.length)) {
    if (moof.type !== 'moof') continue
    for (const trackId of [track.trackId, track.trackId + 1]) {
      for (const sample of fragmentSamples(bytes, moof, {
        ...track,
        trackId
      }))
        out.push({ video: trackId === track.trackId, sample })
    }
  }
  return out.sort((a, b) => a.sample.offset - b.sample.offset)
}

/** The decoded pictures and sound, one checksum each. */
async function frameSums(file: string): Promise<string> {
  const { stdout } = await run(
    FFMPEG,
    ['-v', 'error', '-i', file, '-f', 'framemd5', '-'],
    { maxBuffer: 1 << 24 }
  )
  return stdout
}

/** U27: the stamper writes one SEI per frame and changes nothing else. */
describe('stamping a wall clock into every frame (U27)', function () {
  this.timeout(120_000)
  let dir = ''

  before(async function () {
    if (!(await canEncode('libx265', 'libx264', 'aac'))) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsWallStamp-'))
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  const layouts: Array<{
    name: string
    codec: 'hevc' | 'h264'
    movflags?: string
  }> = [
    { name: 'HEVC based on its moof', codec: 'hevc' },
    {
      name: 'H.264 with file offsets and a random-access index',
      codec: 'h264',
      movflags: 'frag_keyframe+empty_moov'
    }
  ]

  for (const layout of layouts) {
    it(`stamps ${layout.name}`, async function () {
      const plain = join(dir, `${layout.codec}-${layout.name.length}.mp4`)
      const stamped = `${plain}.stamped.mp4`
      await encodeFragmented(plain, {
        codec: layout.codec,
        seconds: 2,
        bframes: 2,
        sound: true,
        movflags: layout.movflags
      })
      await stampFile(plain, stamped, START)
      const before = await readFile(plain)
      const after = await readFile(stamped)
      const track = videoTrackOf(after)!
      const was = allSamples(before, videoTrackOf(before)!)
      const now = allSamples(after, track)
      expect(now.length).equals(was.length)
      expect(now.filter(one => one.video).length).equals(60)

      for (const [i, { video, sample }] of now.entries()) {
        const original = before.subarray(
          was[i].sample.offset,
          was[i].sample.offset + was[i].sample.size
        )
        const bytes = after.subarray(sample.offset, sample.offset + sample.size)
        if (!video) {
          expect(Buffer.compare(bytes, original), `sound ${i}`).equals(0)
          continue
        }
        // Exactly one SEI of ours, before the picture, and taking it out
        // leaves the sample as it was.
        const nals = [...nalUnits(after, sample, track.lengthSize)]
        const ours = nals.filter(
          nal =>
            nalType(track.codec, nal) === SEI_NAL_TYPE[track.codec] &&
            decodeWallClockSei(track.codec, nal) != null
        )
        expect(ours.length, `frame ${i}`).equals(1)
        const stamp = decodeWallClockSei(track.codec, ours[0])
        expect(stamp?.wallMs).equals(
          Math.round(START + (sample.pts * 1000) / track.timescale)
        )
        const at = ours[0].byteOffset - after.byteOffset - sample.offset
        const without = Buffer.concat([
          bytes.subarray(0, at - track.lengthSize),
          bytes.subarray(at + ours[0].length)
        ])
        expect(Buffer.compare(without, original), `frame ${i}`).equals(0)
      }

      // The indexes into the old layout are gone; the decoded pictures and
      // sound are the same.
      const types = readBoxes(after, 0, after.length).map(box => box.type)
      expect(types).not.includes('sidx')
      expect(types).not.includes('mfra')
      expect(await frameSums(stamped)).equals(await frameSums(plain))
    })
  }

  it('leaves out a segment index, which would point at the old bytes', async function () {
    const plain = join(dir, 'indexed.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 1 })
    const bytes = await readFile(plain)
    const moov = readBoxes(bytes, 0, bytes.length).find(
      box => box.type === 'moov'
    )!
    // A `sidx` after the `moov`, as a DASH muxer puts one. The fragments are
    // based on their own `moof`, so nothing else moves.
    const sidx = Buffer.alloc(32)
    sidx.writeUInt32BE(32, 0)
    sidx.write('sidx', 4)
    const indexed = Buffer.concat([
      bytes.subarray(0, moov.end),
      sidx,
      bytes.subarray(moov.end)
    ])
    const stamped = stampWallClock(indexed, START)
    const types = readBoxes(stamped, 0, stamped.length).map(box => box.type)
    expect(types).deep.equals(['ftyp', 'moov', 'moof', 'mdat'])
  })

  it('marks the clock as the encoder’s own when asked', async function () {
    const plain = join(dir, 'uncorrected.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 1 })
    const stamped = stampWallClock(await readFile(plain), START, false)
    const track = videoTrackOf(stamped)!
    const moof = readBoxes(stamped, 0, stamped.length).find(
      box => box.type === 'moof'
    )!
    const [first] = fragmentSamples(stamped, moof, track)
    const sei = [...nalUnits(stamped, first, track.lengthSize)].find(
      nal => decodeWallClockSei('hevc', nal) != null
    )!
    expect(decodeWallClockSei('hevc', sei)).deep.equals({
      wallMs: START,
      corrected: false
    })
  })

  it('refuses a file with no picture to stamp', function () {
    expect(() => stampWallClock(new Uint8Array(32), START)).throws(
      'no H.264 or HEVC track'
    )
  })
})
