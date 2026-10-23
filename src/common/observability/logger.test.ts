import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { logEndpoint, Logger } from './logger'

describe('operational logger', () => {
  it('accepts only public HTTPS routing DSNs', () => {
    expect(logEndpoint('https://public@logs.example.test/12')).equals(
      'https://logs.example.test/ingest/12'
    )
    for (const dsn of [
      '',
      'bad',
      'http://key@example.test/1',
      'https://key:secret@example.test/1',
      'https://key@example.test/1?q=x',
      'https://key@example.test/1#x',
      'https://example.test/1',
      'https://key@example.test/path/1'
    ])
      expect(logEndpoint(dsn)).equals(undefined)
  })
  it('isolates queues by destination, sends JSONL without cookies and discards unsafe input', async () => {
    const stored = new Map<string, string>()
    const sent: Array<{ url: string; body: string; credentials: unknown }> = []
    const logger = new Logger({
      app: 'TS srv',
      dsn: 'https://public@logs.example.test/12',
      version: '1.0',
      id: randomUUID,
      storage: {
        getItem: async key => stored.get(key) ?? null,
        setItem: async (key, text) => {
          stored.set(key, text)
        }
      },
      request: async (url, init) => {
        sent.push({
          url: url as string,
          body: init?.body as string,
          credentials: init?.credentials
        })
        return new Response('', { status: 202 })
      }
    })
    logger.emit('service_started')
    logger.emit('app_error', { chat: 'private-canary' })
    logger.emit('app_error', { ec: 'internal' }, 'error')
    await logger.close()
    expect(sent).length(1)
    expect(sent[0].credentials).equals('omit')
    expect(sent[0].body.startsWith('{"D":')).equals(true)
    expect(sent[0].body).not.contains('private-canary')
    expect(sent[0].body.trim().split('\n')).length(2)
    expect([...stored.keys()][0]).contains(
      'TS srv.https://logs.example.test/ingest/12'
    )
  })
  it('contains disabled configuration and broken identifiers without throwing', async () => {
    const options = {
      app: 'TS' as const,
      dsn: '',
      id: () => {
        throw Error('failure')
      },
      storage: { getItem: async () => null, setItem: async () => {} }
    }
    const disabled = new Logger(options)
    disabled.emit('service_started')
    await disabled.close()
    const failed = new Logger({
      ...options,
      dsn: 'https://key@logs.example.test/1'
    })
    failed.emit('service_started')
    await failed.close()
  })
})
