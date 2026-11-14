// The tools the integration tier needs on a Linux machine, pinned:
//
//   node scripts/testTools.mjs ffmpeg [--server-config]
//
// downloads the FFmpeg build the tests are written against, checks it, and
// unpacks it into .test-tools/ffmpeg. It prints, as JSON, the binary and its
// version for serverConfig.json (`ffmpegPath`, `ffmpegVersion`) and the `bin`
// directory to put first on PATH, which holds ffmpeg and ffprobe. With
// `--server-config` it also writes those two into serverConfig.json, keeping
// whatever else is there. On a Mac the Homebrew FFmpeg serves instead.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const FFMPEG = {
  url: 'https://github.com/TeamStationApp/teamstation/releases/download/tools-ffmpeg-9.0.2/ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz',
  sha256: '2f787799c77ac8eda96f74fee82e7b18ef8f7c8c57ff99da68cb45046937092c',
  version: 'n9.0.2-39-g7adfbe40dc-20261030'
}

/** Downloads `url`, trying again a few times, and answers its bytes. */
async function download(url, fetchFn, tries = 3) {
  let last
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetchFn(url)
      if (!response.ok) throw new Error(`${url} answered ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      last = error
    }
  }
  throw last
}

/** Unpacks a .tar.xz into `dir`, dropping its top folder. */
function untar(archive, dir) {
  const result = spawnSync(
    'tar',
    ['-xf', archive, '-C', dir, '--strip-components=1'],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`)
}

/**
 * @typedef {{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer> }} Answer
 * @typedef {{
 *   fetchFn?: (url: string) => Promise<Answer>,
 *   extract?: (archive: string, dir: string) => void,
 *   scratch?: string
 * }} InstallOptions
 */

/**
 * Puts the pinned FFmpeg under `root`/.test-tools/ffmpeg and answers where it
 * is. A copy already there is kept.
 * @param {string} root
 * @param {InstallOptions} [options]
 */
export async function installFfmpeg(
  root,
  { fetchFn = globalThis.fetch, extract = untar, scratch = tmpdir() } = {}
) {
  const home = join(resolve(root), '.test-tools', 'ffmpeg')
  const bin = join(home, 'bin')
  const ffmpegPath = join(bin, 'ffmpeg')
  if (!existsSync(ffmpegPath)) {
    const bytes = await download(FFMPEG.url, fetchFn)
    const sum = createHash('sha256').update(bytes).digest('hex')
    if (sum !== FFMPEG.sha256) {
      throw new Error(
        `The FFmpeg download's sha256 is ${sum}, not the pinned ${FFMPEG.sha256}`
      )
    }
    const archive = join(scratch, 'teamstation-ffmpeg.tar.xz')
    writeFileSync(archive, bytes)
    mkdirSync(home, { recursive: true })
    extract(archive, home)
  }
  return { ffmpegPath, ffmpegVersion: FFMPEG.version, bin }
}

/** Writes the FFmpeg settings into `file`, keeping the rest of it. */
export function writeServerConfig(file, ffmpeg) {
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...config,
        ffmpegPath: ffmpeg.ffmpegPath,
        ffmpegVersion: ffmpeg.ffmpegVersion
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 * @param {InstallOptions} [options]
 */
export async function main(argv, root = process.cwd(), options = {}) {
  const [tool, ...flags] = argv
  if (tool !== 'ffmpeg')
    throw new Error('Usage: testTools.mjs ffmpeg [--server-config]')
  const ffmpeg = await installFfmpeg(root, options)
  if (flags.includes('--server-config'))
    writeServerConfig(join(root, 'serverConfig.json'), ffmpeg)
  return ffmpeg
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main(process.argv.slice(2)).then(
    result => {
      process.stdout.write(JSON.stringify(result) + '\n')
    },
    error => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exit(1)
    }
  )
}
