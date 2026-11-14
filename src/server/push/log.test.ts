import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import { logTransport, type PushLogRecord, withLog } from './log'
import type {
  PushAddress,
  PushMessage,
  PushResult,
  PushTransport
} from './send'

describe('the push log transport', function () {
  const dir = mkdtempSync(join(tmpdir(), 'ts-push-log-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const at = new Date('2026-11-12T08:00:00.000Z')
  const web: PushAddress = {
    id: 'psh_web',
    userId: 'usr_one',
    platform: 'web',
    address: JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'BPublic', auth: 'secret' }
    }),
    environment: 'production'
  }
  const phone: PushAddress = {
    id: 'psh_ios',
    userId: 'usr_two',
    platform: 'ios',
    address: '00ab'.repeat(16),
    environment: 'development'
  }
  const read = (file: string): PushLogRecord[] =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as PushLogRecord)

  it('writes one line per message with everything needed to deliver it', async function () {
    const file = join(dir, 'nested', 'push.jsonl')
    const log = logTransport(file, () => at)
    const results = await Promise.all([
      log.send(web, {
        platform: 'web',
        payload: '{"t":"chat"}',
        urgency: 'high'
      }),
      log.send(phone, {
        platform: 'ios',
        pushType: 'alert',
        priority: 10,
        payload: { aps: { alert: { body: 'Hi' } } }
      }),
      log.send(web, { platform: 'web', payload: 'third' })
    ])
    expect(results).deep.equals([
      { status: 'sent' },
      { status: 'sent' },
      { status: 'sent' }
    ])
    expect(read(file)).deep.equals([
      {
        at: '2026-11-12T08:00:00.000Z',
        registrationId: 'psh_web',
        userId: 'usr_one',
        platform: 'web',
        environment: 'production',
        address: web.address,
        message: { platform: 'web', payload: '{"t":"chat"}', urgency: 'high' }
      },
      {
        at: '2026-11-12T08:00:00.000Z',
        registrationId: 'psh_ios',
        userId: 'usr_two',
        platform: 'ios',
        environment: 'development',
        address: phone.address,
        message: {
          platform: 'ios',
          pushType: 'alert',
          priority: 10,
          payload: { aps: { alert: { body: 'Hi' } } }
        }
      },
      {
        at: '2026-11-12T08:00:00.000Z',
        registrationId: 'psh_web',
        userId: 'usr_one',
        platform: 'web',
        environment: 'production',
        address: web.address,
        message: { platform: 'web', payload: 'third' }
      }
    ])
  })

  it('answers a failure when it cannot write, and goes on writing after', async function () {
    // The directory itself is no file to append to.
    const blocked = logTransport(dir)
    const failed = await blocked.send(web, { platform: 'web', payload: 'x' })
    expect(failed.status).equals('failed')
    expect(
      (await blocked.send(web, { platform: 'web', payload: 'y' })).status
    ).equals('failed')
    const file = join(dir, 'after.jsonl')
    const log = logTransport(file)
    expect(await log.send(web, { platform: 'web', payload: 'z' })).deep.equals({
      status: 'sent'
    })
    expect(read(file)[0].message).deep.equals({ platform: 'web', payload: 'z' })
  })

  it('logs every platform, then lets the real service answer where there is one', async function () {
    const logged: string[] = []
    const log: PushTransport<PushMessage> = {
      send: async to => {
        logged.push(to.id)
        return { status: 'sent' }
      }
    }
    const gone: PushResult = { status: 'gone', reason: 'HTTP 410' }
    const sentTo: string[] = []
    const transports = withLog(log, {
      web: {
        send: async to => {
          sentTo.push(to.id)
          return gone
        }
      }
    })
    expect(
      await transports.web!.send(web, { platform: 'web', payload: 'x' })
    ).deep.equals(gone)
    expect(
      await transports.ios!.send(phone, {
        platform: 'ios',
        pushType: 'background',
        priority: 5,
        payload: {}
      })
    ).deep.equals({ status: 'sent' })
    expect(
      await transports.android!.send(
        { ...phone, platform: 'android' },
        { platform: 'android', priority: 'normal', data: {} }
      )
    ).deep.equals({ status: 'sent' })
    expect(logged).deep.equals(['psh_web', 'psh_ios', 'psh_ios'])
    expect(sentTo).deep.equals(['psh_web'])
  })
})
