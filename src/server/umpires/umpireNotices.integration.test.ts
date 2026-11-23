import { expect } from 'chai'
import type { Kysely, KyselyPlugin } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { Notification } from '../../common/notifications'
import type { EventReminder } from '../../common/push'
import type { UmpireNotificationSettings } from '../../common/umpires'
import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { seedUmpireCounts } from '../../test/umpireTypes'
import { createSession } from '../auth/sessions'
import type { Database } from '../db/database'
import type { NewPushRequest } from '../push/requests'
import { firstTry } from '../push/requests'
import type { PushAddress, PushMessage } from '../push/send'
import { handleRequest } from '../push/sender/main'
import {
  type LeagueNoticePush,
  openDigests,
  queueUmpireDigests,
  recordSignUp,
  recordUmpireDigests
} from './notices'

/**
 * `db`, keeping each query it is asked, as its node: a digest's settle reads
 * its undismissed events through a left join on `notification_receipts`,
 * and writes them there.
 */
function watched(db: Kysely<Database>): {
  db: Kysely<Database>
  settleReads: () => string[]
  receiptWrites: () => string[]
} {
  const asked: string[] = []
  const plugin: KyselyPlugin = {
    transformQuery: args => {
      asked.push(JSON.stringify(args.node))
      return args.node
    },
    transformResult: async args => args.result
  }
  return {
    db: db.withPlugin(plugin),
    settleReads: () =>
      asked.filter(
        node =>
          node.includes('"joinType":"LeftJoin"') &&
          node.includes('"notification_receipts"')
      ),
    receiptWrites: () =>
      asked.filter(
        node =>
          node.startsWith('{"kind":"InsertQueryNode"') &&
          node.includes('"notification_receipts"')
      )
  }
}

/**
 * Umpire Management Notifications against the routes and the database: each
 * admin's own settings, the daily missing-umpires digest, sign-up and
 * withdraw notices, and their pushes, which go to League management devices
 * alone while the in-app notice is listed regardless.
 *
 * A1 (101) and A2 (102) administer League A, whose locality is in New York
 * and whose season counts days in New York; U (103) is an umpire certified
 * for Plate and the guardian of an umpire player (104); 106 is an admin, and
 * then not; 105 is a site administrator.
 */
