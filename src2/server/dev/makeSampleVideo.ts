import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { remuxToHls } from '../media/ffmpeg'
import { serverConfig } from '../serverConfig'

const run = promisify(execFile)

/**
 * Puts a real, playable video where a real one would be, so the watch path can
 * be exercised on this machine.
 *
 * It generates HEVC with a burnt-in running clock and a tone, then remuxes it
 * to fMP4 HLS through the same code the upload path uses. The clock matters:
 * seeking to a highlight is only verifiable if you can see, in the picture,
 * which second the player landed on.
 *
 *   npm run sample-video -- <videoId> [durationSec]
 */
async function main(): Promise<void> {
  const videoId = process.argv[2]
  const durationSec = Number(process.argv[3] ?? '600')
  if (videoId == null || videoId === '') {
    throw new Error('usage: sample-video <videoId> [durationSec]')
  }

  const outDir = join(serverConfig.mediaDir, 'work', 'videos', videoId)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const source = join(outDir, 'source.mp4')
  console.log(`generating ${durationSec}s of HEVC…`)
  await run(
    serverConfig.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=1280x720:rate=30:duration=${durationSec}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSec}`,
      // The elapsed time, large enough to read in a screenshot.
      '-vf',
      "drawtext=text='%{pts\\:hms}':fontsize=96:fontcolor=white:" +
        'box=1:boxcolor=black@0.6:x=(w-text_w)/2:y=h-text_h-40',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=error',
      '-tag:v',
      'hvc1',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-c:a',
      'aac',
      '-shortest',
      source
    ],
    { maxBuffer: 1 << 24 }
  )

  console.log('remuxing to HLS (copy, no re-encode)…')
  await remuxToHls(serverConfig.ffmpegPath, { input: source, outDir })

  // The source is not part of what gets served; the HLS is.
  await rm(source, { force: true })
  console.log(`ready: ${outDir}/master.m3u8`)
}

main().catch((error: unknown) => {
  console.error(String(error))
  process.exit(1)
})
