import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatWake } from '../../common/push'
import { readMessage } from './chatReads'
import {
  ANDROID_WAKE_TTL_SECONDS,
  expiresAfter,
  IOS_ALERT_WAKE_SECONDS,
  IOS_BACKGROUND_WAKE_SECONDS,
  STALE_WAKE_MS,
  wakeMessage,
  WEB_WAKE_TTL_SECONDS
} from './chatWakes'
import type { PushAddress } from './send'

const phone: PushAddress = {
  id: 'psh_one',
  userId: 'usr_reader',
  platform: 'android',
  address: `android-${'0'.repeat(32)}`,
  environment: 'production'
}

const wake = (dm: boolean): ChatWake => ({
  t: 'chat',
  u: 'usr_reader',
  c: 'cnv_one',
  seq: 4,
  dm,
  from: 'Mookie Betts',
  title: dm ? null : 'Hawks Members',
  url: 'teamstation://chat/cnv_one'
})

describe('wakeMessage on Android', function () {
  it('keeps a wake 8 hours, past a night of Doze and well short of four weeks', function () {
    expect(ANDROID_WAKE_TTL_SECONDS).equals(28_800)
    expect(ANDROID_WAKE_TTL_SECONDS).lessThanOrEqual(24 * 60 * 60)
  })

  it('sends a DM at high priority, kept 8 hours, never collapsed', function () {
    expect(wakeMessage(phone, wake(true), false)).deep.equals({
      platform: 'android',
      priority: 'high',
      ttlSeconds: ANDROID_WAKE_TTL_SECONDS,
      data: { payload: JSON.stringify(wake(true)) }
    })
  })

  it('sends a group wake at normal priority, kept 8 hours, never collapsed', function () {
    const message = wakeMessage(phone, wake(false), false)
    expect(message).deep.equals({
      platform: 'android',
      priority: 'normal',
      ttlSeconds: ANDROID_WAKE_TTL_SECONDS,
      data: { payload: JSON.stringify(wake(false)) }
    })
    // A later plain message must never replace a mention's wake.
    expect(message).not.to.have.property('collapseKey')
  })
})

const iphone: PushAddress = {
  id: 'psh_three',
  userId: 'usr_reader',
  platform: 'ios',
  address: '00ab'.repeat(16),
  environment: 'production'
}
const NOW = new Date('2026-11-13T20:00:00.500Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

describe('wakeMessage and readMessage on iOS', function () {
  it('keeps an alert an hour, as on the web, and a background wake 8 hours, as on Android', function () {
    expect(IOS_ALERT_WAKE_SECONDS).equals(WEB_WAKE_TTL_SECONDS)
    expect(IOS_BACKGROUND_WAKE_SECONDS).equals(ANDROID_WAKE_TTL_SECONDS)
    expect(wakeMessage(iphone, wake(true), false, NOW)).to.include({
      pushType: 'alert',
      priority: 10,
      expiration: NOW_SECONDS + 3_600
    })
    // A group message with iosFiltering is an alert too.
    expect(wakeMessage(iphone, wake(false), true, NOW)).to.include({
      pushType: 'alert',
      expiration: NOW_SECONDS + 3_600
    })
    expect(wakeMessage(iphone, wake(false), false, NOW)).to.include({
      pushType: 'background',
      priority: 5,
      expiration: NOW_SECONDS + 28_800
    })
  })

  it('keeps a read 8 hours, past the alert it takes down', function () {
    const read = { t: 'read' as const, u: 'usr_reader', c: 'cnv_one', seq: 4 }
    expect(readMessage(iphone, read, NOW)).deep.equals({
      platform: 'ios',
      pushType: 'background',
      priority: 5,
      expiration: NOW_SECONDS + IOS_BACKGROUND_WAKE_SECONDS,
      payload: { aps: { 'content-available': 1 }, ...read }
    })
    expect(IOS_BACKGROUND_WAKE_SECONDS).greaterThan(IOS_ALERT_WAKE_SECONDS)
  })

  it('counts from now when it is not told the time', function () {
    const before = Math.floor(Date.now() / 1000)
    const message = wakeMessage(iphone, wake(true), false) as {
      expiration: number
    }
    expect(message.expiration).within(before + 3_600, before + 3_601)
    expect(expiresAfter(NOW, 0)).equals(NOW_SECONDS)
  })
})

const browser: PushAddress = {
  id: 'psh_two',
  userId: 'usr_reader',
  platform: 'web',
  address: JSON.stringify({
    endpoint: 'https://fcm.googleapis.com/fcm/send/aAAAAAAAAAA:APA91b0000',
    keys: { p256dh: 'p256dh', auth: 'auth' }
  }),
  environment: 'production'
}

describe('wakeMessage and readMessage on the web', function () {
  it('keeps a wake an hour, no longer than a post may still wake anybody', function () {
    expect(WEB_WAKE_TTL_SECONDS).equals(3_600)
    expect(WEB_WAKE_TTL_SECONDS * 1000).equals(STALE_WAKE_MS)
    for (const dm of [true, false])
      expect(wakeMessage(browser, wake(dm), false)).deep.equals({
        platform: 'web',
        payload: JSON.stringify(wake(dm)),
        urgency: dm ? 'high' : 'normal',
        ttlSeconds: WEB_WAKE_TTL_SECONDS
      })
  })

  it('keeps a read as long as an Android read, past the wake it takes down', function () {
    const read = { t: 'read' as const, u: 'usr_reader', c: 'cnv_one', seq: 4 }
    expect(readMessage(browser, read)).deep.equals({
      platform: 'web',
      payload: JSON.stringify(read),
      urgency: 'normal',
      ttlSeconds: ANDROID_WAKE_TTL_SECONDS
    })
    expect(readMessage(phone, read)).to.include({
      ttlSeconds: ANDROID_WAKE_TTL_SECONDS
    })
    expect(ANDROID_WAKE_TTL_SECONDS).greaterThan(WEB_WAKE_TTL_SECONDS)
  })
})
