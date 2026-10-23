import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  emitAppLog,
  flushAppLogs,
  resetAppLogging,
  startAppLogging
} from './log'

describe('application operational logger', () => {
  afterEach(() => {
    resetAppLogging()
  })
  it('initializes once, captures safe events and flushes without any credential', async () => {
    resetAppLogging()
    const sent: string[] = []
    startAppLogging(
      'https://public@logs.example.test/42',
      'web',
      '1.0',
      async (_url, init) => {
        expect(init?.credentials).equals('omit')
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    )
    startAppLogging('https://public@logs.example.test/43', 'ios', '1.0')
    emitAppLog('app_foreground')
    emitAppLog('app_error', { ec: 'storage' }, 'error')
    emitAppLog('app_error', { chat: 'private-canary' })
    await flushAppLogs()
    expect(sent).length(1)
    expect(sent[0]).contains('TS web')
    expect(sent[0]).not.contains('private-canary')
    expect(sent[0]).contains('service_started')
    resetAppLogging()
    await flushAppLogs()
  })
})
