import { expect } from 'chai'
import { describe, it } from 'mocha'

import { startStack } from './stack'

describe('a stack with a fault proxy in front of its API', function () {
  this.timeout(120000)

  it('counts each API error once, where the front server sees it', async function () {
    const stack = await startStack({ services: [], fault: 'api-500' })
    try {
      const reply = await fetch(`${stack.origin}/api/v1/anything`)
      expect(reply.status).equals(500)
      const errors = (await stack.serverErrors(0)) ?? []
      expect(errors.map(row => [row.path, row.status])).deep.equals([
        ['/api/v1/anything', 500]
      ])
    } finally {
      await stack.stop()
    }
  })
})
