/**
 * The offline-cache device scenario's fixture (`src/app/sync/offlineDevice.e2e.ts`),
 * written into a development seat's own database and Space.
 *
 *   node -r sucrase/register <this file> --seat <seat name> [--email <+ address>] \
 *     [--out <ids.json>] [--no-video] [--upcoming-days N]
 *
 * Run it as the seat's service user from the seat's live build directory: it
 * loads that build's own server modules by absolute path from the working
 * directory and reads that build's `./serverConfig.json`. It refuses a
 * database other than `TeamStation_<seat>` and refuses to run twice (the
 * email is taken).
 *
 * Writes:
 * - one person who signs in with an emailed code (no password), onboarding
 *   done, a member of two teams, and admin, coach and scorekeeper of the
 *   first (so Score Game and Set Team Rosters open);
 * - a league and a season, both on the person's Home (league_members and
 *   season_members rows), with four teams in them: the opened team, the
 *   never-opened team, the opponent, and a fourth team whose player is the
 *   Add Existing candidate;
 * - a picture on the opened team, the other team, the season and the league,
 *   through `storeGroupPhoto` (same signature on develop and on
 *   paul/offlineCache, so the branch's storeImage change is absorbed there);
 * - a past (final) game and an upcoming game, opened team at home;
 * - a short generated HEVC video on the past game, through the server's own
 *   `src/server/dev/importVideoFile.ts` (remux, upload to the seat's Space,
 *   verify, then the `videos` row).
 *
 * Every name is invented. Prints the ids as JSON.
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)

const { values } = parseArgs({
  options: {
    seat: { type: 'string' },
    email: { type: 'string', default: 'scotty+offlinecache@vtex.net' },
    out: { type: 'string' },
    'no-video': { type: 'boolean', default: false },
    'upcoming-days': { type: 'string', default: '3' }
  }
})

const root = process.cwd()

const load = (path: string): any => require(join(root, path))
const { serverConfig } = load('src/server/serverConfig.ts')
const { makeDatabase } = load('src/server/db/database.ts')
const { makeId } = load('src/common/ids.ts')
const { insertUser, ensureGumboId } = load('src/server/users/insertUser.ts')
const { addEmail } = load('src/server/auth/emails.ts')
const { storeGroupPhoto } = load('src/server/groups/groupPhoto.ts')

const NAMES = {
  league: 'Offline Demo League',
  season: 'Offline Fall Demo',
  opened: 'Offline Falcons',
  unopened: 'Offline Herons',
  opponent: 'Offline Owls',
  candidates: 'Offline Bears',
  candidate: ['Jordan', 'Quillfeather'] as [string, string]
}

const FALCONS = [
  'Alex Lee',
  'Sam Rivera',
  'Casey Moon',
  'Riley Park',
  'Drew Stone',
  'Jamie Fox',
  'Taylor Reed',
  'Morgan Hale',
  'Quinn Ward'
]
const OWLS = [
  'Avery Cole',
  'Blake Hart',
  'Cameron Dale',
  'Dakota Lane',
  'Emerson Fry',
  'Finley Shaw',
  'Harper Wynn',
  'Jesse Pratt',
  'Kendall Ross'
]
const BEARS = ['Logan Birch', 'Parker Vale']

function fail(message: string): never {
  throw new Error(message)
}

/** A 512 square PNG, a colour and a letter, made by the seat's own FFmpeg. */
async function picture(
  dir: string,
  label: string,
  colour: string
): Promise<string> {
  const file = join(dir, `${label}.png`)
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${colour}:s=512x512`
  ]
  try {
    await run(serverConfig.ffmpegPath, [
      ...base,
      '-vf',
      `drawtext=text='${label}':fontsize=320:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-frames:v',
      '1',
      file
    ])
  } catch {
    // No font on this box: a plain colour still tells the four apart.
    await run(serverConfig.ffmpegPath, [...base, '-frames:v', '1', file])
  }
  return (await readFile(file)).toString('base64')
}

