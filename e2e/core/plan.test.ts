import { expect } from 'chai'
import { describe, it } from 'mocha'

import { readManifest } from './manifest'
import { type PlanResource, planScenarios } from './plan'

const SOAK = 'streaming/basic/four-synthetic#scrub'

/** The soak's row, planned against these devices. */
function soak(resources: Record<string, PlanResource>): {
  runnable: boolean
  blockedBy: string[]
} {
  const row = planScenarios(readManifest(), { resources, settings: {} }).find(
    entry => entry.id === SOAK
  )
  if (row == null) throw new Error(`no ${SOAK} in the plan`)
  return row
}

const free = (capability: string): PlanResource => ({
  available: true,
  capabilities: [capability]
})

describe('plan', function () {
  it('gives each role a device of its own, so two iPhone roles need two iPhones', function () {
    const bench = {
      'pixel-a': free('android-phone'),
      'tv-a': free('apple-tv'),
      'iphone-a': free('ios-phone')
    }
    const short = soak(bench)
    expect(short.runnable).equals(false)
    expect(short.blockedBy.join('\n')).includes('not enough free devices')
    expect(short.blockedBy.join('\n')).includes('ios-phone')
    expect(soak({ ...bench, 'iphone-b': free('ios-phone') })).include({
      runnable: true
    })
  })

  it('still says which role has no device at all, or whose is held', function () {
    const held = soak({
      'pixel-a': free('android-phone'),
      'iphone-a': free('ios-phone'),
      'iphone-b': free('ios-phone'),
      'tv-a': {
        available: false,
        capabilities: ['apple-tv'],
        borrower: 'someone-else',
        expiry: '16:00'
      }
    })
    expect(held.blockedBy).deep.equals([
      'tv: tv-a is held by someone-else until 16:00'
    ])
  })
})
