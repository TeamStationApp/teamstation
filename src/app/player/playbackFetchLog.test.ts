import { expect } from 'chai'
import { describe, it } from 'mocha'

import type {
  EventName,
  Level,
  Property
} from '../../common/observability/contract'
import { loggedFetch, playbackOutcome, startFetchLog } from './playbackFetchLog'

function recorder(): {
  sent: Array<{
    event: EventName
    properties: Record<string, Property>
    level?: Level
  }>
  emit: (
    event: EventName,
    properties: Record<string, Property>,
    level?: Level
  ) => void
} {
  const sent: Array<{
    event: EventName
    properties: Record<string, Property>
    level?: Level
  }> = []
  return {
    sent,
    emit: (event, properties, level) => {
      sent.push({ event, properties, level })
    }
  }
}

function clock(...times: number[]): () => number {
  let index = 0
  return () => times[Math.min(index++, times.length - 1)]
}

describe('playback fetch log', () => {
  it('classifies a playback answer', () => {
    expect(playbackOutcome({ url: 'https://x' })).equals('ok')
    expect(playbackOutcome({ url: null, pending: true })).equals('pending')
    expect(playbackOutcome({ url: null })).equals('unavailable')
  })

  it('reports how long an answered ask took and what it amounted to', async () => {
    const { sent, emit } = recorder()
    const answer = { url: null, pending: true }
    const got = await loggedFetch(
      {
        kind: 'playback',
        surface: 'game',
        videoId: 'vid_demo',
        attempt: 3,
        retryDelayMs: 2000
      },
      async () => answer,
      playbackOutcome,
      undefined,
      emit,
      clock(1000, 1250)
    )
    expect(got).equals(answer)
    expect(sent).deep.equals([
      {
        event: 'playback_fetch',
        properties: {
          fk: 'playback',
          sf: 'game',
          ms: 250,
          vi: 'vid_demo',
          at: 3,
          rd: 2000,
          oc: 'pending'
        },
        level: 'info'
      }
    ])
  })

  it('counts a list, and leaves out an id that is not a video id', async () => {
    const { sent, emit } = recorder()
    await loggedFetch(
      { kind: 'live_now', surface: 'card', videoId: 'https://x/videos' },
      async () => [1, 2],
      () => 'ok',
      found => found.length,
      emit,
      clock(0, 40)
    )
    expect(sent[0].properties).deep.equals({
      fk: 'live_now',
      sf: 'card',
      ms: 40,
      oc: 'ok',
      n: 2
    })
  })

  it('leaves out an answer its caller does not think worth saying, never a failure', async () => {
    const { sent, emit } = recorder()
    const seen: Array<[string, number | undefined, number]> = []
    const quiet = {
      kind: 'live_now' as const,
      surface: 'card' as const,
      worthSaying: (outcome: string, count: number | undefined, ms: number) => {
        seen.push([outcome, count, ms])
        return count === 3
      }
    }
    await loggedFetch(
      quiet,
      async () => [1, 2],
      () => 'ok',
      found => found.length,
      emit,
      clock(0, 10)
    )
    await loggedFetch(
      quiet,
      async () => [1, 2, 3],
      () => 'ok',
      found => found.length,
      emit,
      clock(0, 20)
    )
    await loggedFetch(
      quiet,
      async () => {
        throw Object.assign(new Error('down'), { status: 503 })
      },
      () => 'ok',
      undefined,
      emit,
      clock(0, 30)
    ).catch(() => undefined)
    expect(seen).deep.equals([
      ['ok', 2, 10],
      ['ok', 3, 20]
    ])
    expect(
      sent.map(row => [
        row.properties.oc,
        row.properties.n ?? row.properties.status
      ])
    ).deep.equals([
      ['ok', 3],
      ['error', 503]
    ])
    // A judge that throws does not stop the answer being said.
    await loggedFetch(
      {
        ...quiet,
        worthSaying: () => {
          throw new Error('judge')
        }
      },
      async () => [1],
      () => 'ok',
      found => found.length,
      emit,
      clock(0, 5)
    )
    expect(sent.at(-1)?.properties).deep.include({ oc: 'ok', n: 1 })
  })

  it('reports a refusal by its status and a lost line as offline, then rethrows', async () => {
    const { sent, emit } = recorder()
    const refusal = Object.assign(new Error('nope'), { status: 503 })
    let caught: unknown
    await loggedFetch(
      { kind: 'playback', surface: 'card' },
      async () => {
        throw refusal
      },
      playbackOutcome,
      undefined,
      emit,
      clock(0, 9)
    ).catch((error: unknown) => {
      caught = error
    })
    expect(caught).equals(refusal)
    await loggedFetch(
      { kind: 'playback', surface: 'card' },
      async () => {
        throw new TypeError('Failed to fetch')
      },
      playbackOutcome,
      undefined,
      emit,
      clock(0, 9)
    ).catch(() => undefined)
    await loggedFetch(
      { kind: 'playback', surface: 'card' },
      async () => {
        throw Object.assign(new Error('odd'), { status: 42 })
      },
      playbackOutcome,
      undefined,
      emit,
      clock(0, 9)
    ).catch(() => undefined)
    expect(
      sent.map(row => [row.properties.oc, row.properties.status, row.level])
    ).deep.equals([
      ['error', 503, 'warn'],
      ['offline', undefined, 'warn'],
      ['offline', undefined, 'warn']
    ])
  })

  it('keeps the answer when classifying or reporting fails', async () => {
    const got = await loggedFetch(
      { kind: 'playback', surface: 'game' },
      async () => 'answer',
      () => {
        throw new Error('bad classifier')
      },
      () => {
        throw new Error('bad count')
      },
      () => {
        throw new Error('queue full')
      }
    )
    expect(got).equals('answer')
  })

  it('reports a timed request once, from the caller’s own handlers', () => {
    const { sent, emit } = recorder()
    const log = startFetchLog(
      { kind: 'playback', surface: 'game', attempt: 0 },
      emit,
      clock(5, 30)
    )
    log.answered('unavailable', Number.NaN)
    log.failed(new Error('late'))
    expect(sent).length(1)
    expect(sent[0].properties).deep.equals({
      fk: 'playback',
      sf: 'game',
      ms: 25,
      at: 0,
      oc: 'unavailable'
    })
  })
})
