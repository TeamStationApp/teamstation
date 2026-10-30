import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { userIdOfGumbo } from '../common/userId'
import { posterSecond } from '../server/media/posters'
import { stillKey } from '../server/media/stills'
import { demoLocality, type GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'
import {
  fixturePositions,
  seedUmpireCounts,
  seedUmpireTypes
} from './umpireTypes'

/**
 * The long lists world: everything the paging and virtual list scenarios
 * scroll through, on `groupFixture`'s leagues, seasons and teams. The
 * signed-in user is 101, who runs Demo Hawks and Demo League A.
 *
 * - Demo Hawks play every other day for 18 months around today, so the next
 *   game sits in the middle of the list, with a practice a week.
 * - One start is shared by eight games and a practice.
 * - 30 game invitations wait on 101, and 25 sent by 101 wait on the other
 *   side: pending rows in the schedule, and the Pending and Sent notices. 25
 *   more notices are History.
 * - Mookie Betts has plays in games with video, a run of games without, and
 *   hidden plays among them, so a page of his highlights can come up short.
 * - One game has 300 highlights.
 * - Demo League A manages umpires: a Field 2 optional in the regular season
 *   and required in the playoffs, two kinds of note, and assignments.
 * - Demo Visitors in Demo Standalone are the public team and season, with a
 *   private team event a guest must never see.
 *
 * Dates count from today at 18:00 UTC, so a run on another day has the same
 * rows in the same order.
 */
export interface LongListsSeed {
  leagueId: string
  seasonId: string
  playoffsId: string
  teamId: string
  /** The Hawks' first game after today. */
  nextGameId: string
  /** The player with hidden and uncovered highlights. */
  playerId: string
  highlightsGameId: string
  highlightsVideoId: string
  publicTeamId: string
  publicSeasonId: string
  /** The title of the public team's event no guest may see. */
  privateEventTitle: string
  tiedGameIds: string[]
  /** A game in the umpire table past its first page, open to 101. */
  umpireSignupGameId: string
}

/** Rows of each kind, for scenarios that count them. */
export const LONG_LISTS_SHAPE = {
  highlights: 300,
  pendingNotices: 30,
  sentNotices: 25,
  historyNotices: 25,
  privateEventTitle: 'Private team practice'
}

const DAY = 24 * 60 * 60 * 1000
const STILL = resolve(__dirname, 'fixtures/still.jpg')
const VIDEO_SECONDS = 7200
const HIGHLIGHT_VIDEO_SECONDS = 14400
const INSERT_BATCH = 200

/** Where a run keeps what is not proof: the manifest and browser profiles. */
export function longListsSupport(): string {
  return (
    process.env.TS_LONG_LISTS_SUPPORT ?? join(tmpdir(), 'tsLongListsSupport')
  )
}

interface SeededGame {
  id: string
  at: Date
  /** Its start has passed. */
  played: boolean
  video: boolean
  index: number
}

export async function seedLongLists(f: GroupFixture): Promise<LongListsSeed> {
  const db = f.h.db
  const now = f.clock.now().getTime()
  const anchor = Math.floor(now / DAY) * DAY + 18 * 60 * 60 * 1000
  const on = (offset: number, hour = 18): Date =>
    new Date(anchor + offset * DAY + (hour - 18) * 60 * 60 * 1000)
  const dayText = (offset: number): string =>
    on(offset).toISOString().slice(0, 10)
  const still = readFileSync(STILL)
  const keep = (videoId: string, second: number): void => {
    f.h.objects.set(`/${f.h.space.bucket}/${stillKey(videoId, second)}`, still)
  }
  const insertAll = async <T>(
    rows: T[],
    insert: (batch: T[]) => Promise<unknown>
  ): Promise<void> => {
    for (let start = 0; start < rows.length; start += INSERT_BATCH)
      await insert(rows.slice(start, start + INSERT_BATCH))
  }

  // Seasons as long as the games they hold.
  await db
    .updateTable('seasons')
    .set({ starts_on: dayText(-430), ends_on: dayText(170) })
    .where('id', 'in', [f.seasonA, f.playoffs, f.standaloneSeason])
    .execute()

  const team = async (
    name: string,
    season: string,
    user: number
  ): Promise<string> => {
    const answer = await f.h.request(
      'POST',
      '/teams',
      {
        name,
        parent: { kind: 'season', id: season },
        locality: demoLocality,
        idempotencyKey: `long-lists-${name}`
      },
      user
    )
    assert.equal(answer.status, 201)
    return ((await answer.json()) as { id: string }).id
  }
  const owls = await team('Demo Owls', f.seasonA, 101)
  const foxes = await team('Demo Foxes', f.seasonA, 101)
  const gulls = await team('Demo Gulls', f.standaloneSeason, 103)
  await db
    .insertInto('season_teams')
    .values([
      ...[f.teamA, owls, foxes].map(id => ({
        season_id: f.seasonA,
        team_id: id,
        active: true
      })),
      ...[f.teamA, owls, foxes].map(id => ({
        season_id: f.playoffs,
        team_id: id,
        active: true
      })),
      ...[f.standaloneTeam, gulls].map(id => ({
        season_id: f.standaloneSeason,
        team_id: id,
        active: true
      }))
    ])
    .onConflict(oc => oc.doNothing())
    .execute()

  // The Hawks' games: every other day, 400 days back and 150 ahead.
  const games: SeededGame[] = []
  const gameRows = []
  const videoRows = []
  const days = Array.from({ length: 276 }, (_, index) => -400 + index * 2)
  for (const [index, offset] of days.entries()) {
    const at = on(offset)
    const played = at.getTime() < now
    const id = `gam_long_${String(index).padStart(3, '0')}`
    const cancelled = played && index % 41 === 40
    const unscored = played && index % 37 === 36
    const final = played && !cancelled && !unscored
    const video = final && index % 3 === 0
    games.push({ id, at, played, video, index })
    gameRows.push({
      id,
      home_team_id: index % 2 === 0 ? f.teamA : owlsOrFoxes(index),
      away_team_id: index % 2 === 0 ? owlsOrFoxes(index) : f.teamA,
      season_id: offset > 110 ? f.playoffs : f.seasonA,
      start_at: at,
      venue: `Demo Field ${(index % 3) + 1}`,
      timezone: 'UTC',
      status: cancelled
        ? ('cancelled' as const)
        : final
          ? ('final' as const)
          : ('scheduled' as const),
      home_score: final ? (index * 7) % 11 : null,
      away_score: final ? (index * 5) % 9 : null,
      notes: index % 5 === 0 ? 'North diamond entry' : null
    })
    if (video)
      videoRows.push({
        id: `vid_long_${index}`,
        game_id: id,
        kind: 'program' as const,
        storage: 'spaces' as const,
        status: 'ready' as const,
        title: 'Demo game video',
        start_at: at,
        duration_sec: VIDEO_SECONDS
      })
  }
  function owlsOrFoxes(index: number): string {
    return index % 4 < 2 ? owls : foxes
  }

  // Eight games at one start, and a practice at the same moment below.
  const tiedAt = on(-121)
  const tiedGameIds = Array.from(
    { length: 8 },
    (_, index) => `gam_long_tied_${index}`
  )
  for (const [index, id] of tiedGameIds.entries())
    gameRows.push({
      id,
      home_team_id: f.teamA,
      away_team_id: index % 2 === 0 ? owls : foxes,
      season_id: f.seasonA,
      start_at: tiedAt,
      venue: 'Demo Field 4',
      timezone: 'UTC',
      status: 'final' as const,
      home_score: index + 1,
      away_score: index,
      notes: null
    })

  // The game with 300 highlights, in its own afternoon.
  const highlightsGameId = 'gam_long_highlights'
  const highlightsVideoId = 'vid_long_highlights'
  const highlightsAt = on(-7, 13)
  gameRows.push({
    id: highlightsGameId,
    home_team_id: f.teamA,
    away_team_id: owls,
    season_id: f.seasonA,
    start_at: highlightsAt,
    venue: 'Demo Field 1',
    timezone: 'UTC',
    status: 'final' as const,
    home_score: 12,
    away_score: 9,
    notes: null
  })
  videoRows.push({
    id: highlightsVideoId,
    game_id: highlightsGameId,
    kind: 'program' as const,
    storage: 'spaces' as const,
    status: 'ready' as const,
    title: 'Demo game video',
    start_at: highlightsAt,
    duration_sec: HIGHLIGHT_VIDEO_SECONDS
  })

  // The public team's games, played by people 101 has nothing to do with.
  for (let index = 0; index < 120; index++) {
    const at = on(-200 + index * 2, 16)
    const played = at.getTime() < now
    const id = `gam_long_public_${String(index).padStart(3, '0')}`
    gameRows.push({
      id,
      home_team_id: index % 2 === 0 ? f.standaloneTeam : gulls,
      away_team_id: index % 2 === 0 ? gulls : f.standaloneTeam,
      season_id: f.standaloneSeason,
      start_at: at,
      venue: 'Demo Harbor Park',
      timezone: 'UTC',
      status: played ? ('final' as const) : ('scheduled' as const),
      home_score: played ? (index * 3) % 8 : null,
      away_score: played ? (index * 2) % 7 : null,
      notes: null
    })
    if (played && index % 4 === 0)
      videoRows.push({
        id: `vid_long_public_${index}`,
        game_id: id,
        kind: 'program' as const,
        storage: 'spaces' as const,
        status: 'ready' as const,
        title: 'Demo game video',
        start_at: at,
        duration_sec: VIDEO_SECONDS
      })
  }
  await insertAll(gameRows, async batch => {
    await db.insertInto('games').values(batch).execute()
  })
  await insertAll(videoRows, async batch => {
    await db.insertInto('videos').values(batch).execute()
  })
  for (const row of videoRows) keep(row.id, posterSecond(row.duration_sec))

  // Team events: a practice a week, every eighth a meeting, one on the tie.
  const eventRows = Array.from({ length: 79 }, (_, index) => ({
    id: `tev_long_${index}`,
    team_id: f.teamA,
    title: index % 8 === 7 ? 'Team meeting' : 'Practice',
    event_type: index % 8 === 7 ? ('other' as const) : ('practice' as const),
    start_at: on(-399 + index * 7, 17),
    timezone: 'UTC',
    venue: 'Demo Practice Field'
  }))
  eventRows.push(
    {
      id: 'tev_long_tied',
      team_id: f.teamA,
      title: 'Practice',
      event_type: 'practice' as const,
      start_at: tiedAt,
      timezone: 'UTC',
      venue: 'Demo Practice Field'
    },
    {
      id: 'tev_long_private',
      team_id: f.standaloneTeam,
      title: LONG_LISTS_SHAPE.privateEventTitle,
      event_type: 'practice' as const,
      start_at: on(3, 17),
      timezone: 'UTC',
      venue: 'Demo Practice Field'
    }
  )
  await db.insertInto('team_events').values(eventRows).execute()

  // The roster the plays name, in the batting order of the 300.
  const roster = [
    { id: 301, first: 'Mookie', last: 'Betts' },
    { id: 302, first: 'Freddie', last: 'Freeman' },
    { id: 303, first: 'Jose', last: 'Altuve' },
    { id: 304, first: 'Juan', last: 'Soto' },
    { id: 305, first: 'Corey', last: 'Seager' },
    { id: 306, first: 'Bryce', last: 'Harper' }
  ]
  await insertFixtureUsers(
    db,
    roster.map(person => ({
      id: person.id,
      legacyId: `usr_long_${person.id}`,
      display_name: `${person.first} ${person.last}`,
      first_name: person.first,
      last_name: person.last
    }))
  )
  await db
    .insertInto('memberships')
    .values(
      roster.map((person, index) => ({
        id: `mem_long_${person.id}`,
        team_id: f.teamA,
        user_id: userIdOfGumbo(person.id),
        role: 'member' as const,
        is_player: true,
        jersey: String(index + 1)
      }))
    )
    .execute()
  const playerId = userIdOfGumbo(301)

  interface Play {
    id: string
    game: string
    at: Date
    person: (typeof roster)[number]
    index: number
    hidden: boolean
  }
  const plays: Play[] = []
  // The 300: one every 40 seconds, inside the four hour video.
  for (let index = 0; index < LONG_LISTS_SHAPE.highlights; index++)
    plays.push({
      id: `evt_long_h_${index}`,
      game: highlightsGameId,
      at: new Date(highlightsAt.getTime() + (index + 1) * 40_000),
      person: roster[index % roster.length],
      index,
      hidden: false
    })
  // Mookie's plays, newest first: games with video, then a long run of games
  // without, then games with video again, a fifth of them hidden.
  const final = games.filter(game => game.played).reverse()
  const hisGames = [
    ...final.slice(0, 60).filter(game => game.video),
    ...final.slice(60, 100).filter(game => !game.video),
    ...final.slice(100, 130).filter(game => game.video)
  ]
  let played = 0
  for (const game of hisGames)
    for (let inning = 0; inning < 4; inning++) {
      plays.push({
        id: `evt_long_p_${game.index}_${inning}`,
        game: game.id,
        at: new Date(game.at.getTime() + (inning + 1) * 600_000),
        person: roster[0],
        index: inning,
        hidden: played % 5 === 4
      })
      played++
    }
  const words = [
    ['single', 'Single'],
    ['double', 'Double'],
    ['triple', 'Triple'],
    ['home_run', 'Home run']
  ] as const
  await insertAll(plays, async batch => {
    await db
      .insertInto('events')
      .values(
        batch.map(play => {
          const [eventType, label] = words[play.index % words.length]
          const name = `${play.person.first} ${play.person.last[0]}`
          const at = play.at.toISOString()
          return {
            id: play.id,
            gameId: play.game,
            startTime: at,
            battingTeamId: f.teamA,
            hidden: play.hidden,
            gumbo: {
              about: {
                atBatIndex: play.index,
                inning: (play.index % 9) + 1,
                halfInning: 'bottom',
                isScoringPlay: false,
                startTime: at
              },
              result: { eventType, awayScore: 0, homeScore: 0 },
              credits: [
                {
                  eventType,
                  head: label,
                  teamId: f.teamA,
                  creditUserId: play.person.id,
                  credit: { name, role: 'batter', position: null }
                }
              ]
            }
          }
        })
      )
      .execute()
  })
  const highlightStills = async (route: string): Promise<string | null> => {
    const answer = await f.h.request('GET', route, undefined, 101)
    assert.equal(answer.status, 200, route)
    const { highlights, nextBefore } = (await answer.json()) as {
      highlights: Array<{ videoId?: string; stillUrl: string }>
      nextBefore?: string | null
    }
    for (const highlight of highlights) {
      const second = /\/stills\/(\d+)\.jpg/.exec(highlight.stillUrl)?.[1]
      assert.ok(second != null, highlight.stillUrl)
      keep(highlight.videoId ?? highlightsVideoId, Number(second))
    }
    return nextBefore ?? null
  }
  await highlightStills(`/videos/${highlightsVideoId}/highlights`)
  let before: string | null = ''
  while (before != null)
    before = await highlightStills(
      `/players/${playerId}/highlights?limit=50${
        before === '' ? '' : `&before=${encodeURIComponent(before)}`
      }`
    )

  // Invitations from either side: 102's wait on 101, and 101's on 102.
  const proposal = async (index: number, user: 101 | 102): Promise<void> => {
    const ours = user === 101
    const answer = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: ours ? f.teamA : f.teamB },
        game: {
          homeTeamId: ours ? f.teamA : f.teamB,
          awayTeamId: ours ? f.teamB : f.teamA,
          seasonId: null,
          startAt: on(5 + index * 2 + (ours ? 1 : 0), 15).toISOString(),
          venue: 'Demo Field 2',
          status: 'scheduled'
        },
        idempotencyKey: `long-lists-${user}-${index}`
      },
      user
    )
    assert.equal(answer.status, 201, await answer.clone().text())
  }
  for (let index = 0; index < LONG_LISTS_SHAPE.pendingNotices; index++)
    await proposal(index, 102)
  for (let index = 0; index < LONG_LISTS_SHAPE.sentNotices; index++)
    await proposal(index, 101)
  await db
    .insertInto('notification_events')
    .values(
      Array.from({ length: LONG_LISTS_SHAPE.historyNotices }, (_, index) => ({
        id: `nev_long_${index}`,
        source_type: 'schedulePublished',
        source_id: `long-lists-${index}`,
        revision: 1,
        actor_id: null,
        metadata: {
          title: `Schedule published, week ${index + 1}`,
          description: 'The league published its next games.'
        },
        recorded_recipients: [userIdOfGumbo(101)],
        created_at: on(-index - 1)
      }))
    )
    .execute()

  // Umpires: 101 can sign up, through a child who plays, as a parent does.
  const user = userIdOfGumbo(101)
  const child = userIdOfGumbo(104)
  await seedUmpireTypes(db, f.leagueA)
  await db
    .updateTable('leagues')
    .set({ umpire_management: true, umpire_credits: true })
    .where('id', '=', f.leagueA)
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: 'lmb_long_umpire',
      league_id: f.leagueA,
      user_id: user,
      role: 'member'
    })
    .execute()
  await db
    .insertInto('league_umpires')
    .values(
      [101, 103].map(id => ({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(id),
        granted_by: user
      }))
    )
    .execute()
  await db
    .insertInto('user_links')
    .values({
      id: 'lnk_long_umpire',
      user_id: user,
      related_user_id: child,
      kind: 'guardian'
    })
    .execute()
  await db
    .insertInto('memberships')
    .values({
      id: 'mem_long_umpire',
      team_id: f.teamA,
      user_id: child,
      is_player: true,
      role: 'member'
    })
    .execute()
  await db
    .insertInto('umpire_levels')
    .values({
      id: 'ulv_long_majors',
      league_id: f.leagueA,
      name: 'majors',
      position: 0
    })
    .execute()
  await db
    .insertInto('season_umpire_requirements')
    .values(
      [f.seasonA, f.playoffs].map(season => ({
        season_id: season,
        level_id: 'ulv_long_majors'
      }))
    )
    .execute()
  await seedUmpireCounts(db, f.seasonA, true, 1, 1)
  await seedUmpireCounts(db, f.playoffs, true, 2, 0)
  await db
    .insertInto('umpire_certifications')
    .values(
      [101, 103].flatMap(id =>
        ['uty_plate', 'uty_field'].map(typeId => ({
          user_id: userIdOfGumbo(id),
          level_id: 'ulv_long_majors',
          type_id: typeId,
          enabled: true
        }))
      )
    )
    .execute()
  await db
    .insertInto('umpire_note_types')
    .values([
      {
        id: 'unt_long_uniform',
        league_id: f.leagueA,
        name: 'Uniform',
        position: 0
      },
      {
        id: 'unt_long_contact',
        league_id: f.leagueA,
        name: 'Field contact',
        position: 1
      }
    ])
    .execute()
  const seven = games.filter(game => game.index % 7 === 0)
  await db
    .insertInto('game_umpire_notes')
    .values(
      seven.flatMap(game => [
        {
          game_id: game.id,
          note_type_id: 'unt_long_uniform',
          value: game.index % 2 === 0 ? 'Navy' : 'Gold'
        },
        ...(game.index % 3 === 0
          ? [
              {
                game_id: game.id,
                note_type_id: 'unt_long_contact',
                value: 'Demo contact'
              }
            ]
          : [])
      ])
    )
    .execute()
  const [plate] = fixturePositions(true, 1, 1)
  await db
    .insertInto('umpire_assignments')
    .values(
      games
        .filter(game => game.index % 9 === 0 && game.at.getTime() < now)
        .map(game => ({
          game_id: game.id,
          slot: plate.slot,
          user_id: userIdOfGumbo(103),
          assigned_by: user
        }))
    )
    .execute()

  const ahead = games.filter(game => !game.played)
  return {
    leagueId: f.leagueA,
    seasonId: f.seasonA,
    playoffsId: f.playoffs,
    teamId: f.teamA,
    nextGameId: ahead[0].id,
    playerId,
    highlightsGameId,
    highlightsVideoId,
    publicTeamId: f.standaloneTeam,
    publicSeasonId: f.standaloneSeason,
    privateEventTitle: LONG_LISTS_SHAPE.privateEventTitle,
    tiedGameIds,
    umpireSignupGameId: ahead[60].id
  }
}
