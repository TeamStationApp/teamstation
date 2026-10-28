import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asPostEventsBody } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { creditsForHighlight, creditsForPlayer } from './credits'
import {
  battingTeamForHalf,
  replaceGameEvents,
  teamIdsOnCredits
} from './eventWrite'
import { bothPlayedTogether } from './playedTogether'
import { postGamePlays } from './postPlays'
import { whyEmpty } from './whyEmpty'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_events_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('scoring events', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  const home = makeId('team')
  const away = makeId('team')
  const gameId = makeId('game')
  const player = mintUserId(() => false)

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    await admin.query('select 1')
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    const now = new Date()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(player.userId),
      legacyId: player.legacyId,
      display_name: 'Adam Dunn',
      created_at: now,
      updated_at: now
    })
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: home,
        away_team_id: away,
        start_at: now
      })
      .execute()
  })

  after(async function () {
    await db.destroy()
    await admin.query(`drop database if exists ${scratchName}`)
    await admin.end()
  })

  it('names the batting team by the half', function () {
    expect(
      battingTeamForHalf('top', { homeTeamId: home, awayTeamId: away })
    ).equals(away)
    expect(
      battingTeamForHalf('bottom', { homeTeamId: home, awayTeamId: away })
    ).equals(home)
    expect(
      battingTeamForHalf(null, { homeTeamId: home, awayTeamId: away })
    ).equals(null)
    expect(
      teamIdsOnCredits(
        [{ teamId: 'home' }, { teamId: 'away' }, { teamId: 'tem_x' }, {}],
        { homeTeamId: home, awayTeamId: away }
      ).map(credit => credit.teamId)
    ).deep.equals([home, away, 'tem_x', null])
  })

  it('says why a highlight list is empty', function () {
    expect(
      whyEmpty([{}], [{ startTime: null }], {
        startAt: null,
        durationSec: null
      })
    ).equals(null)
    expect(whyEmpty([], [], { startAt: null, durationSec: null })).equals(null)
    expect(
      whyEmpty([], [{ startTime: null }], {
        startAt: new Date(),
        durationSec: 1
      })
    ).equals('noPlayTimes')
    expect(
      whyEmpty([], [{ startTime: new Date() }], {
        startAt: null,
        durationSec: 1
      })
    ).equals('noVideoStart')
    expect(
      whyEmpty([], [{ startTime: new Date() }], {
        startAt: new Date(),
        durationSec: 1
      })
    ).equals('scoredAfterRecording')
  })

  it('replaces every play, keeping what people set on each index', async function () {
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, halfInning: 'top', isScoringPlay: false },
            result: { eventType: 'single', awayScore: 1, homeScore: 0 }
          },
          source: 'external'
        },
        {
          gumbo: {
            about: { atBatIndex: 9999, isScoringPlay: false },
            result: { eventType: 'final_score', awayScore: 1, homeScore: 0 }
          },
          source: 'external'
        }
      ]
    })
    const fielderEvent = await db
      .selectFrom('events')
      .select(['id'])
      .where('gameId', '=', gameId)
      .where('atBatIndex', '=', 0)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: fielderEvent.id,
        gumbo_id: player.userId,
        team_id: away,
        role: 'fielder'
      })
      .execute()
    await db
      .updateTable('events')
      .set({ hidden: true, titleOverride: 'The one', timeNudgeSec: 3 })
      .where('id', '=', fielderEvent.id)
      .execute()

    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, halfInning: 'bottom', isScoringPlay: true },
            result: { eventType: 'single', awayScore: 2, homeScore: 0 },
            source: { system: 'acme', play: { order: 0 } },
            credits: [
              {
                eventType: 'single',
                label: 'Single: Adam Dunn',
                teamId: home,
                creditUserId: player.userId,
                credit: {
                  name: 'Adam Dunn',
                  role: 'batter',
                  position: null
                }
              }
            ]
          },
          source: 'external'
        }
      ]
    })
    const edited = await db
      .selectFrom('events')
      .select(['hidden', 'titleOverride', 'timeNudgeSec'])
      .where('gameId', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(edited).deep.equals({
      hidden: true,
      titleOverride: 'The one',
      timeNudgeSec: 3
    })
    const replaced = await db
      .selectFrom('events')
      .select(['id', 'atBatIndex', 'battingTeamId'])
      .where('gameId', '=', gameId)
      .execute()
    expect(replaced.map(row => row.atBatIndex)).deep.equals([0])
    expect(replaced[0].battingTeamId).equals(home)
    const document = await db
      .selectFrom('events')
      .select('gumbo')
      .where('id', '=', replaced[0].id)
      .executeTakeFirstOrThrow()
    expect(document.gumbo).to.not.have.property('source')
    // The credit is stored with its structure, its label and name kept.
    expect((document.gumbo as { credits: unknown[] }).credits).deep.equals([
      {
        eventType: 'single',
        label: 'Single: Adam Dunn',
        teamId: home,
        creditUserId: player.userId,
        credit: { name: 'Adam Dunn', role: 'batter', position: null },
        head: 'Single'
      }
    ])
    const roles = await db
      .selectFrom('event_players')
      .select(['role', 'gumbo_id'])
      .where('event_id', '=', replaced[0].id)
      .execute()
    expect(roles.map(row => row.role)).deep.equals(['fielder'])

    const byPlayer = await creditsForPlayer(db, userIdOfGumbo(player.userId))
    // Read back structured, with its game, naming its person by id alone.
    expect(byPlayer.get(replaced[0].id)).deep.equals([
      {
        gameId,
        eventType: 'single',
        head: 'Single',
        suffix: null,
        assists: [],
        assistWord: null,
        teamId: home,
        creditUserId: player.userId,
        credit: { role: 'batter', position: null }
      }
    ])
    expect(
      await creditsForPlayer(db, userIdOfGumbo(9_007_199_254_740_000))
    ).deep.equals(new Map())

    const highlights = await creditsForHighlight(db, [replaced[0].id])
    expect(highlights.get(replaced[0].id)?.[0].eventType).equals('single')
  })

  it("stores an outside scorer's credits with their structure, labels and names kept, and copies it into eventCredits", async function () {
    const fielder = mintUserId(id => id === player.userId)
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(fielder.userId),
      legacyId: fielder.legacyId,
      display_name: 'Alex Bregman'
    })
    const outsideGame = makeId('game')
    await db
      .insertInto('games')
      .values({
        id: outsideGame,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const sent = [
      {
        eventType: 'single',
        label: 'Single: Kyle Tucker',
        teamId: 'away',
        creditUserId: null,
        credit: { name: 'Kyle Tucker', role: 'batter', position: null }
      },
      {
        eventType: 'strikeout',
        label: 'Strikeout: Adam Dunn pitching',
        teamId: 'home',
        creditUserId: player.userId,
        credit: { name: 'Adam Dunn', role: 'pitcher', position: null }
      },
      {
        eventType: 'double_play',
        label:
          'Double play: Adam Dunn (SS) to Alex Bregman (2B) to Jose Altuve (1B)',
        teamId: 'home',
        creditUserId: player.userId,
        credit: { name: 'Adam Dunn', role: 'fielder', position: 'SS' },
        assists: [
          {
            name: 'Alex Bregman',
            position: '2B',
            creditUserId: fielder.userId
          }
        ]
      }
    ]
    await postGamePlays(
      db,
      outsideGame,
      asPostEventsBody({
        mode: 'replace',
        source: { system: 'acme' },
        plays: [
          {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single', awayScore: 0, homeScore: 0 },
            matchup: {
              batter: { fullName: 'Kyle Tucker' },
              pitcher: { id: player.userId, fullName: 'Adam Dunn' }
            },
            credits: sent
          }
        ]
      })
    )
    const stored = await db
      .selectFrom('events')
      .select(['id', 'gumbo'])
      .where('gameId', '=', outsideGame)
      .executeTakeFirstOrThrow()
    const credits = (
      stored.gumbo as { credits: Array<Record<string, unknown>> }
    ).credits
    expect(credits.map(credit => credit.label)).deep.equals(
      sent.map(credit => credit.label)
    )
    expect(credits.map(credit => credit.credit)).deep.equals(
      sent.map(credit => credit.credit)
    )
    expect(credits[1]).include({ head: 'Strikeout', suffix: ' pitching' })
    expect(credits[2]).deep.include({
      head: 'Double play',
      assists: [
        { creditUserId: fielder.userId, position: '2B' },
        { creditUserId: null, position: '1B', name: 'Jose Altuve' }
      ],
      assistWord: 'to'
    })

    const rows = await db
      .selectFrom('eventCredits')
      .select([
        'label',
        'name',
        'head',
        'suffix',
        'assists',
        'assistWord',
        'typedName'
      ])
      .where('eventId', '=', stored.id)
      .orderBy('label')
      .execute()
    expect(rows).deep.equals([
      {
        label:
          'Double play: Adam Dunn (SS) to Alex Bregman (2B) to Jose Altuve (1B)',
        name: 'Adam Dunn',
        head: 'Double play',
        suffix: null,
        assists: [
          { gumboId: fielder.userId, position: '2B' },
          { gumboId: null, position: '1B', name: 'Jose Altuve' }
        ],
        assistWord: 'to',
        typedName: null
      },
      {
        label: 'Single: Kyle Tucker',
        name: 'Kyle Tucker',
        head: 'Single',
        suffix: null,
        assists: [],
        assistWord: null,
        typedName: null
      },
      {
        label: 'Strikeout: Adam Dunn pitching',
        name: 'Adam Dunn',
        head: 'Strikeout',
        suffix: ' pitching',
        assists: [],
        assistWord: null,
        typedName: null
      }
    ])
    const read = await creditsForHighlight(db, [stored.id])
    expect(read.get(stored.id)?.map(credit => credit.credit)).deep.equals([
      { name: 'Kyle Tucker', role: 'batter', position: null },
      { role: 'pitcher', position: null },
      { role: 'fielder', position: 'SS' }
    ])
    expect(read.get(stored.id)?.[2].assists).deep.equals([
      { creditUserId: fielder.userId, position: '2B' },
      { creditUserId: null, position: '1B', name: 'Jose Altuve' }
    ])
  })

  it('keeps stored credits a post leaves off, and records an empty list', async function () {
    await replaceGameEvents(db, {
      gameId,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, halfInning: 'bottom', isScoringPlay: true },
            result: { eventType: 'single', awayScore: 2, homeScore: 0 }
          },
          source: 'external'
        },
        {
          gumbo: {
            about: { atBatIndex: 9999, isScoringPlay: false },
            result: { eventType: 'final_score', awayScore: 2, homeScore: 0 },
            credits: []
          },
          source: 'external'
        }
      ]
    })
    const indexes = await db
      .selectFrom('events')
      .select(['id', 'atBatIndex'])
      .where('gameId', '=', gameId)
      .orderBy('atBatIndex')
      .execute()
    expect(indexes.map(row => row.atBatIndex)).deep.equals([0, 9999])
    const looked = await creditsForHighlight(
      db,
      indexes.map(row => row.id)
    )
    const empty = indexes.find(row => row.atBatIndex === 9999)
    expect(looked.get(empty?.id ?? '')).deep.equals([])
    const single = indexes.find(row => row.atBatIndex === 0)
    expect(looked.get(single?.id ?? '')?.[0]).include({
      head: 'Single',
      creditUserId: player.userId
    })

    await db
      .insertInto('games')
      .values({
        id: makeId('game'),
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const bareGame = makeId('game')
    await db
      .insertInto('games')
      .values({
        id: bareGame,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    const bareId = makeId('event')
    await db
      .insertInto('events')
      .values({
        id: bareId,
        gameId: bareGame,
        gumbo: {
          about: { atBatIndex: 0, isScoringPlay: false },
          result: { eventType: 'walk' }
        }
      })
      .execute()
    const bare = await creditsForHighlight(db, [bareId])
    expect(bare.get(bareId)).equals(undefined)

    await db
      .insertInto('game_player_stats')
      .values({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: player.userId,
        team_id: home,
        pa: 0,
        pitch_outs: 0
      })
      .execute()
    const other = mintUserId(() => false)
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(other.userId),
      legacyId: other.legacyId,
      display_name: 'Babe Ruth',
      created_at: new Date(),
      updated_at: new Date()
    })
    const together = await bothPlayedTogether(db, [
      userIdOfGumbo(player.userId),
      userIdOfGumbo(other.userId)
    ])
    expect(
      together.has(
        `${userIdOfGumbo(player.userId)}|${userIdOfGumbo(other.userId)}`
      )
    ).equals(false)
  })

  // U8b: a head coach's lineup saved before the first pitch is an at-bat in
  // progress that starts nothing.
  it('starts only after a pitch, not an initialized at-bat', async function () {
    for (const [pitches, status] of [
      [[], 'scheduled'],
      [[{ isPitch: true }], 'inProgress']
    ] as const) {
      const id = makeId('game')
      await db
        .insertInto('games')
        .values({
          id,
          home_team_id: home,
          away_team_id: away,
          start_at: new Date()
        })
        .execute()
      await postGamePlays(
        db,
        id,
        asPostEventsBody({
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          currentPlay: {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isComplete: false
            },
            matchup: { batter: { id: player.userId, fullName: 'Adam Dunn' } },
            playEvents: pitches
          }
        })
      )
      const row = await db
        .selectFrom('games')
        .select(['status', 'currentPlay'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.status).equals(status)
      expect(row.currentPlay).not.equals(null)
    }
  })
})
