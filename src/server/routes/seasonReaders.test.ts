import { expect } from 'chai'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import type { GameRequestTerms } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { publicGames } from '../groups/publicSummary'
import {
  managementPeopleTree,
  peopleInScope,
  scopeTree
} from '../invites/people'
import { annotatePending, pendingSchedule } from '../schedule/pendingProjection'
import { teamRecords } from '../stats/records'
import {
  seasonParticipantCounts,
  seasonParticipants
} from '../stats/seasonTeams'
import { scheduleOf } from './seasons'

describe('season reader projections and privacy', function () {
  this.timeout(60000)
  let f: GroupFixture
  let exhibitionOnly: string
  let idle: string
  let canceledOnly: string
  let played: string
  let pendingId: string
  let replacementId: string
  before(async () => {
    f = await groupFixture()
    exhibitionOnly = makeId('team')
    idle = makeId('team')
    canceledOnly = makeId('team')
    await f.h.db
      .insertInto('teams')
      .values([
        {
          id: exhibitionOnly,
          name: 'Demo Placeholder',
          kind: 'external',
          custodian_type: 'team',
          custodian_id: f.teamA
        },
        { id: idle, name: 'Demo Idle' },
        { id: canceledOnly, name: 'Demo Historical' }
      ])
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: idle })
      .execute()
    played = makeId('game')
    await f.h.db
      .insertInto('games')
      .values([
        {
          id: played,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          season_id: f.seasonA,
          start_at: new Date('2027-04-01T19:00:00Z'),
          status: 'final',
          home_score: 3,
          away_score: 1
        },
        {
          id: makeId('game'),
          home_team_id: f.teamA,
          away_team_id: exhibitionOnly,
          season_id: f.seasonA,
          start_at: new Date('2027-04-02T19:00:00Z'),
          status: 'final',
          home_score: 0,
          away_score: 4,
          exhibition: true
        },
        {
          id: makeId('game'),
          home_team_id: f.teamA,
          away_team_id: canceledOnly,
          season_id: f.seasonA,
          start_at: new Date('2027-04-03T19:00:00Z'),
          status: 'cancelled',
          cancellation_reason: 'withdrawal',
          withdrawn_by_team_id: canceledOnly,
          withdrawn_by_user_id: userIdOfGumbo(101),
          withdrawn_at: new Date('2027-04-03T19:00:00Z'),
          home_score: 20,
          away_score: 0
        }
      ])
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })
  const get = async (path: string, userId = 101): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, userId)
    expect(response.status, path).equals(200)
    return await response.json()
  }
  it('returns disjoint competition/game categories including nonmembers, placeholders and canceled history', async () => {
    const rows = await get(`/seasons/${f.seasonA}/teams`)
    const category = (id: string): any => rows.find((row: any) => row.id === id)
    expect(category(f.teamA).seasonCategory).equals('inSeason')
    expect(category(f.teamB).seasonCategory).equals('inSeason')
    expect(category(exhibitionOnly)).deep.include({
      kind: 'external',
      seasonCategory: 'exhibition'
    })
    expect(category(idle).seasonCategory).equals('unscheduled')
    expect(category(canceledOnly).seasonCategory).equals('unscheduled')
    expect(new Set(rows.map((row: any) => row.id)).size).equals(rows.length)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', f.teamB)
        .where('season_id', '=', f.seasonA)
        .execute()
    ).deep.equals([])
  })
  it('preserves a newly created season-owned child as Unscheduled without competition membership or games', async () => {
    const response = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Owned Idle',
        parent: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'reader-owned-idle',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        }
      },
      101
    )
    expect(response.status, await response.clone().text()).equals(201)
    const { id } = (await response.json()) as { id: string }
    const membershipBefore = await f.h.db
      .selectFrom('season_teams')
      .selectAll()
      .where('season_id', '=', f.seasonA)
      .execute()
    expect(membershipBefore.some(row => row.team_id === id)).equals(false)
    expect(
      (await get(`/seasons/${f.seasonA}/teams`)).find(
        (team: any) => team.id === id
      )
    ).deep.include({ seasonCategory: 'unscheduled', record: null })
    const participants = await seasonParticipants(f.h.db, f.seasonA)
    expect(participants.teams.find(team => team.id === id)).deep.include({
      activeMember: false,
      parentMember: true,
      seasonCategory: 'unscheduled'
    })
    expect(
      participants.games.some(
        game => game.homeTeamId === id || game.awayTeamId === id
      )
    ).equals(false)
    expect(
      (
        await get(`/seasons/${f.seasonA}/standings?includeExhibitions=false`)
      ).find((team: any) => team.teamId === id)
    ).deep.include({ played: 0, winningPct: null, streak: null })
    const season = (await get('/seasons')).find(
      (season: any) => season.id === f.seasonA
    )
    expect(season.teams).equals(participants.teams.length)
    expect(await seasonParticipantCounts(f.h.db, [])).deep.equals(new Map())
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('season_id', '=', f.seasonA)
        .execute()
    ).deep.equals(membershipBefore)
    expect(
      (await f.h.request('GET', `/seasons/${f.seasonA}/teams`, undefined, 104))
        .status
    ).equals(404)
  })
  it('validates exhibition selection and preserves the legacy inclusion default with zero-result rows', async () => {
    const regular = await get(
      `/seasons/${f.seasonA}/standings?includeExhibitions=false`
    )
    expect(regular.find((row: any) => row.teamId === f.teamA)).deep.include({
      w: 1,
      l: 0,
      winningPct: 1,
      streak: 'W1'
    })
    expect(regular.some((row: any) => row.teamId === exhibitionOnly)).equals(
      false
    )
    const all = await get(`/seasons/${f.seasonA}/standings`)
    const explicit = await get(
      `/seasons/${f.seasonA}/standings?includeExhibitions=true`
    )
    expect(all).deep.equals(explicit)
    expect(all.find((row: any) => row.teamId === f.teamA)).deep.include({
      w: 1,
      l: 1,
      winningPct: 0.5,
      streak: 'L1'
    })
    expect(all.find((row: any) => row.teamId === idle)).deep.include({
      played: 0,
      winningPct: null,
      gamesBehind: null,
      streak: null
    })
    expect(
      (
        await f.h.request(
          'GET',
          `/seasons/${f.seasonA}/standings?includeExhibitions=no`,
          undefined,
          101
        )
      ).status
    ).equals(400)
  })
  it('preserves canceled scores and withdrawal history without pending annotations', async () => {
    const rows = await get(`/events?season=${f.seasonA}`)
    const canceled = rows.find((row: any) => row.awayTeamId === canceledOnly)
    expect(canceled).deep.include({
      status: 'cancelled',
      pendingApproval: false,
      homeScore: 20,
      cancellationReason: 'withdrawal',
      withdrawnByTeamId: canceledOnly,
      withdrawnByTeamName: 'Demo Historical'
    })
    expect(await get(`/games/${canceled.id}`)).deep.include({
      cancellationReason: 'withdrawal',
      withdrawnByTeamName: 'Demo Historical'
    })
  })
  it('keeps historical record inclusion by default and supports explicit exhibition exclusion', async () => {
    expect(
      (await teamRecords(f.h.db, { seasonId: f.seasonA })).find(
        row => row.teamId === f.teamA
      )
    ).deep.include({ w: 1, l: 1 })
    expect(
      (
        await teamRecords(f.h.db, {
          seasonId: f.seasonA,
          includeExhibitions: false
        })
      ).find(row => row.teamId === f.teamA)
    ).deep.include({ w: 1, l: 0 })
  })
  it('gates season statistics before reading rows and returns typed empty aggregates for authorized readers', async () => {
    expect(await get(`/seasons/${f.seasonA}/stats`)).deep.equals({
      seasonId: f.seasonA,
      batting: [],
      pitching: []
    })
    expect(
      (await f.h.request('GET', `/seasons/${f.seasonA}/stats`, undefined, 104))
        .status
    ).equals(404)
    const publicPage = await f.h.request(
      'GET',
      `/seasons/${f.seasonA}`,
      undefined,
      104
    )
    expect(publicPage.status).equals(200)
    const page = await publicPage.json()
    expect(page.canViewPrivate).equals(false)
    expect(page).not.has.property('batting')
  })
  it('aggregates batting and pitching from the chosen season only with shortened identities', async () => {
    const foreign = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: foreign,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date('2027-04-06T19:00:00Z'),
        status: 'final'
      })
      .execute()
    await f.h.db
      .insertInto('game_player_stats')
      .values(
        [played, foreign].map(gameId => ({
          id: makeId('gamePlayerStats'),
          game_id: gameId,
          gumbo_id: 104,
          team_id: f.teamA,
          pa: 4,
          ab: 3,
          h: 2,
          singles: 1,
          doubles: 1,
          bb: 1,
          pitch_bf: 6,
          pitch_outs: 6,
          pitch_h: 1,
          pitch_bb: 1,
          pitch_er: 1
        }))
      )
      .execute()
    const stats = await get(`/seasons/${f.seasonA}/stats`)
    expect(stats.batting).length(1)
    expect(stats.pitching).length(1)
    expect(stats.batting[0]).deep.include({
      userId: userIdOfGumbo(104),
      ab: 3,
      h: 2,
      g: 1
    })
    expect(stats.batting[0].rates.avg).equals(0.667)
    expect(stats.pitching[0]).deep.include({ outs: 6, ip: '2.0', g: 1 })
    expect(stats.pitching[0].rates.era).equals(3)
    expect(stats.batting[0]).not.has.property('firstName')
    expect(stats.batting[0]).not.has.property('lastName')
  })
  it('narrows management people only, preserving the broad tree for other consumers', async () => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamA,
        user_id: userIdOfGumbo(104),
        role: 'member'
      })
      .execute()
    const broad = await scopeTree(f.h.db, 'league', f.leagueA)
    expect(broad?.teams.map(team => team.id)).includes(f.teamA)
    const league = await managementPeopleTree(f.h.db, 'league', f.leagueA)
    const season = await managementPeopleTree(f.h.db, 'season', f.seasonA)
    expect(league?.teams).deep.equals([])
    expect(league?.seasons).deep.equals([])
    expect(season?.teams).deep.equals([])
    expect(
      (await peopleInScope(f.h.db, league!)).some(
        person => person.userId === userIdOfGumbo(104)
      )
    ).equals(false)
    const placeholder = await managementPeopleTree(
      f.h.db,
      'team',
      exhibitionOnly
    )
    expect(
      (await peopleInScope(f.h.db, placeholder!)).some(
        person => person.userId === userIdOfGumbo(104)
      )
    ).equals(true)
    const own = await managementPeopleTree(f.h.db, 'team', f.teamA)
    expect(
      (await peopleInScope(f.h.db, own!)).some(
        person => person.userId === userIdOfGumbo(104)
      )
    ).equals(true)
    const page = await get(`/manage/season/${f.seasonA}`)
    expect(
      page.people.some((person: any) => person.userId === userIdOfGumbo(104))
    ).equals(false)
  })
  it('projects stable pending new identities on global/team/season/public schedules without private terms or scoring access', async () => {
    pendingId = 'req_reader_pending'
    replacementId = makeId('game')
    const terms: GameRequestTerms = {
      kind: 'game',
      game: {
        homeTeamId: f.teamA,
        awayTeamId: f.teamB,
        seasonId: f.seasonA,
        startAt: '2027-04-04T19:00:00Z',
        venue: 'Demo Field',
        outsideTournament: null,
        status: 'scheduled'
      },
      affectedTeamIds: [f.teamA, f.teamB, f.standaloneTeam],
      hostSeasonIds: [f.seasonA],
      gameId: null,
      proposedGameId: replacementId,
      expected: null,
      previous: null
    }
    await f.h.db
      .insertInto('group_requests')
      .values({
        id: pendingId,
        kind: 'game',
        sender_scope_type: 'team',
        sender_scope_id: f.teamA,
        initiating_team_id: f.teamA,
        terms,
        sender_id: userIdOfGumbo(101),
        status: 'pending',
        sent_at: new Date(),
        expires_at: new Date('2090-01-01T00:00:00Z')
      })
      .execute()
    for (const path of [
      '/events',
      `/events?season=${f.seasonA}`,
      `/teams/${f.teamA}/games`
    ]) {
      const rows = await get(path)
      const row = rows.find((row: any) => row.id === replacementId)
      expect(row, path).deep.include({
        pendingApproval: true,
        pendingRequestId: pendingId,
        homeTeamName: 'Demo Hawks',
        homeScore: null,
        videoCount: 0
      })
      expect(row).not.has.property('terms')
      expect(row).not.has.property('previous')
    }
    const publicRows = await publicGames(f.h.db, {
      kind: 'season',
      id: f.seasonA
    })
    expect(publicRows.find(row => row.id === replacementId)).deep.include({
      pendingApproval: true,
      pendingRequestId: null
    })
    expect(
      (await get('/events?scope=run')).some(
        (row: any) => row.id === replacementId
      )
    ).equals(false)
    expect(
      (await f.h.request('GET', `/games/${replacementId}`, undefined, 101))
        .status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'POST',
          `/games/${replacementId}/events`,
          { plays: [] },
          101
        )
      ).status
    ).equals(404)
  })
  it('applies shared time/order/limit filters to projected rows and keeps request access private', async () => {
    const media = {
      space: f.h.space,
      ffmpegPath: 'ffmpeg',
      mediaRoot: '/tmp',
      mediaSecret: 'demo-secret',
      publicUrl: f.h.origin
    }
    const empty = {
      teamIds: new Set<string>(),
      seasonIds: new Set<string>(),
      isAdmin: false
    }
    expect(await scheduleOf(f.h.db, media, { visible: empty })).deep.equals([])
    const removed = {
      teamIds: new Set([f.standaloneTeam]),
      seasonIds: new Set<string>(),
      isAdmin: false
    }
    expect(
      (await scheduleOf(f.h.db, media, { visible: removed })).map(row => row.id)
    ).deep.equals([])
    const visible = {
      teamIds: new Set([f.teamA]),
      seasonIds: new Set<string>(),
      isAdmin: false
    }
    const future = await scheduleOf(f.h.db, media, {
      visible,
      now: new Date('2027-04-03T20:00:00Z'),
      future: true,
      order: 'asc',
      limit: 1
    })
    expect(future.map(row => row.id)).deep.equals([replacementId])
    expect(future[0].pendingRequestId).equals(null)
    for (const ref of [
      { kind: 'team' as const, id: f.teamA },
      { kind: 'league' as const, id: f.leagueA }
    ])
      expect(
        (await publicGames(f.h.db, ref)).some(row => row.id === replacementId)
      ).equals(true)
    expect(
      (await get('/events?when=finished')).some(
        (row: any) => row.id === replacementId
      )
    ).equals(false)
    expect(
      (await get('/events?scope=film')).some(
        (row: any) => row.id === replacementId
      )
    ).equals(false)
    expect(
      (
        await get(
          `/events?since=2027-04-04T19:00:00Z&until=2027-04-05T00:00:00Z&limit=1`
        )
      ).map((row: any) => row.id)
    ).deep.equals([replacementId])
    const own = await scheduleOf(f.h.db, media, {
      visible,
      since: new Date('2027-04-04T19:00:00Z'),
      until: new Date('2027-04-04T19:00:00Z'),
      untilInclusive: true
    })
    expect(own.map(row => row.id)).deep.equals([replacementId])
    expect(
      await scheduleOf(f.h.db, media, { visible, externalIds: ['missing'] })
    ).deep.equals([])
  })
  it('applies time filters before bounded published selection and interleaves pending rows deterministically', async () => {
    const media = {
      space: f.h.space,
      ffmpegPath: 'ffmpeg',
      mediaRoot: '/tmp',
      mediaSecret: 'demo-secret',
      publicUrl: f.h.origin
    }
    const base = {
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA
    }
    await f.h.db
      .insertInto('games')
      .values([
        {
          ...base,
          id: 'gam_limit_past',
          start_at: new Date('2000-01-01T19:00:00Z'),
          status: 'scheduled'
        },
        {
          ...base,
          id: 'gam_limit_upcoming',
          start_at: new Date('2027-04-30T19:00:00Z'),
          status: 'scheduled'
        },
        {
          ...base,
          id: 'gam_limit_scored',
          start_at: new Date('2027-05-01T19:00:00Z'),
          status: 'final',
          home_score: 3,
          away_score: 1
        }
      ])
      .execute()
    const common = { teamId: f.teamA, limit: 1 }
    expect(
      (
        await scheduleOf(f.h.db, media, {
          ...common,
          future: true,
          order: 'asc'
        })
      ).map(row => row.id)
    ).deep.equals([played])
    expect(
      (await scheduleOf(f.h.db, media, { ...common, upcoming: true })).map(
        row => row.id
      )
    ).deep.equals(['gam_limit_upcoming'])
    await f.h.db
      .insertInto('games')
      .values({
        ...base,
        id: 'gam_limit_far_future',
        start_at: new Date('2027-06-01T19:00:00Z'),
        status: 'scheduled'
      })
      .execute()
    expect(
      (await scheduleOf(f.h.db, media, { ...common, past: true })).map(
        row => row.id
      )
    ).deep.equals(['gam_limit_scored'])
    await f.h.db
      .insertInto('games')
      .values(
        ['gam_limit_A', 'gam_limit_a', 'gam_limit_z'].map(id => ({
          ...base,
          id,
          start_at: new Date('2027-04-04T19:00:00Z'),
          status: 'scheduled' as const
        }))
      )
      .execute()
    for (const order of ['asc', 'desc'] as const) {
      const filter = {
        teamId: f.teamA,
        since: new Date('2027-04-04T19:00:00Z'),
        until: new Date('2027-04-05T00:00:00Z'),
        order
      }
      const full = await scheduleOf(f.h.db, media, filter)
      for (const limit of [1, 2]) {
        const limited = await scheduleOf(f.h.db, media, { ...filter, limit })
        expect(limited.map(row => row.id)).deep.equals(
          full.slice(0, limit).map(row => row.id)
        )
      }
    }
  })
  it('annotates retained matchup once, preserves canceled originals, and clears expired/declined/withdrawn flags', async () => {
    await f.h.db
      .updateTable('group_requests')
      .set({
        terms: {
          kind: 'game',
          game: {
            homeTeamId: f.teamB,
            awayTeamId: f.teamA,
            seasonId: f.seasonA,
            startAt: '2027-05-01T19:00:00Z',
            venue: null,
            outsideTournament: null,
            status: 'scheduled'
          },
          affectedTeamIds: [f.teamA, f.teamB],
          hostSeasonIds: [f.seasonA],
          gameId: played,
          proposedGameId: played,
          expected: 'version',
          previous: null
        }
      })
      .where('id', '=', pendingId)
      .execute()
    const rows = await get(`/events?season=${f.seasonA}`)
    expect(rows.filter((row: any) => row.id === played)).length(1)
    expect(rows.find((row: any) => row.id === played)).deep.include({
      pendingApproval: true,
      homeTeamId: f.teamA,
      startAt: '2027-04-01T19:00:00.000Z',
      homeScore: 3,
      status: 'final'
    })
    const pending = await pendingSchedule(f.h.db)
    expect(
      annotatePending([{ id: played, status: 'cancelled' }], pending)[0]
        .pendingApproval
    ).equals(false)
    for (const status of ['declined', 'cancelled', 'expired'] as const) {
      await f.h.db
        .updateTable('group_requests')
        .set({ status })
        .where('id', '=', pendingId)
        .execute()
      expect(
        (await get('/events')).find((row: any) => row.id === played)
          .pendingApproval
      ).equals(false)
    }
    await f.h.db
      .updateTable('group_requests')
      .set({
        status: 'pending',
        sent_at: new Date('1999-01-01'),
        expires_at: new Date('2000-01-01')
      })
      .where('id', '=', pendingId)
      .execute()
    expect(
      (await get('/events')).find((row: any) => row.id === played)
        .pendingApproval
    ).equals(false)
  })
})

