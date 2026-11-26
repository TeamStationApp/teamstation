import childProcess from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { HUB_LEASE_SEC, HUB_RENEW_MS } from '../core/maestro'
import { maestro, navigationDaemonName } from './refinementsMaestro'

describe('legacy navigation device routing', () => {
  let dir: string
  let original: NodeJS.ProcessEnv
  let calls: unknown[][]
  let settings: string
  beforeEach(() => {
    original = process.env
    process.env = { ...original }
    dir = mkdtempSync(join(tmpdir(), 'nav-rig-'))
    settings = join(dir, 'settings.json')
    const client = join(dir, 'client.cjs')
    writeFileSync(client, 'module.exports = globalThis.__tabRigClient')
    process.env.E2E_LOCAL_SETTINGS = settings
    process.env.MAESTRO_D_BIN = join(dir, 'maestro')
    mock.method(childProcess, 'execFileSync', () => undefined)
    process.env.TS_MAESTRO_D_CLIENT = client
    for (const name of ['MAESTRO_D_HUB', 'MAESTRO_D_TOKEN', 'MAESTRO_TEAM_ID'])
      Reflect.deleteProperty(process.env, name)
    calls = []
    Object.assign(globalThis, {
      __tabRigClient: {
        MaestroD: {
          connect: async (options: Record<string, unknown>) => {
            calls.push(['connect', options, process.env.MAESTRO_D_HUB])
            return {
              info: { runDir: dir },
              attach: async (o: object) => calls.push(['local', o]),
              shutdown: async () => calls.push(['shutdown']),
              lease: async (o: object) => {
                calls.push(['lease', o])
                return { renew: async (r: object) => calls.push(['renew', r]) }
              },
              close: async () => calls.push(['close'])
            }
          }
        }
      }
    })
  })
  afterEach(() => {
    mock.reset()
    process.env = original
    Reflect.deleteProperty(globalThis, '__tabRigClient')
    rmSync(dir, { recursive: true, force: true })
  })

  it('routes local and hub targets independently and ends its leases', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'test-only\n')
    writeFileSync(
      settings,
      JSON.stringify({
        maestroHub: {
          address: 'example.test',
          teamId: 'TEAM',
          tokenFile
        }
      })
    )
    process.env.MAESTRO_D_HUB = 'example.test'
    const d = await maestro('nav-test')
    await d.attach({ device: 'browser', platform: 'web' })
    expect(d.info?.runDir).equals(dir)
    expect(process.env.MAESTRO_D_HUB).equals('example.test')
    await d.attach({ device: 'phone@hub', platform: 'ios', flowDir: dir })
    mock.timers.tick(HUB_RENEW_MS)
    await d.shutdown()
    const count = calls.length
    mock.timers.tick(HUB_RENEW_MS)
    expect(calls).length(count)
    expect(calls).to.deep.include.members([
      [
        'connect',
        { name: 'nav-test', bin: process.env.MAESTRO_D_BIN, idleTimeout: 0 },
        undefined
      ],
      ['local', { device: 'browser', platform: 'web' }],
      [
        'connect',
        {
          hub: 'example.test',
          token: 'test-only',
          bin: process.env.MAESTRO_D_BIN
        },
        'example.test'
      ],
      [
        'lease',
        {
          device: 'phone@hub',
          holder: 'nav-test',
          ttlSec: HUB_LEASE_SEC,
          attach: { teamId: 'TEAM', platform: 'ios' }
        }
      ],
      ['renew', { ttlSec: HUB_LEASE_SEC }],
      ['close'],
      ['shutdown']
    ])
  })

  it('names a private daemon for the run and its role', () => {
    delete process.env.E2E_DAEMON_PREFIX
    expect(navigationDaemonName('browser')).equals(`nav-${process.pid}-browser`)
    process.env.E2E_DAEMON_PREFIX = 'run-one'
    expect(navigationDaemonName('phone')).equals('run-one-phone')
  })

  it('refuses an unconfigured hub or missing token before device access', async () => {
    for (const address of [undefined, 'example.test']) {
      if (address != null) process.env.MAESTRO_D_HUB = address
      const d = await maestro('nav-test')
      const error = await d.attach({ device: 'phone@hub' }).then(
        () => '',
        (e: unknown) => String(e)
      )
      expect(error).includes(address == null ? 'hub address' : 'client token')
    }
    expect(calls).deep.equals([])
  })
})
