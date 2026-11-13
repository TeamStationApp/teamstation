import { appendFileSync } from 'node:fs'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import type { EventReminder } from '../../common/push'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  senderDeps,
  type TestPushQueue,
  testPushQueue
} from '../../test/pushQueueKit'
import { createSession } from '../auth/sessions'
import { type Database, makeDatabase } from '../db/database'
import type { ApnsMessage } from './apns'
import type { FcmMessage } from './fcm'
import { MAX_ATTEMPTS } from './requests'
import {
  dueReminders,
  pruneReminders,
  queueReminders,
  type ReminderOutcome,
  REMINDERS_KEPT_MS
} from './rsvpReminders'
import type {
  PushAddress,
  PushLog,
  PushMessage,
  PushPlatform,
  PushTransport,
  PushTransports
} from './send'
import type { WebPushMessage } from './webPush'

/**
 * M4: the sweep reminds whoever said yes to an event starting within two
 * hours, and the guardians of the players among them, once an event start,
 * over a migrated scratch database. Each sweep goes through the push queue
 * on the test Valkey, as the server's does: the due starts are queued, and
 * the push sender's own code reads, sends and settles them. A recording
 * transport stands in for APNs, FCM and Web Push.
 *
 * With `TS_PUSH_DISPATCH_LOG` set, each case appends its recipients and
 * per-platform payloads to that file (the `server-push-dispatch.log`
 * artifact).
 */

interface Sent {
  to: PushAddress
  message: PushMessage
}

const dispatchLog = process.env.TS_PUSH_DISPATCH_LOG

/** The sweep's clock: 3:00 PM in Los Angeles. */
const NOW = new Date('2027-05-01T22:00:00.000Z')
const minutes = (count: number): Date =>
  new Date(NOW.getTime() + count * 60 * 1000)
const ZONE = 'America/Los_Angeles'

const HAWKS = 'tem_reminder_hawks'
const OWLS = 'tem_reminder_owls'

/** Everybody here, by the key each case calls them. */
const PEOPLE = {
  /** Players on the Hawks; P1's guardian is G1. */
  P1: { gumbo: 4601, name: 'Mookie Betts' },
  P2: { gumbo: 4602, name: 'Aaron Judge' },
  /** The Hawks' coach. */
  C: { gumbo: 4603, name: 'Joe Torre' },
  G1: { gumbo: 4604, name: 'Derek Jeter' },
  /** A player on the Owls, whose guardian is G3. */
  P3: { gumbo: 4605, name: 'Shohei Ohtani' },
  G3: { gumbo: 4606, name: 'Cal Ripken' },
  /** On no team. */
  X: { gumbo: 4607, name: 'Ken Griffey' },
  /** A Hawks player, with guardian G4, who leaves the roster. */
  P4: { gumbo: 4608, name: 'Tony Gwynn' },
  G4: { gumbo: 4609, name: 'Hank Aaron' },
  /** A Hawks player whose older row M2 was merged into M. */
  M: { gumbo: 4610, name: 'Willie Mays' },
  M2: { gumbo: 4611, name: 'Willie Mays' },
  /** On the Hawks without playing; G1 is their guardian too. */
  N: { gumbo: 4612, name: 'Nolan Ryan' }
} as const
type Key = keyof typeof PEOPLE
const id = (key: Key): string => userIdOfGumbo(PEOPLE[key].gumbo)
const keyOf = (userId: string): string =>
  (Object.keys(PEOPLE) as Key[]).find(key => id(key) === userId) ?? userId

/** Who has a phone or browser of which kind. */
const DEVICES: Partial<Record<Key, PushPlatform>> = {
  P1: 'ios',
  P2: 'android',
  C: 'web',
  G1: 'android',
  P3: 'ios',
  G3: 'web',
  X: 'ios',
  P4: 'android',
  G4: 'ios',
  M: 'android',
  N: 'ios'
}

/** What one sweep, through the queue, reminded and sent. */
interface Swept {
  reminded: number
  sent: number
  skipped: number
  failed: number
  removed: number
}

