import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { makeId } from '../../common/ids'
import { makeDatabase } from '../db/database'
import {
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  remuxToHls,
  VIDEO_FILE
} from '../media/ffmpeg'
import { spaceConfigured } from '../media/spacesHls'
import {
  uploadVideoDirectory,
  verifyVideoDirectory
} from '../media/spacesVideo'
import { serverConfig } from '../serverConfig'

const run = promisify(execFile)

/**
 * Puts a recording that arrived on a disk into the library.
 *
 * The side door. There is no upload endpoint — the only things that write a
 * `videos` row are the PeerTube importer and the live controller — and the
 * cameras whose files sit on the archive went through neither. They
 * are also **H.264**, which the live path refuses outright, so even a
 * hand-made live stream would not take them.
 *
 *   npm run import-video -- \
 *     --file "<archive>/2026-05-19/…-1st.mov" \
 *     --game gam_demo000000000004 \
 *     --title "2026-05-19 Hawks vs Cyclones 1st"
 *
 * What it does, in the order that makes each step safe to repeat:
 *
 * 1. Reads the file: codec, shape, and how long it really is.
 * 2. Remuxes it to the shape everything downstream expects — one fragmented
 *    MP4 with a byte-range playlist — **without re-encoding it**, and tagged
 *    as the codec it actually is.
 * 3. Puts it in the Space and checks every file arrived, the same way a
 *    finished live recording is checked.
 * 4. Writes the row, last, so a row never names bytes that are not there.
 *
 * The start time comes from the file's name, which for these cameras is the
 * moment the recording began in Pacific time — `2026-05-19-16-43-46-1st.mov`.
 * That is `obsFilename` in the start-time ladder: low trust, stated plainly,
 * and it is why `--start` exists to override it.
 */

interface Args {
  file: string
  game: string
  title: string
  start?: string
  kind: 'program' | 'combined'
  dryRun: boolean
  databaseUrl: string
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  const file = get('file')
  const game = get('game')
  const title = get('title')
  if (file == null || game == null || title == null) {
    throw new Error(
      'usage: import-video --file <path> --game <gameId> --title <title> ' +
        '[--start <iso>] [--kind program|combined] [--database <url>] [--dry-run]'
    )
  }
  return {
    file,
    game,
    title,
    start: get('start'),
    kind: get('kind') === 'combined' ? 'combined' : 'program',
    dryRun: argv.includes('--dry-run'),
    databaseUrl: get('database') ?? serverConfig.databaseUrl
  }
}

interface Probed {
  codecName: string
  width: number
  height: number
  durationSec: number
}

async function probe(file: string): Promise<Probed> {
  // Beside the pinned ffmpeg, which is the build every other measurement
  // here was taken with.
  const ffprobe = serverConfig.ffmpegPath.replace(/ffmpeg$/, 'ffprobe')
  const { stdout } = await run(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file
  ])
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number }>
    format?: { duration?: string }
  }
  const stream = parsed.streams?.[0]
  if (stream?.codec_name == null) throw new Error(`no video stream in ${file}`)
  return {
    codecName: stream.codec_name,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    durationSec: Math.round(Number(parsed.format?.duration ?? 0))
  }
}

/**
 * The tag the track must keep.
 *
 * HEVC needs `hvc1` or Safari refuses it. H.264 must stay `avc1`: a track
 * tagged as a codec it is not plays nowhere at all.
 */
function tagFor(codecName: string): string | null {
  if (codecName === 'hevc' || codecName === 'h265') return 'hvc1'
  if (codecName === 'h264' || codecName === 'avc1') return 'avc1'
  return null
}

/** Where every one of these recordings was made, whatever machine reads it. */
const CAMERA_ZONE = 'America/Los_Angeles'

/**
 * `2026-05-19-16-43-46-1st.mov` → that instant.
 *
 * Read as **Pacific**, explicitly, and not as the clock of whatever machine
 * happens to run this. The importer runs on the server now, which keeps UTC:
 * reading the name in the machine's own zone would put every camera seven
 * hours out from the game it belongs to, and a video on the wrong minute
 * takes every highlight with it.
 *
 * Two steps, because a zone's offset depends on the instant you are asking
 * about: guess that the name is UTC, ask what that instant looks like in
 * Pacific, and correct by the difference. March is standard time here and
 * June is not.
 */
export function startFromName(name: string): Date | null {
  const match =
    /(\d{4})-(\d{2})-(\d{2})[-_ ](\d{2})[-_](\d{2})[-_](\d{2})/.exec(name)
  if (match == null) return null
  const [, year, month, day, hour, minute, second] = match
  const guess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
  if (Number.isNaN(guess)) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMERA_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(guess))
  const read = (type: string): number =>
    Number(parts.find(one => one.type === type)?.value ?? '0')
  const asPacific = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second')
  )
  return new Date(guess - (asPacific - guess))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const probed = await probe(args.file)
  const videoTag = tagFor(probed.codecName)
  const startAt =
    args.start != null ? new Date(args.start) : startFromName(args.file)
  if (startAt == null) {
    throw new Error(
      'no start time: the file name carries none, so pass --start <iso>'
    )
  }

  console.log(args.file)
  console.log(
    `  ${probed.codecName} ${probed.width}x${probed.height}, ` +
      `${probed.durationSec}s, tagged ${videoTag ?? 'as it is'}`
  )
  console.log(`  starts ${startAt.toISOString()} (${startAt.toString()})`)
  if (args.dryRun) return

  const { space } = serverConfig
  if (!spaceConfigured(space)) throw new Error('no Space is configured')

  const videoId = makeId('video')
  const work = await mkdtemp(join(tmpdir(), `gsImport-${videoId}-`))
  const db = makeDatabase(args.databaseUrl)
  try {
    // Before anything is moved. The row is written at the end, and a database
    // that cannot be reached then has already cost a two-gigabyte upload.
    await db.selectFrom('videos').select('id').limit(1).execute()

    console.log('  remuxing (no re-encode)…')
    await remuxToHls(serverConfig.ffmpegPath, {
      input: args.file,
      outDir: work,
      videoTag
    })

    const files = [MASTER_PLAYLIST, MEDIA_PLAYLIST, VIDEO_FILE]
    console.log('  uploading to the Space…')
    const uploaded = await uploadVideoDirectory({
      space,
      videoId,
      dir: work,
      files
    })
    const verified = await verifyVideoDirectory({
      space,
      videoId,
      dir: work,
      files: uploaded.files
    })
    if (!verified.ok)
      throw new Error(`the Space did not verify: ${verified.reason}`)
    console.log(
      `  ${uploaded.files.length} files, ${uploaded.bytes} bytes, verified`
    )

    const now = new Date()
    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: args.game,
        kind: args.kind,
        title: args.title,
        storage: 'spaces',
        status: 'ready',
        start_at: startAt,
        // The name is the only thing that says when this began, and it says
        // it in local time with no zone of its own. Low trust, recorded as
        // such, so a bad batch can be found again.
        start_at_source: args.start != null ? 'manual' : 'obsFilename',
        duration_sec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        num_cameras: 1,
        hidden: false,
        size_bytes: String(uploaded.bytes),
        spaces_verified_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    console.log(`  imported as ${videoId}`)
  } finally {
    await db.destroy()
    await rm(work, { recursive: true, force: true })
  }
}

// Only when this file is the program. Another script importing a helper from
// here should get the helper, not a run of the whole thing — which is what
// happened the first time one of these imported `readArchive`.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
