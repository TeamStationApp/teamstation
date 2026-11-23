import { expect } from 'chai'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from 'kysely'
import { describe, it } from 'mocha'

import type { Database } from '../db/database'
import {
  limited,
  liveRegistration,
  type PushAddress,
  type PushMessage,
  type PushResult,
  type PushTransport,
  sendToDevices
} from './send'

/**
 * What sending does with each answer a service gives, and how many sends a
 * transport has under way at once. Nothing here reaches the database: no
 * address is found gone.
 */

const device = (id: string, userId: string): PushAddress => ({
  id,
  userId,
  platform: 'android',
  address: `token-${id}`,
  environment: 'production'
})
const wake: PushMessage = {
  platform: 'android',
  priority: 'high',
  data: { payload: '{}' }
}
const noDatabase = null as unknown as Kysely<Database>

describe('a live registration', function () {
  /** Compiles SQL without a database. */
  const compiler = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: db => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  })
  const text = (wants: Parameters<typeof liveRegistration>[0]): string =>
    liveRegistration(wants).compile(compiler).sql

  it('needs the switch the push is for on, League management among them', function () {
    expect(text('league_management')).contains(
      '"push_registrations"."league_management"'
    )
    expect(text('league_management')).not.contains('"messages"')
    expect(text('league_management')).not.contains('"rsvp_events"')
    expect(text('rsvp_events')).contains('"push_registrations"."rsvp_events"')
    expect(text('rsvp_events')).not.contains('league_management')
    expect(text('messages')).not.contains('league_management')
    // A read's clear asks for none of them.
    expect(text(null)).not.contains('league_management')
  })
})

describe('sending to devices', function () {
  it('counts unsent whoever no device was sent to, a device skipped as much as one failed', async function () {
    const phone = (id: string, userId: string): PushAddress => ({
      ...device(id, userId),
      platform: 'ios'
    })
    const report = await sendToDevices(
      noDatabase,
      [
        // No APNs transport: skipped.
        phone('psh_skipped', 'usr_skipped'),
        // Skipped on one device, reached on another.
        phone('psh_also_skipped', 'usr_reached'),
        device('psh_sent', 'usr_reached'),
        // Skipped and failed.
        phone('psh_skipped_too', 'usr_failing'),
        device('psh_failed', 'usr_failing'),
        // Nothing to send this device.
        device('psh_quiet', 'usr_quiet')
      ],
      to => (to.id === 'psh_quiet' ? null : wake),
      {
        android: {
          send: async to =>
            to.id === 'psh_failed'
              ? { status: 'failed', reason: 'HTTP 503' }
              : { status: 'sent' }
        }
      },
      () => undefined
    )
    expect(report).deep.include({ sent: 1, skipped: 4, failed: 1 })
    expect(report.unreached).deep.equals(['usr_failing'])
    expect(report.unsent).deep.equals([
      'usr_failing',
      'usr_quiet',
      'usr_skipped'
    ])
  })

  it('tries again only whom a failure kept it from, never whom a service refused for good', async function () {
    const answers: Record<string, PushResult> = {
      psh_sent: { status: 'sent' },
      psh_refused: { status: 'rejected', reason: 'SENDER_ID_MISMATCH' },
      psh_failed: { status: 'failed', reason: 'HTTP 503' },
      psh_refused_too: { status: 'rejected', reason: 'INVALID_ARGUMENT' },
      psh_topic: { status: 'refused', reason: 'BadTopic' }
    }
    const said: string[] = []
    // Where a refusal marks its registration: psh_refused's mark fails.
    const marked: string[] = []
    const marking = {
      updateTable: () => {
        let id = ''
        const query = {
          set: () => query,
          where: (column: string, _op: string, value: string) => {
            if (column === 'id') id = value
            return query
          },
          execute: async () => {
            if (id === 'psh_refused') throw new Error('the database is away')
            marked.push(id)
            return []
          }
        }
        return query
      }
    } as unknown as Kysely<Database>
    const report = await sendToDevices(
      marking,
      [
        device('psh_sent', 'usr_reached'),
        device('psh_refused', 'usr_refused'),
        device('psh_failed', 'usr_failing'),
        device('psh_refused_too', 'usr_failing'),
        // The message refused, not the token: neither marked nor tried again.
        device('psh_topic', 'usr_topic')
      ],
      () => wake,
      { android: { send: async to => answers[to.id] } },
      line => said.push(line)
    )
    expect(report).deep.equals({
      sent: 1,
      skipped: 0,
      failed: 2,
      rejected: 2,
      removed: 0,
      // Refused on one device for good, failed on another: worth a try.
      unreached: ['usr_failing'],
      unsent: ['usr_failing']
    })
    expect(said.sort()).deep.equals([
      'push: android psh_failed failed: HTTP 503',
      'push: android psh_refused rejected: SENDER_ID_MISMATCH',
      'push: android psh_refused_too rejected: INVALID_ARGUMENT',
      'push: android psh_topic refused: BadTopic',
      // A mark that fails is said, and the send still counts as refused.
      'push: marking psh_refused rejected failed: Error: the database is away'
    ])
    expect(marked).deep.equals(['psh_refused_too'])
  })

  it('has no more than its limit of sends under way at once, and sends them all', async function () {
    let running = 0
    let most = 0
    const slow: PushTransport<PushMessage> = {
      send: async () => {
        running++
        most = Math.max(most, running)
        await new Promise(resolve => setTimeout(resolve, 5))
        running--
        return { status: 'sent' }
      }
    }
    const devices = Array.from({ length: 20 }, (_, index) =>
      device(`psh_${index}`, `usr_${index}`)
    )
    const report = await sendToDevices(noDatabase, devices, () => wake, {
      android: limited(slow, 3)
    })
    expect(report.sent).equals(20)
    expect(most).equals(3)
    expect(running).equals(0)
  })

  it('gives a failed send’s place to the next', async function () {
    let calls = 0
    const throwing = limited<PushMessage>(
      {
        send: async () => {
          calls++
          await new Promise(resolve => setTimeout(resolve, 1))
          throw new Error('the transport broke')
        }
      },
      1
    )
    const results = await Promise.allSettled(
      [1, 2, 3].map(
        async index =>
          await throwing.send(device(`psh_${index}`, 'usr_one'), wake)
      )
    )
    expect(results.map(result => result.status)).deep.equals([
      'rejected',
      'rejected',
      'rejected'
    ])
    expect(calls).equals(3)
  })
})
