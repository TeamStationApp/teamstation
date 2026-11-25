import { expect } from 'chai'
import type { Request, Response } from 'express'
import { describe, it } from 'mocha'

import { asHealth } from '../../common/api'
import { withQueryReplies } from '../../test/queryReplies'
import { healthRoutes } from './health'

describe('rate store health', () => {
  it('returns the current worker readiness on each probe independently of database readiness', async () => {
    await withQueryReplies(
      q => (q.sql.includes('schema_migrations') ? [{ count: '3' }] : []),
      async db => {
        let degradedMs = 210
        const router = healthRoutes(db, 'fixture', {
          rateStore: () => ({
            mode: 'enforce',
            readiness: 'failed',
            fault: 'permissions',
            degradedMs
          })
        })
        for (degradedMs of [210, 5000]) {
          const health = await new Promise<ReturnType<typeof asHealth>>(
            (resolve, reject) => {
              const response = {
                status(code: number) {
                  expect(code).equals(200)
                  return this
                },
                json(body: unknown) {
                  resolve(asHealth(body))
                }
              } as unknown as Response
              router(
                {
                  method: 'GET',
                  url: '/health',
                  headers: {}
                } as unknown as Request,
                response,
                reject
              )
            }
          )
          expect(health.database).equals('ok')
          expect(health.apiRateLimits).deep.equals({
            mode: 'enforce',
            readiness: 'failed',
            fault: 'permissions',
            degradedMs
          })
        }
      }
    )
  })
})
