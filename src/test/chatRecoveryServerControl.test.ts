import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'mocha'

import { recoveryServerControl } from './chatRecoveryServerControl'

describe('owned recovery API controller', () => {
  it('binds the exact program, fixture source and allowed operation before execution', async () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'recovery-controller-'))
    const previous = process.env.CHAT_RECOVERY_SERVER_CONTROL
    try {
      const source = 'a'.repeat(40)
      const program = join(artifacts, 'server-control.cjs')
      const result = join(artifacts, 'mode.txt')
      const code = `require('node:fs').writeFileSync(${JSON.stringify(result)}, process.argv[2])`
      writeFileSync(program, code)
      const manifest = {
        disposable: true,
        source,
        baselineSource: 'b'.repeat(40),
        program,
        sha256: createHash('sha256').update(code).digest('hex')
      }
      const file = join(artifacts, 'control.json')
      process.env.CHAT_RECOVERY_SERVER_CONTROL = file
      writeFileSync(file, JSON.stringify(manifest))
      const control = recoveryServerControl({ artifacts, source })
      for (const mode of ['baseline', 'disabled', 'enabled'] as const) {
        await control(mode)
        assert.equal(readFileSync(result, 'utf8'), mode)
      }
      await assert.rejects(control('unknown' as 'baseline'))
      writeFileSync(program, code + '\n// changed')
      await assert.rejects(control('baseline'))
      assert.equal(readFileSync(result, 'utf8'), 'enabled')
      writeFileSync(program, code)
      for (const overrides of [
        { disposable: false },
        { source: 'c'.repeat(40) },
        { baselineSource: 'invalid' },
        { baselineSource: source },
        { program: join(artifacts, 'other.cjs') }
      ]) {
        writeFileSync(file, JSON.stringify({ ...manifest, ...overrides }))
        assert.throws(() => recoveryServerControl({ artifacts, source }))
      }
      delete process.env.CHAT_RECOVERY_SERVER_CONTROL
      assert.throws(() => recoveryServerControl({ artifacts, source }))
    } finally {
      if (previous == null) delete process.env.CHAT_RECOVERY_SERVER_CONTROL
      else process.env.CHAT_RECOVERY_SERVER_CONTROL = previous
      rmSync(artifacts, { recursive: true, force: true })
    }
  })
})
