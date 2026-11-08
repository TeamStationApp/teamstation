import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { describe, it } from 'mocha'

import {
  recoveryFixtureEnvironment,
  type RecoveryFixtureOwner,
  requireFixtureFields,
  validateRecoveryOwner
} from './chatRecoveryFixtureContract'

const owner: RecoveryFixtureOwner = {
  disposable: true,
  source: 'a'.repeat(40),
  branch: 'paul/chatRecovery',
  databaseUrl: 'postgres://localhost:5433/TeamStation_chatRecovery',
  apiUrl: 'http://127.0.0.1:9100/api/v1',
  webUrl: 'http://127.0.0.1:8080',
  artifacts: '/tmp/synthetic-fixture'
}

describe('chat recovery fixture ownership contract', () => {
  it('accepts only the current owned branch, database and source', () => {
    validateRecoveryOwner(owner, owner)
    for (const extra of [
      { disposable: false },
      { source: 'b'.repeat(40) },
      { source: 'invalid' },
      { branch: 'master' },
      { branch: 'paul/tester' },
      { branch: 'paul/otherTask' },
      { databaseUrl: 'postgres://example.com:5433/TeamStation_chatRecovery' },
      { databaseUrl: 'postgres://localhost:5432/TeamStation_chatRecovery' },
      { databaseUrl: 'postgres://localhost:5433/teamstation' },
      { apiUrl: 'https://example.com/api/v1' },
      { apiUrl: 'http://127.0.0.1:9100/other' },
      { apiUrl: 'http://user:secret@127.0.0.1:9100/api/v1' },
      { webUrl: 'http://127.0.0.1:8080/?x=1' },
      { artifacts: 'relative' }
    ])
      assert.throws(() => {
        const invalid = { ...owner, ...extra }
        validateRecoveryOwner(invalid as RecoveryFixtureOwner, owner)
      })
    assert.throws(() => {
      validateRecoveryOwner(owner, {
        ...owner,
        databaseUrl: owner.databaseUrl + '_other'
      })
    })
    // Matching config is not sufficient: both inputs may name a shared server.
    for (const databaseUrl of [
      'postgres://example.com:5433/TeamStation_chatRecovery',
      'postgres://localhost:5432/TeamStation_chatRecovery',
      'postgres://localhost:5433/teamstation',
      'http://localhost:5433/TeamStation_chatRecovery'
    ])
      assert.throws(() => {
        const unsafe = { ...owner, databaseUrl }
        validateRecoveryOwner(unsafe, unsafe)
      })
    for (const branch of ['master', 'paul/tester'])
      assert.throws(() => {
        const unsafe = { ...owner, branch }
        validateRecoveryOwner(unsafe, unsafe)
      })
  })

  it('rejects nested/empty missing fields before launching a runner', () => {
    requireFixtureFields(
      { actor: { userId: 'usr_actor' }, ids: ['msg_owned'] },
      ['actor.userId', 'ids']
    )
    for (const value of [null, {}, { actor: {} }, { actor: { userId: '' } }])
      assert.throws(() => {
        requireFixtureFields(value, ['actor.userId'])
      })
    assert.throws(() => {
      requireFixtureFields({ ids: [] }, ['ids'])
    })
  })

  it('round trips shell metacharacters without executing them', () => {
    const value = "a path's $(exit 42) `exit 43` $HOME\nnext line"
    const script = recoveryFixtureEnvironment({ RECOVERY_PATH: value })
    const result = execFileSync(
      '/bin/sh',
      ['-c', script + 'printf %s "$RECOVERY_PATH"'],
      { encoding: 'utf8' }
    )
    assert.equal(result, value)
    assert.throws(() => {
      recoveryFixtureEnvironment({ 'BAD;NAME': 'x' })
    })
    assert.throws(() => {
      recoveryFixtureEnvironment({ GOOD: '\0' })
    })
  })
})
