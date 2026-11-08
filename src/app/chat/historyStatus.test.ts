import { expect } from 'chai'
import { describe, it } from 'mocha'

import { lstrings } from '../locales/strings'
import { historyStatusText, sendStatusText } from './historyStatus'

describe('chat recovery explanations', () => {
  it('describes approval, partial, retry and active recovery separately', () => {
    for (const [historyRecovery, expected] of [
      ['awaitingApproval', lstrings.chat_history_approval],
      ['partial', lstrings.chat_history_partial],
      ['retryableError', lstrings.chat_history_retry],
      ['recovering', lstrings.chat_history_recovering]
    ] as const)
      expect(historyStatusText({ historyRecovery })).equals(expected)
  })
  it('makes recovery conditional and explains unsupported servers once', () => {
    expect(historyStatusText({ historyRecovery: 'waitingForHolder' })).equals(
      lstrings.chat_history_waiting
    )
    const view = { sendReadiness: 'unsupportedServer' } as const
    expect(historyStatusText(view)).equals(lstrings.chat_history_locked)
    expect(historyStatusText(view)).not.equals(
      sendStatusText(view.sendReadiness)
    )
  })
  it('explains sending restrictions independently of old history', () => {
    expect(sendStatusText('freshStartsDisabled')).equals(
      lstrings.chat_fresh_disabled
    )
    expect(sendStatusText('unsupportedServer')).equals(
      lstrings.chat_history_legacy
    )
    expect(sendStatusText('repairRequired')).equals(lstrings.chat_keys_repair)
    for (const state of [
      'ready',
      'canStartFresh',
      'closed',
      'readOnly',
      undefined
    ] as const)
      expect(sendStatusText(state)).equals(undefined)
  })
})
