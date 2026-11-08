import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  type FaultAudit,
  type RecoveryFault,
  RecoveryFaults
} from './chatRecoveryFaults'

const fault = (extra: Partial<RecoveryFault> = {}): RecoveryFault => ({
  gateId: 'owned-gate',
  userId: 'usr_actor',
  conversationId: 'cnv_scene',
  kind: 'send',
  outcome: 'failure',
  delayMs: 0,
  remaining: 1,
  ...extra
})
const url = (path = '/api/v1/chat/conversations/cnv_scene/messages'): URL =>
  new URL(path, 'http://127.0.0.1')
const at = '2026-01-02T03:04:05.006Z'
const clock = (): Date => new Date(at)

describe('disposable chat recovery fault gates', () => {
  it('consumes only the named actor, method and exact conversation', () => {
    const audit: FaultAudit[] = []
    const gates = new RecoveryFaults(row => audit.push(row), clock)
    gates.set(fault())
    assert.equal(gates.claim('usr_other', 'POST', url()), undefined)
    assert.equal(gates.claim('usr_actor', 'GET', url()), undefined)
    assert.equal(
      gates.claim(
        'usr_actor',
        'POST',
        url('/api/v1/chat/conversations/cnv_other/messages')
      ),
      undefined
    )
    assert.equal(
      gates.claim(
        'usr_actor',
        'POST',
        url('/api/v1/chat/conversations/cnv_scene/messages/extra')
      ),
      undefined
    )
    assert.equal(audit.length, 0)
    assert.equal(gates.claim('usr_actor', 'POST', url())?.remaining, 0)
    assert.equal(gates.claim('usr_actor', 'POST', url()), undefined)
    assert.deepEqual(audit, [
      {
        gateId: 'owned-gate',
        remaining: 0,
        at,
        method: 'POST',
        mode: 'failure'
      }
    ])
  })

  it('limits concurrent claims and copies configuration and returned values', async () => {
    const gates = new RecoveryFaults(() => {})
    const input = fault({ remaining: 2 })
    gates.set(input)
    input.remaining = 100
    const answers = await Promise.all(
      Array.from({ length: 20 }, async () =>
        gates.claim('usr_actor', 'POST', url())
      )
    )
    assert.equal(answers.filter(Boolean).length, 2)
    answers[0]!.remaining = 100
    assert.equal(gates.claim('usr_actor', 'POST', url()), undefined)
  })

  it('gates older pagination while allowing current messages and unrelated queries', () => {
    const gates = new RecoveryFaults(() => {})
    gates.set(fault({ kind: 'page', outcome: 'empty' }))
    assert.equal(gates.claim('usr_actor', 'GET', url()), undefined)
    assert.equal(
      gates.claim('usr_actor', 'GET', url(url().pathname + '?after=2')),
      undefined
    )
    assert.equal(
      gates.claim('usr_actor', 'GET', url(url().pathname + '?before=2'))
        ?.outcome,
      'empty'
    )
  })

  it('gates recovery delivery without blocking legacy epoch reads', () => {
    const gates = new RecoveryFaults(() => {})
    gates.set(fault({ kind: 'history', outcome: 'success' }))
    const path = '/api/v1/chat/conversations/cnv_scene/epochs'
    assert.equal(
      gates.claim('usr_actor', 'GET', url(path + '?after=2')),
      undefined
    )
    assert.equal(
      gates.claim('usr_actor', 'POST', url(path + '?boxesAfter=0')),
      undefined
    )
    assert.equal(
      gates.claim('usr_actor', 'GET', url(path + '?boxesAfter=0'))?.kind,
      'history'
    )
  })

  it('clears pending delays and permits a later gate with the same ID', async () => {
    const audit: FaultAudit[] = []
    const gates = new RecoveryFaults(row => audit.push(row))
    gates.set(fault({ delayMs: 60000, remaining: 2 }))
    const first = gates.claim('usr_actor', 'POST', url())!
    const second = gates.claim('usr_actor', 'POST', url())!
    const waits = [gates.wait(first), gates.wait(second)]
    gates.clear()
    await Promise.all(waits)
    assert.equal(audit.filter(row => row.event === 'delay-released').length, 2)
    assert.equal(gates.claim('usr_actor', 'POST', url()), undefined)
    gates.clear()
    gates.set(fault())
    assert(gates.claim('usr_actor', 'POST', url()) != null)
    await gates.wait(fault())
  })

  it('holds only the named epoch publication while reads and other actors continue', async () => {
    const audit: FaultAudit[] = []
    const gates = new RecoveryFaults(row => audit.push(row))
    gates.set(fault({ kind: 'epoch', outcome: 'success', delayMs: 60000 }))
    const path = '/api/v1/chat/conversations/cnv_scene/epochs'
    assert.equal(gates.claim('usr_actor', 'GET', url(path)), undefined)
    assert.equal(gates.claim('usr_other', 'POST', url(path)), undefined)
    assert.equal(gates.claim('usr_actor', 'POST', url()), undefined)
    assert.equal(
      gates.claim('usr_actor', 'POST', url(path + '/extra')),
      undefined
    )
    assert.equal(
      gates.claim(
        'usr_actor',
        'POST',
        url(path.replace('cnv_scene', 'cnv_other'))
      ),
      undefined
    )
    const held = gates.claim('usr_actor', 'POST', url(path))
    assert(held != null)
    let released = false
    const pending = gates.wait(held).then(() => {
      released = true
    })
    await Promise.resolve()
    assert.equal(released, false)
    assert.equal(gates.claim('usr_actor', 'POST', url(path)), undefined)
    gates.clear()
    await pending
    assert.equal(released, true)
    assert.equal(audit.filter(row => row.event === 'delay-released').length, 1)
  })

  it('releases a timed fault once', async () => {
    const audit: FaultAudit[] = []
    const gates = new RecoveryFaults(row => audit.push(row), clock)
    await gates.wait(fault({ delayMs: 1 }))
    gates.clear()
    assert.deepEqual(audit, [
      { gateId: 'owned-gate', remaining: 1, at, event: 'delay-released' }
    ])
  })

  it('stamps every audit line with the time it happened', async () => {
    const audit: FaultAudit[] = []
    const gates = new RecoveryFaults(row => audit.push(row))
    gates.set(fault({ kind: 'page', outcome: 'empty', remaining: 2 }))
    const before = Date.now()
    const page = '/api/v1/chat/conversations/cnv_scene/messages?before=9'
    assert(gates.claim('usr_actor', 'GET', url(page)) != null)
    gates.clear()
    assert.deepEqual(
      audit.map(row => [row.method, row.mode, row.event, row.remaining]),
      [
        ['GET', 'empty', undefined, 1],
        [undefined, undefined, 'cleared', 1]
      ]
    )
    for (const row of audit) {
      assert.equal(new Date(row.at).toISOString(), row.at)
      assert(Date.parse(row.at) >= before && Date.parse(row.at) <= Date.now())
    }
  })

  it('rejects malformed and excessively broad configurations', () => {
    const gates = new RecoveryFaults(() => {})
    for (const extra of [
      { gateId: '../x' },
      { userId: '' },
      { conversationId: '*' },
      { kind: 'unknown' },
      { outcome: 'unknown' },
      { remaining: 0 },
      { remaining: 101 },
      { remaining: 1.5 },
      { delayMs: -1 },
      { delayMs: 60001 },
      { delayMs: NaN },
      { outcome: 'empty' }
    ])
      assert.throws(() => {
        gates.set(fault(extra as Partial<RecoveryFault>))
      })
    gates.set(fault())
    assert.throws(() => {
      gates.set(fault())
    }, /Duplicate/)
  })
})