async function main(): Promise<void> {
  const seat =
    values.seat ?? fail('--seat <name> is required, e.g. --seat offlineCache')
  const url: string = serverConfig.databaseUrl
  if (/\/([^/?]+)(?:\?.*)?$/.exec(url)?.[1] !== `TeamStation_${seat}`)
    fail(
      `serverConfig.databaseUrl is not TeamStation_${seat}; run from that seat's live build`
    )
  const email = values.email.trim().toLowerCase()
  if (!/^[^@\s]+\+[^@\s]+@/.test(email))
    fail('the email must be a test + address')

  const db = makeDatabase(url)
  const work = await mkdtemp(join(tmpdir(), 'offlineDevice-'))
  try {
    const taken = await db
      .selectFrom('user_emails')
      .select('user_id')
      .where((eb: any) => eb.fn('lower', ['email']), '=', email)
      .executeTakeFirst()
    if (taken != null)
      fail(
        `${email} is already on this seat (user ${taken.user_id}); the fixture is here`
      )

    const now = Date.now()
    const day = (offset: number): string =>
      new Date(now + offset * 86_400_000).toISOString().slice(0, 10)

    // The league and season, and four teams in both.
    const leagueId = makeId('league')
    const seasonId = makeId('season')
    await db
      .insertInto('leagues')
      .values({ id: leagueId, name: NAMES.league })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: seasonId,
        league_id: leagueId,
        name: NAMES.season,
        year: Number(day(0).slice(0, 4)),
        starts_on: day(-30),
        ends_on: day(90),
        timezone: 'America/Los_Angeles'
      })
      .execute()
    const teams = {
      opened: makeId('team'),
      unopened: makeId('team'),
      opponent: makeId('team'),
      candidates: makeId('team')
    }
    await db
      .insertInto('teams')
      .values(
        Object.entries(teams).map(([key, id]) => ({
          id,
          name: NAMES[key as keyof typeof teams],
          league_id: leagueId
        }))
      )
      .execute()
    await db
      .insertInto('season_teams')
      .values(
        Object.values(teams).map(id => ({ season_id: seasonId, team_id: id }))
      )
      .execute()

    // The person: signs in by emailed code, onboarding done.
    const personId = await insertUser(db, {
      display_name: 'Scotty Offline',
      first_name: 'Scotty',
      last_name: 'Offline',
      login_enabled: true,
      is_admin: false,
      onboarding_step: 'complete',
      onboarding_completed_at: new Date()
    })
    const added = await addEmail(db, personId, email, {
      isPrimary: true,
      source: 'manual',
      verifiedAt: new Date()
    })
    if (added.added !== true)
      fail(`${email} could not be added: held by ${added.heldBy}`)
    for (const teamId of [teams.opened, teams.unopened]) {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: personId,
          team_id: teamId,
          role: 'member'
        })
        .execute()
    }
    for (const role of ['admin', 'coach', 'scorekeeper']) {
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: personId,
          scope_type: 'team',
          scope_id: teams.opened,
          role
        })
        .execute()
    }
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: personId,
        league_id: leagueId
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: personId,
        season_id: seasonId
      })
      .execute()

    // Rosters. The candidate plays for the fourth team only.
    const player = async (
      teamId: string,
      name: string,
      jersey: number
    ): Promise<string> => {
      const [first, ...rest] = name.split(' ')
      const userId = await insertUser(db, {
        display_name: name,
        first_name: first,
        last_name: rest.join(' '),
        bats: 'right',
        throws: 'right'
      })
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: true,
          jersey: String(jersey)
        })
        .execute()
      await ensureGumboId(db, userId)
      return userId
    }
    const rosters: Record<string, string[]> = {
      opened: [],
      opponent: [],
      candidates: []
    }
    for (const [i, name] of FALCONS.entries())
      rosters.opened.push(await player(teams.opened, name, i + 1))
    for (const [i, name] of OWLS.entries())
      rosters.opponent.push(await player(teams.opponent, name, i + 11))
    for (const [i, name] of BEARS.entries())
      rosters.candidates.push(await player(teams.candidates, name, i + 21))
    const candidateId = await player(
      teams.candidates,
      NAMES.candidate.join(' '),
      27
    )

    // Games: one final three days ago, one upcoming.
    const pastStart = new Date(now - 3 * 86_400_000)
    pastStart.setUTCHours(1, 0, 0, 0) // 6pm Pacific the evening before
    const upcomingStart = new Date(
      now + Number(values['upcoming-days']) * 86_400_000
    )
    upcomingStart.setUTCHours(1, 0, 0, 0)
    const pastGameId = makeId('game')
    const upcomingGameId = makeId('game')
    const game = (
      id: string,
      start: Date,
      extra: Record<string, unknown>
    ): Record<string, unknown> => ({
      id,
      home_team_id: teams.opened,
      away_team_id: teams.opponent,
      season_id: seasonId,
      start_at: start,
      end_at: new Date(start.getTime() + 2 * 3_600_000),
      venue: 'Offline Demo Park',
      timezone: 'America/Los_Angeles',
      ...extra
    })
    await db
      .insertInto('games')
      .values([
        game(pastGameId, pastStart, {
          status: 'final',
          home_score: 5,
          away_score: 3
        }),
        game(upcomingGameId, upcomingStart, { status: 'scheduled' })
      ])
      .execute()

    // Pictures, through the server's own group-photo path.
    const media = {
      mediaRoot: serverConfig.mediaDir,
      ffmpegPath: serverConfig.ffmpegPath,
      mediaSecret: serverConfig.mediaSecret,
      publicUrl: `https://${serverConfig.primaryUrlOverride}`,
      space: serverConfig.space
    }
    const pictures: Record<string, string | null> = {}
    for (const [key, kind, id, label, colour] of [
      ['opened', 'team', teams.opened, 'F', '0x1f6feb'],
      ['unopened', 'team', teams.unopened, 'H', '0x8250df'],
      ['season', 'season', seasonId, 'S', '0x1a7f37'],
      ['league', 'league', leagueId, 'L', '0xcf222e']
    ] as const) {
      const base64 = await picture(work, label, colour)
      pictures[key] = await storeGroupPhoto(
        db,
        media,
        { kind, id },
        { contentType: 'image/png', base64 }
      )
    }

    // A short video on the past game, through the server's own importer.
    let videoId: string | null = null
    if (!values['no-video']) {
      const file = join(work, 'offlineDevice.mp4')
      await run(serverConfig.ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1280x720:rate=30:duration=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=30',
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
        '-b:a',
        '96k',
        '-shortest',
        file
      ])
      const { stdout } = await run(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          join(root, 'src/server/dev/importVideoFile.ts'),
          '--file',
          file,
          '--game',
          pastGameId,
          '--title',
          `${NAMES.opened} vs ${NAMES.opponent}`,
          '--start',
          pastStart.toISOString()
        ],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 }
      )
      videoId =
        /imported as (\S+)/.exec(stdout)?.[1] ??
        fail(`the importer said: ${stdout}`)
    }

    const ids = {
      seat,
      email,
      personId,
      leagueId,
      seasonId,
      teams,
      teamNames: {
        opened: NAMES.opened,
        unopened: NAMES.unopened,
        opponent: NAMES.opponent,
        candidates: NAMES.candidates
      },
      pastGameId,
      upcomingGameId,
      pastStart: pastStart.toISOString(),
      upcomingStart: upcomingStart.toISOString(),
      videoId,
      pictures,
      candidate: {
        userId: candidateId,
        name: NAMES.candidate.join(' '),
        teamId: teams.candidates
      },
      rosters
    }
    const json = JSON.stringify(ids, null, 2)
    if (values.out != null)
      writeFileSync(values.out, json + '\n', { mode: 0o600 })
    console.log(json)
  } finally {
    await db.destroy()
    await rm(work, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
