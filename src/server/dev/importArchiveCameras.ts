import { execFile } from 'node:child_process'
import {
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { titleSaysLive } from './auditVideos'

const run = promisify(execFile)

/**
 * The camera angles for a whole season, off the archive.
 *
 * The library grew up one upload at a time: a program output, sometimes a
 * pre-rendered composite of the cameras, and — until this — never the cameras
 * themselves. They have been on the archive all along, named with the
 * Pacific time the recording started:
 *
 *   2026-05-19/2026-05-19-16-43-46-1st.mov
 *
 * This walks the games of the named seasons in date order and, for each,
 * imports whatever of the four the archive has and the library has not. Then,
 * once every camera on the take is in the library, it takes down the things
 * they replace: the composite, and — where the game has a primary output —
 * the live recording.
 *
 * The bytes cross the uplink **once**, to the server, which then remuxes them
 * and copies them into object storage.
 * Routing through the server matches the rest of the pipeline.


 * `--local` keeps the old behaviour for a machine with no server to hand.
 *
 * Games are walked in the audit's own order — season by season, and by date
 * within a season — so a run that is interrupted has finished whole seasons
 * rather than a scattering of days.
 *
 *   npm run import-archive -- --seasons "<season>,<season>" --dry-run
 *   npm run import-archive -- --seasons "<season>,<season>"
 *
 * **Taking down is hiding, not deleting.** A hidden video is on no page and in
 * no picker, which is what "no longer referenced" means to anybody looking at
 * the site — and it survives the next PeerTube import, which would simply
 * re-create a row that had been deleted and undo the whole job. The files are
 * never touched, here or in PeerTube.
 *
 * It is safe to run twice: everything it does is worked out from what is
 * already there, so a run that dies half way is resumed by running it again.
 */

const VOLUME = '/var/app/data/archives'
/** Where the file lands on the server while it is being taken in. */
const SCRATCH = '/var/app/work/import'
/** The deployed tree whose `node_modules` and configuration the import uses. */
const REMOTE_APP = '/var/app/current'
const REMOTE_NODE = '/var/app/node/bin'

/** One argument, safe for a remote shell. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}
const ARCHIVES = ['Example Fall', 'Example Spring', 'Example Summer']
/**
 * The suffixes that are a camera, and what to call them.
 *
 * The third camera points at home plate, so `home` is its name. Most takes
 * in the archive call it `mound` — it stands near the mound, which is what the
 * operator named it after — and that is the same angle under an older name,
 * so it is imported as `home` like everything else.
 */
const CAMERAS = ['1st', '3rd', 'home', 'mound'] as const
const CAMERA_NAMES: Record<string, string> = {
  '1st': '1st',
  '3rd': '3rd',
  home: 'home',
  mound: 'home'
}

/**
 * The cameras a take actually holds, under the names the library uses.
 *
 * `mound` and `home` are the same angle, so a take that only has a `mound`
 * file still needs `home` in the library before its mosaic comes down.
 */
export function cameraNamesOnTake(suffixes: Iterable<string>): string[] {
  const names = new Set<string>()
  for (const suffix of suffixes) {
    const name = CAMERA_NAMES[suffix]
    if (name != null) names.add(name)
  }
  return [...names]
}

/**
 * Whether a mosaic or live recording should come down after this pass.
 *
 * The cameras replace those, which is only true of a complete set. A failed
 * camera must not hide the mosaic the game still has to fall back on.
 */
export function hideReplaced(options: {
  videoReadsAs: string
  onTake: string[]
  landed: Set<string>
}): boolean {
  const { videoReadsAs, onTake, landed } = options
  if (onTake.length === 0) return false
  if (!onTake.every(name => landed.has(name))) return false
  if (videoReadsAs === 'multiAngle') return true
  return videoReadsAs === 'live' && landed.has('main')
}
/** How far apart two files may be stamped and still be one recording. */
const GROUP_SEC = 5

interface Take {
  dir: string
  /** The instant the recording began, from the file name, in Pacific time. */
  startAt: Date
  files: Map<string, { path: string; bytes: number }>
}

/**
 * Every take in the archive, by when it started.
 *
 * The 2025 season's earliest dates put a space between the date and the time
 * where every later file has a dash — `2025-09-14 15-30-31.mov` — so the
 * separator is either. Those dates pre-date the rig and hold no camera angles
 * to find, but a take that is read is a take that can be reasoned about, and
 * one that is invisible silently reports as nothing to do.
 */
export function readArchive(volume = VOLUME): Take[] {
  const takes = new Map<string, Take>()
  for (const archive of ARCHIVES) {
    let days: string[]
    try {
      days = readdirSync(join(volume, archive))
    } catch {
      continue
    }
    for (const day of days) {
      const dir = join(volume, archive, day)
      let entries: string[]
      try {
        if (!statSync(dir).isDirectory()) continue
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const file of entries) {
        const stamp =
          /^(\d{4})-(\d{2})-(\d{2})[-_ ](\d{2})[-_](\d{2})[-_](\d{2})(?:[-_ ]([A-Za-z0-9]+))?\.(?:mov|mp4)$/i.exec(
            file
          )
        if (stamp == null) continue
        const [, year, month, day2, hour, minute, second, suffix] = stamp
        // Local components, so the zone rules for that date apply — March is
        // standard time here and June is not, and an hour either way puts a
        // camera an hour out from the game it belongs to.
        const startAt = new Date(
          Number(year),
          Number(month) - 1,
          Number(day2),
          Number(hour),
          Number(minute),
          Number(second)
        )
        // One take's files do not always carry the same second: on
        // 2026-08-09 the three cameras are stamped a second after the
        // primary output and its composite. Keyed on the exact instant that
        // day reads as two takes, and the one the game matches holds no
        // cameras at all — so the cameras are never seen.
        const near = [...takes.values()].find(
          one =>
            one.dir === dir &&
            Math.abs(one.startAt.getTime() - startAt.getTime()) <=
              GROUP_SEC * 1000
        )
        const held = near ?? { dir, startAt, files: new Map() }
        held.files.set(suffix ?? 'main', {
          path: join(dir, file),
          bytes: statSync(join(dir, file)).size
        })
        // The earliest stamp names the take, so a re-read groups the same way.
        if (startAt.getTime() < held.startAt.getTime()) held.startAt = startAt
        takes.set(held.startAt.toISOString(), held)
        if (near != null && near.startAt.getTime() !== held.startAt.getTime()) {
          takes.delete(near.startAt.toISOString())
        }
      }
    }
  }
  return [...takes.values()].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime()
  )
}

