import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { AccountSettings } from '../../common/accountSettings'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import type {
  DirectoryPerson,
  PersonAdministration
} from '../../common/userManagement'
import { accountTestPicture } from '../../test/accountHarness'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { USER_API_KEY_PREFIX } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'

const NODE = 105
const RAINES = 106
const raines = userIdOfGumbo(RAINES)
const BULK = [
  'Hank Aaron',
  'Willie Mays',
  'Ted Williams',
  'Stan Musial',
  'Cy Young',
  'Honus Wagner',
  'Walter Johnson',
  'Christy Mathewson',
  'Ty Cobb',
  'Mickey Mantle',
  'Yogi Berra',
  'Ernie Banks'
]

/** An API key of the node administrator's, which reads no person's activity. */
async function adminKey(f: GroupFixture): Promise<string> {
  const key = USER_API_KEY_PREFIX + makeToken()
  await f.h.db
    .insertInto('user_api_keys')
    .values({
      id: makeId('userApiKey'),
      user_id: userIdOfGumbo(105),
      name: 'export',
      token_hash: hashToken(key),
      secret_sealed: 'sealed',
      permissions: ['team:read'],
      created_at: new Date()
    })
    .execute()
  return key
}

describe('node administration: the people directory', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    const db = f.h.db
    const now = new Date()
    await insertFixtureUsers(db, [
      {
        id: 107,
        legacyId: 'usr_directory_107',
        display_name: 'Tim Raines Jr',
        login_enabled: true,
        email: 'raines.junior@example.com',
        emailId: 'email_directory_107'
      },
      {
        id: 108,
        legacyId: 'usr_directory_108',
        display_name: 'Manny Ramirez',
        login_enabled: true,
        email: 'fixture108@example.com',
        emailId: 'email_directory_108'
      },
      {
        id: 109,
        legacyId: 'usr_directory_109',
        display_name: 'Randy Johnson',
        login_enabled: true,
        email: 'fixture109@example.com',
        emailId: 'email_directory_109'
      },
      {
        id: 110,
        legacyId: 'usr_directory_110',
        display_name: 'Roberto Clemente',
        login_enabled: false,
        email: 'clemente@example.com',
        emailId: 'email_directory_110'
      },
      ...BULK.map((name, i) => ({
        id: 120 + i,
        legacyId: `usr_directory_${120 + i}`,
        display_name: name,
        login_enabled: true,
        email: `player${i}@bulk.example.com`,
        emailId: `email_directory_${120 + i}`
      }))
    ])
    // A second, unverified address of Raines's, which the search still finds.
    await db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: raines,
        email: 'raines.second@example.com',
        is_primary: false,
        verified_at: null,
        created_at: now
      })
      .execute()
    // Raines Jr was merged into Raines: what he held is Raines's now.
    await db
      .updateTable('users')
      .set({ merged_into: raines })
      .where('id', '=', userIdOfGumbo(107))
      .execute()
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: raines,
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'coach',
          is_head_coach: true,
          granted_by: null,
          granted_at: now
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(107),
          scope_type: 'season',
          scope_id: f.standaloneSeason,
          role: 'admin',
          granted_by: null,
          granted_at: now
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: raines,
        team_id: f.teamA,
        role: 'member',
        is_player: true,
        jersey: null,
        joined_at: now,
        granted_by_link_id: null
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: raines,
        season_id: f.seasonA,
        joined_at: now
      })
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: raines,
        league_id: f.leagueA,
        joined_at: now
      })
      .execute()
    await db
      .insertInto('follows')
      .values({ user_id: raines, group_type: 'league', group_id: f.leagueB })
      .execute()
    await db
      .insertInto('team_follows')
      .values({ user_id: raines, team_id: f.teamB })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  const search = async (
    query: string,
    user: number | string | null = NODE
  ): Promise<{ status: number; body: DirectoryPerson[] }> => {
    const response = await f.h.request(
      'GET',
      `/users?view=directory&${query}`,
      undefined,
      user
    )
    return {
      status: response.status,
      body: (await response.json()) as DirectoryPerson[]
    }
  }

  it('finds people by name or any address, starts first, ten at most', async () => {
    const second = await search('q=raines.sec')
    expect(second.status).equals(200)
    expect(second.body).to.have.length(1)
    expect(second.body[0]).to.include({
      userId: raines,
      displayName: 'Tim Raines',
      email: 'raines.second@example.com'
    })
    expect(second.body[0].affiliations).to.be.a('string')
    // A name that starts with it, or an address that does, comes first.
    expect((await search('q=ra')).body.map(row => row.displayName)).deep.equals(
      ['Randy Johnson', 'Tim Raines', 'Manny Ramirez', 'Yogi Berra']
    )
    expect((await search('q=bulk.example')).body).to.have.length(10)
    expect((await search('q=bulk.example&limit=3')).body).to.have.length(3)
    // Merged and switched-off accounts are not offered.
    expect((await search('q=Raines')).body.map(row => row.userId)).deep.equals([
      raines
    ])
    expect((await search('q=clemente')).body).deep.equals([])
    expect((await search('q=%25')).body).deep.equals([])
    expect((await search('q=_')).body).deep.equals([])
    expect((await search('q=')).body).deep.equals([])
  })

  it('names the groups of staff that Add Person’s line says nothing of', async () => {
    const johnson = userIdOfGumbo(109)
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: johnson,
        scope_type: 'team',
        scope_id: f.teamB,
        role: 'videographer',
        granted_by: null,
        granted_at: new Date()
      })
      .execute()
    await f.h.db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: johnson,
        league_id: f.leagueB,
        joined_at: new Date()
      })
      .execute()
    const found = (await search('q=Randy')).body
    expect(found.map(row => [row.userId, row.affiliations])).deep.equals([
      [johnson, 'Demo Eagles · Demo League B']
    ])
    // Somebody tied to nothing has an empty line.
    expect((await search('q=Manny')).body[0].affiliations).equals('')
  })

  it('refuses anybody but a node administrator, and a query it does not take', async () => {
    expect((await search('q=ra', 101)).status).equals(403)
    expect((await search('q=ra', null)).status).equals(401)
    const key = await adminKey(f)
    expect((await search('q=ra', key)).status).equals(403)
    expect(
      (
        await f.h.request(
          'GET',
          `/users/${raines}/administration`,
          undefined,
          key
        )
      ).status
    ).equals(403)
    for (const query of [
      'q=ra&limit=11',
      'q=ra&limit=0',
      'q=ra&q=rb',
      `q=${'x'.repeat(121)}`,
      'q=ra&nodeAdmin=true'
    ])
      expect((await search(query)).status).equals(400)
  })

  it('opens a person with every address and every affiliation and role', async () => {
    const response = await f.h.request(
      'GET',
      `/users/${raines}/administration`,
      undefined,
      NODE
    )
    expect(response.status).equals(200)
    const person = (await response.json()) as PersonAdministration
    expect(person.displayName).equals('Tim Raines')
    expect(person.emails.map(row => row.email).sort()).deep.equals([
      'fixture106@example.com',
      'raines.junior@example.com',
      'raines.second@example.com'
    ])
    expect(person.lastActiveAt).equals(null)
    expect(
      person.affiliations.map(row => [row.kind, row.name, row.roles])
    ).deep.equals([
      ['team', 'Demo Eagles', ['following']],
      ['team', 'Demo Hawks', ['head coach', 'coach', 'player', 'member']],
      ['season', 'Demo Regular', ['member']],
      ['season', 'Demo Standalone', ['admin']],
      ['league', 'Demo League A', ['member']],
      ['league', 'Demo League B', ['following']]
    ])
    expect(person.affiliations[1].id).equals(f.teamA)
    for (const [userId, user, status] of [
      [userIdOfGumbo(107), NODE, 404],
      [userIdOfGumbo(999), NODE, 404],
      [raines, 101, 403]
    ] as const)
      expect(
        (
          await f.h.request(
            'GET',
            `/users/${userId}/administration`,
            undefined,
            user
          )
        ).status
      ).equals(status)
  })

  it('lets a node administrator change a person’s name and photo, and nothing of their password', async () => {
    const read = await f.h.request(
      'GET',
      `/users/${raines}/account`,
      undefined,
      NODE
    )
    expect(read.status).equals(200)
    const account = (await read.json()) as AccountSettings
    expect(account.user.id).equals(raines)
    expect(account.hasPassword).equals(false)
    expect(account.passwordParameters).equals(null)
    expect(account).not.to.have.property('newPasswordSalt')

    const renamed = await f.h.request(
      'PUT',
      `/users/${raines}/account/name`,
      { displayName: 'Timothy Raines' },
      NODE
    )
    expect(renamed.status).equals(200)
    expect(((await renamed.json()) as AccountSettings).user.displayName).equals(
      'Timothy Raines'
    )
    // The audit row is written once the answer has gone.
    let audit: { actor_user_id: string | null } | undefined
    for (let i = 0; i < 100 && audit == null; i++) {
      audit = await f.h.db
        .selectFrom('audit_log')
        .select('actor_user_id')
        .where('entity_id', '=', raines)
        .where('method', '=', 'PUT')
        .executeTakeFirst()
      if (audit == null) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(audit?.actor_user_id).equals(userIdOfGumbo(NODE))

    const pictured = await f.h.request(
      'PUT',
      `/users/${raines}/account/photo`,
      { image: accountTestPicture },
      NODE
    )
    expect(pictured.status).equals(200)
    expect(((await pictured.json()) as AccountSettings).user.avatarUrl).to.be.a(
      'string'
    )
    // A phone's photo is more than the 1 MB an ordinary body may be.
    const large = await f.h.request(
      'PUT',
      `/users/${raines}/account/photo`,
      {
        image: {
          contentType: 'image/png',
          base64: Buffer.alloc(1_200_000).toString('base64')
        }
      },
      NODE
    )
    expect(large.status).not.equals(413)
    const cleared = await f.h.request(
      'DELETE',
      `/users/${raines}/account/photo`,
      undefined,
      NODE
    )
    expect(((await cleared.json()) as AccountSettings).user.avatarUrl).equals(
      null
    )
    expect(
      (
        await f.h.request(
          'PUT',
          `/users/${raines}/account/catalog-picture`,
          { catalogId: 'not-a-picture' },
          NODE
        )
      ).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'PUT',
          `/users/${raines}/account/catalog-picture`,
          { catalogId: 'baseball' },
          NODE
        )
      ).status
    ).equals(200)
    const chosen = await f.h.db
      .selectFrom('users')
      .select('picture_catalog_id')
      .where('id', '=', raines)
      .executeTakeFirstOrThrow()
    expect(chosen.picture_catalog_id).equals('baseball')
  })

  it('refuses another account to anybody but a node administrator signed in themselves', async () => {
    const machine = makeToken()
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(NODE),
        label: 'machine',
        token_hash: hashToken(machine),
        created_at: new Date()
      })
      .execute()
    const routes: Array<[string, string, unknown]> = [
      ['GET', `/users/${raines}/account`, undefined],
      ['PUT', `/users/${raines}/account/name`, { displayName: 'Nobody' }],
      ['PUT', `/users/${raines}/account/photo`, { image: accountTestPicture }],
      ['DELETE', `/users/${raines}/account/photo`, undefined],
      ['PUT', `/users/${raines}/account/catalog-picture`, { catalogId: 'x' }]
    ]
    for (const [method, path, body] of routes) {
      expect((await f.h.request(method, path, body, 101)).status).equals(403)
      expect((await f.h.request(method, path, body, machine)).status).equals(
        403
      )
      expect(
        (
          await f.h.request(
            method,
            path.replace(raines, userIdOfGumbo(107)),
            body,
            NODE
          )
        ).status
      ).equals(404)
    }
    const kept = await f.h.db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', raines)
      .executeTakeFirstOrThrow()
    expect(kept.display_name).equals('Tim Raines')
  })
})
