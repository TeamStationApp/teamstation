import { createServer } from 'node:http'
import { type AddressInfo, connect, type Socket } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { startFaultProxy } from './proxy'

describe('the fault proxy', function () {
  it('closes both sides of an upgraded connection when it closes', async function () {
    let upstreamClosed!: () => void
    const closed = new Promise<void>(resolve => {
      upstreamClosed = resolve
    })
    const api = createServer()
    api.on('upgrade', (_req, socket: Socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      )
      socket.on('end', upstreamClosed)
      socket.on('close', upstreamClosed)
    })
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    const { port } = api.address() as AddressInfo
    const proxy = await startFaultProxy({ target: `http://127.0.0.1:${port}` })
    const client = connect(proxy.port, '127.0.0.1')
    try {
      await new Promise<void>(resolve => client.once('connect', resolve))
      client.write(
        'GET /socket HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      )
      const reply = await new Promise<string>(resolve =>
        client.once('data', data => {
          resolve(String(data))
        })
      )
      expect(reply).includes('101')
      await proxy.close()
      const ended = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>(resolve => {
          setTimeout(() => {
            resolve(false)
          }, 2000)
        })
      ])
      expect(ended).equals(true)
    } finally {
      client.destroy()
      api.closeAllConnections()
      api.close()
    }
  }).timeout(10000)

  it('drops the sockets open when socket-drop is set, and refuses new ones until it is cleared', async function () {
    const api = createServer()
    api.on('upgrade', (_req, socket: Socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n'
      )
    })
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
    const { port } = api.address() as AddressInfo
    const proxy = await startFaultProxy({ target: `http://127.0.0.1:${port}` })
    /** Opens a socket on `path`: whether it was upgraded, and the socket. */
    const open = async (
      path: string
    ): Promise<{ upgraded: boolean; client: Socket }> => {
      const client = connect(proxy.port, '127.0.0.1')
      await new Promise<void>(resolve => client.once('connect', resolve))
      client.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n`
      )
      const upgraded = await new Promise<boolean>(resolve => {
        client.once('data', data => {
          resolve(String(data).includes('101'))
        })
        client.once('close', () => {
          resolve(false)
        })
      })
      return { upgraded, client }
    }
    const closed = async (client: Socket): Promise<boolean> =>
      await Promise.race([
        new Promise<boolean>(resolve => {
          if (client.destroyed) resolve(true)
          client.once('close', () => {
            resolve(true)
          })
        }),
        new Promise<boolean>(resolve => {
          setTimeout(() => {
            resolve(false)
          }, 2000)
        })
      ])
    const sockets: Socket[] = []
    try {
      const search = await open('/api/v1/search')
      const spared = await open('/api/v1/none/socket')
      sockets.push(search.client, spared.client)
      expect([search.upgraded, spared.upgraded]).deep.equals([true, true])

      proxy.setFault('socket-drop')
      expect(await closed(search.client)).equals(true)
      expect(spared.client.destroyed).equals(false)
      expect(proxy.injections.map(row => row.path)).deep.equals([
        '/api/v1/search'
      ])
      const refused = await open('/api/v1/search')
      sockets.push(refused.client)
      expect(refused.upgraded).equals(false)

      proxy.setFault(null)
      const again = await open('/api/v1/search')
      sockets.push(again.client)
      expect(again.upgraded).equals(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await proxy.close()
      api.closeAllConnections()
      api.close()
    }
  }).timeout(10000)
})
