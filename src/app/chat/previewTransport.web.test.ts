import assert from 'node:assert/strict'

import { afterEach, describe, it } from 'mocha'

import { previewThumbnail, readPreviewPage } from './previewTransport'

const page = 'https://example.org/doc'
const origin = 'https://example.net'
type Reply = (id: string, port: MessagePort) => void

describe('chat link preview browser transport', () => {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  function replaceGlobal(key: string, value: unknown): void {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  afterEach(() => {
    for (const [key, original] of originals) {
      if (original == null) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, original)
    }
    originals.clear()
  })

  function browser(reply: Reply, canvas?: unknown): { removed: number } {
    const state = { removed: 0 }
    replaceGlobal('location', new URL(origin))
    replaceGlobal('document', {
      createElement: (type: string) => {
        if (type === 'canvas') return canvas
        assert.equal(type, 'iframe')
        return {
          sandbox: new Set(),
          remove: () => state.removed++,
          contentWindow: {
            postMessage: (
              request: { url: string; id: string; type: string },
              target: string,
              ports: MessagePort[]
            ) => {
              assert.equal(request.url, page)
              assert.equal(request.type, 'read-preview')
              assert.equal(target, '*')
              reply(request.id, ports[0])
            }
          }
        }
      },
      body: {
        appendChild: (frame: HTMLIFrameElement) => {
          assert.equal(frame.hidden, true)
          assert.deepEqual([...frame.sandbox], ['allow-scripts'])
          assert.equal(frame.referrerPolicy, 'no-referrer')
          assert.equal(frame.src, '/chat-link-preview.html')
          frame.onload?.(new Event('load'))
        }
      }
    })
    return state
  }

  it('uses a new private port per request and closes the frame on every exit', async () => {
    const html = new TextEncoder().encode('<title>Hi</title>').buffer
    let answer: Reply = (id, port) => {
      port.postMessage({ id, bytes: html, mime: 'text/html' })
    }
    const state = browser((id, port) => {
      answer(id, port)
    })
    const signal = new AbortController().signal
    assert.equal(await readPreviewPage(page, signal), '<title>Hi</title>')
    for (const bad of [
      { id: 'another' },
      { bytes: 'invalid' },
      { mime: null },
      { bytes: new ArrayBuffer(262145) }
    ]) {
      answer = (id, port) => {
        port.postMessage({ id, bytes: html, mime: 'text/html', ...bad })
      }
      await assert.rejects(readPreviewPage(page, signal), /Unavailable/)
    }
    const held = new AbortController()
    answer = () => {}
    const waiting = readPreviewPage(page, held.signal)
    held.abort()
    await assert.rejects(waiting, /Unavailable/)
    assert.equal(state.removed, 6)
    await assert.rejects(readPreviewPage(page, held.signal), /Unavailable/)
    await assert.rejects(readPreviewPage(origin, signal), /Unavailable/)
    assert.equal(state.removed, 6)
  })

  it('decodes the charset declared by the page and falls back to UTF-8 for unknown labels', async () => {
    const signal = new AbortController().signal
    let mime = 'text/html; charset="windows-1252"'
    let bytes: ArrayBuffer = Uint8Array.of(67, 97, 102, 233).buffer
    browser((id, port) => {
      port.postMessage({ id, bytes, mime })
    })
    assert.equal(await readPreviewPage(page, signal), 'Café')
    mime = 'text/html; charset=unknown'
    bytes = new TextEncoder().encode('Résumé').buffer
    assert.equal(await readPreviewPage(page, signal), 'Résumé')
  })

  it('checks the raster before decoding, bounds the thumbnail and releases decoded images', async () => {
    // A minimal PNG header, used only by the dimension check before the decoder.
    const png = Uint8Array.of(
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      3,
      192,
      0,
      0,
      2,
      128
    )
    let mime = 'image/jpeg'
    let result: Blob | null = new Blob([Uint8Array.of(10, 20)])
    let hasContext = true
    let closed = 0
    let width = 960
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (hasContext ? { drawImage: () => {} } : null),
      toBlob: (done: (blob: Blob | null) => void, type: string) => {
        assert.equal(type, 'image/jpeg')
        done(result)
      }
    }
    replaceGlobal('createImageBitmap', async () => ({
      width,
      height: 640,
      close: () => closed++
    }))
    browser((id, port) => {
      port.postMessage({ id, bytes: png.buffer, mime })
    }, canvas)
    const signal = new AbortController().signal
    assert.equal(await previewThumbnail(page, signal), undefined)
    assert.equal(closed, 0)
    mime = 'image/png'
    const image = await previewThumbnail(page, signal)
    assert.deepEqual(image, {
      fileName: 'preview.jpg',
      contentType: 'image/jpeg',
      bytes: Uint8Array.of(10, 20),
      width: 480,
      height: 320
    })
    for (const invalid of [null, new Blob([new Uint8Array(100000)])]) {
      result = invalid
      assert.equal(await previewThumbnail(page, signal), undefined)
    }
    hasContext = false
    assert.equal(await previewThumbnail(page, signal), undefined)
    width = 20000
    assert.equal(await previewThumbnail(page, signal), undefined)
    assert.equal(closed, 5)
  })
})
