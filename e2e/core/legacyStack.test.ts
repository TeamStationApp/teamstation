import { createServer, type Server } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { refuseTakenPorts } from './legacyStack'

describe('legacy stack ports', function () {
  it('refuses a port something answers on, and passes free ones', async function () {
    const server: Server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address == null || typeof address === 'string')
      throw new Error('no port')
    const taken = address.port
    const free = createServer()
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve))
    const freeAddress = free.address()
    if (freeAddress == null || typeof freeAddress === 'string')
      throw new Error('no port')
    await new Promise<void>(resolve =>
      free.close(() => {
        resolve()
      })
    )
    try {
      await refuseTakenPorts([freeAddress.port])
      let refused: unknown
      await refuseTakenPorts([freeAddress.port, taken]).catch(
        (error: unknown) => {
          refused = error
        }
      )
      expect(String(refused)).includes(`taken: ${taken};`)
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })
})
