import assert from 'node:assert/strict'
import Module from 'node:module'

import jpeg from 'jpeg-js'
import { afterEach, describe, it } from 'mocha'
import { base64 } from 'rfc4648'

import type { Spec } from './NativeChatPreview'
import { readPreviewBlob } from './previewBlob'
import type * as NativeBlob from './previewBlob.native'
import type * as NativeRead from './previewNativeRead'
import type * as NativeTransport from './previewTransport.native'

describe('chat link preview downloads', () => {
  const originalFetch = globalThis.fetch
  const resolved = [
    'react-native',
    './NativeChatPreview',
    './previewNativeRead',
    './previewTransport.native',
    './previewBlob.native'
  ].map(id => require.resolve(id))
  const saved = resolved.map(path => require.cache[path])
  const address = 'https://example.org/test'
  function native(module: Pick<Spec, 'read' | 'cancel'> | null): {
    transport: typeof NativeTransport
    reader: typeof NativeRead
    blob: typeof NativeBlob
  } {
    for (const key of resolved) Reflect.deleteProperty(require.cache, key)
    const rn = new Module(resolved[0])
    rn.exports = {
      TurboModuleRegistry: {
        get: (name: string) => {
          assert.equal(name, 'NativeChatPreview')
          return module
        }
      }
    }
    rn.loaded = true
    require.cache[resolved[0]] = rn
    return {
      transport: require('./previewTransport.native'),
      reader: require('./previewNativeRead'),
      blob: require('./previewBlob.native')
    }
  }
  afterEach(() => {
    globalThis.fetch = originalFetch
    resolved.forEach((path, index) => {
      if (saved[index] == null) Reflect.deleteProperty(require.cache, path)
      else require.cache[path] = saved[index]
    })
  })
  it('reads only the exact authorized amount from the signed blob endpoint', async () => {
    let options: RequestInit | undefined
    globalThis.fetch = async (url, init) => {
      assert.equal(url, address)
      options = init
      return new Response(Uint8Array.of(1, 2))
    }
    assert.deepEqual(await readPreviewBlob(address, 2), Uint8Array.of(1, 2))
    assert.equal(options?.credentials, 'omit')
    assert.equal(options?.referrerPolicy, 'no-referrer')
    assert.equal(options?.redirect, 'error')
    for (const res of [
      new Response(null, { status: 404 }),
      new Response(null),
      new Response(Uint8Array.of(1)),
      new Response(Uint8Array.of(1, 2, 3)),
      new Response(Uint8Array.of(1, 2), { headers: { 'content-length': '4' } })
    ]) {
      globalThis.fetch = async () => res
      await assert.rejects(readPreviewBlob(address, 2), /thumbnail/i)
    }
  })
  it('aborts an authorized thumbnail read when its card disappears', async () => {
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal
      assert.ok(signal != null)
      signal.throwIfAborted()
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          {
            once: true
          }
        )
      })
    }
    const controller = new AbortController()
    const loading = readPreviewBlob(address, 1, controller.signal)
    controller.abort()
    await assert.rejects(loading, { name: 'AbortError' })
    await assert.rejects(readPreviewBlob(address, 1, controller.signal), {
      name: 'AbortError'
    })
  })
  it('decodes native pages, accepts JPEG thumbnails and verifies signed blob lengths', async () => {
    const jpegBytes = jpeg.encode({
      data: Buffer.from([0, 100, 200, 255]),
      width: 1,
      height: 1
    }).data
    let response = base64.stringify(
      new TextEncoder().encode('<title>Fixture</title>')
    )
    const kinds: number[] = []
    const { transport, blob } = native({
      cancel: () => {},
      read: async (_id, url, kind) => {
        assert.equal(url, address)
        kinds.push(kind)
        return response
      }
    })
    const signal = new AbortController().signal
    assert.equal(
      await transport.readPreviewPage(address, signal),
      '<title>Fixture</title>'
    )
    response = base64.stringify(jpegBytes)
    const image = await transport.previewThumbnail(address, signal)
    assert.equal(image?.width, 1)
    assert.equal(image?.height, 1)
    assert.equal(image?.contentType, 'image/jpeg')
    assert.deepEqual(image.bytes, new Uint8Array(jpegBytes))
    response = 'AQI='
    assert.equal(await transport.previewThumbnail(address, signal), undefined)
    assert.deepEqual(
      await blob.readPreviewBlob(address, 2),
      Uint8Array.of(1, 2)
    )
    await assert.rejects(blob.readPreviewBlob(address, 3), /Incomplete/)
    assert.deepEqual(kinds, [0, 1, 1, 2, 2])
  })
  it('drains visible thumbnails and prioritizes a waiting composer within the two native workers', async () => {
    const releases: Array<() => void> = []
    const starts: string[] = []
    const { reader } = native({
      cancel: () => {},
      read: async (_id, url) => {
        starts.push(url)
        return await new Promise(resolve =>
          releases.push(() => {
            resolve('AQ==')
          })
        )
      }
    })
    const jobs = ['one', 'two', 'three', 'four'].map(
      async url => await reader.nativePreviewRead(url, 2, 1)
    )
    const aborted = new AbortController()
    const abandoned = reader.nativePreviewRead(
      'abandoned',
      0,
      1,
      aborted.signal
    )
    aborted.abort()
    await assert.rejects(abandoned, /unavailable/)
    const page = reader.nativePreviewRead('composer', 0, 1)
    assert.deepEqual(starts, ['one', 'two'])
    releases.shift()!()
    await jobs[0]
    assert.deepEqual(starts, ['one', 'two', 'composer'])
    releases.shift()!()
    await jobs[1]
    releases.shift()!()
    await page
    assert.deepEqual(starts, ['one', 'two', 'composer', 'three', 'four'])
    releases.forEach(done => {
      done()
    })
    await Promise.all(jobs)
  })
  it('cancels native jobs and rejects incomplete, oversized and unavailable responses', async () => {
    const controller = new AbortController()
    let canceled: number | undefined, requested: number | undefined
    let response = 'AQID'
    const { reader } = native({
      cancel: id => {
        canceled = id
      },
      read: async id => {
        requested = id
        return response
      }
    })
    await assert.rejects(reader.nativePreviewRead(address, 2, 2), /unavailable/)
    response = ''
    await assert.rejects(reader.nativePreviewRead(address, 0, 4), /unavailable/)
    response = 'AQIDBAUG'
    await assert.rejects(reader.nativePreviewRead(address, 0, 3), /unavailable/)
    const waiting = reader.nativePreviewRead(address, 2, 10, controller.signal)
    controller.abort()
    assert.equal(canceled, requested)
    await assert.rejects(waiting, /unavailable/)
    await assert.rejects(
      reader.nativePreviewRead(address, 2, 10, controller.signal),
      /unavailable/
    )
    await assert.rejects(
      native(null).reader.nativePreviewRead(address, 0, 10),
      /unavailable/
    )
  })
})
