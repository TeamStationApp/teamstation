import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { MaestroDevice } from '../../core/maestro'
import { driverLost, recoveringDevice, type Recovery } from './recovering'

const RESET =
  'Get "http://localhost:9058/session/27AD/source": read tcp [::1]:60541->[::1]:9058: read: connection reset by peer (DEVICE_ERROR)'

/** A device whose calls answer from `script`, one entry per call, in order. */
function scripted(
  name: string,
  script: Array<string | Error>,
  log: string[]
): MaestroDevice {
  return new Proxy<MaestroDevice>(Object.create(null), {
    get(_target, method: string) {
      if (method === 'then') return undefined
      return async () => {
        log.push(`${name}.${method}`)
        if (method === 'detach') return undefined
        const next = script.shift() ?? 'ok'
        if (next instanceof Error) throw next
        return next
      }
    }
  })
}

describe('a recovering device', function () {
  it('tells a lost driver from an app that said no', function () {
    expect(driverLost(RESET)).equals(true)
    expect(
      driverLost(
        'Get "http://localhost:9058/session/27AD/source": context deadline exceeded (Client.Timeout exceeded while awaiting headers) (DEVICE_ERROR)'
      )
    ).equals(true)
    expect(driverLost('connect ECONNREFUSED: connection refused')).equals(true)
    expect(
      driverLost(
        'tapOnPoint: Failed to press at point for 8000ms: send request: Post "http://localhost/session/6381/appium/gestures/long_click": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'
      )
    ).equals(false)
    expect(driverLost('tapOn: text="PhoneA angle": Element not found')).equals(
      false
    )
  })

  it('reattaches once when the driver is lost, retries the call, and reports it', async function () {
    const log: string[] = []
    const devices = [
      scripted('first', [new Error(RESET)], log),
      scripted('second', ['tree'], log)
    ]
    const recoveries: Recovery[] = []
    let clock = 1000
    const device = await recoveringDevice({
      role: 'iphone',
      attach: async () => devices.shift()!,
      onRecovery: recovery => recoveries.push(recovery),
      now: () => clock++
    })
    expect(await device.hierarchy()).equals('tree')
    expect(log).deep.equals([
      'first.hierarchy',
      'first.detach',
      'second.hierarchy'
    ])
    expect(recoveries).deep.equals([
      {
        atMs: 1000,
        role: 'iphone',
        call: 'hierarchy',
        error: RESET,
        recoveredMs: 1001
      }
    ])
  })

  it('passes an app error through untouched, and does not reattach twice within the cooldown', async function () {
    const log: string[] = []
    const devices = [
      scripted(
        'first',
        [new Error('Element not found'), new Error(RESET)],
        log
      ),
      scripted('second', [new Error(RESET), new Error(RESET)], log)
    ]
    const recoveries: Recovery[] = []
    const device = await recoveringDevice({
      role: 'ipad',
      attach: async () => devices.shift()!,
      onRecovery: recovery => recoveries.push(recovery),
      now: () => 5000
    })
    const failure = async (call: () => Promise<unknown>): Promise<string> =>
      await call().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    expect(await failure(async () => await device.tapOn({ text: 'x' }))).equals(
      'Element not found'
    )
    expect(recoveries).length(0)
    // The first loss reattaches; the new driver dies at once, and stays down.
    expect(await failure(async () => await device.screenshot())).equals(RESET)
    expect(recoveries).length(1)
    expect(await failure(async () => await device.screenshot())).equals(RESET)
    expect(recoveries).length(1)
  })

  it('tries the attach again while the phone is off USB, and comes back when it returns', async function () {
    let attaches = 0
    const waits: number[] = []
    const recoveries: Recovery[] = []
    const device = await recoveringDevice({
      role: 'iphone',
      attach: async () => {
        attaches++
        if (attaches === 1) return scripted('first', [new Error(RESET)], [])
        if (attaches < 4) throw new Error('Device not found. Is it attached?')
        return scripted('back', ['tree'], [])
      },
      onRecovery: recovery => recoveries.push(recovery),
      sleep: async ms => {
        waits.push(ms)
      }
    })
    expect(await device.hierarchy()).equals('tree')
    expect(waits).deep.equals([20_000, 20_000])
    expect(recoveries[0].recoveredMs).not.equals(null)
    expect(recoveries[0].reattachError).equals(undefined)
  })

  it('reports a reattach that fails, and gives back the original error', async function () {
    let attaches = 0
    const recoveries: Recovery[] = []
    const device = await recoveringDevice({
      role: 'iphone',
      sleep: async () => undefined,
      attach: async () => {
        if (attaches++ > 0) throw new Error('no WebDriverAgent')
        return scripted('only', [new Error(RESET)], [])
      },
      onRecovery: recovery => recoveries.push(recovery)
    })
    expect(
      await device.state().then(
        () => '',
        (e: unknown) => (e as Error).message
      )
    ).equals(RESET)
    expect(recoveries[0].recoveredMs).equals(null)
    expect(recoveries[0].reattachError).equals('no WebDriverAgent')
  })

  it('retries on the new driver when another call has already reattached', async function () {
    const log: string[] = []
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = new Proxy<MaestroDevice>(Object.create(null), {
      get(_target, method: string) {
        if (method === 'then') return undefined
        return async () => {
          log.push(`first.${method}`)
          if (method === 'detach') return undefined
          if (method === 'state') await held
          throw new Error(RESET)
        }
      }
    })
    const devices = [first, scripted('second', ['a', 'b'], log)]
    const device = await recoveringDevice({
      role: 'iphone',
      attach: async () => devices.shift()!
    })
    // `state` starts on the first driver and fails only after `hierarchy`
    // has lost it and reattached: it goes straight to the second.
    const slow = device.state()
    expect(await device.hierarchy()).equals('a')
    release()
    expect(await slow).equals('b')
    expect(log.filter(line => line === 'first.detach')).length(1)
  })
})
