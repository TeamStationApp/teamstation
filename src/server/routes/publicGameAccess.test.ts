import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asRosterEntry, TeamStationClient } from '../../common/api'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { receivingVideoIds } from '../live/receiving'
import { mediaRoutes } from './media'

describe('public game access', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use('/api/v1', mediaRoutes(db, media))
    })
    await seedSettingsCleanup3(f)
    await f.h.db
      .updateTable('games')
      .set({
        notes: 'Private team notes',
        linescore: {
          away: { runs: [1, 1], r: 2, h: 5, e: 1 },
          home: { runs: [3, 1], r: 4, h: 7, e: 0 }
        }
      })
      .where('id', '=', 'gam_settings3_final')
      .execute()
    await f.h.db
      .insertInto('videos')
      .values([
        {
          id: 'vid_public',
          title: 'Demo recording',
          game_id: 'gam_settings3_final',
          kind: 'program',
          status: 'ready',
          storage: 'local',
          duration_sec: 30
        },
        {
          id: 'vid_hidden',
          title: 'Hidden recording',
          game_id: 'gam_settings3_final',
          kind: 'program',
          status: 'ready',
          storage: 'local',
          duration_sec: 30,
          hidden: true
        }
      ])
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })
  it('preserves public staff photos for anonymous and signed-in nonmembers, but hides player photos', async () => {
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'public-staff.png' })
      .where('id', '=', 101)
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'private-player.png' })
      .where('id', '=', 104)
      .execute()
    const anonymous = await f.h.request(
      'GET',
      `/teams/${f.teamA}`,
      undefined,
      null
    )
    const detail = await anonymous.json()
    expect(
      detail.staff.some(
        (person: { avatarUrl: string | null }) => person.avatarUrl != null
      )
    ).equals(true)
    for (const userId of [101, 103]) {
      const response = await f.h.request(
        'GET',
        `/teams/${f.teamA}/roster`,
        undefined,
        userId
      )
      const roster = (await response.json()).map(asRosterEntry)
      expect(
        roster.find(
          (person: ReturnType<typeof asRosterEntry>) => person.userId === 101
        )?.avatarUrl
      ).is.a('string')
      if (userId === 103)
        expect(
          roster
            .filter(
              (person: ReturnType<typeof asRosterEntry>) =>
                person.section === 'player'
            )
            .every(
              (person: ReturnType<typeof asRosterEntry>) =>
                person.avatarUrl == null
            )
        ).equals(true)
    }
  })
  for (const user of [null, 103])
    it(`lets ${user == null ? 'anonymous' : 'nonmember'} viewers browse games while protecting playback and detailed stats`, async () => {
      const response = await f.h.request(
        'GET',
        '/games/gam_settings3_final',
        undefined,
        user
      )
      expect(response.status).equals(200)
      const game = await response.json()
      expect(game.nonMemberView).equals(true)
      expect(game.linescore.away.runs).deep.equals([1, 1])
      expect(game.linescore.away.h).equals(null)
      expect(game.notes).equals(null)
      expect(game.scoreboard).equals(null)
      expect(game.canScore).equals(false)
      expect(game.canDj).equals(false)
      expect(game.coachSides).deep.equals([])
      expect(
        (
          await f.h.request(
            'GET',
            '/videos/vid_public/highlights',
            undefined,
            user
          )
        ).status
      ).equals(200)
      expect(
        (
          await f.h.request(
            'GET',
            '/videos/vid_hidden/highlights',
            undefined,
            user
          )
        ).status
      ).equals(404)

      expect(game.videos.map((video: { id: string }) => video.id)).deep.equals([
        'vid_public'
      ])
      const group = await f.h.request(
        'GET',
        `/teams/${f.teamA}`,
        undefined,
        user
      )
      expect(group.status).equals(200)
      expect(
        (await group.json()).games.find(
          (game: { id: string }) => game.id === 'gam_settings3_final'
        ).videoCount
      ).equals(1)
      for (const route of [
        '/videos/vid_public/playback',
        '/games/gam_settings3_final/box-score',
        '/games/tev_settings3_practice'
      ]) {
        const denied = await f.h.request('GET', route, undefined, user)
        expect(denied.status, route).oneOf([401, 403, 404])
      }
    })
  it('opens on Primary when the cameras of a take started together', async () => {
    const start = new Date('2026-10-18T16:00:00.000Z')
    const earlier = new Date('2026-10-18T15:00:00.000Z')
    const gameId = 'gam_settings3_scheduled'
    const rows = [
      {
        id: 'vid_lead_a_1st',
        title: 'Demo Hawks at Demo Jets 1st'
      },
      {
        id: 'vid_lead_b_home',
        title: 'Demo Hawks at Demo Jets Home'
      },
      {
        id: 'vid_lead_c_3rd',
        title: 'Demo Hawks at Demo Jets 3rd'
      },
      {
        id: 'vid_lead_d_primary',
        title: 'Demo Hawks at Demo Jets Primary'
      }
    ]
    await f.h.db
      .insertInto('videos')
      .values([
        ...rows.map(row => ({
          ...row,
          game_id: gameId,
          kind: 'program' as const,
          status: 'ready' as const,
          storage: 'local' as const,
          duration_sec: 30,
          start_at: start
        })),
        {
          id: 'vid_lead_z_early',
          title: 'Demo Hawks at Demo Jets earlier take',
          game_id: gameId,
          kind: 'program' as const,
          status: 'ready' as const,
          storage: 'local' as const,
          duration_sec: 30,
          start_at: earlier
        }
      ])
      .execute()
    try {
      const response = await f.h.request(
        'GET',
        `/games/${gameId}`,
        undefined,
        null
      )
      expect(response.status).equals(200)
      const game = await response.json()
      expect(game.videos.map((video: { id: string }) => video.id)).deep.equals([
        'vid_lead_z_early',
        'vid_lead_d_primary',
        'vid_lead_a_1st',
        'vid_lead_b_home',
        'vid_lead_c_3rd'
      ])
    } finally {
      await f.h.db
        .deleteFrom('videos')
        .where('game_id', '=', gameId)
        .where('id', 'like', 'vid_lead_%')
        .execute()
    }
  })

  it('retains member game details, statistics and playback authorization', async () => {
    const response = await f.h.request(
      'GET',
      '/games/gam_settings3_final',
      undefined,
      101
    )
    const game = await response.json()
    expect(game.nonMemberView).equals(false)
    expect(game.notes).equals('Private team notes')
    expect(game.linescore.away.h).equals(5)
    expect(
      (
        await f.h.request(
          'GET',
          '/games/gam_settings3_final/box-score',
          undefined,
          101
        )
      ).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/videos/vid_public/playback', undefined, 101))
        .status
    ).equals(200)
  })
  it('creates a roster player through the typed client', async () => {
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)
    })
    const entry = await api.createRosterPlayer(f.teamA, {
      firstName: 'Mookie',
      lastName: 'Betts',
      jersey: '50',
      positions: ['RF'],
      bats: 'right',
      throws: 'right'
    })
    expect(entry.isPlayer).equals(true)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('login_enabled')
          .where('id', '=', entry.userId)
          .executeTakeFirstOrThrow()
      ).login_enabled
    ).equals(false)
  })
  it('reads receiving video IDs from publishing streams and ignores idle or malformed snapshots', async () => {
    const snapshot = (bytesPerSecond: number): unknown => ({
      liveStreamId: 'liv_public',
      ingress: {
        publishing: true,
        receivingPackets: bytesPerSecond > 0,
        bytesReceived: 1000,
        bytesPerSecond
      },
      outputs: []
    })
    const now = new Date()
    await f.h.db
      .insertInto('live_streams')
      .values({
        id: 'liv_public',
        game_id: 'gam_settings3_final',
        team_id: f.teamA,
        user_id: 101,
        label: 'Demo camera',
        key_hash: '0'.repeat(64),
        key_prefix: 'demo',
        key_cipher: '0'.repeat(64),
        state: 'publishing',
        opens_at: now,
        closes_at: null,
        video_id: 'vid_public',
        status: snapshot(100),
        status_at: now,
        last_error: null,
        first_published_at: now,
        last_published_at: now,
        ended_at: null,
        created_by: 101,
        created_at: now,
        updated_at: now
      })
      .execute()
    expect([...(await receivingVideoIds(f.h.db, ['vid_public']))]).deep.equals([
      'vid_public'
    ])
    await f.h.db
      .updateTable('live_streams')
      .set({ status: snapshot(0) })
      .where('id', '=', 'liv_public')
      .execute()
    expect([...(await receivingVideoIds(f.h.db, ['vid_public']))]).deep.equals(
      []
    )
    await f.h.db
      .updateTable('live_streams')
      .set({ status: snapshot(100), state: 'idle' })
      .where('id', '=', 'liv_public')
      .execute()
    expect([...(await receivingVideoIds(f.h.db, ['vid_public']))]).deep.equals(
      []
    )
    expect([...(await receivingVideoIds(f.h.db, []))]).deep.equals([])
  })
})
