import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { addDays } from '../../common/calendarDates'
import { gameCalendarDay, gameTime } from '../../common/gameTime'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { createSession } from '../auth/sessions'
import { completionNotice } from '../notifications/completionNotice'

/**
 * A member asking to film their team's games, through the real routes:
 * `POST /relationship-requests` and `GET /games/:gameId/stream-access`.
 */
describe('videographer requests', function () {
  this.timeout(60000)
  const ADMIN = 101
  const OTHER_ADMIN = 102
  const MEMBER = 103
  const SECOND_MEMBER = 104
  const SITE_ADMIN = 105
  const STRANGER = 106
  const COACH = 107
  const ASSISTANT = 108
  const SCOREKEEPER = 109
  const VIDEOGRAPHER = 110
  const SEASON_COACH = 111
  const AWAY_MEMBER = 112
  const BOTH_TEAMS = 113
  const LEAVER = 114
  let f: GroupFixture
  let upcoming: string
  let keys = 0

  const member = async (user: number, teamId: string): Promise<void> => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: `mem_film_${user}_${teamId}`,
        user_id: userIdOfGumbo(user),
        team_id: teamId
      })
      .execute()
  }
  const role = async (
    user: number,
    role: 'coach' | 'assistant' | 'scorekeeper' | 'videographer',
    scope: { type: 'team' | 'season'; id: string }
  ): Promise<void> => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: `rol_film_${user}_${role}`,
        user_id: userIdOfGumbo(user),
        scope_type: scope.type,
        scope_id: scope.id,
        role
      })
      .execute()
  }
  const game = async (
    id: string,
    startAt: Date,
    teams: { home?: string; away?: string; timezone?: string } = {}
  ): Promise<string> => {
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: teams.home ?? f.teamA,
        away_team_id: teams.away ?? f.teamB,
        start_at: startAt,
        timezone: teams.timezone ?? 'UTC'
      })
      .execute()
    return id
  }
  const send = async (
    user: number | null,
    teamId = f.teamA,
    key = `film-request-${++keys}`
  ): Promise<Response> =>
    await f.h.request(
      'POST',
      '/relationship-requests',
      { kind: 'videographer', teamId, idempotencyKey: key },
      user
    )
  const access = async (
    gameId: string,
    user: number | null
  ): Promise<Response> =>
    await f.h.request('GET', `/games/${gameId}/stream-access`, undefined, user)
  const accessOf = async (
    gameId: string,
    user: number
  ): Promise<{
    canFilm: boolean
    canRequest: boolean
    requested: boolean
    teamId: string
  }> => {
    const response = await access(gameId, user)
    expect(response.status, await response.clone().text()).equals(200)
    return await response.json()
  }
  const inboxOf = async (
    user: number
  ): Promise<
    Array<{
      requestId: string
      type: string
      title: string
      description: string
      canAct: boolean
      canWithdraw: boolean
      canResend: boolean
    }>
  > =>
    (
      await (
        await f.h.request('GET', '/me/notifications', undefined, user)
      ).json()
    ).items
  const decide = async (
    id: string,
    decision: 'accept' | 'decline',
    user: number
  ): Promise<Response> =>
    await f.h.request(
      'POST',
      `/relationship-requests/${id}/${decision}`,
      {},
      user
    )
  const newRequest = async (user: number): Promise<string> => {
    const response = await send(user)
    expect(response.status, await response.clone().text()).equals(201)
    return ((await response.json()) as { id: string }).id
  }

  before(async () => {
    f = await groupFixture()
    for (const [id, name] of [
      [COACH, 'Joe Torre'],
      [ASSISTANT, 'Don Zimmer'],
      [SCOREKEEPER, 'Vin Scully'],
      [VIDEOGRAPHER, 'Bob Uecker'],
      [SEASON_COACH, 'Tommy Lasorda'],
      [AWAY_MEMBER, 'Cal Ripken'],
      [BOTH_TEAMS, 'Ozzie Smith'],
      [LEAVER, 'Curt Flood']
    ] as const) {
      await insertFixtureUsers(f.h.db, {
        id,
        legacyId: `usr_film_${id}`,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ')[1],
        login_enabled: true,
        is_admin: false
      })
      f.h.tokens.set(
        id,
        (await createSession(f.h.db, userIdOfGumbo(id), 'film-fixture')).token
      )
    }
    for (const user of [
      MEMBER,
      SECOND_MEMBER,
      COACH,
      ASSISTANT,
      SCOREKEEPER,
      VIDEOGRAPHER,
      BOTH_TEAMS,
      LEAVER
    ])
      await member(user, f.teamA)
    await member(AWAY_MEMBER, f.teamB)
    await member(BOTH_TEAMS, f.teamB)
    await role(COACH, 'coach', { type: 'team', id: f.teamA })
    await role(ASSISTANT, 'assistant', { type: 'team', id: f.teamA })
    await role(SCOREKEEPER, 'scorekeeper', { type: 'team', id: f.teamA })
    await role(VIDEOGRAPHER, 'videographer', { type: 'team', id: f.teamA })
    await role(SEASON_COACH, 'coach', { type: 'season', id: f.seasonA })
    upcoming = await game(
      'gam_film_upcoming',
      new Date(Date.now() + 7 * 24 * 3600 * 1000)
    )
  })
  after(async () => {
    await f?.h.close()
  })

  it('takes a member through the route, for themselves, and reaches only the people who approve', async () => {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'videographer',
        teamId: f.teamA,
        idempotencyKey: 'film-first',
        // A client cannot name somebody else or approve itself.
        userId: userIdOfGumbo(SECOND_MEMBER),
        confirmBoth: true
      },
      MEMBER
    )
    expect(response.status, await response.clone().text()).equals(201)
    const sent = (await response.json()) as { id: string; status: string }
    expect(sent.status).equals('pending')
    const row = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', sent.id)
      .executeTakeFirstOrThrow()
    expect(row.sender_scope_type).equals(null)
    expect(row.terms).deep.equals({
      kind: 'videographer',
      teamId: f.teamA,
      userId: userIdOfGumbo(MEMBER)
    })

    for (const user of [ADMIN, COACH, ASSISTANT, SEASON_COACH, SITE_ADMIN]) {
      const item = (await inboxOf(user)).find(
        item => item.requestId === sent.id
      )
      expect(item, `user ${user}`).not.equals(undefined)
      expect(item!.canAct, `user ${user}`).equals(true)
      expect(item!.type).equals('videographer')
      expect(item!.title).equals("Mike Trout asks to film Demo Hawks's games")
      expect(item!.description).equals(
        'Approving makes Mike Trout a Videographer of Demo Hawks, for all of its games.'
      )
    }
    for (const user of [
      OTHER_ADMIN,
      SECOND_MEMBER,
      STRANGER,
      SCOREKEEPER,
      VIDEOGRAPHER,
      AWAY_MEMBER
    ])
      expect(
        (await inboxOf(user)).some(item => item.requestId === sent.id),
        `user ${user}`
      ).equals(false)

    // A person's own request is not theirs to approve, or to send again.
    const mine = await (
      await f.h.request('GET', '/me/notifications?sent=1', undefined, MEMBER)
    ).json()
    const own = mine.items.find(
      (item: { requestId: string }) => item.requestId === sent.id
    )
    expect(own.canAct).equals(false)
    expect(own.canWithdraw).equals(true)
    expect(own.canResend).equals(false)
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${sent.id}/resend`,
          { idempotencyKey: 'film-resend' },
          MEMBER
        )
      ).status
    ).equals(409)
    expect(
      (await (await decide(sent.id, 'accept', MEMBER)).json()).status
    ).equals('pending')
    expect((await decide(sent.id, 'accept', SCOREKEEPER)).status).oneOf([
      403, 404
    ])
    expect((await decide(sent.id, 'accept', VIDEOGRAPHER)).status).oneOf([
      403, 404
    ])

    // Asking again answers the one waiting, under a new key or the same.
    const repeat = await send(MEMBER)
    expect(repeat.status).equals(201)
    expect(((await repeat.json()) as { id: string }).id).equals(sent.id)
    expect(
      (
        (await (await send(MEMBER, f.teamA, 'film-first')).json()) as {
          id: string
        }
      ).id
    ).equals(sent.id)
    const waiting = await f.h.db
      .selectFrom('group_requests')
      .select('id')
      .where('kind', '=', 'videographer')
      .where('sender_id', '=', userIdOfGumbo(MEMBER))
      .execute()
    expect(waiting).has.length(1)

    expect(await accessOf(upcoming, MEMBER)).deep.equals({
      canFilm: false,
      canRequest: true,
      requested: true,
      teamId: f.teamA
    })

    const accepted = await decide(sent.id, 'accept', ASSISTANT)
    expect(accepted.status, await accepted.clone().text()).equals(200)
    expect(((await accepted.json()) as { status: string }).status).equals(
      'accepted'
    )
    const roles = await f.h.db
      .selectFrom('scope_roles')
      .select(['role', 'scope_type', 'scope_id', 'granted_by'])
      .where('user_id', '=', userIdOfGumbo(MEMBER))
      .where('scope_id', '=', f.teamA)
      .execute()
    expect(roles).deep.equals([
      {
        role: 'videographer',
        scope_type: 'team',
        scope_id: f.teamA,
        granted_by: userIdOfGumbo(ASSISTANT)
      }
    ])
    // Told as anybody given a role is.
    const told = await (
      await f.h.request('GET', '/me/notifications?history=1', undefined, MEMBER)
    ).json()
    expect(
      told.items.some(
        (item: { type: string; title: string }) =>
          item.type === 'grant' &&
          item.title === 'Don Zimmer added you as Videographer of Demo Hawks'
      )
    ).equals(true)
    expect(await accessOf(upcoming, MEMBER)).deep.equals({
      canFilm: true,
      canRequest: false,
      requested: false,
      teamId: f.teamA
    })
    // Now they film, there is nothing to ask for.
    const again = await send(MEMBER)
    expect(again.status).equals(409)
    expect(await again.text()).includes('already film')
    expect(
      await completionNotice(f.h.db, {
        kind: 'videographer',
        teamId: f.teamA,
        userId: userIdOfGumbo(MEMBER)
      })
    ).equals('Demo Hawks: videographer approved')
  })

  it('refuses a stranger, somebody who can film and a team that is not a full one', async () => {
    expect((await send(null)).status).equals(401)
    expect((await send(STRANGER)).status).equals(403)
    expect((await send(VIDEOGRAPHER)).status).equals(409)
    expect((await send(ADMIN)).status).equals(409)
    expect((await send(SITE_ADMIN)).status).equals(409)
    expect((await send(SECOND_MEMBER, 'tem_missing')).status).equals(404)
    await f.h.db
      .updateTable('teams')
      .set({
        kind: 'external',
        custodian_type: 'team',
        custodian_id: f.teamA
      })
      .where('id', '=', f.standaloneTeam)
      .execute()
    await member(SECOND_MEMBER, f.standaloneTeam)
    expect((await send(SECOND_MEMBER, f.standaloneTeam)).status).equals(404)
    const placeholder = await game(
      'gam_film_placeholder',
      new Date(Date.now() + 24 * 3600 * 1000),
      { home: f.standaloneTeam }
    )
    expect(await accessOf(placeholder, SECOND_MEMBER)).deep.equals({
      canFilm: false,
      canRequest: false,
      requested: false,
      teamId: f.standaloneTeam
    })
  })

  it('leaves no role when declined, and a declined member may ask again', async () => {
    const id = await newRequest(SECOND_MEMBER)
    const declined = await decide(id, 'decline', COACH)
    expect(((await declined.json()) as { status: string }).status).equals(
      'declined'
    )
    expect((await accessOf(upcoming, SECOND_MEMBER)).canFilm).equals(false)
    expect((await accessOf(upcoming, SECOND_MEMBER)).requested).equals(false)
    expect(await newRequest(SECOND_MEMBER)).not.equals(id)
  })

  it('stops asking once a request has run out', async () => {
    await f.h.db
      .updateTable('group_requests')
      .set({
        sent_at: new Date(Date.now() - 8 * 24 * 3600 * 1000),
        expires_at: new Date(Date.now() - 1000)
      })
      .where('kind', '=', 'videographer')
      .where('sender_id', '=', userIdOfGumbo(SECOND_MEMBER))
      .where('status', '=', 'pending')
      .execute()
    expect((await accessOf(upcoming, SECOND_MEMBER)).requested).equals(false)
  })

  it('refuses an approval once the requester has left the team', async () => {
    const id = await newRequest(LEAVER)
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(LEAVER))
      .where('team_id', '=', f.teamA)
      .execute()
    const late = await decide(id, 'accept', COACH)
    expect(late.status).equals(409)
    const held = await f.h.db
      .selectFrom('scope_roles')
      .select('role')
      .where('user_id', '=', userIdOfGumbo(LEAVER))
      .execute()
    expect(held).deep.equals([])
    expect(
      await f.h.db
        .selectFrom('memberships')
        .select('id')
        .where('user_id', '=', userIdOfGumbo(LEAVER))
        .execute()
    ).deep.equals([])
    // It stays with the approvers, who can turn it down.
    expect((await decide(id, 'decline', COACH)).status).equals(200)
  })

  it('answers stream access for each role', async () => {
    const asked = { canRequest: false, requested: false }
    expect((await access(upcoming, null)).status).equals(401)
    expect(await accessOf(upcoming, VIDEOGRAPHER)).deep.equals({
      canFilm: true,
      ...asked,
      teamId: f.teamA
    })
    expect(await accessOf(upcoming, ADMIN)).deep.equals({
      canFilm: true,
      ...asked,
      teamId: f.teamA
    })
    expect(await accessOf(upcoming, SITE_ADMIN)).deep.equals({
      canFilm: true,
      ...asked,
      teamId: f.teamB
    })
    // The videographer of the other team films this game too.
    expect(await accessOf(upcoming, OTHER_ADMIN)).deep.equals({
      canFilm: true,
      ...asked,
      teamId: f.teamB
    })
    expect(await accessOf(upcoming, SCOREKEEPER)).deep.equals({
      canFilm: false,
      canRequest: true,
      requested: false,
      teamId: f.teamA
    })
    expect(await accessOf(upcoming, AWAY_MEMBER)).deep.equals({
      canFilm: false,
      canRequest: true,
      requested: false,
      teamId: f.teamB
    })
    // A member of both asks the home team.
    expect(await accessOf(upcoming, BOTH_TEAMS)).deep.equals({
      canFilm: false,
      canRequest: true,
      requested: false,
      teamId: f.teamA
    })
  })

  it('answers 404 for a game the caller cannot see, and one that does not exist', async () => {
    expect((await access(upcoming, STRANGER)).status).equals(404)
    expect((await access('gam_film_missing', MEMBER)).status).equals(404)
  })

  it("offers a request up to the end of the game day, in the game's own time", async () => {
    const timezone = 'Pacific/Kiritimati'
    const today = gameCalendarDay(new Date().toISOString(), timezone)
    const yesterday = addDays(today, -1)
    const earlier = await game(
      'gam_film_earlier_today',
      new Date(gameTime(today, '00:01', timezone)),
      { timezone }
    )
    const past = await game(
      'gam_film_yesterday',
      new Date(gameTime(yesterday, '23:59', timezone)),
      { timezone }
    )
    expect((await accessOf(earlier, AWAY_MEMBER)).canRequest).equals(true)
    expect(await accessOf(past, AWAY_MEMBER)).deep.equals({
      canFilm: false,
      canRequest: false,
      requested: false,
      teamId: f.teamB
    })
  })
})