/** What a video's title says it is. Kept in step with `auditVideos.ts`. */
function reads(title: string, kind: string, source: string | null): string {
  const lower = title.trim().toLowerCase()
  if (
    kind === 'live' ||
    source === 'liveSession' ||
    titleSaysLive(title) ||
    / — (gs director|camera \d+)$/i.test(lower) ||
    // `2026-03-25 Hawks vs Mid City 1 - livestream`: a live recording that
    // wears the game's name and puts the word at the end. The audit knew
    // about this one and this did not, so that game kept a dead livestream
    // beside its four angles.
    /[- ]livestream$/i.test(lower)
  ) {
    return 'live'
  }
  if (/\(?\bpartial\)?$/i.test(lower)) return 'partial'
  if (
    / - raw videos$/i.test(lower) ||
    /(^| )(raw|combined|quadvid|trivid)$/i.test(lower)
  ) {
    return 'multiAngle'
  }
  for (const camera of CAMERAS) {
    if (new RegExp(`(^| )${camera}$`, 'i').test(lower)) {
      return CAMERA_NAMES[camera] ?? camera
    }
  }
  return 'main'
}

/**
 * One run at a time.
 *
 * Two copies of this racing each other is not a theoretical worry: it
 * happened, and the two interleaved their output into one log so that a
 * working run looked like a failing one for twenty minutes.
 */
const LOCK = '/tmp/tsImportArchive.lock'

