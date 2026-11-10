import { createSocket } from 'node:dgram'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'

import { expect } from 'chai'

import {
  appFiles,
  isIntegration,
  SERIAL,
  specFiles,
  tierOf,
  tierOptions,
  UNIT_GUARD,
  UNIT_SERVERS,
  withoutTier
} from './testTiers.mjs'

const load = createRequire(__filename)
const guard = load('./unitTierGuard.cjs') as {
  UnitTierError: new (message: string) => Error
  destination: (args: unknown[]) => {
    host?: string
    port?: unknown
    local?: true
  }
  isLocal: (args: unknown[]) => boolean
  isLoopback: (host: unknown) => boolean
  RULE: string
}
// Loaded after the guard, as a unit-tier process loads it.
const childProcess = load('node:child_process') as Record<
  string,
  (...args: string[]) => unknown
>

const listed: Record<string, string[]> = {
  'src/**/*.test.ts': [
    'src/a.test.ts',
    'src/b.integration.test.ts',
    SERIAL[0],
    'src/node_modules/x.test.ts'
  ],
  'e2e/**/*.test.ts': ['e2e/core/c.test.ts', 'src/a.test.ts'],
  'src/**/*.test.tsx': ['src/app/D.test.tsx', 'src/app/E.integration.test.tsx']
}

function glob(
  pattern: string,
  options: { exclude: (path: string) => boolean }
): string[] {
  return (listed[pattern] ?? []).filter(path => !options.exclude(path))
}

describe('testTiers', function () {
  it('tells an integration file by its name', function () {
    expect(isIntegration('src/x.integration.test.ts')).equals(true)
    expect(isIntegration('src/X.integration.test.tsx')).equals(true)
    expect(isIntegration('src/x.test.ts')).equals(false)
    // A model-backed legacy suite is not a mocha tier file.
    expect(isIntegration('src/x.integration.ts')).equals(false)
  })

  it('reads --tier in either form, unit by default', function () {
    expect(tierOf([])).equals('unit')
    expect(tierOf(['--tier', 'integration'])).equals('integration')
    expect(tierOf(['--tier=unit'])).equals('unit')
    expect(() => tierOf(['--tier', 'nightly'])).throws(/unit or integration/)
  })

  it('passes everything but --tier on to mocha', function () {
    expect(
      withoutTier(['--grep', 'x', '--tier', 'integration', '--tier=unit', '-b'])
    ).deep.equals(['--grep', 'x', '-b'])
  })

  it('lists each tier’s spec files once, without SERIAL or node_modules', function () {
    expect(specFiles('unit', glob)).deep.equals([
      'e2e/core/c.test.ts',
      'scripts/testTiers.test.ts',
      'scripts/testTools.test.ts',
      'src/a.test.ts'
    ])
    expect(specFiles('integration', glob)).deep.equals([
      'src/b.integration.test.ts'
    ])
  })

  it('lists each tier’s app files for the bundles', function () {
    expect(appFiles('unit', glob)).deep.equals(['src/app/D.test.tsx'])
    expect(appFiles('integration', glob)).deep.equals([
      'src/app/E.integration.test.tsx'
    ])
  })

  it('guards the unit tier and points it at servers that are not there', function () {
    const unit = tierOptions([], { KEEP: '1' })
    expect(unit.require).deep.equals([UNIT_GUARD])
    expect(unit.env).deep.include({ KEEP: '1', ...UNIT_SERVERS })
    expect(unit.serial).deep.equals([])
    const integration = tierOptions(['--tier', 'integration'], {
      TS_TEST_DATABASE_URL: 'postgres://db/x'
    })
    expect(integration.require).deep.equals([])
    expect(integration.env.TS_TEST_DATABASE_URL).equals('postgres://db/x')
    expect(integration.serial).deep.equals(SERIAL)
  })
})

describe('unitTierGuard', function () {
  it('reads where a connection goes from each form of its arguments', function () {
    expect(guard.destination([5432, 'db.example'])).deep.equals({
      host: 'db.example',
      port: 5432
    })
    expect(guard.destination([{ host: 'db.example', port: 1 }])).deep.equals({
      host: 'db.example',
      port: 1
    })
    expect(guard.destination([[{ port: 2 }]])).deep.equals({
      host: 'localhost',
      port: 2
    })
    expect(guard.destination([{ path: '/tmp/s' }])).deep.equals({ local: true })
    expect(guard.destination(['/tmp/s'])).deep.equals({ local: true })
    expect(guard.destination([80])).deep.equals({ host: 'localhost', port: 80 })
  })

  it('keeps loopback and local sockets, and nothing else', function () {
    expect(guard.isLocal([80, '127.0.0.1'])).equals(true)
    expect(guard.isLocal([{ host: '::1', port: 1 }])).equals(true)
    expect(guard.isLocal([{ path: '/tmp/s' }])).equals(true)
    expect(guard.isLocal([5432, 'unit-tests-have-no-database.invalid'])).equals(
      false
    )
    for (const host of [
      'LOCALHOST',
      '[::1]',
      '::',
      '0.0.0.0',
      '127.0.0.2',
      '::ffff:127.0.0.1'
    ]) {
      expect(guard.isLoopback(host), host).equals(true)
    }
    for (const host of ['8.8.8.8', '128.0.0.1', '1127.0.0.1', 'db.example']) {
      expect(guard.isLoopback(host), host).equals(false)
    }
  })

  it('refuses a datagram to another machine, and keeps one to this one', function () {
    const socket = createSocket('udp4')
    try {
      expect(() => {
        socket.send('x', 53, '8.8.8.8')
      }).throws(guard.UnitTierError, /sent a datagram to 8\.8\.8\.8/)
      expect(() => {
        socket.connect(53, '8.8.8.8')
      }).throws(guard.UnitTierError)
      expect(() => {
        socket.send('x', 9, '127.0.0.1')
      }).not.throws()
    } finally {
      socket.close()
    }
  })

  it('reaches the loopback server a plain listen(0) reports', async function () {
    const server = createServer(socket => socket.end('hi'))
    await new Promise<void>(resolve => server.listen(0, resolve))
    const { address, port } = server.address() as {
      address: string
      port: number
    }
    const said = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, address)
      socket.on('data', data => {
        resolve(String(data))
      })
      socket.on('error', reject)
    })
    server.close()
    expect(said).equals('hi')
  })

  it('refuses a socket to another machine, naming the rule', function () {
    expect(() => connect(5432, 'db.example')).throws(
      guard.UnitTierError,
      /opened a connection to db\.example:5432; name the file \*\.integration\.test/
    )
  })

  it('lets a loopback server and its client talk', async function () {
    const server = createServer(socket => socket.end('hi'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const said = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      socket.on('data', data => {
        resolve(String(data))
      })
      socket.on('error', reject)
    })
    server.close()
    expect(said).equals('hi')
  })

  it('refuses every way of starting a child process', function () {
    for (const name of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork'
    ] as const) {
      expect(() => childProcess[name]('true')).throws(
        guard.UnitTierError,
        new RegExp(`child_process\\.${name}`)
      )
    }
    const { ChildProcess } = load('node:child_process') as {
      ChildProcess: new () => { spawn: (options: object) => void }
    }
    expect(() => {
      new ChildProcess().spawn({ file: 'true', args: [] })
    }).throws(guard.UnitTierError, /ChildProcess#spawn/)
  })
})
