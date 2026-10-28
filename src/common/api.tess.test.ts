import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asHealth,
  asTessMessageBody,
  type Health,
  type StreamingRequest,
  TeamStationClient,
  TESS_ACCEPT,
  TESS_MAX_IMAGE_BYTES,
  type TessStreamEvent,
  TessTurnError,
  tessUploadType
} from './api'
import { HttpError } from './errors'

interface Call {
  url: string
  method: string
  body: unknown
}

function client(answer: unknown): { api: TeamStationClient; calls: Call[] } {
  const calls: Call[] = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body == null ? undefined : JSON.parse(init.body)
      })
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

const change = {
  id: '00000000-0000-4000-8000-000000000001',
  summary: 'Follow Demo Hawks',
  method: 'PUT',
  path: '/me/follows/team/tem_1',
  body: null,
  status: 'pending'
} as const
const reply = {
  id: '7',
  role: 'assistant',
  text: 'Hold Confirm to follow them.',
  attachments: [],
  changes: [change],
  createdAt: '2026-05-02T15:00:00.000Z'
} as const
const asked = {
  id: '6',
  role: 'user',
  text: 'Follow the Hawks',
  attachments: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'runs.csv',
      kind: 'csv',
      described: true
    }
  ],
  changes: [],
  createdAt: '2026-05-02T15:00:00.000Z'
} as const

