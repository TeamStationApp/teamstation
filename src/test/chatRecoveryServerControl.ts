/** An explicit, hash-bound controller may replace only the owned fixture API. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

export function recoveryServerControl(fixture: {
  artifacts: string
  source: string
}): (mode: 'baseline' | 'enabled' | 'disabled') => Promise<void> {
  const file = process.env.CHAT_RECOVERY_SERVER_CONTROL
  assert(file != null, 'A private owned API controller is required')
  const control = JSON.parse(readFileSync(file, 'utf8')) as {
    disposable: true
    source: string
    baselineSource: string
    program: string
    sha256: string
  }
  assert.equal(control.disposable, true)
  assert.equal(control.source, fixture.source)
  assert(/^[a-f0-9]{40}$/.test(control.baselineSource))
  assert.notEqual(control.baselineSource, control.source)
  assert(
    realpathSync(control.program).startsWith(
      realpathSync(fixture.artifacts) + '/'
    )
  )
  assert.equal(control.program, join(fixture.artifacts, 'server-control.cjs'))
  return async mode => {
    assert(['baseline', 'enabled', 'disabled'].includes(mode))
    assert.equal(
      createHash('sha256').update(readFileSync(control.program)).digest('hex'),
      control.sha256
    )
    await promisify(execFile)(process.execPath, [control.program, mode], {
      timeout: 60000,
      maxBuffer: 1024 * 1024
    })
  }
}
