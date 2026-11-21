import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  attachDevice,
  connectDaemon,
  HUB_LEASE_SEC,
  hubDaemon,
  isHubDevice,
  type MaestroDaemon,
  type MaestroHubClient,
  routingDaemon
} from './maestro'
import { BlockedError } from './result'

function fakeHub(): { hub: MaestroHubClient; calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    hub: {
      lease: async options => {
        calls.push(['lease', options])
        return {
          screenshot: async () => new Uint8Array(),
          hierarchy: async () => ({}),
          state: async () => ({}),
          detach: async () => undefined
        }
      },
      close: async () => calls.push(['close'])
    }
  }
}

describe('maestro-d through a hub', function () {
  it('leases and attaches in one call, with the caller’s configuration and no flowDir', async function () {
    const { hub, calls } = fakeHub()
    const daemon = hubDaemon(hub)
    const dir = mkdtempSync(join(tmpdir(), 'hub-run-'))
    try {
      await attachDevice(daemon, dir, {
        device: 'PHONE-UDID@hub',
        appId: 'app.teamstation.develop',
        appFile: '/packages/ios.ipa',
        noAppInstall: true,
        outputDir: '/refused'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(calls).deep.equals([
      [
        'lease',
        {
          device: 'PHONE-UDID@hub',
          ttlSec: HUB_LEASE_SEC,
          attach: {
            artifacts: 'on-failure',
            appId: 'app.teamstation.develop',
            appFile: '/packages/ios.ipa',
            noAppInstall: true
          }
        }
      ]
    ])
  })

  it('adds the hub’s defaults, such as an iPhone’s signing team, under the caller’s options', async function () {
    const { hub, calls } = fakeHub()
    await hubDaemon(hub, { teamId: 'TEAM' }).attach({ device: 'p@hub' })
    expect(calls).deep.equals([
      [
        'lease',
        { device: 'p@hub', ttlSec: HUB_LEASE_SEC, attach: { teamId: 'TEAM' } }
      ]
    ])
  })

  it('routes each device by its id: a hub device to the hub, a browser or simulator to this machine', async function () {
    const opened: string[] = []
    const daemon = (name: string): MaestroDaemon => ({
      attach: async options => {
        opened.push(`${name}:${String(options.device)}`)
        return {} as any
      },
      shutdown: async () => {
        opened.push(`${name}:shutdown`)
      }
    })
    const routed = routingDaemon(
      async () => {
        opened.push('open hub')
        return daemon('hub')
      },
      async () => {
        opened.push('open local')
        return daemon('local')
      }
    )
    await routed.attach({ device: 'web-1234' })
    await routed.attach({ device: 'SIM-UDID' })
    await routed.attach({ device: 'PHONE-UDID@hub' })
    await routed.shutdown()
    expect(opened).deep.equals([
      'open local',
      'local:web-1234',
      'local:SIM-UDID',
      'open hub',
      'hub:PHONE-UDID@hub',
      'hub:shutdown',
      'local:shutdown'
    ])
    expect(isHubDevice('PHONE-UDID@hub')).equals(true)
    expect(isHubDevice('SIM-UDID')).equals(false)
  })

  it('closes the local daemon even when the hub never opened, without throwing', async function () {
    const closed: string[] = []
    const routed = routingDaemon(
      async () => {
        throw new Error('no hub token')
      },
      async () => ({
        attach: async () => ({}) as any,
        shutdown: async () => {
          closed.push('local')
        }
      })
    )
    await routed.attach({ device: 'web-1' })
    let failed: unknown
    try {
      await routed.attach({ device: 'PHONE-UDID@hub' })
    } catch (error) {
      failed = error
    }
    expect(String(failed)).includes('no hub token')
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args.join(' '))
    try {
      await routed.shutdown()
    } finally {
      console.error = original
    }
    expect(closed).deep.equals(['local'])
    expect(String(errors[0])).includes('no hub token')
  })

  it('renews each lease until the run ends, and stops renewing then', async function () {
    let renewed = 0
    const hub: MaestroHubClient = {
      lease: async () => ({
        screenshot: async () => new Uint8Array(),
        hierarchy: async () => ({}),
        state: async () => ({}),
        detach: async () => undefined,
        renew: async (options: { ttlSec: number }) => {
          expect(options.ttlSec).equals(HUB_LEASE_SEC)
          renewed++
        }
      }),
      close: async () => undefined
    }
    const daemon = hubDaemon(hub, {}, 5)
    await daemon.attach({ device: 'PHONE-UDID@hub' })
    await new Promise(resolve => setTimeout(resolve, 30))
    await daemon.shutdown()
    const atEnd = renewed
    expect(atEnd).greaterThan(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(renewed, 'none after the run').equals(atEnd)
  })

  it('ends with close, which ends this process’s leases, never the hub’s shutdown', async function () {
    const { hub, calls } = fakeHub()
    await hubDaemon(hub).shutdown()
    expect(calls).deep.equals([['close']])
  })

  it('blocks a run whose hub token file is missing', async function () {
    let error: unknown
    try {
      const daemon = await connectDaemon(
        {
          maestroHub: {
            address: '192.0.2.1:7433',
            tokenFile: '/nowhere/token'
          }
        },
        'test'
      )
      await daemon.attach({ device: 'PHONE-UDID@hub' })
    } catch (caught) {
      error = caught
    }
    expect(error).instanceOf(BlockedError)
    expect(String(error)).includes('/nowhere/token')
  })

  it('connects to the hub with its address and token, spawning nothing', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'hub-client-'))
    try {
      const token = join(dir, 'token')
      writeFileSync(token, 'secret-token\n')
      const client = join(dir, 'client')
      const connected: unknown[] = []
      const { hub } = fakeHub()
      // A stand-in client checkout, as `maestroClientRoot` names one.
      const cjs = join(client, 'dist', 'cjs')
      mkdirSync(cjs, { recursive: true })
      writeFileSync(
        join(client, 'package.json'),
        JSON.stringify({
          name: 'maestro-d',
          main: 'dist/cjs/index.js',
          exports: './dist/cjs/index.js'
        })
      )
      writeFileSync(
        join(cjs, 'index.js'),
        'module.exports = { MaestroD: { connect: async o => globalThis.__hubConnect(o) } }'
      )
      ;(globalThis as Record<string, unknown>).__hubConnect = async (
        options: unknown
      ) => {
        connected.push(options)
        return hub
      }
      const daemon = await connectDaemon(
        {
          maestroClientRoot: client,
          maestroBin: join(dir, 'no-binary'),
          maestroHub: { address: '192.0.2.1:7433', tokenFile: token }
        },
        'test'
      )
      expect(connected, 'nothing until a hub device attaches').deep.equals([])
      await daemon.attach({ device: 'PHONE-UDID@hub' })
      expect(connected).deep.equals([
        { hub: '192.0.2.1:7433', token: 'secret-token' }
      ])
      expect(daemon.attach).a('function')
    } finally {
      Reflect.deleteProperty(globalThis, '__hubConnect')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
