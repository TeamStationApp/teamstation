import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  controlRecovery,
  type RecoveryControl,
  recoveryControlBody
} from './chatRecoveryControl'

const config: RecoveryControl = {
  disposable: true,
  endpoint: 'http://127.0.0.1/__recovery_fault',
  token: 'x'.repeat(32),
  actors: {
    ios: { userId: 'usr_actor', conversationId: 'cnv_scene' },
    Hc: { userId: 'usr_peer', conversationId: 'cnv_other' }
  }
}

describe('existing chat runner fault command protocol', () => {
  it('maps each native/browser command to one bounded request', () => {
    const cases = [
      ['send', 'send', 'failure'],
      ['page', 'page', 'failure'],
      ['empty', 'page', 'empty'],
      ['delay', 'page', 'success'],
      ['success', 'send', 'success'],
      ['failure', 'send', 'failure'],
      ['pending-success', 'send', 'success'],
      ['pending-failure', 'send', 'failure'],
      ['history-delay', 'history', 'success'],
      ['history-failure', 'history', 'failure'],
      ['epoch-delay', 'epoch', 'success']
    ]
    for (const [action, kind, outcome] of cases)
      assert.deepEqual(
        recoveryControlBody(config, ['ios', action, 'owned-gate', '15000']),
        {
          userId: 'usr_actor',
          conversationId: 'cnv_scene',
          kind,
          outcome,
          gateId: 'owned-gate',
          remaining: 1,
          delayMs: 15000
        }
      )
    assert.equal(
      recoveryControlBody(config, ['Hc', 'send', 'owned-gate'])?.delayMs,
      0
    )
    assert.equal(recoveryControlBody(config, ['clear']), undefined)
  })

  it('rejects missing/unknown actors, actions, malformed delays and nonowned configuration', async () => {
    for (const args of [
      [],
      ['clear', 'extra'],
      ['android', 'send', 'gate'],
      ['ios', 'all', 'gate'],
      ['ios', 'send', 'gate', '-1'],
      ['ios', 'send', 'gate', 'NaN'],
      ['ios', 'send', 'gate', '60001']
    ])
      assert.throws(() => {
        recoveryControlBody(config, args)
      })
    assert.throws(() => {
      recoveryControlBody({ ...config, disposable: false as true }, ['clear'])
    })
    await assert.rejects(
      controlRecovery(
        { ...config, endpoint: 'https://example.com/__recovery_fault' },
        ['clear']
      )
    )
    await assert.rejects(
      controlRecovery({ ...config, endpoint: 'http://127.0.0.1/other' }, [
        'clear'
      ])
    )
    await assert.rejects(controlRecovery({ ...config, token: '' }, ['clear']))
  })
  it('keeps a bounded history-only outage until the owned controller clears it', () => {
    assert.deepEqual(
      recoveryControlBody(config, ['ios', 'history-outage', 'retry-gate']),
      {
        userId: 'usr_actor',
        conversationId: 'cnv_scene',
        kind: 'history',
        outcome: 'failure',
        gateId: 'retry-gate',
        remaining: 100,
        delayMs: 0
      }
    )
    assert.equal(recoveryControlBody(config, ['clear']), undefined)
  })
})
