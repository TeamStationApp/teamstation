import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as connectTcp } from 'node:net'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { bindUpgrades, claimUpgrade, leaveUpgrade } from './bindUpgrades'

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

describe('leaveUpgrade', function () {
  it('answers at once alone, and after the others only when none took it', async function () {
    const server = createServer()
    const orphaned: string[] = []
    // The listener under test, first, as the harness's is.
    server.on('upgrade', (req, socket) => {
      leaveUpgrade(server, socket, () => {
        orphaned.push(String(req.url))
        socket.end('orphan')
      })
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    try {
      expect(await ask(port, '/alone')).equals('orphan')
      const unbind = bindUpgrades(server, [
        (req, socket) => {
          if (req.url !== '/taken') return false
          // Answered a tick later, as a claim that reads a session is.
          setTimeout(() => socket.end('taken'), 20)
          return true
        },
        (req, socket) => {
          if (req.url !== '/answered') return false
          socket.end('answered')
          return true
        }
      ])
      // Taken before the deferred check: left alone.
      expect(await ask(port, '/taken')).equals('taken')
      expect(await ask(port, '/answered')).equals('answered')
      unbind()
      // Another listener that neither claims nor answers: orphaned a tick on.
      const idle = (): undefined => undefined
      server.on('upgrade', idle)
      expect(await ask(port, '/nobody')).equals('orphan')
      server.off('upgrade', idle)
      expect(orphaned).deep.equals(['/alone', '/nobody'])
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    }
  })

  it('leaves a socket another listener claimed first', async function () {
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
      claimUpgrade(socket)
      setTimeout(() => socket.end('first'), 20)
    })
    server.on('upgrade', (_req, socket) => {
      leaveUpgrade(server, socket, () => socket.end('orphan'))
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    try {
      expect(await ask(port, '/any')).equals('first')
    } finally {
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
