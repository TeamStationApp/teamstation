import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asHealth,
  asTessMessageBody,
  type Health,
  TeamStationClient,
  TESS_ACCEPT,
  TESS_MAX_IMAGE_BYTES,
  tessUploadType
} from './api'

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
})
