import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { HarnessContext } from '../../core/spec'
import {
  type BroadcastStatus,
  stackApi,
  stackControl,
  stackMedia,
  untilBroadcast
} from './stackSpace'

describe('the stack’s media actions', function () {
  it('sends each action to the remux route and answers what it said', async function () {
    const sent: unknown[] = []
    const answers: Record<string, unknown> = {
      programme: { path: '/p.mp4', bytes: 3 },
      'single-file': { videoId: 'vid_1' },
      segment: { output: 'done\n' },
      objects: { objects: [{ key: 'videos/a', size: 1 }] },
      play: { eventId: 'evt_1' },
      machine: { vcpus: 2, memGiB: 4 },
      take: { path: '/t.mp4', bytes: 9, streams: ['video/h264'], firstDts: 0 },
      broadcast: { id: 'bc1', t0: 5, events: [], exit: null },
      'broadcast-status': { events: [], exit: null },
      'broadcast-stop': { events: [], exit: 143 },
      'ingest-files': { live: {}, names: [], master: '' }
    }
    const media = stackMedia({
      remux: async body => {
        sent.push(body)
        return answers[(body as { action: string }).action]
      }
    })
    expect(await media.programme({ seconds: 1, path: '/p.mp4' })).deep.equals(
      answers.programme
    )
    expect(
      await media.singleFile({
        videoId: 'vid_1',
        gameId: 'gam_1',
        title: 't',
        startAt: 'now',
        seconds: 1
      })
    ).deep.equals({ videoId: 'vid_1' })
    expect(await media.segment(['--all'])).equals('done\n')
    expect(await media.objects('videos/')).deep.equals([
      { key: 'videos/a', size: 1 }
    ])
    expect(
      await media.play({
        gameId: 'g',
        battingTeamId: 't',
        videoId: 'v',
        secondsIn: 1,
        atBatIndex: 0
      })
    ).equals('evt_1')
    expect(await media.machine()).deep.equals({ vcpus: 2, memGiB: 4 })
    expect(await media.take({ seconds: 2, path: '/t.mp4' })).deep.equals(
      answers.take
    )
    expect(
      await media.broadcast({ url: 'rtmp://x/live/k', duration: 9 })
    ).deep.equals(answers.broadcast)
    expect(await media.broadcastStatus('bc1')).deep.equals({
      events: [],
      exit: null
    })
    expect((await media.broadcastStop('bc1')).exit).equals(143)
    expect((await media.ingestFiles('vid_1')).names).deep.equals([])
    expect(sent.slice(-5)).deep.equals([
      { action: 'take', seconds: 2, path: '/t.mp4' },
      { action: 'broadcast', url: 'rtmp://x/live/k', duration: 9 },
      { action: 'broadcast-status', id: 'bc1' },
      { action: 'broadcast-stop', id: 'bc1' },
      { action: 'ingest-files', videoId: 'vid_1' }
    ])
  })

  it('blocks a stack with no control routes, and names its API', function () {
    const ctx = { stack: { origin: 'https://e2e.example.test/' } }
    expect(() => stackControl(ctx as unknown as HarnessContext)).throws(
      BlockedError,
      'no control routes'
    )
    const control = { remux: async () => null }
    expect(
      stackControl({
        stack: { ...ctx.stack, control }
      } as unknown as HarnessContext)
    ).equals(control)
    expect(stackApi(ctx as unknown as HarnessContext)).equals(
      'https://e2e.example.test/api/v1'
    )
  })
})

describe('waiting on a broadcast', function () {
  const media = (
    statuses: BroadcastStatus[]
  ): { broadcastStatus: () => Promise<BroadcastStatus> } => ({
    broadcastStatus: async () =>
      statuses.length > 1 ? statuses.shift()! : statuses[0]
  })
  const publishing: BroadcastStatus = {
    events: [{ at: 1, event: 'publish' }],
    exit: null
  }

  it('answers the first status that is done', async function () {
    const done = await untilBroadcast(
      media([{ events: [], exit: null }, publishing]),
      'bc1',
      'the publish',
      status => status.events.some(one => one.event === 'publish'),
      { everyMs: 1 }
    )
    expect(done).equals(publishing)
  })

  it('names a broadcast that ended first, and one that never gets there', async function () {
    try {
      await untilBroadcast(
        media([{ events: [{ at: 1, event: 'stopped' }], exit: 1 }]),
        'bc1',
        'the publish',
        () => false
      )
      expect.fail('expected the end to be named')
    } catch (error) {
      expect((error as Error).message)
        .contains('ended (exit 1) before the publish')
        .and.contains('stopped')
    }
    try {
      await untilBroadcast(
        media([{ events: [], exit: null }]),
        'bc1',
        'the publish',
        () => false,
        { timeoutMs: 5, everyMs: 2 }
      )
      expect.fail('expected a timeout')
    } catch (error) {
      expect((error as Error).message).equals(
        'timed out waiting for the publish'
      )
    }
  })
})
