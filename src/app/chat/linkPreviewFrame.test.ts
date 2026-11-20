import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, it } from 'mocha'

interface ReadRequest extends RequestInit {
  targetAddressSpace?: string
}
interface Port {
  postMessage: (reply: {
    id: string
    bytes?: ArrayBuffer
    mime?: string
  }) => void
  close: () => void
  onmessage?: () => void
}
interface FrameEvent {
  origin: string
  source: unknown
  ports: Port[]
  data: { type: string; id: string; url: string; kind: string }
}
const path = resolve('src/app/chat/linkPreviewFrame.js')
const script = readFileSync(path, 'utf8')
const app = 'https://app.example.test'
const page = 'https://example.org/page'

function frame(
  response: Response,
  supported = true
): {
  read: (
    kind?: string,
    changes?: Partial<FrameEvent>
  ) => Promise<{ size?: number; mime?: string; closed: boolean }>
  requests: ReadRequest[]
} {
  const parent = {}
  const requests: ReadRequest[] = []
  let receive: (event: FrameEvent) => Promise<void>
  class PublicRequest {
    readonly targetAddressSpace?: string
    constructor(
      readonly url: URL,
      readonly options: ReadRequest
    ) {
      if (supported) this.targetAddressSpace = options.targetAddressSpace
    }
  }
  runInNewContext(
    script,
    {
      window: {
        parent,
        location: { href: app + '/chat-link-preview.html' },
        addEventListener: (name: string, handler: typeof receive) => {
          assert.equal(name, 'message')
          receive = handler
        }
      },
      URL,
      Request: PublicRequest,
      Uint8Array,
      AbortController,
      setTimeout,
      clearTimeout,
      Error,
      fetch: async (request: PublicRequest) => {
        requests.push(request.options)
        return response
      }
    },
    { filename: path }
  )
  return {
    requests,
    read: async (kind = 'html', changes = {}) => {
      const result: { size?: number; mime?: string; closed: boolean } = {
        closed: false
      }
      const port: Port = {
        postMessage: msg => {
          assert.equal(msg.id, 'read')
          result.size = msg.bytes?.byteLength
          result.mime = msg.mime
        },
        close: () => {
          result.closed = true
        }
      }
      await receive({
        source: parent,
        origin: app,
        ports: [port],
        data: { id: 'read', type: 'read-preview', url: page, kind },
        ...changes
      })
      return result
    }
  }
}
describe('chat link preview isolated frame', () => {
  it('uses the document parent, a private reply port and credential-free public requests', async () => {
    const f = frame(
      new Response('<title>Hi</title>', {
        headers: { 'content-type': 'Text/HTML; charset=utf-8' }
      })
    )
    for (const mismatch of [
      { source: {} },
      { origin: 'https://example.net' },
      { ports: [] }
    ])
      assert.deepEqual(await f.read('html', mismatch), { closed: false })
    assert.equal(f.requests.length, 0)
    assert.deepEqual(await f.read(), {
      closed: true,
      size: 17,
      mime: 'Text/HTML; charset=utf-8'
    })
    const [r] = f.requests
    assert.equal(r.mode, 'cors')
    assert.equal(r.credentials, 'omit')
    assert.equal(r.referrerPolicy, 'no-referrer')
    assert.equal(r.redirect, 'error')
    assert.equal(r.cache, 'no-store')
    assert.equal(r.targetAddressSpace, 'public')
  })
  it('enforces MIME, browser support and both declared and actual limits', async () => {
    for (const [kind, response] of [
      ['html', new Response(null, { status: 404 })],
      [
        'html',
        new Response('text', { headers: { 'content-type': 'text/plain' } })
      ],
      [
        'image',
        new Response('image', { headers: { 'content-type': 'image/svg+xml' } })
      ],
      [
        'html',
        new Response(null, { headers: { 'content-type': 'text/html' } })
      ],
      [
        'html',
        new Response('page', {
          headers: { 'content-type': 'text/html', 'content-length': '300000' }
        })
      ],
      [
        'html',
        new Response(new Uint8Array(262145), {
          headers: { 'content-type': 'text/html' }
        })
      ]
    ] as const) {
      const result = await frame(response).read(kind)
      assert.equal(result.closed, true)
      assert.equal(result.size, undefined)
    }
    const unsupported = frame(new Response('page'), false)
    assert.equal((await unsupported.read()).size, undefined)
    assert.equal(unsupported.requests.length, 0)
    assert.equal(
      (
        await frame(
          new Response(Uint8Array.of(1, 2), {
            headers: { 'content-type': 'image/jpeg' }
          })
        ).read('image')
      ).size,
      2
    )
  })
})
