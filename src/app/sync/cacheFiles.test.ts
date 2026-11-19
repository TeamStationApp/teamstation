import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { type CacheFiles, deleteFileCaches, openFileCache } from './cacheFiles'
import {
  cacheFileName,
  type DocumentStore,
  legacyCacheFileName,
  openCacheStore
} from './cacheStore'
import { CachingClient } from './cachingClient'

describe('server-scoped cache files', () => {
  let dir: string
  let files: CacheFiles
  const user = 'usr_42'
  const a = 'https://a.example.test/api/v1'
  const b = 'https://b.example.test/api/v1'
  const document = {
    body: '{"source":"A"}',
    revision: '1',
    serverDigest: null,
    pending: true
  }
  const row = {
    id: 'edit-1',
    idempotencyKey: 'key-1',
    chain: 'team:t1',
    method: 'POST',
    path: '/teams/t1/players',
    body: '{}',
    dependsOn: [],
    gameId: null
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-scope-'))
    files = {
      list: async () => readdirSync(dir),
      remove: async name => {
        rmSync(join(dir, name))
      },
      open: name => nodeSqliteExecutor(join(dir, name))
    }
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves pending documents and queued edits only on their original server after restart', async () => {
    const first = await openFileCache(user, a, files)
    await first.atomically(async tx => {
      await tx.write('roster', document)
      await tx.enqueue(row)
    })
    await first.close()
    const other = await openFileCache(user, b, files)
    expect(await other.read('roster')).equals(undefined)
    expect(await other.atomically(async tx => await tx.outbox())).deep.equals(
      []
    )
    await other.close()
    const reopened = await openFileCache(user, a, files)
    expect(await reopened.read('roster')).deep.includes(document)
    expect(
      (await reopened.atomically(async tx => await tx.outbox())).map(x => x.id)
    ).deep.equals(['edit-1'])
    await reopened.close()
  })

  it('drops legacy documents and edits, including SQLite sidecars, before opening', async () => {
    const legacy = legacyCacheFileName(user)
    const old = await openCacheStore(files.open(legacy))
    await old.atomically(async tx => {
      await tx.write('roster', document)
      await tx.enqueue(row)
    })
    await old.close()
    for (const suffix of ['-wal', '-shm', '-journal'])
      writeFileSync(join(dir, legacy + suffix), 'old')
    const current = await openFileCache(user, b, files)
    expect(await current.read('roster')).equals(undefined)
    expect(await current.atomically(async tx => await tx.outbox())).deep.equals(
      []
    )
    expect(readdirSync(dir)).deep.equals([cacheFileName(user, b)])
    await current.close()
  })

  it('sign-out deletes every origin for this exact account and preserves other accounts and unrelated files', async () => {
    const first = await openFileCache(user, a, files)
    await first.close()
    const other = await openFileCache('usr_43', a, files)
    await other.atomically(async tx => {
      await tx.write('roster', document)
    })
    await other.close()
    const current = await openFileCache(user, b, files)
    for (const name of [legacyCacheFileName(user), cacheFileName(user, a)]) {
      for (const suffix of ['-wal', '-shm', '-journal'])
        writeFileSync(join(dir, name + suffix), 'old')
    }
    writeFileSync(join(dir, cacheFileName(user, a) + '.backup'), 'keep')
    writeFileSync(join(dir, 'unrelated.sqlite'), 'keep')
    await current.destroy()
    expect(readdirSync(dir).sort()).deep.equals(
      [
        cacheFileName('usr_43', a),
        cacheFileName(user, a) + '.backup',
        'unrelated.sqlite'
      ].sort()
    )
    const preserved = await openFileCache('usr_43', a, files)
    expect(await preserved.read('roster')).deep.includes(document)
    await preserved.close()
  })

  it('uses bounded names for exact account IDs, normalized origins, schemes and ports', () => {
    const name = cacheFileName(user, a)
    for (const origin of [
      'https://A.example.test:443',
      'https://a.example.test?x=1#part',
      'https://a.example.test/another/path'
    ])
      expect(cacheFileName(user, origin)).equals(name)
    for (const origin of [
      b,
      'http://a.example.test',
      'https://a.example.test:444'
    ])
      expect(cacheFileName(user, origin)).not.equals(name)
    expect(cacheFileName(user, 'http://192.0.2.8:8080')).not.equals(
      cacheFileName(user, 'http://192.0.2.10:8080')
    )
    expect(cacheFileName('a/b', a)).not.equals(cacheFileName('a_b', a))
    expect(cacheFileName('../' + '🦉'.repeat(500), a)).matches(
      /^teamstation-v2-[a-f0-9]{64}-[a-f0-9]{64}\.sqlite$/
    )
    expect(legacyCacheFileName('a/b')).equals('teamstation-a_b.sqlite')
  })

  for (const action of ['signedOut', 'discard'] as const)
    it(`${action} removes all account stores when the current origin is corrupt`, async () => {
      const otherOrigin = await openFileCache(user, b, files)
      await otherOrigin.atomically(async tx => {
        await tx.write('roster', document)
        await tx.enqueue(row)
      })
      await otherOrigin.close()
      const otherAccount = await openFileCache('usr_43', a, files)
      await otherAccount.atomically(async tx => {
        await tx.write('roster', document)
      })
      await otherAccount.close()
      writeFileSync(join(dir, cacheFileName(user, a)), 'not a SQLite database')
      const client = new CachingClient({
        baseUrl: a,
        openCache: async (id, url) => await openFileCache(id, url, files),
        deleteCache: async id => {
          await deleteFileCaches(id, files)
        },
        outbox: { setTimer: () => 0, clearTimer: () => undefined }
      })
      if (action === 'signedOut') {
        client.openFor(user)
        expect(await client.cached('roster', raw => raw)).equals(undefined)
        await client.signedOut()
      } else await client.discard(user)
      expect(readdirSync(dir)).deep.equals([cacheFileName('usr_43', a)])
      const kept = await openFileCache('usr_43', a, files)
      expect(await kept.read('roster')).deep.includes(document)
      await kept.close()
    })

  for (const action of ['signedOut', 'discard'] as const)
    it(`${action} finishes its sweep before a new same-account session opens`, async () => {
      let resume!: () => void
      let started!: () => void
      const gate = new Promise<void>(resolve => {
        resume = resolve
      })
      const sweeping = new Promise<void>(resolve => {
        started = resolve
      })
      const stores: DocumentStore[] = []
      const client = new CachingClient({
        baseUrl: a,
        openCache: async (id, url) => {
          const store = await openFileCache(id, url, files)
          stores.push(store)
          return store
        },
        deleteCache: async id => {
          started()
          await gate
          await deleteFileCaches(id, files)
        },
        outbox: { setTimer: () => 0, clearTimer: () => undefined }
      })
      if (action === 'signedOut') {
        client.openFor(user)
        await client.cached('roster', raw => raw)
      }
      const cleanup =
        action === 'signedOut' ? client.signedOut() : client.discard(user)
      await sweeping
      client.openFor(user)
      const reopened = client.cached('roster', raw => raw)
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(stores).length(1)
      } finally {
        resume()
      }
      await cleanup
      await reopened
      expect(stores).length(2)
      await stores[1].atomically(async tx => {
        await tx.write('roster', document)
        await tx.enqueue(row)
      })
      await client.sessionRefused()
      const kept = await openFileCache(user, a, files)
      expect(await kept.read('roster')).deep.includes(document)
      expect(await kept.atomically(async tx => await tx.outbox())).length(1)
      await kept.close()
    })

  it('settles rapid sign-out and reopen sequences without a cleanup dependency cycle', async () => {
    const client = new CachingClient({
      baseUrl: a,
      openCache: async (id, url) => await openFileCache(id, url, files),
      deleteCache: async id => {
        await deleteFileCaches(id, files)
      },
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor(user)
    const first = client.signedOut()
    client.openFor(user)
    const second = client.signedOut()
    client.openFor(user)
    await Promise.all([first, second, client.cached('roster', raw => raw)])
    expect(client.cacheUser).equals(user)
    expect(readdirSync(dir)).deep.equals([cacheFileName(user, a)])
    await client.sessionRefused()
  })

  it('rejects malformed, relative and unsupported origins before touching storage', async () => {
    for (const url of [
      '/api/v1',
      '',
      'https://',
      'https://bad host.test',
      'http://192.0.2.010:8080/api/v1',
      'http://192.0.2.010:8080\\@192.0.2.8/api/v1',
      'http://0xc0000208/api/v1',
      'http://3221225992/api/v1',
      'file:///tmp/a',
      'ftp://a.example.test'
    ]) {
      let touched = false
      try {
        await openFileCache(user, url, {
          ...files,
          list: async () => {
            touched = true
            return []
          }
        })
        expect.fail('invalid origin opened')
      } catch (error) {
        expect(error).instanceOf(Error)
      }
      expect(touched).equals(false)
    }
  })

  it('attempts every account file when one unlink fails and keeps other accounts', async () => {
    const first = await openFileCache(user, a, files)
    await first.close()
    const second = await openFileCache(user, b, files)
    await second.atomically(async tx => {
      await tx.write('roster', document)
      await tx.enqueue(row)
    })
    await second.close()
    const other = await openFileCache('usr_43', a, files)
    await other.atomically(async tx => {
      await tx.write('roster', document)
    })
    await other.close()
    const failed = `${cacheFileName(user, a)}-wal`
    const legacy = legacyCacheFileName(user)
    writeFileSync(join(dir, failed), 'unremovable sidecar')
    writeFileSync(join(dir, legacy), 'legacy')
    const own = [failed, cacheFileName(user, a), cacheFileName(user, b), legacy]
    const attempts: string[] = []
    const failure = new Error('unlink refused')
    const result = await deleteFileCaches(user, {
      list: async () => [...own, cacheFileName('usr_43', a)],
      remove: async name => {
        attempts.push(name)
        if (name === failed) throw failure
        await files.remove(name)
      }
    }).catch((error: unknown) => error)
    expect(result).equals(failure)
    expect(attempts).deep.equals(own)
    expect(readdirSync(dir).sort()).deep.equals(
      [failed, cacheFileName('usr_43', a)].sort()
    )
    const kept = await openFileCache('usr_43', a, files)
    expect(await kept.read('roster')).deep.includes(document)
    await kept.close()
  })

  it('still opens the server-scoped cache when legacy cleanup fails', async () => {
    const store = await openFileCache(user, a, {
      ...files,
      list: async () => [legacyCacheFileName(user)],
      remove: async () => {
        throw new Error('cleanup refused')
      }
    })
    await store.atomically(async tx => {
      await tx.write('roster', document)
    })
    expect(await store.read('roster')).deep.includes(document)
    await store.close()
  })

  it('closes the database when initialization fails', async () => {
    let closed = false
    const failure = new Error('schema refused')
    const result = await openFileCache(user, a, {
      ...files,
      open: () => ({
        transaction: async () => {
          throw failure
        },
        close: () => {
          closed = true
        },
        delete: () => undefined
      })
    }).catch((error: unknown) => error)
    expect(result).equals(failure)
    expect(closed).equals(true)
  })
})