describe('RSVP reminders (M4)', function () {
  this.timeout(60000)
  const name = `teamstation_rsvp_reminders_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  let pushQueue: TestPushQueue

  /**
   * The primary's sweep at `now` (`dueReminders`, queued) and the push
   * sender's work on each request it queued, with `now` its clock.
   */
  async function sweepRsvpReminders(
    on: Kysely<Database>,
    now: Date,
    through: PushTransports,
    log?: PushLog
  ): Promise<Swept> {
    await queueReminders(on, now, pushQueue, () => undefined)
    const swept: Swept = {
      reminded: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      removed: 0
    }
    for (const report of await pushQueue.drain(
      senderDeps(on, through, { clock: () => now, log })
    )) {
      const outcome = report as ReminderOutcome
      swept.reminded += outcome.reminded
      swept.sent += outcome.sent
      swept.skipped += outcome.skipped
      swept.failed += outcome.failed
      swept.removed += outcome.removed
    }
    return swept
  }

  /** The requests waiting to be tried again, oldest first. */
  async function waiting(): Promise<Array<Record<string, unknown>>> {
    return (
      await pushQueue.client.zRange(pushQueue.queue.keys.later, 0, -1)
    ).map(raw => JSON.parse(raw) as Record<string, unknown>)
  }
  let sent: Sent[] = []
  /** What the step now under way is called in the log, when not the case's title. */
  let step: string | null = null

  const recorder = <M extends PushMessage>(): PushTransport<M> => ({
    async send(to, message) {
      sent.push({ to, message })
      return { status: 'sent' }
    }
  })
  const transports: PushTransports = {
    ios: recorder<ApnsMessage>(),
    android: recorder<FcmMessage>(),
    web: recorder<WebPushMessage>()
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    // Deliberately fail, never skip: the sweep is all queries.
    await createMigratedDatabase(admin, name, migrations)
    pushQueue = await testPushQueue()
    db = makeDatabase(testDatabaseUrlOf(name))
    await insertFixtureUsers(
      db,
      (Object.keys(PEOPLE) as Key[])
        .filter(key => key !== 'M2')
        .map(key => ({
          id: PEOPLE[key].gumbo,
          display_name: PEOPLE[key].name,
          first_name: PEOPLE[key].name.split(' ')[0],
          last_name: PEOPLE[key].name.split(' ')[1],
          login_enabled: true
        }))
    )
    await insertFixtureUsers(db, {
      id: PEOPLE.M2.gumbo,
      display_name: PEOPLE.M2.name,
      merged_into: id('M')
    })
    await db
      .insertInto('teams')
      .values([
        { id: HAWKS, name: 'Hawks' },
        { id: OWLS, name: 'Owls' }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values(
        (
          [
            ['P1', HAWKS],
            ['P2', HAWKS],
            ['P4', HAWKS],
            // The merged row is the one still on the roster.
            ['M2', HAWKS],
            ['P3', OWLS],
            ['N', HAWKS]
          ] as const
        ).map(([key, team]) => ({
          id: `mem_reminder_${key}`,
          user_id: id(key),
          team_id: team,
          role: 'member' as const,
          is_player: key !== 'N'
        }))
      )
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'srl_reminder_coach',
        user_id: id('C'),
        scope_type: 'team',
        scope_id: HAWKS,
        role: 'coach'
      })
      .execute()
    await db
      .insertInto('user_links')
      .values(
        (
          [
            ['G1', 'P1'],
            ['G3', 'P3'],
            ['G4', 'P4'],
            ['G1', 'N']
          ] as const
        ).map(([guardian, player]) => ({
          id: `ulk_reminder_${guardian}_${player}`,
          user_id: id(guardian),
          related_user_id: id(player),
          kind: 'guardian' as const
        }))
      )
      .execute()
    for (const [key, platform] of Object.entries(DEVICES) as Array<
      [Key, PushPlatform]
    >) {
      const session = await createSession(db, id(key), 'reminder-test')
      const address =
        platform === 'web'
          ? JSON.stringify({
              endpoint: `https://push.example.test/${key}`,
              keys: { p256dh: 'p256dh', auth: 'auth' }
            })
          : `token-${key}`
      await db
        .insertInto('push_registrations')
        .values({
          id: `psh_reminder_${key}`,
          user_id: id(key),
          session_id: session.sessionId,
          platform,
          address_key:
            platform === 'web' ? `https://push.example.test/${key}` : address,
          address,
          environment: 'production'
        })
        .execute()
    }
  })

  after(async function () {
    await pushQueue?.close()
    await db?.destroy()
    if (admin != null) {
      await dropScratchDatabase(admin, name, { timeoutMs: 20000 })
      await admin.end()
    }
  })

  beforeEach(async function () {
    sent = []
    await pushQueue.client.del(pushQueue.queue.keys.later)
    await db.deleteFrom('push_reminders_sent').execute()
    await db.deleteFrom('game_rsvps').execute()
    await db.deleteFrom('team_event_rsvps').execute()
    await db.deleteFrom('games').execute()
    await db.deleteFrom('team_events').execute()
    await db.deleteFrom('user_notification_settings').execute()
    // Everybody asked for event reminders but P2.
    await db
      .insertInto('user_notification_settings')
      .values(
        (Object.keys(PEOPLE) as Key[])
          .filter(key => key !== 'M2')
          .map(key => ({ user_id: id(key), rsvp_events: key !== 'P2' }))
      )
      .execute()
  })

  afterEach(async function () {
    await next(step ?? this.currentTest?.title ?? '')
    step = null
  })

  /**
   * Ends one step of a case: with `TS_PUSH_DISPATCH_LOG`, writes what it
   * sent under `title` and which registered devices it left out, then starts
   * afresh.
   */
  async function next(title: string): Promise<void> {
    if (dispatchLog != null) {
      const lines = [`\n## reminder: ${title}`]
      if (sent.length === 0) lines.push('  (no pushes)')
      for (const { to, message } of sent) {
        const { platform: _platform, ...fields } = message
        lines.push(
          `  -> ${keyOf(to.userId)} ${to.platform} (${to.id})`,
          `     ${JSON.stringify(fields)}`
        )
      }
      const reached = new Set(sent.map(item => item.to.userId))
      const left = (Object.keys(DEVICES) as Key[]).filter(
        key => !reached.has(id(key))
      )
      lines.push(`  not reminded: ${left.join(', ')}`)
      appendFileSync(dispatchLog, `${lines.join('\n')}\n`)
    }
    sent = []
  }

  async function teamEvent(
    eventId: string,
    startAt: Date,
    values: {
      title?: string
      status?: 'scheduled' | 'cancelled'
      eventType?: 'practice' | 'other'
      timezone?: string
    } = {}
  ): Promise<void> {
    await db
      .insertInto('team_events')
      .values({
        id: eventId,
        team_id: HAWKS,
        title: values.title ?? 'Batting cage',
        start_at: startAt,
        timezone: values.timezone ?? ZONE,
        status: values.status ?? 'scheduled',
        event_type: values.eventType ?? 'other'
      })
      .execute()
  }

  async function game(eventId: string, startAt: Date): Promise<void> {
    await db
      .insertInto('games')
      .values({
        id: eventId,
        home_team_id: HAWKS,
        away_team_id: OWLS,
        start_at: startAt,
        timezone: ZONE
      })
      .execute()
  }

  async function rsvp(
    table: 'game_rsvps' | 'team_event_rsvps',
    eventId: string,
    key: Key,
    response: 'yes' | 'maybe' | 'no',
    updatedAt = minutes(-60)
  ): Promise<void> {
    await db
      .insertInto(table)
      .values({
        event_id: eventId,
        user_id: id(key),
        response,
        updated_by: id(key),
        updated_at: updatedAt
      })
      .execute()
  }

  /** What each person's devices were told, by key. */
  function reminders(): Record<string, EventReminder> {
    const out: Record<string, EventReminder> = {}
    for (const { to, message } of sent) {
      const payload =
        message.platform === 'ios'
          ? (message.payload as unknown as EventReminder)
          : message.platform === 'android'
            ? (JSON.parse(message.data.payload) as EventReminder)
            : (JSON.parse(message.payload) as EventReminder)
      expect(payload.u).equals(to.userId)
      const { aps: _aps, ...reminder } = payload as EventReminder & {
        aps?: unknown
      }
      out[keyOf(to.userId)] = reminder
    }
    return out
  }

  it('reminds a yes in the window once, in each platform shape', async function () {
    await teamEvent('tev_reminder_cage', minutes(90))
    await rsvp('team_event_rsvps', 'tev_reminder_cage', 'P1', 'yes')
    const swept = await sweepRsvpReminders(db, NOW, transports)
    expect(swept).deep.equals({
      reminded: 2,
      sent: 2,
      skipped: 0,
      failed: 0,
      removed: 0
    })
    expect(reminders()).deep.equals({
      P1: {
        t: 'event',
        u: id('P1'),
        title: 'Batting cage',
        body: 'Starts at 4:30 PM',
        url: 'teamstation://games/tev_reminder_cage',
        tag: 'event:tev_reminder_cage'
      },
      G1: {
        t: 'event',
        u: id('G1'),
        title: 'Batting cage',
        body: 'Mookie · Starts at 4:30 PM',
        url: 'teamstation://games/tev_reminder_cage',
        tag: 'event:tev_reminder_cage'
      }
    })
    const ios = sent.find(item => item.to.platform === 'ios')!.message
    expect(ios).deep.include({
      platform: 'ios',
      pushType: 'alert',
      priority: 10,
      expiration: minutes(90).getTime() / 1000
    })
    expect((ios as ApnsMessage).payload.aps).deep.equals({
      alert: { title: 'Batting cage', body: 'Starts at 4:30 PM' },
      sound: 'default',
      'thread-id': 'event:tev_reminder_cage'
    })
    const android = sent.find(item => item.to.platform === 'android')!.message
    expect(android).deep.include({
      platform: 'android',
      priority: 'high',
      ttlSeconds: 90 * 60
    })
    expect(Object.keys((android as FcmMessage).data)).deep.equals(['payload'])

    await next('reminds a yes in the window, in each platform shape')
    step = 'sweeping again five minutes later reminds nobody'
    expect(await sweepRsvpReminders(db, minutes(5), transports)).deep.include({
      reminded: 0,
      sent: 0
    })
    expect(sent).deep.equals([])
  })

  it('reminds nobody who answered maybe or no, or did not answer', async function () {
    await teamEvent('tev_reminder_unsure', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_unsure', 'P1', 'maybe')
    await rsvp('team_event_rsvps', 'tev_reminder_unsure', 'C', 'no')
    const swept = await sweepRsvpReminders(db, NOW, transports)
    expect(swept.reminded).equals(0)
    expect(sent).deep.equals([])
    expect(
      await db.selectFrom('push_reminders_sent').selectAll().execute()
    ).deep.equals([])
  })

  it("reminds the staff's own yes", async function () {
    await teamEvent('tev_reminder_practice', minutes(30), { title: 'Practice' })
    await rsvp('team_event_rsvps', 'tev_reminder_practice', 'C', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(reminders()).deep.equals({
      C: {
        t: 'event',
        u: id('C'),
        title: 'Practice',
        body: 'Starts at 3:30 PM',
        url: 'teamstation://games/tev_reminder_practice',
        tag: 'event:tev_reminder_practice'
      }
    })
    expect(sent[0].message).deep.include({
      platform: 'web',
      urgency: 'high',
      ttlSeconds: 30 * 60
    })
  })

  it("reminds a plain member's own yes, and not their guardian", async function () {
    await teamEvent('tev_reminder_member', minutes(75))
    await rsvp('team_event_rsvps', 'tev_reminder_member', 'N', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(reminders()).deep.equals({
      N: {
        t: 'event',
        u: id('N'),
        title: 'Batting cage',
        body: 'Starts at 4:15 PM',
        url: 'teamstation://games/tev_reminder_member',
        tag: 'event:tev_reminder_member'
      }
    })
  })

  it("names a game from the counted person's side, home and away", async function () {
    await game('gam_reminder_derby', minutes(120))
    await rsvp('game_rsvps', 'gam_reminder_derby', 'P1', 'yes')
    await rsvp('game_rsvps', 'gam_reminder_derby', 'P3', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    const got = reminders()
    expect(Object.keys(got).sort()).deep.equals(['G1', 'G3', 'P1', 'P3'])
    expect(got.P1.title).equals('Hawks vs Owls')
    expect(got.G1.title).equals('Hawks vs Owls')
    expect(got.P3.title).equals('Owls vs Hawks')
    expect(got.G3).deep.include({
      title: 'Owls vs Hawks',
      body: 'Shohei · Starts at 5:00 PM',
      url: 'teamstation://games/gam_reminder_derby'
    })
  })

  it('reminds nobody of a yes from somebody who may not answer for the event', async function () {
    await teamEvent('tev_reminder_left', minutes(45))
    await rsvp('team_event_rsvps', 'tev_reminder_left', 'P4', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_left', 'X', 'yes')
    await db
      .deleteFrom('memberships')
      .where('id', '=', 'mem_reminder_P4')
      .execute()
    try {
      expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(0)
      expect(sent).deep.equals([])
    } finally {
      await db
        .insertInto('memberships')
        .values({
          id: 'mem_reminder_P4',
          user_id: id('P4'),
          team_id: HAWKS,
          role: 'member',
          is_player: true
        })
        .execute()
    }
  })

  it('leaves out anybody with RSVPed events off', async function () {
    await teamEvent('tev_reminder_off', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_off', 'P2', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_off', 'P1', 'yes')
    await db
      .updateTable('user_notification_settings')
      .set({ rsvp_events: false })
      .where('user_id', '=', id('G1'))
      .execute()
    await sweepRsvpReminders(db, NOW, transports)
    expect(Object.keys(reminders())).deep.equals(['P1'])
  })

  it('skips a cancelled event', async function () {
    await teamEvent('tev_reminder_cancelled', minutes(60), {
      status: 'cancelled'
    })
    await rsvp('team_event_rsvps', 'tev_reminder_cancelled', 'P1', 'yes')
    expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(0)
    expect(sent).deep.equals([])
  })

  it('reminds again of a new start time', async function () {
    await teamEvent('tev_reminder_moved', minutes(100))
    await rsvp('team_event_rsvps', 'tev_reminder_moved', 'C', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(reminders().C.body).equals('Starts at 4:40 PM')
    await next('reminds of the start at 4:40 PM')
    step = 'moved half an hour later, reminds again'
    await db
      .updateTable('team_events')
      .set({ start_at: minutes(130) })
      .where('id', '=', 'tev_reminder_moved')
      .execute()
    await sweepRsvpReminders(db, minutes(20), transports)
    expect(reminders().C.body).equals('Starts at 5:10 PM')
    expect(
      await db
        .selectFrom('push_reminders_sent')
        .select('start_at')
        .orderBy('start_at')
        .execute()
    ).deep.equals([{ start_at: minutes(100) }, { start_at: minutes(130) }])
  })

  it('reminds of nothing outside (now, now + 2h]', async function () {
    await teamEvent('tev_reminder_now', NOW)
    await teamEvent('tev_reminder_past', minutes(-10))
    await teamEvent('tev_reminder_later', minutes(121))
    await teamEvent('tev_reminder_edge', minutes(120))
    for (const event of [
      'tev_reminder_now',
      'tev_reminder_past',
      'tev_reminder_later',
      'tev_reminder_edge'
    ])
      await rsvp('team_event_rsvps', event, 'C', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(
      sent.map(item => reminders()[keyOf(item.to.userId)].tag)
    ).deep.equals(['event:tev_reminder_edge'])
  })

  it("reads a merged player's latest answer, on either row", async function () {
    await teamEvent('tev_reminder_merged', minutes(60))
    // The survivor said no after the closed row said yes.
    await rsvp(
      'team_event_rsvps',
      'tev_reminder_merged',
      'M2',
      'yes',
      minutes(-90)
    )
    await rsvp(
      'team_event_rsvps',
      'tev_reminder_merged',
      'M',
      'no',
      minutes(-30)
    )
    expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(0)
    await next('the survivor said no after the closed row said yes: nobody')
    step = 'then the closed row said yes: M'
    await db
      .updateTable('team_event_rsvps')
      .set({ updated_at: minutes(-10) })
      .where('user_id', '=', id('M2'))
      .execute()
    await sweepRsvpReminders(db, NOW, transports)
    expect(Object.keys(reminders())).deep.equals(['M'])
  })

  it('names a practice as the app lists it, whatever its stored title', async function () {
    await teamEvent('tev_reminder_drills', minutes(60), {
      title: 'Tuesday drills',
      eventType: 'practice'
    })
    await rsvp('team_event_rsvps', 'tev_reminder_drills', 'C', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(reminders().C).deep.include({
      title: 'Practice',
      body: 'Starts at 4:00 PM'
    })
  })

  it('names the children of a guardian who also said yes themselves', async function () {
    await teamEvent('tev_reminder_both', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_both', 'C', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_both', 'P2', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_both', 'P1', 'yes')
    // The coach is a guardian of two of their players.
    await db
      .insertInto('user_links')
      .values(
        (['P1', 'P2'] as const).map(player => ({
          id: `ulk_reminder_C_${player}`,
          user_id: id('C'),
          related_user_id: id(player),
          kind: 'guardian' as const
        }))
      )
      .execute()
    try {
      await sweepRsvpReminders(db, NOW, transports)
      expect(reminders().C.body).equals(
        'You, Mookie, Aaron · Starts at 4:00 PM'
      )
    } finally {
      await db
        .deleteFrom('user_links')
        .where('id', 'in', ['ulk_reminder_C_P1', 'ulk_reminder_C_P2'])
        .execute()
    }
  })

  it('goes on past an event it cannot remind of, and reminds of it once it can', async function () {
    // Swept first, and its zone is no zone at all.
    await teamEvent('tev_reminder_a_broken', minutes(60), {
      timezone: 'Not/AZone'
    })
    await teamEvent('tev_reminder_b_fine', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_a_broken', 'C', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_b_fine', 'C', 'yes')
    const said: string[] = []
    const swept = await sweepRsvpReminders(db, NOW, transports, line => {
      said.push(line)
    })
    expect(swept.reminded).equals(1)
    expect(reminders().C.tag).equals('event:tev_reminder_b_fine')
    expect(said.filter(line => line.includes('failed'))).length(1)
    expect(said.find(line => line.includes('failed'))).match(
      /^push sender: reminder request \S+ \(attempt 1\) failed, trying again at \S+: RangeError/
    )
    // Tried again, as its second attempt, in 5 s.
    expect(await waiting()).deep.equals([
      {
        v: 1,
        t: 'reminder',
        kind: 'teamEvent',
        eventId: 'tev_reminder_a_broken',
        startAt: minutes(60).toISOString(),
        attempt: 2
      }
    ])
    // Nothing was written down for the event that failed.
    expect(
      await db.selectFrom('push_reminders_sent').select('event_id').execute()
    ).deep.equals([{ event_id: 'tev_reminder_b_fine' }])
    await next('one event fails to build: the other is reminded of')
    step = 'its zone mended, the next sweep reminds of it'
    await db
      .updateTable('team_events')
      .set({ timezone: ZONE })
      .where('id', '=', 'tev_reminder_a_broken')
      .execute()
    expect(
      (await sweepRsvpReminders(db, minutes(5), transports)).reminded
    ).equals(1)
    expect(reminders().C.tag).equals('event:tev_reminder_a_broken')
  })

  it('tries again whoever every send failed, and keeps whoever it reached or could not send to', async function () {
    await teamEvent('tev_reminder_retry', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_retry', 'P1', 'yes')
    // P1's phone does not answer; G1's does.
    const flaky: PushTransports = {
      ...transports,
      ios: {
        async send(to, message) {
          sent.push({ to, message })
          return { status: 'failed', reason: 'no answer in 10000 ms' }
        }
      }
    }
    const said: string[] = []
    expect(
      await sweepRsvpReminders(db, NOW, flaky, line => {
        said.push(line)
      })
    ).deep.equals({ reminded: 1, sent: 1, skipped: 0, failed: 1, removed: 0 })
    expect(Object.keys(reminders()).sort()).deep.equals(['G1', 'P1'])
    expect(said.filter(line => line.startsWith('push: '))).deep.equals([
      'push: ios psh_reminder_P1 failed: no answer in 10000 ms'
    ])
    expect(said.filter(line => line.startsWith('push sender: '))).deep.equals([
      'push sender: sent 1 RSVP reminder(s) for teamEvent tev_reminder_retry',
      `push sender: ${said
        .find(line => line.includes('trying again'))!
        .slice('push sender: '.length)}`
    ])
    expect(said.find(line => line.includes('trying again'))).match(
      /^push sender: reminder request \S+ \(attempt 1\) failed, trying again at \S+: 1 unreached$/
    )
    const written = async (): Promise<string[]> =>
      (
        await db
          .selectFrom('push_reminders_sent')
          .select('user_id')
          .where('event_id', '=', 'tev_reminder_retry')
          .execute()
      )
        .map(row => keyOf(row.user_id))
        .sort()
    expect(await written()).deep.equals(['G1'])
    await next('every send to P1 fails: P1 is given back, G1 kept')
    step = 'the next sweep reminds P1 alone'
    expect(await sweepRsvpReminders(db, minutes(5), transports)).deep.include({
      reminded: 1,
      sent: 1
    })
    expect(Object.keys(reminders())).deep.equals(['P1'])
    expect(await written()).deep.equals(['G1', 'P1'])
    await next('the next sweep reminds P1 alone')
    step = 'with no transport for a device, the reminder is kept'
    await teamEvent('tev_reminder_untransported', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_untransported', 'C', 'yes')
    expect(
      await sweepRsvpReminders(db, NOW, { ios: transports.ios })
    ).deep.include({ reminded: 1, sent: 0, skipped: 1, failed: 0 })
    expect(
      await db
        .selectFrom('push_reminders_sent')
        .select('user_id')
        .where('event_id', '=', 'tev_reminder_untransported')
        .execute()
    ).deep.equals([{ user_id: id('C') }])
  })

  it('gives back everybody whose registrations could not be read, or whose send threw, and reminds them later', async function () {
    await teamEvent('tev_reminder_unread', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_unread', 'C', 'yes')
    // The registrations read fails, once.
    const executor = db.getExecutor()
    let failReads = 1
    const failing = db.withPlugin({
      transformQuery(args) {
        if (
          failReads > 0 &&
          executor
            .compileQuery(args.node, args.queryId)
            .sql.includes('from "push_registrations"')
        ) {
          failReads--
          throw new Error('timeout exceeded when trying to connect')
        }
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const said: string[] = []
    expect(
      await sweepRsvpReminders(failing, NOW, transports, line => {
        said.push(line)
      })
    ).deep.equals({ reminded: 0, sent: 0, skipped: 0, failed: 0, removed: 0 })
    expect(sent).deep.equals([])
    expect(said[0]).equals(
      'push: reading registrations failed: Error: timeout exceeded when trying to connect'
    )
    expect(
      await db
        .selectFrom('push_reminders_sent')
        .select('user_id')
        .where('event_id', '=', 'tev_reminder_unread')
        .execute()
    ).deep.equals([])
    expect((await waiting()).map(request => request.attempt)).deep.equals([2])
    await next('the registrations read fails: C is given back, and tried again')

    step = 'the next sweep reminds C'
    expect(
      (await sweepRsvpReminders(db, minutes(5), transports)).reminded
    ).equals(1)
    expect(Object.keys(reminders())).deep.equals(['C'])
    await next(step)

    step = 'a send that throws gives its person back'
    await teamEvent('tev_reminder_threw', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_threw', 'C', 'yes')
    const throwing: PushTransports = {
      ...transports,
      web: {
        async send() {
          throw new Error('the socket closed')
        }
      }
    }
    expect(await sweepRsvpReminders(db, minutes(10), throwing)).deep.include({
      reminded: 0,
      failed: 1
    })
    expect(
      await db
        .selectFrom('push_reminders_sent')
        .select('user_id')
        .where('event_id', '=', 'tev_reminder_threw')
        .execute()
    ).deep.equals([])
    expect(
      (await sweepRsvpReminders(db, minutes(15), transports)).reminded
    ).equals(1)
  })

  it('says a sweep that cannot read the events, and queues nothing', async function () {
    await teamEvent('tev_reminder_unswept', minutes(60))
    const away = (): never => {
      throw new Error('the database is away')
    }
    const broken = {
      selectFrom: away,
      deleteFrom: away
    } as unknown as Kysely<Database>
    const said: string[] = []
    const queued = { add: async () => said.push('queued') }
    expect(
      await queueReminders(broken, NOW, queued, line => said.push(line))
    ).equals(0)
    expect(said).deep.equals([
      'queueing RSVP reminders: Error: the database is away',
      'forgetting past RSVP reminders: Error: the database is away'
    ])
    expect(
      await queueReminders(db, NOW, queued, line => said.push(line))
    ).equals(1)
  })

  it('gives a request up after its last attempt, onto the dead stream', async function () {
    await teamEvent('tev_reminder_dead', minutes(60), {
      timezone: 'Not/AZone'
    })
    await rsvp('team_event_rsvps', 'tev_reminder_dead', 'C', 'yes')
    const [request] = await dueReminders(db, NOW)
    await pushQueue.queue.add({ ...request, v: 1, attempt: MAX_ATTEMPTS })
    const said: string[] = []
    await pushQueue.drain(
      senderDeps(db, transports, {
        clock: () => NOW,
        log: line => {
          said.push(line)
        }
      })
    )
    expect(await waiting()).deep.equals([])
    const dead = await pushQueue.client.xRange(
      pushQueue.queue.keys.dead,
      '-',
      '+'
    )
    expect(dead).length(1)
    expect(JSON.parse(dead[0].message.r)).include({
      eventId: 'tev_reminder_dead',
      attempt: MAX_ATTEMPTS
    })
    expect(dead[0].message.error).match(/^gave up after 5 attempts: RangeError/)
    expect(said.at(-1)).match(
      /^push sender: gave up on reminder request \S+ \(attempt 5\): gave up after 5 attempts/
    )
  })

  it('reads no roster for an event whose people are all reminded or not listening, and still reminds anybody new', async function () {
    await teamEvent('tev_reminder_settled', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_settled', 'P1', 'yes')
    // P2 said yes too, with event reminders off.
    await rsvp('team_event_rsvps', 'tev_reminder_settled', 'P2', 'yes')
    await sweepRsvpReminders(db, NOW, transports)
    expect(Object.keys(reminders()).sort()).deep.equals(['G1', 'P1'])
    await next('P1 and P2 say yes; P2 does not listen')

    const executor = db.getExecutor()
    let rosterReads = 0
    const counted = db.withPlugin({
      transformQuery(args) {
        if (
          executor
            .compileQuery(args.node, args.queryId)
            .sql.includes('"memberships"')
        )
          rosterReads++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    step = 'a sweep with nobody owed reads no roster'
    expect(
      await sweepRsvpReminders(counted, minutes(5), transports)
    ).deep.include({ reminded: 0, sent: 0 })
    expect(rosterReads).equals(0)
    await next(step)

    step = 'a new yes is reminded, with their guardian'
    await rsvp('team_event_rsvps', 'tev_reminder_settled', 'P4', 'yes')
    expect(
      (await sweepRsvpReminders(counted, minutes(10), transports)).reminded
    ).equals(2)
    expect(Object.keys(reminders()).sort()).deep.equals(['G4', 'P4'])
    // Worked out in full, roster and all.
    expect(rosterReads).greaterThan(0)
    await next(step)

    step = 'turning reminders on is reminded'
    await db
      .updateTable('user_notification_settings')
      .set({ rsvp_events: true })
      .where('user_id', '=', id('P2'))
      .execute()
    expect(
      (await sweepRsvpReminders(counted, minutes(15), transports)).reminded
    ).equals(1)
    expect(Object.keys(reminders())).deep.equals(['P2'])
    await next(step)

    step = 'a new guardian is reminded'
    await db
      .insertInto('user_links')
      .values({
        id: 'ulk_reminder_X_P2',
        user_id: id('X'),
        related_user_id: id('P2'),
        kind: 'guardian'
      })
      .execute()
    try {
      expect(
        (await sweepRsvpReminders(counted, minutes(20), transports)).reminded
      ).equals(1)
      expect(Object.keys(reminders())).deep.equals(['X'])
    } finally {
      await db
        .deleteFrom('user_links')
        .where('id', '=', 'ulk_reminder_X_P2')
        .execute()
    }
    await next(step)

    step = 'once settled again, no roster is read'
    rosterReads = 0
    await sweepRsvpReminders(counted, minutes(25), transports)
    expect(rosterReads).equals(0)
    expect(sent).deep.equals([])
  })

  it('reads no roster for an event owed nobody: a yes that may not answer for it, or one reminded on the row it was merged into', async function () {
    await teamEvent('tev_reminder_owed_nobody', minutes(60))
    // X is on no team; M2's yes is M's, whose roster place is on M2.
    await rsvp('team_event_rsvps', 'tev_reminder_owed_nobody', 'X', 'yes')
    await rsvp('team_event_rsvps', 'tev_reminder_owed_nobody', 'M2', 'yes')
    expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(1)
    expect(Object.keys(reminders())).deep.equals(['M'])
    await next('X, on no team, and M2, merged into M, say yes')

    const executor = db.getExecutor()
    let rosterReads = 0
    const counted = db.withPlugin({
      transformQuery(args) {
        if (
          executor
            .compileQuery(args.node, args.queryId)
            .sql.includes('"memberships"')
        )
          rosterReads++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    step = 'a sweep with nobody owed reads no roster'
    expect(
      (await sweepRsvpReminders(counted, minutes(5), transports)).reminded
    ).equals(0)
    expect(rosterReads).equals(0)
    await next(step)

    step = 'a yes who joins the team is owed, and worked out in full'
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_reminder_X_joins',
        user_id: id('X'),
        team_id: HAWKS,
        role: 'member',
        is_player: false
      })
      .execute()
    try {
      expect(
        (await sweepRsvpReminders(counted, minutes(10), transports)).reminded
      ).equals(1)
      expect(Object.keys(reminders())).deep.equals(['X'])
      expect(rosterReads).greaterThan(0)
    } finally {
      await db
        .deleteFrom('memberships')
        .where('id', '=', 'mem_reminder_X_joins')
        .execute()
    }
    await next(step)

    step = 'a disabled yes is owed nothing'
    await rsvp('team_event_rsvps', 'tev_reminder_owed_nobody', 'C', 'yes')
    await db
      .updateTable('users')
      .set({ disabled_at: minutes(-60) })
      .where('id', '=', id('C'))
      .execute()
    try {
      rosterReads = 0
      expect(
        (await sweepRsvpReminders(counted, minutes(15), transports)).reminded
      ).equals(0)
      expect(rosterReads).equals(0)
    } finally {
      await db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', id('C'))
        .execute()
    }
    await next(step)

    step = 'and once their account is back, they are'
    expect(
      (await sweepRsvpReminders(counted, minutes(20), transports)).reminded
    ).equals(1)
    expect(Object.keys(reminders())).deep.equals(['C'])
  })

  it('forgets the reminders of starts more than a week gone, on each sweep', async function () {
    const kept = (days: number): Date =>
      new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
    await db
      .insertInto('push_reminders_sent')
      .values([
        {
          event_kind: 'game',
          event_id: 'gam_reminder_long_gone',
          user_id: id('P1'),
          start_at: kept(8)
        },
        {
          event_kind: 'teamEvent',
          event_id: 'tev_reminder_last_week',
          user_id: id('P1'),
          start_at: kept(6)
        }
      ])
      .execute()
    expect(await pruneReminders(db, NOW)).equals(1)
    await db
      .insertInto('push_reminders_sent')
      .values({
        event_kind: 'game',
        event_id: 'gam_reminder_long_gone',
        user_id: id('P2'),
        start_at: kept(8)
      })
      .execute()
    await queueReminders(db, NOW, pushQueue, () => undefined)
    expect(
      (
        await db.selectFrom('push_reminders_sent').select('event_id').execute()
      ).map(row => row.event_id)
    ).deep.equals(['tev_reminder_last_week'])
    expect(REMINDERS_KEPT_MS).equals(7 * 24 * 60 * 60 * 1000)
  })

  it('works out in full a yes given on a row merged into another', async function () {
    await teamEvent('tev_reminder_merged_yes', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_merged_yes', 'M2', 'yes')
    expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(1)
    expect(Object.keys(reminders())).deep.equals(['M'])
    await next(step ?? 'a yes on a merged row reminds the open row')
    step = 'and once reminded, sends nothing more'
    expect(
      (await sweepRsvpReminders(db, minutes(5), transports)).reminded
    ).equals(0)
  })

  it('reminds the guardian, on the open row, of a player whose yes is on a closed row', async function () {
    await teamEvent('tev_reminder_closed_yes', minutes(60))
    await rsvp('team_event_rsvps', 'tev_reminder_closed_yes', 'M2', 'yes')
    expect((await sweepRsvpReminders(db, NOW, transports)).reminded).equals(1)
    expect(Object.keys(reminders())).deep.equals(['M'])
    await next('M2, merged into M, says yes; M has no guardian')

    // X becomes the guardian of M, the row M2 was merged into.
    step = 'a guardian linked to the open row is reminded, though M is'
    await db
      .insertInto('user_links')
      .values({
        id: 'ulk_reminder_X_M',
        user_id: id('X'),
        related_user_id: id('M'),
        kind: 'guardian'
      })
      .execute()
    try {
      expect(
        (await sweepRsvpReminders(db, minutes(5), transports)).reminded
      ).equals(1)
      expect(reminders()).to.have.keys(['X'])
    } finally {
      await db
        .deleteFrom('user_links')
        .where('id', '=', 'ulk_reminder_X_M')
        .execute()
    }
  })
})
