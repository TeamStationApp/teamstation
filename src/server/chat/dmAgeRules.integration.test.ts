import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
import {
  type Answer,
  type ChatFixture,
  openChatFixture
} from './chatTestFixture'
import { DmFacts } from './dms'

/**
 * The DM rules by age (#351), through `POST /chat/dms` on the chat seed:
 * every rule protects people aged 13 to 17, whether or not they play, and
 * nobody else. P (15) and E (16) play for Hawks and Eagles in one season;
 * M (14) plays nowhere; L, the league admin, is an adult who plays on Hawks.
 */
describe('DM rules by age (#351)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>

  before(async function () {
    const opened = await openChatFixture('dm_age_rules', {
      leagueName: 'Harbor League'
    })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
  })

  after(async function () {
    await fixture?.close()
  })

  const dm = async (who: string, others: string[]): Promise<Answer> =>
    await fixture.call(who, 'POST', '/chat/dms', {
      userIds: others.map(key => fixture.id(key))
    })
  const allowed = async (who: string, others: string[]): Promise<void> => {
    const answer = await dm(who, others)
    expect(
      [200, 201],
      `${who} → ${others.join(', ')}: ${JSON.stringify(answer.body)}`
    ).includes(answer.status)
  }
  const refusedAs = async (
    who: string,
    others: string[],
    reason: 'notCandidate' | 'adultRequired'
  ): Promise<void> => {
    const answer = await dm(who, others)
    expect(
      answer.status,
      `${who} → ${others.join(', ')}: ${JSON.stringify(answer.body)}`
    ).equals(reason === 'adultRequired' ? 409 : 403)
    expect(answer.body.details.reason).equals(reason)
  }
  const candidates = async (who: string): Promise<string[]> => {
    const answer = await fixture.call(who, 'GET', '/chat/dm-candidates')
    expect(answer.status).equals(200)
    return (answer.body as Array<{ userId: string }>).map(row =>
      fixture.keyOf(row.userId)
    )
  }
  /** Year and month `years` and a month before the fixture's day. */
  const born = (years: number): { year: number; month: number } => {
    const total =
      fixture.now.getUTCFullYear() * 12 +
      fixture.now.getUTCMonth() -
      years * 12 -
      1
    return { year: Math.floor(total / 12), month: (total % 12) + 1 }
  }
  const player = async (
    key: string,
    teamId: string,
    birth?: { year: number; month: number }
  ): Promise<string> => {
    const userId = await fixture.person(key, { birth })
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member',
        is_player: true
      })
      .execute()
    await fixture.drain()
    return userId
  }
  const link = async (
    adultKey: string,
    childKey: string,
    kind: 'guardian' | 'family'
  ): Promise<void> => {
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: fixture.id(adultKey),
        related_user_id: fixture.id(childKey),
        kind,
        can_manage: kind === 'guardian'
      })
      .execute()
    await fixture.drain()
  }
  const setLao = async (on: boolean): Promise<void> => {
    await db
      .updateTable('leagues')
      .set({ safesport_lao: on })
      .where('id', '=', fixture.seed.leagueId)
      .execute()
    await fixture.drain()
  }

  it('lets an adult who plays message a staff colleague they share a staff chat with (the reported case)', async function () {
    expect(await candidates('L')).includes('Ea')
    await allowed('L', ['Ea'])
    await allowed('Ea', ['L'])
  })

  it('keeps a minor to their coaches and admins, not their team’s scorekeeper', async function () {
    await allowed('Hc', ['P'])
    await allowed('Ha', ['P'])
    await refusedAs('Hk', ['P'], 'notCandidate')
    await refusedAs('P', ['Hk'], 'notCandidate')
  })

  it('takes a minor on another team of the same season, never one of another season', async function () {
    await allowed('E', ['P'])
    const season = makeId('season')
    const team = makeId('team')
    await db
      .insertInto('seasons')
      .values({
        id: season,
        name: 'Fall 2027',
        year: 2027,
        starts_on: '2027-09-01',
        ends_on: '2027-11-30',
        league_id: fixture.seed.leagueId
      })
      .execute()
    await db
      .insertInto('teams')
      .values({ id: team, name: 'Ravens', kind: 'full' })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: season, team_id: team })
      .execute()
    await player('Raven', team, born(15))
    await refusedAs('Raven', ['P'], 'notCandidate')
    await refusedAs('P', ['Raven'], 'notCandidate')
  })

  it('takes an adult season-mate no more than 4 years older, not one older, nor an adult with no birth month', async function () {
    await player('Near', fixture.seed.teams.eagles, born(18))
    await player('Far', fixture.seed.teams.eagles, born(20))
    await allowed('Near', ['P'])
    await refusedAs('Far', ['P'], 'notCandidate')
    // L plays on P's own team but gave no birth month.
    await refusedAs('L', ['P'], 'notCandidate')
  })

  it('keeps an unrelated parent from a minor, both ways', async function () {
    await refusedAs('A', ['P'], 'notCandidate')
    await refusedAs('P', ['A'], 'notCandidate')
    expect(await candidates('A')).not.includes('P')
  })

  it('leaves a minor who plays nowhere and has no guardian out of every DM and every list', async function () {
    expect(await candidates('M')).deep.equals([])
    for (const who of ['Hc', 'F', 'A', 'L'])
      expect(await candidates(who), who).not.includes('M')
    await refusedAs('F', ['M'], 'notCandidate')
    await refusedAs('M', ['F'], 'notCandidate')
  })

  it('gives a minor who plays nowhere their guardian, and only them', async function () {
    await link('N', 'M', 'guardian')
    expect(await candidates('M')).deep.equals(['N'])
    await allowed('N', ['M'])
    await allowed('M', ['N'])
    await refusedAs('Hc', ['M'], 'notCandidate')
    await refusedAs('M', ['N', 'F'], 'notCandidate')
  })

  it('counts adult family and never a guardian or family member who is not an adult', async function () {
    await link('B', 'P', 'family')
    await allowed('B', ['P'])
    // M, a minor who plays nowhere, as P's family: no relative of P's.
    await link('M', 'P', 'family')
    await refusedAs('M', ['P'], 'notCandidate')
    const facts = new DmFacts(db, fixture.now)
    const { guardians, family } = await facts.relativesOf(fixture.id('P'))
    expect([...family].map(id => fixture.keyOf(id))).deep.equals(['B'])
    expect([...guardians].map(id => fixture.keyOf(id)).sort()).deep.equals([
      'G1',
      'G2'
    ])
  })

  it('labels an adult player “Player” and nobody their staff, and a minor’s coach and guardian as such', async function () {
    const labelsOf = async (
      who: string,
      others: string[]
    ): Promise<Record<string, string>> => {
      const made = await dm(who, others)
      const answer = await fixture.call(
        who,
        'GET',
        `/chat/conversations/${made.body.id}/members`
      )
      expect(answer.status).equals(200)
      return Object.fromEntries(
        (answer.body as Array<{ userId: string; label: string }>).map(row => [
          fixture.keyOf(row.userId),
          row.label
        ])
      )
    }
    expect(await labelsOf('L', ['Ea'])).deep.equals({
      L: 'Player',
      Ea: 'Member'
    })
    expect(await labelsOf('Hc', ['P', 'G1'])).deep.equals({
      Hc: 'Staff',
      P: 'Player',
      G1: 'Guardian'
    })
  })

  it('treats somebody with no age as no minor', async function () {
    await fixture.person('Ageless', { noAge: true })
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: fixture.id('Ageless'),
        team_id: fixture.seed.teams.hawks,
        role: 'member'
      })
      .execute()
    await fixture.drain()
    await allowed('A', ['Ageless'])
  })

  describe('in a SafeSport league', function () {
    before(async function () {
      await setLao(true)
    })
    after(async function () {
      await setLao(false)
    })

    it('asks a coach alone for another adult, takes a guardian or an admin, and never a scorekeeper', async function () {
      await refusedAs('Hc', ['P'], 'adultRequired')
      await allowed('Hc', ['P', 'G1'])
      await allowed('Hc', ['P', 'Ha'])
      await refusedAs('Hc', ['P', 'Hk'], 'notCandidate')
    })

    it('counts a minor only the second-adult rule refuses among those whose history it hides', async function () {
      const facts = new DmFacts(db, fixture.now)
      const members = [fixture.id('Hc'), fixture.id('P')]
      expect(await facts.pairRuleBreaks(members, new Set(members))).deep.equals(
        []
      )
      expect(await facts.refusedMinors(members)).deep.equals([fixture.id('P')])
    })

    it('needs no second adult beside a peer no more than 4 years older', async function () {
      await allowed('Near', ['P'])
      await refusedAs('Far', ['P'], 'notCandidate')
    })

    it('offers relatives and adult staff as included adults, not season or league staff', async function () {
      const answer = await fixture.call(
        'Hc',
        'GET',
        `/chat/included-adults?playerIds=${fixture.id('P')}`
      )
      expect(answer.status).equals(200)
      const offered = (answer.body as Array<{ userId: string }>)
        .map(row => fixture.keyOf(row.userId))
        .sort()
      expect(offered).deep.equals(['B', 'G1', 'G2', 'Ha'].sort())
    })
  })
})
