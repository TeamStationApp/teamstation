import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as connectTcp } from 'node:net'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { apiRateLimits } from '../middleware/apiRateLimits'
import { localBudgets } from '../valkey/apiBudgets'
import { bindUpgrades, claimUpgrade, leaveUpgrade } from './bindUpgrades'
import { supportsUpgrade } from './upgradePaths'

describe('upgrade admission paths', () => {
  it('matches exactly the enabled protocols and applies just arrival admission to other paths', async () => {
    for (const path of [
      '/socket?x=1',
      '/api/v1/search///?x=y',
      '/api/v1/scoreboard/demo/socket',
      '/api/v1/scoreboard/demo/publish',
      '/api/v1/scoreboard/demo/dashboard'
    ])
      expect(supportsUpgrade(path, false), path).equals(true)
    for (const path of [
      undefined,
      'http://[bad',
      '/socket/',
      '/api/v1/scoreboard/demo/socket/',
      '/api/v1/searching',
      '/api/v1/dictation?x=y'
    ])
      expect(supportsUpgrade(path, false), path).equals(false)
    expect(supportsUpgrade('/api/v1/dictation/?x=y', true)).equals(true)
    const limits = apiRateLimits(
      localBudgets(() => 0),
      'enforce'
    )
    for (let i = 0; i < 1500; i++)
      expect(await limits.upgrade({}, '192.0.2.3')).equals(0)
    expect(await limits.upgrade({}, '192.0.2.3')).equals(1)
    expect(await limits.upgrade({}, '192.0.2.4', async () => 'reader')).equals(
      0
    )
  })
})

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

  it('dispatches an admitted upgrade and answers an over-budget one before any claim', async () => {
    const server = createServer()
    const claimed: string[] = []
    const unbind = bindUpgrades(
      server,
      [
        (req, socket) => {
          claimed.push(String(req.url))
          socket.end('admitted')
          return true
        }
      ],
      async req => (req.url === '/allowed' ? 0 : 7)
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      expect(await ask(port, '/allowed')).equals('admitted')
      const answer = await ask(port, '/limited')
      expect(answer).includes('HTTP/1.1 429 Too Many Requests')
      expect(answer).includes('Retry-After: 7')
      expect(claimed).deep.equals(['/allowed'])
    } finally {
      unbind()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })

  it('disposes of a refused upgrade once its response is flushed', async () => {
    for (const admit of [
      async () => 1,
      async () => {
        throw new Error('offline')
      }
    ]) {
      const server = createServer()
      const stream = new PassThrough({ allowHalfOpen: true })
      const closed = once(stream, 'close')
      bindUpgrades(server, [], admit)
      server.emit('upgrade', {}, stream, Buffer.alloc(0))
      await closed
      expect(stream.destroyed).equals(true)
    }
  })

  it('dispatches a public scoreboard upgrade when the observe-only session lookup fails', async () => {
    const server = createServer()
    const limits = apiRateLimits(localBudgets(), 'observe')
    bindUpgrades(
      server,
      [
        (req, socket) => {
          if (req.url?.startsWith('/api/v1/scoreboard/') !== true) return false
          socket.end('public viewer')
          return true
        }
      ],
      async req =>
        await limits.upgrade(req.socket, '127.0.0.1', async () => {
          throw new Error('lookup unavailable')
        })
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      expect(
        await ask(
          (server.address() as AddressInfo).port,
          '/api/v1/scoreboard/demo/watch'
        )
      ).equals('public viewer')
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  })

  it('gives a retry delay when upgrade admission is temporarily unavailable', async () => {
    const server = createServer()
    bindUpgrades(server, [], async () => {
      throw new Error('unavailable')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await ask(
        (server.address() as AddressInfo).port,
        '/socket'
      )
      expect(response).includes('503 Service Unavailable')
      expect(response).includes('Retry-After: 1')
    } finally {
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
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
