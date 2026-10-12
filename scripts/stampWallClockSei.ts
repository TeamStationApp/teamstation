import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { readBoxes } from '../src/server/media/wallClockScan'
import { stampWallClock } from '../src/server/media/wallClockStamp'

/**
 * Stamps every frame of a video with a wall clock SEI, as TS Director's live
 * programme carries one: the start's wall time plus the frame's presentation
 * time.
 *
 *   node -r sucrase/register scripts/stampWallClockSei.ts \
 *     --in take.mp4 --out stamped.mp4 --start <wall ms> [--uncorrected] \
 *     [--ffmpeg /opt/homebrew/bin/ffmpeg]
 *
 * The input is an fMP4 or an MP4. An MP4 that is not fragmented is first
 * fragmented by FFmpeg, `-c copy`, which moves the samples into fragments and
 * changes none of them. `--uncorrected` stamps the clock as the encoder's own,
 * not the server's.
 */
const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    start: { type: 'string' },
    uncorrected: { type: 'boolean', default: false },
    ffmpeg: { type: 'string', default: '/opt/homebrew/bin/ffmpeg' }
  }
})
const start = Number(values.start)
if (values.in == null || values.out == null || !Number.isInteger(start)) {
  console.error(
    'Usage: node -r sucrase/register scripts/stampWallClockSei.ts --in <file> --out <file> --start <wall ms> [--uncorrected]'
  )
  process.exit(2)
}

let input: Uint8Array = readFileSync(values.in)
const fragmented = readBoxes(input, 0, input.length).some(
  box => box.type === 'moof'
)
if (!fragmented) {
  const work = mkdtempSync(join(tmpdir(), 'tsStamp-'))
  try {
    const copy = join(work, 'fragmented.mp4')
    execFileSync(values.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      values.in,
      '-c',
      'copy',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      copy
    ])
    input = readFileSync(copy)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
writeFileSync(values.out, stampWallClock(input, start, !values.uncorrected))
console.log(`stamped ${values.out} from ${new Date(start).toISOString()}`)
