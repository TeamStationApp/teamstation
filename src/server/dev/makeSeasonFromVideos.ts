import { makeId } from '../../common/ids'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import { readArchive } from './importArchiveCameras'

/**
 * A season built out of videos nobody has claimed.
 *
 * Every game in this library so far arrived from an import: the schedule
 * came first and the video was matched to it. These did not. Fifteen 2025
 * recordings sit in the library attached to no game at all — in it, and on no
 * page — and the only record of what they are is their own titles:
 *
 *   2025-10-26 Seagulls vs Cedar Lakes
 *   2025-10-26 Seagulls vs Cedar Lakes - Raw Videos
 *
 * So the titles are the source. One game per date, the team named before
 * `vs`, the opponent after it, and the videos of that date attached to it.
 *
 *   npm run make-season -- --team Seagulls --season "NTLL Fall 2025" \
 *     --year 2025 --match "^2025-" --dry-run
 *
 * What it will not do is invent what it cannot read. **Which side was at
 * home is not in any of this**, so the named team is recorded as the home
 * side throughout; where a game was really away, somebody has to say so. And
 * the kick-off time comes from the archive where the recording is
 * still there — the truest thing available — and otherwise from noon on the
 * day the title names, which is honest about knowing the day and not the hour.
 */

interface Parsed {
  day: string
  opponent: string
  /** True for the pre-rendered composite, which is not the main output. */
  composite: boolean
}

/** `2025-10-26 Seagulls vs Cedar Lakes - Raw Videos` → the parts of it. */
export function readTitle(title: string, team: string): Parsed | null {
  const trimmed = title.trim()
  const dated = /^(\d{4}-\d{2}-\d{2})[- ]\s*(.+)$/.exec(trimmed)
  if (dated == null) return null
  const day = dated[1]
  let rest = dated[2]
  const composite =
    / - raw videos$/i.test(rest) || /(^| )(raw|combined)$/i.test(rest)
  rest = rest
    .replace(/ - raw videos$/i, '')
    .replace(/(^| )(raw|combined)$/i, '')
  // A league's name may sit in front of the team's: `QPLL Seagulls vs …`.
  const name = team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const versus = new RegExp(`${name}\\s+vs\\.?\\s+(.+)$`, 'i').exec(rest)
  if (versus == null) return null
  return { day, opponent: versus[1].trim(), composite }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  const team = get('team')
  const seasonName = get('season')
  const year = Number(get('year') ?? '0')
  const match = new RegExp(get('match') ?? '^\\d{4}-')
  const dryRun = argv.includes('--dry-run')
  if (team == null || seasonName == null || year === 0) {
    throw new Error(
      'usage: make-season --team <name> --season <name> --year <year> ' +
        '[--match <regexp>] [--database <url>] [--dry-run]'
    )
  }
  const db = makeDatabase(get('database') ?? serverConfig.databaseUrl)

  try {
    const orphans = await db
      .selectFrom('videos')
      .select(['id', 'title', 'start_at', 'duration_sec'])
      .where('game_id', 'is', null)
      .where('hidden', '=', false)
      .orderBy('title')
      .execute()

    const takes = readArchive()
    const games = new Map<
      string,
      { opponent: string; videos: typeof orphans; startAt: Date; from: string }
    >()

    for (const video of orphans) {
      if (!match.test(video.title)) continue
      const parsed = readTitle(video.title, team)
      if (parsed == null) {
        console.log(`  skipped, cannot read: ${video.title}`)
        continue
      }
      const held = games.get(parsed.day)
      if (held != null) {
        held.videos.push(video)
        continue
      }
      // The recording's own start, where the archive still has it. Noon
      // otherwise: the day is in the title and the hour is not anywhere.
      const take = takes.find(
        one =>
          one.startAt.toLocaleDateString('en-CA', {
            timeZone: 'America/Los_Angeles'
          }) === parsed.day
      )
      const noon = new Date(`${parsed.day}T12:00:00`)
      games.set(parsed.day, {
        opponent: parsed.opponent,
        videos: [video],
        startAt: take?.startAt ?? noon,
        from: take != null ? 'the recording' : 'noon, the title having no hour'
      })
    }

    console.log(
      `${games.size} games from ${[...games.values()].reduce((n, g) => n + g.videos.length, 0)} videos\n`
    )
    for (const [day, game] of [...games].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      console.log(
        `${day} ${team} vs ${game.opponent} — ${game.videos.length} videos, ` +
          `starts ${game.startAt.toISOString()} (${game.from})`
      )
    }
    if (dryRun) return

    // ---- the team, the season, and the teams it holds ---------------------
    const now = new Date()
    let ours = await db
      .selectFrom('teams')
      .select(['id'])
      .where('name', '=', team)
      .executeTakeFirst()
    if (ours == null) {
      const id = makeId('team')
      await db
        .insertInto('teams')
        .values({
          id,
          name: team,
          kind: 'full',
          created_from: 'manual',
          is_managed: true,
          created_at: now,
          updated_at: now
        })
        .execute()
      ours = { id }
      console.log(`\nmade the team ${team} (${id})`)
    }

    let season = await db
      .selectFrom('seasons')
      .select(['id'])
      .where('name', '=', seasonName)
      .where('year', '=', year)
      .executeTakeFirst()
    if (season == null) {
      const id = makeId('season')
      await db
        .insertInto('seasons')
        .values({
          starts_on: `${year}-03-01`,
          ends_on: `${year}-05-31`,
          id,
          name: seasonName,
          year,
          term: 'Fall',
          created_at: now,
          updated_at: now
        })
        .execute()
      season = { id }
      console.log(`made the season ${seasonName} (${id})`)
    }
    await db
      .insertInto('season_teams')
      .values({ season_id: season.id, team_id: ours.id, joined_at: now })
      .onConflict(oc => oc.doNothing())
      .execute()

    // ---- a game per date --------------------------------------------------
    for (const [day, game] of [...games].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      let against = await db
        .selectFrom('teams')
        .select(['id'])
        .where('name', '=', game.opponent)
        .executeTakeFirst()
      if (against == null) {
        const id = makeId('team')
        await db
          .insertInto('teams')
          .values({
            id,
            name: game.opponent,
            // An opponent, not a team anybody here belongs to.
            kind: 'external',
            created_from: 'manual',
            is_managed: false,
            created_at: now,
            updated_at: now
          })
          .execute()
        against = { id }
      }

      const gameId = makeId('game')
      await db
        .insertInto('games')
        .values({
          id: gameId,
          home_team_id: ours.id,
          away_team_id: against.id,
          season_id: season.id,
          start_at: game.startAt,
          status: 'final',
          created_at: now,
          updated_at: now
        })
        .execute()
      for (const video of game.videos) {
        await db
          .updateTable('videos')
          .set({ game_id: gameId, updated_at: now })
          .where('id', '=', video.id)
          .execute()
      }
      console.log(
        `${day}: ${gameId}, ${game.videos.length} videos attached, ` +
          `${team} at home against ${game.opponent}`
      )
    }
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
