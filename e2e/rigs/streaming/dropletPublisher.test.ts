import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { StreamingHandle } from '../../core/streamingStack'
import { DropletPublisher, requirePublisher } from './dropletPublisher'

const ROUTE = { url: 'https://pub.example.test/__e2e/publishers/', token: 'pt' }

function urlFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'droplet-publisher-')), 'url')
  writeFileSync(file, 'rtmp://h:1936/live/key-a\n', { mode: 0o600 })
  return file
}

function fakeFetch(answers: Array<{ status: number; body: unknown }>): {
  fetchFn: typeof fetch
  calls: Array<{ url: string; method: string; body: unknown; auth: string }>
} {
  const calls: Array<{
    url: string
    method: string
    body: unknown
    auth: string
  }> = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init.headers as Record<string, string>).authorization
    })
    const answer = answers.shift() ?? { status: 200, body: {} }
    return {
      ok: answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.body === 'not json') throw new Error('not json')
        return answer.body
      }
    }
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

describe('a camera on the publisher droplet', function () {
  it('is started with the RTMP URL from its file, and knows its clock from the answer', async function () {
    const { fetchFn, calls } = fakeFetch([
      {
        status: 200,
        body: { state: 'live', startedAtMs: 1000, loopMs: 1_800_033 }
      }
    ])
    const camera = new DropletPublisher(
      { publisher: ROUTE, label: 'SynthA', urlFile: urlFile() },
      fetchFn
    )
    expect(camera.clockBase()).equals(undefined)
    await camera.start()
    expect(calls).deep.equals([
      {
        url: 'https://pub.example.test/__e2e/publishers/SynthA',
        method: 'PUT',
        body: { url: 'rtmp://h:1936/live/key-a' },
        auth: 'Bearer pt'
      }
    ])
    expect(camera.clockBase()).deep.equals({
      startedAtMs: 1000,
      loopMs: 1_800_033
    })
  })

  it('is cut and stopped through its routes', async function () {
    const { fetchFn, calls } = fakeFetch([])
    const camera = new DropletPublisher(
      { publisher: ROUTE, label: 'SynthB', urlFile: urlFile() },
      fetchFn
    )
    await camera.cut(45)
    await camera.cut(20, { discontinuity: true })
    await camera.stop()
    expect(
      calls.map(c => [c.method, c.url.replace(ROUTE.url, ''), c.body])
    ).deep.equals([
      ['POST', 'SynthB/cut', { seconds: 45, discontinuity: false }],
      ['POST', 'SynthB/cut', { seconds: 20, discontinuity: true }],
      ['DELETE', 'SynthB', undefined]
    ])
  })

  it('reports a route that fails as the camera failing', async function () {
    const { fetchFn } = fakeFetch([
      {
        status: 502,
        body: { error: 'the SynthC camera is down: the ingest refused it' }
      },
      { status: 500, body: 'not json' }
    ])
    const camera = new DropletPublisher(
      { publisher: ROUTE, label: 'SynthC', urlFile: urlFile() },
      fetchFn
    )
    let failure = ''
    await camera.cut(1).catch((error: unknown) => {
      failure = (error as Error).message
    })
    expect(failure).equals(
      'the publisher droplet answered POST SynthC with 502: the SynthC camera is down: the ingest refused it'
    )
    await camera.stop().catch((error: unknown) => {
      failure = (error as Error).message
    })
    expect(failure).equals(
      'the publisher droplet answered DELETE SynthC with 500'
    )
  })

  it('needs a stack with a publisher droplet', function () {
    const handle = {
      id: 'e2e-stack-1',
      publisher: ROUTE
    } as unknown as StreamingHandle
    expect(requirePublisher(handle)).equals(ROUTE)
    const without = { id: 'e2e-stack-2' } as unknown as StreamingHandle
    expect(() => requirePublisher(without))
      .throws(BlockedError)
      .with.property('message')
      .that.includes('stack "e2e-stack-2" has no publisher droplet')
  })
})
