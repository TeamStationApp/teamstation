import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * What the library actually holds, game by game.
 *
 * A recording of one game should be up to six things: the live stream, the
 * primary output, the three cameras — first, third, home — and the
 * pre-rendered composite. This walks every season and says which of the six
 * each game has, which it has **twice**, and which of its videos are none of
 * them.
 *
 *   npm run audit-videos                > /tmp/audit.md
 *   npm run audit-videos -- --database <url>
 *
 * It classifies by **title and metadata**, because that is all there is: the
 * files carry no marking that says which camera they came from, and nothing
 * in the schema does either. Where a title is wrong the audit is wrong with
 * it, and the one case known to be wrong is called out in the output rather
 * than quietly corrected.
 */

export type Slot =
  'live' | 'main' | 'first' | 'third' | 'home' | 'multiAngle' | 'other'

export const SLOT_NAMES: Record<Slot, string> = {
  live: 'Live',
  main: 'Primary',
  first: 'First',
  third: 'Third',
  home: 'Home',
  multiAngle: 'Multi-angle',
  other: 'Other'
}

export interface VideoRow {
  id: string
  title: string
  kind: string
  status: string
  numCameras: number
  startAtSource: string | null
  durationSec: number | null
  startAt: Date | null
}

/**
 * Which of the six a video is.
 *
 * Live first, because a live recording's title is a timestamp and carries no
 * game name to take a suffix off. Then the composite, whose word has changed
 * four times — `- Raw Videos` and `trivid` in 2025, `raw` through the
 * spring, `combined` since September — and then the cameras. Anything left
 * whose title ends in some form of "partial" is a part upload, which is a
 * real thing in this library and not a camera; everything else is the
 * primary output.
 */
export function slotOf(video: VideoRow): { slot: Slot; why: string } {
  const title = video.title.trim()
  const lower = title.toLowerCase()

  // A part recording is not one of the six. Some are live streams that caught
  // a few minutes and stopped, some are uploads that did not finish; either
  // way the game does not have that thing, it has a piece of it, and counting
  // one as the real article would say a game is covered when it is not.
  if (/\(?\bpartial\)?$/i.test(lower)) {
    const live = video.kind === 'live' || video.startAtSource === 'liveSession'
    return { slot: 'other', why: live ? 'part live recording' : 'part upload' }
  }

  if (
    video.kind === 'live' ||
    video.startAtSource === 'liveSession' ||
    /^(npll )?live(stream)?\b/i.test(title) ||
    / — (gs director|camera \d+)$/i.test(title) ||
    /[- ]livestream$/i.test(lower)
  ) {
    return { slot: 'live', why: 'live stream' }
  }
  if (
    video.numCameras > 1 ||
    / - raw videos$/i.test(lower) ||
    /(^| )(raw|combined|quadvid|trivid)$/i.test(lower)
  ) {
    return { slot: 'multiAngle', why: 'composite' }
  }
  if (/(^| )1st$/i.test(lower)) return { slot: 'first', why: 'camera' }
  if (/(^| )3rd$/i.test(lower)) return { slot: 'third', why: 'camera' }
  // The camera behind the plate points at home, and `home` is what it is
  // called. Takes that named it `mound` are the same angle under an older
  // name and count as the same thing.
  if (/(^| )(home|mound)$/i.test(lower)) return { slot: 'home', why: 'camera' }
  return { slot: 'main', why: 'primary output' }
}

const ORDER: Slot[] = ['live', 'main', 'first', 'third', 'home', 'multiAngle']

/** The date a title begins with, where it begins with one. */
export function titleDate(title: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(title.trim())
  return match == null ? null : `${match[1]}-${match[2]}-${match[3]}`
}

interface Row {
  seasonName: string | null
  seasonYear: number | null
  gameId: string | null
  gameStart: Date | null
  home: string | null
  away: string | null
  video: VideoRow
}

