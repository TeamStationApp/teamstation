import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as connectTcp } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { bindUpgrades } from './bindUpgrades'

describe('bindUpgrades', function () {
  it('gives each upgrade to the first claim that takes it', async function () {
    const server = createServer()
    const seen: string[] = []
    const unbind = bindUpgrades(server, [
      (req, socket) => {
        seen.push(`game:${req.url}`)
        if (req.url !== '/socket') return false
        socket.end('game')
        return true
      },
      (req, socket) => {
        seen.push(`board:${req.url}`)
        if (!String(req.url).startsWith('/api/v1/scoreboard/')) return false
        socket.end('board')
        return true
      }
    ])
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    try {
      expect(await ask(port, '/socket')).equals('game')
      expect(await ask(port, '/api/v1/scoreboard/gam_x/dashboard')).equals(
        'board'
      )
      expect(await ask(port, '/nope')).equals('')
      expect(seen).deep.equals([
        'game:/socket',
        'game:/api/v1/scoreboard/gam_x/dashboard',
        'board:/api/v1/scoreboard/gam_x/dashboard',
        'game:/nope',
        'board:/nope'
      ])
    } finally {
      unbind()
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    }
  })
})

/** One raw upgrade, and everything the server wrote back. */
async function ask(port: number, path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const tcp = connectTcp(port, '127.0.0.1')
    let heard = ''
    tcp.on('data', data => {
      heard += data.toString('utf8')
    })
    tcp.on('error', reject)
    tcp.on('close', () => {
      resolve(heard)
    })
    tcp.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\n\r\n'
    )
  })
}
