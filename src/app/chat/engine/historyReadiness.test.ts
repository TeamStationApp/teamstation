import { expect } from 'chai'
import { describe, it } from 'mocha'

import { sendReadinessOf } from './historyReadiness'

const ready = {
  linked: true,
  closed: false,
  canPost: true,
  verified: true,
  latest: 4,
  holdsLatest: false,
  noHolder: false,
  recoverySupported: true,
  freshEnabled: true,
  hasServerBox: false
}
describe('independent chat send readiness', () => {
  it('allows fresh sending without historical keys', () => {
    expect(sendReadinessOf(ready)).equals('canStartFresh')
    expect(sendReadinessOf({ ...ready, freshEnabled: false })).equals(
      'freshStartsDisabled'
    )
    expect(sendReadinessOf({ ...ready, recoverySupported: false })).equals(
      'unsupportedServer'
    )
  })
  it('requires device repair when the identity already received the key', () => {
    expect(sendReadinessOf({ ...ready, hasServerBox: true })).equals(
      'repairRequired'
    )
  })
  it('retains current-key sending when membership verification prevents rotation', () => {
    expect(
      sendReadinessOf({ ...ready, holdsLatest: true, verified: false })
    ).equals('ready')
  })

  it('retains first, current-key and legacy no-holder sending', () => {
    for (const patch of [
      { latest: 0 },
      { holdsLatest: true },
      { noHolder: true }
    ])
      expect(
        sendReadinessOf({
          ...ready,
          freshEnabled: false,
          recoverySupported: false,
          ...patch
        })
      ).equals('ready')
  })
  it('never bypasses setup, closure or role, and verifies new encryption', () => {
    const cases = [
      [{ linked: false }, 'needsDeviceSetup'],
      [{ closed: true }, 'closed'],
      [{ canPost: false }, 'readOnly'],
      [{ verified: false, holdsLatest: false }, 'unverified']
    ] as const
    for (const [patch, result] of cases)
      expect(sendReadinessOf({ ...ready, holdsLatest: true, ...patch })).equals(
        result
      )
  })
})
