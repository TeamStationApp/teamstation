import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { asParentPreview } from '../../common/groupLinks'
import { asGroupDetail } from '../../common/publicGroups'
import { accountTestPicture } from '../../test/accountHarness'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'

describe('group and inbox client contracts over real HTTP', function () {
  this.timeout(60000)
  let f: GroupFixture
  let client: TeamStationClient
  before(async () => {
    f = await groupFixture()
    client = new TeamStationClient({
      baseUrl: `${f.h.origin}/api/v1`,
      token: f.h.tokens.get(101)
    })
  })
  after(async () => {
    await f?.h.close()
  })
  it('cleans discovery, owned groups and minimal public profiles without granting access', async () => {
    for (const kind of ['league', 'season', 'team'] as const)
      expect((await client.discoverGroups(kind, 'Demo')).length).greaterThan(0)
    const own = await client.ownGroups()
    expect(own.some(group => group.id === f.seasonA)).equals(true)
    expect(own.some(group => group.id === f.teamB)).equals(false)
    await client.group({ kind: 'league', id: f.leagueA })
    await client.group({ kind: 'season', id: f.seasonA })
    const detail = await client.group({ kind: 'team', id: f.teamA })
    expect(detail.canManage).equals(true)
    expect(asGroupDetail(detail)).deep.equals(detail)
    expect(
      (await f.h.request('GET', '/leagues?query=Demo', undefined, 101)).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/leagues?view=wrong', undefined, null)).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'GET',
          '/teams?view=public&query=a&query=b',
          undefined,
          null
        )
      ).status
    ).equals(400)
  })
  it('uploads group pictures, reuses catalog objects and keeps independent settings and retry identity', async () => {
    for (const kind of ['league', 'season', 'team'] as const) {
      const group = await client.createGroup({
        kind,
        name: `Demo Picture ${kind}`,
        locality: demoLocality,
        startsOn: '2027-06-01',
        endsOn: '2027-08-31',
        timezone: 'UTC',
        picture: { image: accountTestPicture },
        idempotencyKey: `upload-${kind}-one`
      })
      expect(group.imageUrl).not.equals(null)
      const ref = { kind, id: group.id }
      const before = f.h.objects.size
      const catalog = await client.updateGroup(ref, {
        picture: { catalogId: 'baseball' },
        name: `Demo Renamed ${kind}`
      })
      expect(catalog.name).equals(`Demo Renamed ${kind}`)
      expect(catalog.imageUrl).includes('/images/catalog/')
      expect(f.h.objects.size).equals(before)
      await client.updateGroup(ref, { picture: { image: accountTestPicture } })
      if (kind !== 'season') {
        const changed = { ...demoLocality, city: 'Own Different City' }
        expect(
          (await client.updateGroup(ref, { locality: changed })).locality
        ).deep.equals(changed)
      } else {
        const changed = await client.updateGroup(ref, {
          startsOn: '2027-12-01',
          endsOn: '2028-02-29',
          timezone: 'America/Los_Angeles'
        })
        expect(changed.startsOn).equals('2027-12-01')
        expect(changed.endsOn).equals('2028-02-29')
      }
      expect(
        (
          await f.h.request(
            'PUT',
            `/groups/${kind}/${group.id}`,
            { picture: { initials: true } },
            101
          )
        ).status
      ).equals(200)
    }
    const saved = await client.createGroup({
      kind: 'team',
      name: 'Demo Catalog',
      locality: demoLocality,
      picture: { catalogId: 'basketball' },
      idempotencyKey: 'catalog-team-once'
    })
    expect(saved.imageUrl).includes('/images/catalog/')
    for (const kind of ['team', 'league', 'season']) {
      f.h.controls.failPut = true
      const failed = await f.h.request(
        'POST',
        `/${kind === 'team' ? 'teams' : kind === 'league' ? 'leagues' : 'seasons'}`,
        {
          name: 'Failed picture',
          locality: demoLocality,
          startsOn: '2027-06-01',
          endsOn: '2027-08-31',
          timezone: 'UTC',
          picture: { image: accountTestPicture },
          idempotencyKey: `failed-group-photo-${kind}`
        }
      )
      f.h.controls.failPut = false
      expect(failed.status).equals(503)
    }
    const unreadable = await f.h.request('POST', '/leagues', {
      name: 'Unreadable picture',
      locality: demoLocality,
      idempotencyKey: 'unreadable-league-picture',
      picture: {
        image: {
          contentType: 'image/png',
          base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            'base64'
          )
        }
      }
    })
    expect(unreadable.status).equals(415)
    expect(
      await f.h.db
        .selectFrom('teams')
        .select('id')
        .where('name', '=', 'Failed picture')
        .execute()
    ).length(0)
  })
  it('reviews parents, records either-side unlink information and keeps viewing separate from decision', async () => {
    const preview = await client.parentPreview([
      {
        operation: 'detach',
        child: { kind: 'team', id: f.teamA },
        parent: { kind: 'season', id: f.seasonA }
      }
    ])
    expect(asParentPreview(preview)).deep.equals(preview)
    await client.changeParents(preview)
    const history = await client.notifications({ history: true })
    const update = history.items.find(row => row.type === 'parentUnlink')!
    expect(update.canAct).equals(false)
    expect((await client.notification(update.requestId)).title).equals(
      'Parent relationships updated'
    )
    await client.viewNotification(update.requestId)
    expect((await client.notification(update.requestId)).viewed).equals(true)
    expect(await client.hasNotifications()).equals(false)
    expect(
      (
        await f.h.request(
          'GET',
          `/me/notifications/${update.requestId}`,
          undefined,
          106
        )
      ).status
    ).equals(404)
  })
  it('keeps shared approvals current, retries idempotently, and removes only competition membership', async () => {
    const sent = await client.inviteRelationship({
      kind: 'participation',
      teamId: f.teamA,
      seasonId: f.seasonB,
      sender: { kind: 'team', id: f.teamA },
      idempotencyKey: 'sdk-competition'
    })
    const host = new TeamStationClient({
      baseUrl: client.baseUrl,
      token: f.h.tokens.get(102)
    })
    const page = await host.notifications({ limit: 1 })
    expect(page.hasPending).equals(true)
    await host.viewNotification(sent.id)
    expect(await host.hasNotifications()).equals(true)
    expect((await host.decideRelationship(sent.id, 'accept')).status).equals(
      'accepted'
    )
    const beforeParents = (await client.group({ kind: 'team', id: f.teamA }))
      .parents
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_participation_contract',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date('2027-04-10T19:00:00Z'),
        status: 'scheduled'
      })
      .execute()
    await client.endParticipation(f.seasonB, f.teamA)
    expect(
      (await client.group({ kind: 'team', id: f.teamA })).parents
    ).deep.equals(beforeParents)
    expect(
      await f.h.db
        .selectFrom('games')
        .select(['home_team_id', 'season_id', 'status'])
        .where('id', '=', 'gam_participation_contract')
        .executeTakeFirstOrThrow()
    ).deep.equals({
      home_team_id: f.teamA,
      season_id: f.seasonB,
      status: 'scheduled'
    })
    expect(
      (
        await f.h.db
          .selectFrom('season_teams')
          .select('active')
          .where('season_id', '=', f.seasonB)
          .where('team_id', '=', f.teamA)
          .executeTakeFirstOrThrow()
      ).active
    ).equals(false)
    const again = await client.inviteRelationship({
      kind: 'participation',
      teamId: f.teamA,
      seasonId: f.seasonB,
      sender: { kind: 'team', id: f.teamA },
      idempotencyKey: 'sdk-competition'
    })
    expect(again.id).equals(sent.id)
    expect(again.status).equals('accepted')
    const pending = await client.inviteRelationship({
      kind: 'participation',
      teamId: f.teamA,
      seasonId: f.seasonB,
      sender: { kind: 'team', id: f.teamA },
      idempotencyKey: 'sdk-resend-first'
    })
    const fresh = await client.decideRelationship(
      pending.id,
      'resend',
      'sdk-resend-next'
    )
    expect(
      await client.decideRelationship(pending.id, 'resend', 'sdk-resend-next')
    ).deep.equals(fresh)
    expect((await host.decideRelationship(pending.id, 'accept')).status).equals(
      'cancelled'
    )
    await client.decideRelationship(fresh.id, 'withdraw')
    expect((await host.decideRelationship(fresh.id, 'decline')).status).equals(
      'cancelled'
    )
  })
  it('exposes preflight only to node admins and blocks new management until explicit replacements and custody are ready', async () => {
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await f.h.db
      .insertInto('teams')
      .values([
        { id: 'legacyNoAdmin', name: 'Legacy Full' },
        { id: 'legacyNoCustodian', name: 'Legacy Opponent', kind: 'external' }
      ])
      .execute()
    expect(
      (await f.h.request('GET', '/node/ownership-preflight', undefined, 101))
        .status
    ).equals(403)
    expect(
      (await f.h.request('GET', '/node/ownership-preflight', undefined, 105))
        .status
    ).equals(200)
    expect(
      (
        await f.h.request('POST', '/teams', {
          name: 'Blocked',
          locality: demoLocality,
          idempotencyKey: 'blocked-cutover'
        })
      ).status
    ).equals(503)
    const unresolved = await f.h.request(
      'POST',
      '/node/ownership-preflight',
      { choices: [] },
      105
    )
    expect(unresolved.status).equals(409)
    const resolved = await f.h.request(
      'POST',
      '/node/ownership-preflight',
      {
        choices: [],
        administrators: [
          { group: { kind: 'team', id: 'legacyNoAdmin' }, userId: 103 }
        ],
        custodians: [
          {
            teamId: 'legacyNoCustodian',
            custodian: { kind: 'season', id: f.seasonB }
          }
        ]
      },
      105
    )
    expect(resolved.status, await resolved.clone().text()).equals(200)
    expect(await resolved.json()).property('ready', true)
    expect(
      (
        await f.h.request('POST', '/teams', {
          name: 'Ready',
          locality: demoLocality,
          idempotencyKey: 'ready-cutover'
        })
      ).status
    ).equals(201)
  })
})