function dateOf(at: Date | null): string {
  if (at == null) return '—'
  // Pacific, which is where every one of these was played.
  return at.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

function mark(count: number): string {
  if (count === 0) return '·'
  if (count === 1) return '✓'
  return `**${count}**`
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--database')
  const databaseUrl =
    at === -1 ? serverConfig.databaseUrl : process.argv[at + 1]
  const db = makeDatabase(databaseUrl)
  try {
    const rows = (await db
      .selectFrom('videos')
      .leftJoin('games', 'games.id', 'videos.game_id')
      .leftJoin('seasons', 'seasons.id', 'games.season_id')
      .leftJoin('teams as home', 'home.id', 'games.home_team_id')
      .leftJoin('teams as away', 'away.id', 'games.away_team_id')
      .select([
        'seasons.name as seasonName',
        'seasons.year as seasonYear',
        'games.id as gameId',
        'games.start_at as gameStart',
        'home.name as home',
        'away.name as away',
        'videos.id as id',
        'videos.title as title',
        'videos.kind as kind',
        'videos.status as status',
        'videos.num_cameras as numCameras',
        'videos.start_at_source as startAtSource',
        'videos.duration_sec as durationSec',
        'videos.start_at as startAt'
      ])
      .where('videos.hidden', '=', false)
      .orderBy('games.start_at')
      .orderBy('videos.title')
      .execute()) as unknown as Array<
      Omit<Row, 'video'> & VideoRow & { gameStart: Date | null }
    >

    const games = new Map<
      string,
      {
        seasonName: string
        seasonYear: number | null
        gameId: string
        gameStart: Date | null
        home: string | null
        away: string | null
        videos: Array<VideoRow & { slot: Slot; why: string }>
      }
    >()
    const orphans: Array<VideoRow & { slot: Slot; why: string }> = []

    for (const row of rows) {
      const video: VideoRow = {
        id: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status,
        numCameras: row.numCameras,
        startAtSource: row.startAtSource,
        durationSec: row.durationSec,
        startAt: row.startAt
      }
      const placed = { ...video, ...slotOf(video) }
      if (row.gameId == null) {
        orphans.push(placed)
        continue
      }
      const held = games.get(row.gameId)
      if (held == null) {
        games.set(row.gameId, {
          seasonName: row.seasonName ?? 'No season',
          seasonYear: row.seasonYear,
          gameId: row.gameId,
          gameStart: row.gameStart,
          home: row.home,
          away: row.away,
          videos: [placed]
        })
      } else held.videos.push(placed)
    }

    const bySeason = new Map<string, Array<ReturnType<typeof games.get>>>()
    for (const game of games.values()) {
      const key = `${game.seasonYear ?? ''} ${game.seasonName}`
      const list = bySeason.get(key) ?? []
      list.push(game)
      bySeason.set(key, list)
    }

    const out: string[] = []
    const now = new Date()
    out.push('# GameStation video audit')
    out.push('')
    out.push(
      `Every video in the library, by game, as of ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
    )
    out.push('')
    out.push(
      'A recording of one game should be up to six things: the **live** stream,',
      'the **primary** output, the three cameras — **first**, **third**,',
      '**home** — and the pre-rendered **multi-angle** composite.',
      'Each row says which of the six that game has. `✓` is one, a **bold**',
      'number is more than one of the same thing, and `·` is none.'
    )
    out.push('')
    out.push(
      'Classified by title and metadata, because that is all there is: no file',
      'carries a marking that says which camera it came from, and neither does',
      'the schema. The composite has been called four different things —',
      '`- Raw Videos` and `trivid` in 2025, `raw` through the spring,',
      '`combined` since September — and all four are counted as one.'
    )
    out.push('')

    // ---- what is wrong, before the tables nobody reads twice -------------
    const twice: string[] = []
    const misnamed: string[] = []
    const partials: string[] = []
    let fourUp = 0
    for (const game of games.values()) {
      const label = `${dateOf(game.gameStart)} ${game.away ?? '?'} at ${game.home ?? '?'}`
      const counts = new Map<Slot, number>()
      for (const video of game.videos) {
        counts.set(video.slot, (counts.get(video.slot) ?? 0) + 1)
      }
      // What the multi-camera view was built for: a primary output and all
      // three cameras, which is a game that opens four-up.
      if (
        (['main', 'first', 'third', 'home'] as Slot[]).every(
          slot => (counts.get(slot) ?? 0) > 0
        )
      ) {
        fourUp += 1
      }
      for (const slot of ORDER) {
        if ((counts.get(slot) ?? 0) > 1) {
          twice.push(
            `**${label}** — ${counts.get(slot)} × ${SLOT_NAMES[slot].toLowerCase()}: ` +
              game.videos
                .filter(one => one.slot === slot)
                .map(one => `\`${one.title}\``)
                .join(', ')
          )
        }
      }
      for (const video of game.videos) {
        const claimed = titleDate(video.title)
        if (claimed != null && claimed !== dateOf(game.gameStart)) {
          misnamed.push(`**${label}** — \`${video.title}\` names ${claimed}`)
        }
        if (video.slot === 'other') {
          partials.push(`**${label}** — \`${video.title}\` (${video.why})`)
        }
      }
    }

    out.push('## What this found')
    out.push('')
    out.push(
      `- **${twice.length} duplicated slots** — a game holding two of the same thing.`,
      `- **${misnamed.length} titles naming a different day** from the game they hang on.`,
      `- **${partials.length} part recordings**, which are none of the six.`,
      `- **${orphans.length} videos attached to no game at all**, so on no page.`,
      `- **${fourUp} games that open four-up** — a primary output and all ` +
        'three cameras.'
    )
    out.push('')
    if (twice.length > 0) {
      out.push('### Two of the same thing')
      out.push('')
      for (const line of twice) out.push(`- ${line}`)
      out.push('')
    }
    if (misnamed.length > 0) {
      out.push('### A title naming another day')
      out.push('')
      out.push(
        'The importer matches a video to a game by **when it was recorded**, not',
        'by what it is called, so these are attached where their timestamps say',
        'they belong. Where one is also a duplicate, the title is the thing that',
        'is wrong, not the attachment.'
      )
      out.push('')
      for (const line of misnamed) out.push(`- ${line}`)
      out.push('')
    }
    if (partials.length > 0) {
      out.push('### Part recordings')
      out.push('')
      for (const line of partials) out.push(`- ${line}`)
      out.push('')
    }

    // ---- the summary, season by season -----------------------------------
    out.push('## Seasons')
    out.push('')
    const seasonGames = await db
      .selectFrom('games')
      .leftJoin('seasons', 'seasons.id', 'games.season_id')
      .select(({ fn }) => [
        'seasons.name as seasonName',
        'seasons.year as seasonYear',
        fn.count<number>('games.id').as('games')
      ])
      .groupBy(['seasons.name', 'seasons.year'])
      .execute()
    const played = new Map(
      seasonGames.map(one => [
        `${one.seasonYear ?? ''} ${one.seasonName ?? 'No season'}`,
        Number(one.games)
      ])
    )

    out.push(
      '| Season | Games | With video | Live | Primary | First | Third | Home | Multi | Duplicated | Unclassified |'
    )
    out.push(
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
    )
    const seasonKeys = [...bySeason.keys()].sort()
    for (const key of seasonKeys) {
      const list = bySeason.get(key) ?? []
      const totals: Record<string, number> = {}
      let duplicated = 0
      let unclassified = 0
      for (const game of list) {
        if (game == null) continue
        const counts = new Map<Slot, number>()
        for (const video of game.videos) {
          counts.set(video.slot, (counts.get(video.slot) ?? 0) + 1)
        }
        for (const slot of ORDER) {
          if ((counts.get(slot) ?? 0) > 0)
            totals[slot] = (totals[slot] ?? 0) + 1
          if ((counts.get(slot) ?? 0) > 1) duplicated += 1
        }
        unclassified += counts.get('other') ?? 0
      }
      out.push(
        `| ${key.trim()} | ${played.get(key) ?? '—'} | ${list.length} | ` +
          `${ORDER.map(slot => totals[slot] ?? 0).join(' | ')} | ` +
          `${duplicated} | ${unclassified} |`
      )
    }
    out.push('')

    // ---- every game ------------------------------------------------------
    for (const key of seasonKeys) {
      const list = (bySeason.get(key) ?? []).filter(one => one != null)
      out.push(`## ${key.trim()}`)
      out.push('')
      out.push(
        '| Date | Game | Live | Primary | First | Third | Home | Multi | Notes |'
      )
      out.push('| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |')
      list.sort(
        (a, b) =>
          (a?.gameStart?.getTime() ?? 0) - (b?.gameStart?.getTime() ?? 0)
      )
      for (const game of list) {
        if (game == null) continue
        const counts = new Map<Slot, number>()
        for (const video of game.videos) {
          counts.set(video.slot, (counts.get(video.slot) ?? 0) + 1)
        }
        const notes: string[] = []
        for (const slot of ORDER) {
          const count = counts.get(slot) ?? 0
          if (count < 2) continue
          const same = game.videos.filter(one => one.slot === slot)
          const which = same.map(one => `\`${one.title}\``).join(', ')
          // Same length to the second and the same start: one recording
          // uploaded twice, whatever the two titles say.
          const identical =
            same.every(
              one =>
                one.durationSec === same[0].durationSec &&
                one.startAt?.getTime() === same[0].startAt?.getTime()
            ) && same[0].durationSec != null
          notes.push(
            `${count} × ${SLOT_NAMES[slot].toLowerCase()}: ${which}` +
              (identical
                ? ' — same length and start, so one recording twice'
                : '')
          )
        }
        // A title that names a different day from the game it is attached to.
        const gameDay = dateOf(game.gameStart)
        for (const video of game.videos) {
          const claimed = titleDate(video.title)
          if (claimed != null && claimed !== gameDay) {
            notes.push(
              `\`${video.title}\` names ${claimed}, this game is ${gameDay}`
            )
          }
        }
        for (const video of game.videos.filter(one => one.slot === 'other')) {
          notes.push(`unclassified: \`${video.title}\` (${video.why})`)
        }
        for (const video of game.videos.filter(
          one => one.status !== 'ready' && one.status !== 'live'
        )) {
          notes.push(`\`${video.title}\` is ${video.status}`)
        }
        const teams =
          game.away != null && game.home != null
            ? `${game.away} at ${game.home}`
            : game.gameId
        out.push(
          `| ${dateOf(game.gameStart)} | ${teams} | ${ORDER.map(slot => mark(counts.get(slot) ?? 0)).join(' | ')} | ${notes.join('; ')} |`
        )
      }
      out.push('')
    }

    // ---- the leftovers ---------------------------------------------------
    if (orphans.length > 0) {
      out.push('## Videos attached to no game')
      out.push('')
      out.push(
        `${orphans.length} of them. A video with no game is in the library and`,
        'on no page: nothing links to it, and the multi-camera view cannot see',
        'it either.'
      )
      out.push('')
      out.push('| Title | Reads as | Status | Length |')
      out.push('| --- | --- | --- | ---: |')
      for (const video of orphans) {
        const length =
          video.durationSec == null ? '—' : `${Math.round(video.durationSec)}s`
        out.push(
          `| ${video.title} | ${SLOT_NAMES[video.slot]} | ${video.status} | ${length} |`
        )
      }
      out.push('')
    }

    console.log(out.join('\n'))
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
