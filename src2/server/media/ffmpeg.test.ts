import { expect } from 'chai'
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { after, before, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

import { serverConfig } from '../serverConfig'
import {
  assertPinnedFfmpeg,
  ffmpegEncoders,
  probeFfmpeg,
  probeVideoStream,
  remuxToHls,
  remuxToHlsArgs
} from './ffmpeg'

const run = promisify(execFile)

/**
 * The contract suite. It does not test FFmpeg; it tests that the flags this
 * server relies on still do what it believes, on the exact build it is pinned
 * to. It makes a real HEVC file, remuxes it, and reads the result back.
 */
describe('ffmpeg contract', function () {
  this.timeout(120000)

  const ffmpegPath = serverConfig.ffmpegPath
  const ffprobePath = ffmpegPath.replace(/ffmpeg$/, 'ffprobe')
  let workDir = ''
  let hasFfmpeg = false
  let hasHevc = false

  before(async function () {
    try {
      await probeFfmpeg(ffmpegPath)
      hasFfmpeg = true
      const encoders = await ffmpegEncoders(ffmpegPath)
      hasHevc = encoders.has('libx265')
    } catch {
      hasFfmpeg = false
    }
    if (!hasFfmpeg) {
      this.skip()
      return
    }
    workDir = await mkdtemp(join(tmpdir(), 'gsFfmpeg-'))
  })

  after(async function () {
    if (workDir !== '') await rm(workDir, { recursive: true, force: true })
  })

  it('is the pinned build', async function () {
    const build = await assertPinnedFfmpeg(
      ffmpegPath,
      serverConfig.ffmpegVersion
    )
    expect(build.version).equals(serverConfig.ffmpegVersion)
  })

  it('refuses a build that is not the pinned one', async function () {
    let threw = false
    try {
      await assertPinnedFfmpeg(ffmpegPath, '0.0.0-not-real')
    } catch (error) {
      threw = true
      expect(String(error)).contains('pinned')
    }
    expect(threw).equals(true)
  })

  it('never transcodes: the arguments always copy', function () {
    const args = remuxToHlsArgs({ input: 'in.mp4', outDir: '/tmp/out' })
    expect(args).contains('-c')
    expect(args[args.indexOf('-c') + 1]).equals('copy')
    // Anything that would re-encode must be absent.
    for (const forbidden of ['libx264', 'libx265', '-crf', '-b:v', '-preset']) {
      expect(args).does.not.contain(forbidden)
    }
  })

  it('tags HEVC as hvc1, which Safari needs', function () {
    const args = remuxToHlsArgs({ input: 'in.mp4', outDir: '/tmp/out' })
    expect(args[args.indexOf('-tag:v') + 1]).equals('hvc1')
  })

  it('writes segments through a temporary file', function () {
    const args = remuxToHlsArgs({ input: 'in.mp4', outDir: '/tmp/out' })
    expect(args[args.indexOf('-hls_flags') + 1]).contains('temp_file')
  })

  it('remuxes real HEVC to fMP4 HLS without re-encoding it', async function () {
    if (!hasHevc) this.skip()
    const source = join(workDir, 'source.mp4')
    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=none',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        source
      ],
      { maxBuffer: 1 << 22 }
    )

    const before = await probeVideoStream(ffprobePath, source)
    expect(before.codecName).equals('hevc')

    await remuxToHls(ffmpegPath, { input: source, outDir: workDir })

    const playlist = await readFile(join(workDir, 'master.m3u8'), 'utf8')
    expect(playlist).contains('#EXTM3U')
    expect(playlist).contains('init.mp4')
    expect(playlist).contains('.m4s')

    // A fragmented segment carries no `moov`, so it cannot be read on its own.
    // A player fetches `init.mp4` first and then the segments; joining the two
    // is the same thing, and it proves the init and the fragment agree.
    const joined = join(workDir, 'joined.mp4')
    await writeFile(
      joined,
      Buffer.concat([
        await readFile(join(workDir, 'init.mp4')),
        await readFile(join(workDir, 'segment00000.m4s'))
      ])
    )
    const after = await probeVideoStream(ffprobePath, joined)
    // The picture must be untouched: same codec, same size, hvc1 tag intact.
    expect(after.codecName).equals('hevc')
    expect(after.codecTag).equals('hvc1')
    expect(after.width).equals(before.width)
    expect(after.height).equals(before.height)
  })
})