describe('the non-member view through the client', function () {
  this.timeout(60000)
  let f: GuardianFixture
  let follower: TeamStationClient
  let member: TeamStationClient
  before(async () => {
    f = await guardianFixture()
    const client = (userId: number): TeamStationClient =>
      new TeamStationClient({
        baseUrl: `${f.h.origin}/api/v1`,
        token: f.h.tokens.get(userId)
      })
    follower = client(f.people.follower)
    member = client(f.people.teamCoach)
  })
  after(async () => {
    await f?.h.close()
  })

  /** The code a refused read is thrown with, or `answered`. */
  const refusal = async (read: () => Promise<unknown>): Promise<string> => {
    try {
      await read()
      return 'answered'
    } catch (error) {
      if (error instanceof HttpError) return error.code
      throw error
    }
  }

  it('cleans the non-member view of a team and a game, and branches on membersOnly', async () => {
    const [game] = f.games
    const team = await follower.group({ kind: 'team', id: f.teamA })
    expect(team.nonMemberView).equals(true)
    expect(asGroupDetail(team)).deep.equals(team)
    expect(
      (await follower.roster(f.teamA)).every(row => row.avatarUrl === null)
    ).equals(true)
    expect((await follower.teamGames(f.teamA)).length).equals(2)
    const detail = await follower.game(game.id)
    expect(detail.nonMemberView).equals(true)
    expect(detail.canScore).equals(false)
    expect(
      (await follower.highlights(game.videoId)).highlights.length
    ).greaterThan(0)

    expect(await refusal(async () => await follower.teamStats(f.teamA))).equals(
      'membersOnly'
    )
    expect(await refusal(async () => await follower.boxScore(game.id))).equals(
      'membersOnly'
    )
    expect(
      await refusal(async () => await follower.playback(game.videoId))
    ).equals('membersOnly')

    expect(
      (await member.group({ kind: 'team', id: f.teamA })).nonMemberView
    ).equals(false)
    expect((await member.game(game.id)).nonMemberView).equals(false)
    expect(await refusal(async () => await member.boxScore(game.id))).equals(
      'answered'
    )
  })
})
