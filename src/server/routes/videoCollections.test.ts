import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import type { CreditAssistRow } from '../db/database'
import {
  hasVideoFilter,
  lineupParticipantIds,
  videoCollectionFilter
} from '../events/videoCollections'
import { eventListRoutes } from './eventList'
import { userRoutes } from './users'

describe('TV video collections', function () {
  this.timeout(60000)
  let h: AccountHarness
  let client: TeamStationClient
  before(async () => {
    h = await accountHarness(
      undefined,
      undefined,
      '127.0.0.1',
      (app, { db, media }) => {
        app.use('/api/v1', eventListRoutes(db, media))
        app.use('/api/v1', userRoutes(db, media.space))
      }
    )
    client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    await h.db
      .insertInto('teams')
      .values([
        { id: 'tem_visitors', name: 'Demo Comets' },
        { id: 'tem_private', name: 'Secret Stars' }
      ])
      .execute()
    await insertFixtureUsers(h.db, {
      id: 103,
      display_name: 'Hank Aaron',
      first_name: 'Hank',
      last_name: 'Aaron'
    })
    for (let i = 0; i < 15; i++) {
      const id = `gam_tv_${String(i).padStart(2, '0')}`
      await h.db
        .insertInto('games')
        .values({
          id,
          home_team_id: i === 14 ? 'tem_private' : 'tem_account',
          away_team_id: 'tem_visitors',
          start_at: new Date(Date.UTC(2026, 8, i + 1))
        })
        .execute()
      if (i === 13) continue
      await h.db
        .insertInto('videos')
        .values({
          id: `vid_tv_${i}`,
          game_id: id,
          title: 'Field',
          kind: 'program',
          storage: 'local',
          status: i === 11 ? 'processing' : 'ready',
          hidden: i === 12,
          created_at: new Date(Date.UTC(2026, 9, i === 0 ? 30 : i + 1))
        })
        .execute()
    }
    await h.db
      .insertInto('videos')
      .values({
        id: 'vid_tv_second',
        game_id: 'gam_tv_00',
        title: 'Dugout',
        kind: 'program',
        storage: 'local',
        status: 'ready',
        created_at: new Date('2026-10-31T00:00:00Z')
      })
      .execute()
    await h.db
      .insertInto('game_player_stats')
      .values([
        {
          id: 'stat_tv_1',
          game_id: 'gam_tv_00',
          gumbo_id: 102,
          team_id: 'tem_account',
          pa: 1
        },
        {
          id: 'stat_tv_2',
          game_id: 'gam_tv_14',
          gumbo_id: 103,
          team_id: 'tem_private',
          pa: 1
        }
      ])
      .execute()
    await h.db
      .insertInto('events')
      .values({
        id: 'evt_tv',
        gameId: 'gam_tv_01',
        gumbo: { about: { atBatIndex: 0 } }
      })
      .execute()
    await h.db
      .insertInto('event_players')
      .values({
        id: 'ep_tv',
        event_id: 'evt_tv',
        gumbo_id: 102,
        role: 'fielder'
      })
      .execute()
  })
  after(async () => {
    await h?.close()
  })
  it('validates query shapes, defaults and incompatible legacy filters', () => {
    expect(hasVideoFilter({})).equals(false)
    expect(() => hasVideoFilter({ participant: userIdOfGumbo(101) })).throws(
      'requires hasVideo'
    )
    expect(hasVideoFilter({ hasVideo: 'true' })).equals(true)
    expect(() => hasVideoFilter({ hasVideo: '0' })).throws()
    expect(videoCollectionFilter({})).includes({
      q: '',
      limit: 50,
      offset: 0,
      sort: 'date'
    })
    for (const query of [
      { team: [] },
      { participant: 'bad' },
      { sort: 'other' },
      { limit: '0' },
      { limit: '101' },
      { offset: '-1' },
      { q: '' },
      { when: 'past' }
    ])
      expect(() => videoCollectionFilter(query)).throws()
  })
  it('deduplicates camera angles and separates game date from upload date with stable pagination', async () => {
    const games = await client.videoGames()
    expect(games).length(11)
    expect(games[0].id).equals('gam_tv_10')
    const uploads = await client.videoGames({ sort: 'upload', limit: 1 })
    expect(uploads[0]).includes({
      id: 'gam_tv_00',
      latestVideoId: 'vid_tv_second',
      latestVideoAt: '2026-10-31T00:00:00.000Z'
    })
    expect(uploads[0].posterUrl).includes('vid_tv_second')
    expect(
      (await client.videoGames({ offset: 10, limit: 4 })).map(g => g.id)
    ).deep.equals(['gam_tv_00'])
    expect(await client.videoGames({ offset: 11 })).deep.equals([])
    expect(await client.videoGames({ team: 'tem_private' })).deep.equals([])
    expect((await client.videoGames({ q: 'comets' })).length).equals(11)
    expect(await client.videoGames({ q: 'no match' })).deep.equals([])
  })
  it('excludes empty recordings before choosing a hero, paginating or deriving identities', async () => {
    const originals = await h.db
      .selectFrom('videos')
      .select(['id', 'duration_sec'])
      .execute()
    try {
      await h.db
        .updateTable('videos')
        .set({ duration_sec: 0 })
        .where('id', '=', 'vid_tv_second')
        .execute()
      expect(
        (await client.videoGames({ sort: 'upload', limit: 1 }))[0].latestVideoId
      ).equals('vid_tv_0')
      await h.db.updateTable('videos').set({ duration_sec: 0 }).execute()
      expect(await client.videoGames({ limit: 1 })).deep.equals([])
      expect(await client.videoTeams()).deep.equals([])
      expect(await client.videoPlayers()).deep.equals([])
      await h.db
        .updateTable('videos')
        .set({ duration_sec: null, status: 'live' })
        .where('id', '=', 'vid_tv_second')
        .execute()
      expect((await client.videoGames({ limit: 1 }))[0].id).equals('gam_tv_00')
    } finally {
      for (const row of originals)
        await h.db
          .updateTable('videos')
          .set({ duration_sec: row.duration_sec })
          .where('id', '=', row.id)
          .execute()
      await h.db
        .updateTable('videos')
        .set({ status: 'ready' })
        .where('id', '=', 'vid_tv_second')
        .execute()
    }
  })
  it('uses recorded participation and privacy names, never current roster membership', async () => {
    const player = userIdOfGumbo(102)
    expect(
      (await client.videoGames({ participant: player })).map(g => g.id)
    ).deep.equals(['gam_tv_01', 'gam_tv_00'])
    expect(
      await client.videoGames({ participant: userIdOfGumbo(101) })
    ).deep.equals([])
    expect((await client.videoPlayers()).map(p => p.userId)).deep.equals([
      player
    ])
    expect((await client.videoPlayers({ q: 'Lou' }))[0].shortName).equals(
      'Lou G'
    )
    expect(await client.videoPlayers({ q: 'Gehrig' })).deep.equals([])
    expect(await client.videoPlayers({ team: 'tem_private' })).deep.equals([])
    expect(await client.videoPlayers({ offset: 1 })).deep.equals([])
  })
  it('lists only teams with playable visible games, including visible opponents', async () => {
    expect((await client.videoTeams()).map(t => t.id)).deep.equals([
      'tem_visitors',
      'tem_account'
    ])
    expect((await client.videoTeams({ q: 'HAWKS', limit: 1 }))[0].id).equals(
      'tem_account'
    )
    expect(
      await client.videoTeams({ participant: userIdOfGumbo(103) })
    ).deep.equals([])
    expect(await client.videoTeams({ offset: 2 })).deep.equals([])
    expect((await client.teams()).map(t => t.id)).deep.equals(['tem_account'])
  })
  it('finds a recorded lineup without requiring a plate appearance', async () => {
    const teams = {
      home: { id: 'tem_account', name: 'Hosts' },
      away: { id: 'tem_visitors', name: 'Visitors' }
    }
    const setup = newSetup(teams, {
      home: [
        {
          gumboId: 103,
          shortName: 'Hank A',
          jersey: '1'
        }
      ],
      away: [
        {
          gumboId: 102,
          shortName: 'Lou G',
          jersey: '2'
        }
      ]
    })
    const session = await ScoringSession.open(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async (_id, change) => {
          await h.db
            .updateTable('games')
            .set({ currentPlay: change.currentPlay as never })
            .where('id', '=', 'gam_tv_02')
            .execute()
          return {
            plays: change.plays,
            currentPlay: change.currentPlay ?? null
          }
        }
      },
      'gam_tv_02',
      { gamePk: 'gam_tv_02', teams, setup }
    )
    session.apply({ type: 'pitch', call: 'B' })
    await session.flush()
    expect(session.problem).equals(null)
    expect(
      (await client.videoGames({ participant: userIdOfGumbo(103) })).map(
        g => g.id
      )
    ).deep.equals(['gam_tv_02'])
    expect(
      (await client.videoPlayers()).map(person => person.shortName)
    ).deep.equals(['Hank A', 'Lou G'])
    await h.db
      .updateTable('games')
      .set({ currentPlay: null })
      .where('id', '=', 'gam_tv_02')
      .execute()
    const person = { gumboId: 103, name: 'Hank A', jersey: '1' }
    expect(
      lineupParticipantIds([
        {
          start: null,
          current: null,
          changes: [
            {
              atBatIndex: 0,
              inning: 1,
              half: 'top',
              side: 'away',
              eventType: 'offensive_substitution',
              player: person,
              position: null,
              battingOrder: null,
              replaced: null,
              description: ''
            }
          ]
        }
      ])
    ).deep.equals([103])
  })
  it('personalizes only authorized highlights and retains public preview behavior', async () => {
    const start = new Date('2026-09-01T16:00:00Z')
    await h.db
      .updateTable('videos')
      .set({ start_at: start, duration_sec: 600 })
      .where('id', '=', 'vid_tv_0')
      .execute()
    await h.db
      .insertInto('user_links')
      .values({
        id: 'link_tv_guardian',
        user_id: userIdOfGumbo(101),
        related_user_id: userIdOfGumbo(102),
        kind: 'guardian'
      })
      .execute()
    for (const [i, id] of [101, 102, 103].entries()) {
      await h.db
        .insertInto('events')
        .values({
          id: `evt_clip_${i}`,
          gameId: 'gam_tv_00',
          startTime: new Date(start.getTime() + (i + 1) * 60000),
          gumbo: {
            about: {
              atBatIndex: i,
              isScoringPlay: false,
              inning: 1,
              halfInning: 'top'
            },
            result: { eventType: 'single' },
            credits: []
          }
        })
        .execute()
      await h.db
        .insertInto('eventCredits')
        .values({
          id: `credit_tv_${i}`,
          eventId: `evt_clip_${i}`,
          eventType: 'single',
          head: 'Single',
          creditGumboId: id,
          teamId: 'tem_account',
          role: 'batter',
          assists: sql<
            CreditAssistRow[]
          >`${JSON.stringify(i === 2 ? [{ gumboId: 101, position: 'SS' }] : [])}::jsonb`
        })
        .execute()
    }
    const clips = await client.tvHighlights('vid_tv_0')
    expect(clips).length(3)
    expect(clips.every(c => c.preferred)).equals(true)
    await sql`update "eventCredits" set assists='[]'::jsonb where id='credit_tv_2'`.execute(
      h.db
    )
    expect(
      (await client.tvHighlights('vid_tv_0')).find(
        c => c.eventId === 'evt_clip_2'
      )?.preferred
    ).equals(false)
    const ordinary = await (
      await h.request('GET', '/videos/vid_tv_0/highlights', undefined, null)
    ).json()
    expect(ordinary.highlights[0]).not.has.property('preferred')
    expect(
      (
        await h.request(
          'GET',
          '/videos/vid_tv_0/highlights?personalized=1',
          undefined,
          null
        )
      ).status
    ).equals(401)
    expect(
      (await h.request('GET', '/videos/vid_tv_14/highlights?personalized=1'))
        .status
    ).equals(404)
    expect(
      (await h.request('GET', '/videos/vid_tv_0/highlights?personalized=yes'))
        .status
    ).equals(400)
    expect(
      (await h.request('GET', '/videos/vid_tv_12/highlights?personalized=1'))
        .status
    ).equals(404)
    await h.db
      .deleteFrom('user_links')
      .where('id', '=', 'link_tv_guardian')
      .execute()
  })
  it('keeps historical participation and family credits after an account merge', async () => {
    await h.db
      .insertInto('game_player_stats')
      .values({
        id: 'stat_tv_alias',
        game_id: 'gam_tv_03',
        gumbo_id: 103,
        team_id: 'tem_account',
        pa: 1
      })
      .execute()
    await h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(102) })
      .where('id', '=', userIdOfGumbo(103))
      .execute()
    await h.db
      .insertInto('user_links')
      .values({
        id: 'link_tv_alias',
        user_id: userIdOfGumbo(101),
        related_user_id: userIdOfGumbo(102),
        kind: 'guardian'
      })
      .execute()
    expect(
      (await client.videoGames({ participant: userIdOfGumbo(102) })).map(
        g => g.id
      )
    ).includes('gam_tv_03')
    expect((await client.videoPlayers()).map(p => p.userId)).not.includes(
      userIdOfGumbo(103)
    )
    expect(
      (await client.tvHighlights('vid_tv_0')).find(
        c => c.eventId === 'evt_clip_2'
      )?.preferred
    ).equals(true)
    await h.db
      .deleteFrom('user_links')
      .where('id', '=', 'link_tv_alias')
      .execute()
    await h.db
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', userIdOfGumbo(103))
      .execute()
  })
  it('does not reveal inaccessible games or identities and rechecks revoked access', async () => {
    for (const route of ['/events', '/teams', '/users']) {
      expect(
        (await h.request('GET', route + '?hasVideo=1', undefined, null)).status
      ).equals(401)
      expect(
        (await h.request('GET', route + '?hasVideo=1&externalId=other')).status
      ).equals(400)
      expect(
        await (
          await h.request('GET', route + '?hasVideo=1', undefined, 102)
        ).json()
      ).deep.equals([])
    }
    await h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    expect(await client.videoGames()).deep.equals([])
    expect(await client.videoPlayers()).deep.equals([])
    expect(await client.videoTeams()).deep.equals([])
  })
})
