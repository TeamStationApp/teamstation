import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openApiDocument } from '../openapi'
import { apiCost, apiRateLimits } from './apiRateLimits'

describe('API rate limit documentation', () => {
  it('keeps the published per-method inventory in step with HTTP and upgrade admission', async () => {
    const report = readFileSync(
      resolve(__dirname, '../../../docs/api-rate-limits.md'),
      'utf8'
    )
    const inventory = report.split('## Operation inventory')[1]
    const documented = openApiDocument('fixture').paths
    const seen = new Set<string>()
    for (const row of inventory.split('\n')) {
      const cells = /^\| `([^`]+)` \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/.exec(
        row
      )
      if (cells == null) continue
      const template = cells[1]
      for (const [i, tier] of (
        ['ordinary', 'aggregate', 'expensive'] as const
      ).entries()) {
        if (cells[i + 2] === '—') continue
        for (const method of cells[i + 2].split(', ')) {
          seen.add(method + ' ' + template)
          const upgradeOnly =
            method === 'GET' &&
            [
              '/search',
              '/scoreboard/{gameId}/publish',
              '/scoreboard/{gameId}/socket'
            ].includes(template)
          if (upgradeOnly) {
            // Arrival is metered before the aggregate upgrade; inspect both via the route-independent gate.
            const charges: string[] = []
            const meter = apiRateLimits(async buckets => {
              charges.push(buckets[buckets.length - 1].tier)
              return { retryAfterSec: 0, limiting: -1, backend: 'shared' }
            }, 'enforce')
            await meter.upgrade({}, '192.0.2.2', async () => undefined)
            expect(charges, template).deep.equals(['arrival', tier])
            continue
          }
          for (const id of ['fixture-a', 'fixture-b']) {
            const route = template.replace(/\{[^}]+\}/g, id)
            for (const verb of method === 'GET' ? ['GET', 'HEAD'] : [method])
              for (const path of [route, route.toUpperCase() + '/'])
                expect(apiCost(verb, path), verb + ' ' + path).equals(tier)
          }
        }
      }
    }
    const operations = Object.entries(documented).flatMap(([path, value]) =>
      Object.keys(value as object)
        .filter(method =>
          ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)
        )
        .map(method => method.toUpperCase() + ' ' + path)
    )
    expect([...seen].sort()).deep.equals(operations.sort())
  })
})