function takeTheLock(): void {
  try {
    const held = Number(readFileSync(LOCK, 'utf8').trim())
    // Signal 0 asks whether the process exists without disturbing it.
    process.kill(held, 0)
    throw new Error(
      `another run already has this (pid ${held}); stop it first or remove ${LOCK}`
    )
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ESRCH') throw error
  }
  writeFileSync(LOCK, String(process.pid))
  const drop = (): void => {
    try {
      unlinkSync(LOCK)
    } catch {}
  }
  process.on('exit', drop)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  const dryRun = argv.includes('--dry-run')
  const local = argv.includes('--local')
  const host = get('host') ?? 'user@example.com'
  // Which seasons is the operator's to say, not the source's: a default
  // would put a real league's season names in a public repository.
  const seasonList = get('seasons') ?? ''
  if (seasonList === '') {
    throw new Error('--seasons needs a comma-separated list of season names')
  }
  const seasons = seasonList.split(',')
  const databaseUrl = get('database') ?? serverConfig.databaseUrl
  if (!dryRun) takeTheLock()
  const db = makeDatabase(databaseUrl)

  try {
    const games = await db
      .selectFrom('games')
      .innerJoin('seasons', 'seasons.id', 'games.season_id')
      .leftJoin('teams as home', 'home.id', 'games.home_team_id')
      .leftJoin('teams as away', 'away.id', 'games.away_team_id')
      .select([
        'games.id as id',
        'games.start_at as startAt',
        'seasons.name as season',
        'home.name as home',
        'away.name as away'
      ])
      .where('seasons.name', 'in', seasons)
      .orderBy('seasons.year')
      .orderBy('seasons.name')
      .orderBy('games.start_at')
      .execute()

    const takes = readArchive()
    if (!local && !dryRun) {
      await run('ssh', [host, `mkdir -p ${quoted(SCRATCH)}`])
    }
    let uploaded = 0
    let hidden = 0

    for (const game of games) {
      const videos = await db
        .selectFrom('videos')
        .select([
          'id',
          'title',
          'kind',
          'status',
          'start_at',
          'start_at_source'
        ])
        .where('game_id', '=', game.id)
        .where('hidden', '=', false)
        .execute()
      if (videos.length === 0) continue

      // The take whose own start is within two minutes of something this game
      // already holds. Matching on the clock rather than on the title is what
      // keeps two games on one day, or two takes on one day, apart.
      const known = videos
        .map(one => one.start_at)
        .filter((one): one is Date => one != null)
        .map(one => one.getTime())
      const take = takes.find(one =>
        known.some(at => Math.abs(at - one.startAt.getTime()) < 120_000)
      )
      const label = `${game.startAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })} ${game.away ?? '?'} at ${game.home ?? '?'}`
      if (take == null) {
        console.log(`${label}: no take in the archive`)
        continue
      }

      const have = new Set(
        videos.map(one => reads(one.title, one.kind, one.start_at_source))
      )
      const wanted = ['main', ...CAMERAS].filter(
        kind => take.files.has(kind) && !have.has(CAMERA_NAMES[kind] ?? kind)
      )
      const bytes = wanted.reduce(
        (sum, kind) => sum + (take.files.get(kind)?.bytes ?? 0),
        0
      )
      console.log(
        `${label}: ${wanted.length === 0 ? 'nothing to add' : `add ${wanted.join(', ')} (${(bytes / 1e9).toFixed(1)} GB)`}`
      )
      if (dryRun) continue

      const held = new Set(have)
      let added = 0
      for (const kind of wanted) {
        const file = take.files.get(kind)
        if (file == null) continue
        const base = videos.find(
          one => reads(one.title, one.kind, one.start_at_source) === 'main'
        )
        const title =
          kind === 'main'
            ? `${label.slice(0, 10)} ${game.away} vs ${game.home}`
            : `${(base?.title ?? label).trim()} ${CAMERA_NAMES[kind] ?? kind}`
        try {
          if (local) {
            await run(
              process.execPath,
              [
                // Resolved from this file, not from the working directory:
                // the run is started from wherever the configuration
                // lives, which is not inside the repository.
                '-r',
                require.resolve('sucrase/register'),
                join(__dirname, 'importVideoFile.ts'),
                '--file',
                file.path,
                '--game',
                game.id,
                '--title',
                title,
                '--database',
                databaseUrl
              ],
              { cwd: process.cwd(), maxBuffer: 1 << 24 }
            )
          } else {
            const landed = `${SCRATCH}/${file.path.split('/').pop() ?? 'video.mov'}`
            // One hop for the bytes. The server has the fast end of the wire
            // to the Space and the configuration that says where it is.
            await run(
              '/bin/sh',
              [
                '-c',
                `ssh -o Compression=no ${host} ${quoted(`cat > ${quoted(landed)}`)} < ${quoted(file.path)}`
              ],
              { maxBuffer: 1 << 24 }
            )
            try {
              await run(
                'ssh',
                [
                  host,
                  // The built copy, not the source: `appConfig` looks two
                  // directories up from the file asking for `config.json`,
                  // which finds it from `lib/server/` and falls one level
                  // short from `server/`.
                  `cd ${REMOTE_APP} && PATH=${REMOTE_NODE}:$PATH node ` +
                    `lib/server/dev/importVideoFile.js --file ${quoted(landed)} ` +
                    `--game ${quoted(game.id)} --title ${quoted(title)}`
                ],
                { maxBuffer: 1 << 24 }
              )
            } finally {
              // Whatever happened, the copy on the server goes: it is a
              // staging post, and the archive still has the original.
              await run('ssh', [host, `rm -f ${quoted(landed)}`]).catch(
                () => undefined
              )
            }
          }
          console.log(`  ${kind}: in`)
          held.add(CAMERA_NAMES[kind] ?? kind)
          added += 1
          uploaded += 1
        } catch (error) {
          const said = error as { stderr?: string; stdout?: string }
          // Whatever the child actually said, in the order it is worth
          // reading: a truncated command line instead of this is how a
          // failing import used to explain nothing at all.
          const spoke = [said.stderr ?? '', said.stdout ?? ''].map(one =>
            one.trim()
          )
          const why = spoke.find(one => one !== '') ?? String(error)
          console.log(
            `  ${kind}: FAILED — ${why.split('\n').slice(-3).join(' ')}`
          )
        }
      }

      // What the cameras replace, taken down only once the whole set is in.
      const onTake = cameraNamesOnTake(take.files.keys())
      const camerasMissing = !onTake.every(name => held.has(name))
      if (added === 0 && wanted.length > 0 && camerasMissing) continue

      for (const video of videos) {
        const isA = reads(video.title, video.kind, video.start_at_source)
        if (!hideReplaced({ videoReadsAs: isA, onTake, landed: held })) continue
        await db
          .updateTable('videos')
          .set({ hidden: true, updated_at: new Date() })
          .where('id', '=', video.id)
          .execute()
        console.log(`  hidden (${isA}): ${video.title}`)
        hidden += 1
      }
    }

    console.log(`\n${uploaded} imported, ${hidden} taken down`)
  } finally {
    await db.destroy()
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
