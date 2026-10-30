import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  deleteSpacePrefix,
  listSpaceObjectEntries,
  verifyObjectLength
} from './spacesVideo'

const space = {
  endpoint: 'https://objects.example.test',
  region: 'test',
  bucket: 'test-bucket',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  pathStyle: true
}
const prefix = 'videos/vid_test/'
const entry = (name: string, size = 10): string =>
  `<Contents><Key>${prefix}${name}</Key><Size>${size}</Size><ETag>&quot;abc123&quot;</ETag></Contents>`
const page = (entries: string, token?: string): string =>
  `<ListBucketResult>${entries}<IsTruncated>${token != null}</IsTruncated>${token == null ? '' : `<NextContinuationToken>${token}</NextContinuationToken>`}</ListBucketResult>`
async function rejected(
  action: Promise<unknown>,
  message: string
): Promise<void> {
  try {
    await action
  } catch (error) {
    expect(String(error)).contains(message)
    return
  }
  throw new Error(`Expected rejection containing ${message}`)
}

describe('Space listing and bounded deletion', function () {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reads metadata through escaped continuation tokens', async function () {
    const requests: string[] = []
    globalThis.fetch = async input => {
      requests.push(input instanceof Request ? input.url : String(input))
      return new Response(
        requests.length === 1
          ? page(entry('a&amp;b'), 'next&amp;token')
          : page(entry('c&lt;d&gt;&apos;'))
      )
    }
    expect(await listSpaceObjectEntries(space, prefix)).deep.equals([
      { key: prefix + 'a&b', size: 10, etag: 'abc123' },
      { key: prefix + "c<d>'", size: 10, etag: 'abc123' }
    ])
    expect(new URL(requests[1]).searchParams.get('continuation-token')).equals(
      'next&token'
    )
  })

  it('fails closed on bad, incomplete, escaped or looping listings', async function () {
    for (const [xml, message] of [
      ['not XML', 'Invalid object listing'],
      [
        page('<Contents><Key>anything</Key></Contents>'),
        'Incomplete object listing'
      ],
      [page(entry('a').replace(prefix, 'elsewhere/')), 'escaped its prefix'],
      [page('').replace('false', 'true'), 'continuation']
    ]) {
      globalThis.fetch = async () => new Response(xml)
      await rejected(listSpaceObjectEntries(space, prefix), message)
    }
    globalThis.fetch = async () => new Response(page('', 'same'))
    await rejected(listSpaceObjectEntries(space, prefix), 'continuation')
    let sequence = 0
    globalThis.fetch = async () => new Response(page('', String(sequence++)))
    await rejected(listSpaceObjectEntries(space, prefix), 'fifty pages')
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await rejected(listSpaceObjectEntries(space, prefix), '503')
    await rejected(
      listSpaceObjectEntries({ ...space, bucket: '' }, prefix),
      'No Space'
    )
  })

  it('deletes 2,400 objects in at most 32 concurrent requests across three pages', async function () {
    let active = 0
    let maximum = 0
    let deleted = 0
    const seen = new Set<string>()
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (init?.method !== 'DELETE') {
        const from = Number(url.searchParams.get('continuation-token') ?? 0)
        const end = Math.min(2400, from + 1000)
        return new Response(
          page(
            Array.from({ length: end - from }, (_, i) =>
              entry(`seg${from + i}.m4s`)
            ).join(''),
            end < 2400 ? String(end) : undefined
          )
        )
      }
      active++
      maximum = Math.max(maximum, active)
      expect(seen.has(url.pathname)).equals(false)
      seen.add(url.pathname)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      deleted++
      return new Response(null, { status: deleted % 2 === 0 ? 204 : 404 })
    }
    expect(await deleteSpacePrefix(space, prefix)).deep.equals({
      deleted: 2400
    })
    expect(maximum).equals(32)
    expect(active).equals(0)
  })

  it('drains in-flight deletes before rejecting and does not schedule more', async function () {
    for (const networkFailure of [false, true]) {
      let active = 0
      let called = 0
      globalThis.fetch = async (_input, init) => {
        if (init?.method !== 'DELETE')
          return new Response(
            page(
              Array.from({ length: 50 }, (_, i) => entry(String(i))).join('')
            )
          )
        const n = called++
        active++
        await new Promise(resolve => setTimeout(resolve, n === 0 ? 1 : 10))
        active--
        if (n === 0 && networkFailure) throw new Error('connection lost')
        return new Response(null, { status: n === 0 ? 503 : 204 })
      }
      await rejected(
        deleteSpacePrefix(space, prefix),
        networkFailure ? 'connection lost' : '503'
      )
      expect(active).equals(0)
      expect(called).equals(32)
      globalThis.fetch = originalFetch
    }
  })

  it('releases every one-byte verification response, including ignored ranges', async function () {
    for (const [status, range, ok] of [
      [206, 'bytes 0-0/10', true],
      [206, 'bytes 0-0/9', false],
      [206, '', false],
      [200, 'bytes 0-0/10', false],
      [403, '', false]
    ] as const) {
      let cancelled = false
      const response = new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          }
        }),
        { status, headers: { 'content-range': range } }
      )
      const result = await verifyObjectLength({
        space,
        key: prefix + 'init.mp4',
        size: 10,
        fetch: async (_url, init) => {
          expect(init?.headers).deep.equals({ range: 'bytes=0-0' })
          return response
        }
      })
      expect(result.ok).equals(ok)
      expect(cancelled).equals(true)
    }
  })
})
