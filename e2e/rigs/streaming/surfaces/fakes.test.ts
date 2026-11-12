import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PNG } from 'pngjs'

import type { MaestroDevice } from '../../../core/maestro'
import type { Rect } from './regions'

/**
 * Stand-ins the surface tests share: a maestro-d device that records every call and
 * answers from a table, and PNG screenshots drawn to order.
 */

export type Call = [string, unknown]

export function fakeDevice(
  answers: Record<string, unknown | ((arg: unknown) => unknown)> = {}
): {
  device: MaestroDevice
  calls: Call[]
} {
  const calls: Call[] = []
  const device: MaestroDevice = new Proxy<MaestroDevice>(Object.create(null), {
    get(_target, name: string) {
      return async (arg: unknown) => {
        calls.push([name, arg])
        const answer = answers[name]
        if (typeof answer === 'function')
          return (answer as (arg: unknown) => unknown)(arg)
        return answer ?? { status: 'passed' }
      }
    }
  })
  return { device, calls }
}

/** A grey screenshot; `bright` regions (in pixels) drawn white. */
export function png(
  width: number,
  height: number,
  bright: Rect[] = []
): Uint8Array {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lit = bright.some(
        r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
      )
      const at = (y * width + x) * 4
      image.data[at] = lit ? 255 : 60
      image.data[at + 1] = lit ? 255 : 60
      image.data[at + 2] = lit ? 255 : 60
      image.data[at + 3] = 255
    }
  }
  return PNG.sync.write(image)
}

export function fixture(name: string): string {
  return readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')
}

export function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name))
}

export const noSleep = async (): Promise<void> => {}

describe('the surface fakes', function () {
  it('record calls and answer from their table', async function () {
    const { device, calls } = fakeDevice({
      state: { foregroundApp: 'x' },
      hierarchy: () => ({})
    })
    expect(await device.state()).deep.equals({ foregroundApp: 'x' })
    expect(await device.tapOn({ text: 'A' })).deep.equals({ status: 'passed' })
    expect(calls.map(call => call[0])).deep.equals(['state', 'tapOn'])
    expect(PNG.sync.read(Buffer.from(png(4, 2))).width).equals(4)
  })
})
