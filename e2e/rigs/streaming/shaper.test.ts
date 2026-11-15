import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { loadShaper, type ShaperTools } from './shaper'

const TOOLS: ShaperTools = {
  fetch: async () => new Response('{}'),
  sleep: async () => {}
}

function module(source: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'e2e-shaper-')), 'shaper.cjs')
  writeFileSync(file, source)
  return file
}

describe('loadShaper', function () {
  it('makes the conditioner the local module exports, handing it the tools', async function () {
    const file = module(`
exports.shaper = tools => ({
  onTestNetwork: async ip => ({ ip, hostname: null, ssid: String(typeof tools.fetch) }),
  outage: async (ip, ms, during) => {
    await tools.sleep(ms)
    return await during?.()
  }
})`)
    const shaper = loadShaper(file, TOOLS)
    expect(await shaper.onTestNetwork('192.0.2.20')).deep.equals({
      ip: '192.0.2.20',
      hostname: null,
      ssid: 'function'
    })
    expect(await shaper.outage('192.0.2.20', 5, async () => 'held')).equals(
      'held'
    )
  })

  it('refuses a module with no shaper, or one that makes no conditioner', function () {
    expect(() => loadShaper(module('exports.other = 1'), TOOLS)).to.throw(
      'exports no shaper(tools)'
    )
    expect(() =>
      loadShaper(module('exports.shaper = () => ({})'), TOOLS)
    ).to.throw('has no onTestNetwork and outage')
  })
})