describe('api client for Tess', () => {
  it('reads the conversation', async () => {
    const { api, calls } = client({
      available: true,
      messages: [{ ...asked, clientId: 'm-1' }, reply],
      contextTokens: 1200,
      answering: true
    })
    expect(await api.tess()).deep.equals({
      available: true,
      messages: [{ ...asked, clientId: 'm-1' }, reply],
      contextTokens: 1200,
      answering: true
    })
    expect(calls).deep.equals([
      { url: '/api/v1/me/tess', method: 'GET', body: undefined }
    ])
  })

  it('sends a message, with attachments and the screen only when there are any', async () => {
    const { api, calls } = client({ messages: [asked, reply] })
    expect(await api.sendTessMessage('Follow the Hawks')).deep.equals([
      asked,
      reply
    ])
    await api.sendTessMessage('Look', {
      attachmentIds: ['a1'],
      screen: { path: '/teams/tem_1', title: 'Demo Hawks', stack: [] }
    })
    await api.sendTessMessage('Plain', { attachmentIds: [] })
    await api.sendTessMessage('Mine', { clientId: 'm-2' })
    expect(calls.map(call => [call.method, call.url, call.body])).deep.equals([
      ['POST', '/api/v1/me/tess/messages', { text: 'Follow the Hawks' }],
      [
        'POST',
        '/api/v1/me/tess/messages',
        {
          text: 'Look',
          attachmentIds: ['a1'],
          screen: { path: '/teams/tem_1', title: 'Demo Hawks', stack: [] }
        }
      ],
      ['POST', '/api/v1/me/tess/messages', { text: 'Plain' }],
      ['POST', '/api/v1/me/tess/messages', { text: 'Mine', clientId: 'm-2' }]
    ])
  })

  it('uploads an attachment', async () => {
    const stored = { id: 'a1', name: 'runs.csv', kind: 'csv' }
    const { api, calls } = client(stored)
    const file = { name: 'runs.csv', mediaType: 'text/csv', data: 'YSxi' }
    expect(await api.uploadTessAttachment(file)).deep.equals(stored)
    expect(calls).deep.equals([
      { url: '/api/v1/me/tess/attachments', method: 'POST', body: file }
    ])
  })

  it('confirms a change', async () => {
    const answer = { change: { ...change, status: 'done' }, messages: [reply] }
    const { api, calls } = client(answer)
    expect(await api.confirmTessChange('a b')).deep.equals(answer)
    expect(calls).deep.equals([
      {
        url: '/api/v1/me/tess/changes/a%20b/confirm',
        method: 'POST',
        body: undefined
      }
    ])
  })

  it('reads the weekly usage', async () => {
    const week = {
      weekStart: '2026-04-27',
      inputTokens: 1200,
      outputTokens: 7,
      requests: 1
    }
    const { api, calls } = client({ weeks: [week] })
    expect(await api.tessUsage()).deep.equals([week])
    expect(calls[0].url).equals('/api/v1/me/tess/usage')
  })

  it('takes a message’s client id of up to 64 letters, digits, - and _', function () {
    expect(
      asTessMessageBody({ text: 'Hi', clientId: 'a-B_9' }).clientId
    ).equals('a-B_9')
    expect(asTessMessageBody({ text: 'Hi' }).clientId).equals(undefined)
    for (const clientId of ['', 'x'.repeat(65), 'a b', 'a/b', 7])
      expect(() => asTessMessageBody({ text: 'Hi', clientId })).throws(
        TypeError
      )
  })

  it('refuses an answer that is not a conversation', async () => {
    const { api } = client({ messages: [{ ...reply, role: 'tool' }] })
    try {
      await api.sendTessMessage('Hi')
      expect.fail('a bad answer was taken')
    } catch (error) {
      expect(error).instanceOf(TypeError)
    }
  })

  it('reads the replay pitch delay from health, and an older server without it as 5', function () {
    const health = {
      status: 'ok',
      version: '1.2.3',
      database: 'ok',
      migrations: 81
    }
    expect(asHealth({ ...health, replayPitchSec: 7 }).replayPitchSec).equals(7)
    expect(asHealth(health).replayPitchSec).equals(5)
  })

  it('reads tess from health, and an older server without it as not true', function () {
    const health = {
      status: 'ok',
      version: '1.2.3',
      database: 'ok',
      migrations: 81
    }
    expect(asHealth({ ...health, tess: true }).tess).equals(true)
    expect(asHealth({ ...health, tess: false }).tess).equals(false)
    expect(asHealth(health).tess).equals(undefined)
    expect(asHealth(health).tess === true).equals(false)
    // A Health written before Tess still is one.
    const older: Health = {
      status: 'ok',
      version: '1.2.3',
      database: 'ok',
      migrations: 80,
      dictation: false,
      dictationModels: []
    }
    expect(older.tess).equals(undefined)
  })

  it('reads a file for Tess by its type, or by its name when the type names nothing she reads', function () {
    expect(tessUploadType('a.png', 'image/png')).deep.equals({
      kind: 'image',
      mediaType: 'image/png'
    })
    expect(tessUploadType('a', 'IMAGE/JPG')?.mediaType).equals('image/jpeg')
    expect(tessUploadType('a', 'TEXT/CSV; charset=utf-8')).deep.equals({
      kind: 'csv',
      mediaType: 'text/csv'
    })
    expect(tessUploadType('a', 'application/csv')?.mediaType).equals('text/csv')
    // Windows calls a CSV a spreadsheet; its name says what it is.
    expect(tessUploadType('Runs.CSV', 'application/vnd.ms-excel')).deep.equals({
      kind: 'csv',
      mediaType: 'text/csv'
    })
    expect(tessUploadType('notes.md', 'application/octet-stream')?.kind).equals(
      'markdown'
    )
    expect(tessUploadType('notes.TXT', undefined)?.kind).equals('text')
    expect(tessUploadType('scores.pdf', 'application/pdf')).equals(null)
    expect(tessUploadType('README', null)).equals(null)
    // A picture's base64 is at most the 5 MB the model takes.
    expect(Math.ceil(TESS_MAX_IMAGE_BYTES / 3) * 4).equals(5 * 1024 * 1024)
    expect(TESS_ACCEPT.split(',')).deep.equals([
      'image/*',
      '.csv',
      '.txt',
      '.md',
      '.markdown',
      'text/csv',
      'text/plain',
      'text/markdown'
    ])
  })

  describe('streamed', () => {
    /** A request the test answers by hand, a piece at a time. */
    class FakeRequest implements StreamingRequest {
      method = ''
      url = ''
      headers: Record<string, string> = {}
      body: string | undefined
      withCredentials = false
      status = 0
      responseText = ''
      contentType: string | null = null
      onprogress: (() => void) | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      ontimeout: (() => void) | null = null
      onabort: (() => void) | null = null
      open(method: string, url: string): void {
        this.method = method
        this.url = url
      }

      setRequestHeader(name: string, value: string): void {
        this.headers[name] = value
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? this.contentType : null
      }

      send(body?: string): void {
        this.body = body
      }

      /** The status and type arrive, then the body in these pieces. */
      answer(status: number, type: string, ...pieces: string[]): void {
        this.status = status
        this.contentType = type
        for (const piece of pieces) {
          this.responseText += piece
          this.onprogress?.()
        }
      }
    }

    const sse = (event: string, data: unknown): string =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const STREAM = 'text/event-stream; charset=utf-8'

    function streaming(token?: string): {
      api: TeamStationClient
      requests: FakeRequest[]
    } {
      const requests: FakeRequest[] = []
      const api = new TeamStationClient({
        baseUrl: '/api/v1',
        token,
        streamingRequest: () => {
          const request = new FakeRequest()
          requests.push(request)
          return request
        }
      })
      return { api, requests }
    }

    async function failure(promise: Promise<unknown>): Promise<HttpError> {
      try {
        await promise
      } catch (error) {
        expect(error).instanceOf(HttpError)
        return error as HttpError
      }
      return expect.fail('it did not fail')
    }

    it('sends a message as `request` does, and tells each event as its whole text arrives', async () => {
      const { api, requests } = streaming('tok_tess_stream')
      api.analyticsApp = 'TS'
      const told: TessStreamEvent[] = []
      const answer = api.streamTessMessage(
        'Follow the Hawks',
        { attachmentIds: ['a1'], clientId: 'm-3' },
        event => told.push(event)
      )
      const [request] = requests
      expect([request.method, request.url]).deep.equals([
        'POST',
        '/api/v1/me/tess/messages'
      ])
      expect(request.withCredentials).equals(true)
      expect(request.headers).deep.equals({
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-teamstation-app': 'TS',
        authorization: 'Bearer tok_tess_stream'
      })
      expect(JSON.parse(request.body!)).deep.equals({
        text: 'Follow the Hawks',
        attachmentIds: ['a1'],
        clientId: 'm-3'
      })
      const text = [
        sse('stored', { messages: [{ ...asked, clientId: 'm-3' }] }),
        ': keep-alive\n\n',
        sse('thinking', { delta: 'They want ' }),
        sse('thinking', { delta: 'the Hawks.' }),
        'event: step\r\ndata: {"id":"t1","label":"Reading: A team","status":"running"}\r\n\r\n',
        sse('a_new_event', { delta: 'x' }),
        sse('text', { delta: 42 }),
        'event: text\ndata: {not json\n\n',
        sse('text', { delta: 'Hold Confirm.' }),
        sse('done', { messages: [asked, reply] }),
        sse('text', { delta: 'after the end' })
      ].join('')
      // Cut anywhere, a line and an event at a time.
      const pieces: string[] = []
      for (let at = 0; at < text.length; at += 13)
        pieces.push(text.slice(at, at + 13))
      request.answer(200, STREAM, ...pieces)
      expect(await answer).deep.equals([asked, reply])
      expect(told).deep.equals([
        { type: 'stored', messages: [{ ...asked, clientId: 'm-3' }] },
        { type: 'thinking', delta: 'They want ' },
        { type: 'thinking', delta: 'the Hawks.' },
        {
          type: 'step',
          id: 't1',
          label: 'Reading: A team',
          status: 'running'
        },
        { type: 'text', delta: 'Hold Confirm.' }
      ])
      request.onload?.()
      expect(api.offline).equals(false)
    })

    it('confirms a change streamed, its change told as it ended, with nothing sent', async () => {
      const { api, requests } = streaming()
      const told: TessStreamEvent[] = []
      const answer = api.streamTessConfirm('a b', event => told.push(event))
      const [request] = requests
      expect(request.url).equals('/api/v1/me/tess/changes/a%20b/confirm')
      expect(request.body).equals(undefined)
      expect(request.headers).deep.equals({ accept: 'text/event-stream' })
      const done = { ...change, status: 'done' }
      request.answer(
        200,
        STREAM,
        sse('stored', { messages: [], change: done }),
        // The last event with no blank line after it, read at the end.
        `event: done\ndata: ${JSON.stringify({ change: done, messages: [reply] })}`
      )
      request.onload?.()
      expect(await answer).deep.equals({ change: done, messages: [reply] })
      expect(told).deep.equals([{ type: 'stored', messages: [], change: done }])
    })

    it('fails as the server failed: an error event, or a refusal before the stream', async () => {
      const { api, requests } = streaming()
      let refused = 0
      api.onSessionRefused = () => {
        refused += 1
      }
      const failed = api.streamTessMessage('Hi', {}, () => undefined)
      requests[0].answer(
        200,
        STREAM,
        sse('stored', { messages: [asked] }),
        sse('error', {
          status: 503,
          code: 'unavailable',
          message: "Tess's model answered 529 overloaded_error",
          details: { status: 529 }
        })
      )
      const error = await failure(failed)
      expect([error.code, error.message, error.details]).deep.equals([
        'unavailable',
        "Tess's model answered 529 overloaded_error",
        { status: 529 }
      ])
      const odd = api.streamTessMessage('Hi', {}, () => undefined)
      requests[1].answer(200, STREAM, sse('error', { status: 404 }))
      expect((await failure(odd)).code).equals('notFound')
      const oddest = api.streamTessMessage('Hi', {}, () => undefined)
      requests[2].answer(200, STREAM, sse('error', 'broken'))
      expect((await failure(oddest)).code).equals('internal')

      const busy = api.streamTessMessage('Hi', {}, () => undefined)
      requests[3].answer(
        409,
        'application/json',
        JSON.stringify({
          code: 'conflict',
          message:
            'Tess is still answering. Wait for her reply, then try again.'
        })
      )
      requests[3].onload?.()
      const conflict = await failure(busy)
      expect([conflict.code, conflict.message]).deep.equals([
        'conflict',
        'Tess is still answering. Wait for her reply, then try again.'
      ])
      const signedOut = api.streamTessMessage('Hi', {}, () => undefined)
      requests[4].answer(401, 'application/json', '')
      requests[4].onload?.()
      expect((await failure(signedOut)).code).equals('unauthorized')
      expect(refused).equals(1)
      // None of them says whether the message was kept.
      expect(error).not.instanceOf(TessTurnError)
    })

    it('says whether the server kept the message when its error event does', async () => {
      const { api, requests } = streaming()
      const takenBack = api.streamTessMessage('Hi', {}, () => undefined)
      requests[0].answer(
        200,
        STREAM,
        sse('stored', { messages: [asked] }),
        sse('error', {
          status: 503,
          code: 'unavailable',
          message: "Tess's model answered 529 overloaded_error",
          kept: false
        })
      )
      const gone = await failure(takenBack)
      expect(gone).instanceOf(TessTurnError)
      expect([
        gone.code,
        gone.message,
        (gone as TessTurnError).kept
      ]).deep.equals([
        'unavailable',
        "Tess's model answered 529 overloaded_error",
        false
      ])
      const kept = api.streamTessConfirm('c1', () => undefined)
      requests[1].answer(200, STREAM, sse('error', { status: 500, kept: true }))
      const stays = await failure(kept)
      expect(stays).instanceOf(TessTurnError)
      expect([stays.code, (stays as TessTurnError).kept]).deep.equals([
        'internal',
        true
      ])
    })

    it('takes a JSON answer from a server that does not stream', async () => {
      const { api, requests } = streaming()
      const answer = api.streamTessMessage('Hi', {}, () => undefined)
      requests[0].answer(
        200,
        'application/json',
        JSON.stringify({ messages: [asked, reply] })
      )
      requests[0].onload?.()
      expect(await answer).deep.equals([asked, reply])
      const unreadable = api.streamTessMessage('Hi', {}, () => undefined)
      requests[1].answer(200, 'application/json', '<html>')
      requests[1].onload?.()
      expect((await failure(unreadable)).code).equals('internal')
    })

    it('is offline when the stream stops before Tess is done, or never connects', async () => {
      const { api, requests } = streaming()
      const told: TessStreamEvent[] = []
      const cut = api.streamTessMessage('Hi', {}, event => told.push(event))
      requests[0].answer(
        200,
        STREAM,
        sse('stored', { messages: [asked] }),
        sse('text', { delta: 'Half' })
      )
      requests[0].onload?.()
      expect((await failure(cut)).code).equals('offline')
      expect(api.offline).equals(true)
      expect(told.map(event => event.type)).deep.equals(['stored', 'text'])
      for (const end of ['onerror', 'ontimeout', 'onabort'] as const) {
        const lost = api.streamTessMessage('Hi', {}, () => undefined)
        const request = requests.at(-1)!
        request[end]?.()
        // Told once, however it ends.
        request.onerror?.()
        expect((await failure(lost)).code, end).equals('offline')
      }
    })

    it('uses the platform’s XMLHttpRequest by default, and fails without one', async () => {
      const made: FakeRequest[] = []
      const global = globalThis as { XMLHttpRequest?: unknown }
      const saved = global.XMLHttpRequest
      try {
        global.XMLHttpRequest = class extends FakeRequest {
          constructor() {
            super()
            made.push(this)
          }
        }
        const api = new TeamStationClient({ baseUrl: '/api/v1' })
        const answer = api.streamTessMessage('Hi', {}, () => undefined)
        made[0].answer(200, STREAM, sse('done', { messages: [] }))
        expect(await answer).deep.equals([])
        global.XMLHttpRequest = undefined
        try {
          await api.streamTessMessage('Hi', {}, () => undefined)
          expect.fail('it streamed without a request')
        } catch (error) {
          expect(String(error)).contains('No XMLHttpRequest')
        }
      } finally {
        global.XMLHttpRequest = saved
      }
    })
  })
})
