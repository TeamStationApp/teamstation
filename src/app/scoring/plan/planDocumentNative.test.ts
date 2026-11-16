import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import type * as Native from './planDocument.native'

type Facade = typeof Native

/**
 * Loads the native facade, and its TurboModule spec, over stand-ins for
 * React Native, react-native-blob-util and the base64 encoder.
 */
async function load(
  bridge: unknown,
  test: (facade: Facade, writes: string[][], names: string[]) => Promise<void>
): Promise<void> {
  const writes: string[][] = []
  const names: string[] = []
  /** The folders under `plan-documents/`, as the cache holds them. */
  const folders = new Set<string>()
  const stand = {
    'react-native': {
      TurboModuleRegistry: {
        get: (name: string) => {
          names.push(name)
          return bridge
        }
      }
    },
    'react-native-blob-util': {
      __esModule: true,
      default: {
        fs: {
          dirs: { CacheDir: '/cache' },
          exists: async (path: string) => folders.size > 0 || path === '',
          ls: async () => [...folders],
          unlink: async (path: string) => {
            writes.push(['unlink', path])
            folders.delete(path.split('/').pop()!)
          },
          mkdir: async (path: string) => {
            writes.push(['mkdir', path])
            folders.add(path.split('/').pop()!)
          },
          writeFile: async (path: string, data: string, encoding: string) => {
            writes.push(['write', path, data, encoding])
          }
        }
      }
    },
    'react-native-quick-base64': {
      fromByteArray: (bytes: Uint8Array) => `base64:${bytes.length}`
    }
  }
  const resolved = Object.keys(stand).map(name => require.resolve(name))
  const own = ['./planDocument.native', './NativePlanDocument'].map(name =>
    require.resolve(name)
  )
  const saved = [...resolved, ...own].map(path => require.cache[path])
  Object.values(stand).forEach((exports, at) => {
    const replacement = new Module(resolved[at])
    replacement.exports = exports
    require.cache[resolved[at]] = replacement
  })
  for (const path of own) Reflect.deleteProperty(require.cache, path)
  try {
    await test(require('./planDocument.native') as Facade, writes, names)
  } finally {
    ;[...resolved, ...own].forEach((path, at) => {
      if (saved[at] == null) Reflect.deleteProperty(require.cache, path)
      else require.cache[path] = saved[at]
    })
  }
}

const BYTES = new Uint8Array([1, 2, 3])
const NAME = 'Hosts-game-plan-2027-04-11.pdf'
const ANCHOR = { x: 10, y: 700, width: 120, height: 44 }

describe('the native game plan PDF', function () {
  it('writes each PDF by its name in a folder of its own, keeps the last two, and hands it to TSPlanDocument with the pressed control’s place', async function () {
    const calls: unknown[][] = []
    const realNow = Date.now
    let now = 1000
    Date.now = () => now
    try {
      await load(
        {
          share: async (...args: unknown[]) => {
            calls.push(['share', ...args])
          },
          print: async (...args: unknown[]) => {
            calls.push(['print', ...args])
          }
        },
        async (facade, writes, names) => {
          const root = '/cache/plan-documents'
          await facade.sharePlanDocument(BYTES, NAME, ANCHOR)
          now = 2000
          await facade.printPlanDocument(BYTES, NAME, ANCHOR)
          expect(names).deep.equals(['TSPlanDocument'])
          expect(calls).deep.equals([
            ['share', `${root}/1000/${NAME}`, 10, 700, 120, 44],
            [
              'print',
              `${root}/2000/${NAME}`,
              'Hosts-game-plan-2027-04-11',
              10,
              700,
              120,
              44
            ]
          ])
          expect(writes).deep.equals([
            ['mkdir', `${root}/1000`],
            ['write', `${root}/1000/${NAME}`, 'base64:3', 'base64'],
            ['mkdir', `${root}/2000`],
            ['write', `${root}/2000/${NAME}`, 'base64:3', 'base64']
          ])
          // A third keeps both before it; a fourth lets the oldest go, never
          // a file an earlier share may still be sending.
          writes.length = 0
          now = 3000
          await facade.sharePlanDocument(BYTES, NAME, ANCHOR)
          expect(writes.some(([kind]) => kind === 'unlink')).equals(false)
          now = 4000
          await facade.sharePlanDocument(BYTES, NAME, ANCHOR)
          expect(writes.filter(([kind]) => kind === 'unlink')).deep.equals([
            ['unlink', `${root}/1000`]
          ])
        }
      )
    } finally {
      Date.now = realNow
    }
  })

  it('refuses in a build with no TSPlanDocument, and passes on its refusal', async function () {
    await load(null, async facade => {
      for (const run of [
        async () => {
          await facade.sharePlanDocument(BYTES, NAME, ANCHOR)
        },
        async () => {
          await facade.printPlanDocument(BYTES, NAME, ANCHOR)
        }
      ])
        expect(
          await run().then(
            () => 'done',
            (error: unknown) => String(error)
          )
        ).equals('Error: This build cannot share or print a game plan')
    })
    await load(
      {
        share: async () => {
          throw new Error('Nothing to share from')
        }
      },
      async facade => {
        expect(
          await facade.sharePlanDocument(BYTES, NAME, ANCHOR).then(
            () => 'done',
            (error: unknown) => String(error)
          )
        ).equals('Error: Nothing to share from')
      }
    )
  })
})