describe('replacement schedule participant visibility', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  const get = async (path: string, userId: number): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, userId)
    expect(response.status, path).equals(200)
    return await response.json()
  }
  const original = async (): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2027-04-10T19:00:00Z'),
        venue: 'Demo Original Field',
        status: 'scheduled'
      })
      .execute()
    return id
  }
  const replace = async (id: string, key: string): Promise<any> => {
    const scheduling = await get(`/games/${id}/scheduling`, 101)
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId: id,
        expected: scheduling.version,
        game: {
          ...scheduling.game,
          awayTeamId: f.standaloneTeam,
          venue: 'Demo Proposed Field'
        },
        idempotencyKey: key
      },
      101
    )
    expect(response.status, await response.clone().text()).equals(201)
    return await response.json()
  }

  it('keeps a removed team on its canceled original while proposed participants and the host see the new pending game', async () => {
    const oldId = await original()
    const proposal = await replace(oldId, 'reader-unmanaged-replacement')
    expect(proposal).deep.include({
      status: 'pending',
      gameId: null,
      replacesGameId: oldId
    })
    expect(proposal.proposedGameId).not.equals(oldId)
    const newId = proposal.proposedGameId
    for (const path of [`/teams/${f.teamB}/games`, '/events']) {
      const removed = await get(path, 102)
      expect(removed.find((row: any) => row.id === oldId)).deep.include({
        status: 'cancelled',
        cancellationReason: 'replacement',
        pendingApproval: false,
        awayTeamId: f.teamB
      })
      expect(
        removed.some((row: any) => row.id === newId),
        path
      ).equals(false)
    }
    const removedPublic = await publicGames(f.h.db, {
      kind: 'team',
      id: f.teamB
    })
    expect(removedPublic.find(row => row.id === oldId)).deep.include({
      status: 'cancelled',
      pendingApproval: false
    })
    expect(removedPublic.some(row => row.id === newId)).equals(false)
    for (const [path, user] of [
      [`/teams/${f.teamA}/games`, 101],
      [`/teams/${f.standaloneTeam}/games`, 103],
      [`/events?season=${f.seasonA}`, 101],
      ['/events', 103]
    ] as const) {
      const rows = await get(path, user)
      expect(
        rows.find((row: any) => row.id === newId),
        path
      ).deep.include({
        pendingApproval: true,
        homeTeamId: f.teamA,
        awayTeamId: f.standaloneTeam
      })
    }
    for (const ref of [
      { kind: 'team' as const, id: f.teamA },
      { kind: 'team' as const, id: f.standaloneTeam },
      { kind: 'season' as const, id: f.seasonA }
    ]) {
      const rows = await publicGames(f.h.db, ref)
      expect(rows.find(row => row.id === newId)).deep.include({
        pendingApproval: true,
        pendingRequestId: null
      })
    }
  })

  it('keeps a managed original matchup pending for its original teams until acceptance updates that same ID', async () => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(101),
        scope_type: 'team',
        scope_id: f.teamB,
        role: 'admin',
        granted_by: userIdOfGumbo(105)
      })
      .execute()
    const oldId = await original()
    const proposal = await replace(oldId, 'reader-managed-replacement')
    expect(proposal).deep.include({
      status: 'pending',
      gameId: oldId,
      proposedGameId: oldId,
      replacesGameId: null
    })
    const removed = await get(`/teams/${f.teamB}/games`, 102)
    expect(removed.filter((row: any) => row.id === oldId)).length(1)
    expect(removed.find((row: any) => row.id === oldId)).deep.include({
      status: 'scheduled',
      pendingApproval: true,
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      venue: 'Demo Original Field'
    })
    const publicOriginal = await publicGames(f.h.db, {
      kind: 'team',
      id: f.teamB
    })
    expect(publicOriginal.find(row => row.id === oldId)).deep.include({
      pendingApproval: true,
      venue: 'Demo Original Field'
    })
    expect(
      (await get(`/teams/${f.standaloneTeam}/games`, 103)).some(
        (row: any) => row.id === oldId
      )
    ).equals(false)
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${proposal.id}/accept`,
      {},
      103
    )
    expect(accepted.status, await accepted.clone().text()).equals(200)
    expect(await accepted.json()).deep.include({ gameId: oldId })
    expect(
      (await get(`/teams/${f.teamB}/games`, 102)).some(
        (row: any) => row.id === oldId
      )
    ).equals(false)
    expect(
      (await get(`/teams/${f.standaloneTeam}/games`, 103)).find(
        (row: any) => row.id === oldId
      )
    ).deep.include({
      pendingApproval: false,
      awayTeamId: f.standaloneTeam,
      venue: 'Demo Proposed Field'
    })
  })
})
