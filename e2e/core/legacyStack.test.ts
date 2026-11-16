import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  backUpServerConfig,
  configBackupPath,
  frontProxy,
  mayDropStackDatabase,
  refuseTakenPorts,
  STACK_DATABASE_MARK
} from './legacyStack'

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

describe('legacy stack server config', function () {
  const stackUrl = 'postgres://127.0.0.1/teamstation_e2eStack'
  const setUp = (): { dir: string; config: string; backup: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'legacyStackConfig-'))
    return {
      dir,
      config: join(dir, 'serverConfig.json'),
      backup: join(dir, 'backup', 'serverConfig.original.json')
    }
  }
  const write = (file: string, value: unknown): void => {
    writeFileSync(file, JSON.stringify(value))
  }
  const read = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

  it('keeps each checkout’s config backup apart', function () {
    const a = configBackupPath('/Users/dev/git/teamstation')
    expect(configBackupPath('/Users/dev/git/teamstation')).equals(a)
    expect(
      configBackupPath('/Users/dev/git-worktrees/teamstation_other')
    ).not.equals(a)
  })

  it("keeps the developer's config through a run that stopped before restoring", function () {
    const { dir, config, backup } = setUp()
    mkdirSync(join(dir, 'backup'))
    try {
      write(config, { databaseUrl: 'postgres://mine', name: 'mine' })
      backUpServerConfig(config, backup, stackUrl)
      // The stopped run left the stack's copy; the scratch directory is gone.
      write(config, { databaseUrl: stackUrl })
      const next = backUpServerConfig(config, backup, stackUrl)
      expect(next.base).deep.equals({
        databaseUrl: 'postgres://mine',
        name: 'mine'
      })
      write(config, { databaseUrl: stackUrl })
      next.restore()
      expect(read(config)).deep.equals({
        databaseUrl: 'postgres://mine',
        name: 'mine'
      })
      expect(existsSync(backup)).equals(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the stack copy when the developer had no config', function () {
    const { dir, config, backup } = setUp()
    mkdirSync(join(dir, 'backup'))
    try {
      // A stopped run of a developer with no config left only the stack's.
      write(config, { databaseUrl: stackUrl })
      const { base, restore } = backUpServerConfig(config, backup, stackUrl)
      expect(base).deep.equals({})
      restore()
      expect(existsSync(config)).equals(false)

      const fresh = backUpServerConfig(config, backup, stackUrl)
      write(config, { databaseUrl: stackUrl })
      fresh.restore()
      expect(existsSync(config)).equals(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('legacy stack database', function () {
  it('drops only a database that is not there, or one the stack marked as its own', function () {
    expect(
      mayDropStackDatabase({ exists: false, mark: null, reclaim: false })
    ).equals(true)
    expect(
      mayDropStackDatabase({
        exists: true,
        mark: STACK_DATABASE_MARK,
        reclaim: false
      })
    ).equals(true)
    // A seat's database named alike, with no mark or another one.
    expect(
      mayDropStackDatabase({ exists: true, mark: null, reclaim: false })
    ).equals(false)
    expect(
      mayDropStackDatabase({ exists: true, mark: 'seat', reclaim: false })
    ).equals(false)
    // The stack's own from before it marked them, when the run says so.
    expect(
      mayDropStackDatabase({ exists: true, mark: null, reclaim: true })
    ).equals(true)
  })
})