describe('umpire notices', function () {
  this.timeout(120000)
  let f: GroupFixture
  let old: string | undefined
  const queued: NewPushRequest[] = []
  /** Makes the next enqueue reject, as a queue client never should. */
  let rejectPush = false
  const A1 = userIdOfGumbo(101)
  const A2 = userIdOfGumbo(102)
  const U = userIdOfGumbo(103)
  const PLAYER = userIdOfGumbo(104)
  const EX = userIdOfGumbo(106)
  const exRole = 'srl_umpire_notices_ex'

  const settings = async (
    league: string,
    user: number,
    change?: Partial<UmpireNotificationSettings> | unknown
  ): Promise<Response> =>
    await f.h.request(
      change === undefined ? 'GET' : 'PUT',
      `/leagues/${league}/umpire-notifications`,
      change,
      user
    )
  const read = async (
    league: string,
    user: number
  ): Promise<UmpireNotificationSettings> => {
    const response = await settings(league, user)
    expect(response.status, await response.clone().text()).equals(200)
    return (await response.json()) as UmpireNotificationSettings
  }
  const save = async (
    league: string,
    user: number,
    change: Partial<UmpireNotificationSettings>
  ): Promise<UmpireNotificationSettings> => {
    const response = await settings(league, user, change)
    expect(response.status, await response.clone().text()).equals(200)
    return (await response.json()) as UmpireNotificationSettings
  }
  const grantAdmin = async (user: string, id: string): Promise<void> => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id,
        user_id: user,
        scope_type: 'league',
        scope_id: f.leagueA,
        role: 'admin',
        granted_by: A1
      })
      .execute()
  }
  const game = async (
    id: string,
    startAt: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> => {
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(startAt),
        end_at: new Date(Date.parse(startAt) + 2 * 3600000),
        timezone: 'America/New_York',
        ...extra
      })
      .execute()
  }
  const fill = async (gameId: string, slot = 'uty_plate:1'): Promise<void> => {
    await f.h.db
      .insertInto('umpire_assignments')
      .values({ game_id: gameId, slot, user_id: U, assigned_by: A1 })
      .execute()
  }
  /** The digest rows of an admin, oldest first. */
  const digests = async (
    user: string
  ): Promise<
    Array<{
      id: string
      revision: number
      title: string
      description: string
      gameId: string
    }>
  > =>
    (
      await f.h.db
        .selectFrom('notification_events')
        .select(['id', 'revision', 'metadata', 'recorded_recipients'])
        .where('source_type', '=', 'umpireMissingSlots')
        .where('source_id', '=', `${f.leagueA}:${user}`)
        .orderBy('revision')
        .execute()
    ).map(row => {
      expect(row.recorded_recipients).deep.equals([user])
      const metadata = row.metadata as Record<string, string>
      expect(metadata.leagueId).equals(f.leagueA)
      return {
        id: row.id,
        revision: row.revision,
        title: metadata.title,
        description: metadata.description,
        gameId: metadata.gameId
      }
    })
  const notices = async (
    user: number,
    history = false
  ): Promise<{ items: Notification[]; hasPending: boolean }> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications${history ? '?history=1' : ''}`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return (await response.json()) as {
      items: Notification[]
      hasPending: boolean
    }
  }
  const slot = async (
    method: 'POST' | 'DELETE',
    gameId: string,
    body: unknown,
    user: number
  ): Promise<void> => {
    const response = await f.h.request(
      method,
      `/games/${gameId}/umpire-slots`,
      body,
      user
    )
    expect(response.status, await response.clone().text()).equals(200)
  }
  /** A notice's title as `user` reads it in their inbox, at read time. */
  const titleAs = async (user: string, id: string): Promise<string> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      [101, 102, 103, 105, 106].find(gumbo => userIdOfGumbo(gumbo) === user)
    )
    expect(response.status, await response.clone().text()).equals(200)
    return ((await response.json()) as Notification).title
  }
  /**
   * Slot notices of a kind recorded since `since`, newest last, each titled
   * as A2 (a recipient of every one) reads it. None keeps a name.
   */
  const slotNotices = async (
    kind: 'umpireSignUp' | 'umpireWithdraw',
    since: Date
  ): Promise<
    Array<{ id: string; title: string; gameId: string; recipients: string[] }>
  > =>
    await Promise.all(
      (
        await f.h.db
          .selectFrom('notification_events')
          .select(['id', 'metadata', 'recorded_recipients'])
          .where('source_type', '=', kind)
          .where('created_at', '>=', since)
          .orderBy('created_at')
          .execute()
      ).map(async row => {
        const metadata = row.metadata as Record<string, string>
        expect(metadata.leagueId).equals(f.leagueA)
        expect(metadata).not.have.property('title')
        expect(metadata.umpireId).match(/^usr_/)
        return {
          id: row.id,
          title: await titleAs(A2, row.id),
          gameId: metadata.gameId,
          recipients: [...row.recorded_recipients].sort()
        }
      })
    )
  /**
   * Each notice's pushes reach its recipients once each, and each names the
   * umpire as its recipients read the notice.
   */
  const expectPushed = async (
    pushed: readonly LeagueNoticePush[],
    made: ReadonlyArray<{ id: string; recipients: string[] }>
  ): Promise<void> => {
    expect([...new Set(pushed.map(push => push.tag))].sort()).deep.equals(
      made.map(notice => `event:league:${notice.id}`).sort()
    )
    for (const notice of made) {
      const mine = pushed.filter(
        push => push.tag === `event:league:${notice.id}`
      )
      expect(mine.flatMap(push => push.u).sort()).deep.equals(notice.recipients)
      for (const push of mine)
        for (const user of push.u)
          expect(push.body).equals(await titleAs(user, notice.id))
    }
  }

  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture({
      push: {
        add: async request => {
          if (rejectPush) {
            rejectPush = false
            throw new Error('the queue is away')
          }
          queued.push(request)
          return true
        }
      }
    })
    const db = f.h.db
    await db
      .updateTable('leagues')
      .set({
        locality: JSON.stringify({
          city: 'Albany',
          region: 'NY',
          country: 'US',
          placeId: null,
          timezone: 'America/New_York'
        })
      })
      .where('id', '=', f.leagueA)
      .execute()
    await db
      .updateTable('seasons')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', f.seasonA)
      .execute()
    // Plate is required; Field is optional.
    await seedUmpireCounts(db, f.seasonA, true, 0, 1)
    await grantAdmin(A2, 'srl_umpire_notices_a2')
    await db
      .insertInto('league_umpires')
      .values({ league_id: f.leagueA, user_id: U, granted_by: A1 })
      .execute()
    await db
      .insertInto('umpire_certifications')
      .values({
        user_id: U,
        level_id: 'ulv_majors',
        type_id: 'uty_plate',
        enabled: true
      })
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: 'lnk_notices_guardian',
        user_id: U,
        related_user_id: PLAYER,
        kind: 'guardian'
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })

  it('keeps each admin’s own settings per league, for admins only, and an ex-admin’s for their return', async () => {
    const defaults = {
      missingSlots: false,
      daysBefore: 7,
      signUps: false,
      withdrawals: false
    }
    expect(await read(f.leagueA, 101)).deep.equals(defaults)
    expect(await save(f.leagueA, 101, { missingSlots: true })).deep.equals({
      ...defaults,
      missingSlots: true
    })
    expect(await save(f.leagueA, 101, { daysBefore: 3 })).deep.equals({
      ...defaults,
      missingSlots: true,
      daysBefore: 3
    })
    expect(
      await save(f.leagueA, 101, { signUps: true, withdrawals: true })
    ).deep.equals({
      missingSlots: true,
      daysBefore: 3,
      signUps: true,
      withdrawals: true
    })
    expect(await read(f.leagueA, 101)).deep.equals({
      missingSlots: true,
      daysBefore: 3,
      signUps: true,
      withdrawals: true
    })
    // A1's leave A2's, and another league's, alone.
    expect(await read(f.leagueA, 102)).deep.equals(defaults)
    await save(f.leagueA, 105, { withdrawals: true })
    expect(await read(f.leagueB, 105)).deep.equals(defaults)
    await save(f.leagueA, 105, { withdrawals: false })
    for (const body of [
      { daysBefore: 0 },
      { daysBefore: 31 },
      { daysBefore: 2.5 },
      { daysBefore: '7' },
      { signUps: 'yes' },
      { other: true },
      []
    ])
      expect(
        (await settings(f.leagueA, 101, body)).status,
        JSON.stringify(body)
      ).equals(400)
    expect(await read(f.leagueA, 101)).deep.include({ daysBefore: 3 })
    // Somebody who is not an admin.
    expect((await settings(f.leagueA, 103)).status).equals(403)
    expect((await settings(f.leagueA, 103, { signUps: true })).status).equals(
      403
    )
    expect((await settings('lea_missing', 101)).status).equals(404)
    // An admin who saves, stops being one, and is one again.
    await grantAdmin(EX, exRole)
    await save(f.leagueA, 106, { missingSlots: true, signUps: true })
    await f.h.db.deleteFrom('scope_roles').where('id', '=', exRole).execute()
    expect((await settings(f.leagueA, 106)).status).equals(403)
    expect((await settings(f.leagueA, 106, { signUps: false })).status).equals(
      403
    )
    expect(
      await f.h.db
        .selectFrom('league_umpire_notifications')
        .select(['missing_slots', 'sign_ups'])
        .where('league_id', '=', f.leagueA)
        .where('user_id', '=', EX)
        .executeTakeFirst()
    ).deep.equals({ missing_slots: true, sign_ups: true })
    await grantAdmin(EX, exRole)
    expect(await read(f.leagueA, 106)).deep.include({
      missingSlots: true,
      signUps: true
    })
    // An ex-admin again for the rest: their choices stay, and tell them nothing.
    await f.h.db.deleteFrom('scope_roles').where('id', '=', exRole).execute()
    await save(f.leagueA, 102, { signUps: true, withdrawals: true })
  })

  describe('the daily digest', function () {
    // Saturday 10 April 2027 in New York (EDT, -4): 10:00 is 14:00Z.
    const D = '2027-04-10'
    const at = (iso: string): Date => new Date(iso)

    before(async () => {
      await game('gam_n_d1', '2027-04-11T22:00:00Z')
      await game('gam_n_d3', '2027-04-13T22:00:00Z')
      await game('gam_n_d4', '2027-04-14T22:00:00Z')
      await game('gam_n_far', '2027-04-25T22:00:00Z')
      await game('gam_n_optional', '2027-04-11T23:00:00Z')
      await fill('gam_n_optional')
      await game('gam_n_started', '2027-04-10T13:00:00Z')
      await game('gam_n_final', '2027-04-11T21:00:00Z', { status: 'final' })
      await game('gam_n_cancelled', '2027-04-11T21:00:00Z', {
        status: 'cancelled'
      })
      await game('gam_n_withdrawn', '2027-04-11T21:00:00Z', {
        withdrawn_at: new Date('2027-04-01T00:00:00Z')
      })
    })

    it('lists the games still missing a required umpire at 10:00 in the league’s zone, once a day', async () => {
      expect(
        await recordUmpireDigests(f.h.db, at(`${D}T13:59:00Z`))
      ).deep.equals([])
      const pushes = await recordUmpireDigests(f.h.db, at(`${D}T14:00:00Z`))
      const [digest] = await digests(A1)
      expect(digest.revision).equals(20270410)
      expect(digest.title).equals('2 games still need umpires')
      expect(digest.description.split('\n')).deep.equals([
        'Demo Hawks vs Demo Eagles · Apr 11, 6:00 pm · Demo Regular — Plate (1 day out)',
        'Demo Hawks vs Demo Eagles · Apr 13, 6:00 pm · Demo Regular — Plate (3 days out)'
      ])
      expect(digest.gameId).equals('gam_n_d1')
      // A2 has missing slots off, and the ex-admin is no admin.
      expect(await digests(A2)).deep.equals([])
      expect(await digests(EX)).deep.equals([])
      expect(pushes).deep.equals([
        {
          t: 'league',
          u: [A1],
          title: 'Demo League A',
          body: '2 games still need umpires',
          url: `teamstation://umpires/${f.leagueA}?view=league&game=gam_n_d1`,
          tag: `event:league:${digest.id}`
        }
      ])
      // Again that day, and by two nodes at once: nothing more.
      expect(
        await recordUmpireDigests(f.h.db, at(`${D}T14:20:00Z`))
      ).deep.equals([])
      expect(
        await Promise.all([
          recordUmpireDigests(f.h.db, at(`${D}T23:50:00Z`)),
          recordUmpireDigests(f.h.db, at(`${D}T23:50:00Z`))
        ])
      ).deep.equals([[], []])
      expect(await digests(A1)).length(1)
      // In Pending, with the league and game it opens.
      const pending = await notices(101)
      expect(pending.hasPending).equals(true)
      const listed = pending.items.find(item => item.id === digest.id)!
      expect(listed).deep.include({
        type: 'umpireMissingSlots',
        title: '2 games still need umpires',
        leagueId: f.leagueA,
        gameId: 'gam_n_d1'
      })
      expect(
        (await notices(101, true)).items.some(item => item.id === digest.id)
      ).equals(false)
    })

    it('repeats the next day, replacing the last in Pending, as games fill and move', async () => {
      await fill('gam_n_d3')
      await f.h.db
        .updateTable('games')
        .set({
          start_at: new Date('2027-04-12T20:00:00Z'),
          end_at: new Date('2027-04-12T22:00:00Z')
        })
        .where('id', '=', 'gam_n_far')
        .execute()
      // Two nodes at once on the next day: one digest.
      const made = await Promise.all([
        recordUmpireDigests(f.h.db, at('2027-04-11T14:00:00Z')),
        recordUmpireDigests(f.h.db, at('2027-04-11T14:00:00Z'))
      ])
      expect(made.flat()).length(1)
      const [first, second] = await digests(A1)
      expect(second.revision).equals(20270411)
      expect(second.description.split('\n')).deep.equals([
        'Demo Hawks vs Demo Eagles · Apr 11, 6:00 pm · Demo Regular — Plate (today)',
        'Demo Hawks vs Demo Eagles · Apr 12, 4:00 pm · Demo Regular — Plate (1 day out)',
        'Demo Hawks vs Demo Eagles · Apr 14, 6:00 pm · Demo Regular — Plate (3 days out)'
      ])
      const pending = (await notices(101)).items.filter(
        item => item.type === 'umpireMissingSlots'
      )
      expect(pending.map(item => item.id)).deep.equals([second.id])
      expect(
        (await notices(101, true)).items.find(item => item.id === first.id)
      ).deep.include({ leagueId: f.leagueA, gameId: 'gam_n_d1' })
      // Dismissed, it leaves Pending.
      expect(
        (
          await f.h.request(
            'PUT',
            `/me/notifications/${second.id}/dismissed`,
            undefined,
            101
          )
        ).status
      ).equals(204)
      expect(
        (await notices(101)).items.some(
          item => item.type === 'umpireMissingSlots'
        )
      ).equals(false)
    })

    it('records nothing with no game to list, or while the league does not manage umpires', async () => {
      // Every game filled, started or out of the window by the 15th.
      for (const id of ['gam_n_d4', 'gam_n_far']) await fill(id)
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-12T14:00:00Z'))
      ).deep.equals([])
      await f.h.db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', 'gam_n_d4')
        .execute()
      await f.h.db
        .updateTable('leagues')
        .set({ umpire_management: false })
        .where('id', '=', f.leagueA)
        .execute()
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-13T14:00:00Z'))
      ).deep.equals([])
      await f.h.db
        .updateTable('leagues')
        .set({ umpire_management: true })
        .where('id', '=', f.leagueA)
        .execute()
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-13T14:00:00Z'))
      ).length(1)
    })

    it('goes by 10:00 Pacific for a league with no locality', async () => {
      await f.h.db
        .updateTable('leagues')
        .set({ locality: null })
        .where('id', '=', f.leagueA)
        .execute()
      // 09:59 and 10:00 PDT (-7) on the 14th.
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-14T16:59:00Z'))
      ).deep.equals([])
      const [push] = await recordUmpireDigests(
        f.h.db,
        at('2027-04-14T17:00:00Z')
      )
      expect(push).deep.include({ u: [A1], body: '1 game still needs umpires' })
      expect((await digests(A1)).at(-1)!.revision).equals(20270414)
      // An admin with missing slots off, and an ex-admin, never got one.
      expect(await digests(A2)).deep.equals([])
      expect(await digests(EX)).deep.equals([])
    })

    it('settles the last digest in Pending on a day with no game left to list', async () => {
      // Pacific still (no locality); Apr 14's game has started by the 15th.
      await game('gam_n_settle', '2027-04-16T22:00:00Z')
      const [push] = await recordUmpireDigests(
        f.h.db,
        at('2027-04-15T17:00:00Z')
      )
      expect(push).deep.include({ u: [A1], body: '1 game still needs umpires' })
      const day1 = (await digests(A1)).at(-1)!
      expect(day1).deep.include({ revision: 20270415, gameId: 'gam_n_settle' })
      const before = await notices(101)
      expect(before.hasPending).equals(true)
      expect(
        before.items
          .filter(item => item.type === 'umpireMissingSlots')
          .map(item => item.id)
      ).deep.equals([day1.id])
      // Its slots filled, the next day records and pushes nothing.
      await fill('gam_n_settle')
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-16T17:00:00Z'))
      ).deep.equals([])
      expect((await digests(A1)).at(-1)!.id).equals(day1.id)
      const after = await notices(101)
      expect(
        after.items.some(item => item.type === 'umpireMissingSlots')
      ).equals(false)
      expect(after.hasPending).equals(false)
      expect(
        (await notices(101, true)).items.some(item => item.id === day1.id)
      ).equals(true)
      // Again that day: still nothing, and with no digest of A1's open,
      // nothing to settle is read or written (2.harness-review.4).
      const sweep = watched(f.h.db)
      expect(
        await recordUmpireDigests(sweep.db, at('2027-04-16T18:00:00Z'))
      ).deep.equals([])
      expect(sweep.settleReads()).deep.equals([])
      expect(sweep.receiptWrites()).deep.equals([])
      expect((await notices(101)).hasPending).equals(false)
    })

    it('settles the day’s own digest once its games fill that day, and a re-enable counts from the next day', async () => {
      // Pacific (no locality): 10:00 PDT on the 17th is 17:00Z.
      await game('gam_n_sameday', '2027-04-18T22:00:00Z')
      const [push] = await recordUmpireDigests(
        f.h.db,
        at('2027-04-17T17:00:00Z')
      )
      expect(push).deep.include({ u: [A1], body: '1 game still needs umpires' })
      const today = (await digests(A1)).at(-1)!
      expect(today).deep.include({
        revision: 20270417,
        gameId: 'gam_n_sameday'
      })
      expect((await notices(101)).hasPending).equals(true)
      // Filled at 10:05; the 10:10 sweep settles the day's digest itself.
      await fill('gam_n_sameday')
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-17T17:10:00Z'))
      ).deep.equals([])
      const after = await notices(101)
      expect(
        after.items.some(item => item.type === 'umpireMissingSlots')
      ).equals(false)
      expect(after.hasPending).equals(false)
      expect(
        (await notices(101, true)).items.some(item => item.id === today.id)
      ).equals(true)
      // Missing slots off and on again the same day, with a slot open again:
      // nothing more that day.
      await f.h.db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', 'gam_n_sameday')
        .execute()
      await save(f.leagueA, 101, { missingSlots: false })
      await save(f.leagueA, 101, { missingSlots: true })
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-17T18:00:00Z'))
      ).deep.equals([])
      expect((await digests(A1)).at(-1)!.id).equals(today.id)
      expect((await notices(101)).hasPending).equals(false)
      await fill('gam_n_sameday')
    })

    it('dates and counts each game in its own zone, as the umpire schedule does, not its season’s', async () => {
      // 11:30 pm on the 18th in Honolulu is 5:30 am on the 19th in New York,
      // the season's zone.
      await game('gam_n_zone', '2027-04-19T09:30:00Z', {
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam,
        timezone: 'Pacific/Honolulu'
      })
      const [push] = await recordUmpireDigests(
        f.h.db,
        at('2027-04-18T17:00:00Z')
      )
      expect(push).deep.include({ u: [A1], body: '1 game still needs umpires' })
      const digest = (await digests(A1)).at(-1)!
      expect(digest.revision).equals(20270418)
      expect(digest.description).equals(
        'Demo Eagles vs Demo Visitors · Apr 18, 11:30 pm · Demo Regular — Plate (today)'
      )
      // The sign-up and withdraw texts date it so too.
      const since = new Date()
      await slot('POST', 'gam_n_zone', { slot: 'uty_plate:1', userId: U }, 103)
      await slot('DELETE', 'gam_n_zone', { slot: 'uty_plate:1' }, 103)
      expect((await slotNotices('umpireSignUp', since))[0].title).match(
        / signed up as Plate for Demo Eagles vs Demo Visitors, Apr 18 11:30 pm$/
      )
      expect((await slotNotices('umpireWithdraw', since))[0].title).match(
        / withdrew from Plate for Demo Eagles vs Demo Visitors, Apr 18 11:30 pm$/
      )
      await fill('gam_n_zone')
    })
  })

  describe('settling the digests of an admin who no longer gets one', function () {
    // Pacific (no locality): 10:00 PDT is 17:00Z.
    const at = (iso: string): Date => new Date(iso)
    /** An admin's digests that have no dismissed receipt, oldest first. */
    const undismissed = async (user: string): Promise<number[]> =>
      (
        await f.h.db
          .selectFrom('notification_events as e')
          .leftJoin('notification_receipts as r', join =>
            join.onRef('r.event_id', '=', 'e.id').on('r.user_id', '=', user)
          )
          .select('e.revision')
          .where('e.source_type', '=', 'umpireMissingSlots')
          .where('e.source_id', '=', `${f.leagueA}:${user}`)
          .where('r.dismissed_at', 'is', null)
          .orderBy('e.revision')
          .execute()
      ).map(row => row.revision)
    const pendingDigests = async (user: number): Promise<string[]> =>
      (await notices(user)).items
        .filter(item => item.type === 'umpireMissingSlots')
        .map(item => item.id)

    before(async () => {
      await game('gam_n_stale', '2027-04-25T22:00:00Z')
      await save(f.leagueA, 101, { daysBefore: 7 })
      await save(f.leagueA, 102, { missingSlots: true, daysBefore: 7 })
      // The ex-admin is an admin again, with missing slots still on.
      await grantAdmin(EX, exRole)
      const pushes = await recordUmpireDigests(
        f.h.db,
        at('2027-04-19T17:00:00Z')
      )
      expect(pushes.map(push => push.u[0]).sort()).deep.equals(
        [A1, A2, EX].sort()
      )
      for (const user of [A1, A2, EX])
        expect(await undismissed(user)).deep.equals([20270419])
    })
    after(async () => {
      await f.h.db
        .updateTable('leagues')
        .set({ umpire_management: true })
        .where('id', '=', f.leagueA)
        .execute()
      await f.h.db.deleteFrom('scope_roles').where('id', '=', exRole).execute()
    })

    it('settles an admin’s digest as they turn missing slots off, and no other admin’s', async () => {
      const [digest] = await pendingDigests(102)
      expect(digest).not.equals(undefined)
      expect(await save(f.leagueA, 102, { missingSlots: false })).deep.include({
        missingSlots: false
      })
      expect(await undismissed(A2)).deep.equals([])
      const after = await notices(102)
      expect(
        after.items.some(item => item.type === 'umpireMissingSlots')
      ).equals(false)
      expect(after.hasPending).equals(false)
      expect(
        (await notices(102, true)).items.some(item => item.id === digest)
      ).equals(true)
      // Saving it off again, or another setting, changes nothing more.
      await save(f.leagueA, 102, { missingSlots: false, signUps: true })
      // The other admins' digests stay in Pending.
      expect(await undismissed(A1)).deep.equals([20270419])
      expect(await undismissed(EX)).deep.equals([20270419])
      expect(await pendingDigests(101)).length(1)
    })

    it('settles an ex-admin’s digest at the next due sweep, recording and pushing nothing for them', async () => {
      await f.h.db.deleteFrom('scope_roles').where('id', '=', exRole).execute()
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-20T16:59:00Z'))
      ).deep.equals([])
      expect(await undismissed(EX)).deep.equals([20270419])
      const pushes = await recordUmpireDigests(
        f.h.db,
        at('2027-04-20T17:00:00Z')
      )
      expect(pushes.map(push => push.u)).deep.equals([[A1]])
      expect(await undismissed(EX)).deep.equals([])
      expect((await digests(EX)).map(digest => digest.revision)).deep.equals([
        20270419
      ])
      // A1, still opted in, has the day's digest in its place.
      expect(await undismissed(A1)).deep.equals([20270420])
    })

    it('never reads or settles the open digest of an admin deleted, disabled or merged away (2.harness-review.3)', async () => {
      const source = `${f.leagueA}:${EX}`
      const id = makeId('audit')
      await f.h.db
        .insertInto('notification_events')
        .values({
          id,
          source_type: 'umpireMissingSlots',
          source_id: source,
          revision: 20270418,
          actor_id: null,
          metadata: {
            title: '1 game still needs umpires',
            description: '',
            leagueId: f.leagueA,
            gameId: 'gam_n_stale'
          },
          recorded_recipients: [EX],
          created_at: at('2027-04-18T17:00:00Z')
        })
        .execute()
      expect((await openDigests(f.h.db)).has(source)).equals(true)
      const closes = [
        { disabled_at: at('2027-04-20T00:00:00Z') },
        { merged_into: A1 },
        // A deleted account stays disabled.
        {
          deleted_at: at('2027-04-20T00:00:00Z'),
          disabled_at: at('2027-04-20T00:00:00Z')
        }
      ]
      const reopen = { disabled_at: null, merged_into: null, deleted_at: null }
      for (const close of closes) {
        await f.h.db
          .updateTable('users')
          .set(close)
          .where('id', '=', EX)
          .execute()
        expect(
          (await openDigests(f.h.db)).has(source),
          JSON.stringify(close)
        ).equals(false)
        const sweep = watched(f.h.db)
        await recordUmpireDigests(sweep.db, at('2027-04-20T17:30:00Z'))
        expect(
          sweep.settleReads().filter(node => node.includes(source)),
          JSON.stringify(close)
        ).deep.equals([])
        expect(
          await f.h.db
            .selectFrom('notification_receipts')
            .select('user_id')
            .where('event_id', '=', id)
            .execute(),
          JSON.stringify(close)
        ).deep.equals([])
        expect(await undismissed(EX)).includes(20270418)
        await f.h.db
          .updateTable('users')
          .set(reopen)
          .where('id', '=', EX)
          .execute()
      }
      await f.h.db
        .deleteFrom('notification_events')
        .where('id', '=', id)
        .execute()
    })

    it('settles every digest of a league at its next due sweep once it stops managing umpires', async () => {
      await f.h.db
        .updateTable('leagues')
        .set({ umpire_management: false })
        .where('id', '=', f.leagueA)
        .execute()
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-21T16:59:00Z'))
      ).deep.equals([])
      expect(await undismissed(A1)).deep.equals([20270420])
      expect(await pendingDigests(101)).length(1)
      expect(
        await recordUmpireDigests(f.h.db, at('2027-04-21T17:00:00Z'))
      ).deep.equals([])
      expect(await undismissed(A1)).deep.equals([])
      expect((await digests(A1)).map(digest => digest.revision).at(-1)).equals(
        20270420
      )
      const after = await notices(101)
      expect(
        after.items.some(item => item.type === 'umpireMissingSlots')
      ).equals(false)
      expect(after.hasPending).equals(false)
    })
  })

  describe('sign-ups and withdrawals', function () {
    // 8:00 pm EDT on 4 April, after the tests' umpire clock.
    before(async () => {
      // Not the Hawks, whom the player plays for.
      const teams = { home_team_id: f.teamB, away_team_id: f.standaloneTeam }
      await game('gam_n_slots', '2027-04-05T00:00:00Z', teams)
      await game('gam_n_slots2', '2027-04-06T00:00:00Z', teams)
    })

    it('tells the admins with sign-ups on, never the one who signed up', async () => {
      const since = new Date()
      const before = queued.length
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      // A1 signs themselves up: only A2 is told.
      await slot(
        'POST',
        'gam_n_slots2',
        { slot: 'uty_plate:1', userId: A1 },
        101
      )
      // A guardian signs up their player: the notice names the player.
      await slot(
        'POST',
        'gam_n_slots',
        { slot: 'uty_field:1', userId: PLAYER },
        103
      )
      const made = await slotNotices('umpireSignUp', since)
      expect(made.map(notice => notice.recipients)).deep.equals([
        [A1, A2].sort(),
        [A2],
        [A1, A2].sort()
      ])
      expect(made[0].title).match(
        /^Mike (Trout|T) signed up as Plate for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm$/
      )
      expect(made[1].title).match(/ signed up as Plate for .*Apr 5 8:00 pm$/)
      expect(made[2].title).equals(
        'Ichiro signed up as Field for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm'
      )
      expect(made.map(notice => notice.gameId)).deep.equals([
        'gam_n_slots',
        'gam_n_slots2',
        'gam_n_slots'
      ])
      // Pushed to its recipients after the write, each naming the umpire as
      // they read them.
      const pushed = queued.slice(before) as LeagueNoticePush[]
      await expectPushed(pushed, made)
      expect(pushed[0]).deep.include({
        t: 'league',
        title: 'Demo League A',
        url: `teamstation://umpires/${f.leagueA}?view=league&game=gam_n_slots`
      })
      expect(pushed[0].tag).match(/^event:league:/)
      // History from the start, with the league and game.
      // Less the away game's, from the digest's zone case.
      const history = (await notices(102, true)).items.filter(
        item => item.type === 'umpireSignUp' && item.gameId !== 'gam_n_zone'
      )
      expect(history).length(3)
      expect(history[0]).deep.include({
        leagueId: f.leagueA,
        gameId: 'gam_n_slots'
      })
      expect(
        (await notices(102)).items.some(item => item.type === 'umpireSignUp')
      ).equals(false)
    })

    it('tells the admins with withdrawals on of an umpire’s own, never of an admin removing someone else’s', async () => {
      const since = new Date()
      const before = queued.length
      // U withdraws; U as guardian withdraws their player.
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_field:1' }, 103)
      // A1 removes an assignment of U's that A1 did not make: nothing.
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 101)
      // A1 withdraws their own: A2 alone.
      await slot('DELETE', 'gam_n_slots2', { slot: 'uty_plate:1' }, 101)
      const made = await slotNotices('umpireWithdraw', since)
      expect(made.map(notice => notice.recipients)).deep.equals([
        [A1, A2].sort(),
        [A1, A2].sort(),
        [A2]
      ])
      expect(made[0].title).match(
        /^Mike (Trout|T) withdrew from Plate for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm$/
      )
      expect(made[1].title).equals(
        'Ichiro withdrew from Field for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm'
      )
      // Pushed: the three withdrawals and the one sign-up between them.
      await expectPushed(queued.slice(before) as LeagueNoticePush[], [
        ...made,
        ...(await slotNotices('umpireSignUp', since))
      ])
    })

    it('names the umpire as each reader may read them, when they read it (3.harness-review.2)', async () => {
      const SITE = userIdOfGumbo(105)
      await save(f.leagueA, 105, { signUps: true })
      // U off the league's umpires and no longer the player's guardian: on
      // none of League A's lists, so its admins read U's short name, while
      // the site administrator reads it in full.
      const lists = async (on: boolean): Promise<void> => {
        if (on) {
          await f.h.db
            .insertInto('league_umpires')
            .values({ league_id: f.leagueA, user_id: U, granted_by: A1 })
            .execute()
          await f.h.db
            .insertInto('user_links')
            .values({
              id: 'lnk_notices_guardian',
              user_id: U,
              related_user_id: PLAYER,
              kind: 'guardian'
            })
            .execute()
        } else {
          await f.h.db
            .deleteFrom('league_umpires')
            .where('league_id', '=', f.leagueA)
            .where('user_id', '=', U)
            .execute()
          await f.h.db
            .deleteFrom('user_links')
            .where('id', '=', 'lnk_notices_guardian')
            .execute()
        }
      }
      await lists(false)
      const since = new Date()
      const pushed = await recordSignUp(f.h.db, {
        leagueId: f.leagueA,
        gameId: 'gam_n_slots',
        slot: 'uty_plate:1',
        umpireId: U,
        actorIds: [U]
      })
      const [made] = await slotNotices('umpireSignUp', since)
      expect(made.recipients).deep.equals([A1, A2, SITE].sort())
      const game =
        ' signed up as Plate for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm'
      expect(await titleAs(SITE, made.id)).equals(`Mike Trout${game}`)
      expect(await titleAs(A2, made.id)).equals(`Mike T${game}`)
      expect(await titleAs(A1, made.id)).equals(`Mike T${game}`)
      // So does each reader's History page, read as a whole.
      const listed = async (user: number): Promise<string | undefined> =>
        (await notices(user, true)).items.find(item => item.id === made.id)
          ?.title
      expect(await listed(105)).equals(`Mike Trout${game}`)
      expect(await listed(102)).equals(`Mike T${game}`)
      // A push for each name, to those who read it so, built as it is sent.
      expect(pushed.map(push => [push.body, [...push.u].sort()])).deep.members([
        [`Mike Trout${game}`, [SITE]],
        [`Mike T${game}`, [A1, A2].sort()]
      ])
      await expectPushed(pushed, [made])
      // Back on the lists, the admins read U in full in what was recorded.
      await lists(true)
      expect(await titleAs(A2, made.id)).equals(`Mike Trout${game}`)
      // A rename reads as the new name.
      await f.h.db
        .updateTable('users')
        .set({ first_name: 'Mikey' })
        .where('id', '=', U)
        .execute()
      expect(await titleAs(SITE, made.id)).equals(`Mikey Trout${game}`)
      await f.h.db
        .updateTable('users')
        .set({ first_name: 'Mike' })
        .where('id', '=', U)
        .execute()
      await save(f.leagueA, 105, { signUps: false })
    })

    it('names the slot as the digest does, Plate 2 beside a Plate 1 (2.harness-review.6)', async () => {
      await f.h.db
        .updateTable('season_umpire_type_requirements')
        .set({ required_count: 2 })
        .where('season_id', '=', f.seasonA)
        .where('type_id', '=', 'uty_plate')
        .execute()
      const since = new Date()
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:2', userId: U }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:2' }, 103)
      expect((await slotNotices('umpireSignUp', since))[0].title).match(
        /^Mike (Trout|T) signed up as Plate 2 for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm$/
      )
      expect((await slotNotices('umpireWithdraw', since))[0].title).match(
        /^Mike (Trout|T) withdrew from Plate 2 for Demo Eagles vs Demo Visitors, Apr 4 8:00 pm$/
      )
      await f.h.db
        .updateTable('season_umpire_type_requirements')
        .set({ required_count: 1 })
        .where('season_id', '=', f.seasonA)
        .where('type_id', '=', 'uty_plate')
        .execute()
      // Plate alone again, and the first slot is plain Plate.
      const plain = new Date()
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 103)
      expect((await slotNotices('umpireSignUp', plain))[0].title).match(
        / signed up as Plate for /
      )
      // A withdrawal from a slot the season no longer lists names its type.
      await fill('gam_n_slots', 'uty_plate:2')
      const gone = new Date()
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:2' }, 103)
      expect((await slotNotices('umpireWithdraw', gone))[0].title).match(
        /^Mike (Trout|T) withdrew from Plate for /
      )
    })

    it('tells a site administrator who opts in, though they hold no role in the league (2.harness-review.5)', async () => {
      const SITE = userIdOfGumbo(105)
      await save(f.leagueA, 105, { signUps: true })
      const since = new Date()
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 103)
      // The ex-admin with sign-ups still on is not told.
      expect(
        (await slotNotices('umpireSignUp', since)).map(n => n.recipients)
      ).deep.equals([[A1, A2, SITE].sort()])
      await save(f.leagueA, 105, { signUps: false })
    })

    it('keeps the answer and the notice when the push cannot be queued', async () => {
      const since = new Date()
      rejectPush = true
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      expect(rejectPush).equals(false)
      expect(await slotNotices('umpireSignUp', since)).length(1)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 103)
    })

    it('tells nobody with it off', async () => {
      await save(f.leagueA, 101, { signUps: false, withdrawals: false })
      await save(f.leagueA, 102, { signUps: false, withdrawals: false })
      const since = new Date()
      const before = queued.length
      await slot('POST', 'gam_n_slots', { slot: 'uty_plate:1', userId: U }, 103)
      await slot('DELETE', 'gam_n_slots', { slot: 'uty_plate:1' }, 103)
      expect(await slotNotices('umpireSignUp', since)).deep.equals([])
      expect(await slotNotices('umpireWithdraw', since)).deep.equals([])
      expect(queued.length).equals(before)
      await save(f.leagueA, 101, { signUps: true, withdrawals: true })
      await save(f.leagueA, 102, { signUps: true, withdrawals: true })
    })
  })

  describe('push', function () {
    it('pushes a notice to League management devices alone, while it is listed in the app either way', async () => {
      // What the sender sends, as the log transport would write it.
      const sent: Array<{ to: PushAddress; message: PushMessage }> = []
      const recording = {
        send: async (to: PushAddress, message: PushMessage) => {
          sent.push({ to, message })
          return { status: 'sent' as const }
        }
      }
      const device = async (user: string, on: boolean): Promise<string> => {
        const { sessionId } = await createSession(f.h.db, user, 'notices')
        const id = makeId('pushRegistration')
        await f.h.db
          .insertInto('push_registrations')
          .values({
            id,
            user_id: user,
            session_id: sessionId,
            platform: 'android',
            address_key: `android-${id}`,
            address: `android-${id}`,
            environment: 'production',
            messages: true,
            rsvp_events: true,
            league_management: on
          })
          .execute()
        return id
      }
      const onDevice = await device(A1, true)
      await device(A2, false)
      const before = queued.length
      await slot(
        'POST',
        'gam_n_slots2',
        { slot: 'uty_plate:1', userId: U },
        103
      )
      const [request] = queued.slice(before) as LeagueNoticePush[]
      expect([...request.u].sort()).deep.equals([A1, A2].sort())
      const deps = {
        db: f.h.db,
        transports: { android: recording },
        iosFiltering: false,
        chatHoldMs: 0,
        clock: () => new Date(),
        log: () => undefined
      }
      const queue = {
        markWoken: async () => undefined,
        wokenAt: async () => null,
        readPast: async () => undefined
      }
      const { outcome } = await handleRequest(
        firstTry(request),
        deps,
        queue as never
      )
      expect(outcome).deep.equals({ status: 'done' })
      expect(sent.map(each => each.to.id)).deep.equals([onDevice])
      const message = sent[0].message
      if (message.platform !== 'android') throw new Error('not Android')
      const payload = JSON.parse(message.data.payload) as EventReminder
      expect(payload).deep.equals({
        t: 'event',
        u: A1,
        title: 'Demo League A',
        body: request.body,
        url: `teamstation://umpires/${f.leagueA}?view=league&game=gam_n_slots2`,
        tag: request.tag
      })
      // A2's device has League management off: no push, but the notice is
      // in A2's History all the same.
      const history = (await notices(102, true)).items
      expect(
        history.some(
          item => item.type === 'umpireSignUp' && item.gameId === 'gam_n_slots2'
        )
      ).equals(true)
    })
  })

  describe('a sweep where one league fails (3.harness-review.1)', function () {
    // Pacific (no locality): 11:00 PDT on 10 May 2027.
    const now = new Date('2027-05-10T18:00:00Z')
    const leagues = [1, 2, 3].map(n => `lea_n_sweep${n}`)

    before(async () => {
      for (const [index, league] of leagues.entries()) {
        const n = index + 1
        await f.h.db
          .insertInto('leagues')
          .values({
            id: league,
            name: `Sweep League ${n}`,
            umpire_management: true
          })
          .execute()
        await f.h.db
          .insertInto('umpire_levels')
          .values({
            id: `ulv_n_sweep${n}`,
            league_id: league,
            name: 'majors',
            position: 0
          })
          .execute()
        await f.h.db
          .insertInto('umpire_types')
          .values({
            id: `uty_n_sweep${n}`,
            league_id: league,
            name: 'Plate',
            position: 0
          })
          .execute()
        await f.h.db
          .insertInto('seasons')
          .values({
            id: `sea_n_sweep${n}`,
            league_id: league,
            name: `Sweep ${n}`,
            year: 2027,
            starts_on: '2027-03-01',
            ends_on: '2027-08-01'
          })
          .execute()
        await f.h.db
          .insertInto('season_umpire_requirements')
          .values({ season_id: `sea_n_sweep${n}`, level_id: `ulv_n_sweep${n}` })
          .execute()
        await f.h.db
          .insertInto('season_umpire_type_requirements')
          .values({
            season_id: `sea_n_sweep${n}`,
            type_id: `uty_n_sweep${n}`,
            required_count: 1,
            optional_count: 0
          })
          .execute()
        await game(`gam_n_sweep${n}`, '2027-05-11T22:00:00Z', {
          season_id: `sea_n_sweep${n}`
        })
        await f.h.db
          .insertInto('scope_roles')
          .values({
            id: `srl_n_sweep${n}`,
            user_id: A1,
            scope_type: 'league',
            scope_id: league,
            role: 'admin',
            granted_by: A1
          })
          .execute()
        await f.h.db
          .insertInto('league_umpire_notifications')
          .values({ league_id: league, user_id: A1, missing_slots: true })
          .execute()
      }
    })
    after(async () => {
      await f.h.db
        .updateTable('leagues')
        .set({ umpire_management: false })
        .where('id', 'in', leagues)
        .execute()
    })

    it('queues each league’s pushes as recorded, says the league that failed, and goes on to the next', async () => {
      const added: LeagueNoticePush[] = []
      const said: string[] = []
      /** What was queued when the second league's read of its games threw. */
      let queuedAtFailure: string[] | undefined
      let failing = true
      const plugin: KyselyPlugin = {
        transformQuery: args => {
          const node = JSON.stringify(args.node)
          if (
            failing &&
            node.includes('"games"') &&
            node.includes(`"${leagues[1]}"`)
          ) {
            queuedAtFailure = added.map(push => push.title)
            throw new Error('statement timeout')
          }
          return args.node
        },
        transformResult: async args => args.result
      }
      const queue = {
        add: async (request: NewPushRequest) => {
          added.push(request as LeagueNoticePush)
          return true
        }
      }
      const sweep = async (): Promise<string[]> => {
        const before = added.length
        await queueUmpireDigests(f.h.db.withPlugin(plugin), now, queue, line =>
          said.push(line)
        )
        return added
          .slice(before)
          .map(push => push.title)
          .filter(title => title.startsWith('Sweep League'))
      }
      expect(await sweep()).deep.equals(['Sweep League 1', 'Sweep League 3'])
      // The first league's push was queued before the second's read threw.
      expect(queuedAtFailure).includes('Sweep League 1')
      expect(said).deep.equals([
        `recording umpire digests for league ${leagues[1]}: Error: statement timeout`
      ])
      const recorded = async (league: string): Promise<number> =>
        (
          await f.h.db
            .selectFrom('notification_events')
            .select('id')
            .where('source_type', '=', 'umpireMissingSlots')
            .where('source_id', '=', `${league}:${A1}`)
            .execute()
        ).length
      expect(await Promise.all(leagues.map(recorded))).deep.equals([1, 0, 1])
      // The next sweep records the second league's, and nothing again.
      failing = false
      expect(await sweep()).deep.equals(['Sweep League 2'])
      expect(await Promise.all(leagues.map(recorded))).deep.equals([1, 1, 1])
      expect(said).length(1)
    })

    it('queues a digest’s push even when settling the older one then fails (4.harness-review.1)', async () => {
      // The next day: each league's digest from the test above is still
      // open, so recording today's settles it, and that settle throws.
      const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      const added: LeagueNoticePush[] = []
      const said: string[] = []
      let failing = true
      const plugin: KyselyPlugin = {
        transformQuery: args => {
          // Only settling's write of a receipt fails; the reads go on.
          if (
            failing &&
            args.node.kind === 'InsertQueryNode' &&
            JSON.stringify(args.node).includes('"notification_receipts"')
          )
            throw new Error('statement timeout')
          return args.node
        },
        transformResult: async args => args.result
      }
      const queue = {
        add: async (request: NewPushRequest) => {
          added.push(request as LeagueNoticePush)
          return true
        }
      }
      const sweep = async (): Promise<string[]> => {
        const before = added.length
        await queueUmpireDigests(
          f.h.db.withPlugin(plugin),
          nextDay,
          queue,
          line => said.push(line)
        )
        return added
          .slice(before)
          .map(push => push.title)
          .filter(title => title.startsWith('Sweep League'))
      }
      expect(await sweep()).deep.equals([
        'Sweep League 1',
        'Sweep League 2',
        'Sweep League 3'
      ])
      expect(said.length).greaterThan(0)
      // Today's rows are in, so a later sweep pushes none of them again.
      failing = false
      expect(await sweep()).deep.equals([])
    })
  })
})
