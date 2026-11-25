import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Script } from 'node:vm'

import { expect } from 'chai'
import { buildSync } from 'esbuild'
import { describe, it } from 'mocha'

import { installedNativeUrl } from '../../test/installedNativeUrl'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import {
  cacheFileName,
  type DocumentStore,
  legacyCacheFileName
} from './cacheStore'

// Bundle with native resolution, just as Metro does. Only OS facilities are
// replaced; URL parsing, file lifecycle and SQL execute the production code.
const bundled = buildSync({
  entryPoints: ['src/app/sync/cache.native.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  sourcemap: 'inline',
  outfile: 'lib/cache-native-test.cjs',
  resolveExtensions: ['.native.ts', '.ts', '.js', '.json'],
  external: [
    'react-native',
    'react-native-blob-util',
    '@op-engineering/op-sqlite'
  ]
}).outputFiles[0].text

// c8 filters mapped paths before resolving relative source names. Absolute
// names keep the real V8 ranges instead of v8-to-istanbul's default counts.
const bundle = bundled.replace(
  /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
  (_match, encoded: string) => {
    const map = JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
      sources: string[]
    }
    map.sources = map.sources.map(source => resolve('lib', source))
    return `sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
  }
)

describe('native server-scoped cache adapter', () => {
  for (const platform of ['ios', 'android'])
    it(`uses the ${platform} database directory and a standard parser with React Native's URL global`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'native-cache-scope-'))
      const calls: string[] = []
      const NativeUrl = installedNativeUrl()
      // This fixture would fail with RN's default parser, proving the test
      // does not accidentally rely on Node's standard URL implementation.
      expect(
        new NativeUrl('https://API.example.test:443/api/v1').origin
      ).not.equals('https://api.example.test')
      const modules: Record<string, unknown> = {
        'react-native': {
          Platform: { OS: platform, Version: '27' },
          NativeModules: {}
        },
        'react-native-blob-util': {
          fs: {
            exists: async (path: string) => {
              expect(path).equals(dir)
              return calls.includes('opened')
            },
            ls: async (path: string) => {
              expect(path).equals(dir)
              return readdirSync(path)
            },
            unlink: async (path: string) => {
              calls.push('unlink')
              rmSync(path)
            }
          }
        },
        '@op-engineering/op-sqlite': {
          IOS_DOCUMENT_PATH: platform === 'ios' ? dir : '/unused-ios',
          ANDROID_DATABASE_PATH:
            platform === 'android' ? dir : '/unused-android',
          open: ({ name, location }: { name: string; location: string }) => {
            expect(location).equals(dir)
            calls.push('opened')
            const sql = nodeSqliteExecutor(join(location, name))
            return {
              transaction: async (work: (tx: unknown) => Promise<void>) => {
                await sql.transaction(async tx => {
                  await work({
                    execute: async (text: string, values: unknown[]) => ({
                      rows: await tx.execute(text, values as never)
                    })
                  })
                })
              },
              close: async () => {
                calls.push('close')
                await sql.close()
              },
              delete: async () => {
                calls.push('delete')
                await sql.delete()
              }
            }
          }
        }
      }
      const module: {
        exports: Partial<{
          deleteDocumentCaches: (user: string) => Promise<void>
          openDocumentCache: (
            user: string,
            url: string
          ) => Promise<DocumentStore>
        }>
      } = { exports: {} }
      const wrapped = `(function(require,module,exports,URL){${bundle}\n})`
      mkdirSync('lib', { recursive: true })
      writeFileSync('lib/cache-native-test.cjs', wrapped)
      new Script(wrapped, {
        filename: resolve('lib/cache-native-test.cjs')
      }).runInThisContext()(
        (name: string) => {
          if (!(name in modules))
            throw new Error(`Unexpected native dependency: ${name}`)
          return modules[name]
        },
        module,
        module.exports,
        NativeUrl
      )
      const open = module.exports.openDocumentCache!
      try {
        const first = await open(
          'usr_42',
          'https://API.example.test:443/api/v1'
        )
        await first.atomically(async tx => {
          await tx.write('source', {
            body: 'A',
            revision: '1',
            serverDigest: null,
            pending: true
          })
        })
        await first.close()
        writeFileSync(join(dir, legacyCacheFileName('usr_42')), 'discard')
        const reopened = await open(
          'usr_42',
          'https://api.example.test?query=1'
        )
        expect((await reopened.read('source'))?.body).equals('A')
        expect(readdirSync(dir)).deep.equals([
          cacheFileName('usr_42', 'https://api.example.test')
        ])
        await reopened.destroy()
        expect(readdirSync(dir)).deep.equals([])
        expect(calls).includes('unlink')
        expect(calls.slice(-2)).deep.equals(['close', 'delete'])
        // Cleanup itself must not try to open a corrupt current-origin file.
        for (const name of [
          cacheFileName('usr_42', 'https://api.example.test'),
          cacheFileName('usr_42', 'https://other.example.test'),
          legacyCacheFileName('usr_42'),
          cacheFileName('usr_43', 'https://api.example.test')
        ])
          writeFileSync(join(dir, name), 'corrupt')
        const openedBefore = calls.filter(call => call === 'opened').length
        await module.exports.deleteDocumentCaches!('usr_42')
        expect(calls.filter(call => call === 'opened')).length(openedBefore)
        expect(readdirSync(dir)).deep.equals([
          cacheFileName('usr_43', 'https://api.example.test')
        ])
        for (const url of [
          'https://bad host.test',
          'http://192.0.2.010:8080/api/v1',
          'http://192.0.2.010:8080\\@192.0.2.8/api/v1',
          'http://0xc0000208/api/v1',
          'http://3221225992/api/v1',
          'https://café.example.test',
          'https://CAFÉ.example.test',
          'https://caf%C3%A9.example.test',
          'https://ＦＯＯ.example.test',
          '/api/v1',
          'file:///tmp/a'
        ]) {
          const before = calls.length
          const error = await open('usr_42', url).catch(
            (error: unknown) => error
          )
          expect(error).instanceOf(Error)
          expect(calls.length).equals(before)
        }
        const ip = await open('usr_42', 'http://192.0.2.8:8080/api/v1')
        await ip.close()
        expect(readdirSync(dir)).includes(
          cacheFileName('usr_42', 'http://192.0.2.8:8080')
        )
        const ascii = await open('usr_42', 'https://xn--caf-dma.example.test')
        await ascii.close()
        expect(readdirSync(dir)).includes(
          cacheFileName('usr_42', 'https://xn--caf-dma.example.test')
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
})
