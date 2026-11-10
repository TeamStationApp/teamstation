import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'mocha'

import {
  controlRecovery,
  type RecoveryControl,
  recoveryControlBody,
  runRecoveryControl
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

  it('runs as the executable the runners call, with its settings from the environment', async () => {
    const seen: Array<{ method?: string; body: string; auth?: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += String(chunk)))
      req.on('end', () => {
        seen.push({ method: req.method, body, auth: req.headers.authorization })
        res.writeHead(204).end()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const directory = mkdtempSync(join(tmpdir(), 'recovery-control-'))
    try {
      const file = join(directory, 'control.json')
      writeFileSync(
        file,
        JSON.stringify({
          ...config,
          endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__recovery_fault`
        })
      )
      const run = async (
        args: string[],
        env: Record<string, string>
      ): Promise<{ code: number; stderr: string }> =>
        await new Promise(resolve => {
          execFile(
            process.execPath,
            ['scripts/chat-history-recovery-control.cjs', ...args],
            { env: { ...process.env, ...env } },
            (error, _stdout, stderr) => {
              resolve({ code: error == null ? 0 : 1, stderr })
            }
          )
        })
      const control = { CHAT_RECOVERY_CONTROL_FILE: file }
      assert.equal(
        (await run(['Hc', 'pending-success', 'gate', '5'], control)).code,
        0
      )
      assert.equal((await run(['clear'], control)).code, 0)
      assert.deepEqual(
        seen.map(row => row.method),
        ['POST', 'DELETE']
      )
      assert.deepEqual(JSON.parse(seen[0].body), {
        userId: 'usr_peer',
        conversationId: 'cnv_other',
        kind: 'send',
        outcome: 'success',
        gateId: 'gate',
        remaining: 1,
        delayMs: 5
      })
      assert.equal(seen[0].auth, 'Bearer ' + config.token)
      const refused = await run(['Hc', 'all', 'gate'], control)
      assert.equal(refused.code, 1)
      assert(!refused.stderr.includes(config.token))
      assert.equal(
        (await run(['clear'], { CHAT_RECOVERY_CONTROL_FILE: '' })).code,
        1
      )
      assert.equal(seen.length, 2)
      await assert.rejects(runRecoveryControl(undefined, ['clear']))
      await assert.rejects(runRecoveryControl('control.json', ['clear']))
    } finally {
      rmSync(directory, { recursive: true, force: true })
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })
})
