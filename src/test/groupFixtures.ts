import { expect } from 'chai'

import { userIdOfGumbo } from '../common/userId'
import type { Actor } from '../server/auth/sessions'
import { createSession } from '../server/auth/sessions'
import type { Clock } from '../server/groups/requests'
import type { GooglePlaces } from '../server/location/googlePlaces'
import type { eventInfoRoutes } from '../server/routes/eventInfo'
import type { AccountHarness, MountExtra } from './accountHarness'
import { creationHarness } from './creationHarness'
import { insertFixtureUsers } from './insertFixtureUsers'

export const demoLocality = {
  city: 'Demo City',
  region: 'Demo Region',
  country: 'US',
  placeId: null,
  timezone: 'UTC'
}
export const actor = (userId: number): Actor => ({
  userId: userIdOfGumbo(userId),
  isAdmin: false,
  scopes: []
})

export interface GroupFixture {
  h: AccountHarness
  clock: Clock
  advance: (milliseconds: number) => void
  leagueA: string
  leagueB: string
  seasonA: string
  playoffs: string
  seasonB: string
  teamA: string
  teamB: string
  standaloneSeason: string
  standaloneTeam: string
}

export async function groupFixture(
  webRoot?: string,
  bindHost?: string,
  mountExtra?: MountExtra,
  cityLookup?: GooglePlaces,
  eventOptions: Parameters<typeof eventInfoRoutes>[2] = {},
  venueOptions: Parameters<typeof creationHarness>[6] = {}
): Promise<GroupFixture> {
  // Public readers and sign-in use the real clock. Start the controllable
  // fixture clock alongside it so newly created requests are not already expired.
  let timestamp = Date.now()
  let key = 0
  const clock = { now: () => new Date(timestamp) }
  const h = await creationHarness(
    webRoot,
    clock,
    bindHost,
    mountExtra,
    cityLookup,
    eventOptions,
    venueOptions
  )
  try {
    await h.db
      .updateTable('memberships')
      .set({ role: 'manager' })
      .where('team_id', '=', 'tem_account')
      .execute()
    for (const [id, name] of [
      [103, 'Mike Trout'],
      [104, 'Ichiro'],
      [105, 'José Alvarez'],
      [106, 'Tim Raines']
    ] as const) {
      await insertFixtureUsers(h.db, {
        id,
        legacyId: `usr_creation_${id}`,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' '),
        login_enabled: true,
        is_admin: id === 105
      })
      h.tokens.set(
        id,
        (await createSession(h.db, userIdOfGumbo(id), 'creation-fixture')).token
      )
      await h.db
        .insertInto('user_emails')
        .values({
          id: `email_creation_${id}`,
          user_id: userIdOfGumbo(id),
          email: `fixture${id}@example.com`,
          is_primary: true,
          verified_at: new Date(),
          source: 'manual'
        })
        .execute()
    }
    const create = async (
      kind: 'league' | 'season' | 'team',
      name: string,
      userId: number,
      parent?: { kind: 'league' | 'season'; id: string }
    ): Promise<string> => {
      const result = await h.request(
        'POST',
        `/${kind === 'league' ? 'leagues' : kind === 'season' ? 'seasons' : 'teams'}`,
        {
          name,
          idempotencyKey: `fixture-${++key}`,
          locality: demoLocality,
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          timezone: 'UTC',
          parent
        },
        userId
      )
      expect(result.status).equals(201)
      return ((await result.json()) as { id: string }).id
    }
    const leagueA = await create('league', 'Demo League A', 101)
    const leagueB = await create('league', 'Demo League B', 102)
    const seasonA = await create('season', 'Demo Regular', 101, {
      kind: 'league',
      id: leagueA
    })
    const playoffs = await create('season', 'Demo Playoffs', 101, {
      kind: 'league',
      id: leagueA
    })
    const seasonB = await create('season', 'Demo Tournament', 102, {
      kind: 'league',
      id: leagueB
    })
    const teamA = await create('team', 'Demo Hawks', 101, {
      kind: 'season',
      id: seasonA
    })
    const teamB = await create('team', 'Demo Eagles', 102, {
      kind: 'season',
      id: seasonB
    })
    const standaloneSeason = await create('season', 'Demo Standalone', 103)
    const standaloneTeam = await create('team', 'Demo Visitors', 103)
    return {
      h,
      clock,
      advance: ms => {
        timestamp += ms
      },
      leagueA,
      leagueB,
      seasonA,
      playoffs,
      seasonB,
      teamA,
      teamB,
      standaloneSeason,
      standaloneTeam
    }
  } catch (error) {
    await h.close()
    throw error
  }
}
