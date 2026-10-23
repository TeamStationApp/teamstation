import { expect } from 'chai'

import { AnalyticsClient } from './analyticsClient'
import type { EventRecord } from './contract'
import { WatchClock } from './watch'

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
describe('Explicit analytics delivery', () => {
  it('keeps anonymous events credential-free, partitions identities and rejects unsafe properties', async () => {
    const storage = new Map<string, string>()
    const sent: Array<{ rows: EventRecord[]; options: RequestInit }> = []
    let n = 0
    let time = 1000
    const analytics = new AnalyticsClient({
      endpoint: 'https://example.com/api/analytics/events',
      app: 'TS',
      version: '1',
      id: () => uuid(++n),
      monotonic: () => time,
      storage: {
        getItem: async key => storage.get(key) ?? null,
        setItem: async (key, value) => {
          storage.set(key, value)
        }
      },
      request: (async (_url, options: RequestInit) => {
        sent.push({ rows: JSON.parse(options.body as string), options })
        return { status: 202 }
      }) as typeof fetch
    })
    await analytics.emit('login_started', { mt: 'email_code' })
    analytics.navigate('account')
    await analytics.emit('login_failed', { mt: 'email_code', ec: 'invalid' })
    await analytics.emit('app_error')
    await analytics.emit('account_created')
    await analytics.emit('signup_started', { text: 'private-canary' })
    await analytics.flush()
    expect(sent[0].options.credentials).equals('omit')
    expect(sent[0].rows.map(r => r.E)).deep.equals([
      'session_started',
      'login_started',
      'login_failed'
    ])
    analytics.identify('user-one', 'synthetic-one')
    await analytics.emit('login_succeeded', { mt: 'email_code' })
    await analytics.flush()
    expect(sent[1].options.credentials).equals('include')
    expect(sent[1].options.headers).includes({
      authorization: 'Bearer synthetic-one'
    })
    analytics.identify('user-one', 'synthetic-one')
    await analytics.emit('upload_started', { vi: 'vid_example' })
    const oldRequest = analytics.capture()
    analytics.identify('user-two', 'synthetic-two')
    oldRequest('event_created', { id: 'gam_stale' })
    analytics.capture()('event_created', { id: 'gam_current' })
    analytics.identify('user-one', 'synthetic-one')
    await analytics.emit('login_succeeded', { mt: 'password' })
    analytics.navigate('home')
    analytics.navigate('home')
    time += 1000
    analytics.navigate('private-route-canary')
    analytics.navigate('chat')
    analytics.foreground(false)
    analytics.foreground(false)
    analytics.foreground(true)
    await analytics.flush()
    expect(JSON.stringify(sent)).not.contains('upload_started')
    expect(JSON.stringify(sent)).not.contains('gam_stale')
    expect(JSON.stringify(sent)).not.contains('canary')
    expect(
      sent
        .flatMap(x => x.rows)
        .filter(r => r.E === 'page_viewed')
        .map(r => r.P.pg)
    ).deep.equals(['home', 'other'])
    analytics.identify()
    await analytics.emit('login_failed', { ec: 'offline' })
    await analytics.close()
    await analytics.close()
    analytics.identify('ignored')
    analytics.foreground(false)
    await analytics.emit('login_started')
    expect(sent.at(-1)!.options.credentials).equals('omit')
    expect(
      [...storage.entries()]
        .filter(([key]) => key.endsWith('user-one'))
        .every(([, value]) => value === '[]')
    ).equals(true)
  })
})

describe('Active video watch time', () => {
  it('counts selected foreground playback using monotonic time, excludes pauses, buffers and seeks', () => {
    let time = 0
    const rows: Array<{ event: string; ms?: number }> = []
    const clock = new WatchClock(
      'vid_example',
      uuid(1),
      (event, p) => {
        rows.push({ event, ms: p.ms as number | undefined })
      },
      () => time
    )
    clock.update({ playing: true })
    time = 20000
    clock.update({ playing: false })
    time += 5000
    clock.seek(500)
    clock.update({ playing: true })
    time += 1000
    clock.update({ buffering: true })
    time += 5000
    clock.update({ buffering: false })
    time += 1000
    clock.update({ foreground: false })
    time += 5000
    clock.update({ foreground: true, rate: -1 })
    time += 1000
    clock.update({ selected: false })
    time += 5000
    clock.close(true)
    clock.close()
    clock.update({ playing: true })
    clock.seek(1)
    clock.flush()
    expect(
      rows
        .filter(r => r.event === 'watch_progress')
        .reduce((sum, r) => sum + r.ms!, 0)
    ).equals(23000)
    expect(rows.filter(r => r.ms != null).every(r => r.ms! <= 15000)).equals(
      true
    )
    expect(rows.filter(r => r.event === 'video_started')).length(1)
    expect(rows.at(-1)!.event).equals('video_completed')
  })
  it('ignores hidden previews and isolates observer failures', () => {
    let time = 0
    const events: string[] = []
    const clock = new WatchClock(
      'vid_example',
      uuid(2),
      e => {
        events.push(e)
        throw new Error('observer failure')
      },
      () => time
    )
    clock.update({ selected: false, playing: true })
    time += 5000
    clock.close()
    expect(events).deep.equals([])
    const visible = new WatchClock(
      'vid_example',
      uuid(3),
      () => {
        throw new Error('observer failure')
      },
      () => time
    )
    visible.update({ playing: true })
    time += 1000
    visible.close()
  })
})
