import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer, type Server } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { frontProxy, refuseTakenPorts } from './legacyStack'

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

describe('legacy stack front', function () {
  it("sends the API's paths and local media to the API, pages to the web app", async function () {
    const answering = (name: string): ReturnType<typeof createHttpServer> =>
      createHttpServer((_req, res) => {
        res.end(name)
      })
    const api = answering('api')
    const web = answering('web')
    const listen = async (
      server: ReturnType<typeof createHttpServer> | Server
    ): Promise<number> => {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as AddressInfo).port
    }
    const front = frontProxy(await listen(api), await listen(web))
    const port = await listen(front)
    const ask = async (path: string): Promise<string> =>
      await (await fetch(`http://127.0.0.1:${port}${path}`)).text()
    try {
      expect(await ask('/api/v1/auth/me')).equals('api')
      expect(
        await ask('/media/1794525895/sig/work/videos/vid_1/master.m3u8')
      ).equals('api')
      expect(await ask('/games/gam_1?tab=watch')).equals('web')
      expect(await ask('/mediaLibrary')).equals('web')
    } finally {
      for (const server of [front, api, web])
        await new Promise<void>(resolve =>
          server.close(() => {
            resolve()
          })
        )
    }
  })
})
